const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const ARTIFACT_TYPES = Object.freeze([
    'launcher-config',
    'library',
    'preset',
    'theme',
    'game-save',
    'game-config'
]);

const INTERVAL_MINUTES = Object.freeze([5, 10, 15, 30, 60]);
const CONFLICT_MODES = Object.freeze(['prompt', 'newest', 'local']);

function normalizeSyncSettings(value = {}) {
    const settings = value && typeof value === 'object' ? value : {};
    const normalizeTargets = category => Array.from(new Set(
        Array.isArray(settings.destinations && settings.destinations[category])
            ? settings.destinations[category].filter(provider =>
                ['google', 'onedrive', 'dropbox', 'mediafire'].includes(provider)
                || category === 'saves' && provider === 'sailcloud'
            )
            : []
    ));
    const sailCloudExcludedGameSaveKeys = Array.isArray(settings.sailCloudExcludedGameSaveKeys)
        ? Array.from(new Set(settings.sailCloudExcludedGameSaveKeys
            .map(key => String(key || '').trim().slice(0, 300))
            .filter(key => key.startsWith('game-save:'))))
        : [];
    const interval = Number(settings.configIntervalMinutes);
    return {
        enabled: settings.enabled !== false,
        conflictMode: CONFLICT_MODES.includes(settings.conflictMode) ? settings.conflictMode : 'prompt',
        configChangeMode: ['off', 'debounced', 'immediate'].includes(settings.configChangeMode)
            ? settings.configChangeMode
            : 'debounced',
        configIntervalMinutes: INTERVAL_MINUTES.includes(interval) ? interval : 0,
        configOnStartup: settings.configOnStartup !== false,
        configBeforeExit: settings.configBeforeExit !== false,
        saveBeforeLaunch: settings.saveBeforeLaunch !== false,
        saveAfterExit: settings.saveAfterExit !== false,
        gameConfigBeforeLaunch: !!settings.gameConfigBeforeLaunch,
        gameConfigAfterExit: !!settings.gameConfigAfterExit,
        sailCloudSingleSaveCopy: !!settings.sailCloudSingleSaveCopy,
        sailCloudExcludedGameSaveKeys,
        destinations: {
            config: normalizeTargets('config'),
            library: normalizeTargets('library'),
            saves: normalizeTargets('saves'),
            gameConfigs: normalizeTargets('gameConfigs')
        }
    };
}

function portableGame(game = {}) {
    const copy = { ...game };
    [
        'exePath', 'installFolder', 'localSave', 'driveSave', 'playDetectionPath',
        'companionApp', 'preLaunchScript', 'postLaunchScript', 'shortcutIcon'
    ].forEach(key => delete copy[key]);
    if (Array.isArray(copy.configSyncEntries)) {
        copy.configSyncEntries = copy.configSyncEntries.map(entry => {
            const portable = { ...entry };
            delete portable.localPath;
            return portable;
        });
    }
    return copy;
}

function portableSnapshot(snapshot = {}) {
    const settings = { ...(snapshot.globalSettings || {}) };
    delete settings.customCloudKeysData;
    delete settings.steamApiKey;
    delete settings.discordToken;
    delete settings.customFont;
    delete settings.defaultDriveFolder;
    delete settings.quickPaths;
    delete settings.localLauncherAvatar;
    delete settings.uiAppBg;
    delete settings.uiAppBgStore;
    delete settings.accountSyncEnabled;
    return {
        schemaVersion: 2,
        myGames: Array.isArray(snapshot.myGames) ? snapshot.myGames.map(portableGame) : [],
        customSections: Array.isArray(snapshot.customSections) ? snapshot.customSections : [],
        globalSettings: settings
    };
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function newestMtime(targetPath) {
    if (!targetPath || !fs.existsSync(targetPath)) return 0;
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) return stat.mtimeMs;
    let newest = stat.mtimeMs;
    for (const name of fs.readdirSync(targetPath)) {
        try {
            newest = Math.max(newest, newestMtime(path.join(targetPath, name)));
        } catch (_) {}
    }
    return newest;
}

function decideConflict({ mode = 'prompt', localChanged, remoteChanged, localTime = 0, remoteTime = 0 }) {
    if (!localChanged && !remoteChanged) return 'noop';
    if (localChanged && !remoteChanged) return 'upload';
    if (!localChanged && remoteChanged) return 'download';
    if (mode === 'local') return 'upload';
    if (mode === 'newest') return remoteTime > localTime ? 'download' : 'upload';
    return 'prompt';
}

function normalizeConfigEntry(entry = {}) {
    return {
        id: entry.id || crypto.randomUUID(),
        name: String(entry.name || 'Game Configuration').trim().slice(0, 80),
        kind: entry.kind === 'file' ? 'file' : 'folder',
        localPath: String(entry.localPath || ''),
        enabled: entry.enabled !== false,
        beforeLaunch: !!entry.beforeLaunch,
        afterExit: entry.afterExit !== false,
        intervalMinutes: INTERVAL_MINUTES.includes(Number(entry.intervalMinutes))
            ? Number(entry.intervalMinutes)
            : 0
    };
}

module.exports = {
    ARTIFACT_TYPES,
    CONFLICT_MODES,
    INTERVAL_MINUTES,
    decideConflict,
    newestMtime,
    normalizeConfigEntry,
    normalizeSyncSettings,
    portableGame,
    portableSnapshot,
    sha256File
};
