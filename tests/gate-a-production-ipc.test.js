'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { registerAccountIpc } = require('../accounts/ipc');
const { registerAchievementIpc } = require('../achievements/ipc');

function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-gate-a-ipc-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const local = path.join(root, 'local');
    fs.mkdirSync(local);
    const paths = {
        executable: path.join(local, 'game.exe'),
        pre: path.join(local, 'before.ps1'),
        post: path.join(local, 'after.cmd'),
        companion: path.join(local, 'companion.exe'),
        save: path.join(local, 'save')
    };
    for (const name of ['executable', 'pre', 'post', 'companion']) fs.writeFileSync(paths[name], name);
    fs.mkdirSync(paths.save);

    const handlers = new Map();
    const openQueue = [];
    const saveQueue = [];
    const messageQueue = [];
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
    const dialog = {
        showOpenDialog: async () => openQueue.shift() || { canceled: true, filePaths: [] },
        showSaveDialog: async () => saveQueue.shift() || { canceled: true },
        showMessageBox: async () => ({ response: messageQueue.shift() ?? 1 })
    };
    const services = registerAccountIpc({
        app: { getPath: name => name === 'userData' ? root : root },
        ipcMain,
        safeStorage: options.safeStorage || {
            isEncryptionAvailable: () => false,
            encryptString: value => Buffer.from(value),
            decryptString: value => Buffer.from(value).toString('utf8')
        },
        authorizeIpcEvent: () => true,
        dialog,
        validateSteamAppId: async () => false
    });
    const invoke = async (channel, payload) => handlers.get(channel)({ sender: {} }, payload);
    return { root, paths, handlers, openQueue, saveQueue, messageQueue, services, invoke };
}

async function bootstrapGame(f) {
    const bootstrapped = await f.invoke('profiles-bootstrap');
    assert.equal(bootstrapped.success, true);
    const captured = await f.invoke('profiles-capture-active', {
        myGames: [{
            id: 'game-ipc',
            name: 'IPC Fixture',
            configSyncEntries: [{
                id: 'config-main', name: 'Settings', kind: 'file', enabled: true,
                beforeLaunch: false, afterExit: true, intervalMinutes: 0
            }]
        }],
        customSections: [],
        globalSettings: { theme: 'theme-midnight' }
    });
    assert.equal(captured.success, true);
}

test('portable profile IPC initializes the local store before import, export, and merge', async t => {
    const f = fixture(t);
    const portablePath = path.join(f.root, 'portable.json');
    f.saveQueue.push({ canceled: false, filePath: portablePath });

    const exported = await f.invoke('profiles-export-portable-file');
    assert.equal(exported.success, true);
    assert.equal(exported.data.canceled, false);
    assert.equal(JSON.parse(fs.readFileSync(portablePath, 'utf8')).schema, 'sail.portable/v3');

    f.openQueue.push({ canceled: false, filePaths: [portablePath] });
    const imported = await f.invoke('profiles-import-portable-file');
    assert.equal(imported.success, true);
    assert.equal(imported.data.canceled, false);
    assert.equal(imported.data.snapshot.myGames.length, 0);

    const merged = await f.invoke('profiles-merge-control-plane', f.services.profileStore.exportControlPlane());
    assert.equal(merged.success, true);
    assert.equal(merged.data.state.migrationReady, true);
});

test('local backup IPC round-trips usable paths while protected settings stay in the local vault', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    f.services.profileStore.createExecutionCapability('game-ipc', {
        executablePath: f.paths.executable,
        argv: ['--local'],
        workingDirectory: path.dirname(f.paths.executable),
        preLaunchScript: '', postLaunchScript: '', companionPath: '',
        runAsAdmin: false, highPriority: false, playDetectionPath: '', steamAppId: ''
    });
    f.services.profileStore.createFilesystemCapability('game-ipc', 'save', f.paths.save);
    const captured = await f.invoke('profiles-capture-active', {
        myGames: [{ id: 'game-ipc', name: 'IPC Fixture', saveScanPending: true, configSyncEntries: [] }],
        customSections: [{ id: 'local', name: 'Local', icon: 'folder', customIcon: 'data:image/png;base64,fixture' }],
        globalSettings: {
            theme: 'theme-midnight', steamApiKey: 'PRIVATE_CANARY',
            customCloudKeys: true, dlHistory: [{ id: 'download-1', name: 'Fixture' }]
        }
    });
    assert.equal(captured.success, true);

    const backupPath = path.join(f.root, 'launcher-backup.json');
    f.saveQueue.push({ canceled: false, filePath: backupPath });
    const exported = await f.invoke('profiles-export-local-backup-file');
    assert.equal(exported.success, true);
    const backupText = fs.readFileSync(backupPath, 'utf8');
    const backup = JSON.parse(backupText);
    assert.equal(backup.schema, 'sail.local-backup/v1');
    assert.equal(backup.authorities.games['game-ipc'].execution.executablePath, f.paths.executable);
    assert.ok(backup.authorities.games['game-ipc'].filesystems.some(item => item.rootPath === f.paths.save));
    assert.equal(backupText.includes('PRIVATE_CANARY'), false);
    assert.equal(backupText.includes('steamApiKey'), false);

    await f.invoke('profiles-capture-active', {
        myGames: [], customSections: [], globalSettings: { theme: 'theme-midnight' }
    });
    f.openQueue.push({ canceled: false, filePaths: [backupPath] });
    const imported = await f.invoke('profiles-import-local-backup-file');
    assert.equal(imported.success, true);
    assert.equal(imported.data.snapshot.myGames[0].localSetupStatus, 'active');
    assert.equal(imported.data.snapshot.myGames[0].localSaveSetupStatus, 'active');
    assert.equal(imported.data.snapshot.myGames[0].saveScanPending, true);
    assert.equal(imported.data.snapshot.customSections[0].customIcon, 'data:image/png;base64,fixture');
    assert.equal(imported.data.snapshot.globalSettings.steamApiKey, 'PRIVATE_CANARY');
    assert.deepEqual(imported.data.snapshot.globalSettings.dlHistory, [{ id: 'download-1', name: 'Fixture' }]);
});

test('protected local settings reload when Windows encryption becomes available after startup', async t => {
    let encryptionReady = false;
    const f = fixture(t, {
        safeStorage: {
            isEncryptionAvailable: () => encryptionReady,
            encryptString: value => Buffer.from(value),
            decryptString: value => Buffer.from(value).toString('utf8')
        }
    });
    const protectedPayload = JSON.stringify({
        schemaVersion: 1,
        settings: { steamApiKey: 'STARTUP_SECRET' }
    });
    fs.writeFileSync(path.join(f.root, 'sail_local_settings.json'), JSON.stringify({
        'settings-v1': Buffer.from(protectedPayload).toString('base64')
    }));

    const unavailable = await f.invoke('profiles-bootstrap');
    assert.equal(unavailable.success, true);
    assert.equal(unavailable.data.snapshot.globalSettings.steamApiKey, undefined);
    await f.invoke('profiles-capture-active', {
        myGames: [], customSections: [], globalSettings: { theme: 'theme-midnight' }
    });

    encryptionReady = true;
    const restored = await f.invoke('profiles-load-active');
    assert.equal(restored.success, true);
    assert.equal(restored.data.snapshot.globalSettings.steamApiKey, 'STARTUP_SECRET');
    const updated = await f.invoke('profiles-capture-active', {
        myGames: [], customSections: [],
        globalSettings: { theme: 'theme-midnight', discordToken: 'NEW_SECRET' }
    });
    assert.equal(updated.data.snapshot.globalSettings.steamApiKey, 'STARTUP_SECRET');
    assert.equal(updated.data.snapshot.globalSettings.discordToken, 'NEW_SECRET');
});

test('production picker handler mints execution and filesystem authority without exposing local paths', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    for (const selected of [f.paths.executable, f.paths.pre, f.paths.post, f.paths.companion]) {
        f.openQueue.push({ canceled: false, filePaths: [selected] });
    }
    f.messageQueue.push(0, 0);
    const created = await f.invoke('authority-configure-execution', {
        gameId: 'game-ipc',
        argumentProposal: '--profile "Local User"',
        requestPreLaunchScript: true,
        requestPostLaunchScript: true,
        requestCompanion: true,
        requestElevation: true,
        requestHighPriority: false,
        requestTrackingExecutable: false,
        requestRom: false,
        useSteamInstallation: false
    });
    assert.equal(created.success, true);
    assert.match(created.data.capabilityId, /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.stringify(created.data).includes(f.root), false);
    const resolved = f.services.profileStore.resolveExecutionCapability({
        gameId: 'game-ipc',
        capabilityId: created.data.capabilityId,
        expectedRevision: created.data.revision,
        operation: 'launch'
    });
    assert.equal(resolved.details.executablePath, f.paths.executable);
    assert.deepEqual(resolved.details.argv, ['--profile', 'Local User']);
    assert.equal(resolved.details.preLaunchScript, f.paths.pre);
    assert.equal(resolved.details.postLaunchScript, f.paths.post);
    assert.equal(resolved.details.companionPath, f.paths.companion);
    assert.equal(resolved.details.runAsAdmin, true);

    const injected = await f.invoke('authority-configure-execution', {
        gameId: 'game-ipc',
        executablePath: path.join(f.root, 'attacker.exe')
    });
    assert.equal(injected.success, false);
    assert.equal(injected.code, 'SAIL_GATE_A_INVALID_PAYLOAD');

    f.openQueue.push({ canceled: false, filePaths: [f.paths.save] });
    const filesystem = await f.invoke('authority-configure-filesystem', {
        gameId: 'game-ipc', kind: 'save', entryId: '', pathKind: 'folder'
    });
    assert.equal(filesystem.success, true);
    assert.equal(JSON.stringify(filesystem.data).includes(f.paths.save), false);
    const save = f.services.profileStore.resolveFilesystemCapability({
        gameId: 'game-ipc', capabilityId: filesystem.data.capabilityId,
        expectedRevision: filesystem.data.revision, operation: 'save-read'
    });
    assert.equal(save.details.rootPath, f.paths.save);
});

test('production execution review exposes approve all for base authority only', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    const state = f.services.profileStore.getState();
    const pending = f.services.profileStore.capabilityStore.createPendingExecution({
        profileId: state.activeProfileId,
        libraryId: state.activeLibraryId,
        gameId: 'game-ipc'
    }, { exePath: f.paths.executable, launchArgs: '--safe', runAsAdmin: true }, 'test-fixture');

    f.messageQueue.push(1);
    const reviewed = await f.invoke('authority-review-execution', {
        gameId: 'game-ipc', capabilityId: pending.capabilityId,
        expectedRevision: pending.revision, component: 'base'
    });
    assert.equal(reviewed.success, true);
    assert.equal(reviewed.data.bulk, true);
    assert.equal(reviewed.data.totalCount, 1);
    assert.equal(reviewed.data.approvedCount, 1);
    const status = f.services.profileStore.authorityStatus('game-ipc');
    assert.equal(status.execution.reviewComponents.includes('base'), false);
    assert.equal(status.execution.reviewComponents.includes('arguments'), true);
    assert.equal(status.execution.reviewComponents.includes('elevation'), true);
});

test('renderer treats active local setup as ready and uses normal local-choice copy', () => {
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.doesNotMatch(renderer, /localSetupStatus\s*===\s*'ready'/);
    assert.doesNotMatch(renderer, /Review required on first use|Approved locally|native review|approve locally during Save/i);
    assert.match(renderer, /Local launch setup is ready/);
    assert.match(renderer, /Configured on this PC/);
});

test('production Sail Cloud upload and download handlers accept only scoped one-use transfer capabilities', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    const uploadPath = path.join(f.root, 'upload.zip');
    fs.writeFileSync(uploadPath, 'portable upload');
    const uploadCapability = f.services.profileStore.createTransferCapability('game-ipc', uploadPath, 'transfer-read');
    const uploads = [];
    f.services.accountService.uploadCloudFile = async payload => {
        uploads.push(payload);
        return { artifact_id: 'artifact-1', revision: 1 };
    };
    const uploaded = await f.invoke('account-cloud-upload-file', {
        capabilityId: uploadCapability.capabilityId,
        expectedRevision: uploadCapability.revision,
        gameId: 'game-ipc',
        configEntryId: '',
        artifactType: 'game-save',
        logicalKey: 'game-save:game-ipc',
        expectedRemoteRevision: 0,
        maxVersions: 3,
        contentType: 'application/zip'
    });
    assert.equal(uploaded.success, true);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].filePath, uploadPath);
    assert.equal(uploads[0].artifactType, 'game-save');
    assert.equal(uploads[0].controlPlane.kind, 'control-plane');
    assert.equal(fs.existsSync(uploadPath), false);
    const replayedUpload = await f.invoke('account-cloud-upload-file', {
        capabilityId: uploadCapability.capabilityId,
        expectedRevision: uploadCapability.revision,
        gameId: 'game-ipc', configEntryId: '', artifactType: 'game-save',
        logicalKey: 'game-save:game-ipc', expectedRemoteRevision: 0,
        maxVersions: 3, contentType: 'application/zip'
    });
    assert.equal(replayedUpload.success, false);
    assert.equal(uploads.length, 1);
    const rawUpload = await f.invoke('account-cloud-upload-file', {
        capabilityId: '00000000-0000-4000-8000-000000000000', expectedRevision: 1,
        gameId: 'game-ipc', configEntryId: '', artifactType: 'game-save',
        logicalKey: 'game-save:game-ipc', expectedRemoteRevision: 0,
        maxVersions: 3, contentType: 'application/zip', filePath: path.join(f.root, 'raw.zip')
    });
    assert.equal(rawUpload.success, false);
    assert.equal(rawUpload.code, 'SAIL_GATE_A_INVALID_PAYLOAD');

    const downloadPath = path.join(f.root, 'download.zip');
    const downloadCapability = f.services.profileStore.createTransferCapability('game-ipc', downloadPath, 'transfer-write');
    const downloads = [];
    f.services.accountService.downloadCloudFile = async payload => {
        downloads.push(payload);
        fs.writeFileSync(payload.destinationPath, 'cloud bytes');
        return { revision: 4 };
    };
    const downloaded = await f.invoke('account-cloud-download-file', {
        capabilityId: downloadCapability.capabilityId,
        expectedRevision: downloadCapability.revision,
        gameId: 'game-ipc',
        artifactId: 'artifact-1',
        logicalKey: 'game-save:game-ipc',
        revision: 4
    });
    assert.equal(downloaded.success, true);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].destinationPath, downloadPath);
    assert.equal(downloads[0].expectedArtifactType, 'game-save');
    assert.equal(JSON.stringify(downloaded.data).includes(downloadPath), false);
    const readable = f.services.profileStore.resolveTransferCapability({
        gameId: 'game-ipc',
        capabilityId: downloaded.data.transfer.capabilityId,
        expectedRevision: downloaded.data.transfer.revision,
        operation: 'transfer-read'
    });
    assert.equal(fs.readFileSync(readable.details.targetPath, 'utf8'), 'cloud bytes');
    const rawDownload = await f.invoke('account-cloud-download-file', {
        capabilityId: downloadCapability.capabilityId,
        expectedRevision: downloadCapability.revision,
        gameId: 'game-ipc', artifactId: 'artifact-1',
        logicalKey: 'game-save:game-ipc', revision: 4,
        destinationPath: path.join(f.root, 'raw-download.zip')
    });
    assert.equal(rawDownload.success, false);
    assert.equal(rawDownload.code, 'SAIL_GATE_A_INVALID_PAYLOAD');
});

test('production manual import admits legacy data through V3 and cannot replace local authority', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    const active = f.services.profileStore.createExecutionCapability('game-ipc', {
        executablePath: f.paths.executable,
        argv: [],
        workingDirectory: path.dirname(f.paths.executable),
        preLaunchScript: '', postLaunchScript: '', companionPath: '',
        runAsAdmin: false, highPriority: false, playDetectionPath: '', steamAppId: ''
    });
    const importPath = path.join(f.root, 'legacy-import.json');
    fs.writeFileSync(importPath, JSON.stringify({
        schemaVersion: 2,
        myGames: [{
            id: 'game-ipc', name: 'Imported Metadata', exePath: 'C:\\Remote\\replace.exe',
            launchArgs: '/c attacker', runAsAdmin: true, localSave: 'C:\\Remote\\save',
            configSyncEntries: []
        }, {
            id: 'remote-game', name: 'Remote Only', exePath: 'C:\\Remote\\only.exe',
            companionApp: 'C:\\Remote\\companion.exe', configSyncEntries: []
        }],
        customSections: [],
        globalSettings: {
            theme: 'theme-midnight', steamApiKey: 'SECRET_CANARY',
            customCloudKeysData: { google: { clientSecret: 'SECRET_CANARY' } }
        }
    }));
    f.openQueue.push({ canceled: false, filePaths: [importPath] });
    const imported = await f.invoke('profiles-import-portable-file');
    assert.equal(imported.success, true);
    const existing = imported.data.snapshot.myGames.find(game => game.id === 'game-ipc');
    const remoteOnly = imported.data.snapshot.myGames.find(game => game.id === 'remote-game');
    assert.equal(existing.name, 'Imported Metadata');
    assert.equal(existing.exePath, undefined);
    assert.equal(existing.runAsAdmin, undefined);
    assert.equal(remoteOnly.localSetupStatus, 'local-setup-required');
    assert.equal(JSON.stringify(imported.data).includes('SECRET_CANARY'), false);
    const status = f.services.profileStore.authorityStatus('game-ipc');
    assert.equal(status.execution.capabilityId, active.capabilityId);
    assert.equal(status.execution.revision, active.revision);

    f.openQueue.push({ canceled: false, filePaths: [importPath] });
    const localImport = await f.invoke('profiles-import-local-backup-file');
    assert.equal(localImport.success, true);
    assert.equal(localImport.data.importKind, 'legacy-local');
    assert.equal(localImport.data.snapshot.globalSettings.steamApiKey, 'SECRET_CANARY');
    assert.equal(localImport.data.snapshot.globalSettings.customCloudKeysData.google.clientSecret, 'SECRET_CANARY');
    assert.equal(f.services.profileStore.authorityStatus('game-ipc').execution.state, 'active');
});

test('production launch binding resolves scripts, companion, argv, working directory and elevation only from main authority', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = source.indexOf("ipcMain.handle('launch-game'");
    const end = source.indexOf("ipcMain.handle('get-system-specs'", start);
    const binding = source.slice(start, end);
    assert.match(binding, /resolveExecutionCapability\(\{/);
    assert.match(binding, /operation:\s*'launch'/);
    assert.match(binding, /createExecutionPhaseAuthority\(\{/);
    for (const phase of ['pre-script', 'companion', 'launch', 'post-script']) {
        assert.equal(binding.includes(`phaseAuthority.resolve('${phase}')`), true, phase);
    }
    assert.doesNotMatch(binding, /input\.(?:exePath|executablePath|argv|workingDirectory|preLaunchScript|postLaunchScript|companionApp|companionPath|runAsAdmin)/);
    assert.match(binding, /spawn\(launchExePath, launchArgv, \{ cwd: launchWorkingDirectory/);
    assert.match(binding, /runScript\(beforePreLaunch\.preLaunchScript, true\)/);
    assert.match(binding, /beforeCompanion\.companionPath/);
    assert.match(binding, /if \(launchDetails\.runAsAdmin\)/);
});

test('production achievement IPC resolves local sources only through main-owned filesystem capabilities', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    const sourcePath = path.join(f.root, 'achievements.json');
    fs.writeFileSync(sourcePath, JSON.stringify({ achievements: { LOCAL_UNLOCK: { achieved: true } } }));
    const service = registerAchievementIpc({
        app: { getPath: () => f.root, getAppPath: () => f.root },
        ipcMain: { handle: (channel, handler) => f.handlers.set(channel, handler) },
        BrowserWindow: { getAllWindows: () => [] },
        Notification: null,
        dialog: {
            showOpenDialog: async () => f.openQueue.shift() || { canceled: true, filePaths: [] },
            showMessageBox: async () => ({ response: 0 })
        },
        authorizeIpcEvent: () => true,
        profileStore: f.services.profileStore
    });
    t.after(() => service.dispose());
    const state = f.services.profileStore.getState();
    const libraryKey = `${state.activeProfileId}:${state.activeLibraryId}`;

    await assert.rejects(
        () => f.invoke('achievements-pick-source', { gameId: 'game-ipc', kind: 'file', path: sourcePath }),
        error => error && error.code === 'SAIL_GATE_A_INVALID_PAYLOAD'
    );
    f.openQueue.push({ canceled: false, filePaths: [sourcePath] });
    const picked = await f.invoke('achievements-pick-source', { gameId: 'game-ipc', kind: 'file' });
    assert.equal(picked.canceled, false);
    assert.equal(picked.source.kind, 'file');
    assert.equal(JSON.stringify(picked).includes(sourcePath), false);

    await assert.rejects(
        () => f.invoke('achievements-set-library', {
            games: [{ id: 'game-ipc', exePath: path.join(f.root, 'attacker.exe') }],
            libraryKey, notificationsEnabled: false, trackingEnabled: true, forceScan: true
        }),
        error => error && error.code === 'SAIL_GATE_A_INVALID_PAYLOAD'
    );
    const scanned = await f.invoke('achievements-set-library', {
        games: [{ id: 'game-ipc' }],
        libraryKey, notificationsEnabled: false, trackingEnabled: true, forceScan: true
    });
    assert.equal(scanned.updates.length, 1);
    assert.equal(scanned.updates[0].data.items[0].id, 'LOCAL_UNLOCK');
    assert.equal(JSON.stringify(scanned).includes(sourcePath), false);
    const currentSource = scanned.localSources['game-ipc'][0];
    assert.equal(currentSource.capabilityId, picked.source.capabilityId);

    fs.renameSync(sourcePath, `${sourcePath}.replaced`);
    fs.writeFileSync(sourcePath, JSON.stringify({ achievements: { REPLACEMENT: { achieved: true } } }));
    const replacedScan = await f.invoke('achievements-set-library', {
            games: [{ id: 'game-ipc' }], libraryKey,
            notificationsEnabled: false, trackingEnabled: true, forceScan: true
        });
    assert.equal(replacedScan.updates.length, 1);
    assert.deepEqual(replacedScan.errors, []);

    await assert.rejects(
        () => f.invoke('achievements-remove-source', {
            gameId: 'game-ipc', capabilityId: picked.source.capabilityId,
            expectedRevision: picked.source.expectedRevision + 1
        }),
        error => error && error.code === 'SAIL_CAPABILITY_STALE_REVISION'
    );
    const removed = await f.invoke('achievements-remove-source', {
        gameId: 'game-ipc', capabilityId: currentSource.capabilityId,
        expectedRevision: currentSource.expectedRevision
    });
    assert.equal(removed.revoked, true);
    assert.equal(await service.scanGame('game-ipc', { force: true }), null);
    await assert.rejects(
        () => f.invoke('achievements-remove-source', {
            gameId: 'game-ipc', capabilityId: currentSource.capabilityId,
            expectedRevision: currentSource.expectedRevision
        }),
        error => error && error.code === 'SAIL_GATE_A_INVALID_PAYLOAD'
    );
});

test('production achievement artwork never exposes a path and is reauthorized after source revocation', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    const sourceRoot = path.join(f.root, 'achievement-artwork');
    const sourcePath = path.join(sourceRoot, 'achievements.json');
    const artworkPath = path.join(sourceRoot, 'winner.png');
    fs.mkdirSync(sourceRoot);
    fs.writeFileSync(artworkPath, Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
    ));
    fs.writeFileSync(sourcePath, JSON.stringify({
        achievements: { ART_UNLOCK: { achieved: true, icon: 'winner.png' } }
    }));
    const service = registerAchievementIpc({
        app: { getPath: () => f.root, getAppPath: () => f.root },
        ipcMain: { handle: (channel, handler) => f.handlers.set(channel, handler) },
        BrowserWindow: { getAllWindows: () => [] },
        Notification: null,
        dialog: {
            showOpenDialog: async () => f.openQueue.shift() || { canceled: true, filePaths: [] },
            showMessageBox: async () => ({ response: 0 })
        },
        authorizeIpcEvent: () => true,
        profileStore: f.services.profileStore
    });
    t.after(() => service.dispose());
    const state = f.services.profileStore.getState();
    const libraryKey = `${state.activeProfileId}:${state.activeLibraryId}`;

    f.openQueue.push({ canceled: false, filePaths: [sourceRoot] });
    const picked = await f.invoke('achievements-pick-source', { gameId: 'game-ipc', kind: 'folder' });
    const scanned = await f.invoke('achievements-set-library', {
        games: [{ id: 'game-ipc' }], libraryKey,
        notificationsEnabled: false, trackingEnabled: true, forceScan: true
    });
    assert.equal(scanned.updates[0].data.items[0].id, 'ART_UNLOCK');
    assert.equal(Object.hasOwn(scanned.updates[0].data.items[0], 'iconPath'), false);
    assert.equal(JSON.stringify(scanned).includes(artworkPath), false);

    const artwork = await f.invoke('achievements-read-artwork', {
        gameId: 'game-ipc', itemId: 'ART_UNLOCK', variant: 'unlocked', libraryKey
    });
    assert.equal(artwork.available, true);
    assert.equal(artwork.mimeType, 'image/png');
    assert.match(artwork.dataUrl, /^data:image\/png;base64,/);
    assert.equal(JSON.stringify(artwork).includes(artworkPath), false);

    const movedRoot = `${sourceRoot}.approved`;
    fs.renameSync(sourceRoot, movedRoot);
    fs.mkdirSync(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, 'winner.png'), Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
    ));
    const replacedArtwork = await f.invoke('achievements-read-artwork', {
        gameId: 'game-ipc', itemId: 'ART_UNLOCK', variant: 'unlocked', libraryKey
    });
    assert.deepEqual(replacedArtwork, { available: false });

    const removed = await f.invoke('achievements-remove-source', {
        gameId: 'game-ipc', capabilityId: picked.source.capabilityId,
        expectedRevision: picked.source.expectedRevision
    });
    assert.equal(removed.revoked, true);
    const staleArtwork = await f.invoke('achievements-read-artwork', {
        gameId: 'game-ipc', itemId: 'ART_UNLOCK', variant: 'unlocked', libraryKey
    });
    assert.deepEqual(staleArtwork, { available: false });
});
