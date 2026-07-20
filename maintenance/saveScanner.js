'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SAVE_NAMES = /^(save|saves|saved|savegame|savegames|profile|profiles|userdata|storage)$/i;
const SKIP_NAMES = /^(windows|system32|winsxs|node_modules|\.git|cache|caches|temp|tmp)$/i;

function normalizeName(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function defaultSaveRoots() {
    const home = os.homedir();
    const localLow = process.env.LOCALAPPDATA ? path.join(path.dirname(process.env.LOCALAPPDATA), 'LocalLow') : '';
    return [
        path.join(home, 'Saved Games'),
        path.join(home, 'Documents', 'My Games'),
        path.join(home, 'Documents'),
        process.env.APPDATA || '',
        process.env.LOCALAPPDATA || '',
        localLow
    ].filter(Boolean);
}

function candidateScore(dirPath, gameTarget, source, parentMatched, stat) {
    const name = path.basename(dirPath);
    const normalized = normalizeName(name);
    const exact = normalized === gameTarget;
    const partial = normalized.length >= 4 && (normalized.includes(gameTarget) || gameTarget.includes(normalized));
    const saveLike = SAVE_NAMES.test(name);
    if (!exact && !partial && !(saveLike && (parentMatched || source === 'installation'))) return null;
    let score = exact ? 120 : partial ? 85 : 55;
    if (saveLike) score += 35;
    if (source === 'installation') score += 25;
    if (stat && Date.now() - stat.mtimeMs < 30 * 24 * 60 * 60 * 1000) score += 8;
    return { score, reason: exact ? 'Folder name exactly matches the game.' : partial ? 'Folder name resembles the game.' : 'Save-like folder found inside the installation or a matching game folder.' };
}

async function scanSaveCandidates(input = {}, options = {}) {
    const target = normalizeName(input.gameName);
    if (target.length < 3) return [];
    const roots = [];
    if (input.includeInstallRoot !== false && input.installRoot) roots.push({ root: input.installRoot, source: 'installation', maxDepth: 7 });
    for (const root of input.customRoots || []) if (root) roots.push({ root, source: 'custom', maxDepth: 6 });
    for (const root of defaultSaveRoots()) roots.push({ root, source: 'common', maxDepth: 2 });

    const seenRoots = new Set();
    const seenCandidates = new Set();
    const candidates = [];
    let visited = 0;
    const maxVisited = Math.max(500, Math.min(50000, Number(options.maxVisited) || 15000));

    for (const descriptor of roots) {
        let root;
        try { root = path.resolve(descriptor.root); } catch (_) { continue; }
        const rootKey = root.toLowerCase();
        if (seenRoots.has(rootKey)) continue;
        seenRoots.add(rootKey);
        if (descriptor.source === 'custom') {
            try {
                const rootStat = await fs.promises.lstat(root);
                const rootScore = candidateScore(root, target, 'custom', true, rootStat);
                if (rootScore && rootStat.isDirectory() && !rootStat.isSymbolicLink() && !seenCandidates.has(rootKey)) {
                    seenCandidates.add(rootKey);
                    candidates.push({ path: root, source: 'custom', score: rootScore.score, reason: `Custom scan directory: ${rootScore.reason}`, modifiedAt: rootStat.mtime.toISOString() });
                }
            } catch (_) {}
        }
        const stack = [{ dir: root, depth: 0, parentMatched: false }];
        while (stack.length && visited < maxVisited) {
            if (options.signal && options.signal.aborted) throw Object.assign(new Error('Save scan cancelled.'), { code: 'CANCELLED' });
            const current = stack.pop();
            let entries;
            try { entries = await fs.promises.readdir(current.dir, { withFileTypes: true }); } catch (_) { continue; }
            for (const entry of entries) {
                if (visited++ >= maxVisited) break;
                if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_NAMES.test(entry.name)) continue;
                const full = path.join(current.dir, entry.name);
                let stat; try { stat = await fs.promises.lstat(full); } catch (_) { continue; }
                if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
                const normalized = normalizeName(entry.name);
                const matched = normalized === target || (normalized.length >= 4 && (normalized.includes(target) || target.includes(normalized)));
                const scored = candidateScore(full, target, descriptor.source, current.parentMatched, stat);
                if (scored && !seenCandidates.has(full.toLowerCase())) {
                    seenCandidates.add(full.toLowerCase());
                    candidates.push({ path: full, source: descriptor.source, score: scored.score, reason: scored.reason, modifiedAt: stat.mtime.toISOString() });
                }
                if (current.depth < descriptor.maxDepth) stack.push({ dir: full, depth: current.depth + 1, parentMatched: current.parentMatched || matched });
                if (options.onProgress && visited % 50 === 0) options.onProgress({ phase: 'save-folder-scan', currentFile: full, processedFiles: visited });
            }
        }
        if (visited >= maxVisited) break;
    }
    return candidates.sort((a, b) => b.score - a.score || String(b.modifiedAt).localeCompare(String(a.modifiedAt))).slice(0, 100);
}

module.exports = { defaultSaveRoots, normalizeName, scanSaveCandidates };
