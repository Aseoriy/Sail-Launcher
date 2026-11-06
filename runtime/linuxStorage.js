'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// What Sail keeps on disk on Linux. The renderer only ever sends a key back; paths stay in main.
function storageLocations({ userData, protonRoot, downloadRoots = [] }) {
    const roots = [...new Set(downloadRoots.filter(Boolean).map(item => path.resolve(item)))];
    return [
        { key: 'games', label: 'Downloaded games', description: 'Games Sail downloaded and unpacked, in your download folder.', paths: roots },
        { key: 'prefixes', label: 'Windows environments', description: 'One Proton or Wine environment per Windows game, with its settings and often its saves. Remove a game to remove its environment.',
            paths: [path.join(protonRoot, 'prefixes'), path.join(protonRoot, 'wine-prefixes')] },
        { key: 'runtimes', label: 'Proton and Wine downloaded by Sail', description: 'Manage these in Settings → Compatibility. Proton from Steam is not counted.',
            paths: [path.join(protonRoot, 'managed'), path.join(protonRoot, 'downloads')] },
        { key: 'prerequisites', label: 'Windows components', description: 'DirectX and Visual C++ packages kept for setting up Windows games.', paths: [path.join(protonRoot, 'prerequisites')] },
        { key: 'logs', label: 'Game launch logs', description: 'Recent output from Proton and native games, for troubleshooting.', paths: [path.join(protonRoot, 'launches')] },
        { key: 'cache', label: 'Launcher cache', description: 'Web pages and images Sail cached. Safe to clear; it fills up again as you browse.', clearable: true,
            paths: ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache'].map(name => path.join(userData, name)) }
    ];
}

// `du` is on every Linux desktop and much faster than walking prefixes from JavaScript.
// -x keeps it on one filesystem; links are not followed, so nothing outside is counted.
function folderBytes(paths, { run = execFile } = {}) {
    const existing = paths.filter(item => { try { return fs.lstatSync(item).isDirectory(); } catch (_) { return false; } });
    if (!existing.length) return Promise.resolve(0);
    return new Promise(resolve => {
        run('du', ['-s', '-x', '-B1', '--', ...existing], { timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
            // du still prints totals when a few files can't be read; only a missing/failed du gives nothing.
            const total = String(stdout || '').split('\n').reduce((sum, line) => sum + (Number(line.split('\t')[0]) || 0), 0);
            resolve(total || (error ? null : 0));
        });
    });
}

async function storageSummary(options, { run } = {}) {
    const locations = storageLocations(options);
    const sizes = await Promise.all(locations.map(item => folderBytes(item.paths, { run })));
    return locations.map((item, index) => ({ key: item.key, label: item.label, description: item.description, clearable: !!item.clearable,
        bytes: sizes[index], openable: item.key !== 'cache' && item.paths.some(folder => fs.existsSync(folder)) }));
}

function storageFolder(options, key) {
    const location = storageLocations(options).find(item => item.key === key);
    if (!location || location.key === 'cache') throw new Error('This storage location cannot be opened.');
    const folder = location.paths.find(item => fs.existsSync(item));
    if (!folder) throw new Error('This folder does not exist yet.');
    return folder;
}

module.exports = { storageLocations, storageSummary, storageFolder, folderBytes };
