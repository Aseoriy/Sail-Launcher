'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { registerAccountIpc } = require('../accounts/ipc');
const { createRemoteDataClient } = require('../ui/remoteJson');
const { registerRemoteDataIpc } = require('../security/remoteData');
const {
    IPC_FORBIDDEN_CODE,
    createAuthorizedIpcRegistrar,
    createTrustedFrameAuthorizer
} = require('../security/ipcAuthorization');
const {
    SOURCES_PARTITION,
    installMainNavigationPolicy,
    installWebviewAttachmentPolicy,
    isSailLauncherInstallUrl,
    parseExternalWebUrl
} = require('../security/navigationPolicy');

function preventedEvent(extra = {}) {
    return Object.assign({
        prevented: false,
        preventDefault() { this.prevented = true; }
    }, extra);
}

function fakeContents() {
    const contents = new EventEmitter();
    contents.setWindowOpenHandler = handler => { contents.windowOpenHandler = handler; };
    return contents;
}

function trustedFixture() {
    const trustedEntryPath = path.join(process.cwd(), 'index.html');
    const localUrl = pathToFileURL(trustedEntryPath).href;
    const appSession = {};
    const mainFrame = { url: localUrl, isDestroyed: () => false };
    mainFrame.top = mainFrame;
    const contents = {
        session: appSession,
        mainFrame,
        getURL: () => localUrl,
        isDestroyed: () => false
    };
    const win = { isDestroyed: () => false, webContents: contents };
    const authorize = createTrustedFrameAuthorizer({ getMainWindow: () => win, trustedEntryPath });
    const event = { sender: contents, senderFrame: mainFrame };
    return { authorize, contents, event, localUrl, mainFrame, trustedEntryPath };
}

test('main renderer allows only the packaged Sail document and externalizes safe web links', () => {
    const webContents = fakeContents();
    const opened = [];
    const trustedEntryPath = path.join(process.cwd(), 'index.html');
    installMainNavigationPolicy(webContents, {
        trustedEntryPath,
        shell: { openExternal: url => { opened.push(url); return Promise.resolve(); } }
    });

    const local = preventedEvent();
    webContents.emit('will-navigate', local, pathToFileURL(trustedEntryPath).href);
    assert.equal(local.prevented, false);

    const sailHub = preventedEvent();
    webContents.emit('will-navigate', sailHub, 'https://sailhub.fyi/releases');
    assert.equal(sailHub.prevented, true);
    assert.deepEqual(opened, ['https://sailhub.fyi/releases']);

    const popup = webContents.windowOpenHandler({ url: 'https://news.sailhub.fyi/release' });
    assert.deepEqual(popup, { action: 'deny' });
    assert.equal(opened.at(-1), 'https://news.sailhub.fyi/release');

    const releaseNotesPopup = webContents.windowOpenHandler({ url: 'https://sail-launcher.sailhub.fyi/changelog' });
    assert.deepEqual(releaseNotesPopup, { action: 'deny' });
    assert.equal(opened.at(-1), 'https://sail-launcher.sailhub.fyi/changelog');

    const subframe = preventedEvent({ isMainFrame: false });
    webContents.emit('will-frame-navigate', subframe);
    assert.equal(subframe.prevented, true);
});

test('unexpected navigation schemes and malformed external URLs fail closed', () => {
    const webContents = fakeContents();
    const opened = [];
    installMainNavigationPolicy(webContents, {
        trustedEntryPath: path.join(process.cwd(), 'index.html'),
        shell: { openExternal: url => opened.push(url) }
    });

    const rejected = [
        'javascript:alert(1)',
        'data:text/html,hello',
        pathToFileURL(path.join(process.cwd(), 'other.html')).href,
        'sail-launcher://unexpected',
        'https:\\sailhub.fyi\\broken',
        'not a url'
    ];
    for (const rawUrl of rejected) {
        const event = preventedEvent();
        webContents.emit('will-navigate', event, rawUrl);
        assert.equal(event.prevented, true, rawUrl);
        assert.deepEqual(webContents.windowOpenHandler({ url: rawUrl }), { action: 'deny' });
        assert.equal(parseExternalWebUrl(rawUrl), null);
    }
    assert.deepEqual(opened, []);
});

test('Store and Sources attachments are isolated and their popups cannot create children', () => {
    const host = fakeContents();
    const opened = [];
    const handedOff = [];
    const partitionSessions = new Map();
    const session = {
        fromPartition(partition) {
            if (!partitionSessions.has(partition)) partitionSessions.set(partition, { partition });
            return partitionSessions.get(partition);
        }
    };
    installWebviewAttachmentPolicy(host, {
        session,
        shell: { openExternal: url => opened.push(url) },
        onSailLauncherProtocol: url => handedOff.push(url)
    });

    const preferences = {
        preload: 'dangerous.js',
        nodeIntegration: true,
        nodeIntegrationInSubFrames: true,
        contextIsolation: false,
        sandbox: false,
        webSecurity: false
    };
    const allowedAttach = preventedEvent();
    host.emit('will-attach-webview', allowedAttach, preferences, {
        partition: SOURCES_PARTITION,
        src: 'https://example.com/download'
    });
    assert.equal(allowedAttach.prevented, false);
    assert.equal(preferences.preload, undefined);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.nodeIntegrationInSubFrames, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.webSecurity, true);

    const unexpectedAttach = preventedEvent();
    host.emit('will-attach-webview', unexpectedAttach, {}, {
        partition: 'persist:unexpected',
        src: 'https://sailhub.fyi/'
    });
    assert.equal(unexpectedAttach.prevented, true);

    const guest = fakeContents();
    guest.session = session.fromPartition(SOURCES_PARTITION);
    guest.destroyed = false;
    guest.destroy = () => { guest.destroyed = true; };
    guest.getLastWebPreferences = () => preferences;
    host.emit('did-attach-webview', {}, guest);
    assert.equal(guest.destroyed, false);
    assert.deepEqual(guest.windowOpenHandler({ url: 'https://sub.sailhub.fyi/popup' }), { action: 'deny' });
    assert.equal(opened.at(-1), 'https://sub.sailhub.fyi/popup');

    const invalidGuestNavigation = preventedEvent();
    guest.emit('will-navigate', invalidGuestNavigation, 'data:text/html,escape');
    assert.equal(invalidGuestNavigation.prevented, true);

    const installUrl = 'sail-launcher://install-plugin?url=' + encodeURIComponent('https://example.com/plugin.zip');
    assert.equal(isSailLauncherInstallUrl(installUrl), true);
    const installNavigation = preventedEvent();
    guest.emit('will-navigate', installNavigation, installUrl);
    assert.equal(installNavigation.prevented, true);
    assert.deepEqual(handedOff, [installUrl]);
});

test('sensitive IPC accepts only the trusted local top-level Sail frame', async () => {
    const fixture = trustedFixture();
    assert.equal(fixture.authorize(fixture.event, 'launch-game'), true);

    const remoteFrame = { url: 'https://sailhub.fyi/', top: null, isDestroyed: () => false };
    remoteFrame.top = remoteFrame;
    assert.throws(
        () => fixture.authorize({ sender: fixture.contents, senderFrame: remoteFrame }, 'launch-game'),
        error => error.code === IPC_FORBIDDEN_CODE
    );

    const guestFrame = { url: 'https://example.com/', top: null, isDestroyed: () => false };
    const guestContents = { session: {}, mainFrame: guestFrame, getURL: () => guestFrame.url, isDestroyed: () => false };
    guestFrame.top = guestFrame;
    assert.throws(
        () => fixture.authorize({ sender: guestContents, senderFrame: guestFrame }, 'launch-game'),
        error => error.code === IPC_FORBIDDEN_CODE
    );

    const subframe = { url: fixture.localUrl, top: fixture.mainFrame, isDestroyed: () => false };
    assert.throws(
        () => fixture.authorize({ sender: fixture.contents, senderFrame: subframe }, 'launch-game'),
        error => error.code === IPC_FORBIDDEN_CODE
    );

    const handlers = new Map();
    const registrar = createAuthorizedIpcRegistrar({
        handle: (channel, handler) => handlers.set(channel, handler),
        on: () => {}
    }, fixture.authorize);
    registrar.handle('launch-game', (_event, payload) => ({ launched: payload.id }));
    assert.deepEqual(await handlers.get('launch-game')(fixture.event, { id: 'game-1' }), { launched: 'game-1' });
    assert.throws(
        () => handlers.get('launch-game')({ sender: guestContents, senderFrame: guestFrame }, { id: 'game-1' }),
        error => error.code === IPC_FORBIDDEN_CODE
    );
});

test('account IPC preserves the event and validates it before account work', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-account-security-'));
    t.after(() => fs.removeSync(root));
    const handlers = new Map();
    const trustedEvent = { marker: 'trusted-account-frame' };
    const seen = [];
    registerAccountIpc({
        app: { getPath: () => root },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        safeStorage: {
            isEncryptionAvailable: () => false,
            encryptString: () => Buffer.alloc(0),
            decryptString: () => ''
        },
        dialog: {
            showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
            showMessageBox: async () => ({ response: 1 })
        },
        authorizeIpcEvent(event, channel) {
            seen.push({ event, channel });
            if (event !== trustedEvent) {
                const error = new Error('internal details must not escape');
                error.code = IPC_FORBIDDEN_CODE;
                throw error;
            }
        }
    });

    const allowed = await handlers.get('account-get-state')(trustedEvent);
    assert.equal(allowed.success, true);
    assert.equal(seen[0].event, trustedEvent);
    assert.equal(seen[0].channel, 'account-get-state');

    const denied = await handlers.get('account-get-state')({ marker: 'remote' });
    assert.deepEqual(denied, {
        success: false,
        error: 'This account request is not allowed.',
        code: IPC_FORBIDDEN_CODE
    });
});

test('production typed remote-data handler runs only after trusted-frame authorization', async () => {
    const fixture = trustedFixture();
    const handlers = new Map();
    const registrar = createAuthorizedIpcRegistrar({
        handle: (channel, handler) => handlers.set(channel, handler),
        on: () => {}
    }, fixture.authorize);
    let executions = 0;
    registerRemoteDataIpc(registrar, {
        async execute(payload) {
            executions += 1;
            assert.deepEqual(payload, { operation: 'steam.searchApps', query: 'Portal' });
            return { data: [{ name: 'Portal', appid: 400 }] };
        }
    });
    const client = createRemoteDataClient({
        invoke: (channel, payload) => handlers.get(channel)(fixture.event, payload)
    });
    assert.deepEqual(await client.searchSteamApps('Portal'), [{ name: 'Portal', appid: 400 }]);
    assert.equal(executions, 1);

    const remoteFrame = { url: 'https://sailhub.fyi/', top: null, isDestroyed: () => false };
    remoteFrame.top = remoteFrame;
    assert.throws(
        () => handlers.get('remote-data')({ sender: fixture.contents, senderFrame: remoteFrame }, { operation: 'steam.searchApps', query: 'Portal' }),
        error => error.code === IPC_FORBIDDEN_CODE
    );
    assert.equal(executions, 1);
});

test('packaged renderer has no generic remote URL IPC capability', () => {
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.doesNotMatch(renderer, /ipcRenderer\.invoke\(['"]scrape-(?:fetch|render)['"]/);
    assert.doesNotMatch(main, /ipcMain\.handle\(['"]scrape-(?:fetch|render)['"]/);
    assert.match(renderer, /createRemoteDataClient\(ipcRenderer\)/);
    assert.match(renderer, /remoteData\.searchSteamApps\(query\)/);
    assert.match(renderer, /remoteData\.getSteamAppDetails\(/);
});
