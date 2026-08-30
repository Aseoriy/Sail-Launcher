'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const QUARANTINE_DIRECTORY_NAME = 'quarantine';
const QUARANTINE_ITEM_PATTERN = /^quarantine-[a-f0-9]{48}$/;
const SAIL_STAGING_DIRECTORY_NAMES = new Set(['.s', '.sail-staging']);
const DEFAULT_LIMITS = Object.freeze({
    maxRoots: 32,
    maxItems: 200,
    maxEntries: 10000,
    maxDepth: 16
});

function sameCanonicalPath(first, second) {
    const normalize = value => {
        const normalized = path.normalize(String(value)).replace(/[\\/]+$/, '');
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    };
    return normalize(first) === normalize(second);
}

function isStrictChildPath(root, target) {
    const relative = path.relative(root, target);
    return !!relative
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function realpath(fsImpl, target) {
    const resolver = fsImpl.realpathSync.native || fsImpl.realpathSync;
    return resolver(path.resolve(target));
}

function ordinaryDirectory(fsImpl, target) {
    const stats = fsImpl.lstatSync(target, { bigint: true });
    return stats.isDirectory() && !stats.isSymbolicLink() ? stats : null;
}

function validateQuarantineRoot(fsImpl, candidate) {
    try {
        const requested = path.resolve(String(candidate || ''));
        if (path.basename(requested).toLowerCase() !== QUARANTINE_DIRECTORY_NAME) return null;
        const stagingRoot = path.dirname(requested);
        if (!SAIL_STAGING_DIRECTORY_NAMES.has(path.basename(stagingRoot).toLowerCase())) return null;
        if (!ordinaryDirectory(fsImpl, stagingRoot) || !ordinaryDirectory(fsImpl, requested)) return null;
        const canonicalStaging = realpath(fsImpl, stagingRoot);
        const canonicalRoot = realpath(fsImpl, requested);
        if (!sameCanonicalPath(stagingRoot, canonicalStaging)
            || !sameCanonicalPath(requested, canonicalRoot)
            || !isStrictChildPath(canonicalStaging, canonicalRoot)) return null;
        return canonicalRoot;
    } catch (_) {
        return null;
    }
}

function safeNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.min(number, Number.MAX_SAFE_INTEGER);
}

function readNamesBounded(fsImpl, target, limit) {
    const names = [];
    let truncated = false;
    const directory = fsImpl.opendirSync(target);
    try {
        while (names.length <= limit) {
            const entry = directory.readSync();
            if (!entry) break;
            if (names.length === limit) {
                truncated = true;
                break;
            }
            names.push(entry.name);
        }
    } finally {
        try { directory.closeSync(); } catch (_) {}
    }
    return { names, truncated };
}

class DownloadQuarantineCatalog {
    constructor(options = {}) {
        if (!options.catalogPath) throw new TypeError('A quarantine catalog path is required.');
        this.fs = options.fs || fs;
        this.catalogPath = path.resolve(options.catalogPath);
        this.randomBytes = options.randomBytes || crypto.randomBytes;
        this.maxRoots = options.maxRoots || DEFAULT_LIMITS.maxRoots;
        this.maxItems = options.maxItems || DEFAULT_LIMITS.maxItems;
        this.maxEntries = options.maxEntries || DEFAULT_LIMITS.maxEntries;
        this.maxDepth = options.maxDepth || DEFAULT_LIMITS.maxDepth;
        this.knownRoots = new Set();
        this.openTargets = new Map();
        this.loadRecordedRoots();
    }

    loadRecordedRoots() {
        let parsed;
        try { parsed = JSON.parse(this.fs.readFileSync(this.catalogPath, 'utf8')); } catch (_) { return; }
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.roots)) return;
        for (const value of parsed.roots.slice(0, this.maxRoots)) {
            if (typeof value === 'string' && value.length <= 32768) this.knownRoots.add(path.resolve(value));
        }
    }

    recordRoot(candidate) {
        const root = validateQuarantineRoot(this.fs, candidate);
        if (!root) throw new Error('The quarantine root is not an authoritative Sail staging directory.');
        if (this.knownRoots.has(root)) return root;
        if (this.knownRoots.size >= this.maxRoots) throw new Error('The quarantine root catalog is full.');
        this.knownRoots.add(root);
        try {
            this.persistRoots();
        } catch (error) {
            this.knownRoots.delete(root);
            throw error;
        }
        return root;
    }

    persistRoots() {
        const parent = path.dirname(this.catalogPath);
        this.fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const temporary = path.join(parent, `.download-quarantine-${this.randomBytes(12).toString('hex')}.tmp`);
        const body = JSON.stringify({ version: 1, roots: [...this.knownRoots] });
        try {
            this.fs.writeFileSync(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            this.fs.renameSync(temporary, this.catalogPath);
        } catch (error) {
            try { this.fs.unlinkSync(temporary); } catch (_) {}
            throw error;
        }
    }

    inspectItem(itemPath, budget) {
        let totalBytes = 0;
        let latestMs = 0;
        let partial = false;
        const stack = [{ target: itemPath, depth: 0 }];
        while (stack.length) {
            if (budget.entries >= this.maxEntries) {
                budget.truncated = true;
                partial = true;
                break;
            }
            const current = stack.pop();
            budget.entries += 1;
            let stats;
            try { stats = this.fs.lstatSync(current.target, { bigint: true }); } catch (_) {
                partial = true;
                continue;
            }
            latestMs = Math.max(latestMs, safeNumber(stats.mtimeMs), safeNumber(stats.birthtimeMs));
            if (stats.isSymbolicLink()) {
                partial = true;
                continue;
            }
            if (!stats.isDirectory()) {
                totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + safeNumber(stats.size));
                continue;
            }
            if (current.depth >= this.maxDepth) {
                partial = true;
                budget.truncated = true;
                continue;
            }
            const remaining = Math.max(0, this.maxEntries - budget.entries - stack.length);
            let listing;
            try { listing = readNamesBounded(this.fs, current.target, remaining); } catch (_) {
                partial = true;
                continue;
            }
            if (listing.truncated) {
                partial = true;
                budget.truncated = true;
            }
            for (const name of listing.names) stack.push({ target: path.join(current.target, name), depth: current.depth + 1 });
        }
        return { totalBytes, latestMs, partial };
    }

    summarize() {
        const summary = { itemCount: 0, totalBytes: 0, latestAt: null, partial: false, roots: [] };
        const budget = { entries: 0, truncated: false };
        this.openTargets.clear();
        for (const recorded of [...this.knownRoots].slice(0, this.maxRoots)) {
            const root = validateQuarantineRoot(this.fs, recorded);
            if (!root) {
                summary.partial = true;
                continue;
            }
            let listing;
            try { listing = readNamesBounded(this.fs, root, this.maxItems - summary.itemCount); } catch (_) {
                summary.partial = true;
                continue;
            }
            const itemNames = listing.names.filter(name => QUARANTINE_ITEM_PATTERN.test(name));
            if (listing.truncated) summary.partial = true;
            let rootCount = 0;
            let rootBytes = 0;
            let rootLatestMs = 0;
            let rootPartial = false;
            for (const name of itemNames) {
                const itemPath = path.join(root, name);
                let canonicalItem;
                try {
                    if (!ordinaryDirectory(this.fs, itemPath)) continue;
                    canonicalItem = realpath(this.fs, itemPath);
                } catch (_) {
                    rootPartial = true;
                    continue;
                }
                if (!sameCanonicalPath(itemPath, canonicalItem) || !isStrictChildPath(root, canonicalItem)) {
                    rootPartial = true;
                    continue;
                }
                const item = this.inspectItem(canonicalItem, budget);
                rootCount += 1;
                rootBytes = Math.min(Number.MAX_SAFE_INTEGER, rootBytes + item.totalBytes);
                rootLatestMs = Math.max(rootLatestMs, item.latestMs);
                rootPartial = rootPartial || item.partial;
                if (budget.entries >= this.maxEntries) break;
            }
            if (!rootCount) {
                summary.partial = summary.partial || rootPartial;
                continue;
            }
            const id = this.randomBytes(24).toString('hex');
            this.openTargets.set(id, root);
            summary.roots.push({
                id,
                itemCount: rootCount,
                totalBytes: rootBytes,
                latestAt: rootLatestMs ? new Date(rootLatestMs).toISOString() : null,
                partial: rootPartial
            });
            summary.itemCount += rootCount;
            summary.totalBytes = Math.min(Number.MAX_SAFE_INTEGER, summary.totalBytes + rootBytes);
            if (rootLatestMs && (!summary.latestAt || rootLatestMs > Date.parse(summary.latestAt))) {
                summary.latestAt = new Date(rootLatestMs).toISOString();
            }
            summary.partial = summary.partial || rootPartial;
            if (summary.itemCount >= this.maxItems || budget.entries >= this.maxEntries) break;
        }
        summary.partial = summary.partial || budget.truncated;
        return summary;
    }

    // Remove only opaque quarantine directories that were discovered beneath a
    // recorded, canonical Sail staging root.  This deliberately uses lstat and
    // per-entry identity checks instead of a recursive pathname delete so a
    // junction, symlink, or replacement path can never broaden the target.
    clear() {
        const result = {
            status: 'cleared',
            removedItemCount: 0,
            removedBytes: 0,
            failedItemCount: 0,
            partial: false
        };
        const budget = { entries: 0, truncated: false };
        for (const recorded of [...this.knownRoots].slice(0, this.maxRoots)) {
            const root = validateQuarantineRoot(this.fs, recorded);
            if (!root) {
                result.partial = true;
                continue;
            }
            let listing;
            try { listing = readNamesBounded(this.fs, root, this.maxItems); } catch (_) {
                result.partial = true;
                continue;
            }
            if (listing.truncated) result.partial = true;
            for (const name of listing.names.filter(value => QUARANTINE_ITEM_PATTERN.test(value))) {
                if (result.removedItemCount + result.failedItemCount >= this.maxItems) {
                    result.partial = true;
                    break;
                }
                const itemPath = path.join(root, name);
                let item;
                let canonicalItem;
                try {
                    if (!ordinaryDirectory(this.fs, itemPath)) throw new Error('not-directory');
                    canonicalItem = realpath(this.fs, itemPath);
                    if (!sameCanonicalPath(itemPath, canonicalItem) || !isStrictChildPath(root, canonicalItem)) {
                        throw new Error('identity-mismatch');
                    }
                    item = this.inspectItem(canonicalItem, budget);
                    if (item.partial || budget.truncated) throw new Error('unsafe-item');
                    // Enumeration and deletion have separate bounded budgets. Reusing the
                    // inspection budget here could exhaust it halfway through a completely
                    // validated item and leave an avoidable partial cleanup.
                    const removalBudget = { entries: 0, truncated: false };
                    this.removeVerifiedTree(root, canonicalItem, removalBudget);
                    result.removedItemCount += 1;
                    result.removedBytes = Math.min(Number.MAX_SAFE_INTEGER, result.removedBytes + item.totalBytes);
                } catch (_) {
                    result.failedItemCount += 1;
                    result.partial = true;
                }
            }
            if (budget.truncated) result.partial = true;
        }
        if (result.failedItemCount || result.partial) {
            result.status = result.removedItemCount ? 'partially_cleared' : 'clear_refused';
        }
        return result;
    }

    removeVerifiedTree(root, target, budget) {
        if (++budget.entries > this.maxEntries) {
            budget.truncated = true;
            throw new Error('entry-limit');
        }
        let stats;
        try { stats = this.fs.lstatSync(target, { bigint: true }); } catch (_) { throw new Error('missing-entry'); }
        if (stats.isSymbolicLink()) throw new Error('reparse-entry');
        if (stats.isDirectory()) {
            const canonical = realpath(this.fs, target);
            if (!sameCanonicalPath(target, canonical) || !isStrictChildPath(root, canonical)) throw new Error('directory-identity-mismatch');
            let listing;
            try { listing = readNamesBounded(this.fs, target, this.maxEntries - budget.entries); } catch (_) { throw new Error('cannot-list'); }
            if (listing.truncated) {
                budget.truncated = true;
                throw new Error('entry-limit');
            }
            for (const name of listing.names) this.removeVerifiedTree(root, path.join(target, name), budget);
            this.fs.rmdirSync(target);
            return;
        }
        if (!stats.isFile()) throw new Error('unsupported-entry');
        this.fs.unlinkSync(target);
    }

    async openRoot(id, openPath) {
        if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id) || typeof openPath !== 'function') {
            return { status: 'open_refused' };
        }
        const recorded = this.openTargets.get(id);
        const root = recorded && validateQuarantineRoot(this.fs, recorded);
        if (!root || !sameCanonicalPath(root, recorded)) return { status: 'open_refused' };
        try {
            const error = await openPath(root);
            return error ? { status: 'open_failed' } : { status: 'opened' };
        } catch (_) {
            return { status: 'open_failed' };
        }
    }
}

function registerDownloadQuarantineIpc(ipcMain, options = {}) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('An IPC registrar is required.');
    const catalog = options.catalog;
    const shell = options.shell;
    if (!catalog || !shell || typeof shell.openPath !== 'function') {
        throw new TypeError('Download quarantine IPC requires the production catalog and shell boundary.');
    }
    ipcMain.handle('get-download-quarantine-summary', async () => catalog.summarize());
    ipcMain.handle('clear-download-quarantine', async () => catalog.clear());
    ipcMain.handle('open-download-quarantine', async (_event, id) => catalog.openRoot(id, target => shell.openPath(target)));
}

module.exports = {
    DEFAULT_LIMITS,
    DownloadQuarantineCatalog,
    QUARANTINE_DIRECTORY_NAME,
    QUARANTINE_ITEM_PATTERN,
    registerDownloadQuarantineIpc,
    validateQuarantineRoot
};
