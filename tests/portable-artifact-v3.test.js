'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    LIMITS,
    PORTABLE_SCHEMA,
    PortableArtifactError,
    admitPortableArtifact,
    canonicalPortableBytes,
    createPortableSnapshot,
    portableArtifactToSnapshot,
    serializePortableArtifact,
    validatePortableArtifact
} = require('../sync/portableArtifactV3');

function legacyGame(overrides = {}) {
    return {
        id: 'game-one',
        name: 'Example Game',
        steamAppId: '480',
        tags: ['Co-op'],
        isFavorite: true,
        addedAt: 1710000000000,
        playtime: 42,
        lastPlayed: null,
        playtimeSessionIds: [],
        steamImageUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480/header.jpg',
        configSyncEntries: [{
            id: 'config-main',
            name: 'Main Config',
            kind: 'folder',
            enabled: true,
            beforeLaunch: true,
            afterExit: true,
            intervalMinutes: 0
        }],
        ...overrides
    };
}

function legacySnapshot(overrides = {}) {
    return {
        schemaVersion: 2,
        myGames: [legacyGame()],
        customSections: [{ name: 'Co-op', icon: 'folder' }],
        globalSettings: {
            theme: 'theme-midnight',
            language: 'english',
            compactLayout: true,
            syncV2: {
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
                destinations: { config: ['google'], library: [], saves: ['sailcloud'], gameConfigs: [] }
            }
        },
        ...overrides
    };
}

function context() {
    return {
        exportedAt: '2026-08-21T12:00:00.000Z',
        profileId: 'profile-one',
        libraryId: 'library-one',
        presetId: 'preset-one',
        profileName: 'Default Profile',
        libraryName: 'Main Library',
        presetName: 'Default Settings'
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test('PortableArtifactV3 projection produces the one canonical envelope', () => {
    const { artifact, diagnostics, legacy } = createPortableSnapshot(legacySnapshot(), context());
    assert.equal(legacy, true);
    assert.equal(artifact.schema, PORTABLE_SCHEMA);
    assert.equal(artifact.kind, 'launcher-snapshot');
    assert.deepEqual(Object.keys(artifact), ['schema', 'kind', 'exportedAt', 'profiles', 'libraries', 'presets']);
    assert.equal(artifact.profiles[0].id, 'profile-one');
    assert.equal(artifact.libraries[0].games[0].name, 'Example Game');
    assert.equal(artifact.presets[0].settings.theme, 'theme-midnight');
    assert.equal(diagnostics.sourceSchema, 'local-projection');
    assert.deepEqual(validatePortableArtifact(artifact), artifact);
    assert.deepEqual(portableArtifactToSnapshot(artifact), {
        myGames: artifact.libraries[0].games,
        customSections: artifact.libraries[0].sections,
        globalSettings: artifact.presets[0].settings
    });
});

test('legacy V1 and V2 adapters discard authority and secrets for new and existing games', () => {
    for (const schemaVersion of [undefined, 2]) {
        const source = legacySnapshot({
            ...(schemaVersion === undefined ? {} : { schemaVersion }),
            myGames: [
                legacyGame({
                    id: 'existing',
                    exePath: 'C:\\Games\\existing.exe',
                    installFolder: 'C:\\Games',
                    launchArgs: '--profile pooks',
                    runAsAdmin: true,
                    companionApp: 'C:\\Tools\\companion.exe',
                    preLaunchScript: 'C:\\Scripts\\before.ps1',
                    postLaunchScript: 'C:\\Scripts\\after.cmd',
                    localSave: 'C:\\Saves\\Existing',
                    driveSave: 'D:\\Cloud',
                    configSyncEntries: [{
                        id: 'config-main', name: 'Config', kind: 'folder', enabled: true,
                        beforeLaunch: true, afterExit: true, intervalMinutes: 0,
                        localPath: 'C:\\Users\\Me\\AppData\\Config'
                    }]
                }),
                legacyGame({
                    id: 'new-remote',
                    name: 'Remote Only',
                    exePath: 'cmd.exe',
                    launchArgs: '/c calc',
                    emulatorPath: 'powershell.exe',
                    romPath: 'C:\\payload.rom'
                })
            ],
            globalSettings: {
                theme: 'theme-midnight',
                steamApiKey: 'STEAM_SECRET_CANARY',
                discordToken: 'DISCORD_SECRET_CANARY',
                customCloudKeysData: { dropbox: { clientSecret: 'DROPBOX_SECRET_CANARY' } },
                debrid: { keys: { realdebrid: 'DEBRID_SECRET_CANARY' } },
                customFont: 'C:\\Fonts\\custom.ttf',
                uiAppBg: 'C:\\Pictures\\background.png',
                defaultDriveFolder: 'D:\\Cloud',
                quickPaths: [{ name: 'Games', path: 'C:\\Games' }],
                sources: [{ name: 'Bad', url: 'javascript:alert(1)' }]
            }
        });
        if (schemaVersion === undefined) delete source.schemaVersion;
        const result = admitPortableArtifact(JSON.stringify(source), { context: context() });
        const serialized = serializePortableArtifact(result.artifact);
        for (const canary of [
            'existing.exe', 'pooks', 'companion.exe', 'before.ps1', 'after.cmd',
            'AppData', 'cmd.exe', 'calc', 'powershell.exe', 'payload.rom',
            'STEAM_SECRET_CANARY', 'DISCORD_SECRET_CANARY', 'DROPBOX_SECRET_CANARY',
            'DEBRID_SECRET_CANARY', 'custom.ttf', 'background.png', 'javascript:'
        ]) {
            assert.equal(serialized.includes(canary), false, `${canary} leaked from legacy schema ${schemaVersion || 1}`);
        }
        const games = result.artifact.libraries[0].games;
        assert.deepEqual(games.map(game => game.id), ['existing', 'new-remote']);
        assert.equal(games[0].configSyncEntries[0].localPath, undefined);
        assert.ok(result.diagnostics.droppedFieldCount >= 20);
        assert.deepEqual(new Set(result.diagnostics.authorityWarningGameIds), new Set(['existing', 'new-remote']));
    }
});

test('canonical V3 enforces additionalProperties false at every live nesting level', () => {
    const artifact = createPortableSnapshot(legacySnapshot(), context()).artifact;
    const mutations = [
        value => { value.unexpected = true; },
        value => { value.profiles[0].pin_verifier = 'secret'; },
        value => { value.libraries[0].catalog = {}; },
        value => { value.libraries[0].games[0].exePath = 'cmd.exe'; },
        value => { value.libraries[0].games[0].configSyncEntries[0].localPath = 'C:\\secret'; },
        value => {
            value.libraries[0].games[0].achievementData = {
                schemaVersion: 1,
                appId: '480',
                updatedAt: 0,
                lastSteamRefreshAt: null,
                lastLocalScanAt: null,
                items: [{
                    id: 'ACH', displayName: 'Achievement', description: '', hidden: false,
                    icon: null, iconGray: null, unlocked: false, unlockTime: null,
                    exePath: 'cmd.exe'
                }]
            };
        },
        value => { value.presets[0].settings.sources = [{ name: 'Injected', url: 'https://evil.invalid' }]; },
        value => { value.presets[0].settings.syncV2.destinations.root = ['C:\\']; }
    ];
    for (const mutate of mutations) {
        const hostile = clone(artifact);
        mutate(hostile);
        assert.throws(() => validatePortableArtifact(hostile), error => {
            assert.ok(error instanceof PortableArtifactError);
            assert.equal(error.code, 'SAIL_PORTABLE_UNKNOWN_PROPERTY');
            return true;
        });
    }
});

test('V3 admission removes historical local achievement artwork paths without loosening validation', () => {
    const artifact = createPortableSnapshot(legacySnapshot(), context()).artifact;
    artifact.libraries[0].games[0].achievementData = {
        schemaVersion: 1,
        appId: '480',
        updatedAt: 1710000000000,
        lastSteamRefreshAt: null,
        lastLocalScanAt: 1710000000000,
        items: [{
            id: 'ACH_LOCAL_ART', displayName: 'Local artwork', description: '', hidden: false,
            icon: null, iconGray: null, unlocked: true, unlockTime: 1710000000000,
            source: 'local'
        }]
    };
    const historical = clone(artifact);
    historical.libraries[0].games[0].achievementData.items[0].iconPath = 'C:\\SailCache\\unlocked.png';
    historical.libraries[0].games[0].achievementData.items[0].iconGrayPath = 'C:\\SailCache\\locked.png';

    assert.throws(() => validatePortableArtifact(historical), error => error.code === 'SAIL_PORTABLE_UNKNOWN_PROPERTY');
    const admitted = admitPortableArtifact(historical);
    const item = admitted.artifact.libraries[0].games[0].achievementData.items[0];
    assert.equal(item.iconPath, undefined);
    assert.equal(item.iconGrayPath, undefined);
    assert.equal(admitted.diagnostics.droppedFieldCount, 2);
    assert.deepEqual(admitted.diagnostics.droppedFields.map(row => row.key), ['iconPath', 'iconGrayPath']);
    assert.equal(serializePortableArtifact(admitted.artifact).includes('SailCache'), false);

    const stillHostile = clone(historical);
    stillHostile.libraries[0].games[0].achievementData.items[0].unexpectedPath = 'C:\\payload.exe';
    assert.throws(() => admitPortableArtifact(stillHostile), error => error.code === 'SAIL_PORTABLE_UNKNOWN_PROPERTY');
});

test('prototype keys, controls, excessive depth and future schemas fail closed', () => {
    assert.throws(
        () => admitPortableArtifact('{"schemaVersion":2,"myGames":[{"id":"one","name":"Game","__proto__":{"polluted":true}}]}'),
        error => error.code === 'SAIL_PORTABLE_PROTOTYPE_REJECTED'
    );
    assert.throws(
        () => admitPortableArtifact({ schemaVersion: 2, myGames: [{ id: 'one', name: 'Bad\u0000Name' }] }),
        error => error.code === 'SAIL_PORTABLE_INVALID'
    );
    let deep = { value: true };
    for (let index = 0; index < LIMITS.depth + 2; index++) deep = { nested: deep };
    assert.throws(() => admitPortableArtifact({ schemaVersion: 2, myGames: [], extra: deep }), error => error.code === 'SAIL_PORTABLE_TOO_DEEP');
    assert.throws(() => admitPortableArtifact({ schema: 'sail.portable/v4' }), error => error.code === 'SAIL_PORTABLE_SCHEMA_UNSUPPORTED');
    assert.throws(() => admitPortableArtifact({ schemaVersion: 99 }), error => error.code === 'SAIL_PORTABLE_SCHEMA_UNSUPPORTED');
});

test('canonical bounds and referential integrity are enforced', () => {
    const artifact = createPortableSnapshot(legacySnapshot(), context()).artifact;
    const tooManySections = clone(artifact);
    tooManySections.libraries[0].sections = Array.from({ length: LIMITS.sections + 1 }, (_, index) => ({
        id: `section-${index}`,
        name: `Section ${index}`,
        icon: 'folder'
    }));
    assert.throws(() => validatePortableArtifact(tooManySections), error => error.code === 'SAIL_PORTABLE_TOO_MANY_ITEMS');

    const wrongProfile = clone(artifact);
    wrongProfile.libraries[0].profileId = 'profile-other';
    assert.throws(() => validatePortableArtifact(wrongProfile), /unknown profile/);

    const duplicateGame = clone(artifact);
    duplicateGame.libraries[0].games.push(clone(duplicateGame.libraries[0].games[0]));
    assert.throws(() => validatePortableArtifact(duplicateGame), /Duplicate entries/);
});

test('only approved credential-free Steam artwork URLs survive projection', () => {
    const good = createPortableSnapshot(legacySnapshot(), context()).artifact.libraries[0].games[0];
    assert.match(good.steamImageUrl, /^https:\/\/shared\.akamai\.steamstatic\.com\//);
    for (const image of [
        'javascript:alert(1)',
        'data:image/svg+xml,<svg onload=alert(1)>',
        'file:///C:/secret.png',
        'https://evil.invalid/cover.jpg',
        'https://user:pass@shared.akamai.steamstatic.com/cover.jpg'
    ]) {
        const projected = createPortableSnapshot(legacySnapshot({ myGames: [legacyGame({ steamImageUrl: image })] }), context());
        assert.equal(projected.artifact.libraries[0].games[0].steamImageUrl, undefined);
        assert.ok(projected.diagnostics.droppedFieldCount > 0);
    }
});

test('serialized V3 artifacts never contain secret or local-authority field names', () => {
    const result = createPortableSnapshot(legacySnapshot({
        myGames: [legacyGame({
            exePath: 'C:\\Games\\game.exe',
            localSave: 'C:\\Saves',
            launchArgs: '--unsafe',
            runAsAdmin: true,
            configSyncEntries: [{
                id: 'cfg', name: 'Config', kind: 'file', enabled: true,
                beforeLaunch: true, afterExit: true, intervalMinutes: 0,
                localPath: 'C:\\secret.ini'
            }]
        })],
        globalSettings: {
            theme: 'theme-midnight',
            debrid: { keys: { realdebrid: 'secret' } },
            steamApiKey: 'secret',
            discordToken: 'secret',
            customCloudKeysData: { google: { clientSecret: 'secret' } }
        }
    }), context());
    const parsed = JSON.parse(serializePortableArtifact(result.artifact));
    const keys = [];
    const walk = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) return value.forEach(walk);
        Object.entries(value).forEach(([key, child]) => { keys.push(key.toLowerCase()); walk(child); });
    };
    walk(parsed);
    for (const forbidden of [
        'exepath', 'localsave', 'launchargs', 'runasadmin', 'localpath',
        'debrid', 'steamapikey', 'discordtoken', 'customcloudkeysdata', 'keys'
    ]) {
        assert.equal(keys.includes(forbidden), false, `${forbidden} appeared in V3 output`);
    }
});

test('portable upload bytes translate legacy input and independently read back as clean V3', () => {
    const projected = canonicalPortableBytes(legacySnapshot({
        myGames: [legacyGame({
            exePath: 'C:\\Remote\\game.exe',
            launchArgs: '--remote',
            runAsAdmin: true
        })],
        globalSettings: { theme: 'theme-midnight', discordToken: 'secret-canary' }
    }), {
        context: context(),
        kindHint: 'launcher-snapshot',
        expectedKind: 'launcher-snapshot'
    });
    assert.equal(projected.legacy, true);
    const parsed = JSON.parse(projected.bytes.toString('utf8'));
    assert.equal(parsed.schema, PORTABLE_SCHEMA);
    assert.equal(parsed.kind, 'launcher-snapshot');
    const serialized = projected.bytes.toString('utf8').toLowerCase();
    for (const forbidden of ['exepath', 'launchargs', 'runasadmin', 'discordtoken', 'secret-canary']) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
});
