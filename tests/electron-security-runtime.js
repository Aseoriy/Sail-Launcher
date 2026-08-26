'use strict';

const { EventEmitter } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { registerDownloadCancellationIpc } = require('../runtime/downloadIpc');
const { DownloadJobDirectoryRegistry } = require('../runtime/downloadJobCleanup');
const { DownloadQuarantineCatalog, registerDownloadQuarantineIpc } = require('../runtime/downloadQuarantine');
const { createAuthorizedIpcRegistrar, createTrustedFrameAuthorizer } = require('../security/ipcAuthorization');
const { registerLaunchStatusIpc } = require('../security/launchStatusIpc');
const { createRemoteDataService, registerRemoteDataIpc } = require('../security/remoteData');
const { installMainNavigationPolicy, installWebviewAttachmentPolicy } = require('../security/navigationPolicy');

const suppliedTempRoot = process.env.SAIL_SECURITY_TEST_ROOT;
const tempRoot = suppliedTempRoot
    ? path.resolve(suppliedTempRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'sail-electron-security-'));
if (!path.basename(tempRoot).startsWith('sail-electron-security-')) {
    throw new Error('The Electron security test root is invalid.');
}
for (const directory of ['userData', 'sessionData', 'crashDumps', 'logs']) {
    fs.mkdirSync(path.join(tempRoot, directory), { recursive: true });
}
app.setPath('userData', path.join(tempRoot, 'userData'));
app.setPath('sessionData', path.join(tempRoot, 'sessionData'));
app.setPath('crashDumps', path.join(tempRoot, 'crashDumps'));
app.setPath('logs', path.join(tempRoot, 'logs'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('window-all-closed', event => event.preventDefault());

function stage(name) {
    console.error(`SAIL_SECURITY_RUNTIME_STAGE ${name}`);
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, label, milliseconds = 12000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds))
    ]);
}

async function waitUntil(predicate, label, milliseconds = 6000) {
    const started = Date.now();
    while (Date.now() - started < milliseconds) {
        if (predicate()) return;
        await delay(30);
    }
    throw new Error(`${label} timed out.`);
}

function createRuntimeNetwork() {
    const calls = [];
    function request(options, onResponse) {
        calls.push({ hostname: options.hostname, path: options.path, method: options.method });
        const requestEmitter = new EventEmitter();
        requestEmitter.setTimeout = () => {};
        requestEmitter.destroy = error => {
            requestEmitter.destroyed = true;
            if (error) queueMicrotask(() => requestEmitter.emit('error', error));
        };
        requestEmitter.end = () => {
            options.lookup(options.hostname, { all: true }, (_error, resolved, family) => {
                const selected = Array.isArray(resolved) ? resolved[0] : { address: resolved, family };
                const socket = new EventEmitter();
                socket.connecting = true;
                socket.remoteAddress = selected.address;
                requestEmitter.emit('socket', socket);
                queueMicrotask(() => {
                    socket.connecting = false;
                    socket.emit('secureConnect');
                    if (requestEmitter.destroyed) return;
                    const response = new EventEmitter();
                    response.statusCode = 200;
                    response.headers = { 'content-type': 'application/json' };
                    response.resume = () => {};
                    onResponse(response);
                    response.emit('data', '[{"name":"Portal 2","appid":620}]');
                    response.emit('end');
                });
            });
        };
        return requestEmitter;
    }
    return {
        calls,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request
    };
}

function assertRejected(authorize, event, label) {
    let rejected = false;
    try { authorize(event, 'remote-data'); } catch (error) { rejected = error && error.code === 'SAIL_IPC_FORBIDDEN'; }
    if (!rejected) throw new Error(`${label} IPC was not rejected.`);
}

async function run() {
    let server;
    let mainWindow;
    let remoteWindow;
    let wrongSessionWindow;
    try {
        const registerScheme = require('register-scheme');
        if (typeof registerScheme !== 'function') throw new Error('The existing register-scheme native module did not load in Electron.');
        stage('server');
        server = http.createServer((_request, response) => {
            stage('server-request');
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end('<!doctype html><title>Remote guest</title><p>remote content</p>');
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const remoteUrl = `http://127.0.0.1:${server.address().port}/remote`;
        const preloadPath = path.join(tempRoot, 'remote-preload.js');
        const entryPath = path.join(tempRoot, 'index.html');
        const otherEntryPath = path.join(tempRoot, 'other.html');
        fs.writeFileSync(preloadPath, `
            const { ipcRenderer } = require('electron');
            window.addEventListener('DOMContentLoaded', () => {
                ipcRenderer.invoke('remote-data', { operation: 'steam.searchApps', query: 'Remote attempt' }).catch(() => {});
            });
        `);
        fs.writeFileSync(otherEntryPath, '<!doctype html><title>Wrong local document</title>');
        fs.writeFileSync(entryPath, `<!doctype html>
            <meta charset="utf-8">
            <title>Sail security runtime</title>
            <div id="launchStatus" role="status" hidden><span id="launchStatusMessage"></span></div>
            <a id="release-link" href="https://sail-launcher.sailhub.fyi/releases/v5.4.1" target="_blank">Release notes</a>
            <iframe id="child" srcdoc="<!doctype html><p>child frame</p>"></iframe>
            <webview id="sourceWebview" src="${remoteUrl}" partition="persist:sail-sources" allowpopups preload="${pathToFileURL(preloadPath).href}"></webview>
        `);

        const externalized = [];
        const safeShell = { openExternal: url => { externalized.push(url); return Promise.resolve(); } };
        const authorizeIpcEvent = createTrustedFrameAuthorizer({ getMainWindow: () => mainWindow, trustedEntryPath: entryPath });
        const authorizedIpc = createAuthorizedIpcRegistrar(ipcMain, authorizeIpcEvent);
        const hostileLaunchName = '</span><img src=x onerror="globalThis.__sailSplashXss=1"><script>globalThis.__sailSplashXss=2</script>';
        registerLaunchStatusIpc(authorizedIpc, {
            resolveGameMetadata: gameId => {
                if (gameId !== 'game-hostile') throw new Error('Unknown game.');
                return { id: gameId, name: hostileLaunchName };
            }
        });
        const network = createRuntimeNetwork();
        registerRemoteDataIpc(authorizedIpc, createRemoteDataService({ lookup: network.lookup, request: network.request }));

        const downloadRoot = path.join(tempRoot, 'downloads');
        const quarantineCatalogPath = path.join(tempRoot, 'userData', 'download-quarantine-roots.json');
        const quarantineCatalog = new DownloadQuarantineCatalog({ catalogPath: quarantineCatalogPath });
        const registry = new DownloadJobDirectoryRegistry({ quarantineCatalog });
        const activeDownloads = new Map();
        const pendingBrowserDownloads = new Map();
        const openedQuarantineRoots = [];
        registerDownloadCancellationIpc(authorizedIpc, {
            registry,
            activeDownloads,
            pendingBrowserDownloads,
            retryDelays: [0, 20, 40],
            onCleanupOutcome: () => {}
        });
        registerDownloadQuarantineIpc(authorizedIpc, {
            catalog: quarantineCatalog,
            shell: { openPath: async target => { openedQuarantineRoots.push(target); return ''; } }
        });

        stage('main-window');
        mainWindow = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                webSecurity: true,
                webviewTag: true
            }
        });
        installMainNavigationPolicy(mainWindow.webContents, { shell: safeShell, trustedEntryPath: entryPath });
        installWebviewAttachmentPolicy(mainWindow.webContents, { shell: safeShell, session });
        const guestAttached = new Promise(resolve => mainWindow.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)));
        await mainWindow.loadFile(entryPath);

        stage('launch-status');
        const launchStatusModulePath = path.join(__dirname, '..', 'ui', 'launchStatus.js');
        const launchStatusOutcome = await mainWindow.webContents.executeJavaScript(`(async () => {
            const ipcRenderer = require('electron').ipcRenderer;
            require(${JSON.stringify(launchStatusModulePath)}).bindLaunchStatus(document, ipcRenderer, { durationMs: 1000 });
            ipcRenderer.send('show-launch-splash', { gameId: 'game-hostile', name: 'renderer-forgery' });
            await new Promise(resolve => setTimeout(resolve, 40));
            const rejectedStayedHidden = document.getElementById('launchStatus').hidden;
            ipcRenderer.send('show-launch-splash', { gameId: 'game-hostile' });
            await new Promise(resolve => setTimeout(resolve, 40));
            const container = document.getElementById('launchStatus');
            const message = document.getElementById('launchStatusMessage');
            return {
                rejectedStayedHidden,
                text: message.textContent,
                childCount: message.children.length,
                hostileElementCount: container.querySelectorAll('img,svg,iframe,form,script,[onerror],[onclick]').length,
                executed: globalThis.__sailSplashXss,
                visible: !container.hidden
            };
        })()`);
        if (!launchStatusOutcome.rejectedStayedHidden
            || launchStatusOutcome.text !== `🚀 Launching ${hostileLaunchName}...`
            || launchStatusOutcome.childCount !== 0
            || launchStatusOutcome.hostileElementCount !== 0
            || launchStatusOutcome.executed !== undefined
            || !launchStatusOutcome.visible) {
            throw new Error(`Launch status boundary failed: ${JSON.stringify(launchStatusOutcome)}`);
        }

        stage('trusted-remote-data');
        const remoteDataModulePath = path.join(__dirname, '..', 'ui', 'remoteJson.js');
        const trustedResult = await mainWindow.webContents.executeJavaScript(
            `require(${JSON.stringify(remoteDataModulePath)}).createRemoteDataClient(require('electron').ipcRenderer).searchSteamApps('Portal 2')`
        );
        if (!Array.isArray(trustedResult) || trustedResult[0].appid !== 620 || network.calls.length !== 1) {
            throw new Error('Trusted typed Steam IPC did not execute the production handler.');
        }

        const invalidRequests = await mainWindow.webContents.executeJavaScript(`Promise.all([
            require('electron').ipcRenderer.invoke('remote-data', { operation: 'steam.searchApps', query: 'Portal', url: 'http://127.0.0.1/private' }),
            require('electron').ipcRenderer.invoke('remote-data', { operation: 'source.detail', reference: 'http://127.0.0.1/private' }),
            require('electron').ipcRenderer.invoke('remote-data', { operation: 'steam.searchApps', query: 'Portal', host: '10.0.0.1' })
        ])`);
        if (invalidRequests.some(result => result && result.ok) || network.calls.length !== 1) {
            throw new Error('Raw or private destination input reached the network boundary.');
        }

        stage('privileged-dom-boundary');
        const safeDomModulePath = path.join(__dirname, '..', 'ui', 'safeDom.js');
        const domBoundary = await mainWindow.webContents.executeJavaScript(`(async () => { try {
            const SafeDom = require(${JSON.stringify(safeDomModulePath)});
            const hostile = '<img src=x onerror="globalThis.__sailGateAXss=1"><script>globalThis.__sailGateAXss=2</script>';
            const categories = [
                'games', 'sections', 'settings', 'sources', 'profiles', 'cloud rows',
                'Steam search', 'Steam friends', 'Steam details', 'Steam workshop'
            ];
            const matrix = document.createElement('div');
            for (const category of categories) {
                matrix.append(SafeDom.element(document, 'div', { text: category + ': ' + hostile, title: hostile }));
            }
            document.body.append(matrix);
            const plainDataStayedText = Array.from(matrix.children).every((row, index) =>
                row.textContent === categories[index] + ': ' + hostile
                && row.children.length === 0
                && row.title === hostile
            ) && globalThis.__sailGateAXss === undefined;

            const image = document.createElement('img');
            const hostileImagesRejected = [
                'javascript:alert(1)',
                'data:text/html;base64,PHNjcmlwdD4=',
                'https://evil.example/cover.png',
                'https://cdn.akamai.steamstatic.com/cover.png\\" onerror=alert(1)'
            ].every(value => SafeDom.setImageSource(image, value, { allowSteam: true }) === false);
            const approvedImageAccepted = SafeDom.setImageSource(
                image,
                'https://cdn.akamai.steamstatic.com/steam/apps/620/header.jpg',
                { allowSteam: true }
            ) && image.src.startsWith('https://cdn.akamai.steamstatic.com/');
            const urlsTyped = !SafeDom.safeExternalUrl('javascript:alert(1)', { allowAnyHost: true })
                && !SafeDom.safeExternalUrl('https://user:pass@example.com/private', { allowAnyHost: true })
                && SafeDom.safeExternalUrl('https://example.com/safe', { allowAnyHost: true }) === 'https://example.com/safe';
            const cssTyped = SafeDom.safeCssColor('#a855f7') === '#a855f7'
                && !SafeDom.safeCssColor('red; background:url(javascript:alert(1))')
                && !SafeDom.safeCssColor('expression(alert(1))')
                && Object.keys(SafeDom.safeUiCustom({ 'body, iframe': { bg: 'red' } })).length === 0;
            const sourcesTyped = SafeDom.safeUserSources([
                { name: 'Safe source', url: 'https://example.com/catalog', openInSystemBrowser: true },
                { name: 'Script source', url: 'javascript:alert(1)' },
                { name: 'Attribute source', url: 'https://example.com', onclick: hostile }
            ]);

            const rich = document.createElement('div');
            rich.append(SafeDom.rebuildSteamRichText(document, [
                '<p id="bad" style="color:red" onclick="alert(1)">Allowed <strong data-x="bad">strong</strong></p>',
                '<a href="https://store.steampowered.com/app/620" onclick="alert(1)" style="color:red">safe link</a>',
                '<a href="javascript:alert(1)"><em>unsafe link text</em></a>',
                '<script>script text</script><style>style text</style>',
                '<svg><script>alert(1)</script><text>svg text</text></svg>',
                '<math><mtext>math text</mtext></math><form><input value="bad">form text</form>',
                '<video src="https://evil.example/video.mp4">video text</video>',
                '<marquee onstart="alert(1)">unknown tag text</marquee>'
            ].join('')));
            document.body.append(rich);
            const allowedTags = new Set(['P', 'STRONG', 'B', 'EM', 'I', 'CODE', 'S', 'DIV', 'UL', 'OL', 'LI', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'BR', 'A']);
            const richNodes = Array.from(rich.querySelectorAll('*'));
            const limitedSteamHtml = richNodes.every(node => allowedTags.has(node.tagName))
                && richNodes.every(node => Array.from(node.attributes).every(attribute =>
                    node.tagName === 'A' && ['href', 'target', 'rel', 'title'].includes(attribute.name)
                ))
                && rich.querySelectorAll('script,style,svg,math,form,input,video,marquee').length === 0
                && rich.querySelectorAll('[onclick],[onerror],[onstart],[style],[id],[class]').length === 0
                && rich.querySelector('a').href === 'https://store.steampowered.com/app/620'
                && rich.querySelector('a').target === '_blank'
                && rich.querySelector('a').rel === 'noopener noreferrer'
                && rich.textContent.includes('unsafe link text')
                && rich.textContent.includes('unknown tag text')
                && !rich.textContent.includes('script text')
                && !rich.textContent.includes('svg text')
                && !rich.textContent.includes('form text')
                && globalThis.__sailGateAXss === undefined;
            const hostileKey = '\" autofocus onfocus=globalThis.__sailGateAXss=3';
            const DebridRendering = require(${JSON.stringify(path.join(__dirname, '..', 'ui', 'debridRendering.js'))});
            const debridList = document.createElement('div');
            DebridRendering.renderDebridServices(document, debridList, [
                { id: 'realdebrid', name: 'Real-Debrid', hint: 'Local key' },
                { id: 'alldebrid', name: 'AllDebrid', hint: 'Local key' }
            ], {
                active: 'realdebrid',
                keys: { realdebrid: hostileKey, alldebrid: 'local-key' },
                status: {
                    realdebrid: { ok: true, user: hostile },
                    alldebrid: { ok: false, error: hostile }
                }
            });
            document.body.appendChild(debridList);
            const debridInput = debridList.querySelector('.debrid-key[data-id="realdebrid"]');
            const debridStatusStayedText = debridList.textContent.includes(hostile)
                && debridList.querySelectorAll('script,img,[onerror],[onfocus],[autofocus]').length === 0
                && debridInput.value === hostileKey
                && globalThis.__sailGateAXss === undefined;
            const staleArtworkPath = ${JSON.stringify('C:\\Remote\\revoked-achievement.png')};
            const staleArtworkGame = {
                id: 'runtime-stale-artwork', name: 'Runtime artwork', steamAppId: '',
                achievementData: {
                    items: [{ id: 'STALE_ART', displayName: 'Stale art', unlocked: true, iconPath: staleArtworkPath }]
                },
                achievementSources: []
            };
            const { bindAchievementArtwork } = require(${JSON.stringify(path.join(__dirname, '..', 'ui', 'achievementArtwork.js'))});
            const artworkHost = document.createElement('div');
            const artworkImage = document.createElement('img');
            artworkHost.appendChild(artworkImage);
            document.body.appendChild(artworkHost);
            const artworkRequests = [];
            bindAchievementArtwork({
                image: artworkImage,
                item: staleArtworkGame.achievementData.items[0],
                game: staleArtworkGame,
                ipc: {
                    invoke: async (channel, payload) => {
                        artworkRequests.push({ channel, payload });
                        return { available: false };
                    }
                },
                currentLibraryKey: () => 'runtime:isolated',
                SafeDom
            });
            await new Promise(resolve => setTimeout(resolve, 50));
            const achievementArtworkStayedMainOwned = artworkRequests.length === 1
                && artworkRequests[0].channel === 'achievements-read-artwork'
                && JSON.stringify(artworkRequests[0].payload).includes('revoked-achievement') === false
                && !/^file:/i.test(artworkImage.getAttribute('src') || '')
                && !(artworkImage.getAttribute('src') || '').includes('revoked-achievement')
                && artworkImage.hidden;
            artworkHost.remove();
            debridList.remove();
            matrix.remove();
            rich.remove();
            return {
                plainDataStayedText,
                hostileImagesRejected,
                approvedImageAccepted,
                urlsTyped,
                cssTyped,
                sourcesTyped: sourcesTyped.length === 1 && sourcesTyped[0].name === 'Safe source',
                limitedSteamHtml,
                debridStatusStayedText,
                achievementArtworkStayedMainOwned
            };
        } catch (error) {
            return { probeError: String(error && error.stack || error) };
        }
        })()`);
        if (Object.values(domBoundary).some(value => value !== true)) {
            throw new Error(`Privileged DOM boundary failed: ${JSON.stringify(domBoundary)}`);
        }

        stage('owned-cancel');
        const ownedJob = registry.begin('runtime-owned', { gameName: 'Runtime Owned', defaultRoot: downloadRoot });
        await registry.ensureDirectory(ownedJob);
        await registry.setState(ownedJob, 'downloading');
        fs.writeFileSync(path.join(ownedJob.directory, 'partial.bin'), 'partial');
        const ownedPath = ownedJob.directory;
        const cancelOwned = await mainWindow.webContents.executeJavaScript(
            `require('electron').ipcRenderer.invoke('cancel-download', 'runtime-owned')`
        );
        if (!cancelOwned || cancelOwned.status !== 'cancelled_quarantined' || cancelOwned.retained !== true) {
            throw new Error('Production cancellation did not report retained quarantine truthfully.');
        }
        await waitUntil(() => ownedJob.cleanupFinalized, 'Owned staging quarantine');
        if (ownedJob.state !== 'cancelled_quarantined' || fs.existsSync(ownedPath) || !fs.existsSync(ownedJob.quarantinePath)) {
            throw new Error('Owned staging directory did not enter fail-closed quarantine retention.');
        }

        stage('quarantine-discovery-open');
        const quarantineSummary = await mainWindow.webContents.executeJavaScript(
            `require('electron').ipcRenderer.invoke('get-download-quarantine-summary')`
        );
        if (!quarantineSummary || quarantineSummary.itemCount !== 1 || !quarantineSummary.roots[0]) {
            throw new Error('Retained quarantine was not discoverable through the production handler.');
        }
        const refusedOpen = await mainWindow.webContents.executeJavaScript(
            `require('electron').ipcRenderer.invoke('open-download-quarantine', ${JSON.stringify(tempRoot)})`
        );
        if (!refusedOpen || refusedOpen.status !== 'open_refused' || openedQuarantineRoots.length !== 0) {
            throw new Error('Renderer path input reached the quarantine Open-folder boundary.');
        }
        const opened = await mainWindow.webContents.executeJavaScript(
            `require('electron').ipcRenderer.invoke('open-download-quarantine', ${JSON.stringify(quarantineSummary.roots[0].id)})`
        );
        if (!opened || opened.status !== 'opened' || openedQuarantineRoots.length !== 1
            || openedQuarantineRoots[0] !== fs.realpathSync.native(ownedJob.quarantineRoot)) {
            throw new Error('Production Open-folder handler did not target the canonical quarantine root.');
        }
        const restartedCatalog = new DownloadQuarantineCatalog({ catalogPath: quarantineCatalogPath });
        if (restartedCatalog.summarize().itemCount !== 1) throw new Error('Retained quarantine was not discoverable after catalog restart.');

        stage('cancel-before-create');
        const earlyJob = registry.begin('runtime-early', { gameName: 'Runtime Early', defaultRoot: downloadRoot });
        const earlyPath = earlyJob.directory;
        const cancelEarly = await mainWindow.webContents.executeJavaScript(
            `require('electron').ipcRenderer.invoke('cancel-download', 'runtime-early')`
        );
        if (!cancelEarly || cancelEarly.status !== 'cancelled_clean' || cancelEarly.retained !== false) {
            throw new Error('Production cancellation did not report a clean uncreated job.');
        }
        await waitUntil(() => earlyJob.cleanupFinalized, 'Early cancellation cleanup');
        let earlyCreationRejected = false;
        try { await registry.ensureDirectory(earlyJob); } catch (_) { earlyCreationRejected = true; }
        if (!earlyCreationRejected || fs.existsSync(earlyPath)) throw new Error('Cancelled job created staging after its terminal transition.');

        stage('replacement-cancel');
        const replacementJob = registry.begin('runtime-replaced', { gameName: 'Runtime Replaced', defaultRoot: downloadRoot });
        await registry.ensureDirectory(replacementJob);
        await registry.setState(replacementJob, 'processing');
        fs.rmSync(replacementJob.directory, { recursive: true, force: true });
        fs.mkdirSync(replacementJob.directory);
        const replacementSentinel = path.join(replacementJob.directory, 'replacement.txt');
        fs.writeFileSync(replacementSentinel, 'keep');
        const cancelReplacement = await mainWindow.webContents.executeJavaScript(
            `require('electron').ipcRenderer.invoke('cancel-download', 'runtime-replaced')`
        );
        if (!cancelReplacement || cancelReplacement.status !== 'cleanup_refused') {
            throw new Error('Production cancellation did not report replacement cleanup refusal.');
        }
        const cancelReplacementAgain = await mainWindow.webContents.executeJavaScript(
            `require('electron').ipcRenderer.invoke('cancel-download', 'runtime-replaced')`
        );
        if (!cancelReplacementAgain || cancelReplacementAgain.status !== 'cleanup_refused'
            || cancelReplacementAgain.reason !== cancelReplacement.reason) {
            throw new Error('Repeated production cancellation did not preserve the cleanup refusal.');
        }
        await waitUntil(() => replacementJob.state === 'cancellation_refused', 'Replacement cleanup refusal');
        if (fs.readFileSync(replacementSentinel, 'utf8') !== 'keep') throw new Error('Same-path replacement was deleted.');

        stage('navigation');
        await mainWindow.webContents.executeJavaScript(`document.getElementById('release-link').click()`);
        await mainWindow.webContents.executeJavaScript(`window.location.href = 'https://sailhub.fyi/attempted-navigation'`).catch(() => {});
        await delay(150);
        if (mainWindow.webContents.getURL() !== pathToFileURL(entryPath).href) throw new Error('Remote content replaced the privileged local document.');
        if (!externalized.includes('https://sail-launcher.sailhub.fyi/releases/v5.4.1')) throw new Error('Release link was not externalized.');
        if (!externalized.includes('https://sailhub.fyi/attempted-navigation')) throw new Error('Remote navigation was not externalized.');

        stage('guest');
        const guest = await withTimeout(guestAttached, 'Sources webview attachment');
        stage('guest-attached');
        await withTimeout(new Promise(resolve => {
            if (!guest.isLoading()) return resolve();
            guest.once('did-finish-load', resolve);
        }), 'Sources webview load');
        stage('guest-loaded');
        const guestPreferences = guest.getLastWebPreferences();
        if (guestPreferences.nodeIntegration || guestPreferences.nodeIntegrationInSubFrames
            || guestPreferences.contextIsolation !== true || guestPreferences.sandbox !== true
            || guestPreferences.webSecurity === false || guestPreferences.preload) {
            throw new Error('Sources webview did not retain isolated production preferences.');
        }
        const guestNodeAccess = 'blocked-by-production-preferences';
        assertRejected(authorizeIpcEvent, { sender: guest, senderFrame: guest.mainFrame }, 'Guest');

        const childFrame = mainWindow.webContents.mainFrame.frames.find(frame => frame !== mainWindow.webContents.mainFrame);
        if (!childFrame) throw new Error('Runtime child frame was not created.');
        assertRejected(authorizeIpcEvent, { sender: mainWindow.webContents, senderFrame: childFrame }, 'Subframe');

        stage('remote-window');
        remoteWindow = new BrowserWindow({
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: preloadPath }
        });
        await remoteWindow.loadURL(remoteUrl).catch(() => {});
        await delay(250);
        if (network.calls.length !== 1) throw new Error('A remote renderer reached the production remote-data operation.');
        assertRejected(authorizeIpcEvent, { sender: remoteWindow.webContents, senderFrame: remoteWindow.webContents.mainFrame }, 'Wrong-window/document');

        stage('wrong-session-window');
        wrongSessionWindow = new BrowserWindow({
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:sail-security-wrong-session' }
        });
        await wrongSessionWindow.loadFile(otherEntryPath).catch(() => {});
        assertRejected(authorizeIpcEvent, { sender: wrongSessionWindow.webContents, senderFrame: wrongSessionWindow.webContents.mainFrame }, 'Wrong-session/window');

        stage('popup-policy');
        if (BrowserWindow.getAllWindows().length !== 3) throw new Error('A popup created an unexpected BrowserWindow.');

        return {
            isolatedUserData: app.getPath('userData').startsWith(tempRoot),
            trustedTypedSteamProductionHandler: true,
            rawPrivateInputRejectedBeforeNetwork: true,
            privilegedDomPlainDataMatrix: domBoundary.plainDataStayedText,
            typedImageUrlCssAndSourceValidators: domBoundary.hostileImagesRejected
                && domBoundary.approvedImageAccepted && domBoundary.urlsTyped
                && domBoundary.cssTyped && domBoundary.sourcesTyped,
            limitedSteamHtmlRebuiltFromAllowlist: domBoundary.limitedSteamHtml,
            debridProviderStatusRenderedAsText: domBoundary.debridStatusStayedText,
            achievementArtworkMainOwnedAfterRevocation: domBoundary.achievementArtworkStayedMainOwned,
            launchStatusProductionIpcRenderedAsText: true,
            remoteGuestSubframeWrongWindowSessionDocumentRejected: true,
            exactOwnedStagingQuarantinedAndRetained: true,
            explicitCancellationStatuses: true,
            quarantineDiscoverableAfterRestart: true,
            quarantineOpenFolderCanonicalAndPathless: true,
            samePathReplacementRetained: true,
            repeatedCleanupRefusalRemainsSticky: true,
            remoteMainNavigationDenied: true,
            releaseLinkExternalized: true,
            guestPreferencesIsolated: true,
            guestNodeAccess,
            guestPopupCreatedChild: false,
            existingRegisterSchemeNativeModuleLoaded: true,
            networkCalls: network.calls.length
        };
    } finally {
        for (const win of [wrongSessionWindow, remoteWindow, mainWindow]) {
            try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
        }
        if (server) {
            try { server.closeAllConnections(); } catch (_) {}
            await new Promise(resolve => server.close(resolve));
        }
        await delay(100);
    }
}

app.whenReady().then(async () => {
    let exitCode = 0;
    try {
        const result = await run();
        console.log(`SAIL_SECURITY_RUNTIME ${JSON.stringify(result)}`);
    } catch (error) {
        exitCode = 1;
        console.error(`SAIL_SECURITY_RUNTIME_FAILED ${error && error.stack ? error.stack : 'Unknown failure'}`);
    } finally {
        process.exit(exitCode);
    }
});
