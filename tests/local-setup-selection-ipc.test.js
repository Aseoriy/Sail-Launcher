'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { registerAccountIpc } = require('../accounts/ipc');

function fixture(t, existingRoot = '') {
    const root = existingRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'sail-local-selection-'));
    if (!existingRoot) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const local = path.join(root, 'local');
    const save = path.join(root, 'save');
    fs.mkdirSync(local, { recursive: true }); fs.mkdirSync(save, { recursive: true });
    const executable = path.join(local, 'game.exe');
    const tracking = path.join(local, 'tracker.exe');
    const preLaunch = path.join(local, 'pre.ps1');
    const postLaunch = path.join(local, 'post.ps1');
    const companion = path.join(local, 'companion.exe');
    if (!existingRoot) {
        fs.writeFileSync(executable, 'game'); fs.writeFileSync(tracking, 'tracker');
        fs.writeFileSync(preLaunch, 'pre'); fs.writeFileSync(postLaunch, 'post'); fs.writeFileSync(companion, 'companion');
    }
    const queue = [];
    let openDialog = async () => queue.shift() || { canceled: true, filePaths: [] };
    const handlers = new Map();
    const services = registerAccountIpc({
        app: { getPath: () => root },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        safeStorage: { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() },
        authorizeIpcEvent: () => true,
        dialog: {
            showOpenDialog: (...args) => openDialog(...args),
            showMessageBox: async () => ({ response: 0 })
        },
        validateSteamAppId: async () => false
    });
    const sender = { id: 7 };
    const invoke = (name, payload, event = { sender }) => handlers.get(name)(event, payload);
    const invokeData = async (name, payload, event) => {
        const result = await invoke(name, payload, event);
        if (!result.success) throw new Error(result.error);
        return result.data;
    };
    return {
        root, save, executable, tracking, preLaunch, postLaunch, companion, queue, services, invoke, invokeData,
        setOpenDialog(handler) { openDialog = handler; }
    };
}

async function bootstrapGame(f) {
    assert.equal((await f.invoke('profiles-bootstrap')).success, true);
    const captured = await f.invoke('profiles-capture-active', {
        myGames: [{ id: 'setup-game', name: 'Setup Game' }], customSections: [], globalSettings: {}
    });
    assert.equal(captured.success, true);
    f.services.profileStore.createExecutionCapability('setup-game', {
        executablePath: f.executable, argv: ['--keep'], workingDirectory: path.dirname(f.executable),
        preLaunchScript: f.preLaunch, postLaunchScript: f.postLaunch, companionPath: f.companion, runAsAdmin: true,
        highPriority: true, playDetectionPath: '', steamAppId: '480'
    });
}

test('selection-only save and tracking Browse flows apply only when configured', async t => {
    const f = fixture(t);
    await bootstrapGame(f);

    f.queue.push({ canceled: false, filePaths: [f.tracking] });
    const tracking = await f.invokeData('authority-select-executable', { purpose: 'tracking', gameId: 'setup-game' });
    assert.equal(tracking.canceled, false);
    assert.equal(tracking.name, 'tracker.exe');
    assert.equal(tracking.label, 'Play detection: tracker.exe');
    const before = f.services.profileStore.authorityStatus('setup-game').execution;
    assert.equal(before.state, 'active');
    const configured = await f.invokeData('authority-configure-tracking', {
        gameId: 'setup-game', selectionId: tracking.selectionId
    });
    const after = f.services.profileStore.authorityStatus('setup-game').execution;
    const details = f.services.profileStore.validateExecutionCapability({
        gameId: 'setup-game', capabilityId: after.capabilityId, expectedRevision: after.revision, operation: 'reveal'
    }).details;
    assert.equal(configured.state, 'active');
    assert.equal(details.executablePath, f.executable);
    assert.deepEqual(details.argv, ['--keep']);
    assert.equal(details.preLaunchScript, f.preLaunch);
    assert.equal(details.postLaunchScript, f.postLaunch);
    assert.equal(details.companionPath, f.companion);
    assert.equal(details.runAsAdmin, true);
    assert.equal(details.highPriority, true);
    assert.equal(details.steamAppId, '480');
    assert.equal(details.playDetectionPath, f.tracking);

    f.queue.push({ canceled: false, filePaths: [f.save] });
    const selectedSave = await f.invokeData('authority-select-filesystem', {
        kind: 'save', pathKind: 'folder', gameId: 'setup-game'
    });
    assert.equal(selectedSave.canceled, false);
    assert.equal(selectedSave.label, 'Save folder: save');
    const saveBefore = f.services.profileStore.authorityStatus('setup-game').filesystems.find(item => item.kind === 'save');
    assert.equal(saveBefore, undefined);
    const save = await f.invokeData('authority-configure-filesystem', {
        gameId: 'setup-game', kind: 'save', entryId: '', pathKind: 'folder', selectionId: selectedSave.selectionId
    });
    assert.equal(save.state, 'active');
    assert.equal(f.services.profileStore.resolveFilesystemCapability({
        gameId: 'setup-game', capabilityId: save.capabilityId, expectedRevision: save.revision, operation: 'save-read'
    }).details.rootPath, f.save);

    const newSave = path.join(f.root, 'new-save');
    fs.mkdirSync(newSave);
    f.queue.push({ canceled: false, filePaths: [newSave] });
    const unbound = await f.invokeData('authority-select-filesystem', { kind: 'save', pathKind: 'folder' });
    const currentSnapshot = f.services.profileStore.loadActiveSnapshot();
    const newGame = await f.invokeData('profiles-capture-active', {
        myGames: [...currentSnapshot.myGames, { id: 'new-game', name: 'New Game' }],
        customSections: currentSnapshot.customSections, globalSettings: currentSnapshot.globalSettings
    });
    assert.equal(newGame.snapshot.myGames.length, 2);
    const newSaveAuthority = await f.invokeData('authority-configure-filesystem', {
        gameId: 'new-game', kind: 'save', entryId: '', pathKind: 'folder', selectionId: unbound.selectionId
    });
    assert.equal(f.services.profileStore.resolveFilesystemCapability({
        gameId: 'new-game', capabilityId: newSaveAuthority.capabilityId,
        expectedRevision: newSaveAuthority.revision, operation: 'save-read'
    }).details.rootPath, newSave);

    f.queue.push({ canceled: false, filePaths: [f.executable] });
    const newBase = await f.invokeData('authority-select-executable', {});
    const baseAuthority = await f.invokeData('authority-configure-execution', {
        gameId: 'new-game', argumentProposal: '', requestPreLaunchScript: false,
        requestPostLaunchScript: false, requestCompanion: false, requestElevation: false,
        requestHighPriority: false, requestTrackingExecutable: false, requestRom: false,
        useSteamInstallation: false, baseSelectionId: newBase.selectionId
    });
    assert.equal(baseAuthority.state, 'active');
    f.queue.push({ canceled: false, filePaths: [f.tracking] });
    const newTracking = await f.invokeData('authority-select-executable', { purpose: 'tracking' });
    assert.equal(newTracking.label, 'Play detection: tracker.exe');
    const newTrackingAuthority = await f.invokeData('authority-configure-tracking', {
        gameId: 'new-game', selectionId: newTracking.selectionId
    });
    assert.equal(newTrackingAuthority.state, 'active');
});

test('typed selections reject cross-use, replay, wrong sender, and cancelled picker without mutation', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    f.queue.push({ canceled: true, filePaths: [] });
    assert.deepEqual(await f.invokeData('authority-select-filesystem', { kind: 'save', pathKind: 'folder', gameId: 'setup-game' }), { canceled: true });

    f.queue.push({ canceled: false, filePaths: [f.tracking] });
    const tracking = await f.invokeData('authority-select-executable', { purpose: 'tracking', gameId: 'setup-game' });
    await assert.rejects(() => f.invokeData('authority-configure-filesystem', {
        gameId: 'setup-game', kind: 'save', entryId: '', pathKind: 'folder', selectionId: tracking.selectionId
    }), /different setup field/i);
    await assert.rejects(() => f.invokeData('authority-configure-tracking', {
        gameId: 'setup-game', selectionId: tracking.selectionId
    }, { sender: { id: 8 } }), /no longer available/i);
    const configured = await f.invokeData('authority-configure-tracking', { gameId: 'setup-game', selectionId: tracking.selectionId });
    assert.equal(configured.state, 'active');
    await assert.rejects(() => f.invokeData('authority-configure-tracking', { gameId: 'setup-game', selectionId: tracking.selectionId }), /no longer available/i);

    f.queue.push({ canceled: false, filePaths: [f.executable] });
    const base = await f.invokeData('authority-select-executable', {});
    await assert.rejects(() => f.invokeData('authority-configure-tracking', {
        gameId: 'setup-game', selectionId: base.selectionId
    }), /different setup field/i);
});

test('pending selections fail closed for wrong game, scope, expiry, and changed identities', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    const current = f.services.profileStore.loadActiveSnapshot();
    await f.invokeData('profiles-capture-active', {
        myGames: [...current.myGames, { id: 'other-game', name: 'Other Game' }],
        customSections: current.customSections, globalSettings: current.globalSettings
    });
    f.services.profileStore.createExecutionCapability('other-game', {
        executablePath: f.executable, argv: [], workingDirectory: path.dirname(f.executable),
        preLaunchScript: '', postLaunchScript: '', companionPath: '', runAsAdmin: false,
        highPriority: false, playDetectionPath: '', steamAppId: ''
    });

    f.queue.push({ canceled: false, filePaths: [f.tracking] });
    const wrongGame = await f.invokeData('authority-select-executable', { purpose: 'tracking', gameId: 'setup-game' });
    await assert.rejects(() => f.invokeData('authority-configure-tracking', {
        gameId: 'other-game', selectionId: wrongGame.selectionId
    }), /different game/i);

    f.queue.push({ canceled: false, filePaths: [f.tracking] });
    const scopeBound = await f.invokeData('authority-select-executable', { purpose: 'tracking', gameId: 'setup-game' });
    const originalLibraryId = f.services.profileStore.getState().activeLibraryId;
    const switched = await f.invokeData('profiles-create-library', { name: 'Other Library', snapshot: current });
    const otherLibraryId = switched.profiles.find(profile => profile.id === switched.activeProfileId).libraries.at(-1).id;
    await f.invokeData('profiles-switch-library', { libraryId: otherLibraryId });
    f.services.profileStore.createExecutionCapability('setup-game', {
        executablePath: f.executable, argv: [], workingDirectory: path.dirname(f.executable),
        preLaunchScript: '', postLaunchScript: '', companionPath: '', runAsAdmin: false,
        highPriority: false, playDetectionPath: '', steamAppId: ''
    });
    await assert.rejects(() => f.invokeData('authority-configure-tracking', {
        gameId: 'setup-game', selectionId: scopeBound.selectionId
    }), /different profile or library/i);
    await f.invokeData('profiles-switch-library', { libraryId: originalLibraryId });

    const rawPath = await f.invoke('authority-select-executable', { purpose: 'tracking', path: f.tracking });
    assert.equal(rawPath.success, false);

    const inactiveSnapshot = f.services.profileStore.loadActiveSnapshot();
    await f.invokeData('profiles-capture-active', {
        myGames: [...inactiveSnapshot.myGames, { id: 'inactive-game', name: 'Inactive Game' }],
        customSections: inactiveSnapshot.customSections, globalSettings: inactiveSnapshot.globalSettings
    });
    f.queue.push({ canceled: false, filePaths: [f.tracking] });
    const inactiveSelection = await f.invokeData('authority-select-executable', { purpose: 'tracking' });
    await assert.rejects(() => f.invokeData('authority-configure-tracking', {
        gameId: 'inactive-game', selectionId: inactiveSelection.selectionId
    }), /active execution authority/i);

    f.queue.push({ canceled: false, filePaths: [f.tracking] });
    const expired = await f.invokeData('authority-select-executable', { purpose: 'tracking', gameId: 'setup-game' });
    const originalNow = Date.now;
    Date.now = () => originalNow() + 30 * 60 * 1000 + 1;
    try {
        await assert.rejects(() => f.invokeData('authority-configure-tracking', {
            gameId: 'setup-game', selectionId: expired.selectionId
        }), /no longer available/i);
    } finally { Date.now = originalNow; }

    f.queue.push({ canceled: false, filePaths: [f.tracking] });
    const changedFile = await f.invokeData('authority-select-executable', { purpose: 'tracking', gameId: 'setup-game' });
    fs.renameSync(f.tracking, `${f.tracking}.moved`);
    fs.writeFileSync(f.tracking, 'replacement');
    await assert.rejects(() => f.invokeData('authority-configure-tracking', {
        gameId: 'setup-game', selectionId: changedFile.selectionId
    }), /changed/i);

    const changedFolder = path.join(f.root, 'save-changed');
    fs.mkdirSync(changedFolder);
    f.queue.push({ canceled: false, filePaths: [changedFolder] });
    const save = await f.invokeData('authority-select-filesystem', { kind: 'save', pathKind: 'folder', gameId: 'setup-game' });
    fs.renameSync(changedFolder, `${changedFolder}.moved`);
    fs.mkdirSync(changedFolder);
    await assert.rejects(() => f.invokeData('authority-configure-filesystem', {
        gameId: 'setup-game', kind: 'save', entryId: '', pathKind: 'folder', selectionId: save.selectionId
    }), /changed/i);
});

test('tracking configuration refuses pending execution authority', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    f.services.profileStore.capabilityStore.createPendingExecution(
        f.services.profileStore.authorityScope('setup-game'),
        { exePath: f.executable, launchArgs: '' },
        'selection-test'
    );
    f.queue.push({ canceled: false, filePaths: [f.tracking] });
    const selection = await f.invokeData('authority-select-executable', { purpose: 'tracking', gameId: 'setup-game' });
    await assert.rejects(() => f.invokeData('authority-configure-tracking', {
        gameId: 'setup-game', selectionId: selection.selectionId
    }), /active execution authority/i);
});

function executionEditPayload(f, authority, overrides = {}) {
    return {
        gameId: 'setup-game', argumentProposal: undefined,
        requestPreLaunchScript: false, requestPostLaunchScript: false,
        requestCompanion: false, requestElevation: undefined, requestHighPriority: undefined,
        requestTrackingExecutable: false, requestRom: false, useSteamInstallation: false,
        capabilityId: authority.capabilityId, expectedRevision: authority.revision,
        ...overrides
    };
}

test('execution settings read/write preserves quoting and reloads from the persisted authority store', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    const before = await f.invokeData('authority-get-execution-settings', { gameId: 'setup-game' });
    assert.deepEqual(before, {
        state: 'active', capabilityId: before.capabilityId, revision: before.revision,
        argumentProposal: '--keep', runAsAdmin: true, highPriority: true,
        companionName: 'companion.exe', preLaunchName: 'pre.ps1', postLaunchName: 'post.ps1'
    });

    const argumentProposal = '--name "two words" "C:\\Program Files\\Game\\bin"';
    const updated = await f.invokeData('authority-configure-execution', executionEditPayload(f, before, {
        argumentProposal, requestElevation: false, requestHighPriority: true
    }));
    assert.equal(updated.state, 'active');
    const details = f.services.profileStore.validateExecutionCapability({
        gameId: 'setup-game', capabilityId: updated.capabilityId, expectedRevision: updated.revision, operation: 'reveal'
    }).details;
    assert.deepEqual(details.argv, ['--name', 'two words', 'C:\\Program Files\\Game\\bin']);
    assert.equal(details.executablePath, f.executable);
    assert.equal(details.workingDirectory, path.dirname(f.executable));
    assert.equal(details.preLaunchScript, f.preLaunch);
    assert.equal(details.postLaunchScript, f.postLaunch);
    assert.equal(details.companionPath, f.companion);
    assert.equal(details.runAsAdmin, false);
    assert.equal(details.highPriority, true);

    const reloaded = fixture(t, f.root);
    await reloaded.invokeData('profiles-bootstrap');
    const afterReload = await reloaded.invokeData('authority-get-execution-settings', { gameId: 'setup-game' });
    assert.equal(afterReload.state, 'active');
    assert.equal(afterReload.argumentProposal, argumentProposal);
    assert.equal(afterReload.runAsAdmin, false);
    assert.equal(afterReload.highPriority, true);
    assert.equal(afterReload.companionName, 'companion.exe');
    assert.equal(afterReload.preLaunchName, 'pre.ps1');
    assert.equal(afterReload.postLaunchName, 'post.ps1');
});

test('execution edits cancel without replacing requested scripts or companions', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    const initial = f.services.profileStore.authorityStatus('setup-game').execution;
    for (const request of ['requestPreLaunchScript', 'requestCompanion']) {
        f.queue.push({ canceled: true, filePaths: [] });
        const result = await f.invokeData('authority-configure-execution', executionEditPayload(f, initial, {
            [request]: true
        }));
        assert.deepEqual(result, { canceled: true });
        const current = f.services.profileStore.authorityStatus('setup-game').execution;
        assert.equal(current.capabilityId, initial.capabilityId);
        assert.equal(current.revision, initial.revision);
        const details = f.services.profileStore.validateExecutionCapability({
            gameId: 'setup-game', capabilityId: current.capabilityId, expectedRevision: current.revision, operation: 'reveal'
        }).details;
        assert.equal(details.preLaunchScript, f.preLaunch);
        assert.equal(details.companionPath, f.companion);
    }
});

test('execution edits reject stale and cross-library capability references', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    const initial = f.services.profileStore.authorityStatus('setup-game').execution;
    const updated = await f.invokeData('authority-configure-execution', executionEditPayload(f, initial, {
        argumentProposal: '--new'
    }));
    await assert.rejects(() => f.invokeData('authority-configure-execution', executionEditPayload(f, initial, {
        argumentProposal: '--stale'
    })), /capability is not active|stale revision|already revoked/i);

    const snapshot = f.services.profileStore.loadActiveSnapshot();
    const switched = await f.invokeData('profiles-create-library', {
        name: 'Other Library', snapshot
    });
    const otherLibraryId = switched.profiles.find(profile => profile.id === switched.activeProfileId).libraries.at(-1).id;
    await f.invokeData('profiles-switch-library', { libraryId: otherLibraryId });
    await assert.rejects(() => f.invokeData('authority-configure-execution', executionEditPayload(f, updated, {
        argumentProposal: '--cross-library'
    })), /different profile or library|wrong scope|does not match the requested game/i);
});

test('execution edits revalidate the existing authority after a picker remains open', async t => {
    const f = fixture(t);
    await bootstrapGame(f);
    const initial = f.services.profileStore.authorityStatus('setup-game').execution;
    let resolvePicker;
    f.setOpenDialog(() => new Promise(resolve => { resolvePicker = resolve; }));
    const pending = f.invokeData('authority-configure-execution', executionEditPayload(f, initial, {
        requestPreLaunchScript: true
    }));
    await new Promise(resolve => setImmediate(resolve));
    fs.renameSync(f.preLaunch, `${f.preLaunch}.moved`);
    fs.writeFileSync(f.preLaunch, 'replacement');
    resolvePicker({ canceled: false, filePaths: [f.preLaunch] });
    await assert.rejects(() => pending, /changed/i);
    const current = f.services.profileStore.authorityStatus('setup-game').execution;
    assert.equal(current.capabilityId, initial.capabilityId);
    assert.equal(current.revision, initial.revision);
});
