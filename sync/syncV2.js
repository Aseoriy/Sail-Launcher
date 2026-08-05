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
const SYNC_CONFIDENCE_STATES = Object.freeze([
    'idle',
    'syncing',
    'success',
    'failed',
    'paused',
    'unavailable'
]);
const SYNC_CONFIDENCE_CATEGORIES = Object.freeze(['config', 'library', 'saves', 'gameConfigs']);

function normalizeSyncTimestamp(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function safeSyncErrorMessage(error) {
    let message = error && error.message ? error.message : String(error || '');
    message = message.replace(/\s+/g, ' ').trim();
    if (!message) return 'Sync failed. Try again.';
    if (/offline|network|fetch|timed? ?out|temporarily unavailable|did not respond|ECONN|ENOTFOUND|EAI_AGAIN|\b50[23]\b/i.test(message)) {
        return 'Offline or temporarily unavailable. Check your connection and try again.';
    }
    if (/\b40[13]\b|authentication|session|sign in|credential|access token|refresh token/i.test(message)) {
        return 'Your account session needs attention. Sign in again and retry.';
    }
    message = message
        .replace(/https?:\/\/[^\s]+/gi, 'the remote service')
        .replace(/[A-Za-z]:[\\/][^\s,;)]*/g, 'a local file')
        .replace(/\b(?:access|refresh|api)[-_ ]?token\b\s*[:=]?\s*[^\s,;]+/gi, 'account credentials')
        .replace(/\bauthorization\b\s*[:=]?\s*bearer\s+[^\s,;]+/gi, 'account credentials')
        .replace(/\bbearer\s+[^\s,;]+/gi, 'account credentials')
        .replace(/\bauthorization\b\s*[:=]?\s*[^\s,;]+/gi, 'account credentials')
        .replace(/\b(?:password|api[-_ ]?key|client[-_ ]?secret)\b\s*[:=]\s*[^\s,;]+/gi, 'account credentials')
        .slice(0, 220)
        .trim();
    return message || 'Sync failed. Try again.';
}

function syncConfidenceStateForError(error) {
    const message = error && error.message ? error.message : String(error || '');
    return /offline|network|fetch|timed? ?out|temporarily unavailable|did not respond|ECONN|ENOTFOUND|EAI_AGAIN|\b50[23]\b/i.test(message)
        ? 'unavailable'
        : 'failed';
}

function normalizeSyncConfidence(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const normalizeRecord = record => {
        const input = record && typeof record === 'object' ? record : {};
        return {
            state: SYNC_CONFIDENCE_STATES.includes(input.state) ? input.state : 'idle',
            lastSuccessfulAt: normalizeSyncTimestamp(input.lastSuccessfulAt),
            lastFailedAt: normalizeSyncTimestamp(input.lastFailedAt),
            error: input.error ? safeSyncErrorMessage(input.error) : ''
        };
    };
    const categories = {};
    SYNC_CONFIDENCE_CATEGORIES.forEach(category => {
        categories[category] = normalizeRecord(source.categories && source.categories[category]);
    });
    return {
        schemaVersion: 1,
        ...normalizeRecord(source),
        categories
    };
}

function recordSyncConfidence(value, category, state, details = {}) {
    const next = normalizeSyncConfidence(value);
    const target = SYNC_CONFIDENCE_CATEGORIES.includes(category) ? next.categories[category] : next;
    const nextState = SYNC_CONFIDENCE_STATES.includes(state) ? state : 'idle';
    const timestamp = normalizeSyncTimestamp(details.timestamp) || Date.now();
    target.state = nextState;
    if (nextState === 'success') {
        target.lastSuccessfulAt = timestamp;
        target.error = '';
    } else if (nextState === 'failed' || nextState === 'unavailable') {
        target.lastFailedAt = timestamp;
        target.error = safeSyncErrorMessage(details.error || details.message || 'Sync failed.');
    }
    return next;
}

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
    delete settings.syncConfidence;
    delete settings.syncStatus;
    delete settings.sailSyncConfidenceV2;
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
    normalizeSyncConfidence,
    recordSyncConfidence,
    safeSyncErrorMessage,
    syncConfidenceStateForError,
    SYNC_CONFIDENCE_CATEGORIES,
    SYNC_CONFIDENCE_STATES,
    portableGame,
    portableSnapshot,
    sha256File
};
