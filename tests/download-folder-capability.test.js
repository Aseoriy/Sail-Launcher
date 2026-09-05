'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const vm = require('node:vm');
const { ProfileStore } = require('../accounts/profileStore');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-download-folder-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const downloadFolder = path.join(root, 'downloaded-game');
    const gameFolder = path.join(root, 'installed-game');
    fs.mkdirSync(downloadFolder);
    fs.mkdirSync(gameFolder);
    fs.writeFileSync(path.join(gameFolder, 'game.exe'), 'fixture');
    const store = new ProfileStore(root);
    store.initialize();
    const shell = { opened: [], openPath: async target => { shell.opened.push(target); return ''; } };
    return { root, downloadFolder, gameFolder, store, shell };
}

function productionOpenFolderHandler(store, shell) {
    const start = mainSource.indexOf("ipcMain.handle('open-folder-capability'");
    const arrow = mainSource.indexOf('async (e, payload) =>', start);
    const bodyStart = mainSource.indexOf('{', arrow);
    let depth = 0;
    let quote = '';
    for (let i = bodyStart; i < mainSource.length; i++) {
        const ch = mainSource[i];
        if (quote) {
            if (ch === quote && mainSource[i - 1] !== '\\') quote = '';
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
            const body = mainSource.slice(bodyStart + 1, i);
            const handlers = new Map();
            const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
            const exactGateAPayload = (payload, keys) => {
                if (!payload || typeof payload !== 'object' || Object.keys(payload).some(key => !keys.includes(key))) {
                    throw new Error('Invalid Open local folder payload.');
                }
                return payload;
            };
            vm.runInNewContext(`ipcMain.handle('open-folder-capability', async (e, payload) => {${body}});`, {
                ipcMain, gateAProfileStore: () => store, exactGateAPayload, shell
            });
            return handlers.get('open-folder-capability');
        }
    }
    throw new Error('Could not extract production handler.');
}

test('completed download folder capability opens without an active library game', async t => {
    const f = fixture(t);
    assert.match(mainSource, /input\.gameId === 'launcher-device'\s*\? store\.resolveTransferCapability\s*:\s*store\.resolveFilesystemCapability/);
    const location = f.store.createLauncherDirectoryCapability(f.downloadFolder);
    const invoke = productionOpenFolderHandler(f.store, f.shell);
    const result = await invoke({}, {
        gameId: 'launcher-device', capabilityId: location.capabilityId, expectedRevision: location.revision
    });
    assert.equal(result.success, true);
    assert.equal(result.capability, null);
    assert.deepEqual(f.shell.opened, [f.downloadFolder]);
    assert.throws(() => f.store.resolveTransferCapability({
        gameId: 'launcher-device', capabilityId: location.capabilityId,
        expectedRevision: location.revision, operation: 'folder-open'
    }), /capability is not active/i);
});

test('game-scoped folder capability and all invalid boundaries remain fail-closed', async t => {
    const f = fixture(t);
    const added = f.store.registerDownloadedGameProposal({
        gameName: 'Fixture Game', executablePath: path.join(f.gameFolder, 'game.exe'), folderPath: f.gameFolder
    });
    const location = added.location;
    const invoke = productionOpenFolderHandler(f.store, f.shell);
    await invoke({}, {
        gameId: added.gameId, capabilityId: location.capabilityId, expectedRevision: location.revision
    });
    assert.deepEqual(f.shell.opened, [f.gameFolder]);

    const stale = f.store.createLauncherDirectoryCapability(f.downloadFolder);
    await assert.rejects(() => invoke({}, {
        gameId: 'launcher-device', capabilityId: stale.capabilityId, expectedRevision: stale.revision + 1
    }), /revision is stale/i);
    await assert.rejects(() => invoke({}, {
        gameId: 'launcher-device', capabilityId: '00000000-0000-4000-8000-000000000000', expectedRevision: 1
    }), /capability reference was not found/i);
    await assert.rejects(() => invoke({}, {
        gameId: 'launcher-device', capabilityId: stale.capabilityId, expectedRevision: stale.revision,
        path: f.root
    }), /invalid Open local folder payload/i);

    const configPath = path.join(f.root, 'config.ini');
    fs.writeFileSync(configPath, 'fixture');
    const wrongKind = f.store.createFilesystemCapability(added.gameId, 'config', configPath);
    await assert.rejects(() => invoke({}, {
        gameId: added.gameId, capabilityId: wrongKind.capabilityId, expectedRevision: wrongKind.revision
    }), /does not allow this operation/i);
});
