'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const { mergeAchievementData } = require('../achievements/achievementLogic');
const {
    PORTABLE_SCHEMA,
    admitPortableArtifact,
    createPortableSnapshot,
    serializePortableArtifact,
    validatePortableArtifact
} = require('../sync/portableArtifactV3');
const { CapabilityStore, durableWriteJson } = require('../security/capabilityStore');
const { legacyLocalArtifactStem } = require('../security/archiveDataBinding');

const PROFILE_SCHEMA_VERSION = 3;
const DEVICE_OVERLAY_SCHEMA_VERSION = 1;
const MIGRATION_SCHEMA_VERSION = 1;
const LOCAL_BACKUP_SCHEMA = 'sail.local-backup/v1';
const LOCAL_BACKUP_LIMIT = 16 * 1024 * 1024;
const STATE_KEYS = new Set([
    'schemaVersion', 'deviceId', 'activeProfileId', 'activeLibraryId',
    'activePresetId', 'profiles'
]);
const PROFILE_KEYS = new Set([
    'id', 'name', 'createdAt', 'updatedAt', 'pinSalt', 'pinVerifier',
    'localAvatarPath', 'conflictMode', 'libraries', 'presets'
]);
const ITEM_KEYS = new Set(['id', 'name', 'createdAt', 'updatedAt']);
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const AUTHORITY_GAME_KEYS = new Set([
    'exePath', 'executablePath', 'installFolder', 'installPath', 'emulatorPath',
    'romPath', 'romArgs', 'launchArgs', 'argv', 'workingDirectory',
    'preLaunchScript', 'postLaunchScript', 'companionApp', 'companionPath',
    'runAsAdmin', 'highPriority', 'playDetectionPath', 'localSave', 'driveSave',
    'saveScanDirectories', 'configSyncEntries', 'achievementSources'
]);
const DERIVED_GAME_KEYS = new Set([
    'localSetupStatus', 'localSaveSetupStatus', 'authorityReviewComponents'
]);
const PROTECTED_LOCAL_SETTING_KEYS = new Set([
    'steamApiKey', 'discordToken', 'customCloudKeysData', 'debrid'
]);
const SECRET_KEY_PATTERN = /(?:password|passphrase|secret|token|cookie|authorization|api[-_]?key|client[-_]?secret|pin[-_]?salt|pin[-_]?verifier)/i;
const MIGRATION_JOURNAL_KEYS = new Set([
    'schemaVersion', 'transactionId', 'status', 'preparedAt', 'hadExistingRoot',
    'backupRoot', 'stageRoot', 'originalManifest', 'committedAt', 'rolledBackAt',
    'portableDigest'
]);
const MIGRATION_STATUSES = new Set(['prepared', 'backed-up', 'verified', 'committed', 'rolled-back']);

class ProfileStoreError extends Error {
    constructor(code, message, cause = null) {
        super(message);
        this.name = 'ProfileStoreError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

function fail(code, message, cause = null) {
    throw new ProfileStoreError(code, message, cause);
}

function makeId() {
    return crypto.randomUUID();
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function portableMetadataOnlyEnabled(settings) {
    return isPlainObject(settings) && settings.portableMetadataOnly === true;
}

function applyPortableMetadataOnly(artifact, profileIds) {
    const selectedProfiles = new Set([...profileIds].map(value => String(value)));
    const filtered = clone(artifact);
    filtered.libraries = filtered.libraries.map(library => {
        if (!selectedProfiles.has(String(library.profileId))) return library;
        return {
            ...library,
            games: library.games.map(game => {
                const { configSyncEntries, ...metadata } = game;
                return metadata;
            })
        };
    });
    filtered.presets = filtered.presets.map(preset => {
        if (!selectedProfiles.has(String(preset.profileId))) return preset;
        const settings = isPlainObject(preset.settings) ? { ...preset.settings } : {};
        if (isPlainObject(settings.syncV2)) {
            const syncV2 = { ...settings.syncV2 };
            syncV2.gameConfigBeforeLaunch = false;
            syncV2.gameConfigAfterExit = false;
            syncV2.destinations = isPlainObject(syncV2.destinations)
                ? { ...syncV2.destinations, gameConfigs: [] }
                : { gameConfigs: [] };
            settings.syncV2 = syncV2;
        }
        settings.portableMetadataOnly = true;
        return { ...preset, settings };
    });
    return validatePortableArtifact(filtered);
}

function assertExactObject(value, allowed, label) {
    if (!isPlainObject(value)) fail('SAIL_PROFILE_INVALID', `${label} must be an object.`);
    for (const key of Object.keys(value)) {
        if (PROTOTYPE_KEYS.has(key) || !allowed.has(key)) fail('SAIL_PROFILE_INVALID', `${label}.${key} is not allowed.`);
    }
    return value;
}

function cleanName(value, fallback) {
    const text = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
    return text || fallback;
}

function cleanId(value, fallback = makeId()) {
    const text = String(value || '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text) ? text : fallback;
}

function cleanTimestamp(value, fallback = new Date().toISOString()) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
}

function hashPin(pin, salt = crypto.randomBytes(16)) {
    const derived = crypto.scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1 });
    return { salt: salt.toString('base64'), verifier: derived.toString('base64') };
}

function verifyPin(pin, record) {
    if (!record || !record.pinVerifier || !record.pinSalt) return true;
    const actual = hashPin(pin, Buffer.from(record.pinSalt, 'base64')).verifier;
    const left = Buffer.from(actual, 'base64');
    const right = Buffer.from(record.pinVerifier, 'base64');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function directoryManifest(rootPath) {
    if (!fs.existsSync(rootPath)) return [];
    const result = [];
    const visit = (current, relative) => {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) fail('SAIL_PROFILE_MIGRATION_UNSAFE', 'Profile migration refuses linked files and directories.');
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), path.join(relative, name));
            return;
        }
        if (!stat.isFile()) fail('SAIL_PROFILE_MIGRATION_UNSAFE', 'Profile migration found an unsupported filesystem entry.');
        result.push({ path: relative.replace(/\\/g, '/'), size: stat.size, sha256: sha256File(current) });
    };
    visit(rootPath, '');
    return result;
}

function manifestsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function validateMigrationJournal(journal, migrationRoot) {
    if (!isPlainObject(journal)) throw new TypeError('Migration journal must be an object.');
    for (const key of Object.keys(journal)) {
        if (PROTOTYPE_KEYS.has(key) || !MIGRATION_JOURNAL_KEYS.has(key)) throw new TypeError(`Migration journal field ${key} is invalid.`);
    }
    if (journal.schemaVersion !== MIGRATION_SCHEMA_VERSION
        || typeof journal.transactionId !== 'string'
        || !/^\d{1,20}-[0-9a-f]{16}$/.test(journal.transactionId)
        || !MIGRATION_STATUSES.has(journal.status)
        || typeof journal.hadExistingRoot !== 'boolean'
        || !Number.isFinite(Date.parse(journal.preparedAt || ''))) {
        throw new TypeError('Migration journal header is invalid.');
    }
    const transactionRoot = path.join(migrationRoot, journal.transactionId);
    const expectedBackup = path.join(transactionRoot, 'backup');
    const expectedStage = path.join(transactionRoot, 'stage', 'SailProfiles');
    if (path.resolve(String(journal.backupRoot || '')) !== path.resolve(expectedBackup)
        || path.resolve(String(journal.stageRoot || '')) !== path.resolve(expectedStage)) {
        throw new TypeError('Migration journal paths are invalid.');
    }
    if (!Array.isArray(journal.originalManifest) || journal.originalManifest.length > 250000) {
        throw new TypeError('Migration journal manifest is invalid.');
    }
    const manifestPaths = new Set();
    for (const item of journal.originalManifest) {
        if (!isPlainObject(item) || Object.keys(item).some(key => !['path', 'size', 'sha256'].includes(key))
            || typeof item.path !== 'string' || !item.path || item.path.length > 2048
            || path.isAbsolute(item.path) || item.path.split('/').some(segment => !segment || segment === '.' || segment === '..')
            || /[\u0000-\u001f\u007f\\]/.test(item.path) || manifestPaths.has(item.path)
            || !Number.isSafeInteger(item.size) || item.size < 0
            || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) {
            throw new TypeError('Migration journal manifest entry is invalid.');
        }
        manifestPaths.add(item.path);
    }
    for (const key of ['committedAt', 'rolledBackAt']) {
        if (journal[key] !== undefined && !Number.isFinite(Date.parse(journal[key]))) throw new TypeError(`Migration journal ${key} is invalid.`);
    }
    if (journal.portableDigest !== undefined && !/^[0-9a-f]{64}$/.test(String(journal.portableDigest))) {
        throw new TypeError('Migration journal portable digest is invalid.');
    }
    return journal;
}

function sanitizedDeviceValue(value, depth = 0) {
    if (depth > 6) return undefined;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
        if (value.length > 32767 || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 512) return undefined;
        return value.map(item => sanitizedDeviceValue(item, depth + 1)).filter(item => item !== undefined);
    }
    if (!isPlainObject(value)) return undefined;
    const output = {};
    const entries = Object.entries(value);
    if (entries.length > 256) return undefined;
    for (const [key, child] of entries) {
        if (PROTOTYPE_KEYS.has(key) || SECRET_KEY_PATTERN.test(key)) continue;
        const sanitized = sanitizedDeviceValue(child, depth + 1);
        if (sanitized !== undefined) output[key] = sanitized;
    }
    return output;
}

function sanitizedProtectedValue(value, depth = 0) {
    if (depth > 8) return undefined;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
        if (value.length > 65536 || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 512) return undefined;
        return value.map(item => sanitizedProtectedValue(item, depth + 1)).filter(item => item !== undefined);
    }
    if (!isPlainObject(value)) return undefined;
    const output = {};
    const entries = Object.entries(value);
    if (entries.length > 256) return undefined;
    for (const [key, child] of entries) {
        if (PROTOTYPE_KEYS.has(key) || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) continue;
        const sanitized = sanitizedProtectedValue(child, depth + 1);
        if (sanitized !== undefined) output[key] = sanitized;
    }
    return output;
}

function extractProtectedLocalSettings(settings = {}) {
    if (!isPlainObject(settings)) return {};
    const output = {};
    for (const key of PROTECTED_LOCAL_SETTING_KEYS) {
        const sanitized = sanitizedProtectedValue(settings[key]);
        if (sanitized !== undefined) output[key] = sanitized;
    }
    return output;
}

function emptyDeviceOverlay() {
    return {
        schemaVersion: DEVICE_OVERLAY_SCHEMA_VERSION,
        legacyRecoveryVersion: 1,
        games: {}, sections: {}, settings: {}, warnings: {}, storageAliases: {}
    };
}

function validateStorageAliases(value) {
    if (!isPlainObject(value) || Object.keys(value).length > 10000) fail('SAIL_PROFILE_INVALID', 'Device storage aliases are invalid.');
    for (const [gameId, record] of Object.entries(value)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gameId)) fail('SAIL_PROFILE_INVALID', 'A device storage alias has an invalid game ID.');
        assertExactObject(record, new Set(['stem']), `device storage alias ${gameId}`);
        if (legacyLocalArtifactStem(record.stem) !== record.stem) fail('SAIL_PROFILE_INVALID', `Device storage alias ${gameId} is invalid.`);
    }
    return value;
}

function extractDeviceOverlay(snapshot = {}, portableArtifact = null) {
    const overlay = emptyDeviceOverlay();
    const portableLibrary = portableArtifact && Array.isArray(portableArtifact.libraries)
        ? portableArtifact.libraries[0]
        : null;
    const portableGames = new Map((portableLibrary && portableLibrary.games || []).map(game => [String(game.id), game]));
    for (const game of Array.isArray(snapshot.myGames) ? snapshot.myGames : []) {
        if (!game || !game.id) continue;
        const local = {};
        const portableGame = portableGames.get(String(game.id)) || {};
        for (const [key, value] of Object.entries(game)) {
            if (PROTOTYPE_KEYS.has(key) || AUTHORITY_GAME_KEYS.has(key) || DERIVED_GAME_KEYS.has(key)
                || Object.prototype.hasOwnProperty.call(portableGame, key)) continue;
            const sanitized = sanitizedDeviceValue(value);
            if (sanitized !== undefined && sanitized !== '' && sanitized !== null) local[key] = sanitized;
        }
        if (Object.keys(local).length) overlay.games[String(game.id)] = local;
    }
    const portableSections = portableLibrary && portableLibrary.sections || [];
    for (const section of Array.isArray(snapshot.customSections) ? snapshot.customSections : []) {
        if (!section || typeof section !== 'object') continue;
        const portableSection = portableSections.find(item =>
            section.id && String(item.id) === String(section.id)
            || String(item.name || '') === String(section.name || '')
        );
        if (!portableSection) continue;
        const local = {};
        for (const [key, value] of Object.entries(section)) {
            if (PROTOTYPE_KEYS.has(key) || Object.prototype.hasOwnProperty.call(portableSection, key)) continue;
            const sanitized = sanitizedDeviceValue(value);
            if (sanitized !== undefined && sanitized !== '' && sanitized !== null) local[key] = sanitized;
        }
        if (Object.keys(local).length) overlay.sections[String(portableSection.id)] = local;
    }
    const settings = isPlainObject(snapshot.globalSettings) ? snapshot.globalSettings : {};
    const portableSettings = portableArtifact && Array.isArray(portableArtifact.presets)
        && portableArtifact.presets[0] && portableArtifact.presets[0].settings || {};
    for (const [key, value] of Object.entries(settings)) {
        if (PROTOTYPE_KEYS.has(key) || PROTECTED_LOCAL_SETTING_KEYS.has(key)
            || SECRET_KEY_PATTERN.test(key) || Object.prototype.hasOwnProperty.call(portableSettings, key)) continue;
        const sanitized = sanitizedDeviceValue(value);
        if (sanitized !== undefined) overlay.settings[key] = sanitized;
    }
    return overlay;
}

function decodeLocalBackupInput(input) {
    let parsed = input;
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        const bytes = Buffer.from(input);
        if (bytes.length > LOCAL_BACKUP_LIMIT) fail('SAIL_LOCAL_BACKUP_TOO_LARGE', 'Local backups must be 16 MiB or smaller.');
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch (error) { fail('SAIL_LOCAL_BACKUP_INVALID', 'The selected local backup is not valid UTF-8 JSON.', error); }
    } else if (typeof input === 'string') {
        if (Buffer.byteLength(input, 'utf8') > LOCAL_BACKUP_LIMIT) fail('SAIL_LOCAL_BACKUP_TOO_LARGE', 'Local backups must be 16 MiB or smaller.');
        try { parsed = JSON.parse(input); }
        catch (error) { fail('SAIL_LOCAL_BACKUP_INVALID', 'The selected local backup is not valid JSON.', error); }
    } else {
        let serialized;
        try { serialized = JSON.stringify(input); }
        catch (error) { fail('SAIL_LOCAL_BACKUP_INVALID', 'The local backup cannot be serialized.', error); }
        if (!serialized || Buffer.byteLength(serialized, 'utf8') > LOCAL_BACKUP_LIMIT) {
            fail('SAIL_LOCAL_BACKUP_TOO_LARGE', 'Local backups must be 16 MiB or smaller.');
        }
        try { parsed = JSON.parse(serialized); }
        catch (error) { fail('SAIL_LOCAL_BACKUP_INVALID', 'The local backup is invalid.', error); }
    }
    if (!isPlainObject(parsed)) fail('SAIL_LOCAL_BACKUP_INVALID', 'The selected local backup must contain a launcher snapshot.');
    return parsed;
}

function validateLocalBackupAuthorities(value) {
    if (value === undefined || value === null) return null;
    if (!isPlainObject(value) || value.schemaVersion !== 1 || !isPlainObject(value.games)) {
        fail('SAIL_LOCAL_BACKUP_INVALID', 'The local backup authority section is invalid.');
    }
    for (const key of Object.keys(value)) {
        if (!['schemaVersion', 'games'].includes(key)) fail('SAIL_LOCAL_BACKUP_INVALID', `Local backup authority field ${key} is not supported.`);
    }
    const gameEntries = Object.entries(value.games);
    if (gameEntries.length > 10001) fail('SAIL_LOCAL_BACKUP_INVALID', 'The local backup contains too many authority records.');
    const executionKeys = new Set([
        'executablePath', 'argv', 'workingDirectory', 'preLaunchScript',
        'postLaunchScript', 'companionPath', 'runAsAdmin', 'highPriority',
        'playDetectionPath', 'steamAppId'
    ]);
    for (const [gameId, record] of gameEntries) {
        if (PROTOTYPE_KEYS.has(gameId) || cleanId(gameId, '') !== gameId || !isPlainObject(record)) {
            fail('SAIL_LOCAL_BACKUP_INVALID', 'A local backup game authority record is invalid.');
        }
        for (const key of Object.keys(record)) {
            if (!['execution', 'filesystems'].includes(key)) fail('SAIL_LOCAL_BACKUP_INVALID', `Local backup authority ${gameId}.${key} is not supported.`);
        }
        if (record.execution !== null && record.execution !== undefined) {
            if (!isPlainObject(record.execution) || Object.keys(record.execution).some(key => !executionKeys.has(key))) {
                fail('SAIL_LOCAL_BACKUP_INVALID', `Local backup execution authority for ${gameId} is invalid.`);
            }
            const execution = record.execution;
            for (const key of ['executablePath', 'workingDirectory', 'preLaunchScript', 'postLaunchScript', 'companionPath', 'playDetectionPath']) {
                if (execution[key] !== undefined && (typeof execution[key] !== 'string' || execution[key].length > 32767
                    || execution[key] && !path.isAbsolute(execution[key]))) {
                    fail('SAIL_LOCAL_BACKUP_INVALID', `Local backup execution field ${gameId}.${key} is invalid.`);
                }
            }
            if (!Array.isArray(execution.argv) || execution.argv.length > 128
                || execution.argv.some(argument => typeof argument !== 'string' || argument.length > 32767 || /[\u0000\r\n]/.test(argument))) {
                fail('SAIL_LOCAL_BACKUP_INVALID', `Local backup arguments for ${gameId} are invalid.`);
            }
            if (typeof execution.runAsAdmin !== 'boolean' || typeof execution.highPriority !== 'boolean'
                || execution.steamAppId && !/^[1-9]\d{0,9}$/.test(String(execution.steamAppId))) {
                fail('SAIL_LOCAL_BACKUP_INVALID', `Local backup execution flags for ${gameId} are invalid.`);
            }
        }
        if (!Array.isArray(record.filesystems) || record.filesystems.length > 128) {
            fail('SAIL_LOCAL_BACKUP_INVALID', `Local backup filesystem authority for ${gameId} is invalid.`);
        }
        for (const item of record.filesystems) {
            if (!isPlainObject(item) || Object.keys(item).some(key => !['kind', 'entryId', 'rootPath'].includes(key))
                || !['save', 'config', 'download-root', 'install-root', 'archive-root', 'achievement-file', 'achievement-folder'].includes(item.kind)
                || typeof item.entryId !== 'string' || item.entryId && cleanId(item.entryId, '') !== item.entryId
                || typeof item.rootPath !== 'string' || item.rootPath.length > 32767 || !path.isAbsolute(item.rootPath)) {
                fail('SAIL_LOCAL_BACKUP_INVALID', `A local backup filesystem entry for ${gameId} is invalid.`);
            }
        }
    }
    return clone(value);
}

function localBackupSnapshot(value) {
    if (!isPlainObject(value) || !Array.isArray(value.myGames) || value.myGames.length > 10000
        || !Array.isArray(value.customSections) || value.customSections.length > 512
        || !isPlainObject(value.globalSettings)) {
        fail('SAIL_LOCAL_BACKUP_INVALID', 'The selected file does not contain a valid Sail Launcher backup.');
    }
    return {
        myGames: clone(value.myGames),
        customSections: clone(value.customSections),
        globalSettings: clone(value.globalSettings)
    };
}

function mergePortableGames(localGames, remoteGames, options = {}) {
    const local = Array.isArray(localGames) ? localGames : [];
    const remote = Array.isArray(remoteGames) ? remoteGames : [];
    const localById = new Map(local.map(game => [String(game.id), game]));
    const merged = [];
    for (const remoteGame of remote) {
        const localGame = localById.get(String(remoteGame.id));
        if (!localGame) {
            merged.push(clone(remoteGame));
            continue;
        }
        const game = { ...clone(remoteGame) };
        const achievementData = mergeAchievementData(localGame.achievementData, remoteGame.achievementData, remoteGame.steamAppId || localGame.steamAppId);
        if (achievementData) game.achievementData = achievementData;
        game.playtime = Math.max(Number(remoteGame.playtime) || 0, Number(localGame.playtime) || 0);
        const latestPlayedAt = Math.max(Number(remoteGame.lastPlayed) || 0, Number(localGame.lastPlayed) || 0);
        game.lastPlayed = latestPlayedAt || remoteGame.lastPlayed || localGame.lastPlayed || null;
        game.playtimeSessionIds = [...new Set([
            ...(Array.isArray(remoteGame.playtimeSessionIds) ? remoteGame.playtimeSessionIds : []),
            ...(Array.isArray(localGame.playtimeSessionIds) ? localGame.playtimeSessionIds : [])
        ])].slice(-50);
        if (options.preserveLocalConfigSyncEntries && Array.isArray(localGame.configSyncEntries)) {
            game.configSyncEntries = clone(localGame.configSyncEntries);
        }
        merged.push(game);
        localById.delete(String(remoteGame.id));
    }
    for (const game of local) {
        if (localById.has(String(game.id))) merged.push(clone(game));
    }
    return merged;
}

function defaultState() {
    const now = new Date().toISOString();
    const profileId = makeId();
    const libraryId = makeId();
    const presetId = makeId();
    return {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        deviceId: makeId(),
        activeProfileId: profileId,
        activeLibraryId: libraryId,
        activePresetId: presetId,
        profiles: [{
            id: profileId,
            name: 'Default Profile',
            createdAt: now,
            updatedAt: now,
            pinSalt: null,
            pinVerifier: null,
            localAvatarPath: null,
            conflictMode: 'prompt',
            libraries: [{ id: libraryId, name: 'Main Library', createdAt: now, updatedAt: now }],
            presets: [{ id: presetId, name: 'Default Settings', createdAt: now, updatedAt: now }]
        }]
    };
}

function normalizeState(input) {
    assertExactObject(input, STATE_KEYS, 'profile state');
    if (input.schemaVersion !== PROFILE_SCHEMA_VERSION || !Array.isArray(input.profiles) || !input.profiles.length || input.profiles.length > 64) {
        fail('SAIL_PROFILE_INVALID', 'The profile state schema is invalid.');
    }
    const ids = new Set();
    for (const [profileIndex, profile] of input.profiles.entries()) {
        assertExactObject(profile, PROFILE_KEYS, `profiles[${profileIndex}]`);
        if (cleanId(profile.id, '') !== profile.id || ids.has(profile.id)) fail('SAIL_PROFILE_INVALID', 'Profile IDs must be valid and unique.');
        ids.add(profile.id);
        if (!Array.isArray(profile.libraries) || !profile.libraries.length || profile.libraries.length > 256
            || !Array.isArray(profile.presets) || !profile.presets.length || profile.presets.length > 256) {
            fail('SAIL_PROFILE_INVALID', 'Each profile must have bounded libraries and presets.');
        }
        for (const [collectionName, items] of [['libraries', profile.libraries], ['presets', profile.presets]]) {
            const itemIds = new Set();
            for (const [index, item] of items.entries()) {
                assertExactObject(item, ITEM_KEYS, `profiles[${profileIndex}].${collectionName}[${index}]`);
                if (cleanId(item.id, '') !== item.id || itemIds.has(item.id)) fail('SAIL_PROFILE_INVALID', 'Library and preset IDs must be valid and unique.');
                itemIds.add(item.id);
            }
        }
    }
    const activeProfile = input.profiles.find(profile => profile.id === input.activeProfileId);
    if (!activeProfile || !activeProfile.libraries.some(item => item.id === input.activeLibraryId)
        || !activeProfile.presets.some(item => item.id === input.activePresetId)) {
        fail('SAIL_PROFILE_INVALID', 'The active profile, library, or preset reference is invalid.');
    }
    return input;
}

class ProfileStore {
    constructor(userDataPath, options = {}) {
        this.userDataPath = path.resolve(userDataPath);
        this.root = path.join(this.userDataPath, 'SailProfiles');
        this.statePath = path.join(this.root, 'state.json');
        this.migrationRoot = path.join(this.userDataPath, 'SailGateAMigration');
        this.journalPath = path.join(this.migrationRoot, 'journal.json');
        this.state = null;
        this.pinFailures = new Map();
        this.migrationReady = false;
        this.faultInjector = typeof options.faultInjector === 'function' ? options.faultInjector : () => {};
        this.capabilityStore = null;
    }

    atomicWrite(destination, value) {
        durableWriteJson(destination, value);
    }

    libraryPath(profileId, libraryId, root = this.root) {
        return path.join(root, 'profiles', profileId, 'portable', 'libraries', `${libraryId}.json`);
    }

    presetPath(profileId, presetId, root = this.root) {
        return path.join(root, 'profiles', profileId, 'portable', 'presets', `${presetId}.json`);
    }

    overlayPath(profileId, libraryId, root = this.root) {
        return path.join(root, 'profiles', profileId, 'device-local', `${libraryId}.json`);
    }

    profilePath(profileId) {
        return path.join(this.root, 'profiles', profileId);
    }

    legacyLibraryPath(profileId, libraryId, root = this.root) {
        return path.join(root, 'profiles', profileId, 'libraries', `${libraryId}.json`);
    }

    legacyPresetPath(profileId, presetId, root = this.root) {
        return path.join(root, 'profiles', profileId, 'presets', `${presetId}.json`);
    }

    activeScope(gameId = null) {
        if (!this.state) return null;
        return {
            profileId: this.state.activeProfileId,
            libraryId: this.state.activeLibraryId,
            ...(gameId ? { gameId: String(gameId) } : {})
        };
    }

    initialize() {
        if (this.state) return this.getState();
        this.recoverIncompleteMigration();
        if (fs.existsSync(this.statePath)) {
            let loaded;
            try { loaded = fsExtra.readJsonSync(this.statePath); }
            catch (error) { fail('SAIL_PROFILE_OPEN_FAILED', 'The local profile state could not be read. No remote merge was attempted.', error); }
            if (loaded && loaded.schemaVersion === PROFILE_SCHEMA_VERSION) {
                try {
                    this.state = normalizeState(loaded);
                    this.capabilityStore = new CapabilityStore(path.join(this.root, 'authority'), () => this.activeScope());
                    this.capabilityStore.initialize();
                    this.capabilityStore.promoteTrustedLocalPending([
                        'legacy-migration', 'local-import', 'steam-import', 'epic-import',
                        'gog-import', 'download-proposal', 'local-backup-import'
                    ]);
                    this.verifyPortableStore();
                    this.recoverMissingLegacyOverlay();
                    this.migrationReady = true;
                    return this.getState();
                } catch (error) {
                    this.state = null;
                    this.capabilityStore = null;
                    fail('SAIL_PROFILE_OPEN_FAILED', 'The local Gate A profile store failed verification. No remote merge was attempted.', error);
                }
            }
        }
        this.migrateLocalData();
        return this.getState();
    }

    recoverIncompleteMigration() {
        if (!fs.existsSync(this.journalPath)) return;
        let journal;
        try { journal = fsExtra.readJsonSync(this.journalPath); }
        catch (error) { fail('SAIL_PROFILE_MIGRATION_BLOCKED', 'The Gate A migration journal is unreadable. Profiles remain closed.', error); }
        try { validateMigrationJournal(journal, this.migrationRoot); }
        catch (error) { fail('SAIL_PROFILE_MIGRATION_BLOCKED', 'The Gate A migration journal is invalid. Profiles remain closed.', error); }
        if (['committed', 'rolled-back'].includes(journal.status)) return;
        this.rollbackMigration(journal);
        journal.status = 'rolled-back';
        journal.rolledBackAt = new Date().toISOString();
        this.atomicWrite(this.journalPath, journal);
        fail('SAIL_PROFILE_MIGRATION_ROLLED_BACK', 'An incomplete Gate A migration was rolled back exactly. Restart Sail Launcher to retry.');
    }

    readLegacyModel() {
        if (fs.existsSync(this.statePath)) {
            const legacyState = fsExtra.readJsonSync(this.statePath);
            if (!legacyState || legacyState.schemaVersion !== 2 || !Array.isArray(legacyState.profiles)) {
                fail('SAIL_PROFILE_MIGRATION_BLOCKED', 'The existing profile store uses an unsupported schema.');
            }
            const profiles = legacyState.profiles.map((sourceProfile, profileIndex) => {
                const profileId = cleanId(sourceProfile.id);
                const libraries = (Array.isArray(sourceProfile.libraries) ? sourceProfile.libraries : []).map((sourceLibrary, libraryIndex) => {
                    const libraryId = cleanId(sourceLibrary.id);
                    const sourcePath = this.legacyLibraryPath(sourceProfile.id, sourceLibrary.id);
                    const snapshot = fs.existsSync(sourcePath) ? fsExtra.readJsonSync(sourcePath) : {};
                    return {
                        id: libraryId,
                        name: cleanName(sourceLibrary.name, `Library ${libraryIndex + 1}`),
                        createdAt: cleanTimestamp(sourceLibrary.createdAt),
                        updatedAt: cleanTimestamp(sourceLibrary.updatedAt || sourceProfile.updatedAt),
                        snapshot
                    };
                });
                const presets = (Array.isArray(sourceProfile.presets) ? sourceProfile.presets : []).map((sourcePreset, presetIndex) => {
                    const presetId = cleanId(sourcePreset.id);
                    const sourcePath = this.legacyPresetPath(sourceProfile.id, sourcePreset.id);
                    const snapshot = fs.existsSync(sourcePath) ? fsExtra.readJsonSync(sourcePath) : {};
                    return {
                        id: presetId,
                        name: cleanName(sourcePreset.name, `Preset ${presetIndex + 1}`),
                        createdAt: cleanTimestamp(sourcePreset.createdAt),
                        updatedAt: cleanTimestamp(sourcePreset.updatedAt || sourceProfile.updatedAt),
                        snapshot
                    };
                });
                if (!libraries.length) libraries.push({ id: makeId(), name: 'Main Library', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), snapshot: {} });
                if (!presets.length) presets.push({ id: makeId(), name: 'Default Settings', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), snapshot: {} });
                return {
                    id: profileId,
                    name: cleanName(sourceProfile.name, `Profile ${profileIndex + 1}`),
                    createdAt: cleanTimestamp(sourceProfile.createdAt),
                    updatedAt: cleanTimestamp(sourceProfile.updatedAt),
                    pinSalt: typeof sourceProfile.pinSalt === 'string' ? sourceProfile.pinSalt : null,
                    pinVerifier: typeof sourceProfile.pinVerifier === 'string' ? sourceProfile.pinVerifier : null,
                    localAvatarPath: typeof sourceProfile.localAvatarPath === 'string' ? sourceProfile.localAvatarPath : null,
                    conflictMode: ['prompt', 'newest', 'local'].includes(sourceProfile.conflictMode) ? sourceProfile.conflictMode : 'prompt',
                    libraries,
                    presets
                };
            });
            if (!profiles.length) fail('SAIL_PROFILE_MIGRATION_BLOCKED', 'The existing profile store contains no profiles.');
            const activeProfile = profiles.find(profile => profile.id === legacyState.activeProfileId) || profiles[0];
            return {
                deviceId: cleanId(legacyState.deviceId), profiles,
                activeProfileId: activeProfile.id,
                activeLibraryId: activeProfile.libraries.some(item => item.id === legacyState.activeLibraryId) ? legacyState.activeLibraryId : activeProfile.libraries[0].id,
                activePresetId: activeProfile.presets.some(item => item.id === legacyState.activePresetId) ? legacyState.activePresetId : activeProfile.presets[0].id
            };
        }
        const state = defaultState();
        const legacyPath = path.join(this.userDataPath, 'sail_library.json');
        let snapshot = {};
        if (fs.existsSync(legacyPath)) {
            try { snapshot = fsExtra.readJsonSync(legacyPath); }
            catch (error) { fail('SAIL_PROFILE_MIGRATION_BLOCKED', 'The legacy launcher data could not be read safely.', error); }
        }
        const profile = state.profiles[0];
        return {
            deviceId: state.deviceId,
            activeProfileId: profile.id,
            activeLibraryId: profile.libraries[0].id,
            activePresetId: profile.presets[0].id,
            profiles: [{
                ...profile,
                libraries: [{ ...profile.libraries[0], snapshot }],
                presets: [{ ...profile.presets[0], snapshot }]
            }]
        };
    }

    migrateLocalData() {
        const model = this.readLegacyModel();
        fsExtra.ensureDirSync(this.migrationRoot);
        const transactionId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
        const transactionRoot = path.join(this.migrationRoot, transactionId);
        const backupRoot = path.join(transactionRoot, 'backup');
        const stageRoot = path.join(transactionRoot, 'stage', 'SailProfiles');
        const hadExistingRoot = fs.existsSync(this.root);
        const originalManifest = hadExistingRoot ? directoryManifest(this.root) : [];
        const journal = {
            schemaVersion: MIGRATION_SCHEMA_VERSION,
            transactionId,
            status: 'prepared',
            preparedAt: new Date().toISOString(),
            hadExistingRoot,
            backupRoot,
            stageRoot,
            originalManifest
        };
        this.atomicWrite(this.journalPath, journal);
        this.faultInjector('prepared');
        try {
            if (hadExistingRoot) {
                fsExtra.ensureDirSync(path.dirname(backupRoot));
                fsExtra.moveSync(this.root, backupRoot, { overwrite: false });
            }
            const legacyPath = path.join(this.userDataPath, 'sail_library.json');
            if (fs.existsSync(legacyPath)) {
                fsExtra.ensureDirSync(path.join(transactionRoot, 'legacy'));
                fs.copyFileSync(legacyPath, path.join(transactionRoot, 'legacy', 'sail_library.json'));
            }
            journal.status = 'backed-up';
            this.atomicWrite(this.journalPath, journal);
            this.faultInjector('backed-up');

            const newState = {
                schemaVersion: PROFILE_SCHEMA_VERSION,
                deviceId: model.deviceId,
                activeProfileId: model.activeProfileId,
                activeLibraryId: model.activeLibraryId,
                activePresetId: model.activePresetId,
                profiles: model.profiles.map(profile => ({
                    id: profile.id,
                    name: profile.name,
                    createdAt: profile.createdAt,
                    updatedAt: profile.updatedAt,
                    pinSalt: profile.pinSalt || null,
                    pinVerifier: profile.pinVerifier || null,
                    localAvatarPath: profile.localAvatarPath || null,
                    conflictMode: profile.conflictMode || 'prompt',
                    libraries: profile.libraries.map(({ snapshot, ...item }) => item),
                    presets: profile.presets.map(({ snapshot, ...item }) => item)
                }))
            };
            normalizeState(newState);
            this.atomicWrite(path.join(stageRoot, 'state.json'), newState);
            const stagedCapabilities = new CapabilityStore(path.join(stageRoot, 'authority'), () => ({
                profileId: newState.activeProfileId,
                libraryId: newState.activeLibraryId
            }));
            stagedCapabilities.initialize();
            for (const profile of model.profiles) {
                for (const library of profile.libraries) {
                    const matchingPreset = profile.presets[0];
                    const combined = {
                        myGames: Array.isArray(library.snapshot.myGames) ? library.snapshot.myGames : [],
                        customSections: Array.isArray(library.snapshot.customSections) ? library.snapshot.customSections : [],
                        globalSettings: matchingPreset && matchingPreset.snapshot.globalSettings || library.snapshot.globalSettings || {}
                    };
                    const projected = createPortableSnapshot(combined, {
                        profileId: profile.id,
                        profileName: profile.name,
                        libraryId: library.id,
                        libraryName: library.name,
                        presetId: matchingPreset.id,
                        presetName: matchingPreset.name,
                        conflictMode: profile.conflictMode,
                        exportedAt: profile.updatedAt
                    });
                    const portableLibrary = projected.artifact.libraries[0];
                    this.atomicWrite(this.libraryPath(profile.id, library.id, stageRoot), {
                        schemaVersion: PROFILE_SCHEMA_VERSION,
                        library: portableLibrary
                    });
                    const overlay = extractDeviceOverlay(combined, projected.artifact);
                    for (const gameId of projected.diagnostics.authorityWarningGameIds) {
                        overlay.warnings[gameId] = { kind: 'local-migration', recoveredLocally: true };
                    }
                    const rawGames = Array.isArray(library.snapshot.myGames) ? library.snapshot.myGames : [];
                    for (const rawGame of rawGames) {
                        const gameId = cleanId(rawGame && rawGame.id, '');
                        if (!gameId || !portableLibrary.games.some(game => game.id === gameId)) continue;
                        const legacyStem = legacyLocalArtifactStem(rawGame && rawGame.name);
                        if (legacyStem) overlay.storageAliases[gameId] = { stem: legacyStem };
                        stagedCapabilities.migrateLegacyGame({ profileId: profile.id, libraryId: library.id, gameId }, rawGame);
                    }
                    this.atomicWrite(this.overlayPath(profile.id, library.id, stageRoot), overlay);
                    const settings = isPlainObject(combined.globalSettings) ? combined.globalSettings : {};
                    const launcherScope = { profileId: profile.id, libraryId: library.id, gameId: 'launcher-device' };
                    for (const [kind, keys] of Object.entries({
                        'download-root': ['dlInstallDir', 'downloadDirectory', 'defaultDriveFolder'],
                        'install-root': ['installDirectory'],
                        'archive-root': ['archiveDirectory']
                    })) {
                        const proposedPath = keys.map(key => settings[key]).find(value => typeof value === 'string' && path.isAbsolute(value));
                        if (proposedPath) stagedCapabilities.adoptTrustedLocalFilesystem(launcherScope, kind, proposedPath, '', 'legacy-migration');
                    }
                }
                for (const preset of profile.presets) {
                    const matchingLibrary = profile.libraries[0];
                    const combined = {
                        myGames: [], customSections: [],
                        globalSettings: preset.snapshot.globalSettings || {}
                    };
                    const projected = createPortableSnapshot(combined, {
                        profileId: profile.id,
                        profileName: profile.name,
                        libraryId: matchingLibrary.id,
                        libraryName: matchingLibrary.name,
                        presetId: preset.id,
                        presetName: preset.name,
                        conflictMode: profile.conflictMode,
                        exportedAt: profile.updatedAt
                    });
                    this.atomicWrite(this.presetPath(profile.id, preset.id, stageRoot), {
                        schemaVersion: PROFILE_SCHEMA_VERSION,
                        preset: projected.artifact.presets[0]
                    });
                }
            }
            this.verifyPortableStore(stageRoot, newState);
            journal.status = 'verified';
            this.atomicWrite(this.journalPath, journal);
            this.faultInjector('verified');
            fsExtra.moveSync(stageRoot, this.root, { overwrite: false });
            journal.status = 'committed';
            journal.committedAt = new Date().toISOString();
            journal.portableDigest = crypto.createHash('sha256').update(serializePortableArtifact(this.assembleControlPlane(this.root, newState))).digest('hex');
            this.atomicWrite(this.journalPath, journal);
            this.state = newState;
            this.capabilityStore = new CapabilityStore(path.join(this.root, 'authority'), () => this.activeScope());
            this.capabilityStore.initialize();
            this.verifyPortableStore();
            this.migrationReady = true;
        } catch (error) {
            try {
                this.rollbackMigration(journal);
                journal.status = 'rolled-back';
                journal.rolledBackAt = new Date().toISOString();
                this.atomicWrite(this.journalPath, journal);
            } catch (rollbackError) {
                fail('SAIL_PROFILE_MIGRATION_BLOCKED', 'Gate A migration and exact rollback both failed. Profiles remain closed.', rollbackError);
            }
            fail('SAIL_PROFILE_MIGRATION_ROLLED_BACK', 'Gate A migration failed and the previous profile data was restored exactly.', error);
        }
    }

    rollbackMigration(journal) {
        try { validateMigrationJournal(journal, this.migrationRoot); }
        catch (error) { fail('SAIL_PROFILE_MIGRATION_BLOCKED', 'The Gate A migration journal cannot authorize rollback.', error); }
        if (journal.hadExistingRoot) {
            let rootMatches = false;
            let backupMatches = false;
            try { rootMatches = fs.existsSync(this.root) && manifestsEqual(directoryManifest(this.root), journal.originalManifest); } catch (_) {}
            try { backupMatches = fs.existsSync(journal.backupRoot) && manifestsEqual(directoryManifest(journal.backupRoot), journal.originalManifest); } catch (_) {}
            if (!rootMatches && !backupMatches) {
                fail('SAIL_PROFILE_MIGRATION_BLOCKED', 'Neither the current profile root nor the migration backup matches the pre-migration profile. No profile data was removed.');
            }
            if (!rootMatches) {
                if (fs.existsSync(this.root)) fsExtra.removeSync(this.root);
                fsExtra.moveSync(journal.backupRoot, this.root, { overwrite: false });
            }
            const restoredManifest = directoryManifest(this.root);
            if (!manifestsEqual(restoredManifest, journal.originalManifest)) {
                fail('SAIL_PROFILE_MIGRATION_BLOCKED', 'The restored profile data does not match its migration backup.');
            }
        } else if (fs.existsSync(this.root)) {
            fsExtra.removeSync(this.root);
        }
        if (journal.stageRoot && fs.existsSync(path.dirname(journal.stageRoot))) fsExtra.removeSync(path.dirname(journal.stageRoot));
    }

    assembleControlPlane(root = this.root, state = this.state) {
        const profiles = [];
        const libraries = [];
        const presets = [];
        for (const profile of state.profiles) {
            profiles.push({
                id: profile.id,
                name: profile.name,
                conflictMode: profile.conflictMode || 'prompt',
                createdAt: profile.createdAt,
                updatedAt: profile.updatedAt
            });
            for (const library of profile.libraries) {
                const document = fsExtra.readJsonSync(this.libraryPath(profile.id, library.id, root));
                assertExactObject(document, new Set(['schemaVersion', 'library']), 'portable library document');
                if (document.schemaVersion !== PROFILE_SCHEMA_VERSION) fail('SAIL_PROFILE_INVALID', 'Portable library schema is invalid.');
                libraries.push(document.library);
            }
            for (const preset of profile.presets) {
                const document = fsExtra.readJsonSync(this.presetPath(profile.id, preset.id, root));
                assertExactObject(document, new Set(['schemaVersion', 'preset']), 'portable preset document');
                if (document.schemaVersion !== PROFILE_SCHEMA_VERSION) fail('SAIL_PROFILE_INVALID', 'Portable preset schema is invalid.');
                presets.push(document.preset);
            }
        }
        return admitPortableArtifact({
            schema: PORTABLE_SCHEMA,
            kind: 'control-plane',
            exportedAt: new Date().toISOString(),
            profiles, libraries, presets
        }).artifact;
    }

    verifyPortableStore(root = this.root, state = this.state) {
        const artifact = this.assembleControlPlane(root, state);
        const serialized = serializePortableArtifact(artifact);
        const independentlyRead = JSON.parse(serialized);
        const verified = validatePortableArtifact(independentlyRead);
        if (serializePortableArtifact(verified) !== serialized) fail('SAIL_PROFILE_INVALID', 'Portable profile verification was not stable.');
        return verified;
    }

    ensureReady() {
        if (!this.state || !this.migrationReady) fail('SAIL_PROFILE_NOT_READY', 'Local profiles are not ready for portable reads, remote merges, or remote writes.');
    }

    saveState() {
        normalizeState(this.state);
        this.atomicWrite(this.statePath, this.state);
    }

    activeProfile() {
        return this.state && this.state.profiles.find(profile => profile.id === this.state.activeProfileId) || null;
    }

    getState() {
        if (!this.state) return null;
        return {
            schemaVersion: this.state.schemaVersion,
            deviceId: this.state.deviceId,
            activeProfileId: this.state.activeProfileId,
            activeLibraryId: this.state.activeLibraryId,
            activePresetId: this.state.activePresetId,
            migrationReady: this.migrationReady,
            profiles: this.state.profiles.map(profile => ({
                id: profile.id,
                name: profile.name,
                createdAt: profile.createdAt,
                updatedAt: profile.updatedAt,
                locked: !!profile.pinVerifier,
                localAvatarPath: profile.localAvatarPath && fs.existsSync(profile.localAvatarPath) ? profile.localAvatarPath : null,
                conflictMode: profile.conflictMode || 'prompt',
                libraries: profile.libraries.map(item => ({ ...item })),
                presets: profile.presets.map(item => ({ ...item }))
            }))
        };
    }

    readOverlay(profileId, libraryId) {
        const overlayPath = this.overlayPath(profileId, libraryId);
        if (!fs.existsSync(overlayPath)) {
            const overlay = emptyDeviceOverlay();
            overlay.legacyRecoveryVersion = 0;
            return overlay;
        }
        const overlay = fsExtra.readJsonSync(overlayPath);
        assertExactObject(overlay, new Set([
            'schemaVersion', 'legacyRecoveryVersion', 'games', 'sections',
            'settings', 'warnings', 'storageAliases'
        ]), 'device overlay');
        if (overlay.schemaVersion !== DEVICE_OVERLAY_SCHEMA_VERSION || !isPlainObject(overlay.games)
            || overlay.sections !== undefined && !isPlainObject(overlay.sections)
            || overlay.legacyRecoveryVersion !== undefined && overlay.legacyRecoveryVersion !== 1
            || !isPlainObject(overlay.settings) || !isPlainObject(overlay.warnings)) {
            fail('SAIL_PROFILE_INVALID', 'The device-local overlay is invalid.');
        }
        overlay.legacyRecoveryVersion = overlay.legacyRecoveryVersion === 1 ? 1 : 0;
        overlay.sections = isPlainObject(overlay.sections) ? overlay.sections : {};
        overlay.storageAliases = validateStorageAliases(overlay.storageAliases === undefined ? {} : overlay.storageAliases);
        return overlay;
    }

    recoverMissingLegacyOverlay() {
        const profile = this.activeProfile();
        if (!profile) return;
        const libraryId = this.state.activeLibraryId;
        const overlay = this.readOverlay(profile.id, libraryId);
        if (overlay.legacyRecoveryVersion === 1) return;
        const legacyPath = path.join(this.userDataPath, 'sail_library.json');
        if (!fs.existsSync(legacyPath)) {
            overlay.legacyRecoveryVersion = 1;
            this.atomicWrite(this.overlayPath(profile.id, libraryId), overlay);
            return;
        }
        try {
            const stat = fs.statSync(legacyPath);
            if (!stat.isFile() || stat.size > LOCAL_BACKUP_LIMIT) return;
            const legacy = fsExtra.readJsonSync(legacyPath);
            const libraryMeta = profile.libraries.find(item => item.id === libraryId);
            const presetMeta = profile.presets.find(item => item.id === this.state.activePresetId);
            const projected = createPortableSnapshot(legacy, {
                profileId: profile.id,
                profileName: profile.name,
                libraryId,
                libraryName: libraryMeta && libraryMeta.name || 'Main Library',
                presetId: presetMeta && presetMeta.id || profile.presets[0].id,
                presetName: presetMeta && presetMeta.name || 'Default Settings',
                conflictMode: profile.conflictMode
            });
            const recovered = extractDeviceOverlay(legacy, projected.artifact);
            const library = fsExtra.readJsonSync(this.libraryPath(profile.id, libraryId)).library;
            const gameIds = new Set(library.games.map(game => String(game.id)));
            const sectionIds = new Set(library.sections.map(section => String(section.id)));
            for (const [gameId, value] of Object.entries(recovered.games)) {
                if (!gameIds.has(gameId)) continue;
                overlay.games[gameId] = { ...clone(value), ...clone(overlay.games[gameId] || {}) };
            }
            for (const [sectionId, value] of Object.entries(recovered.sections)) {
                if (!sectionIds.has(sectionId)) continue;
                overlay.sections[sectionId] = { ...clone(value), ...clone(overlay.sections[sectionId] || {}) };
            }
            overlay.settings = { ...clone(recovered.settings), ...clone(overlay.settings) };
            overlay.legacyRecoveryVersion = 1;
            this.atomicWrite(this.overlayPath(profile.id, libraryId), overlay);
        } catch (_) {
            // Keep the recovery marker unset so a later launch can retry after a
            // transient read or parse failure without replacing current local values.
        }
    }

    loadActiveSnapshot() {
        this.ensureReady();
        const profile = this.activeProfile();
        if (!profile) fail('SAIL_PROFILE_INVALID', 'Active launcher profile is missing.');
        const libraryDocument = fsExtra.readJsonSync(this.libraryPath(profile.id, this.state.activeLibraryId));
        const presetDocument = fsExtra.readJsonSync(this.presetPath(profile.id, this.state.activePresetId));
        const overlay = this.readOverlay(profile.id, this.state.activeLibraryId);
        const games = libraryDocument.library.games.map(game => {
            const local = isPlainObject(overlay.games[game.id]) ? overlay.games[game.id] : {};
            const authority = this.capabilityStore.status({ profileId: profile.id, libraryId: this.state.activeLibraryId, gameId: game.id });
            const saveAuthority = authority.filesystems.find(capability => capability.label === 'save');
            const achievementSources = authority.filesystems
                .filter(capability => capability.kind === 'achievement-file' || capability.kind === 'achievement-folder')
                .map(capability => ({
                    id: capability.entryId || capability.capabilityId,
                    kind: capability.kind === 'achievement-folder' ? 'folder' : 'file',
                    label: capability.label,
                    capabilityId: capability.capabilityId,
                    expectedRevision: capability.revision,
                    state: capability.state,
                    enabled: capability.state === 'active'
                }));
            return {
                ...clone(game),
                ...clone(local),
                localSetupStatus: authority.execution.state,
                localSaveSetupStatus: saveAuthority && saveAuthority.state || 'local-setup-required',
                authorityReviewComponents: authority.execution.reviewComponents,
                achievementSources,
                configSyncEntries: game.configSyncEntries.map(entry => ({
                    ...entry,
                    localSetupStatus: (authority.filesystems.find(capability => capability.label === entry.id) || {}).state || 'local-setup-required'
                }))
            };
        });
        return {
            myGames: games,
            customSections: libraryDocument.library.sections.map(section => ({
                ...clone(section),
                ...clone(isPlainObject(overlay.sections[section.id]) ? overlay.sections[section.id] : {})
            })),
            globalSettings: { ...clone(presetDocument.preset.settings), ...clone(overlay.settings) }
        };
    }

    captureActiveSnapshot(snapshot = {}) {
        this.ensureReady();
        const profile = this.activeProfile();
        const libraryMeta = profile.libraries.find(item => item.id === this.state.activeLibraryId);
        const presetMeta = profile.presets.find(item => item.id === this.state.activePresetId);
        const projected = createPortableSnapshot(snapshot, {
            profileId: profile.id,
            profileName: profile.name,
            libraryId: libraryMeta.id,
            libraryName: libraryMeta.name,
            presetId: presetMeta.id,
            presetName: presetMeta.name,
            conflictMode: profile.conflictMode
        });
        this.atomicWrite(this.libraryPath(profile.id, libraryMeta.id), { schemaVersion: PROFILE_SCHEMA_VERSION, library: projected.artifact.libraries[0] });
        this.atomicWrite(this.presetPath(profile.id, presetMeta.id), { schemaVersion: PROFILE_SCHEMA_VERSION, preset: projected.artifact.presets[0] });
        const existingOverlay = this.readOverlay(profile.id, libraryMeta.id);
        const projectedOverlay = extractDeviceOverlay(snapshot, projected.artifact);
        const capturedGames = clone(projectedOverlay.games);
        projectedOverlay.warnings = clone(existingOverlay.warnings);
        projectedOverlay.storageAliases = clone(existingOverlay.storageAliases);
        projectedOverlay.games = Array.isArray(snapshot.myGames)
            ? { ...clone(existingOverlay.games), ...capturedGames }
            : clone(existingOverlay.games);
        if (Array.isArray(snapshot.myGames)) {
            for (const game of snapshot.myGames) {
                const gameId = game && cleanId(game.id, '');
                if (gameId && !Object.prototype.hasOwnProperty.call(capturedGames, gameId)) delete projectedOverlay.games[gameId];
            }
        }
        projectedOverlay.settings = isPlainObject(snapshot.globalSettings)
            ? projectedOverlay.settings
            : clone(existingOverlay.settings);
        projectedOverlay.sections = Array.isArray(snapshot.customSections)
            ? projectedOverlay.sections
            : clone(existingOverlay.sections);
        this.atomicWrite(this.overlayPath(profile.id, libraryMeta.id), projectedOverlay);
        profile.updatedAt = new Date().toISOString();
        libraryMeta.updatedAt = profile.updatedAt;
        presetMeta.updatedAt = profile.updatedAt;
        this.saveState();
        this.verifyPortableStore();
        return {
            saved: true,
            state: this.getState(),
            snapshot: this.loadActiveSnapshot(),
            diagnostics: projected.diagnostics
        };
    }

    exportControlPlane() {
        this.ensureReady();
        const artifact = this.verifyPortableStore();
        const metadataOnlyProfiles = new Set(artifact.presets
            .filter(preset => portableMetadataOnlyEnabled(preset.settings))
            .map(preset => preset.profileId));
        return metadataOnlyProfiles.size ? applyPortableMetadataOnly(artifact, metadataOnlyProfiles) : artifact;
    }

    exportActivePortable() {
        this.ensureReady();
        const artifact = this.exportControlPlane();
        const profileId = this.state.activeProfileId;
        return validatePortableArtifact({
            schema: PORTABLE_SCHEMA,
            kind: 'launcher-snapshot',
            exportedAt: new Date().toISOString(),
            profiles: artifact.profiles.filter(item => item.id === profileId),
            libraries: artifact.libraries.filter(item => item.id === this.state.activeLibraryId && item.profileId === profileId),
            presets: artifact.presets.filter(item => item.id === this.state.activePresetId && item.profileId === profileId)
        });
    }

    exportActiveLocalBackup() {
        this.ensureReady();
        const snapshot = this.loadActiveSnapshot();
        const games = snapshot.myGames.map(game => {
            const output = clone(game);
            for (const key of DERIVED_GAME_KEYS) delete output[key];
            delete output.achievementSources;
            if (Array.isArray(output.configSyncEntries)) {
                output.configSyncEntries = output.configSyncEntries.map(entry => {
                    const cleanEntry = clone(entry);
                    delete cleanEntry.localSetupStatus;
                    return cleanEntry;
                });
            }
            return sanitizedDeviceValue(output);
        }).filter(isPlainObject);
        const settings = sanitizedDeviceValue(snapshot.globalSettings) || {};
        for (const key of PROTECTED_LOCAL_SETTING_KEYS) delete settings[key];
        return {
            schema: LOCAL_BACKUP_SCHEMA,
            exportedAt: new Date().toISOString(),
            snapshot: {
                myGames: games,
                customSections: snapshot.customSections.map(section => sanitizedDeviceValue(section)).filter(isPlainObject),
                globalSettings: settings
            },
            authorities: this.capabilityStore.exportLocalAuthorities(
                this.state.activeProfileId,
                this.state.activeLibraryId
            )
        };
    }

    restoreLocalBackupAuthorities(authoritiesInput, gameIds, source = 'local-backup-import') {
        const authorities = validateLocalBackupAuthorities(authoritiesInput);
        const summary = { executionRestored: 0, filesystemRestored: 0, skipped: 0 };
        if (!authorities) return summary;
        for (const [gameId, record] of Object.entries(authorities.games)) {
            if (gameId !== 'launcher-device' && !gameIds.has(gameId)) {
                summary.skipped += 1;
                continue;
            }
            const scope = { ...this.activeScope(), gameId };
            if (record.execution && gameId !== 'launcher-device') {
                const restored = this.capabilityStore.adoptTrustedLocalExecutionDetails(scope, record.execution, source);
                if (restored) summary.executionRestored += 1;
                else summary.skipped += 1;
            }
            for (const item of record.filesystems) {
                if (gameId === 'launcher-device' && !['download-root', 'install-root', 'archive-root'].includes(item.kind)
                    || gameId !== 'launcher-device' && ['download-root', 'install-root', 'archive-root'].includes(item.kind)) {
                    summary.skipped += 1;
                    continue;
                }
                const restored = this.capabilityStore.adoptTrustedLocalFilesystem(
                    scope, item.kind, item.rootPath, item.entryId, source
                );
                if (restored) summary.filesystemRestored += 1;
                else summary.skipped += 1;
            }
        }
        return summary;
    }

    importActiveLocalBackup(input) {
        this.ensureReady();
        const parsed = decodeLocalBackupInput(input);
        const rollback = this.exportActiveLocalBackup();
        const rollbackRoot = path.join(this.root, 'import-backups');
        const rollbackName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.json`;
        this.atomicWrite(path.join(rollbackRoot, rollbackName), rollback);

        if (parsed.schema === PORTABLE_SCHEMA) {
            const imported = this.importActivePortable(parsed);
            return {
                ...imported,
                importKind: 'portable',
                rollbackCreated: true,
                protectedSettings: {}
            };
        }

        let snapshot;
        let authorities = null;
        let importKind = 'legacy-local';
        if (parsed.schema === LOCAL_BACKUP_SCHEMA) {
            for (const key of Object.keys(parsed)) {
                if (!['schema', 'exportedAt', 'snapshot', 'authorities'].includes(key)) {
                    fail('SAIL_LOCAL_BACKUP_INVALID', `Local backup field ${key} is not supported.`);
                }
            }
            if (!Number.isFinite(Date.parse(parsed.exportedAt || ''))) {
                fail('SAIL_LOCAL_BACKUP_INVALID', 'The local backup timestamp is invalid.');
            }
            snapshot = localBackupSnapshot(parsed.snapshot);
            authorities = validateLocalBackupAuthorities(parsed.authorities);
            importKind = 'local-backup';
        } else {
            snapshot = localBackupSnapshot(parsed);
        }

        const protectedSettings = extractProtectedLocalSettings(snapshot.globalSettings);
        const profileSnapshot = clone(snapshot);
        for (const key of PROTECTED_LOCAL_SETTING_KEYS) delete profileSnapshot.globalSettings[key];
        this.captureActiveSnapshot(profileSnapshot);
        const activeSnapshot = this.loadActiveSnapshot();
        const gameIds = new Set(activeSnapshot.myGames.map(game => String(game.id)));
        let authoritySummary;
        if (authorities) {
            authoritySummary = this.restoreLocalBackupAuthorities(authorities, gameIds);
        } else {
            authoritySummary = { executionRestored: 0, filesystemRestored: 0, skipped: 0 };
            const rawGames = Array.isArray(snapshot.myGames) ? snapshot.myGames : [];
            for (let index = 0; index < rawGames.length; index += 1) {
                const rawGame = rawGames[index];
                const gameId = rawGame && cleanId(rawGame.id, '') || activeSnapshot.myGames[index] && activeSnapshot.myGames[index].id;
                if (!gameId || !gameIds.has(String(gameId))) continue;
                const created = this.capabilityStore.migrateLegacyGame(this.authorityScope(String(gameId)), rawGame || {});
                if (created.execution) authoritySummary.executionRestored += 1;
                authoritySummary.filesystemRestored += created.filesystems.length;
            }
            const settings = snapshot.globalSettings || {};
            const launcherScope = this.launcherDeviceScope();
            for (const [kind, keys] of Object.entries({
                'download-root': ['dlInstallDir', 'downloadDirectory', 'defaultDriveFolder'],
                'install-root': ['installDirectory'],
                'archive-root': ['archiveDirectory']
            })) {
                const candidate = keys.map(key => settings[key]).find(value => typeof value === 'string' && path.isAbsolute(value));
                if (!candidate) continue;
                const restored = this.capabilityStore.adoptTrustedLocalFilesystem(
                    launcherScope, kind, candidate, '', 'local-backup-import'
                );
                if (restored) authoritySummary.filesystemRestored += 1;
                else authoritySummary.skipped += 1;
            }
        }
        return {
            state: this.getState(),
            snapshot: this.loadActiveSnapshot(),
            importKind,
            rollbackCreated: true,
            authoritySummary,
            protectedSettings
        };
    }

    mergeControlPlane(remoteInput = {}) {
        this.ensureReady();
        const admitted = admitPortableArtifact(remoteInput, { kindHint: 'control-plane' });
        let remote = admitted.artifact;
        if (remote.kind !== 'control-plane') fail('SAIL_PORTABLE_KIND_MISMATCH', 'A control-plane artifact is required.');
        const metadataOnlyProfiles = new Set(remote.presets
            .filter(preset => portableMetadataOnlyEnabled(preset.settings))
            .map(preset => preset.profileId));
        const activeSnapshot = this.loadActiveSnapshot();
        if (portableMetadataOnlyEnabled(activeSnapshot.globalSettings)) metadataOnlyProfiles.add(this.state.activeProfileId);
        if (metadataOnlyProfiles.size) remote = applyPortableMetadataOnly(remote, metadataOnlyProfiles);
        const conflicts = [];
        for (const remoteProfile of remote.profiles) {
            let profile = this.state.profiles.find(item => item.id === remoteProfile.id);
            if (!profile) {
                profile = {
                    id: remoteProfile.id,
                    name: remoteProfile.name,
                    createdAt: remoteProfile.createdAt || remote.exportedAt,
                    updatedAt: remoteProfile.updatedAt || remote.exportedAt,
                    pinSalt: null,
                    pinVerifier: null,
                    localAvatarPath: null,
                    conflictMode: remoteProfile.conflictMode || 'prompt',
                    libraries: [], presets: []
                };
                this.state.profiles.push(profile);
            }
            const metadataOnly = metadataOnlyProfiles.has(remoteProfile.id);
            const localUpdated = Date.parse(profile.updatedAt || 0) || 0;
            const remoteUpdated = Date.parse(remoteProfile.updatedAt || remote.exportedAt || 0) || 0;
            const applyRemote = profile.updatedAt === remoteProfile.updatedAt || profile.conflictMode !== 'local' && remoteUpdated >= localUpdated;
            if (applyRemote) {
                profile.name = remoteProfile.name;
                profile.conflictMode = remoteProfile.conflictMode;
                profile.updatedAt = remoteProfile.updatedAt || remote.exportedAt;
            } else if (remoteUpdated && localUpdated && remoteUpdated !== localUpdated) {
                conflicts.push({ type: 'profile', id: profile.id, resolution: 'local-preserved' });
            }
            for (const remoteLibrary of remote.libraries.filter(item => item.profileId === remoteProfile.id)) {
                let library = profile.libraries.find(item => item.id === remoteLibrary.id);
                if (!library) {
                    library = { id: remoteLibrary.id, name: remoteLibrary.name, createdAt: remoteLibrary.createdAt || remote.exportedAt, updatedAt: remoteLibrary.updatedAt || remote.exportedAt };
                    profile.libraries.push(library);
                    this.atomicWrite(this.libraryPath(profile.id, library.id), { schemaVersion: PROFILE_SCHEMA_VERSION, library: remoteLibrary });
                    const overlay = emptyDeviceOverlay();
                    for (const game of remoteLibrary.games) {
                        overlay.warnings[game.id] = { kind: 'remote-metadata', localSetupRequired: true };
                    }
                    this.atomicWrite(this.overlayPath(profile.id, library.id), overlay);
                } else if (applyRemote) {
                    const existingDocument = fsExtra.readJsonSync(this.libraryPath(profile.id, library.id));
                    const mergedLibrary = {
                        ...clone(remoteLibrary),
                        games: mergePortableGames(existingDocument.library.games, remoteLibrary.games, {
                            preserveLocalConfigSyncEntries: metadataOnly
                        })
                    };
                    this.atomicWrite(this.libraryPath(profile.id, library.id), { schemaVersion: PROFILE_SCHEMA_VERSION, library: mergedLibrary });
                    library.name = remoteLibrary.name;
                    library.updatedAt = remoteLibrary.updatedAt || remote.exportedAt;
                    const overlay = this.readOverlay(profile.id, library.id);
                    for (const game of remoteLibrary.games) {
                        if (!existingDocument.library.games.some(localGame => localGame.id === game.id)) {
                            overlay.warnings[game.id] = { kind: 'remote-metadata', localSetupRequired: true };
                        }
                    }
                    for (const gameId of admitted.diagnostics.authorityWarningGameIds) {
                        overlay.warnings[gameId] = { kind: 'remote-authority-discarded', localSetupRequired: true };
                    }
                    this.atomicWrite(this.overlayPath(profile.id, library.id), overlay);
                }
            }
            for (const remotePreset of remote.presets.filter(item => item.profileId === remoteProfile.id)) {
                let preset = profile.presets.find(item => item.id === remotePreset.id);
                if (!preset) {
                    preset = { id: remotePreset.id, name: remotePreset.name, createdAt: remotePreset.createdAt || remote.exportedAt, updatedAt: remotePreset.updatedAt || remote.exportedAt };
                    profile.presets.push(preset);
                    this.atomicWrite(this.presetPath(profile.id, preset.id), { schemaVersion: PROFILE_SCHEMA_VERSION, preset: remotePreset });
                } else if (applyRemote) {
                    preset.name = remotePreset.name;
                    preset.updatedAt = remotePreset.updatedAt || remote.exportedAt;
                    this.atomicWrite(this.presetPath(profile.id, preset.id), { schemaVersion: PROFILE_SCHEMA_VERSION, preset: remotePreset });
                }
            }
            this.ensureProfileDocuments(profile);
        }
        this.saveState();
        this.verifyPortableStore();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot(), diagnostics: admitted.diagnostics, conflicts };
    }

    importActivePortable(input) {
        this.ensureReady();
        const admitted = admitPortableArtifact(input, { kindHint: 'launcher-snapshot' });
        if (admitted.artifact.kind !== 'launcher-snapshot') fail('SAIL_PORTABLE_KIND_MISMATCH', 'A launcher snapshot artifact is required.');
        const profile = this.activeProfile();
        const currentSnapshot = this.loadActiveSnapshot();
        const sourcePolicy = admitted.artifact.presets[0] && admitted.artifact.presets[0].settings;
        const metadataOnly = portableMetadataOnlyEnabled(currentSnapshot.globalSettings)
            || portableMetadataOnlyEnabled(sourcePolicy);
        const importedArtifact = metadataOnly
            ? applyPortableMetadataOnly(admitted.artifact, new Set([admitted.artifact.profiles[0].id]))
            : admitted.artifact;
        const sourceLibrary = importedArtifact.libraries[0];
        const sourcePreset = importedArtifact.presets[0];
        const currentLibrary = fsExtra.readJsonSync(this.libraryPath(profile.id, this.state.activeLibraryId)).library;
        const targetLibraryMeta = profile.libraries.find(item => item.id === this.state.activeLibraryId);
        const targetPresetMeta = profile.presets.find(item => item.id === this.state.activePresetId);
        const library = {
            ...clone(sourceLibrary),
            id: targetLibraryMeta.id,
            profileId: profile.id,
            name: targetLibraryMeta.name,
            games: mergePortableGames(currentLibrary.games, sourceLibrary.games, {
                preserveLocalConfigSyncEntries: metadataOnly
            })
        };
        const preset = { ...clone(sourcePreset), id: targetPresetMeta.id, profileId: profile.id, name: targetPresetMeta.name };
        this.atomicWrite(this.libraryPath(profile.id, targetLibraryMeta.id), { schemaVersion: PROFILE_SCHEMA_VERSION, library });
        this.atomicWrite(this.presetPath(profile.id, targetPresetMeta.id), { schemaVersion: PROFILE_SCHEMA_VERSION, preset });
        const overlay = this.readOverlay(profile.id, targetLibraryMeta.id);
        for (const game of sourceLibrary.games) {
            if (!currentLibrary.games.some(localGame => localGame.id === game.id)) overlay.warnings[game.id] = { kind: 'imported-metadata', localSetupRequired: true };
        }
        for (const gameId of admitted.diagnostics.authorityWarningGameIds) overlay.warnings[gameId] = { kind: 'imported-authority-discarded', localSetupRequired: true };
        this.atomicWrite(this.overlayPath(profile.id, targetLibraryMeta.id), overlay);
        profile.updatedAt = new Date().toISOString();
        this.saveState();
        this.verifyPortableStore();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot(), diagnostics: admitted.diagnostics };
    }

    ensureProfileDocuments(profile) {
        const now = new Date().toISOString();
        if (!profile.libraries.length) {
            const library = { id: makeId(), name: 'Main Library', createdAt: now, updatedAt: now };
            profile.libraries.push(library);
            const presetId = profile.presets[0] && profile.presets[0].id || makeId();
            const projected = createPortableSnapshot({}, { profileId: profile.id, profileName: profile.name, libraryId: library.id, libraryName: library.name, presetId });
            this.atomicWrite(this.libraryPath(profile.id, library.id), { schemaVersion: PROFILE_SCHEMA_VERSION, library: projected.artifact.libraries[0] });
            this.atomicWrite(this.overlayPath(profile.id, library.id), emptyDeviceOverlay());
        }
        if (!profile.presets.length) {
            const preset = { id: makeId(), name: 'Default Settings', createdAt: now, updatedAt: now };
            profile.presets.push(preset);
            const projected = createPortableSnapshot({}, { profileId: profile.id, profileName: profile.name, libraryId: profile.libraries[0].id, libraryName: profile.libraries[0].name, presetId: preset.id, presetName: preset.name });
            this.atomicWrite(this.presetPath(profile.id, preset.id), { schemaVersion: PROFILE_SCHEMA_VERSION, preset: projected.artifact.presets[0] });
        }
    }

    createProfile(name, pin = '', snapshot = {}) {
        this.ensureReady();
        const now = new Date().toISOString();
        const profileId = makeId();
        const libraryId = makeId();
        const presetId = makeId();
        const pinData = pin ? hashPin(pin) : null;
        const profile = {
            id: profileId,
            name: cleanName(name, `Profile ${this.state.profiles.length + 1}`),
            createdAt: now, updatedAt: now,
            pinSalt: pinData && pinData.salt || null,
            pinVerifier: pinData && pinData.verifier || null,
            localAvatarPath: null,
            conflictMode: 'prompt',
            libraries: [{ id: libraryId, name: 'Main Library', createdAt: now, updatedAt: now }],
            presets: [{ id: presetId, name: 'Default Settings', createdAt: now, updatedAt: now }]
        };
        const projected = createPortableSnapshot(snapshot, { profileId, profileName: profile.name, libraryId, presetId, exportedAt: now });
        this.state.profiles.push(profile);
        this.atomicWrite(this.libraryPath(profileId, libraryId), { schemaVersion: PROFILE_SCHEMA_VERSION, library: projected.artifact.libraries[0] });
        this.atomicWrite(this.presetPath(profileId, presetId), { schemaVersion: PROFILE_SCHEMA_VERSION, preset: projected.artifact.presets[0] });
        this.atomicWrite(this.overlayPath(profileId, libraryId), extractDeviceOverlay(snapshot, projected.artifact));
        this.saveState();
        return this.getState();
    }

    setProfileAvatar(profileId, sourcePath) {
        this.ensureReady();
        const profile = this.state.profiles.find(item => item.id === profileId);
        if (!profile) fail('SAIL_PROFILE_NOT_FOUND', 'Launcher profile was not found.');
        const source = path.resolve(String(sourcePath || ''));
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail('SAIL_PROFILE_AVATAR_INVALID', 'Choose an existing avatar image.');
        const ext = path.extname(source).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || fs.statSync(source).size > 2 * 1024 * 1024) {
            fail('SAIL_PROFILE_AVATAR_INVALID', 'Local avatars must be PNG, JPEG, or WebP images no larger than 2 MB.');
        }
        const destination = path.join(this.profilePath(profile.id), `avatar${ext === '.jpeg' ? '.jpg' : ext}`);
        fsExtra.ensureDirSync(path.dirname(destination));
        if (path.normalize(source) !== path.normalize(destination)) fs.copyFileSync(source, destination);
        if (profile.localAvatarPath && path.normalize(profile.localAvatarPath) !== path.normalize(destination)) fsExtra.removeSync(profile.localAvatarPath);
        profile.localAvatarPath = destination;
        profile.updatedAt = new Date().toISOString();
        this.saveState();
        return this.getState();
    }

    clearProfileAvatar(profileId) {
        this.ensureReady();
        const profile = this.state.profiles.find(item => item.id === profileId);
        if (!profile) fail('SAIL_PROFILE_NOT_FOUND', 'Launcher profile was not found.');
        if (profile.localAvatarPath) fsExtra.removeSync(profile.localAvatarPath);
        profile.localAvatarPath = null;
        profile.updatedAt = new Date().toISOString();
        this.saveState();
        return this.getState();
    }

    deleteProfile(profileId, pin = '') {
        this.ensureReady();
        if (this.state.profiles.length <= 1) fail('SAIL_PROFILE_LAST_PROFILE', 'Create another launcher profile before deleting the last one.');
        const index = this.state.profiles.findIndex(item => item.id === profileId);
        if (index < 0) fail('SAIL_PROFILE_NOT_FOUND', 'Launcher profile was not found.');
        const profile = this.state.profiles[index];
        if (profile.pinVerifier) {
            const unlock = this.unlockProfile(profileId, pin);
            if (!unlock.success) fail('SAIL_PROFILE_PIN_INVALID', 'Enter the correct profile PIN before deleting it.');
        }
        this.state.profiles.splice(index, 1);
        this.pinFailures.delete(profileId);
        fsExtra.removeSync(this.profilePath(profileId));
        if (this.state.activeProfileId === profileId) {
            const next = this.state.profiles[Math.min(index, this.state.profiles.length - 1)];
            this.state.activeProfileId = next.id;
            this.state.activeLibraryId = next.libraries[0].id;
            this.state.activePresetId = next.presets[0].id;
        }
        this.saveState();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot(), deletedProfile: { id: profile.id, name: profile.name } };
    }

    updateProfile(profileId, patch = {}) {
        this.ensureReady();
        const profile = this.state.profiles.find(item => item.id === profileId);
        if (!profile) fail('SAIL_PROFILE_NOT_FOUND', 'Launcher profile was not found.');
        if (Object.prototype.hasOwnProperty.call(patch, 'name')) profile.name = cleanName(patch.name, profile.name);
        if (['prompt', 'newest', 'local'].includes(patch.conflictMode)) profile.conflictMode = patch.conflictMode;
        if (Object.prototype.hasOwnProperty.call(patch, 'pin')) {
            const pinData = patch.pin ? hashPin(patch.pin) : null;
            profile.pinSalt = pinData && pinData.salt || null;
            profile.pinVerifier = pinData && pinData.verifier || null;
        }
        profile.updatedAt = new Date().toISOString();
        this.saveState();
        return this.getState();
    }

    unlockProfile(profileId, pin) {
        this.ensureReady();
        const profile = this.state.profiles.find(item => item.id === profileId);
        if (!profile) fail('SAIL_PROFILE_NOT_FOUND', 'Launcher profile was not found.');
        const failure = this.pinFailures.get(profileId);
        if (failure && failure.retryAt > Date.now()) return { success: false, retryAfterMs: failure.retryAt - Date.now() };
        if (verifyPin(pin, profile)) {
            this.pinFailures.delete(profileId);
            return { success: true };
        }
        const attempts = (failure ? failure.attempts : 0) + 1;
        const retryAt = attempts >= 5 ? Date.now() + Math.min(300000, 1000 * (2 ** (attempts - 5))) : 0;
        this.pinFailures.set(profileId, { attempts, retryAt });
        return { success: false, retryAfterMs: Math.max(0, retryAt - Date.now()) };
    }

    switchProfile(profileId) {
        this.ensureReady();
        const profile = this.state.profiles.find(item => item.id === profileId);
        if (!profile) fail('SAIL_PROFILE_NOT_FOUND', 'Launcher profile was not found.');
        this.state.activeProfileId = profile.id;
        this.state.activeLibraryId = profile.libraries[0].id;
        this.state.activePresetId = profile.presets[0].id;
        this.saveState();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot() };
    }

    createLibrary(name, snapshot = {}) {
        this.ensureReady();
        const profile = this.activeProfile();
        const now = new Date().toISOString();
        const library = { id: makeId(), name: cleanName(name, 'New Library'), createdAt: now, updatedAt: now };
        const preset = profile.presets.find(item => item.id === this.state.activePresetId) || profile.presets[0];
        const projected = createPortableSnapshot(snapshot, { profileId: profile.id, profileName: profile.name, libraryId: library.id, libraryName: library.name, presetId: preset.id, presetName: preset.name });
        profile.libraries.push(library);
        this.atomicWrite(this.libraryPath(profile.id, library.id), { schemaVersion: PROFILE_SCHEMA_VERSION, library: projected.artifact.libraries[0] });
        this.atomicWrite(this.overlayPath(profile.id, library.id), extractDeviceOverlay(snapshot, projected.artifact));
        profile.updatedAt = now;
        this.saveState();
        return this.getState();
    }

    switchLibrary(libraryId) {
        this.ensureReady();
        const profile = this.activeProfile();
        if (!profile.libraries.some(item => item.id === libraryId)) fail('SAIL_PROFILE_LIBRARY_NOT_FOUND', 'Library was not found.');
        this.state.activeLibraryId = libraryId;
        this.saveState();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot() };
    }

    createPreset(name, snapshot = {}) {
        this.ensureReady();
        const profile = this.activeProfile();
        const now = new Date().toISOString();
        const preset = { id: makeId(), name: cleanName(name, 'New Settings'), createdAt: now, updatedAt: now };
        const library = profile.libraries.find(item => item.id === this.state.activeLibraryId) || profile.libraries[0];
        const projected = createPortableSnapshot(snapshot, { profileId: profile.id, profileName: profile.name, libraryId: library.id, libraryName: library.name, presetId: preset.id, presetName: preset.name });
        profile.presets.push(preset);
        this.atomicWrite(this.presetPath(profile.id, preset.id), { schemaVersion: PROFILE_SCHEMA_VERSION, preset: projected.artifact.presets[0] });
        profile.updatedAt = now;
        this.saveState();
        return this.getState();
    }

    switchPreset(presetId) {
        this.ensureReady();
        const profile = this.activeProfile();
        if (!profile.presets.some(item => item.id === presetId)) fail('SAIL_PROFILE_PRESET_NOT_FOUND', 'Settings preset was not found.');
        this.state.activePresetId = presetId;
        this.saveState();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot() };
    }

    authorityScope(gameId) {
        this.ensureReady();
        const normalizedGameId = cleanId(gameId, '');
        if (!normalizedGameId) fail('SAIL_PROFILE_GAME_NOT_FOUND', 'Game was not found.');
        const profile = this.activeProfile();
        const document = fsExtra.readJsonSync(this.libraryPath(profile.id, this.state.activeLibraryId));
        if (!document.library.games.some(game => game.id === normalizedGameId)) {
            fail('SAIL_PROFILE_GAME_NOT_FOUND', 'Game was not found in the active library.');
        }
        return { profileId: profile.id, libraryId: this.state.activeLibraryId, gameId: normalizedGameId };
    }

    activeGameMetadata(gameId) {
        const scope = this.authorityScope(gameId);
        const document = fsExtra.readJsonSync(this.libraryPath(scope.profileId, scope.libraryId));
        const game = document.library.games.find(item => item.id === scope.gameId);
        return { ...clone(game), profileId: scope.profileId, libraryId: scope.libraryId };
    }

    legacyStorageAlias(gameId) {
        const scope = this.authorityScope(gameId);
        const overlay = this.readOverlay(scope.profileId, scope.libraryId);
        const record = overlay.storageAliases[scope.gameId];
        return record ? clone(record) : null;
    }

    authorityStatus(gameId) {
        return this.capabilityStore.status(this.authorityScope(gameId));
    }

    createExecutionCapability(gameId, details) {
        return this.capabilityStore.createApprovedExecution(this.authorityScope(gameId), details, 'local-selection');
    }

    createFilesystemCapability(gameId, kind, rootPath, entryId = '') {
        return this.capabilityStore.createApprovedFilesystem(this.authorityScope(gameId), kind, rootPath, entryId, 'local-selection');
    }

    pendingExecutionReview(request) {
        const scope = this.authorityScope(request && request.gameId);
        return this.capabilityStore.pendingExecutionReview({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            component: request && request.component,
            ...scope
        });
    }

    reviewPendingExecution(request, decision) {
        const scope = this.authorityScope(request && request.gameId);
        return this.capabilityStore.reviewPendingExecution({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            component: request && request.component,
            ...scope
        }, decision);
    }

    async approveAllPendingExecutionBases(validateSteamAppId) {
        this.ensureReady();
        const candidates = this.capabilityStore.pendingExecutionBaseProposals(this.state.activeProfileId);
        const skipped = [];
        let approvedCount = 0;
        for (const candidate of candidates) {
            try {
                if (candidate.steamAppId) {
                    if (typeof validateSteamAppId !== 'function' || !await validateSteamAppId(candidate.steamAppId)) {
                        throw new Error('The Steam AppID is not installed in a locally detected Steam library.');
                    }
                    this.capabilityStore.approvePendingExecutionComponent(candidate.capabilityId, 'base', {
                        accept: true,
                        steamAppId: candidate.steamAppId
                    });
                } else if (candidate.executablePath) {
                    this.capabilityStore.approvePendingExecutionComponent(candidate.capabilityId, 'base', {
                        accept: true,
                        selectedPath: candidate.executablePath
                    });
                } else {
                    throw new Error('No local executable or validated Steam AppID is available.');
                }
                approvedCount += 1;
            } catch (error) {
                skipped.push({
                    gameId: candidate.gameId,
                    reason: String(error && error.message || 'The base executable could not be approved.').slice(0, 240)
                });
            }
        }
        return {
            totalCount: candidates.length,
            approvedCount,
            skippedCount: skipped.length,
            skipped
        };
    }

    pendingFilesystemReview(request) {
        const scope = this.authorityScope(request && request.gameId);
        return this.capabilityStore.pendingFilesystemReview({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            ...scope
        });
    }

    reviewPendingFilesystem(request, selectedPath) {
        const scope = this.authorityScope(request && request.gameId);
        return this.capabilityStore.reviewPendingFilesystem({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            ...scope
        }, selectedPath);
    }

    resolveExecutionCapability(request) {
        const scope = this.authorityScope(request && request.gameId);
        return this.capabilityStore.resolveExecution({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            operation: request && request.operation || 'launch',
            ...scope
        });
    }

    resolveFilesystemCapability(request) {
        const scope = this.authorityScope(request && request.gameId);
        return this.capabilityStore.resolveFilesystem({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            operation: request && request.operation,
            ...scope
        });
    }

    validateExecutionCapability(request) {
        const scope = this.authorityScope(request && request.gameId);
        return this.capabilityStore.validateExecution({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            operation: request && request.operation || 'launch',
            ...scope
        });
    }

    validateFilesystemCapability(request) {
        const scope = this.authorityScope(request && request.gameId);
        return this.capabilityStore.validateFilesystem({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            operation: request && request.operation,
            ...scope
        });
    }

    revokeFilesystemCapability(request) {
        const scope = this.authorityScope(request && request.gameId);
        return this.capabilityStore.revokeFilesystem({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            ...scope
        });
    }

    createTransferCapability(gameId, targetPath, operation) {
        return this.capabilityStore.createTransferCapability(this.authorityScope(gameId), targetPath, operation);
    }

    createDirectoryCapability(gameId, targetPath, operation = 'folder-open') {
        return this.capabilityStore.createDirectoryCapability(this.authorityScope(gameId), targetPath, operation);
    }

    registerDiscoveredGames(rows = [], source = 'local-import') {
        this.ensureReady();
        if (!Array.isArray(rows) || rows.length > 5000) fail('SAIL_PROFILE_INVALID', 'The local import result is invalid.');
        const current = this.loadActiveSnapshot();
        const created = [];
        for (const row of rows) {
            if (!isPlainObject(row)) continue;
            const name = String(row.name || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
            const platform = ['steam', 'epic', 'gog'].includes(row.platform) ? row.platform : 'custom';
            const steamAppId = /^[1-9]\d{0,9}$/.test(String(row.steamAppId || '')) ? String(row.steamAppId) : '';
            const epicId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(row.epicId || '')) ? String(row.epicId) : '';
            const gogId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(row.gogId || '')) ? String(row.gogId) : '';
            if (!name) continue;
            const duplicate = current.myGames.some(game => steamAppId && game.steamAppId === steamAppId
                || epicId && game.epicId === epicId
                || gogId && game.gogId === gogId
                || !steamAppId && !epicId && !gogId && String(game.name || '').toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'));
            if (duplicate) continue;
            const gameId = makeId();
            const game = {
                id: gameId, name, platform, tags: [], isFavorite: false, addedAt: Date.now(),
                playtime: 0, lastPlayed: null, playtimeSessionIds: [], configSyncEntries: [],
                source, sourceTitle: name, installedAt: new Date().toISOString()
            };
            if (steamAppId) {
                game.steamAppId = steamAppId;
                game.sourceIdentifier = steamAppId;
                game.steamImageUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`;
                game.steamHeroUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_hero.jpg`;
            } else if (epicId) {
                game.epicId = epicId;
                game.sourceIdentifier = epicId;
            } else if (gogId) {
                game.gogId = gogId;
                game.sourceIdentifier = gogId;
            }
            current.myGames.push(game);
            created.push({
                gameId,
                executablePath: typeof row.executablePath === 'string' && path.isAbsolute(row.executablePath) && fs.existsSync(row.executablePath) && fs.statSync(row.executablePath).isFile()
                    ? path.normalize(row.executablePath)
                    : '',
                steamAppId
            });
        }
        if (!created.length) return { importedCount: 0, state: this.getState(), snapshot: current };
        this.captureActiveSnapshot(current);
        const execution = [];
        for (const item of created) {
            const adopted = this.capabilityStore.adoptTrustedLocalExecution(this.authorityScope(item.gameId), {
                exePath: item.executablePath,
                steamAppId: item.executablePath ? '' : item.steamAppId
            }, source);
            if (adopted) execution.push(adopted);
        }
        return {
            importedCount: created.length,
            execution,
            state: this.getState(),
            snapshot: this.loadActiveSnapshot()
        };
    }

    registerDownloadedGameProposal(input = {}) {
        this.ensureReady();
        const name = String(input.gameName || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
        if (!name) fail('SAIL_PROFILE_INVALID', 'The downloaded game name is invalid.');
        const gameId = makeId();
        const current = this.loadActiveSnapshot();
        const game = {
            id: gameId,
            name,
            tags: [],
            isFavorite: false,
            addedAt: Date.now(),
            playtime: 0,
            lastPlayed: null,
            playtimeSessionIds: [],
            configSyncEntries: [],
            platform: 'custom',
            source: 'sail-download',
            sourceIdentifier: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(input.sourceId || '')) ? String(input.sourceId) : 'download',
            sourceTitle: name,
            installedAt: new Date().toISOString()
        };
        const coverPath = typeof input.coverPath === 'string' && path.isAbsolute(input.coverPath) && fs.existsSync(input.coverPath)
            ? path.normalize(input.coverPath)
            : '';
        if (coverPath) game.customBannerPath = coverPath;
        current.myGames.push(game);
        this.captureActiveSnapshot(current);
        const scope = this.authorityScope(gameId);
        let execution = null;
        const executablePath = typeof input.executablePath === 'string' && path.isAbsolute(input.executablePath) && fs.existsSync(input.executablePath)
            ? path.normalize(input.executablePath)
            : '';
        if (executablePath) execution = this.capabilityStore.adoptTrustedLocalExecution(scope, { exePath: executablePath }, 'download-proposal');
        const folderPath = typeof input.folderPath === 'string' && path.isAbsolute(input.folderPath) && fs.existsSync(input.folderPath)
            ? path.normalize(input.folderPath)
            : '';
        const location = folderPath ? this.capabilityStore.createDirectoryCapability(scope, folderPath, 'folder-open', { source: 'download-result' }) : null;
        return {
            gameId,
            execution,
            location,
            state: this.getState(),
            snapshot: this.loadActiveSnapshot()
        };
    }

    createBackupFileCapability(gameId, targetPath) {
        return this.capabilityStore.createTransferCapability(
            this.authorityScope(gameId),
            targetPath,
            ['backup-read', 'backup-delete', 'backup-open'],
            { source: 'main-backup-list' }
        );
    }

    launcherTransferScope() {
        this.ensureReady();
        return { ...this.activeScope(), gameId: 'launcher-portable' };
    }

    launcherDeviceScope() {
        this.ensureReady();
        return { ...this.activeScope(), gameId: 'launcher-device' };
    }

    createDeviceRootCapability(kind, targetPath) {
        if (!['download-root', 'install-root', 'archive-root'].includes(kind)) fail('SAIL_CAPABILITY_INVALID', 'Unknown device root kind.');
        return this.capabilityStore.createApprovedFilesystem(this.launcherDeviceScope(), kind, targetPath, '', 'local-selection');
    }

    deviceRootStatus(kind) {
        if (!['download-root', 'install-root', 'archive-root'].includes(kind)) fail('SAIL_CAPABILITY_INVALID', 'Unknown device root kind.');
        return this.capabilityStore.status(this.launcherDeviceScope()).filesystems.find(record => record.label === kind) || {
            capabilityId: null, revision: 0, state: 'local-setup-required', type: 'filesystem',
            gameId: 'launcher-device', operations: [], reviewComponents: [], label: kind
        };
    }

    resolveDeviceRootCapability(request) {
        const kind = request && request.kind;
        const operation = { 'download-root': 'download-write', 'install-root': 'install-write', 'archive-root': 'archive-write' }[kind];
        if (!operation) fail('SAIL_CAPABILITY_INVALID', 'Unknown device root kind.');
        return this.capabilityStore.resolveFilesystem({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            operation,
            ...this.launcherDeviceScope()
        });
    }

    createLauncherTransferCapability(targetPath, operation) {
        return this.capabilityStore.createTransferCapability(this.launcherTransferScope(), targetPath, operation);
    }

    createLauncherDirectoryCapability(targetPath) {
        return this.capabilityStore.createDirectoryCapability(this.launcherDeviceScope(), targetPath, 'folder-open', { source: 'download-result' });
    }

    resolveTransferCapability(request) {
        const gameId = request && request.gameId;
        const scope = gameId === 'launcher-portable'
            ? this.launcherTransferScope()
            : gameId === 'launcher-device' ? this.launcherDeviceScope() : this.authorityScope(gameId);
        return this.capabilityStore.resolveFilesystem({
            capabilityId: request && request.capabilityId,
            expectedRevision: request && request.expectedRevision,
            operation: request && request.operation,
            ...scope
        });
    }
}

module.exports = {
    DEVICE_OVERLAY_SCHEMA_VERSION,
    LOCAL_BACKUP_SCHEMA,
    MIGRATION_SCHEMA_VERSION,
    PROFILE_SCHEMA_VERSION,
    PROTECTED_LOCAL_SETTING_KEYS,
    ProfileStore,
    ProfileStoreError,
    directoryManifest,
    extractDeviceOverlay,
    extractProtectedLocalSettings,
    hashPin,
    manifestsEqual,
    mergePortableGames,
    verifyPin
};
