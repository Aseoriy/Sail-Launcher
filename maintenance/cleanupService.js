'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureNoLinkEscape, isWithin, normalizeAbsolute } = require('./pathSafety');
const { throwIfCancelled } = require('./scanner');

function candidateId(candidatePath, category) {
    return crypto.createHash('sha256').update(`${category}\n${path.resolve(candidatePath)}`).digest('hex').slice(0, 24);
}

function classifyFile(filePath, stat, context) {
    const name = path.basename(filePath);
    const relative = context.root ? path.relative(context.root, filePath).replace(/\\/g, '/') : name;
    const lower = relative.toLowerCase();
    let result = null;
    if (/\.aria2$/i.test(name)) result = { category: 'failed-download', reason: 'aria2 control file left by an incomplete Sail download.', risk: 'safe', selected: true };
    else if (/\.(crdownload|partial)$/i.test(name) || /\.part$/i.test(name)) result = { category: 'failed-download', reason: 'Incomplete download fragment.', risk: 'low', selected: false };
    else if (/\.(r\d\d|z\d\d|\d{3})$/i.test(name)) result = { category: 'multipart-archive', reason: 'Multipart archive piece that may be removable after successful extraction.', risk: 'medium', selected: false };
    else if (/\.(zip|rar|7z|iso)$/i.test(name)) result = { category: 'completed-archive', reason: 'Downloaded archive; confirm the installed game works before removal.', risk: 'medium', selected: false };
    else if (/(^|\/)(\.sail-temp|sail[_-]temp|sail[_-]extract)(\/|$)/i.test(lower)) result = { category: 'sail-temporary', reason: 'Temporary file inside a Sail-created working directory.', risk: 'safe', selected: true };
    else if (/\.(tmp|temp)$/i.test(name)) result = { category: 'temporary-file', reason: 'Temporary-looking file; review because age alone is not sufficient evidence.', risk: 'medium', selected: false };
    else if (/setup.*\.exe$|installer.*\.exe$/i.test(name)) result = { category: 'installer', reason: 'Installer payload that may be unnecessary after a verified installation.', risk: 'medium', selected: false };
    if (!result) return null;
    return Object.assign({
        id: candidateId(filePath, result.category),
        path: filePath,
        relativePath: relative,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        root: context.root,
        source: context.source
    }, result);
}

async function scanRoot(root, context, options, output) {
    const stack = [normalizeAbsolute(root)];
    while (stack.length) {
        throwIfCancelled(options.signal);
        const current = stack.pop();
        let entries;
        try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch (_) { continue; }
        for (const entry of entries) {
            throwIfCancelled(options.signal);
            const full = path.join(current, entry.name);
            let stat;
            try { stat = await fs.promises.lstat(full); } catch (_) { continue; }
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) { stack.push(full); continue; }
            if (!stat.isFile()) continue;
            const found = classifyFile(full, stat, Object.assign({ root }, context));
            if (found) output.push(found);
            if (options.onProgress) options.onProgress({ phase: 'cleanup-scan', currentFile: full, processedFiles: output.length });
        }
    }
}

class CleanupService {
    constructor(baseDir) {
        this.baseDir = normalizeAbsolute(baseDir);
    }

    async scan(input = {}, options = {}) {
        const candidates = [];
        const roots = [];
        if (input.downloadsRoot) roots.push({ root: input.downloadsRoot, source: 'downloads' });
        for (const installRoot of input.installRoots || []) if (installRoot) roots.push({ root: installRoot, source: 'installation' });
        roots.push({ root: this.baseDir, source: 'maintenance' });
        const seen = new Set();
        for (const entry of roots) {
            let root;
            try { root = normalizeAbsolute(entry.root); } catch (_) { continue; }
            const key = root.toLowerCase();
            if (seen.has(key) || !fs.existsSync(root)) continue;
            seen.add(key);
            await scanRoot(root, entry, options, candidates);
        }
        candidates.sort((a, b) => a.risk.localeCompare(b.risk) || b.size - a.size);
        return {
            scannedAt: new Date().toISOString(),
            candidates,
            totalBytes: candidates.reduce((sum, item) => sum + item.size, 0),
            selectedBytes: candidates.filter(item => item.selected).reduce((sum, item) => sum + item.size, 0),
            allowedRoots: Array.from(seen)
        };
    }

    async remove(candidates, allowedRoots, options = {}) {
        const roots = (allowedRoots || []).map(normalizeAbsolute);
        const removed = [];
        const failed = [];
        for (const candidate of candidates || []) {
            throwIfCancelled(options.signal);
            const target = normalizeAbsolute(candidate.path);
            const root = roots.find(item => isWithin(item, target, false));
            if (!root) { failed.push({ path: target, error: 'Outside approved cleanup roots.' }); continue; }
            try {
                await ensureNoLinkEscape(root, target);
                const stat = await fs.promises.lstat(target);
                if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Only regular files can be removed.');
                const classification = classifyFile(target, stat, { root, source: candidate.source });
                if (!classification || classification.id !== candidate.id) throw new Error('Candidate classification changed; rescan before deleting.');
                await fs.promises.rm(target, { force: true });
                removed.push({ path: target, size: stat.size, category: classification.category });
                if (options.onProgress) options.onProgress({ phase: 'cleanup-delete', currentFile: target, processedFiles: removed.length });
            } catch (error) { failed.push({ path: target, error: error.message }); }
        }
        return { removed, failed, reclaimedBytes: removed.reduce((sum, item) => sum + item.size, 0) };
    }
}

module.exports = { CleanupService, candidateId, classifyFile };
