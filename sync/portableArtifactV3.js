'use strict';

const crypto = require('crypto');
const { normalizeAchievementData } = require('../achievements/achievementLogic');

const PORTABLE_SCHEMA = 'sail.portable/v3';
const PORTABLE_KINDS = Object.freeze(['launcher-snapshot', 'control-plane']);

const LIMITS = Object.freeze({
    envelopeBytes: 16 * 1024 * 1024,
    depth: 12,
    nodes: 250000,
    profiles: 64,
    libraries: 256,
    presets: 256,
    games: 10000,
    sections: 512,
    tagsPerGame: 64,
    configEntriesPerGame: 64,
    achievementItemsPerGame: 5000,
    settingsArray: 512
});

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_PORTABLE_KEYS = new Set([
    'exepath', 'executable', 'executablepath', 'installfolder', 'installpath',
    'installdir', 'dlinstalldir', 'downloadroot', 'archiveroot', 'destinationpath',
    'sourcepath', 'filepath', 'workingdirectory', 'cwd', 'playdetectionpath',
    'emulatorpath', 'rompath', 'romargs', 'firmwarepath', 'launchargs', 'arguments',
    'argv', 'runasadmin', 'elevation', 'highpriority', 'companionapp',
    'companionpath', 'prelaunchscript', 'postlaunchscript', 'prescript',
    'postscript', 'scriptpath', 'scripts', 'shell', 'shellfragment', 'command',
    'commandline', 'localsave', 'drivesave', 'localpath', 'savescandirectories',
    'shortcuticon', 'custombannerpath', 'customicon', 'icondata', 'localartwork',
    'customfont', 'fontpath', 'localfont', 'backgroundpath', 'uiappbg',
    'locallauncheravatar', 'defaultdrivefolder', 'quickpaths', 'sources',
    'pluginpath', 'pluginexecutablepath', 'entrypoint', 'downloadurl', 'packageurl',
    'url', 'href', 'src', 'password', 'passphrase', 'secret', 'clientsecret',
    'apikey', 'steamapikey', 'discordtoken', 'accesstoken', 'refreshtoken',
    'authorization', 'cookie', 'cookies', 'customcloudkeysdata', 'debrid', 'keys',
    'pin', 'pinhash', 'pinsalt', 'pin_salt', 'pinverifier', 'pin_verifier'
]);

const APPROVED_ARTWORK_HOSTS = Object.freeze([
    'shared.akamai.steamstatic.com',
    'cdn.akamai.steamstatic.com',
    'community.akamai.steamstatic.com',
    'avatars.akamai.steamstatic.com',
    'steamcdn-a.akamaihd.net',
    'cdn.cloudflare.steamstatic.com'
]);

const BUILTIN_THEMES = new Set([
    'theme-midnight', 'theme-cherry', 'theme-cyberpunk', 'theme-deepsea',
    'theme-forest', 'theme-frost', 'theme-monochrome', 'theme-neon',
    'theme-ocean', 'theme-sunset'
]);

const BOOLEAN_SETTING_KEYS = new Set([
    'sidebarCollapsed', 'compactLayout', 'exitWhenClosed', 'disableDiscordRpc',
    'hideStars', 'legacySettings', 'fullTileImage', 'verticalCards',
    'showSurpriseMe', 'showStats', 'showDynamicFolders', 'showFavoritesFolder',
    'showContinuePlaying', 'showModsPage', 'showWorkshopPage',
    'showGameDownloadsPage', 'showDownloadManagerPage',
    'achievementTrackingEnabled', 'achievementCardBadgesEnabled',
    'achievementNotificationsEnabled', 'maintenanceEnabled',
    'maintenanceGamePageEnabled', 'showSocialSidebar', 'dedicatedSettingsPage',
    'enableUiResizing', 'transparentSettings', 'lessAnimations',
    'cloudAutoSync', 'cloudSyncBlocking', 'enableMultiSync', 'glassmorphicUi',
    'betaUpdates', 'disableTranslucency', 'forceTranslucency',
    'autoSettingsSync', 'enableSourcesPage', 'enableDiscoverPage',
    'themeInfoButtons', 'showSocialSidebar', 'defaultToSteam',
    'enableSaveDetection', 'favoritesFirst', 'keepListCovers', 'muteSounds',
    'portableMetadataOnly'
]);

const NUMBER_SETTING_RULES = Object.freeze({
    recentDays: { min: 1, max: 3650, integer: true },
    animationSpeed: { min: 0.1, max: 4 },
    mainSidebarWidth: { min: 160, max: 600, integer: true },
    socialSidebarWidth: { min: 160, max: 600, integer: true },
    glassOpacity: { min: 0.05, max: 1 },
    saveBackupCount: { min: 1, max: 50, integer: true }
});

const ENUM_SETTING_RULES = Object.freeze({
    language: new Set(['english', 'spanish', 'french', 'german', 'japanese', 'koreana', 'schinese']),
    tileShape: new Set(['default', 'square', 'rounded', 'circle', 'wide']),
    tileSize: new Set(['small', 'medium', 'large']),
    friendsBarSide: new Set(['left', 'right']),
    mainSidebarSide: new Set(['left', 'right']),
    foldersPosition: new Set(['top', 'bottom']),
    actionButtonsLocation: new Set(['top', 'bottom']),
    iconStyle: new Set(['icons', 'emoji']),
    forceResizeMode: new Set(['off', 'stick', 'scale']),
    friendsSort: new Set(['status', 'name', 'favorites']),
    sortOrder: new Set(['alphabetical', 'alphabetical-desc', 'newest', 'oldest', 'playtime', 'playtime-asc', 'recent']),
    viewMode: new Set(['grid', 'list']),
    dropdownAccentStyle: new Set(['filled', 'outline']),
    saveDetectionMode: new Set(['automatic', 'ludusavi', 'manual', 'off'])
});

const ROOT_KEYS = new Set(['schema', 'kind', 'exportedAt', 'profiles', 'libraries', 'presets']);
const PROFILE_KEYS = new Set(['id', 'name', 'conflictMode', 'createdAt', 'updatedAt']);
const LIBRARY_KEYS = new Set(['id', 'profileId', 'name', 'createdAt', 'updatedAt', 'games', 'sections']);
const PRESET_KEYS = new Set(['id', 'profileId', 'name', 'createdAt', 'updatedAt', 'settings']);
const GAME_KEYS = new Set([
    'id', 'name', 'platform', 'steamAppId', 'searchSteamAppId', 'epicId', 'gogId',
    'isRom', 'tags', 'isFavorite', 'addedAt', 'playtime', 'lastPlayed',
    'playtimeSessionIds', 'steamImageUrl', 'steamHeroUrl', 'source',
    'sourceIdentifier', 'sourceTitle', 'sourceVersion', 'installedAt',
    'maintenanceHideInformationIssues', 'dependencyRequirements',
    'configSyncEntries', 'achievementData'
]);
const SECTION_KEYS = new Set(['id', 'name', 'icon']);
const CONFIG_ENTRY_KEYS = new Set([
    'id', 'name', 'kind', 'enabled', 'beforeLaunch', 'afterExit', 'intervalMinutes'
]);
const ACHIEVEMENT_DATA_KEYS = new Set([
    'schemaVersion', 'appId', 'updatedAt', 'lastSteamRefreshAt', 'lastLocalScanAt', 'items'
]);
const ACHIEVEMENT_ITEM_KEYS = new Set([
    'id', 'displayName', 'description', 'hidden', 'icon', 'iconGray',
    'unlocked', 'unlockTime', 'source'
]);
const SETTINGS_KEYS = new Set([
    ...BOOLEAN_SETTING_KEYS,
    ...Object.keys(NUMBER_SETTING_RULES),
    ...Object.keys(ENUM_SETTING_RULES),
    'theme', 'steamId', 'favoriteFriends', 'dismissedAlerts', 'buttonLocations', 'syncV2'
]);
const BUTTON_LOCATION_KEYS = new Set(['sailHub', 'systemSpecs']);
const SYNC_KEYS = new Set([
    'enabled', 'conflictMode', 'configChangeMode', 'configIntervalMinutes',
    'configOnStartup', 'configBeforeExit', 'saveBeforeLaunch', 'saveAfterExit',
    'gameConfigBeforeLaunch', 'gameConfigAfterExit', 'sailCloudSingleSaveCopy',
    'sailCloudExcludedGameSaveKeys', 'destinations'
]);
const SYNC_DESTINATION_KEYS = new Set(['config', 'library', 'saves', 'gameConfigs']);

class PortableArtifactError extends Error {
    constructor(message, code = 'SAIL_PORTABLE_INVALID', path = '$') {
        super(message);
        this.name = 'PortableArtifactError';
        this.code = code;
        this.path = path;
    }
}

function fail(path, message, code = 'SAIL_PORTABLE_INVALID') {
    throw new PortableArtifactError(`${message} (${path})`, code, path);
}

function hasControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function decodeInput(input) {
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        const bytes = Buffer.from(input);
        if (bytes.length > LIMITS.envelopeBytes) fail('$', 'Portable artifact exceeds the 16 MiB limit', 'SAIL_PORTABLE_TOO_LARGE');
        try {
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch (error) {
            fail('$', `Portable artifact is not valid UTF-8 JSON: ${error.message}`, 'SAIL_PORTABLE_JSON_INVALID');
        }
    }
    if (typeof input === 'string') {
        if (Buffer.byteLength(input, 'utf8') > LIMITS.envelopeBytes) fail('$', 'Portable artifact exceeds the 16 MiB limit', 'SAIL_PORTABLE_TOO_LARGE');
        try { return JSON.parse(input); }
        catch (error) { fail('$', `Portable artifact is not valid JSON: ${error.message}`, 'SAIL_PORTABLE_JSON_INVALID'); }
    }
    return input;
}

function preflight(value, { allowUndefined = false } = {}) {
    const stack = [{ value, path: '$', depth: 0 }];
    const seen = new Set();
    let nodes = 0;
    while (stack.length) {
        const current = stack.pop();
        nodes += 1;
        if (nodes > LIMITS.nodes) fail(current.path, 'Portable artifact contains too many values', 'SAIL_PORTABLE_TOO_COMPLEX');
        if (current.depth > LIMITS.depth) fail(current.path, `Portable artifact exceeds depth ${LIMITS.depth}`, 'SAIL_PORTABLE_TOO_DEEP');
        const item = current.value;
        if (item === undefined && allowUndefined) continue;
        if (item === null || typeof item === 'boolean') continue;
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) fail(current.path, 'Portable numbers must be finite');
            continue;
        }
        if (typeof item === 'string') {
            if (hasControlCharacters(item)) fail(current.path, 'Portable strings cannot contain control characters');
            continue;
        }
        if (typeof item !== 'object') fail(current.path, 'Portable values must be JSON data');
        if (seen.has(item)) fail(current.path, 'Portable artifacts cannot contain cycles');
        seen.add(item);
        if (Array.isArray(item)) {
            for (let index = item.length - 1; index >= 0; index--) {
                stack.push({ value: item[index], path: `${current.path}[${index}]`, depth: current.depth + 1 });
            }
            continue;
        }
        if (!isPlainObject(item)) fail(current.path, 'Portable objects must use the ordinary JSON object prototype', 'SAIL_PORTABLE_PROTOTYPE_REJECTED');
        for (const key of Object.keys(item)) {
            if (PROTOTYPE_KEYS.has(key.toLowerCase())) fail(`${current.path}.${key}`, 'Prototype-bearing keys are forbidden', 'SAIL_PORTABLE_PROTOTYPE_REJECTED');
            if (hasControlCharacters(key)) fail(`${current.path}.${key}`, 'Portable property names cannot contain control characters');
            stack.push({ value: item[key], path: `${current.path}.${key}`, depth: current.depth + 1 });
        }
    }
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); }
    catch (error) { fail('$', `Portable artifact cannot be serialized: ${error.message}`); }
    if (bytes > LIMITS.envelopeBytes) fail('$', 'Portable artifact exceeds the 16 MiB limit', 'SAIL_PORTABLE_TOO_LARGE');
    return bytes;
}

function exactObject(value, path, allowedKeys) {
    if (!isPlainObject(value)) fail(path, 'Expected an object');
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) fail(`${path}.${key}`, `Unknown property '${key}'`, 'SAIL_PORTABLE_UNKNOWN_PROPERTY');
    }
    return value;
}

function stringValue(value, path, { min = 0, max = 160, pattern = null, nullable = false } = {}) {
    if (nullable && (value === null || value === undefined || value === '')) return null;
    if (typeof value !== 'string') fail(path, 'Expected a string');
    const text = value.trim();
    if (text.length < min || text.length > max) fail(path, `String length must be ${min}-${max}`);
    if (hasControlCharacters(text)) fail(path, 'Control characters are forbidden');
    if (pattern && !pattern.test(text)) fail(path, 'String has an invalid format');
    return text;
}

function idValue(value, path) {
    const id = stringValue(String(value === undefined || value === null ? '' : value), path, {
        min: 1,
        max: 128,
        pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
    });
    if (PROTOTYPE_KEYS.has(id.toLowerCase())) fail(path, 'Reserved IDs are forbidden');
    return id;
}

function booleanValue(value, path) {
    if (typeof value !== 'boolean') fail(path, 'Expected a boolean');
    return value;
}

function numberValue(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false, nullable = false } = {}) {
    if (nullable && (value === null || value === undefined)) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'Expected a finite number');
    if (integer && !Number.isInteger(value)) fail(path, 'Expected an integer');
    if (value < min || value > max) fail(path, `Number must be between ${min} and ${max}`);
    return value;
}

function timestampValue(value, path, { nullable = false } = {}) {
    if (nullable && (value === null || value === undefined || value === '')) return null;
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed)) fail(path, 'Expected an ISO timestamp');
    return new Date(parsed).toISOString();
}

function optionalTimestamp(value, path) {
    return value === undefined ? undefined : timestampValue(value, path, { nullable: true });
}

function uniqueArray(value, path, max, itemReader) {
    if (!Array.isArray(value)) fail(path, 'Expected an array');
    if (value.length > max) fail(path, `Array exceeds ${max} entries`, 'SAIL_PORTABLE_TOO_MANY_ITEMS');
    const output = [];
    const seen = new Set();
    value.forEach((item, index) => {
        const next = itemReader(item, `${path}[${index}]`);
        const key = typeof next === 'string' ? next.toLocaleLowerCase('en-US') : JSON.stringify(next);
        if (seen.has(key)) fail(`${path}[${index}]`, 'Duplicate entries are forbidden');
        seen.add(key);
        output.push(next);
    });
    return output;
}

function optional(output, key, value) {
    if (value !== undefined && value !== null && value !== '') output[key] = value;
}

function approvedArtworkUrl(value, path, { nullable = true } = {}) {
    if (nullable && (value === null || value === undefined || value === '')) return null;
    const text = stringValue(value, path, { min: 1, max: 2048 });
    let parsed;
    try { parsed = new URL(text); }
    catch (_) { fail(path, 'Artwork URL is malformed'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) fail(path, 'Artwork URL must be credential-free HTTPS');
    const host = parsed.hostname.toLowerCase();
    if (!APPROVED_ARTWORK_HOSTS.includes(host)) fail(path, 'Artwork host is not approved');
    parsed.hash = '';
    return parsed.toString();
}

function validateConfigEntry(value, path) {
    const input = exactObject(value, path, CONFIG_ENTRY_KEYS);
    const output = {
        id: idValue(input.id, `${path}.id`),
        name: stringValue(input.name, `${path}.name`, { min: 1, max: 80 }),
        kind: stringValue(input.kind, `${path}.kind`, { pattern: /^(?:file|folder)$/ }),
        enabled: booleanValue(input.enabled, `${path}.enabled`),
        beforeLaunch: booleanValue(input.beforeLaunch, `${path}.beforeLaunch`),
        afterExit: booleanValue(input.afterExit, `${path}.afterExit`),
        intervalMinutes: numberValue(input.intervalMinutes, `${path}.intervalMinutes`, { min: 0, max: 60, integer: true })
    };
    if (![0, 5, 10, 15, 30, 60].includes(output.intervalMinutes)) fail(`${path}.intervalMinutes`, 'Unsupported configuration interval');
    return output;
}

function validateAchievementData(value, path, fallbackAppId = '') {
    const input = exactObject(value, path, ACHIEVEMENT_DATA_KEYS);
    if (input.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'Unsupported achievement schema');
    const items = uniqueArray(input.items, `${path}.items`, LIMITS.achievementItemsPerGame, (item, itemPath) => {
        const row = exactObject(item, itemPath, ACHIEVEMENT_ITEM_KEYS);
        const output = {
            id: stringValue(row.id, `${itemPath}.id`, { min: 1, max: 160 }),
            displayName: stringValue(row.displayName, `${itemPath}.displayName`, { min: 1, max: 240 }),
            description: stringValue(row.description || '', `${itemPath}.description`, { max: 2000 }),
            hidden: booleanValue(row.hidden, `${itemPath}.hidden`),
            icon: approvedArtworkUrl(row.icon, `${itemPath}.icon`),
            iconGray: approvedArtworkUrl(row.iconGray, `${itemPath}.iconGray`),
            unlocked: booleanValue(row.unlocked, `${itemPath}.unlocked`),
            unlockTime: numberValue(row.unlockTime, `${itemPath}.unlockTime`, { min: 1, max: 8640000000000000, integer: true, nullable: true })
        };
        optional(output, 'source', row.source === null || row.source === undefined
            ? null
            : stringValue(row.source, `${itemPath}.source`, { min: 1, max: 40, pattern: /^[A-Za-z0-9._-]+$/ }));
        return output;
    });
    assertUniqueIds(items, `${path}.items`);
    return {
        schemaVersion: 1,
        appId: input.appId ? stringValue(input.appId, `${path}.appId`, { max: 20, pattern: /^\d*$/ }) : String(fallbackAppId || ''),
        updatedAt: numberValue(input.updatedAt, `${path}.updatedAt`, { min: 0, max: 8640000000000000, integer: true }),
        lastSteamRefreshAt: numberValue(input.lastSteamRefreshAt, `${path}.lastSteamRefreshAt`, { min: 1, max: 8640000000000000, integer: true, nullable: true }),
        lastLocalScanAt: numberValue(input.lastLocalScanAt, `${path}.lastLocalScanAt`, { min: 1, max: 8640000000000000, integer: true, nullable: true }),
        items
    };
}

function validateGame(value, path) {
    const input = exactObject(value, path, GAME_KEYS);
    const output = {
        id: idValue(input.id, `${path}.id`),
        name: stringValue(input.name, `${path}.name`, { min: 1, max: 160 }),
        tags: uniqueArray(input.tags || [], `${path}.tags`, LIMITS.tagsPerGame, (item, itemPath) => stringValue(item, itemPath, { min: 1, max: 80 })),
        isFavorite: booleanValue(input.isFavorite, `${path}.isFavorite`),
        addedAt: numberValue(input.addedAt, `${path}.addedAt`, { min: 0, max: 8640000000000000, integer: true }),
        playtime: numberValue(input.playtime, `${path}.playtime`, { min: 0, max: 1000000000000 }),
        lastPlayed: numberValue(input.lastPlayed, `${path}.lastPlayed`, { min: 1, max: 8640000000000000, integer: true, nullable: true }),
        playtimeSessionIds: uniqueArray(input.playtimeSessionIds || [], `${path}.playtimeSessionIds`, 50, idValue),
        configSyncEntries: uniqueArray(input.configSyncEntries || [], `${path}.configSyncEntries`, LIMITS.configEntriesPerGame, validateConfigEntry)
    };
    assertUniqueIds(output.configSyncEntries, `${path}.configSyncEntries`);
    if (input.platform !== null && input.platform !== undefined) {
        output.platform = stringValue(input.platform, `${path}.platform`, { pattern: /^(?:steam|epic|gog|rom|custom)$/ });
    }
    for (const key of ['steamAppId', 'searchSteamAppId']) {
        if (input[key] !== null && input[key] !== undefined && input[key] !== '') {
            output[key] = stringValue(String(input[key]), `${path}.${key}`, { min: 1, max: 10, pattern: /^[1-9]\d{0,9}$/ });
        }
    }
    for (const key of ['epicId', 'gogId', 'sourceIdentifier']) {
        optional(output, key, input[key] === null || input[key] === undefined
            ? null
            : stringValue(String(input[key]), `${path}.${key}`, { min: 1, max: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ }));
    }
    for (const key of ['source', 'sourceTitle', 'sourceVersion']) {
        optional(output, key, input[key] === null || input[key] === undefined
            ? null
            : stringValue(String(input[key]), `${path}.${key}`, { min: 1, max: key === 'sourceTitle' ? 160 : 80 }));
    }
    if (input.isRom !== undefined) output.isRom = booleanValue(input.isRom, `${path}.isRom`);
    if (input.installedAt !== undefined && input.installedAt !== null) output.installedAt = timestampValue(input.installedAt, `${path}.installedAt`);
    if (input.maintenanceHideInformationIssues !== undefined) {
        output.maintenanceHideInformationIssues = booleanValue(input.maintenanceHideInformationIssues, `${path}.maintenanceHideInformationIssues`);
    }
    if (input.dependencyRequirements !== undefined) {
        output.dependencyRequirements = uniqueArray(input.dependencyRequirements, `${path}.dependencyRequirements`, 32,
            (item, itemPath) => stringValue(item, itemPath, { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ }));
    }
    optional(output, 'steamImageUrl', approvedArtworkUrl(input.steamImageUrl, `${path}.steamImageUrl`));
    optional(output, 'steamHeroUrl', approvedArtworkUrl(input.steamHeroUrl, `${path}.steamHeroUrl`));
    if (input.achievementData !== undefined && input.achievementData !== null) {
        output.achievementData = validateAchievementData(input.achievementData, `${path}.achievementData`, output.steamAppId);
    }
    return output;
}

function validateSection(value, path) {
    const input = exactObject(value, path, SECTION_KEYS);
    return {
        id: idValue(input.id, `${path}.id`),
        name: stringValue(input.name, `${path}.name`, { min: 1, max: 80 }),
        icon: stringValue(input.icon || 'folder', `${path}.icon`, { min: 1, max: 32 })
    };
}

function validateSyncSettings(value, path) {
    const input = exactObject(value, path, SYNC_KEYS);
    const destinationsInput = exactObject(input.destinations, `${path}.destinations`, SYNC_DESTINATION_KEYS);
    const providerArray = (items, itemPath, allowSailCloud) => uniqueArray(items, itemPath, 5, (provider, providerPath) => {
        const allowed = allowSailCloud ? /^(?:google|onedrive|dropbox|mediafire|sailcloud)$/ : /^(?:google|onedrive|dropbox|mediafire)$/;
        return stringValue(provider, providerPath, { pattern: allowed, max: 20 });
    });
    const interval = numberValue(input.configIntervalMinutes, `${path}.configIntervalMinutes`, { min: 0, max: 60, integer: true });
    if (![0, 5, 10, 15, 30, 60].includes(interval)) fail(`${path}.configIntervalMinutes`, 'Unsupported sync interval');
    return {
        enabled: booleanValue(input.enabled, `${path}.enabled`),
        conflictMode: stringValue(input.conflictMode, `${path}.conflictMode`, { pattern: /^(?:prompt|newest|local)$/ }),
        configChangeMode: stringValue(input.configChangeMode, `${path}.configChangeMode`, { pattern: /^(?:off|debounced|immediate)$/ }),
        configIntervalMinutes: interval,
        configOnStartup: booleanValue(input.configOnStartup, `${path}.configOnStartup`),
        configBeforeExit: booleanValue(input.configBeforeExit, `${path}.configBeforeExit`),
        saveBeforeLaunch: booleanValue(input.saveBeforeLaunch, `${path}.saveBeforeLaunch`),
        saveAfterExit: booleanValue(input.saveAfterExit, `${path}.saveAfterExit`),
        gameConfigBeforeLaunch: booleanValue(input.gameConfigBeforeLaunch, `${path}.gameConfigBeforeLaunch`),
        gameConfigAfterExit: booleanValue(input.gameConfigAfterExit, `${path}.gameConfigAfterExit`),
        sailCloudSingleSaveCopy: booleanValue(input.sailCloudSingleSaveCopy, `${path}.sailCloudSingleSaveCopy`),
        sailCloudExcludedGameSaveKeys: uniqueArray(input.sailCloudExcludedGameSaveKeys || [], `${path}.sailCloudExcludedGameSaveKeys`, LIMITS.settingsArray,
            (item, itemPath) => stringValue(item, itemPath, { min: 11, max: 300, pattern: /^game-save:[A-Za-z0-9][A-Za-z0-9._:-]*$/ })),
        destinations: {
            config: providerArray(destinationsInput.config || [], `${path}.destinations.config`, false),
            library: providerArray(destinationsInput.library || [], `${path}.destinations.library`, false),
            saves: providerArray(destinationsInput.saves || [], `${path}.destinations.saves`, true),
            gameConfigs: providerArray(destinationsInput.gameConfigs || [], `${path}.destinations.gameConfigs`, false)
        }
    };
}

function validateSettings(value, path) {
    const input = exactObject(value, path, SETTINGS_KEYS);
    const output = {};
    for (const key of BOOLEAN_SETTING_KEYS) {
        if (input[key] !== undefined) output[key] = booleanValue(input[key], `${path}.${key}`);
    }
    for (const [key, rule] of Object.entries(NUMBER_SETTING_RULES)) {
        if (input[key] !== undefined) output[key] = numberValue(input[key], `${path}.${key}`, rule);
    }
    for (const [key, values] of Object.entries(ENUM_SETTING_RULES)) {
        if (input[key] === undefined) continue;
        const next = stringValue(input[key], `${path}.${key}`, { min: 1, max: 40 });
        if (!values.has(next)) fail(`${path}.${key}`, 'Unsupported setting value');
        output[key] = next;
    }
    if (input.theme !== undefined) {
        const theme = stringValue(input.theme, `${path}.theme`, { min: 1, max: 40 });
        if (!BUILTIN_THEMES.has(theme)) fail(`${path}.theme`, 'Only built-in themes are portable');
        output.theme = theme;
    }
    if (input.steamId !== undefined && input.steamId !== '') {
        output.steamId = stringValue(String(input.steamId), `${path}.steamId`, { min: 17, max: 20, pattern: /^\d+$/ });
    }
    if (input.favoriteFriends !== undefined) {
        output.favoriteFriends = uniqueArray(input.favoriteFriends, `${path}.favoriteFriends`, LIMITS.settingsArray,
            (item, itemPath) => stringValue(String(item), itemPath, { min: 1, max: 80, pattern: /^[A-Za-z0-9._:-]+$/ }));
    }
    if (input.dismissedAlerts !== undefined) {
        output.dismissedAlerts = uniqueArray(input.dismissedAlerts, `${path}.dismissedAlerts`, LIMITS.settingsArray,
            (item, itemPath) => stringValue(String(item), itemPath, { min: 1, max: 160, pattern: /^[A-Za-z0-9._:-]+$/ }));
    }
    if (input.buttonLocations !== undefined) {
        const locations = exactObject(input.buttonLocations, `${path}.buttonLocations`, BUTTON_LOCATION_KEYS);
        output.buttonLocations = {};
        for (const key of BUTTON_LOCATION_KEYS) {
            if (locations[key] === undefined) continue;
            output.buttonLocations[key] = stringValue(locations[key], `${path}.buttonLocations.${key}`, {
                pattern: /^(?:hidden|top|bottom|header|sidebar)$/,
                max: 20
            });
        }
    }
    if (input.syncV2 !== undefined) output.syncV2 = validateSyncSettings(input.syncV2, `${path}.syncV2`);
    return output;
}

function validateProfile(value, path) {
    const input = exactObject(value, path, PROFILE_KEYS);
    const output = {
        id: idValue(input.id, `${path}.id`),
        name: stringValue(input.name, `${path}.name`, { min: 1, max: 80 }),
        conflictMode: stringValue(input.conflictMode, `${path}.conflictMode`, { pattern: /^(?:prompt|newest|local)$/ })
    };
    optional(output, 'createdAt', optionalTimestamp(input.createdAt, `${path}.createdAt`));
    optional(output, 'updatedAt', optionalTimestamp(input.updatedAt, `${path}.updatedAt`));
    return output;
}

function validateLibrary(value, path) {
    const input = exactObject(value, path, LIBRARY_KEYS);
    const output = {
        id: idValue(input.id, `${path}.id`),
        profileId: idValue(input.profileId, `${path}.profileId`),
        name: stringValue(input.name, `${path}.name`, { min: 1, max: 80 }),
        games: uniqueArray(input.games, `${path}.games`, LIMITS.games, validateGame),
        sections: uniqueArray(input.sections, `${path}.sections`, LIMITS.sections, validateSection)
    };
    assertUniqueIds(output.games, `${path}.games`);
    assertUniqueIds(output.sections, `${path}.sections`);
    optional(output, 'createdAt', optionalTimestamp(input.createdAt, `${path}.createdAt`));
    optional(output, 'updatedAt', optionalTimestamp(input.updatedAt, `${path}.updatedAt`));
    return output;
}

function validatePreset(value, path) {
    const input = exactObject(value, path, PRESET_KEYS);
    const output = {
        id: idValue(input.id, `${path}.id`),
        profileId: idValue(input.profileId, `${path}.profileId`),
        name: stringValue(input.name, `${path}.name`, { min: 1, max: 80 }),
        settings: validateSettings(input.settings, `${path}.settings`)
    };
    optional(output, 'createdAt', optionalTimestamp(input.createdAt, `${path}.createdAt`));
    optional(output, 'updatedAt', optionalTimestamp(input.updatedAt, `${path}.updatedAt`));
    return output;
}

function assertUniqueIds(items, path) {
    const seen = new Set();
    items.forEach((item, index) => {
        const key = item.id.toLocaleLowerCase('en-US');
        if (seen.has(key)) fail(`${path}[${index}].id`, 'Duplicate IDs are forbidden');
        seen.add(key);
    });
}

function validatePortableArtifact(input) {
    const value = decodeInput(input);
    preflight(value);
    const root = exactObject(value, '$', ROOT_KEYS);
    if (root.schema !== PORTABLE_SCHEMA) fail('$.schema', `Expected ${PORTABLE_SCHEMA}`, 'SAIL_PORTABLE_SCHEMA_UNSUPPORTED');
    if (!PORTABLE_KINDS.includes(root.kind)) fail('$.kind', 'Unsupported portable artifact kind');
    const artifact = {
        schema: PORTABLE_SCHEMA,
        kind: root.kind,
        exportedAt: timestampValue(root.exportedAt, '$.exportedAt'),
        profiles: uniqueArray(root.profiles, '$.profiles', LIMITS.profiles, validateProfile),
        libraries: uniqueArray(root.libraries, '$.libraries', LIMITS.libraries, validateLibrary),
        presets: uniqueArray(root.presets, '$.presets', LIMITS.presets, validatePreset)
    };
    assertUniqueIds(artifact.profiles, '$.profiles');
    assertUniqueIds(artifact.libraries, '$.libraries');
    assertUniqueIds(artifact.presets, '$.presets');
    const profileIds = new Set(artifact.profiles.map(item => item.id));
    artifact.libraries.forEach((library, index) => {
        if (!profileIds.has(library.profileId)) fail(`$.libraries[${index}].profileId`, 'Library references an unknown profile');
    });
    artifact.presets.forEach((preset, index) => {
        if (!profileIds.has(preset.profileId)) fail(`$.presets[${index}].profileId`, 'Preset references an unknown profile');
    });
    if (artifact.kind === 'launcher-snapshot' && (artifact.profiles.length !== 1 || artifact.libraries.length !== 1 || artifact.presets.length !== 1)) {
        fail('$', 'Launcher snapshots must contain exactly one profile, library, and preset');
    }
    preflight(artifact);
    return artifact;
}

function diagnosticsFor(sourceSchema) {
    return {
        sourceSchema,
        droppedFieldCount: 0,
        droppedFields: [],
        authorityWarningGameIds: []
    };
}

function recordDrop(diagnostics, path, key, reason = 'not-portable', gameId = null) {
    diagnostics.droppedFieldCount += 1;
    if (diagnostics.droppedFields.length < 256) diagnostics.droppedFields.push({ path, key, reason });
    if (gameId && !diagnostics.authorityWarningGameIds.includes(gameId)) {
        diagnostics.authorityWarningGameIds.push(gameId);
    }
}

function stripKnownLocalAchievementArtwork(input, diagnostics) {
    const hasLocalArtwork = (Array.isArray(input.libraries) ? input.libraries : []).some(library =>
        (library && Array.isArray(library.games) ? library.games : []).some(game =>
            (game && game.achievementData && Array.isArray(game.achievementData.items) ? game.achievementData.items : [])
                .some(item => isPlainObject(item) && ['iconPath', 'iconGrayPath']
                    .some(key => Object.prototype.hasOwnProperty.call(item, key)))
        )
    );
    if (!hasLocalArtwork) return input;
    const output = JSON.parse(JSON.stringify(input));
    for (const [libraryIndex, library] of (Array.isArray(output.libraries) ? output.libraries : []).entries()) {
        for (const [gameIndex, game] of (library && Array.isArray(library.games) ? library.games : []).entries()) {
            const items = game && game.achievementData && Array.isArray(game.achievementData.items)
                ? game.achievementData.items
                : [];
            for (const [itemIndex, item] of items.entries()) {
                if (!isPlainObject(item)) continue;
                for (const key of ['iconPath', 'iconGrayPath']) {
                    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
                    delete item[key];
                    recordDrop(
                        diagnostics,
                        `$.libraries[${libraryIndex}].games[${gameIndex}].achievementData.items[${itemIndex}].${key}`,
                        key,
                        'device-local-achievement-artwork',
                        game && game.id ? String(game.id).slice(0, 128) : null
                    );
                }
            }
        }
    }
    return output;
}

function collectForbiddenLegacyFields(value, diagnostics) {
    const stack = [{ value, path: '$', gameId: null }];
    while (stack.length) {
        const current = stack.pop();
        if (!current.value || typeof current.value !== 'object') continue;
        if (Array.isArray(current.value)) {
            current.value.forEach((item, index) => stack.push({ value: item, path: `${current.path}[${index}]`, gameId: current.gameId }));
            continue;
        }
        const isGameObject = /(?:^|\.)(?:myGames|games)\[\d+\]$/.test(current.path);
        const possibleGameId = isGameObject && current.value.id
            ? String(current.value.id).slice(0, 128)
            : current.gameId;
        for (const [key, child] of Object.entries(current.value)) {
            if (FORBIDDEN_PORTABLE_KEYS.has(key.toLowerCase())) {
                recordDrop(diagnostics, `${current.path}.${key}`, key, 'device-authority-or-secret', possibleGameId);
            }
            stack.push({ value: child, path: `${current.path}.${key}`, gameId: possibleGameId });
        }
    }
}

function trackUnknownKeys(value, path, allowed, diagnostics, gameId = null) {
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(value)) {
        if (!allowed.has(key) && !FORBIDDEN_PORTABLE_KEYS.has(key.toLowerCase())) {
            recordDrop(diagnostics, `${path}.${key}`, key, 'unknown-legacy-field', gameId);
        }
    }
}

function safeLegacy(reader, diagnostics, path, key, fallback = undefined) {
    try { return reader(); }
    catch (_) {
        recordDrop(diagnostics, path, key, 'invalid-legacy-value');
        return fallback;
    }
}

function legacySection(value, index, diagnostics, path) {
    const input = typeof value === 'string' ? { name: value } : value;
    if (!isPlainObject(input)) {
        recordDrop(diagnostics, path, String(index), 'invalid-section');
        return null;
    }
    trackUnknownKeys(input, path, new Set(['id', 'name', 'icon', 'customIcon']), diagnostics);
    const name = safeLegacy(() => stringValue(String(input.name || ''), `${path}.name`, { min: 1, max: 80 }), diagnostics, `${path}.name`, 'name');
    if (!name) return null;
    const id = safeLegacy(() => idValue(input.id || `section-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 16)}`, `${path}.id`), diagnostics, `${path}.id`, 'id');
    if (!id) return null;
    return { id, name, icon: safeLegacy(() => stringValue(String(input.icon || 'folder'), `${path}.icon`, { min: 1, max: 32 }), diagnostics, `${path}.icon`, 'icon', 'folder') };
}

function legacyConfigEntry(value, index, diagnostics, path) {
    if (!isPlainObject(value)) {
        recordDrop(diagnostics, path, String(index), 'invalid-config-entry');
        return null;
    }
    trackUnknownKeys(value, path, new Set([...CONFIG_ENTRY_KEYS, 'localPath']), diagnostics);
    const candidate = {
        id: value.id || `config-${index + 1}`,
        name: value.name || 'Game Configuration',
        kind: value.kind === 'file' ? 'file' : 'folder',
        enabled: value.enabled !== false,
        beforeLaunch: !!value.beforeLaunch,
        afterExit: value.afterExit !== false,
        intervalMinutes: [0, 5, 10, 15, 30, 60].includes(Number(value.intervalMinutes)) ? Number(value.intervalMinutes) : 0
    };
    return safeLegacy(() => validateConfigEntry(candidate, path), diagnostics, path, String(index), null);
}

function legacyAchievementData(value, fallbackAppId, diagnostics, path) {
    if (!value || typeof value !== 'object') return null;
    trackUnknownKeys(value, path, new Set([...ACHIEVEMENT_DATA_KEYS, 'appid']), diagnostics);
    if (Array.isArray(value.items)) {
        value.items.forEach((item, index) => {
            if (item && typeof item === 'object') {
                trackUnknownKeys(item, `${path}.items[${index}]`, new Set([
                    ...ACHIEVEMENT_ITEM_KEYS, 'apiName', 'apiname', 'internalName', 'key', 'name',
                    'display_name', 'title', 'desc', 'achieved', 'earned', 'isUnlocked',
                    'complete', 'unlocktime', 'unlock_time', 'unlockedAt', 'timestamp',
                    'earned_time', 'iconUrl', 'icon_url', 'icongray', 'icon_gray',
                    'lockedIcon', 'iconPath', 'icon_path', 'iconGrayPath',
                    'icon_gray_path', 'lockedIconPath'
                ]), diagnostics);
            }
        });
    }
    const normalized = normalizeAchievementData(value, fallbackAppId);
    if (!normalized) return null;
    const candidate = {
        schemaVersion: 1,
        appId: normalized.appId || String(fallbackAppId || ''),
        updatedAt: normalized.updatedAt || 0,
        lastSteamRefreshAt: normalized.lastSteamRefreshAt || null,
        lastLocalScanAt: normalized.lastLocalScanAt || null,
        items: normalized.items.slice(0, LIMITS.achievementItemsPerGame).map(item => ({
            id: item.id,
            displayName: item.displayName,
            description: item.description || '',
            hidden: !!item.hidden,
            icon: safeLegacy(() => approvedArtworkUrl(item.icon, `${path}.icon`), diagnostics, `${path}.icon`, 'icon', null),
            iconGray: safeLegacy(() => approvedArtworkUrl(item.iconGray, `${path}.iconGray`), diagnostics, `${path}.iconGray`, 'iconGray', null),
            unlocked: !!item.unlocked,
            unlockTime: item.unlockTime || null,
            source: item.source || null
        }))
    };
    return safeLegacy(() => validateAchievementData(candidate, path, fallbackAppId), diagnostics, path, 'achievementData', null);
}

function legacyGame(value, index, diagnostics, path) {
    if (!isPlainObject(value)) {
        recordDrop(diagnostics, path, String(index), 'invalid-game');
        return null;
    }
    const rawId = value.id === undefined || value.id === null || value.id === '' ? `legacy-game-${index + 1}` : value.id;
    const gameId = safeLegacy(() => idValue(rawId, `${path}.id`), diagnostics, `${path}.id`, 'id');
    if (!gameId) return null;
    trackUnknownKeys(value, path, new Set([
        ...GAME_KEYS, 'exePath', 'installFolder', 'localSave', 'driveSave', 'playDetectionPath',
        'companionApp', 'preLaunchScript', 'postLaunchScript', 'shortcutIcon',
        'achievementSources', 'customBannerPath', 'iconData', 'emulatorPath', 'romPath',
        'romArgs', 'firmwarePath', 'runAsAdmin', 'launchArgs', 'highPriority',
        'saveScanDirectories', 'saveScanPending'
    ]), diagnostics, gameId);
    const name = safeLegacy(() => stringValue(String(value.name || ''), `${path}.name`, { min: 1, max: 160 }), diagnostics, `${path}.name`, 'name');
    if (!name) return null;
    const candidate = {
        id: gameId,
        name,
        tags: Array.isArray(value.tags) ? value.tags.slice(0, LIMITS.tagsPerGame).map(String) : [],
        isFavorite: !!value.isFavorite,
        addedAt: Number.isFinite(Number(value.addedAt)) && Number(value.addedAt) >= 0 ? Math.round(Number(value.addedAt)) : 0,
        playtime: Number.isFinite(Number(value.playtime)) && Number(value.playtime) >= 0 ? Number(value.playtime) : 0,
        lastPlayed: Number.isFinite(Number(value.lastPlayed)) && Number(value.lastPlayed) > 0 ? Math.round(Number(value.lastPlayed)) : null,
        playtimeSessionIds: Array.isArray(value.playtimeSessionIds) ? value.playtimeSessionIds.slice(-50).map(String) : [],
        configSyncEntries: Array.isArray(value.configSyncEntries)
            ? value.configSyncEntries.slice(0, LIMITS.configEntriesPerGame).map((entry, entryIndex) => legacyConfigEntry(entry, entryIndex, diagnostics, `${path}.configSyncEntries[${entryIndex}]`)).filter(Boolean)
            : []
    };
    let platform = value.platform;
    if (!platform && value.isRom) platform = 'rom';
    if (!platform && value.steamAppId) platform = 'steam';
    if (['steam', 'epic', 'gog', 'rom', 'custom'].includes(platform)) candidate.platform = platform;
    if (value.isRom !== undefined) candidate.isRom = !!value.isRom;
    for (const key of ['steamAppId', 'searchSteamAppId', 'epicId', 'gogId']) {
        if (value[key] !== undefined && value[key] !== null && value[key] !== '') candidate[key] = String(value[key]);
    }
    for (const key of ['source', 'sourceIdentifier', 'sourceTitle', 'sourceVersion']) {
        if (value[key] !== undefined && value[key] !== null && value[key] !== '') candidate[key] = String(value[key]);
    }
    if (value.installedAt) candidate.installedAt = value.installedAt;
    if (value.maintenanceHideInformationIssues !== undefined) candidate.maintenanceHideInformationIssues = !!value.maintenanceHideInformationIssues;
    if (Array.isArray(value.dependencyRequirements)) candidate.dependencyRequirements = value.dependencyRequirements.map(String);
    for (const key of ['steamImageUrl', 'steamHeroUrl']) {
        if (!value[key]) continue;
        const normalized = safeLegacy(() => approvedArtworkUrl(String(value[key]), `${path}.${key}`), diagnostics, `${path}.${key}`, key, null);
        if (normalized) candidate[key] = normalized;
    }
    const achievementData = legacyAchievementData(value.achievementData, candidate.steamAppId, diagnostics, `${path}.achievementData`);
    if (achievementData) candidate.achievementData = achievementData;
    return safeLegacy(() => validateGame(candidate, path), diagnostics, path, gameId, null);
}

function defaultSyncSettings() {
    return {
        enabled: true,
        conflictMode: 'prompt',
        configChangeMode: 'debounced',
        configIntervalMinutes: 0,
        configOnStartup: true,
        configBeforeExit: true,
        saveBeforeLaunch: true,
        saveAfterExit: true,
        gameConfigBeforeLaunch: false,
        gameConfigAfterExit: true,
        sailCloudSingleSaveCopy: false,
        sailCloudExcludedGameSaveKeys: [],
        destinations: { config: [], library: [], saves: [], gameConfigs: [] }
    };
}

function legacySyncSettings(value, diagnostics, path) {
    if (!isPlainObject(value)) return null;
    trackUnknownKeys(value, path, SYNC_KEYS, diagnostics);
    const sourceDestinations = isPlainObject(value.destinations) ? value.destinations : {};
    trackUnknownKeys(sourceDestinations, `${path}.destinations`, SYNC_DESTINATION_KEYS, diagnostics);
    const defaults = defaultSyncSettings();
    const candidate = {
        enabled: value.enabled !== false,
        conflictMode: ['prompt', 'newest', 'local'].includes(value.conflictMode) ? value.conflictMode : defaults.conflictMode,
        configChangeMode: ['off', 'debounced', 'immediate'].includes(value.configChangeMode) ? value.configChangeMode : defaults.configChangeMode,
        configIntervalMinutes: [0, 5, 10, 15, 30, 60].includes(Number(value.configIntervalMinutes)) ? Number(value.configIntervalMinutes) : 0,
        configOnStartup: value.configOnStartup !== false,
        configBeforeExit: value.configBeforeExit !== false,
        saveBeforeLaunch: value.saveBeforeLaunch !== false,
        saveAfterExit: value.saveAfterExit !== false,
        gameConfigBeforeLaunch: !!value.gameConfigBeforeLaunch,
        gameConfigAfterExit: value.gameConfigAfterExit !== false,
        sailCloudSingleSaveCopy: !!value.sailCloudSingleSaveCopy,
        sailCloudExcludedGameSaveKeys: Array.isArray(value.sailCloudExcludedGameSaveKeys) ? value.sailCloudExcludedGameSaveKeys.map(String) : [],
        destinations: {
            config: Array.isArray(sourceDestinations.config) ? sourceDestinations.config : [],
            library: Array.isArray(sourceDestinations.library) ? sourceDestinations.library : [],
            saves: Array.isArray(sourceDestinations.saves) ? sourceDestinations.saves : [],
            gameConfigs: Array.isArray(sourceDestinations.gameConfigs) ? sourceDestinations.gameConfigs : []
        }
    };
    return safeLegacy(() => validateSyncSettings(candidate, path), diagnostics, path, 'syncV2', defaults);
}

function legacySettings(value, diagnostics, path) {
    const input = isPlainObject(value) ? value : {};
    trackUnknownKeys(input, path, SETTINGS_KEYS, diagnostics);
    const candidate = {};
    for (const key of BOOLEAN_SETTING_KEYS) {
        if (typeof input[key] === 'boolean') candidate[key] = input[key];
    }
    for (const key of Object.keys(NUMBER_SETTING_RULES)) {
        if (typeof input[key] === 'number' && Number.isFinite(input[key])) candidate[key] = input[key];
    }
    for (const key of Object.keys(ENUM_SETTING_RULES)) {
        if (typeof input[key] === 'string' && ENUM_SETTING_RULES[key].has(input[key])) candidate[key] = input[key];
    }
    if (typeof input.theme === 'string' && BUILTIN_THEMES.has(input.theme)) candidate.theme = input.theme;
    if (input.steamId !== undefined && input.steamId !== null && input.steamId !== '') candidate.steamId = String(input.steamId);
    if (Array.isArray(input.favoriteFriends)) candidate.favoriteFriends = input.favoriteFriends.map(String);
    if (Array.isArray(input.dismissedAlerts)) candidate.dismissedAlerts = input.dismissedAlerts.map(String);
    if (isPlainObject(input.buttonLocations)) {
        trackUnknownKeys(input.buttonLocations, `${path}.buttonLocations`, BUTTON_LOCATION_KEYS, diagnostics);
        candidate.buttonLocations = {};
        for (const key of BUTTON_LOCATION_KEYS) {
            if (typeof input.buttonLocations[key] === 'string' && /^(?:hidden|top|bottom|header|sidebar)$/.test(input.buttonLocations[key])) {
                candidate.buttonLocations[key] = input.buttonLocations[key];
            }
        }
    }
    if (input.syncV2) candidate.syncV2 = legacySyncSettings(input.syncV2, diagnostics, `${path}.syncV2`);
    return safeLegacy(() => validateSettings(candidate, path), diagnostics, path, 'globalSettings', {});
}

function canonicalContext(context = {}) {
    const now = context.exportedAt || new Date().toISOString();
    return {
        exportedAt: timestampValue(now, '$context.exportedAt'),
        profileId: idValue(context.profileId || 'local-profile', '$context.profileId'),
        libraryId: idValue(context.libraryId || 'local-library', '$context.libraryId'),
        presetId: idValue(context.presetId || 'local-preset', '$context.presetId'),
        profileName: stringValue(context.profileName || 'Imported Profile', '$context.profileName', { min: 1, max: 80 }),
        libraryName: stringValue(context.libraryName || 'Main Library', '$context.libraryName', { min: 1, max: 80 }),
        presetName: stringValue(context.presetName || 'Default Settings', '$context.presetName', { min: 1, max: 80 }),
        conflictMode: ['prompt', 'newest', 'local'].includes(context.conflictMode) ? context.conflictMode : 'prompt'
    };
}

function adaptLegacySnapshot(raw, context = {}, diagnostics = diagnosticsFor(raw && raw.schemaVersion ? `v${raw.schemaVersion}` : 'v1')) {
    const ctx = canonicalContext(context);
    const snapshot = isPlainObject(raw) ? raw : {};
    trackUnknownKeys(snapshot, '$', new Set(['schemaVersion', 'myGames', 'customSections', 'globalSettings']), diagnostics);
    const games = (Array.isArray(snapshot.myGames) ? snapshot.myGames : []).slice(0, LIMITS.games)
        .map((game, index) => legacyGame(game, index, diagnostics, `$.myGames[${index}]`)).filter(Boolean);
    const sections = (Array.isArray(snapshot.customSections) ? snapshot.customSections : []).slice(0, LIMITS.sections)
        .map((section, index) => legacySection(section, index, diagnostics, `$.customSections[${index}]`)).filter(Boolean);
    const artifact = validatePortableArtifact({
        schema: PORTABLE_SCHEMA,
        kind: 'launcher-snapshot',
        exportedAt: ctx.exportedAt,
        profiles: [{ id: ctx.profileId, name: ctx.profileName, conflictMode: ctx.conflictMode }],
        libraries: [{ id: ctx.libraryId, profileId: ctx.profileId, name: ctx.libraryName, games, sections }],
        presets: [{ id: ctx.presetId, profileId: ctx.profileId, name: ctx.presetName, settings: legacySettings(snapshot.globalSettings, diagnostics, '$.globalSettings') }]
    });
    return { artifact, diagnostics, legacy: true };
}

function adaptLegacyControlPlane(raw, diagnostics = diagnosticsFor('legacy-control-plane')) {
    const input = isPlainObject(raw) ? raw : {};
    trackUnknownKeys(input, '$', new Set(['profiles', 'libraries', 'presets', 'policies', 'connections', 'storage']), diagnostics);
    const profileRows = Array.isArray(input.profiles) ? input.profiles.slice(0, LIMITS.profiles) : [];
    const profiles = [];
    for (let index = 0; index < profileRows.length; index++) {
        const row = profileRows[index];
        if (!isPlainObject(row)) continue;
        trackUnknownKeys(row, `$.profiles[${index}]`, new Set([
            'id', 'name', 'conflictMode', 'conflict_mode', 'createdAt', 'created_at',
            'updatedAt', 'updated_at', 'pin_salt', 'pin_verifier', 'user_id'
        ]), diagnostics);
        const candidate = {
            id: row.id,
            name: row.name || 'Imported Profile',
            conflictMode: row.conflictMode || row.conflict_mode || 'prompt'
        };
        if (row.createdAt || row.created_at) candidate.createdAt = row.createdAt || row.created_at;
        if (row.updatedAt || row.updated_at) candidate.updatedAt = row.updatedAt || row.updated_at;
        const profile = safeLegacy(() => validateProfile(candidate, `$.profiles[${index}]`), diagnostics, `$.profiles[${index}]`, 'profile', null);
        if (profile) profiles.push(profile);
    }
    const profileIds = new Set(profiles.map(item => item.id));
    const libraries = [];
    for (const [index, row] of (Array.isArray(input.libraries) ? input.libraries.slice(0, LIMITS.libraries) : []).entries()) {
        if (!isPlainObject(row)) continue;
        trackUnknownKeys(row, `$.libraries[${index}]`, new Set([
            'id', 'profileId', 'profile_id', 'name', 'createdAt', 'created_at',
            'updatedAt', 'updated_at', 'catalog', 'user_id', 'sail_artifact'
        ]), diagnostics);
        const profileId = String(row.profileId || row.profile_id || '');
        if (!profileIds.has(profileId)) { recordDrop(diagnostics, `$.libraries[${index}]`, 'profileId', 'unknown-profile'); continue; }
        const catalog = isPlainObject(row.catalog) ? row.catalog : {};
        trackUnknownKeys(catalog, `$.libraries[${index}].catalog`, new Set(['games', 'sections', 'schemaVersion']), diagnostics);
        const games = (Array.isArray(catalog.games) ? catalog.games : []).slice(0, LIMITS.games)
            .map((game, gameIndex) => legacyGame(game, gameIndex, diagnostics, `$.libraries[${index}].catalog.games[${gameIndex}]`)).filter(Boolean);
        const sections = (Array.isArray(catalog.sections) ? catalog.sections : []).slice(0, LIMITS.sections)
            .map((section, sectionIndex) => legacySection(section, sectionIndex, diagnostics, `$.libraries[${index}].catalog.sections[${sectionIndex}]`)).filter(Boolean);
        const candidate = { id: row.id, profileId, name: row.name || 'Imported Library', games, sections };
        if (row.createdAt || row.created_at) candidate.createdAt = row.createdAt || row.created_at;
        if (row.updatedAt || row.updated_at) candidate.updatedAt = row.updatedAt || row.updated_at;
        const library = safeLegacy(() => validateLibrary(candidate, `$.libraries[${index}]`), diagnostics, `$.libraries[${index}]`, 'library', null);
        if (library) libraries.push(library);
    }
    const presets = [];
    for (const [index, row] of (Array.isArray(input.presets) ? input.presets.slice(0, LIMITS.presets) : []).entries()) {
        if (!isPlainObject(row)) continue;
        trackUnknownKeys(row, `$.presets[${index}]`, new Set([
            'id', 'profileId', 'profile_id', 'name', 'createdAt', 'created_at',
            'updatedAt', 'updated_at', 'settings', 'user_id', 'sail_artifact'
        ]), diagnostics);
        const profileId = String(row.profileId || row.profile_id || '');
        if (!profileIds.has(profileId)) { recordDrop(diagnostics, `$.presets[${index}]`, 'profileId', 'unknown-profile'); continue; }
        const candidate = {
            id: row.id,
            profileId,
            name: row.name || 'Imported Settings',
            settings: legacySettings(row.settings, diagnostics, `$.presets[${index}].settings`)
        };
        if (row.createdAt || row.created_at) candidate.createdAt = row.createdAt || row.created_at;
        if (row.updatedAt || row.updated_at) candidate.updatedAt = row.updatedAt || row.updated_at;
        const preset = safeLegacy(() => validatePreset(candidate, `$.presets[${index}]`), diagnostics, `$.presets[${index}]`, 'preset', null);
        if (preset) presets.push(preset);
    }
    const artifact = validatePortableArtifact({
        schema: PORTABLE_SCHEMA,
        kind: 'control-plane',
        exportedAt: new Date().toISOString(),
        profiles,
        libraries,
        presets
    });
    return { artifact, diagnostics, legacy: true };
}

function admitPortableArtifact(input, options = {}) {
    const value = decodeInput(input);
    preflight(value, { allowUndefined: !!options.allowUndefined });
    if (isPlainObject(value) && value.schema === PORTABLE_SCHEMA) {
        const diagnostics = diagnosticsFor(PORTABLE_SCHEMA);
        const compatible = stripKnownLocalAchievementArtwork(value, diagnostics);
        return { artifact: validatePortableArtifact(compatible), diagnostics, legacy: false };
    }
    if (isPlainObject(value) && typeof value.schema === 'string' && value.schema.startsWith('sail.portable/')) {
        fail('$.schema', `Unsupported portable schema '${value.schema}'`, 'SAIL_PORTABLE_SCHEMA_UNSUPPORTED');
    }
    if (isPlainObject(value) && Number(value.schemaVersion) > 2) {
        fail('$.schemaVersion', `Unsupported future portable schema version '${value.schemaVersion}'`, 'SAIL_PORTABLE_SCHEMA_UNSUPPORTED');
    }
    const diagnostics = diagnosticsFor(value && value.schemaVersion ? `v${value.schemaVersion}` : options.kindHint === 'control-plane' ? 'legacy-control-plane' : 'v1');
    collectForbiddenLegacyFields(value, diagnostics);
    if (options.kindHint === 'control-plane' || isPlainObject(value) && Array.isArray(value.profiles) && Array.isArray(value.libraries)) {
        return adaptLegacyControlPlane(value, diagnostics);
    }
    return adaptLegacySnapshot(value, options.context || {}, diagnostics);
}

function createPortableSnapshot(snapshot, context = {}) {
    preflight(snapshot, { allowUndefined: true });
    const diagnostics = diagnosticsFor('local-projection');
    collectForbiddenLegacyFields(snapshot, diagnostics);
    return adaptLegacySnapshot(snapshot, context, diagnostics);
}

function createPortableControlPlane(controlPlane) {
    preflight(controlPlane, { allowUndefined: true });
    const diagnostics = diagnosticsFor('local-control-plane-projection');
    collectForbiddenLegacyFields(controlPlane, diagnostics);
    return adaptLegacyControlPlane(controlPlane, diagnostics);
}

function portableArtifactToSnapshot(input, selection = {}) {
    const artifact = validatePortableArtifact(input);
    const profile = artifact.profiles.find(item => !selection.profileId || item.id === selection.profileId) || artifact.profiles[0];
    if (!profile) fail('$', 'Portable artifact contains no selected profile');
    const library = artifact.libraries.find(item => item.profileId === profile.id && (!selection.libraryId || item.id === selection.libraryId));
    const preset = artifact.presets.find(item => item.profileId === profile.id && (!selection.presetId || item.id === selection.presetId));
    if (!library || !preset) fail('$', 'Portable artifact is missing the selected library or preset');
    return {
        myGames: library.games,
        customSections: library.sections,
        globalSettings: preset.settings
    };
}

function serializePortableArtifact(input) {
    return JSON.stringify(validatePortableArtifact(input), null, 2);
}

function canonicalPortableBytes(input, options = {}) {
    const admitted = admitPortableArtifact(input, options);
    if (options.expectedKind && admitted.artifact.kind !== options.expectedKind) {
        fail('$.kind', `Expected a ${options.expectedKind} portable artifact`, 'SAIL_PORTABLE_KIND_MISMATCH');
    }
    const serialized = serializePortableArtifact(admitted.artifact);
    const verified = validatePortableArtifact(JSON.parse(serialized));
    const verifiedSerialization = serializePortableArtifact(verified);
    if (verifiedSerialization !== serialized) fail('$', 'Portable serialization failed independent verification');
    return {
        artifact: verified,
        bytes: Buffer.from(`${verifiedSerialization}\n`, 'utf8'),
        diagnostics: admitted.diagnostics,
        legacy: admitted.legacy
    };
}

module.exports = {
    APPROVED_ARTWORK_HOSTS,
    FORBIDDEN_PORTABLE_KEYS,
    LIMITS,
    PORTABLE_KINDS,
    PORTABLE_SCHEMA,
    PortableArtifactError,
    admitPortableArtifact,
    approvedArtworkUrl,
    canonicalPortableBytes,
    createPortableControlPlane,
    createPortableSnapshot,
    portableArtifactToSnapshot,
    serializePortableArtifact,
    validatePortableArtifact,
    validateSettings
};
