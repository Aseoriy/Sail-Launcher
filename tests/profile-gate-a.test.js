'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const fsExtra = require('fs-extra');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
    LOCAL_BACKUP_SCHEMA,
    PROFILE_SCHEMA_VERSION,
    ProfileStore,
    ProfileStoreError,
    directoryManifest
} = require('../accounts/profileStore');
const { PORTABLE_SCHEMA, serializePortableArtifact } = require('../sync/portableArtifactV3');

function makeFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-gate-a-profile-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const local = path.join(root, 'local');
    fs.mkdirSync(local);
    const executablePath = path.join(local, 'game.exe');
    const preLaunchScript = path.join(local, 'before.ps1');
    const postLaunchScript = path.join(local, 'after.cmd');
    const companionPath = path.join(local, 'companion.exe');
    const savePath = path.join(local, 'save');
    const configPath = path.join(local, 'settings.ini');
    const achievementPath = path.join(local, 'achievements.json');
    fs.writeFileSync(executablePath, 'exe');
    fs.writeFileSync(preLaunchScript, 'script');
    fs.writeFileSync(postLaunchScript, 'script');
    fs.writeFileSync(companionPath, 'exe');
    fs.mkdirSync(savePath);
    fs.writeFileSync(configPath, 'setting=true');
    fs.writeFileSync(achievementPath, '{"achievements":{}}');
    return { root, local, executablePath, preLaunchScript, postLaunchScript, companionPath, savePath, configPath, achievementPath };
}

function legacySnapshot(f) {
    return {
        schemaVersion: 2,
        myGames: [{
            id: 'game-local',
            name: 'Local Game',
            exePath: f.executablePath,
            launchArgs: '--profile "Local User"',
            preLaunchScript: f.preLaunchScript,
            postLaunchScript: f.postLaunchScript,
            companionApp: f.companionPath,
            runAsAdmin: true,
            localSave: f.savePath,
            saveScanPending: true,
            achievementSources: [{ id: 'achievement-main', kind: 'file', path: f.achievementPath, enabled: true }],
            customBannerPath: path.join(f.local, 'cover.png'),
            playtime: 15,
            configSyncEntries: [{
                id: 'config-main', name: 'Settings', kind: 'file', enabled: true,
                beforeLaunch: true, afterExit: true, intervalMinutes: 0,
                localPath: f.configPath
            }]
        }],
        customSections: [{ id: 'favorites', name: 'Favorites', icon: 'star', customIcon: 'data:image/png;base64,fixture' }],
        globalSettings: {
            theme: 'theme-midnight',
            steamApiKey: 'must-not-migrate',
            discordToken: 'must-not-migrate',
            customCloudKeysData: { google: { clientSecret: 'must-not-migrate' } },
            customCloudKeys: true,
            uiEditorEnabled: true,
            dlHistory: [{ id: 'download-1', name: 'Downloaded Game' }],
            sources: [{ name: 'Local source', url: 'https://example.test' }]
        }
    };
}

function writeLegacy(f) {
    fs.writeFileSync(path.join(f.root, 'sail_library.json'), JSON.stringify(legacySnapshot(f), null, 2));
}

function writeLegacyV2Profile(f) {
    const sailProfiles = path.join(f.root, 'SailProfiles');
    const profileId = 'profile-v2';
    const libraryId = 'library-v2';
    const presetId = 'preset-v2';
    fsExtra.ensureDirSync(path.join(sailProfiles, 'profiles', profileId, 'libraries'));
    fsExtra.ensureDirSync(path.join(sailProfiles, 'profiles', profileId, 'presets'));
    const statePath = path.join(sailProfiles, 'state.json');
    const libraryPath = path.join(sailProfiles, 'profiles', profileId, 'libraries', `${libraryId}.json`);
    fsExtra.writeJsonSync(statePath, {
        schemaVersion: 2,
        deviceId: 'device-v2',
        activeProfileId: profileId,
        activeLibraryId: libraryId,
        activePresetId: presetId,
        profiles: [{
            id: profileId, name: 'V2 Profile', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
            pinSalt: null, pinVerifier: null, localAvatarPath: null, conflictMode: 'prompt',
            libraries: [{ id: libraryId, name: 'V2 Library', createdAt: '2026-01-01T00:00:00.000Z' }],
            presets: [{ id: presetId, name: 'V2 Preset', createdAt: '2026-01-01T00:00:00.000Z' }]
        }]
    }, { spaces: 2 });
    fsExtra.writeJsonSync(libraryPath, legacySnapshot(f), { spaces: 2 });
    fsExtra.writeJsonSync(path.join(sailProfiles, 'profiles', profileId, 'presets', `${presetId}.json`), { globalSettings: legacySnapshot(f).globalSettings }, { spaces: 2 });
    return { sailProfiles, statePath, libraryPath };
}

test('legacy local data migrates to V3 metadata and immediately usable main-owned local authority', t => {
    const f = makeFixture(t);
    writeLegacy(f);
    const store = new ProfileStore(f.root);
    const state = store.initialize();
    assert.equal(state.schemaVersion, PROFILE_SCHEMA_VERSION);
    assert.equal(state.migrationReady, true);
    const snapshot = store.loadActiveSnapshot();
    assert.equal(snapshot.myGames[0].name, 'Local Game');
    assert.equal(snapshot.myGames[0].playtime, 15);
    assert.equal(snapshot.myGames[0].exePath, undefined);
    assert.equal(snapshot.myGames[0].localSave, undefined);
    assert.equal(snapshot.myGames[0].launchArgs, undefined);
    assert.equal(snapshot.myGames[0].runAsAdmin, undefined);
    assert.equal(snapshot.myGames[0].saveScanPending, true);
    assert.equal(snapshot.myGames[0].configSyncEntries[0].localPath, undefined);
    assert.equal(snapshot.myGames[0].achievementSources[0].path, undefined);
    assert.equal(snapshot.myGames[0].achievementSources[0].state, 'active');
    assert.equal(snapshot.myGames[0].localSetupStatus, 'active');
    assert.deepEqual(snapshot.myGames[0].authorityReviewComponents, []);
    assert.equal(snapshot.globalSettings.steamApiKey, undefined);
    assert.equal(snapshot.globalSettings.discordToken, undefined);
    assert.equal(snapshot.globalSettings.customCloudKeysData, undefined);
    assert.deepEqual(snapshot.globalSettings.sources, [{ name: 'Local source', url: 'https://example.test' }]);
    assert.equal(snapshot.globalSettings.customCloudKeys, true);
    assert.equal(snapshot.globalSettings.uiEditorEnabled, true);
    assert.deepEqual(snapshot.globalSettings.dlHistory, [{ id: 'download-1', name: 'Downloaded Game' }]);
    assert.equal(snapshot.customSections[0].customIcon, 'data:image/png;base64,fixture');
    assert.deepEqual(store.legacyStorageAlias('game-local'), { stem: 'Local Game' });

    const status = store.authorityStatus('game-local');
    assert.equal(status.execution.state, 'active');
    assert.ok(status.filesystems.some(item => item.label === 'save' && item.state === 'active'));
    assert.ok(status.filesystems.some(item => item.label === 'config-main' && item.state === 'active'));
    assert.ok(status.filesystems.some(item => item.kind === 'achievement-file' && item.state === 'active'));
    const exported = store.exportControlPlane();
    assert.equal(exported.schema, PORTABLE_SCHEMA);
    assert.equal(exported.kind, 'control-plane');
    const serialized = serializePortableArtifact(exported).toLowerCase();
    for (const forbidden of ['exepath', 'localsave', 'launchargs', 'runasadmin', 'localpath', 'achievementsources', 'steamapikey', 'discordtoken', 'clientsecret', 'pinverifier', 'pinsalt']) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }

    const restarted = new ProfileStore(f.root);
    restarted.initialize();
    assert.equal(restarted.authorityStatus('game-local').execution.capabilityId, status.execution.capabilityId);
});

test('downloaded Steam metadata persists while the local executable remains launch authority', t => {
    const f = makeFixture(t);
    const store = new ProfileStore(f.root);
    store.initialize();
    const added = store.registerDownloadedGameProposal({
        gameName: 'Supermarket Chaos',
        executablePath: f.executablePath,
        folderPath: f.local,
        sourceId: 'steamrip',
        steamAppId: '4800590'
    });
    const game = added.snapshot.myGames.find(item => item.id === added.gameId);
    assert.equal(game.platform, 'steam');
    assert.equal(game.steamAppId, '4800590');
    assert.equal(game.sourceIdentifier, '4800590');
    assert.match(game.steamImageUrl, /\/4800590\/header\.jpg$/);
    assert.match(game.steamHeroUrl, /\/4800590\/library_hero\.jpg$/);

    const authority = store.authorityStatus(added.gameId);
    assert.equal(authority.execution.state, 'active');
    const installAuthority = authority.filesystems.find(item => item.kind === 'game-install');
    assert.ok(installAuthority);
    assert.deepEqual(installAuthority.operations, ['install-delete']);
    assert.equal(store.downloadedGameUninstallStatus(added.gameId).available, true);
    const resolved = store.resolveExecutionCapability({
        gameId: added.gameId,
        capabilityId: authority.execution.capabilityId,
        expectedRevision: authority.execution.revision,
        operation: 'launch'
    });
    assert.equal(resolved.details.executablePath, f.executablePath);
    assert.equal(resolved.details.steamAppId, '');

    const restarted = new ProfileStore(f.root);
    restarted.initialize();
    const persisted = restarted.loadActiveSnapshot().myGames.find(item => item.id === added.gameId);
    assert.equal(persisted.platform, 'steam');
    assert.equal(persisted.steamAppId, '4800590');

    const custom = restarted.registerDownloadedGameProposal({
        gameName: 'Unknown Local Game',
        executablePath: f.executablePath,
        sourceId: 'steamrip',
        steamAppId: 'invalid'
    }).snapshot.myGames.find(item => item.name === 'Unknown Local Game');
    assert.equal(custom.platform, 'custom');
    assert.equal(custom.steamAppId, undefined);
});

test('removing a game clears its portable row, device overlay, and local authorities', t => {
    const f = makeFixture(t);
    const store = new ProfileStore(f.root);
    store.initialize();
    const added = store.registerDownloadedGameProposal({
        gameName: 'Disposable Download',
        executablePath: f.executablePath,
        folderPath: f.local,
        sourceId: 'steamrip'
    });
    const result = store.removeGameFromActiveLibrary(added.gameId);
    assert.equal(result.snapshot.myGames.some(game => game.id === added.gameId), false);
    assert.ok(result.revoked.execution >= 1);
    assert.ok(result.revoked.filesystem >= 1);
    assert.throws(() => store.authorityStatus(added.gameId), /not found/i);
    assert.deepEqual(store.readRetainedGames(result.state.activeProfileId, result.state.activeLibraryId).games, {});
});

test('kept Sail data restores playtime, achievements, and sync metadata on reinstall', t => {
    const f = makeFixture(t);
    const store = new ProfileStore(f.root);
    store.initialize();
    const added = store.registerDownloadedGameProposal({
        gameName: 'Supermarket Simulator',
        executablePath: f.executablePath,
        folderPath: f.local,
        sourceId: 'steamrip-supermarket-simulator',
        steamAppId: '2670630'
    });
    const snapshot = added.snapshot;
    const game = snapshot.myGames.find(item => item.id === added.gameId);
    game.playtime = 9876;
    game.lastPlayed = 1710000000000;
    game.playtimeSessionIds = ['session-kept'];
    game.configSyncEntries = [{
        id: 'config-main', name: 'Settings', kind: 'file', enabled: true,
        beforeLaunch: true, afterExit: true, intervalMinutes: 0
    }];
    game.achievementData = {
        schemaVersion: 1, appId: '2670630', updatedAt: 1710000000000,
        lastSteamRefreshAt: null, lastLocalScanAt: 1710000000000,
        items: [{
            id: 'ACH_KEEP', displayName: 'Still Here', description: '', hidden: false,
            icon: null, iconGray: null, unlocked: true, unlockTime: 1710000000000,
            source: 'local'
        }]
    };
    store.captureActiveSnapshot(snapshot);

    const removed = store.removeGameFromActiveLibrary(added.gameId, { keepSailData: true });
    assert.equal(removed.keptSailData, true);
    assert.equal(removed.snapshot.myGames.some(item => item.id === added.gameId), false);
    const retained = store.readRetainedGames(removed.state.activeProfileId, removed.state.activeLibraryId);
    assert.equal(retained.games[added.gameId].game.playtime, 9876);
    assert.equal(retained.games[added.gameId].game.achievementData.items[0].id, 'ACH_KEEP');

    const restarted = new ProfileStore(f.root);
    restarted.initialize();
    const restored = restarted.registerDownloadedGameProposal({
        gameName: 'Supermarket Simulator',
        executablePath: f.executablePath,
        folderPath: f.local,
        sourceId: 'steamrip-supermarket-simulator',
        steamAppId: '2670630'
    });
    const restoredGame = restored.snapshot.myGames.find(item => item.id === restored.gameId);
    assert.equal(restored.gameId, added.gameId);
    assert.equal(restoredGame.playtime, 9876);
    assert.deepEqual(restoredGame.playtimeSessionIds, ['session-kept']);
    assert.equal(restoredGame.achievementData.items[0].id, 'ACH_KEEP');
    assert.equal(restoredGame.configSyncEntries[0].id, 'config-main');
    assert.deepEqual(restarted.readRetainedGames(removed.state.activeProfileId, removed.state.activeLibraryId).games, {});
});

test('local backup round-trips local paths without exporting protected settings', t => {
    const f = makeFixture(t);
    writeLegacy(f);
    const source = new ProfileStore(f.root);
    source.initialize();
    const backup = source.exportActiveLocalBackup();
    const serialized = JSON.stringify(backup);
    assert.equal(backup.schema, LOCAL_BACKUP_SCHEMA);
    assert.equal(backup.authorities.games['game-local'].execution.executablePath, f.executablePath);
    assert.ok(backup.authorities.games['game-local'].filesystems.some(item => item.rootPath === f.savePath));
    assert.equal(serialized.includes('must-not-migrate'), false);
    assert.equal(serialized.includes('steamApiKey'), false);
    assert.equal(serialized.includes('discordToken'), false);

    const targetRoot = path.join(f.root, 'restored-user-data');
    fs.mkdirSync(targetRoot);
    const target = new ProfileStore(targetRoot);
    target.initialize();
    const imported = target.importActiveLocalBackup(backup);
    assert.equal(imported.importKind, 'local-backup');
    assert.equal(imported.rollbackCreated, true);
    assert.equal(imported.authoritySummary.executionRestored, 1);
    assert.ok(imported.authoritySummary.filesystemRestored >= 3);
    assert.equal(imported.snapshot.myGames[0].localSetupStatus, 'active');
    assert.equal(imported.snapshot.myGames[0].localSaveSetupStatus, 'active');
    assert.equal(imported.snapshot.myGames[0].saveScanPending, true);
    assert.equal(imported.snapshot.customSections[0].customIcon, 'data:image/png;base64,fixture');

    const status = target.authorityStatus('game-local');
    const resolved = target.resolveExecutionCapability({
        gameId: 'game-local', capabilityId: status.execution.capabilityId,
        expectedRevision: status.execution.revision, operation: 'launch'
    });
    assert.equal(resolved.details.executablePath, f.executablePath);
    assert.deepEqual(resolved.details.argv, ['--profile', 'Local User']);
    assert.equal(resolved.details.runAsAdmin, true);
    assert.ok(fs.readdirSync(path.join(targetRoot, 'SailProfiles', 'import-backups')).length >= 1);
});

test('historical V3 achievement artwork paths no longer block startup, cloud merge, or profile export', t => {
    const f = makeFixture(t);
    const snapshot = {
        myGames: [{
            id: 'art-game', name: 'Artwork Game', steamAppId: '480',
            achievementData: {
                schemaVersion: 1, appId: '480', updatedAt: 1710000000000,
                lastSteamRefreshAt: null, lastLocalScanAt: 1710000000000,
                items: [{
                    id: 'ACH_ART', displayName: 'Artwork', description: '', hidden: false,
                    icon: null, iconGray: null, unlocked: true, unlockTime: 1710000000000,
                    source: 'local'
                }]
            }
        }],
        customSections: [],
        globalSettings: { theme: 'theme-midnight' }
    };
    const store = new ProfileStore(f.root);
    store.initialize();
    store.captureActiveSnapshot(snapshot);
    const state = store.createLibrary('Second Library', snapshot);
    const profile = state.profiles.find(item => item.id === state.activeProfileId);
    const staleLibrary = profile.libraries.find(item => item.id !== state.activeLibraryId);
    const stalePath = path.join(store.root, 'profiles', profile.id, 'portable', 'libraries', `${staleLibrary.id}.json`);
    const staleDocument = fsExtra.readJsonSync(stalePath);
    staleDocument.library.games[0].achievementData.items[0].iconPath = f.achievementPath;
    staleDocument.library.games[0].achievementData.items[0].iconGrayPath = path.join(f.local, 'locked.png');
    fsExtra.writeJsonSync(stalePath, staleDocument, { spaces: 2 });

    const reopened = new ProfileStore(f.root);
    assert.doesNotThrow(() => reopened.initialize());
    assert.doesNotThrow(() => reopened.captureActiveSnapshot(snapshot));
    assert.equal(reopened.exportActiveLocalBackup().schema, LOCAL_BACKUP_SCHEMA);
    const exported = reopened.exportControlPlane();
    assert.equal(JSON.stringify(exported).includes('iconPath'), false);
    assert.equal(JSON.stringify(exported).includes(f.achievementPath), false);

    const remote = JSON.parse(JSON.stringify(exported));
    remote.libraries[0].games[0].achievementData.items[0].iconPath = 'C:\\RemoteCache\\unlocked.png';
    const merged = reopened.mergeControlPlane(remote);
    assert.equal(merged.diagnostics.droppedFields.some(row => row.key === 'iconPath'), true);
    assert.equal(JSON.stringify(reopened.exportControlPlane()).includes('RemoteCache'), false);
});

test('existing V3 stores recover local-only settings that the first hardening pass dropped', t => {
    const f = makeFixture(t);
    writeLegacy(f);
    const initial = new ProfileStore(f.root);
    const state = initial.initialize();
    const overlayPath = initial.overlayPath(state.activeProfileId, state.activeLibraryId);
    const oldOverlay = fsExtra.readJsonSync(overlayPath);
    delete oldOverlay.legacyRecoveryVersion;
    delete oldOverlay.sections;
    delete oldOverlay.games['game-local'].saveScanPending;
    delete oldOverlay.settings.customCloudKeys;
    delete oldOverlay.settings.uiEditorEnabled;
    delete oldOverlay.settings.dlHistory;
    fsExtra.writeJsonSync(overlayPath, oldOverlay, { spaces: 2 });

    const recovered = new ProfileStore(f.root);
    recovered.initialize();
    const snapshot = recovered.loadActiveSnapshot();
    assert.equal(snapshot.myGames[0].saveScanPending, true);
    assert.equal(snapshot.customSections[0].customIcon, 'data:image/png;base64,fixture');
    assert.equal(snapshot.globalSettings.customCloudKeys, true);
    assert.equal(snapshot.globalSettings.uiEditorEnabled, true);
    assert.deepEqual(snapshot.globalSettings.dlHistory, [{ id: 'download-1', name: 'Downloaded Game' }]);
    assert.equal(fsExtra.readJsonSync(overlayPath).legacyRecoveryVersion, 1);
});

test('legacy local-setting recovery retries after a transient legacy-file read failure', t => {
    const f = makeFixture(t);
    writeLegacy(f);
    const initial = new ProfileStore(f.root);
    const state = initial.initialize();
    const overlayPath = initial.overlayPath(state.activeProfileId, state.activeLibraryId);
    const oldOverlay = fsExtra.readJsonSync(overlayPath);
    delete oldOverlay.legacyRecoveryVersion;
    delete oldOverlay.settings.dlHistory;
    fsExtra.writeJsonSync(overlayPath, oldOverlay, { spaces: 2 });
    fs.writeFileSync(path.join(f.root, 'sail_library.json'), '{not valid json');

    const retrying = new ProfileStore(f.root);
    retrying.initialize();
    assert.equal(fsExtra.readJsonSync(overlayPath).legacyRecoveryVersion, undefined);
    assert.equal(retrying.loadActiveSnapshot().globalSettings.dlHistory, undefined);

    writeLegacy(f);
    retrying.recoverMissingLegacyOverlay();
    assert.deepEqual(retrying.loadActiveSnapshot().globalSettings.dlHistory, [{ id: 'download-1', name: 'Downloaded Game' }]);
    assert.equal(fsExtra.readJsonSync(overlayPath).legacyRecoveryVersion, 1);
});

test('legacy v5.3.3 local backup import restores usable paths and returns secrets only for protected storage', t => {
    const f = makeFixture(t);
    const targetRoot = path.join(f.root, 'legacy-import-user-data');
    fs.mkdirSync(targetRoot);
    const target = new ProfileStore(targetRoot);
    target.initialize();
    const imported = target.importActiveLocalBackup(legacySnapshot(f));
    assert.equal(imported.importKind, 'legacy-local');
    assert.equal(imported.snapshot.myGames[0].localSetupStatus, 'active');
    assert.equal(imported.snapshot.myGames[0].localSaveSetupStatus, 'active');
    assert.equal(imported.protectedSettings.steamApiKey, 'must-not-migrate');
    assert.equal(imported.protectedSettings.discordToken, 'must-not-migrate');
    assert.equal(imported.protectedSettings.customCloudKeysData.google.clientSecret, 'must-not-migrate');
    assert.equal(imported.snapshot.globalSettings.steamApiKey, undefined);
    assert.equal(imported.snapshot.globalSettings.discordToken, undefined);
});

test('portable metadata-only policy omits game configs and preserves active local authority', t => {
    const f = makeFixture(t);
    writeLegacy(f);
    const store = new ProfileStore(f.root);
    store.initialize();
    store.captureActiveSnapshot({
        myGames: [
            { id: 'game-local', name: 'Local Game', configSyncEntries: [{ id: 'config-local', name: 'Local config', kind: 'file', enabled: true, beforeLaunch: true, afterExit: true, intervalMinutes: 0 }] }
        ],
        customSections: [],
        globalSettings: {
            theme: 'theme-midnight',
            portableMetadataOnly: true,
            syncV2: {
                enabled: true, conflictMode: 'prompt', configChangeMode: 'debounced', configIntervalMinutes: 0,
                configOnStartup: true, configBeforeExit: true, saveBeforeLaunch: true, saveAfterExit: true,
                gameConfigBeforeLaunch: true, gameConfigAfterExit: true, sailCloudSingleSaveCopy: false,
                sailCloudExcludedGameSaveKeys: [], destinations: { config: [], library: [], saves: [], gameConfigs: ['google'] }
            }
        }
    });

    const exported = store.exportActivePortable();
    assert.equal(exported.libraries[0].games.every(game => Array.isArray(game.configSyncEntries) && game.configSyncEntries.length === 0), true);
    assert.equal(exported.presets[0].settings.portableMetadataOnly, true);
    assert.equal(exported.presets[0].settings.syncV2.gameConfigBeforeLaunch, false);
    assert.equal(exported.presets[0].settings.syncV2.gameConfigAfterExit, false);
    assert.deepEqual(exported.presets[0].settings.syncV2.destinations.gameConfigs, []);

    exported.libraries[0].games[0].configSyncEntries = [{ id: 'config-attacker', name: 'Should not arrive', kind: 'file', enabled: true, beforeLaunch: true, afterExit: true, intervalMinutes: 0 }];
    exported.libraries[0].games.push({
        ...JSON.parse(JSON.stringify(exported.libraries[0].games[0])),
        id: 'game-new',
        name: 'New Game',
        configSyncEntries: [{ id: 'config-new', name: 'Should not arrive either', kind: 'file', enabled: true, beforeLaunch: true, afterExit: true, intervalMinutes: 0 }]
    });
    store.importActivePortable(exported);

    const snapshot = store.loadActiveSnapshot();
    const local = snapshot.myGames.find(game => game.id === 'game-local');
    const remote = snapshot.myGames.find(game => game.id === 'game-new');
    assert.deepEqual(local.configSyncEntries.map(entry => entry.id), ['config-local']);
    assert.deepEqual(remote.configSyncEntries, []);
    const localAuthority = store.authorityStatus('game-local');
    assert.equal(localAuthority.execution.state, 'active');
    assert.equal(localAuthority.filesystems.some(item => item.state === 'active'), true);
});

test('approve all base review approves only base executables for every pending game in the active profile', t => {
    const f = makeFixture(t);
    writeLegacy(f);
    const store = new ProfileStore(f.root);
    store.initialize();
    const state = store.getState();
    store.captureActiveSnapshot({
        myGames: [
            { id: 'game-local', name: 'Local Game' },
            { id: 'game-second', name: 'Second Game' }
        ],
        customSections: [],
        globalSettings: { theme: 'theme-midnight' }
    });
    store.capabilityStore.createPendingExecution({
        profileId: state.activeProfileId, libraryId: state.activeLibraryId, gameId: 'game-second'
    }, { exePath: f.executablePath, launchArgs: '--safe', runAsAdmin: true }, 'test-fixture');

    const result = store.approveAllPendingExecutionBases(async () => false);
    return result.then(summary => {
        assert.equal(summary.totalCount, 1);
        assert.equal(summary.approvedCount, 1);
        assert.equal(summary.skippedCount, 0);
        const localStatus = store.authorityStatus('game-local');
        assert.equal(localStatus.execution.state, 'active');
        assert.deepEqual(localStatus.execution.reviewComponents, []);
        const secondStatus = store.capabilityStore.status({
            profileId: state.activeProfileId, libraryId: state.activeLibraryId, gameId: 'game-second'
        });
        assert.equal(secondStatus.execution.reviewComponents.includes('base'), false);
        assert.equal(secondStatus.execution.reviewComponents.includes('arguments'), true);
        assert.equal(secondStatus.execution.reviewComponents.includes('elevation'), true);
    });
});

test('existing v5.4 pending records from trusted local discovery are promoted on restart', t => {
    const f = makeFixture(t);
    const store = new ProfileStore(f.root);
    store.initialize();
    store.captureActiveSnapshot({
        myGames: [{ id: 'game-recovery', name: 'Recovered Game' }],
        customSections: [],
        globalSettings: { theme: 'theme-midnight' }
    });
    const state = store.getState();
    store.capabilityStore.createPendingExecution({
        profileId: state.activeProfileId,
        libraryId: state.activeLibraryId,
        gameId: 'game-recovery'
    }, { exePath: f.executablePath, launchArgs: '--recovered' }, 'steam-import');
    assert.equal(store.authorityStatus('game-recovery').execution.state, 'pending-review');

    const restarted = new ProfileStore(f.root);
    restarted.initialize();
    const recovered = restarted.authorityStatus('game-recovery');
    assert.equal(recovered.execution.state, 'active');
    assert.deepEqual(recovered.execution.reviewComponents, []);
});

test('remote conflicts update metadata but cannot replace or activate local authority', t => {
    const f = makeFixture(t);
    writeLegacy(f);
    const store = new ProfileStore(f.root);
    store.initialize();
    const state = store.getState();
    const before = store.authorityStatus('game-local');
    const remote = {
        profiles: [{
            id: state.activeProfileId,
            name: 'Remote Name',
            conflict_mode: 'newest',
            created_at: '2026-08-20T00:00:00.000Z',
            updated_at: '2099-01-01T00:00:00.000Z',
            pin_salt: 'remote-secret', pin_verifier: 'remote-secret'
        }],
        libraries: [{
            id: state.activeLibraryId,
            profile_id: state.activeProfileId,
            name: 'Remote Library',
            updated_at: '2099-01-01T00:00:00.000Z',
            catalog: { games: [{
                id: 'game-local', name: 'Remote Metadata', playtime: 30,
                exePath: 'C:\\Remote\\evil.exe', launchArgs: '--remote', runAsAdmin: true,
                localSave: 'C:\\Remote\\save', configSyncEntries: []
            }, {
                id: 'game-remote', name: 'Remote Only', exePath: 'C:\\Remote\\only.exe',
                launchArgs: '--remote', runAsAdmin: true, configSyncEntries: []
            }], sections: [] }
        }],
        presets: [{
            id: state.activePresetId,
            profile_id: state.activeProfileId,
            name: 'Remote Preset',
            updated_at: '2099-01-01T00:00:00.000Z',
            settings: { theme: 'theme-midnight', discordToken: 'remote-secret' }
        }]
    };
    const result = store.mergeControlPlane(remote);
    const local = result.snapshot.myGames.find(game => game.id === 'game-local');
    const remoteOnly = result.snapshot.myGames.find(game => game.id === 'game-remote');
    assert.equal(local.name, 'Remote Metadata');
    assert.equal(local.playtime, 30);
    assert.equal(local.exePath, undefined);
    assert.equal(remoteOnly.localSetupStatus, 'local-setup-required');
    const after = store.authorityStatus('game-local');
    assert.equal(after.execution.capabilityId, before.execution.capabilityId);
    assert.equal(after.execution.revision, before.execution.revision);
    assert.equal(after.execution.state, 'active');
    assert.deepEqual(store.legacyStorageAlias('game-local'), { stem: 'Local Game' });
    assert.ok(result.diagnostics.authorityWarningGameIds.includes('game-local'));
    assert.ok(result.diagnostics.authorityWarningGameIds.includes('game-remote'));
    assert.equal(store.getState().profiles[0].locked, false);
});

test('failed V2 migration restores the exact source manifest and blocks profile open', t => {
    const f = makeFixture(t);
    const { sailProfiles } = writeLegacyV2Profile(f);
    const before = directoryManifest(sailProfiles);
    const store = new ProfileStore(f.root, {
        faultInjector(phase) {
            if (phase === 'verified') throw new Error('fixture fault after verification');
        }
    });
    assert.throws(() => store.initialize(), error => {
        assert.ok(error instanceof ProfileStoreError);
        assert.equal(error.code, 'SAIL_PROFILE_MIGRATION_ROLLED_BACK');
        return true;
    });
    assert.deepEqual(directoryManifest(sailProfiles), before);
    assert.equal(fsExtra.readJsonSync(path.join(sailProfiles, 'state.json')).schemaVersion, 2);
    const journal = fsExtra.readJsonSync(path.join(f.root, 'SailGateAMigration', 'journal.json'));
    assert.equal(journal.status, 'rolled-back');
});

test('prepared migration recovery preserves the untouched V2 profile before any backup move', t => {
    const f = makeFixture(t);
    const fixture = writeLegacyV2Profile(f);
    const stateBefore = fs.readFileSync(fixture.statePath);
    const libraryBefore = fs.readFileSync(fixture.libraryPath);
    const interrupted = new ProfileStore(f.root, {
        faultInjector(stage) {
            if (stage === 'prepared') throw new Error('simulated process interruption');
        }
    });
    assert.throws(() => interrupted.initialize(), /simulated process interruption/);
    assert.deepEqual(fs.readFileSync(fixture.statePath), stateBefore);
    assert.deepEqual(fs.readFileSync(fixture.libraryPath), libraryBefore);

    const recovery = new ProfileStore(f.root);
    assert.throws(() => recovery.initialize(), error => error.code === 'SAIL_PROFILE_MIGRATION_ROLLED_BACK');
    assert.deepEqual(fs.readFileSync(fixture.statePath), stateBefore);
    assert.deepEqual(fs.readFileSync(fixture.libraryPath), libraryBefore);
});

test('invalid migration journals fail closed without changing the profile root', t => {
    const f = makeFixture(t);
    const fixture = writeLegacyV2Profile(f);
    const stateBefore = fs.readFileSync(fixture.statePath);
    const libraryBefore = fs.readFileSync(fixture.libraryPath);
    const migrationRoot = path.join(f.root, 'SailGateAMigration');
    fs.mkdirSync(migrationRoot, { recursive: true });
    fs.writeFileSync(path.join(migrationRoot, 'journal.json'), JSON.stringify({
        schemaVersion: 999,
        status: 'prepared',
        backupRoot: path.join(f.root, 'not-a-backup')
    }));

    const store = new ProfileStore(f.root);
    assert.throws(() => store.initialize(), error => error.code === 'SAIL_PROFILE_MIGRATION_BLOCKED');
    assert.deepEqual(fs.readFileSync(fixture.statePath), stateBefore);
    assert.deepEqual(fs.readFileSync(fixture.libraryPath), libraryBefore);
});

test('malformed V3 profile state fails closed instead of creating or merging replacement data', t => {
    const f = makeFixture(t);
    fs.mkdirSync(path.join(f.root, 'SailProfiles'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'SailProfiles', 'state.json'), JSON.stringify({
        schemaVersion: 3,
        deviceId: 'device',
        activeProfileId: 'profile',
        activeLibraryId: 'library',
        activePresetId: 'preset',
        profiles: [],
        unexpected: true
    }));
    const store = new ProfileStore(f.root);
    assert.throws(() => store.initialize(), error => {
        assert.equal(error.code, 'SAIL_PROFILE_OPEN_FAILED');
        return true;
    });
    assert.equal(store.getState(), null);
});
