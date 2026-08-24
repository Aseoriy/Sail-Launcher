'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ACHIEVEMENT_EXTENSIONS = new Set(['.json', '.ini', '.cfg']);
const ACHIEVEMENT_TEXT_FILES = new Set(['achievement', 'achievements.txt', 'stats.txt']);
const APP_ID_FILES = [
    'steam_appid.txt',
    path.join('steam_settings', 'steam_appid.txt'),
    path.join('steam_settings', 'configs.app.ini'),
    path.join('steam_settings', 'configs.user.ini'),
    'steam_emu.ini',
    'SmartSteamEmu.ini'
];

function isAchievementFilePath(filePath) {
    const basename = path.basename(filePath).toLowerCase();
    return ACHIEVEMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
        || ACHIEVEMENT_TEXT_FILES.has(basename)
        || /^usergamestatsschema_\d+\.bin$/i.test(basename);
}

function normalizedPath(filePath) {
    try {
        return path.resolve(String(filePath || '')).replace(/[\\/]+$/, '').toLowerCase();
    } catch (_) {
        return String(filePath || '').toLowerCase();
    }
}

function samePath(left, right) {
    const a = path.resolve(String(left || ''));
    const b = path.resolve(String(right || ''));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathInside(candidate, root) {
    if (samePath(candidate, root)) return true;
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveApprovedPath(targetPath, options = {}, expectedKind = '') {
    const fileSystem = options.fs || fs;
    const raw = String(targetPath || '');
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw) || !path.isAbsolute(raw)) return null;
    const target = path.resolve(raw);
    const roots = Array.isArray(options.approvedRoots) ? options.approvedRoots : [];
    const root = roots.find(candidate => candidate && typeof candidate.path === 'string'
        && (candidate.kind === 'file' ? samePath(target, candidate.path) : pathInside(target, candidate.path)));
    if (!root) return null;
    const rootPath = path.resolve(root.path);
    try {
        const rootLinkStat = fileSystem.lstatSync(rootPath);
        if (rootLinkStat.isSymbolicLink()) return null;
        const rootRealPath = fileSystem.realpathSync.native
            ? fileSystem.realpathSync.native(rootPath)
            : fileSystem.realpathSync(rootPath);
        if (!samePath(rootRealPath, rootPath)) return null;
        const rootStat = fileSystem.statSync(rootRealPath);
        if (root.kind === 'file' && !rootStat.isFile() || root.kind === 'directory' && !rootStat.isDirectory()) return null;
        if (root.dev !== undefined && String(root.dev) !== String(rootStat.dev)
            || root.ino !== undefined && String(root.ino) !== String(rootStat.ino)
            || Number.isFinite(root.birthtimeMs) && Number(root.birthtimeMs) !== Math.round(rootStat.birthtimeMs || 0)) return null;

        if (root.kind === 'directory') {
            const relative = path.relative(rootPath, target);
            let cursor = rootPath;
            for (const segment of relative ? relative.split(path.sep) : []) {
                cursor = path.join(cursor, segment);
                if (fileSystem.lstatSync(cursor).isSymbolicLink()) return null;
            }
        }
        const linkStat = fileSystem.lstatSync(target);
        if (linkStat.isSymbolicLink()) return null;
        if (expectedKind === 'file' && !linkStat.isFile()
            || expectedKind === 'directory' && !linkStat.isDirectory()) return null;
        const realPath = fileSystem.realpathSync.native
            ? fileSystem.realpathSync.native(target)
            : fileSystem.realpathSync(target);
        if (root.kind === 'file' ? !samePath(realPath, rootRealPath) : !pathInside(realPath, rootRealPath)) return null;
        return path.normalize(realPath);
    } catch (_) {
        return null;
    }
}

function findSteamRoot(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'steamRoot')) return options.steamRoot || '';
    if (process.platform !== 'win32') return '';
    const run = options.execFileSync || childProcess.execFileSync;
    try {
        const output = run('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 3000
        });
        const match = String(output).match(/SteamPath\s+REG_SZ\s+(.+)/i);
        return match ? match[1].trim().replace(/\//g, '\\') : '';
    } catch (_) {
        return '';
    }
}

function resolveInstalledSteamApp(appIdInput, options = {}) {
    const appId = String(appIdInput || '');
    if (!/^[1-9]\d{0,9}$/.test(appId)) return null;
    const fileSystem = options.fs || fs;
    const steamRoot = findSteamRoot(options);
    if (!steamRoot || !path.isAbsolute(steamRoot)) return null;
    try {
        const rootPath = path.resolve(steamRoot);
        const rootLink = fileSystem.lstatSync(rootPath);
        if (!rootLink.isDirectory() || rootLink.isSymbolicLink()) return null;
        const rootRealPath = fileSystem.realpathSync.native
            ? fileSystem.realpathSync.native(rootPath)
            : fileSystem.realpathSync(rootPath);
        if (!samePath(rootRealPath, rootPath)) return null;
        const rootStat = fileSystem.statSync(rootRealPath);
        const manifestPath = path.join(rootRealPath, 'steamapps', `appmanifest_${appId}.acf`);
        const manifestLink = fileSystem.lstatSync(manifestPath);
        if (!manifestLink.isFile() || manifestLink.isSymbolicLink()) return null;
        const manifestRealPath = fileSystem.realpathSync.native
            ? fileSystem.realpathSync.native(manifestPath)
            : fileSystem.realpathSync(manifestPath);
        if (!pathInside(manifestRealPath, rootRealPath)) return null;
        return {
            appId,
            rootIdentity: {
                realPath: path.normalize(rootRealPath),
                kind: 'directory',
                dev: String(rootStat.dev),
                ino: String(rootStat.ino),
                birthtimeMs: Math.round(rootStat.birthtimeMs || 0)
            }
        };
    } catch (_) {
        return null;
    }
}

function gameRoots(game = {}) {
    const roots = [];
    for (const value of [game.installFolder, game.exePath]) {
        if (!value) continue;
        const ext = path.extname(value).toLowerCase();
        const root = ext === '.exe' || ext === '.bat' || ext === '.lnk' ? path.dirname(value) : value;
        if (root && !roots.some(existing => normalizedPath(existing) === normalizedPath(root))) roots.push(root);
    }
    return roots;
}

function validAppId(value) {
    const text = String(value || '').trim();
    return /^\d{1,12}$/.test(text) && text !== '0' ? text : '';
}

function resolveGameAppId(game = {}, options = {}) {
    const explicit = validAppId(game.steamAppId || (game.achievementData && game.achievementData.appId));
    if (explicit) return explicit;
    const fileSystem = options.fs || fs;
    for (const root of gameRoots(game)) {
        for (const relativePath of APP_ID_FILES) {
            const filePath = path.join(root, relativePath);
            try {
                const approvedPath = resolveApprovedPath(filePath, options, 'file');
                if (!approvedPath) continue;
                const stat = fileSystem.lstatSync(approvedPath);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) continue;
                const text = String(fileSystem.readFileSync(approvedPath, 'utf8')).replace(/^\uFEFF/, '');
                const plain = validAppId(text);
                if (plain) return plain;
                const match = text.match(/(?:^|[\r\n])\s*(?:app_?id|steam_?app_?id)\s*[=:]\s*["']?(\d{1,12})/i);
                if (match && validAppId(match[1])) return match[1];
            } catch (_) {}
        }
    }
    for (const source of Array.isArray(game.achievementSources) ? game.achievementSources : []) {
        const fromPath = String(source && source.path || '').replace(/\\/g, '/').match(/(?:Goldberg SteamEmu Saves|GSE Saves|CODEX|RUNE|OnlineFix|Steam\/(?:CODEX|RLD!|dodi)|EMPRESS|SKIDROW|RLE|\.1911|CreamAPI)\/(\d{1,12})(?:\/|$)/i);
        if (fromPath && validAppId(fromPath[1])) return fromPath[1];
    }
    return '';
}

function automaticCandidatePaths(game = {}, options = {}) {
    const appId = resolveGameAppId(game, options);
    const env = options.env || process.env;
    const appData = env.APPDATA || '';
    const localAppData = env.LOCALAPPDATA || (appData ? path.resolve(appData, '..', 'Local') : '');
    const programData = env.PROGRAMDATA || 'C:\\ProgramData';
    const publicRoot = env.PUBLIC || 'C:\\Users\\Public';
    const publicDocuments = path.join(publicRoot, 'Documents');
    const documents = options.documentsPath || (env.USERPROFILE ? path.join(env.USERPROFILE, 'Documents') : '');
    const candidates = [];
    if (appId && options.allowKnownLocations === true) candidates.push(
        path.join(publicDocuments, 'Steam', 'CODEX', appId, 'achievements.ini'),
        path.join(publicDocuments, 'Steam', 'RUNE', appId, 'achievements.ini'),
        path.join(publicDocuments, 'OnlineFix', appId, 'Stats', 'Achievements.ini'),
        path.join(publicDocuments, 'OnlineFix', appId, 'Achievements.ini'),
        path.join(publicDocuments, 'EMPRESS', appId, 'remote', appId, 'achievements.json'),
        path.join(programData, 'RLD!', appId, 'achievements.ini'),
        path.join(programData, 'Steam', 'Player', appId, 'stats', 'achievements.ini'),
        path.join(programData, 'Steam', 'RLD!', appId, 'achievements.ini'),
        path.join(programData, 'Steam', 'RLD!', appId, 'stats', 'achievements.ini'),
        path.join(programData, 'Steam', 'dodi', appId, 'achievements.ini'),
        path.join(programData, 'Steam', 'dodi', appId, 'stats', 'achievements.ini')
    );
    if (appId && appData && options.allowKnownLocations === true) candidates.push(
        path.join(appData, 'Goldberg SteamEmu Saves', appId, 'achievements.json'),
        path.join(appData, 'Goldberg SteamEmu Saves', appId, 'achievements.ini'),
        path.join(appData, 'GSE Saves', appId, 'achievements.json'),
        path.join(appData, 'GSE Saves', appId, 'achievements.ini'),
        path.join(appData, 'Steam', 'CODEX', appId, 'achievements.ini'),
        path.join(appData, 'SmartSteamEmu', appId, 'User', 'Achievements.ini'),
        path.join(appData, 'CreamAPI', appId, 'stats', 'CreamAPI.Achievements.cfg'),
        path.join(appData, 'EMPRESS', 'remote', appId, 'achievements.json'),
        path.join(appData, 'RLE', appId, 'achievements.ini'),
        path.join(appData, 'RLE', appId, 'Achievements.ini'),
        path.join(appData, '.1911', appId, 'achievement')
    );
    if (appId && documents && options.allowKnownLocations === true) candidates.push(
        path.join(documents, 'SKIDROW', appId, 'SteamEmu', 'UserStats', 'achiev.ini'),
        path.join(documents, 'Player', appId, 'SteamEmu', 'UserStats', 'achiev.ini')
    );
    if (appId && localAppData && options.allowKnownLocations === true) candidates.push(
        path.join(localAppData, 'SKIDROW', appId, 'SteamEmu', 'UserStats', 'achiev.ini')
    );

    const localNames = [
        'achievements.json',
        'achievements.ini',
        'achievements.cfg',
        'Achievements.ini',
        'user_stats.ini',
        path.join('steam_settings', 'achievements.json'),
        path.join('steam_settings', 'achievements.ini'),
        path.join('steam_settings', 'stats', 'achievements.json'),
        path.join('SteamData', 'achievements.json'),
        path.join('SteamData', 'achievements.ini'),
        path.join('SteamData', 'user_stats.ini'),
        path.join('3DMGAME', 'Player', 'stats', 'achievements.ini'),
        path.join('settings', 'achievements.json'),
        path.join('settings', 'achievements.ini')
    ];
    if (appId) localNames.push(
        `UserGameStatsSchema_${appId}.bin`,
        path.join('steam_settings', `UserGameStatsSchema_${appId}.bin`)
    );
    for (const root of gameRoots(game)) {
        for (const name of localNames) candidates.push(path.join(root, name));
    }

    const steamRoot = options.allowSteamData === true ? findSteamRoot(options) : '';
    if (steamRoot && appId && options.allowSteamData === true) {
        candidates.push(path.join(steamRoot, 'appcache', 'stats', `UserGameStatsSchema_${appId}.bin`));
        const userdataRoot = path.join(steamRoot, 'userdata');
        const fileSystem = options.fs || fs;
        try {
            const approvedUserdataRoot = resolveApprovedPath(userdataRoot, options, 'directory');
            if (!approvedUserdataRoot) return candidates;
            for (const accountId of fileSystem.readdirSync(approvedUserdataRoot)) {
                if (!/^\d+$/.test(accountId)) continue;
                candidates.push(path.join(approvedUserdataRoot, accountId, 'config', 'librarycache', `${appId}.json`));
            }
        } catch (_) {}
    }
    return candidates;
}

function collectMappedFiles(source, options = {}) {
    const fileSystem = options.fs || fs;
    const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 2;
    const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 128;
    const files = [];
    const sourcePath = String(source && source.path || '').trim();
    if (!sourcePath || source.enabled === false) return files;

    function walk(target, depth) {
        if (files.length >= maxFiles || depth > maxDepth) return;
        const approvedTarget = resolveApprovedPath(target, options);
        if (!approvedTarget) return;
        let stat;
        try { stat = fileSystem.lstatSync(approvedTarget); } catch (_) { return; }
        if (stat.isSymbolicLink()) return;
        if (stat.isFile()) {
            if (isAchievementFilePath(approvedTarget)) files.push(approvedTarget);
            return;
        }
        if (!stat.isDirectory()) return;
        let names = [];
        try { names = fileSystem.readdirSync(approvedTarget); } catch (_) { return; }
        for (const name of names) {
            if (files.length >= maxFiles) break;
            walk(path.join(approvedTarget, name), depth + 1);
        }
    }

    walk(sourcePath, 0);
    return files;
}

function candidateAchievementPaths(game = {}, options = {}) {
    const result = automaticCandidatePaths(game, options).map(filePath => ({
        path: filePath,
        custom: false,
        sourceId: null
    }));
    for (const source of Array.isArray(game.achievementSources) ? game.achievementSources : []) {
        for (const filePath of collectMappedFiles(source, options)) {
            result.push({ path: filePath, custom: true, sourceId: source.id || null });
        }
    }
    const seen = new Set();
    return result.filter(candidate => {
        const key = normalizedPath(candidate.path);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function discoverAchievementFiles(game = {}, options = {}) {
    const fileSystem = options.fs || fs;
    const files = [];
    for (const candidate of candidateAchievementPaths(game, options)) {
        try {
            const approvedPath = resolveApprovedPath(candidate.path, options, 'file');
            if (!approvedPath) continue;
            const stat = fileSystem.lstatSync(approvedPath);
            if (stat.isFile() && !stat.isSymbolicLink()) files.push({ ...candidate, path: approvedPath });
        } catch (_) {}
    }
    return files;
}

function achievementWatchDirectories(game = {}, options = {}) {
    const fileSystem = options.fs || fs;
    const directories = [];
    for (const candidate of automaticCandidatePaths(game, options)) directories.push(path.dirname(candidate));
    for (const source of Array.isArray(game.achievementSources) ? game.achievementSources : []) {
        if (!source || source.enabled === false || !source.path) continue;
        try {
            const approvedSource = resolveApprovedPath(source.path, options);
            if (!approvedSource) continue;
            const stat = fileSystem.lstatSync(approvedSource);
            directories.push(stat.isDirectory() ? approvedSource : path.dirname(approvedSource));
        } catch (_) {}
    }
    const seen = new Set();
    return directories.map(directory => resolveApprovedPath(directory, options, 'directory')).filter(directory => {
        if (!directory) return false;
        const key = normalizedPath(directory);
        if (!key || seen.has(key)) return false;
        try {
            if (!fileSystem.statSync(directory).isDirectory()) return false;
        } catch (_) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

module.exports = {
    ACHIEVEMENT_EXTENSIONS,
    achievementWatchDirectories,
    automaticCandidatePaths,
    candidateAchievementPaths,
    collectMappedFiles,
    discoverAchievementFiles,
    findSteamRoot,
    gameRoots,
    isAchievementFilePath,
    normalizedPath,
    resolveApprovedPath,
    resolveGameAppId,
    resolveInstalledSteamApp,
    validAppId
};
