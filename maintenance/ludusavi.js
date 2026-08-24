'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const LUDUSAVI_MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const manifestMemoryCache = new Map();
const manifestIndexCache = new WeakMap();

function parseManifest(text) {
    const value = yaml.load(String(text || ''), { schema: yaml.JSON_SCHEMA });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ludusavi returned an invalid manifest.');
    return value;
}

function readCachedManifest(cachePath, fileSystem = fs) {
    const text = fileSystem.readFileSync(cachePath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MANIFEST_MAX_BYTES) throw new Error('The cached Ludusavi manifest is too large.');
    return parseManifest(text);
}

function writeCachedManifest(cachePath, text, fileSystem = fs) {
    fileSystem.mkdirSync(path.dirname(cachePath), { recursive: true });
    const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fileSystem.writeFileSync(temporaryPath, text, 'utf8');
        fileSystem.renameSync(temporaryPath, cachePath);
    } finally {
        try { fileSystem.rmSync(temporaryPath, { force: true }); } catch (_) {}
    }
}

async function fetchManifestText(fetchImpl, options = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Downloads are unavailable in this build.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 20000);
    try {
        const response = await fetchImpl(options.url || LUDUSAVI_MANIFEST_URL, {
            signal: controller.signal,
            headers: { Accept: 'application/yaml, text/yaml, text/plain', 'User-Agent': 'Sail-Launcher' }
        });
        if (!response || !response.ok) throw new Error(`Ludusavi download failed with HTTP ${response && response.status || 'unknown'}.`);
        const declaredSize = Number(response.headers && response.headers.get && response.headers.get('content-length')) || 0;
        if (declaredSize > MANIFEST_MAX_BYTES) throw new Error('The Ludusavi manifest is too large.');
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MANIFEST_MAX_BYTES) throw new Error('The Ludusavi manifest is too large.');
        return text;
    } finally {
        clearTimeout(timeout);
    }
}

async function loadLudusaviManifest(options = {}) {
    const fileSystem = options.fs || fs;
    const cachePath = path.resolve(options.cachePath);
    const reportStatus = (phase, message) => {
        if (typeof options.onStatus !== 'function') return;
        try { options.onStatus({ phase, message }); } catch (_) {}
    };
    const memory = manifestMemoryCache.get(cachePath);
    if (memory) {
        reportStatus('cache', 'Using the cached Ludusavi database…');
        return memory;
    }

    let cached = null;
    let cacheAge = Infinity;
    try {
        const stat = fileSystem.statSync(cachePath);
        cacheAge = Date.now() - stat.mtimeMs;
        cached = readCachedManifest(cachePath, fileSystem);
        if (cacheAge < (Number(options.maxAgeMs) || MANIFEST_MAX_AGE_MS)) {
            reportStatus('cache', 'Using the cached Ludusavi database…');
            const result = { manifest: cached, source: 'cache', stale: false };
            manifestMemoryCache.set(cachePath, result);
            return result;
        }
    } catch (_) {}

    try {
        reportStatus('download', cached ? 'Updating the Ludusavi database…' : 'Downloading the Ludusavi database…');
        const text = await fetchManifestText(options.fetchImpl || globalThis.fetch, options);
        const manifest = parseManifest(text);
        writeCachedManifest(cachePath, text, fileSystem);
        reportStatus('ready', 'Ludusavi database ready. Checking known save locations…');
        const result = { manifest, source: 'download', stale: false };
        manifestMemoryCache.set(cachePath, result);
        return result;
    } catch (error) {
        if (cached) {
            reportStatus('stale-cache', 'Database update failed. Using the cached Ludusavi database…');
            const result = { manifest: cached, source: 'cache', stale: true, warning: error.message };
            manifestMemoryCache.set(cachePath, result);
            return result;
        }
        throw error;
    }
}

function normalizedTitle(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function manifestIndex(manifest) {
    const cached = manifestIndexCache.get(manifest);
    if (cached) return cached;
    const bySteamId = new Map();
    const byTitle = new Map();
    for (const [title, data] of Object.entries(manifest)) {
        if (!data || typeof data !== 'object') continue;
        const ids = [data.steam && data.steam.id, ...((data.id && data.id.steamExtra) || [])];
        for (const id of ids) if (id !== undefined && id !== null) bySteamId.set(String(id), title);
        const key = normalizedTitle(title);
        if (key && !byTitle.has(key)) byTitle.set(key, title);
    }
    const result = { bySteamId, byTitle };
    manifestIndexCache.set(manifest, result);
    return result;
}

function resolveManifestAlias(manifest, title) {
    const visited = new Set();
    let currentTitle = title;
    for (let depth = 0; depth < 8; depth++) {
        const data = manifest[currentTitle];
        if (!data || !data.alias) return data ? { title: currentTitle, data } : null;
        if (visited.has(currentTitle)) return null;
        visited.add(currentTitle);
        currentTitle = String(data.alias);
    }
    return null;
}

function findManifestGame(manifest, input = {}) {
    const index = manifestIndex(manifest);
    const appId = String(input.steamAppId || '').trim();
    let title = appId ? index.bySteamId.get(appId) : null;
    if (!title) title = index.byTitle.get(normalizedTitle(input.gameName));
    return title ? resolveManifestAlias(manifest, title) : null;
}

function installFolderFromInput(input = {}) {
    const direct = String(input.installFolder || '').trim();
    if (direct) return path.resolve(direct);
    const executable = String(input.exePath || '').trim();
    return executable ? path.dirname(path.resolve(executable)) : '';
}

function steamLibraryRoot(installFolder) {
    const normalized = String(installFolder || '').replace(/\//g, '\\');
    const marker = '\\steamapps\\common\\';
    const index = normalized.toLowerCase().indexOf(marker);
    return index > 0 ? normalized.slice(0, index) : '';
}

function steamUserIds(steamRoot, fileSystem = fs) {
    if (!steamRoot) return [];
    try {
        return fileSystem.readdirSync(path.join(steamRoot, 'userdata'), { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
            .map(entry => entry.name);
    } catch (_) {
        return [];
    }
}

function replaceToken(value, token, replacement) {
    return value.replace(new RegExp(`<${token}>`, 'gi'), String(replacement || ''));
}

function resolveLudusaviPaths(rawPath, gameData, input = {}, options = {}) {
    const env = options.env || process.env;
    const home = options.homePath || env.USERPROFILE || os.homedir();
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const installFolder = installFolderFromInput(input);
    const storeRoot = options.storeRoot || steamLibraryRoot(installFolder) || options.steamRoot || '';
    const installNames = installFolder
        ? [path.basename(installFolder)]
        : Object.keys(gameData.installDir || {});
    const users = Array.isArray(options.steamUserIds)
        ? options.steamUserIds
        : steamUserIds(options.steamRoot || storeRoot, options.fs || fs);
    const gameNames = installNames.length ? installNames : [String(input.gameName || '')];
    const userIds = users.length ? users : ['*'];
    const needsUser = /<storeUserId>/i.test(rawPath);
    const variants = [];

    for (const gameName of gameNames) {
        for (const userId of needsUser ? userIds : ['']) {
            const base = installFolder || (storeRoot && gameName ? path.join(storeRoot, 'steamapps', 'common', gameName) : '');
            let resolved = String(rawPath || '');
            const values = {
                home,
                root: storeRoot,
                game: gameName,
                base,
                storeGameId: String(input.steamAppId || gameData.steam && gameData.steam.id || ''),
                storeUserId: userId,
                osUserName: env.USERNAME || path.basename(home),
                winAppData: env.APPDATA || path.join(home, 'AppData', 'Roaming'),
                winLocalAppData: localAppData,
                winLocalAppDataLow: path.join(path.dirname(localAppData), 'LocalLow'),
                winDocuments: options.documentsPath || path.join(home, 'Documents'),
                winSavedGames: options.savedGamesPath || path.join(home, 'Saved Games'),
                winPublic: env.PUBLIC || 'C:\\Users\\Public',
                winProgramData: env.PROGRAMDATA || 'C:\\ProgramData',
                winDir: env.WINDIR || env.windir || 'C:\\Windows',
                winProfile: home
            };
            let complete = true;
            for (const [token, replacement] of Object.entries(values)) {
                if (new RegExp(`<${token}>`, 'i').test(resolved) && !replacement) {
                    complete = false;
                    break;
                }
                resolved = replaceToken(resolved, token, replacement);
            }
            if (!complete) continue;
            resolved = resolved.replace(/\//g, path.sep);
            if (!/<[^>]+>/.test(resolved) && path.isAbsolute(resolved)) variants.push(path.normalize(resolved));
        }
    }
    return [...new Set(variants.map(value => value.toLowerCase()))].map(key => variants.find(value => value.toLowerCase() === key));
}

function fileEntryApplies(metadata = {}, osName = 'windows', store = 'steam') {
    const tags = Array.isArray(metadata.tags) ? metadata.tags.map(tag => String(tag).toLowerCase()) : [];
    if (tags.length && !tags.includes('save')) return false;
    const conditions = Array.isArray(metadata.when) ? metadata.when : [];
    if (!conditions.length) return true;
    return conditions.some(condition => {
        if (!condition || typeof condition !== 'object') return true;
        const osMatches = !condition.os || String(condition.os).toLowerCase() === osName;
        const storeMatches = !condition.store || String(condition.store).toLowerCase() === store;
        return osMatches && storeMatches;
    });
}

function globSegmentRegex(segment) {
    let source = '^';
    for (let index = 0; index < segment.length; index++) {
        const character = segment[index];
        if (character === '*') source += '.*';
        else if (character === '?') source += '.';
        else if (character === '[') {
            const closing = segment.indexOf(']', index + 1);
            if (closing > index + 1) {
                source += segment.slice(index, closing + 1);
                index = closing;
            } else source += '\\[';
        } else source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
    return new RegExp(`${source}$`, 'i');
}

function expandGlobPath(pattern, options = {}) {
    const fileSystem = options.fs || fs;
    const parsed = path.parse(pattern);
    const segments = pattern.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
    const matches = [];
    let visited = 0;
    const maxVisited = Math.max(100, Math.min(10000, Number(options.maxVisited) || 3000));
    const maxMatches = Math.max(1, Math.min(512, Number(options.maxMatches) || 128));

    function walk(current, segmentIndex, recursiveDepth) {
        if (visited++ >= maxVisited || matches.length >= maxMatches || recursiveDepth > 8) return;
        if (segmentIndex >= segments.length) {
            try {
                const stat = fileSystem.lstatSync(current);
                if (!stat.isSymbolicLink()) matches.push({ path: current, stat });
            } catch (_) {}
            return;
        }
        const segment = segments[segmentIndex];
        if (segment === '**') {
            walk(current, segmentIndex + 1, recursiveDepth);
            let entries = [];
            try { entries = fileSystem.readdirSync(current, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
                walk(path.join(current, entry.name), segmentIndex, recursiveDepth + 1);
            }
            return;
        }
        if (/[*?[]/.test(segment)) {
            const expression = globSegmentRegex(segment);
            let entries = [];
            try { entries = fileSystem.readdirSync(current, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (entry.isSymbolicLink() || !expression.test(entry.name)) continue;
                walk(path.join(current, entry.name), segmentIndex + 1, recursiveDepth);
            }
            return;
        }
        walk(path.join(current, segment), segmentIndex + 1, recursiveDepth);
    }

    if (parsed.root) walk(parsed.root, 0, 0);
    return matches;
}

function staticGlobParent(pattern) {
    const parsed = path.parse(pattern);
    const segments = pattern.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
    const firstGlob = segments.findIndex(segment => /[*?[]/.test(segment));
    if (firstGlob < 0) return '';
    return path.join(parsed.root, ...segments.slice(0, firstGlob));
}

function existingDirectoryForPattern(pattern, options = {}) {
    const fileSystem = options.fs || fs;
    const matches = expandGlobPath(pattern, options);
    const found = [];
    for (const match of matches) found.push(match.stat.isDirectory() ? match.path : path.dirname(match.path));
    if (found.length) return { paths: found, matchedFiles: true };

    const parent = staticGlobParent(pattern);
    if (parent) {
        try {
            const stat = fileSystem.lstatSync(parent);
            if (stat.isDirectory() && !stat.isSymbolicLink()) return { paths: [parent], matchedFiles: false };
        } catch (_) {}
    }

    if (!/[*?[]/.test(pattern) && path.extname(path.basename(pattern))) {
        const fileParent = path.dirname(pattern);
        try {
            const stat = fileSystem.lstatSync(fileParent);
            if (stat.isDirectory() && !stat.isSymbolicLink()) return { paths: [fileParent], matchedFiles: false };
        } catch (_) {}
    }
    return { paths: [], matchedFiles: false };
}

function detectLudusaviSaveCandidates(manifest, input = {}, options = {}) {
    const matched = findManifestGame(manifest, input);
    if (!matched || !matched.data.files) return { matchedGame: null, candidates: [] };
    const env = options.env || process.env;
    const home = options.homePath || env.USERPROFILE || os.homedir();
    const installFolder = installFolderFromInput(input);
    const storeRoot = options.storeRoot || steamLibraryRoot(installFolder) || options.steamRoot || '';
    const documentsRoot = options.documentsPath || path.join(home, 'Documents');
    const savedGamesRoot = options.savedGamesPath || path.join(home, 'Saved Games');
    const roamingRoot = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localRoot = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const localLowRoot = path.join(path.dirname(localRoot), 'LocalLow');
    const programData = env.PROGRAMDATA || 'C:\\ProgramData';
    const publicRoot = env.PUBLIC || 'C:\\Users\\Public';
    const windowsRoot = env.WINDIR || env.windir || 'C:\\Windows';
    const standardRoots = [
        home,
        documentsRoot,
        savedGamesRoot,
        roamingRoot,
        localRoot,
        localLowRoot,
        programData,
        publicRoot,
        windowsRoot,
        installFolder,
        storeRoot,
        options.steamRoot
    ].filter(Boolean).map(value => path.resolve(value));
    const broadRoots = new Set([
        home,
        documentsRoot,
        savedGamesRoot,
        roamingRoot,
        localRoot,
        localLowRoot,
        programData,
        publicRoot,
        windowsRoot,
        storeRoot,
        options.steamRoot,
        options.steamRoot && path.join(options.steamRoot, 'userdata')
    ].filter(Boolean).map(value => path.resolve(value).toLowerCase()));
    const candidates = [];
    const seen = new Set();

    for (const [rawPath, metadata] of Object.entries(matched.data.files)) {
        if (!fileEntryApplies(metadata, 'windows', 'steam')) continue;
        for (const resolved of resolveLudusaviPaths(rawPath, matched.data, input, options)) {
            const result = existingDirectoryForPattern(resolved, options);
            for (const candidatePath of result.paths) {
                const normalized = path.resolve(candidatePath);
                const key = normalized.toLowerCase();
                const relativeToKnownRoot = standardRoots.some(root => {
                    const relative = path.relative(root, normalized);
                    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
                });
                if (!relativeToKnownRoot || seen.has(key) || broadRoots.has(key) || normalized === path.parse(normalized).root) continue;
                seen.add(key);
                candidates.push({
                    path: normalized,
                    source: 'ludusavi',
                    reason: result.matchedFiles
                        ? `Save data found using Ludusavi's entry for ${matched.title}.`
                        : `Known Ludusavi save folder for ${matched.title}.`,
                    score: result.matchedFiles ? 140 : 110,
                    matchedFiles: result.matchedFiles,
                    rawPath
                });
            }
        }
    }
    candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    return { matchedGame: matched.title, candidates };
}

module.exports = {
    LUDUSAVI_MANIFEST_URL,
    detectLudusaviSaveCandidates,
    expandGlobPath,
    fileEntryApplies,
    findManifestGame,
    loadLudusaviManifest,
    parseManifest,
    resolveLudusaviPaths,
    steamLibraryRoot
};
