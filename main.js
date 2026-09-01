const { app, BrowserWindow, ipcMain: electronIpcMain, dialog, shell, screen, Tray, Menu, session, safeStorage, Notification, net } = require('electron');
const { exec, execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const dnsPromises = require('node:dns').promises;
const nodeNet = require('node:net');
const unrar = require('node-unrar-js');
const _7z = require('7zip-min');
try {
    const pathTo7zip = _7z.getConfig().binaryPath.replace('app.asar', 'app.asar.unpacked');
    _7z.config({ binaryPath: pathTo7zip });
} catch (e) {
    console.error('Failed to configure 7zip-min path:', e);
}
const DiscordRPC = require('discord-rpc');
const cloudSync = require('./cloudSync');
const { registerMaintenanceIpc } = require('./maintenance/ipc');
const { detectLudusaviSaveCandidates, loadLudusaviManifest } = require('./maintenance/ludusavi');
const { scanSaveCandidates } = require('./maintenance/saveScanner');
const { registerAccountIpc } = require('./accounts/ipc');
const { registerAchievementIpc } = require('./achievements/ipc');
const { findSteamRoot, resolveInstalledSteamApp } = require('./achievements/achievementDiscovery');
const { RecoveryJournal } = require('./runtime/recoveryJournal');
const { DownloadJobDirectoryRegistry } = require('./runtime/downloadJobCleanup');
const { registerDownloadCancellationIpc } = require('./runtime/downloadIpc');
const { BrowserDownloadIntentRegistry, createBrowserWillDownloadHandler, createPrepareBrowserDownloadHandler } = require('./runtime/browserDownloadIntents');
const {
    ManagedVerificationCoordinator,
    mergeRefreshedDownload,
    shouldPreservePartialForRetry
} = require('./runtime/downloadResolutionLifecycle');
const { createDownloadWorkCoordinator } = require('./runtime/downloadWorkCoordinator');
const { runOwnedChildProcess } = require('./runtime/ownedChildProcess');
const { runOwnedWorker } = require('./runtime/ownedWorker');
const { DownloadQuarantineCatalog, registerDownloadQuarantineIpc } = require('./runtime/downloadQuarantine');
const { removeOwnedInstallDirectory, strictChildPath } = require('./runtime/gameUninstall');
const {
    AKIRABOX_HOST_RE,
    BUZZHEAVIER_HOST_RE,
    DATANODES_BROWSER_TRANSFER_AUTHORITY,
    DATANODES_HOST_RE,
    FILEDITCH_HOST_RE,
    FILEKEEPER_HOST_RE,
    FUCKINGFAST_HOST_RE,
    PIXELDRAIN_HOST_RE,
    ROOTZ_HOST_RE,
    VIKINGFILE_HOST_RE,
    X1337_HOST_RE,
    credentialFreeHttpsUrl,
    extractDataNodesBrowserDownload,
    extractFuckingFastBrowserDownload,
    fileKeeperDownloadUrl,
    gofileShareDetails,
    managedHostTransferRequest,
    resolve1337xUrl,
    resolveAkiraBoxUrl,
    resolveBuzzHeavierUrl,
    resolveDataNodesUrl,
    resolveFileDitchUrl,
    resolveFileKeeperUrl,
    resolveGofileUrl,
    resolveMegaDbUrl,
    resolvePixeldrainUrl,
    resolveRootzUrl,
    resolveVikingFileUrl,
    validateDataNodesBrowserTransfer
} = require('./runtime/downloadHostResolvers');
const {
    FILECRYPT_CHALLENGE_EXPRESSION,
    fileCryptLinkCandidates,
    fileCryptSubmitExpression,
    normalizeFileCryptContainerUrl,
    solveFileCryptProof
} = require('./runtime/fileCryptResolver');
const {
    HEALTH_STATES,
    classifyFileCryptResponse,
    createDownloadLinkHealthChecker,
    isHealthTargetAllowed
} = require('./runtime/downloadLinkHealth');
const {
    DEFAULT_VERIFICATION_RESOURCE_HOSTS,
    findSystemChromiumExecutable,
    resolveWithSystemChromium,
    verificationNeedsAttention
} = require('./runtime/systemBrowserResolver');
const DownloadSourceLogic = require('./ui/downloadSourceLogic');
const ARCHIVE_EXTRACT_WORKER = path.join(__dirname, 'runtime', 'archiveExtractWorker.js');
const DOWNLOAD_PREPARATION_WORKER = path.join(__dirname, 'runtime', 'downloadPreparationWorker.js');
const { createAuthorizedIpcRegistrar, createTrustedFrameAuthorizer } = require('./security/ipcAuthorization');
const { createArchivePowerShellInvocation, scopedArtifactStems } = require('./security/archiveDataBinding');
const { createExecutionPhaseAuthority } = require('./security/executionPhaseAuthority');
const { LegacyCloudReferenceStore } = require('./security/legacyCloudReferences');
const { registerLaunchStatusIpc } = require('./security/launchStatusIpc');
const { createRemoteDataService, registerRemoteDataIpc } = require('./security/remoteData');
const { canonicalPortableBytes } = require('./sync/portableArtifactV3');
const {
    SOURCES_PARTITION,
    installIsolatedRemoteNavigationPolicy,
    installMainNavigationPolicy,
    installWebviewAttachmentPolicy,
    openExternalWebUrl
} = require('./security/navigationPolicy');
const args = process.argv;
if (args.includes('--sail-ui-probe')) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('use-angle', 'swiftshader');
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
let autoLaunchGameId = null;
const launchArg = args.find(a => a.startsWith('--launch-game-id='));
if (launchArg) autoLaunchGameId = launchArg.split('=')[1].replace(/"/g, '');

const startHidden = args.includes('--hidden');
let activeBackupProcess = null;
let backingUpZipPath = null;
const uninstallingGameIds = new Set();
let tray = null;
let maintenanceService = null;
let accountServices = null;
let achievementService = null;
let mainWindow = null;
let hostTransferProbeStarted = false;
const fullscreenControllers = new WeakMap();
const fullscreenStates = new WeakMap();
const sailHubGuestContents = new Set();
let runtimeRecovery = null;
let runtimeMonitorTimer = null;
let runtimeMonitorBusy = false;
let deferredQuitRequested = false;
let deferredQuitSyncDeadline = 0;
let deferredQuitTimer = null;
const runtimeProcessMisses = new Map();
let isQuitting = false;
let exitSynced = false;

let exitWhenClosedSetting = false;
let devToolsEnabled = false;
function resolveLocallyInstalledSteamAppId(appId) {
    return resolveInstalledSteamApp(appId);
}

function isLocallyInstalledSteamAppId(appId) {
    return !!resolveLocallyInstalledSteamAppId(appId);
}
const trustedEntryPath = path.join(__dirname, 'index.html');
const authorizeIpcEvent = createTrustedFrameAuthorizer({
    getMainWindow: () => mainWindow,
    trustedEntryPath
});
const ipcMain = createAuthorizedIpcRegistrar(electronIpcMain, authorizeIpcEvent);
ipcMain.on('set-exit-behavior', (e, val) => exitWhenClosedSetting = val);
ipcMain.on('set-devtools-setting', (e, val) => devToolsEnabled = val);

function getRunningProcessSnapshot() {
    return new Promise(resolve => {
        execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            if (error) return resolve({ names: new Set(), pids: new Set(), byPid: new Map() });
            const names = new Set();
            const pids = new Set();
            const byPid = new Map();
            for (const line of String(stdout || '').split(/\r?\n/)) {
                const match = line.match(/^"([^"]*)","(\d+)"/);
                if (!match) continue;
                const name = match[1].toLowerCase();
                const pid = Number(match[2]);
                names.add(name);
                pids.add(pid);
                byPid.set(pid, name);
            }
            resolve({ names, pids, byPid });
        });
    });
}

function sendRuntimeSessionEnded(event) {
    if (!event) return;
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('runtime-session-ended', event);
    }
}

function finishRuntimeSession(payload) {
    if (!runtimeRecovery) return null;
    const event = runtimeRecovery.finishSession(payload);
    if (event) sendRuntimeSessionEnded(event);
    evaluateDeferredQuit();
    return event;
}

async function monitorRuntimeSessions() {
    if (!runtimeRecovery || runtimeMonitorBusy) return;
    runtimeMonitorBusy = true;
    try {
        const snapshot = runtimeRecovery.snapshot();
        const sessions = Object.values(snapshot.activeSessions || {});
        if (!sessions.length) {
            evaluateDeferredQuit();
            return;
        }
        const running = await getRunningProcessSnapshot();
        const now = Date.now();
        for (const session of sessions) {
            const expectedName = String(session.exeName || '').toLowerCase();
            const detectedByName = expectedName && running.names.has(expectedName);
            const detectedByPid = session.pid && running.pids.has(Number(session.pid))
                && (!expectedName || running.byPid.get(Number(session.pid)) === expectedName);
            const detected = detectedByName || detectedByPid;
            if (detected) {
                runtimeProcessMisses.delete(session.sessionId);
                runtimeRecovery.touchSession({ gameId: session.gameId, libraryKey: session.libraryKey, sessionId: session.sessionId, observedAt: now });
                continue;
            }
            const misses = (runtimeProcessMisses.get(session.sessionId) || 0) + 1;
            runtimeProcessMisses.set(session.sessionId, misses);
            const staleRecoveredSession = session.recovered && now - session.lastHeartbeatAt > 15000;
            const launchGraceExpired = session.processConfirmed || now - session.startedAt > 45000;
            if (!staleRecoveredSession && (!launchGraceExpired || misses < 3)) continue;
            if (staleRecoveredSession && misses < 3) continue;
            runtimeProcessMisses.delete(session.sessionId);
            finishRuntimeSession({
                gameId: session.gameId,
                libraryKey: session.libraryKey,
                sessionId: session.sessionId,
                endedAt: session.recovered ? session.lastHeartbeatAt : now,
                reason: session.recovered ? 'launcher-recovered-session' : 'process-exited'
            });
        }
    } finally {
        runtimeMonitorBusy = false;
    }
}

function startRuntimeMonitor() {
    clearInterval(runtimeMonitorTimer);
    runtimeMonitorTimer = setInterval(() => monitorRuntimeSessions().catch(() => {}), 10000);
    if (runtimeMonitorTimer.unref) runtimeMonitorTimer.unref();
    monitorRuntimeSessions().catch(() => {});
}

function postExitWorkStillRunning(snapshot) {
    return (snapshot.postExitJobs || []).some(job => [job.save, job.config].some(operation =>
        operation && operation.required && ['pending', 'running'].includes(operation.status)
    ));
}

function evaluateDeferredQuit() {
    if (!deferredQuitRequested || !runtimeRecovery) return;
    const snapshot = runtimeRecovery.snapshot();
    if (Object.keys(snapshot.activeSessions || {}).length) return;
    if (!deferredQuitSyncDeadline) deferredQuitSyncDeadline = Date.now() + 120000;
    if (postExitWorkStillRunning(snapshot) && Date.now() < deferredQuitSyncDeadline) {
        clearTimeout(deferredQuitTimer);
        deferredQuitTimer = setTimeout(evaluateDeferredQuit, 1000);
        return;
    }
    deferredQuitRequested = false;
    clearTimeout(deferredQuitTimer);
    isQuitting = true;
    app.quit();
}

function deferQuitForRuntimeWork() {
    if (!runtimeRecovery) return false;
    const snapshot = runtimeRecovery.snapshot();
    const hasActiveGame = Object.keys(snapshot.activeSessions || {}).length > 0;
    const hasActiveSaveWork = postExitWorkStillRunning(snapshot);
    if (!hasActiveGame && !hasActiveSaveWork) return false;
    deferredQuitRequested = true;
    deferredQuitSyncDeadline = hasActiveGame ? 0 : Date.now() + 120000;
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.hide();
    }
    try {
        if (tray && typeof tray.displayBalloon === 'function') {
            tray.displayBalloon({
                title: 'Sail is protecting this session',
                content: hasActiveGame
                    ? 'Sail will stay in the tray until the game closes and its save work finishes.'
                    : 'Sail will finish the current save operation before closing.'
            });
        }
    } catch (_) {}
    evaluateDeferredQuit();
    return true;
}

function requestApplicationQuit() {
    if (deferQuitForRuntimeWork()) return false;
    isQuitting = true;
    app.quit();
    return true;
}

let currentInstallerMute = true;
ipcMain.on('toggle-installer-mute', (e, state) => {
    currentInstallerMute = !!state;
    try { require('fs').writeFileSync(require('path').join(app.getPath('userData'), '.installer_mute'), state ? '1' : '0'); } catch(e) {}
});

// --- DISCORD RPC ENGINE (WITH RETRY SYSTEM) ---
const clientId = '1486922616701849700';
const SAIL_WEBSITE_URL = 'https://sail-launcher.sailhub.fyi';
const SAIL_HUB_MODS_ORIGIN = SAIL_WEBSITE_URL;
const SAIL_HUB_MODS_PARTITION = 'persist:sailhub-mods';

function isSailHubModsUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl) return false;
    try {
        const parsed = new URL(rawUrl);
        return parsed.origin === SAIL_HUB_MODS_ORIGIN && parsed.pathname === '/plugins';
    } catch (_) {
        return false;
    }
}

async function syncSailHubGuestAuth(guestContents) {
    if (!guestContents || typeof guestContents.getURL !== 'function'
        || (typeof guestContents.isDestroyed === 'function' && guestContents.isDestroyed())
        || !isSailHubModsUrl(guestContents.getURL())) return;

    let session = null;
    try {
        session = accountServices && accountServices.accountService
            ? await accountServices.accountService.session()
            : null;
    } catch (error) {
        console.error('Sail Hub account session restore failed:', error && error.message || error);
        return;
    }

    const handoff = session && typeof session.access_token === 'string' && typeof session.refresh_token === 'string'
        ? { access_token: session.access_token, refresh_token: session.refresh_token }
        : null;
    const serialized = JSON.stringify(handoff);
    const script = `(async (launcherSession) => {
        let client = window.sailSupabase;
        for (let attempt = 0; !client?.auth && attempt < 20; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
            client = window.sailSupabase;
        }
        if (!client?.auth) return;
        if (launcherSession) {
            const result = await client.auth.setSession(launcherSession);
            if (result && result.error) throw result.error;
        } else {
            await client.auth.signOut({ scope: 'local' });
        }
        if (typeof window.refreshAuth === 'function') await window.refreshAuth();
    })(${serialized})`;

    try {
        await guestContents.executeJavaScript(script, true);
    } catch (error) {
        console.error('Sail Hub account session restore failed:', error && error.message || error);
    }
}

function registerSailHubGuestContents(guestContents) {
    if (!guestContents || guestContents.session !== session.fromPartition(SAIL_HUB_MODS_PARTITION)) return;
    sailHubGuestContents.add(guestContents);
    const sync = () => { syncSailHubGuestAuth(guestContents).catch(() => {}); };
    guestContents.on('did-finish-load', sync);
    guestContents.once('destroyed', () => sailHubGuestContents.delete(guestContents));
    sync();
}

function notifySailHubGuestAuthChange() {
    for (const guestContents of sailHubGuestContents) {
        syncSailHubGuestAuth(guestContents).catch(() => {});
    }
}

let rpc = null;
let rpcEnabled = true;
let rpcRetryInterval = null;

function setActivity(gameName) {
    if (!rpc || !rpcEnabled) {
        console.log(`RPC skip: rpc=${!!rpc}, enabled=${rpcEnabled}`);
        return;
    }
    try {
        const activity = gameName ? {
            details: 'Playing',
            state: gameName,
            buttons: [{ label: 'Sail Launcher', url: SAIL_WEBSITE_URL }],
            instance: false,
        } : {
            details: 'Browsing Library',
            state: 'Looking for something to play',
            buttons: [{ label: 'Sail Launcher', url: SAIL_WEBSITE_URL }],
            instance: false,
        };
        
        console.log("Updating Discord Activity:", activity.state || "Idle");
        rpc.setActivity(activity).catch(err => console.error("RPC setActivity Error:", err));
    } catch (e) {
        console.error("RPC setActivity Exception:", e);
    }
}

function findBestExe(folderPath, gameName = "") {
    let bestExe = null;
    let maxRes = -1;
    const cleanGameName = gameName ? gameName.toLowerCase().replace(/[^a-z0-9]/g, '') : "";

    function scan(dir) {
        if (!fs.existsSync(dir)) return;
        let files;
        try { files = fs.readdirSync(dir); } catch(e) { return; }
        
        for (const file of files) {
            const full = path.join(dir, file);
            let stat;
            try { stat = fs.lstatSync(full); } catch(e) { continue; }
            // Maintenance and executable discovery must never traverse links/junctions outside
            // the installation that the user selected.
            if (stat.isSymbolicLink()) continue;
            
            if (stat.isDirectory()) {
                const lowerDir = file.toLowerCase();
                if (lowerDir.includes('redist') || lowerDir.includes('engine') || lowerDir.includes('extra') || lowerDir.includes('commonredist') || lowerDir.includes('__installer')) continue;
                scan(full);
            } else if (file.toLowerCase().endsWith('.exe')) {
                const lowerFile = file.toLowerCase();
                if (lowerFile.includes('unins') || lowerFile.includes('crash') || lowerFile.includes('helper') || lowerFile.includes('setup') || lowerFile.includes('reporter') || lowerFile.includes('overlay')) continue;
                
                let score = stat.size;
                // Boost score if the file name contains the game name
                if (cleanGameName && lowerFile.replace(/[^a-z0-9]/g, '').includes(cleanGameName)) {
                    score += 1000000000; // Big boost for name matching
                }

                if (score > maxRes) {
                    maxRes = score;
                    bestExe = full;
                }
            }
        }
    }
    scan(folderPath);
    return bestExe;
}

function connectRPC() {
    if (!rpcEnabled) return;
    if (rpc) {
        console.log("RPC already connected.");
        return;
    }
    
    console.log("Attempting to connect to Discord RPC with Client ID:", clientId);
    const tempRpc = new DiscordRPC.Client({ transport: 'ipc' });

    tempRpc.on('ready', () => {
        console.log("Discord RPC Connected Successfully! (ready event)");
        rpc = tempRpc;
        if (rpcRetryInterval) { clearInterval(rpcRetryInterval); rpcRetryInterval = null; }
        setActivity(null);
    });

    tempRpc.on('error', (err) => {
        console.error("Discord RPC Client Error:", err.message);
        rpc = null;
    });

    tempRpc.on('disconnected', () => {
        console.log("Discord RPC Disconnected event.");
        rpc = null;
        if (rpcEnabled && !rpcRetryInterval) {
            rpcRetryInterval = setInterval(connectRPC, 15000);
        }
    });

    tempRpc.login({ clientId }).then(() => {
        console.log("RPC Login promise resolved.");
    }).catch(err => {
        console.log("Discord RPC Login Failed (promise catch):", err.message);
        rpc = null;
        if (!rpcRetryInterval && rpcEnabled) {
            rpcRetryInterval = setInterval(connectRPC, 15000);
        }
    });
}

ipcMain.on('set-rpc-setting', (e, disableRpc) => {
    rpcEnabled = !disableRpc;
    if (rpcEnabled && !rpc) {
        connectRPC();
    } else if (!rpcEnabled) {
        if (rpcRetryInterval) { clearInterval(rpcRetryInterval); rpcRetryInterval = null; }
        if (rpc) {
            rpc.clearActivity().catch(console.error);
            rpc.destroy().catch(console.error);
            rpc = null;
        }
    }
});

ipcMain.on('update-rpc', (e, gameName) => { if (rpcEnabled) setActivity(gameName); });

// --- LAUNCH STATUS ---
registerLaunchStatusIpc(ipcMain, {
    resolveGameMetadata: gameId => gateAProfileStore().activeGameMetadata(gameId)
});

function hostTransferProbePayload(job) {
    if (!job) return { totalBytes: 0, files: [] };
    const roots = [...new Set([job.directory, job.quarantinePath, job.finalDirectory]
        .filter(value => typeof value === 'string' && value))];
    const files = [];
    const walk = (directory, depth = 0) => {
        if (depth > 8 || files.length >= 1000) return;
        let entries;
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
            if (files.length >= 1000) break;
            const fullPath = path.join(directory, entry.name);
            let stats;
            try { stats = fs.lstatSync(fullPath); } catch (_) { continue; }
            if (stats.isSymbolicLink()) continue;
            if (stats.isDirectory()) {
                walk(fullPath, depth + 1);
                continue;
            }
            if (!stats.isFile() || !stats.size || entry.name.endsWith('.aria2')
                || entry.name.startsWith('_cover') || entry.name.startsWith('.')) continue;
            files.push({ name: entry.name.slice(0, 240), bytes: stats.size });
        }
    };
    roots.forEach(root => walk(root));
    return {
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
        files: files.slice(0, 20)
    };
}

async function runHostTransferProbe(win) {
    const fixtures = [
        {
            label: 'Sail FileDitch transfer probe',
            url: process.env.SAIL_FILEDITCH_TRANSFER_PROBE_URL || '',
            expectedHost: 'fileditchfiles.me'
        },
        {
            label: 'Sail BuzzHeavier transfer probe',
            url: process.env.SAIL_BUZZHEAVIER_TRANSFER_PROBE_URL || '',
            expectedHost: 'buzzheavier.com'
        }
    ];
    const report = { startedAt: new Date().toISOString(), fixtures: [] };
    const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

    for (const fixture of fixtures) {
        const row = { label: fixture.label, sourceUrl: fixture.url, expectedHost: fixture.expectedHost };
        let job = null;
        try {
            const start = await win.webContents.executeJavaScript(
                `window.__sailStartHostTransferProbe(${JSON.stringify(fixture)})`, true
            );
            Object.assign(row, { id: start && start.id || '', host: start && start.host || '', buttonText: start && start.buttonText || '' });
            if (!row.id) throw new Error(start && start.error || 'The launcher did not create a download job.');

            const deadline = Date.now() + 120000;
            while (Date.now() < deadline) {
                job = downloadJobDirectories.get(row.id) || job;
                const payload = hostTransferProbePayload(job);
                const state = await win.webContents.executeJavaScript(
                    `window.__sailGetHostTransferProbeState(${JSON.stringify(row.id)})`, true
                );
                row.rendererState = state;
                row.jobState = job && job.state || '';
                row.payload = payload;
                if (payload.totalBytes > 0 && state && (state.sawProcessing || state.completed)) {
                    row.transferComplete = true;
                    break;
                }
                if (state && state.error && !state.sawProcessing) {
                    row.error = state.error;
                    break;
                }
                await pause(200);
            }
            if (!row.transferComplete && !row.error) row.error = 'Timed out before a complete payload transfer was observed.';
        } catch (error) {
            row.error = error && error.message || String(error);
        } finally {
            if (row.id) {
                try {
                    row.cancellation = await win.webContents.executeJavaScript(
                        `window.__sailCancelHostTransferProbe(${JSON.stringify(row.id)})`, true
                    );
                } catch (_) {}
                await pause(500);
                row.payload = hostTransferProbePayload(job);
            }
        }
        row.passed = row.transferComplete === true
            && row.payload && row.payload.totalBytes > 0
            && row.host === row.expectedHost
            && /^⬇️ Download/.test(row.buttonText || '');
        report.fixtures.push(row);
    }

    report.finishedAt = new Date().toISOString();
    report.passed = report.fixtures.length === fixtures.length && report.fixtures.every(row => row.passed);
    const reportPath = path.join(app.getPath('userData'), 'sail-host-transfer-probe.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    app.exit(report.passed ? 0 : 4);
}

function createWindow() {
    const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');
    let state = { width: 1300, height: 850 };
    try { if (fs.existsSync(windowStatePath)) state = JSON.parse(fs.readFileSync(windowStatePath, 'utf8')); } catch (e) { }

    const win = new BrowserWindow({
        width: state.width, height: state.height, x: state.x, y: state.y, frame: false, titleBarStyle: 'hidden', transparent: true,
        icon: path.join(__dirname, 'icon.ico'),
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: true, webviewTag: true }
    });
    mainWindow = win;
    win.once('closed', () => {
        if (mainWindow === win) mainWindow = null;
    });

    win.once('ready-to-show', () => {
        if (!startHidden && !win.isDestroyed()) win.show();
    });

    const saveBounds = () => {
        if (!win.isMaximized() && !win.isMinimized() && !isWindowFullscreen(win)) {
            try { fs.writeFileSync(windowStatePath, JSON.stringify(win.getBounds())); } catch (e) { }
        }
    };
    let saveBoundsTimeout;
    const debouncedSaveBounds = () => {
        clearTimeout(saveBoundsTimeout);
        saveBoundsTimeout = setTimeout(saveBounds, 500);
    };

    win.on('close', saveBounds);
    win.on('resized', debouncedSaveBounds);
    win.on('moved', debouncedSaveBounds);
    let restoreNormalWindowLevelAfterFullscreen = false;
    let normalWindowStateBeforeFullscreen = null;
    let fullscreenDisplayTransferPending = false;
    let restoreNormalWindowStateTimeout = null;
    const sendFullscreenState = (active = win.isFullScreen()) => {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('window-fullscreen-changed', active === true);
        }
    };
    const rememberNormalWindowState = () => {
        if (normalWindowStateBeforeFullscreen || win.isDestroyed()) return;
        const wasMaximized = win.isMaximized();
        normalWindowStateBeforeFullscreen = {
            bounds: wasMaximized ? win.getNormalBounds() : win.getBounds(),
            wasMaximized
        };
    };
    const restoreNormalWindowState = (attempt = 0) => {
        if (!normalWindowStateBeforeFullscreen || fullscreenDisplayTransferPending || win.isDestroyed()) return;
        clearTimeout(restoreNormalWindowStateTimeout);
        restoreNormalWindowStateTimeout = setTimeout(() => {
            if (!normalWindowStateBeforeFullscreen || fullscreenDisplayTransferPending || win.isDestroyed() || isWindowFullscreen(win)) return;
            if (win.isFullScreen()) {
                if (attempt < 20) restoreNormalWindowState(attempt + 1);
                return;
            }

            const previousState = normalWindowStateBeforeFullscreen;
            normalWindowStateBeforeFullscreen = null;
            if (previousState.wasMaximized) {
                win.setBounds(previousState.bounds);
                win.maximize();
            } else {
                if (win.isMaximized()) win.unmaximize();
                win.setBounds(previousState.bounds);
            }
        }, attempt === 0 ? 0 : 16);
    };
    const raiseFullscreenWindowLevel = () => {
        // Fullscreen docks such as MyDockFinder can stay above an ordinary
        // Electron fullscreen window. Raise Sail only for the fullscreen
        // session so the desktop chrome hides and the exit control stays usable.
        if (!win.isAlwaysOnTop()) {
            restoreNormalWindowLevelAfterFullscreen = true;
            win.setAlwaysOnTop(true, 'screen-saver');
        }
    };
    const restoreNormalWindowLevel = () => {
        if (restoreNormalWindowLevelAfterFullscreen) {
            restoreNormalWindowLevelAfterFullscreen = false;
            win.setAlwaysOnTop(false);
        }
    };
    const setNativeFullscreen = active => {
        const enabled = active === true;
        if (enabled) rememberNormalWindowState();
        fullscreenStates.set(win, enabled);
        if (enabled) raiseFullscreenWindowLevel();
        win.setFullScreen(enabled);
        if (!enabled) {
            restoreNormalWindowLevel();
            restoreNormalWindowState();
        }
        // Windows can resize synchronously without emitting the macOS-style
        // transition event, so update the renderer immediately as well.
        sendFullscreenState(enabled);
    };
    fullscreenControllers.set(win, {
        setFullscreen: setNativeFullscreen,
        rememberNormalWindowState,
        beginDisplayTransfer: () => { fullscreenDisplayTransferPending = true; },
        finishDisplayTransfer: () => { fullscreenDisplayTransferPending = false; }
    });
    win.on('enter-full-screen', () => {
        fullscreenStates.set(win, true);
        raiseFullscreenWindowLevel();
        sendFullscreenState(true);
    });
    win.on('leave-full-screen', () => {
        fullscreenStates.set(win, false);
        restoreNormalWindowLevel();
        restoreNormalWindowState();
        sendFullscreenState(false);
    });
    win.on('will-move', (event, newBounds) => {
        if (!isWindowFullscreen(win)) return;
        if (normalWindowStateBeforeFullscreen && newBounds) {
            const fullscreenBounds = win.getBounds();
            normalWindowStateBeforeFullscreen.bounds = {
                ...normalWindowStateBeforeFullscreen.bounds,
                x: normalWindowStateBeforeFullscreen.bounds.x + newBounds.x - fullscreenBounds.x,
                y: normalWindowStateBeforeFullscreen.bounds.y + newBounds.y - fullscreenBounds.y
            };
        }
        event.preventDefault();
        setNativeFullscreen(false);
    });
    win.webContents.once('did-finish-load', sendFullscreenState);

    installMainNavigationPolicy(win.webContents, { shell, trustedEntryPath });
    installWebviewAttachmentPolicy(win.webContents, {
        shell,
        session,
        onSailLauncherProtocol: handleProtocolUrl
    });
    win.webContents.on('did-attach-webview', (_event, guestContents) => {
        registerSailHubGuestContents(guestContents);
    });

    // Setup Ad Blocker for Webview and Main Window
    const adBlockList = [
        'doubleclick.net', 'google-analytics.com', 'googlesyndication.com',
        'googleadservices.com', 'googletagservices.com', 'adservice.google.com',
        'adsystem.com', 'popads.net', 'propellerads.com', 'exoclick.com',
        'adnxs.com', 'adroll.com', 'adskeeper.co.uk', 'adsterra.com',
        'mgid.com', 'outbrain.com', 'taboola.com', 'criteo.com',
        'amazon-adsystem.com', 'carbonads.net', 'buysellads.com',
        'adcolony.com', 'unityads', 'applovin.com', 'ironsrc.com',
        'trafficjunky.com', 'a.orstatic.com', 'onclickads.net',
        'onclickperformance.com', 'juicyads.com', 'ero-advertising.com',
        'exosrv.com', 'ad-delivery.net', 'nativeads.com', 'adzerk.net',
        'smartadserver.com', 'onclickgo.com', 'onclickalgo.com', 'ad-revenue.com',
        'ad-delivery', 'adcontent', 'analytics'
    ];

    const patchSailhubHeaders = (details, callback) => {
        const h = details.requestHeaders;
        const uaKey = Object.keys(h).find(k => k.toLowerCase() === 'user-agent');
        if (uaKey) h[uaKey] = h[uaKey].replace(/\s*Electron\/[\d.]+/g, '').trim();
        const chuaKey = Object.keys(h).find(k => k.toLowerCase() === 'sec-ch-ua');
        if (chuaKey) h[chuaKey] = h[chuaKey].replace(/"Electron";v="[^"]*",?\s*/g, '').replace(/,\s*$/, '').trim();
        const refKey = Object.keys(h).find(k => k.toLowerCase() === 'referer');
        if (refKey && h[refKey].startsWith('file://')) delete h[refKey];
        callback({ requestHeaders: h });
    };
    const sailhubHeaderUrls = ['https://sailhub.fyi/*', 'https://*.sailhub.fyi/*'];
    win.webContents.session.webRequest.onBeforeSendHeaders({ urls: sailhubHeaderUrls }, patchSailhubHeaders);
    session.fromPartition('persist:sailhub-mods').webRequest.onBeforeSendHeaders({ urls: sailhubHeaderUrls }, patchSailhubHeaders);


    win.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        const url = details.url.toLowerCase();
        const shouldBlock = adBlockList.some(domain => url.includes(domain));
        if (shouldBlock) {
            callback({ cancel: true });
        } else {
            callback({ cancel: false });
        }
    });

    const handleSessionDownload = createBrowserWillDownloadHandler({
        intents: browserDownloadIntents,
        isCaptureEnabled: () => browserDownloadCapture.enabled,
        isRegistered: webContentsId => browserDownloadWebContents.has(webContentsId),
        capture: (item, webContentsId, intent) => captureBrowserDownload(win.webContents, item, webContentsId, intent),
        fallback(event, item, downloadWebContents) {
        if (downloadWebContents && managedResolverWebContents.has(downloadWebContents.id)) return;
        item.pause();
        const filename = item.getFilename();
        dialog.showSaveDialog(win, {
            defaultPath: path.join(app.getPath('downloads'), filename),
            title: 'Choose Download Location'
        }).then(result => {
            if (result.canceled || !result.filePath) {
                item.cancel();
            } else {
                item.setSavePath(result.filePath);
                item.resume();
            }
        });
        }
    });
    const downloadSessions = new Set([
        win.webContents.session,
        session.fromPartition('persist:sailhub-mods'),
        session.fromPartition(SOURCES_PARTITION)
    ]);
    for (const downloadSession of downloadSessions) downloadSession.on('will-download', handleSessionDownload);

    win.webContents.on('context-menu', (e, props) => {
        if (devToolsEnabled) {
            Menu.buildFromTemplate([{ label: 'Inspect Element', click: () => win.webContents.inspectElement(props.x, props.y) }]).popup(win);
        }
    });

    win.webContents.on('before-input-event', (event, input) => {
        if (!devToolsEnabled && input.type === 'keyDown' && ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12')) {
            event.preventDefault();
        }
    });

    let rendererRecoveryAttempts = 0;
    let rendererRecoveryResetTimer = null;
    win.webContents.on('did-finish-load', () => {
        clearTimeout(rendererRecoveryResetTimer);
        rendererRecoveryResetTimer = setTimeout(() => { rendererRecoveryAttempts = 0; }, 30000);
        if (process.argv.includes('--sail-ui-probe')) {
            setTimeout(async () => {
                try {
                    const result = await win.webContents.executeJavaScript(`(async () => {
                        const page = document.getElementById('gamePageView');
                        const layout = document.getElementById('gpContentLayout');
                        const panel = document.getElementById('gpAchievementsPanel');
                        const browse = document.getElementById('achievementBrowseList');
                        const recent = document.getElementById('achievementRecentList');
                        const sample = document.createElement('div');
                        sample.className = 'achievement-row is-openable';
                        sample.setAttribute('data-achievement-open', '0');
                        if (recent) recent.appendChild(sample);
                        const clicked = [];
                        const previous = window.achievementOpenGame;
                        window.achievementOpenGame = index => clicked.push(index);
                        if (sample) sample.click();
                        if (recent) recent.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                        window.achievementOpenGame = previous;
                        if (sample && sample.parentNode) sample.parentNode.removeChild(sample);
                        page.classList.add('compact-game-page');
                        layout.style.display = 'none';
                        panel.hidden = false;
                        const compactLayoutDisplay = getComputedStyle(layout).display;
                        const compactPanelDisplay = getComputedStyle(panel).display;
                        page.classList.remove('compact-game-page');
                        layout.style.display = '';
                        const quarantineSummary = await window.refreshDownloadQuarantine();
                        const refusedQuarantinePath = await require('electron').ipcRenderer.invoke('open-download-quarantine', 'C:\\\\not-a-quarantine-token');
                        const retainedCopy = require('./ui/downloadQuarantine').cancellationMessage({ status: 'cancelled_quarantined', retained: true });
                        const quarantinePanel = document.getElementById('downloadQuarantinePanel');
                        const quarantineSummaryText = document.getElementById('downloadQuarantineSummary');
                        const quarantinePanelStateCorrect = quarantineSummary.itemCount > 0
                            ? getComputedStyle(quarantinePanel).display !== 'none'
                                && quarantineSummaryText.textContent.includes(String(quarantineSummary.itemCount))
                                && !!document.querySelector('#downloadQuarantineRoots button')
                            : getComputedStyle(quarantinePanel).display === 'none';
                        const hostProbe = typeof window.__sailProbeDownloadHostButtons === 'function'
                            ? window.__sailProbeDownloadHostButtons()
                            : { buttons: [], clicks: [], browserOpens: [] };
                        const sourceWebview = document.getElementById('sourceWebview');
                        let sourceBrowserLoad = null;
                        if (sourceWebview && typeof sourceWebview.loadURL === 'function') {
                            const originalLoadURL = sourceWebview.loadURL;
                            sourceWebview.loadURL = (url, options) => {
                                sourceBrowserLoad = { url, options };
                                return Promise.resolve();
                            };
                            window.openSourcesBrowser(
                                'https://megadb.net/referrer-probe',
                                false,
                                { referrer: 'https://steamrip.com/referrer-probe/' }
                            );
                            sourceWebview.loadURL = originalLoadURL;
                        }
                        return {
                            panelInsideContentLayout: !!(layout && panel && layout.contains(panel)),
                            hasBrowseList: !!browse,
                            hasRecentList: !!recent,
                            hasBrowseMore: !!document.getElementById('achievementBrowseMore'),
                            hasHubViewToggle: !!document.querySelector('[data-hub-view="browse"]'),
                            hasHubPanes: !!document.querySelector('.achievement-hub-panes'),
                            compactLayoutDisplay,
                            compactPanelDisplay,
                            recentClickOpened: clicked.includes(0),
                            hasQuarantinePanel: !!document.getElementById('downloadQuarantinePanel'),
                            hasQuarantineRefresh: typeof window.refreshDownloadQuarantine === 'function',
                            quarantineSummaryShape: !!quarantineSummary && Array.isArray(quarantineSummary.roots),
                            quarantineItemCount: quarantineSummary.itemCount,
                            quarantinePanelStateCorrect,
                            rendererPathOpenRefused: refusedQuarantinePath && refusedQuarantinePath.status === 'open_refused',
                            retainedCopyTruthful: retainedCopy === 'Download cancelled. Temporary files were retained in quarantine for safety.',
                            hostProbeButtons: hostProbe.buttons,
                            hostProbeClicks: hostProbe.clicks,
                            hostProbeBrowserOpens: hostProbe.browserOpens,
                            directHostButtons: hostProbe.buttons.length === 9
                                && hostProbe.buttons.filter(row => row.host !== 'akirabox.to').every(row => /^⬇️ Download/.test(row.text))
                                && hostProbe.buttons.some(row => row.host === 'akirabox.to' && /^🌐 Open in Browser/.test(row.text)),
                            directHostClicks: hostProbe.clicks.map(row => row.host).sort().join(',')
                                === '1337x.to,bzzhr.to,datanodes.to,fileditchfiles.me,fuckingfast,gofile.io,rootz.so,vikingfile.com'
                                && hostProbe.clicks.some(row => row.host === 'fuckingfast' && row.partCount === 2)
                                && hostProbe.browserOpens.length === 1
                                && hostProbe.browserOpens[0].url === 'https://akirabox.to/probe-file/game.rar'
                                && hostProbe.browserOpens[0].system === true,
                            sourceBrowserReferrerForwarded: sourceBrowserLoad
                                && sourceBrowserLoad.url === 'https://megadb.net/referrer-probe'
                                && sourceBrowserLoad.options
                                && sourceBrowserLoad.options.httpReferrer === 'https://steamrip.com/referrer-probe/',
                            lessAnimationsNukesAll: !![...document.styleSheets].some(sheet => {
                                try {
                                    return [...sheet.cssRules].some(rule => String(rule.selectorText || '').includes('body.less-animations *:not(.spin-icon)'));
                                } catch (_) { return false; }
                            })
                        };
                    })()`);
                    const reportPath = require('path').join(app.getPath('userData'), 'sail-ui-probe.json');
                    require('fs').mkdirSync(require('path').dirname(reportPath), { recursive: true });
                    require('fs').writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`);
                    app.exit(result.panelInsideContentLayout || !result.hasBrowseList || !result.hasRecentList
                        || result.compactPanelDisplay === 'none' || !result.recentClickOpened || result.lessAnimationsNukesAll
                        || !result.hasQuarantinePanel || !result.hasQuarantineRefresh || !result.quarantineSummaryShape
                        || !result.quarantinePanelStateCorrect || !result.rendererPathOpenRefused || !result.retainedCopyTruthful
                        || !result.directHostButtons || !result.directHostClicks
                        || !result.sourceBrowserReferrerForwarded ? 2 : 0);
                } catch (error) {
                    console.error(error);
                    app.exit(3);
                }
            }, 1500);
        }
        if (process.argv.includes('--sail-host-transfer-probe') && !hostTransferProbeStarted) {
            hostTransferProbeStarted = true;
            setTimeout(() => {
                runHostTransferProbe(win).catch(error => {
                    const reportPath = path.join(app.getPath('userData'), 'sail-host-transfer-probe.json');
                    try {
                        fs.writeFileSync(reportPath, `${JSON.stringify({
                            startedAt: new Date().toISOString(),
                            passed: false,
                            error: error && error.message || String(error)
                        }, null, 2)}\n`);
                    } catch (_) {}
                    app.exit(5);
                });
            }, 1500);
        }
    });
    win.webContents.on('render-process-gone', (_event, details) => {
        if (isQuitting || win.isDestroyed() || details.reason === 'clean-exit') return;
        if (rendererRecoveryAttempts >= 2) return;
        rendererRecoveryAttempts += 1;
        setTimeout(() => {
            if (!isQuitting && !win.isDestroyed()) win.reload();
        }, 800);
    });

    win.on('close', (event) => {
        if (!isQuitting && !exitWhenClosedSetting) {
            event.preventDefault();
            win.hide();
            return;
        }

        if (!isQuitting && deferQuitForRuntimeWork()) {
            event.preventDefault();
            win.hide();
            return;
        }

        if (!exitSynced) {
            event.preventDefault();
            win.webContents.send('exit-sync-request');
            setTimeout(() => {
                if (!exitSynced) {
                    exitSynced = true;
                    isQuitting = true;
                    app.quit();
                }
            }, 5000);
        }
    });

    // Register every lifecycle/download/probe listener before navigation. Packaged ASAR
    // loads are fast enough to finish before late listeners are attached otherwise.
    win.loadFile('index.html');
}

// Restart App Hook
ipcMain.on('restart-app', () => {
    app.relaunch();
    app.exit(0);
});

ipcMain.handle('get-user-data', () => app.getPath('userData'));
ipcMain.handle('get-auto-launch', () => autoLaunchGameId);

ipcMain.handle('search-steam-workshop', async (e, payload) => {
    const input = exactGateAPayload(payload, ['gameId', 'steamAppId', 'query', 'page'], 'Steam Workshop search');
    const game = gateAProfileStore().activeGameMetadata(input.gameId);
    const appId = String(input.steamAppId || '');
    const query = typeof input.query === 'string' ? input.query.slice(0, 256) : '';
    const page = Number.isSafeInteger(input.page) && input.page >= 1 && input.page <= 100 ? input.page : 1;
    if (!/^\d{1,12}$/.test(appId) || String(game.steamAppId || '') !== appId) {
        throw new Error('Steam Workshop search does not match the active game.');
    }
    return new Promise((resolve) => {
        const https = require('https');
        const url = `https://steamcommunity.com/workshop/browse/?appid=${appId}&searchtext=${encodeURIComponent(query)}&browsesort=trend&section=readytouseitems&p=${page}`;
        
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Encoding': 'gzip, deflate'
            }
        };
        
        https.get(url, options, (res) => {
            const chunks = [];
            let total = 0;
            res.on('data', (chunk) => {
                total += chunk.length;
                if (total > 2 * 1024 * 1024) {
                    res.destroy(new Error('Steam Workshop response exceeded the allowed size.'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    const encoding = res.headers['content-encoding'];
                    let html = '';
                    const zlib = require('zlib');
                    
                    if (encoding === 'gzip') {
                        html = zlib.gunzipSync(buffer).toString('utf8');
                    } else if (encoding === 'deflate') {
                        html = zlib.inflateSync(buffer).toString('utf8');
                    } else {
                        html = buffer.toString('utf8');
                    }
                    
                    // Steam updated to React SSR/hydration. Parse DOM structure.
                    let matches = [...html.matchAll(/href="https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/\?id=(\d+)"[^>]*>\s*<img src="([^"]+)"[^>]*alt="([^"]*)"/g)];
                    let items = matches.map(m => ({ id: m[1], previewUrl: m[2], title: m[3] }));
                    
                    // Fallback to legacy parser
                    if (items.length === 0) {
                        const legacyMatches = [...html.matchAll(/data-publishedfileid="(\d+)".*?src="(.*?)".*?class="workshopItemTitle.*?>(.*?)</gs)];
                        items = legacyMatches.map(m => ({ id: m[1], previewUrl: m[2], title: m[3] }));
                    }
                    resolve(items.slice(0, 60).map(item => ({
                        id: /^\d{1,20}$/.test(String(item.id || '')) ? String(item.id) : '',
                        previewUrl: String(item.previewUrl || '').slice(0, 4096),
                        title: String(item.title || '').replace(/<[^>]*>/g, '').slice(0, 512)
                    })).filter(item => item.id));
                } catch(e) {
                    console.error('Error decoding/parsing workshop search:', e);
                    resolve([]);
                }
            });
        }).on('error', (err) => {
            console.error('HTTPS error searching workshop:', err);
            resolve([]);
        });
    });
});

ipcMain.handle('download-workshop-item', async (e, payload) => {
    const input = exactGateAPayload(payload, ['gameId', 'steamAppId', 'itemId'], 'Steam Workshop download');
    const game = gateAProfileStore().activeGameMetadata(input.gameId);
    const appId = String(input.steamAppId || '');
    const itemId = String(input.itemId || '');
    if (!/^\d{1,12}$/.test(appId) || !/^\d{1,20}$/.test(itemId) || String(game.steamAppId || '') !== appId) {
        throw new Error('Steam Workshop download does not match the active game.');
    }
    return new Promise((resolve) => {
        const steamCmdDir = path.join(app.getPath('userData'), 'steamcmd');
        const steamCmdExe = path.join(steamCmdDir, 'steamcmd.exe');
        
        if (!fs.existsSync(steamCmdDir)) fs.mkdirSync(steamCmdDir, { recursive: true });

        const runSteamCmd = () => {
            const child = spawn(steamCmdExe, ['+login', 'anonymous', '+workshop_download_item', appId, itemId, '+quit']);
            
            child.on('close', (code) => {
                if (code === 0 || code === 7) { // 7 is usually a success code in steamcmd indicating it needs a restart or finished with minor warnings
                    const downloadPath = path.join(steamCmdDir, 'steamapps', 'workshop', 'content', appId, itemId);
                    try {
                        const location = gateAProfileStore().createDirectoryCapability(input.gameId, downloadPath, 'folder-open');
                        resolve({ success: true, location });
                    } catch (error) {
                        resolve({ success: false, error: error.message });
                    }
                } else {
                    resolve({ success: false, error: `SteamCMD exited with code ${code}` });
                }
            });
            child.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });
        };

        if (fs.existsSync(steamCmdExe)) {
            runSteamCmd();
        } else {
            const zipPath = path.join(steamCmdDir, 'steamcmd.zip');
            const file = fs.createWriteStream(zipPath);
            https.get('https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip', (response) => {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    exec(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${steamCmdDir}' -Force"`, { windowsHide: true }, (err) => {
                        fs.unlinkSync(zipPath);
                        if (err) return resolve({ success: false, error: "Failed to extract SteamCMD" });
                        runSteamCmd();
                    });
                });
            }).on('error', (err) => {
                fs.unlink(zipPath, () => {});
                resolve({ success: false, error: "Failed to download SteamCMD" });
            });
        }
    });
});

ipcMain.handle('get-common-paths', () => {
    return { appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA || app.getPath('appData'), documents: app.getPath('documents') };
});

ipcMain.handle('set-autostart', (e, enable) => { app.setLoginItemSettings({ openAtLogin: enable, path: app.getPath('exe'), args: ['--hidden'] }); });
ipcMain.handle('get-autostart', () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle('create-shortcut', (e, payload) => {
    const input = exactGateAPayload(payload, ['gameId', 'capabilityId', 'expectedRevision'], 'Game shortcut');
    const store = gateAProfileStore();
    const resolved = store.resolveExecutionCapability({
        capabilityId: input.capabilityId,
        expectedRevision: input.expectedRevision,
        gameId: input.gameId,
        operation: 'shortcut'
    });
    const metadata = store.activeGameMetadata(input.gameId);
    const safeName = metadata.name.replace(/[<>:"/\\|?*]+/g, '').slice(0, 120) || 'Game';
    const shortcutPath = path.join(app.getPath('desktop'), `${safeName}.lnk`);
    const gameExePath = resolved.details.executablePath || '';
    const ext = path.extname(gameExePath).toLowerCase();
    const iconToUse = !gameExePath || ['.bat', '.cmd', '.lnk'].includes(ext) ? process.execPath : gameExePath;
    shell.writeShortcutLink(shortcutPath, 'create', {
        target: process.execPath,
        args: `--launch-game-id="${metadata.id}"`,
        description: `Launch ${metadata.name}`,
        icon: iconToUse,
        iconIndex: 0
    });
    return true;
});

ipcMain.on('show-game-context', (e, index) => {
    const menu = Menu.buildFromTemplate([
        { label: '▶️ Play Game', click: () => e.sender.send('context-play-game', index) },
        { type: 'separator' },
        { label: '✏️ Edit Game', click: () => e.sender.send('context-edit-game', index) },
        { label: '🗑️ Remove Game from Library', click: () => e.sender.send('context-delete-game', index) }
    ]);
    menu.popup(BrowserWindow.fromWebContents(e.sender));
});

ipcMain.handle('runtime-recovery-state', async () => {
    await monitorRuntimeSessions();
    return runtimeRecovery ? runtimeRecovery.snapshot() : { activeSessions: {}, completedSessions: [], postExitJobs: [] };
});
ipcMain.handle('runtime-session-start', (_event, payload) => runtimeRecovery ? runtimeRecovery.startSession(payload) : null);
ipcMain.handle('runtime-session-observed', (_event, payload) => runtimeRecovery ? runtimeRecovery.touchSession(payload) : null);
ipcMain.handle('runtime-session-finish', (_event, payload) => finishRuntimeSession(payload));
ipcMain.handle('runtime-session-acknowledge', (_event, eventId) => runtimeRecovery ? runtimeRecovery.acknowledgeSession(eventId) : false);
ipcMain.handle('runtime-post-exit-begin', (_event, payload) => runtimeRecovery ? runtimeRecovery.ensurePostExitJob(payload) : null);
ipcMain.handle('runtime-post-exit-update', (_event, payload) => {
    const result = runtimeRecovery ? runtimeRecovery.updatePostExitJob(payload) : null;
    evaluateDeferredQuit();
    return result;
});

function matchingRuntimeGame(item, gameId, libraryKey) {
    return item && item.gameId === gameId && (!libraryKey || item.libraryKey === libraryKey);
}

function removeSailManagedGameFiles(store, gameId, executablePath) {
    const scope = store.authorityScope(gameId);
    const legacyAlias = store.legacyStorageAlias(gameId);
    const [safeName, legacyName = null] = scopedArtifactStems(scope, legacyAlias && legacyAlias.stem || '');
    let removed = 0;
    let failed = 0;
    if (executablePath) {
        const backupDir = path.dirname(path.dirname(executablePath));
        if (fs.existsSync(backupDir)) {
            let filenames = [];
            try { filenames = fs.readdirSync(backupDir); } catch (_) { failed += 1; }
            for (const filename of filenames) {
                const owned = [safeName, legacyName].filter(Boolean).some(stem =>
                    filename === `${stem} backup.zip`
                    || filename.startsWith(`${stem}_backup_`) && filename.endsWith('.zip')
                );
                if (!owned) continue;
                const candidate = path.join(backupDir, filename);
                try {
                    const stat = fs.lstatSync(candidate);
                    if (!stat.isFile() || stat.isSymbolicLink()) continue;
                    fs.unlinkSync(candidate);
                    removed += 1;
                } catch (_) { failed += 1; }
            }
        }
    }
    const saveRoot = path.join(os.homedir(), 'SailLauncherSaves');
    for (const stem of [safeName, legacyName].filter(Boolean)) {
        const candidate = path.join(saveRoot, stem);
        if (!strictChildPath(saveRoot, candidate) || !fs.existsSync(candidate)) continue;
        try {
            const stat = fs.lstatSync(candidate);
            if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
            fs.rmSync(candidate, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
            removed += 1;
        } catch (_) { failed += 1; }
    }
    return {
        removed,
        warning: failed ? 'Some Sail-managed local backups could not be removed.' : ''
    };
}

async function removeSailCloudGameArtifacts(gameId) {
    if (!accountServices || !accountServices.accountService) return { removed: 0, warning: '' };
    try {
        const account = await accountServices.accountService.state();
        if (!account || !account.signedIn) return { removed: 0, warning: '' };
        const files = await accountServices.accountService.listCloudFiles();
        const prefix = `game-config:${gameId}:`;
        const owned = files.filter(file => file.logical_key === `game-save:${gameId}`
            || file.artifact_type === 'game-config' && file.logical_key.startsWith(prefix));
        for (const file of owned) await accountServices.accountService.deleteCloudFile(file.id);
        return { removed: owned.length, warning: '' };
    } catch (error) {
        return {
            removed: 0,
            warning: `The game was uninstalled, but Sail Cloud cleanup did not finish: ${String(error && error.message || 'unknown error').slice(0, 240)}`
        };
    }
}

ipcMain.handle('uninstall-downloaded-game', async (_event, payload) => {
    const input = exactGateAPayload(payload, [
        'gameId', 'capabilityId', 'expectedRevision', 'removeSailData', 'keepSailData'
    ], 'Downloaded game uninstall');
    if (typeof input.removeSailData !== 'boolean' || typeof input.keepSailData !== 'boolean'
        || input.removeSailData && input.keepSailData) {
        throw new Error('The uninstall data choices are invalid.');
    }
    const uninstallGameId = String(input.gameId || '');
    if (uninstallingGameIds.has(uninstallGameId)) throw new Error('This game is already being uninstalled.');
    uninstallingGameIds.add(uninstallGameId);
    try {
        const store = gateAProfileStore();
        const metadata = store.activeGameMetadata(input.gameId);
        if (metadata.source !== 'sail-download') throw new Error('Only games installed by Sail can be uninstalled here.');
        const scope = store.authorityScope(input.gameId);
        const libraryKey = `${scope.profileId}:${scope.libraryId}`;
        const install = store.validateFilesystemCapability({
            gameId: input.gameId,
            capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision,
            operation: 'install-delete'
        });
        const runtimeState = runtimeRecovery ? runtimeRecovery.snapshot() : { activeSessions: {}, postExitJobs: [] };
        if (Object.values(runtimeState.activeSessions || {}).some(item => matchingRuntimeGame(item, input.gameId, libraryKey))) {
            throw new Error('Close the game before uninstalling it.');
        }
        if ((runtimeState.postExitJobs || []).some(item => matchingRuntimeGame(item, input.gameId, libraryKey)
            && [item.save, item.config].some(operation => operation && operation.status === 'running'))) {
            throw new Error('Wait for the game’s current sync operation to finish before uninstalling it.');
        }
        if (activeBackupProcess !== null) throw new Error('Wait for the current game backup to finish before uninstalling.');

        let executablePath = '';
        const authority = store.authorityStatus(input.gameId);
        if (authority.execution && authority.execution.state === 'active') {
            try {
                const execution = store.validateExecutionCapability({
                    gameId: input.gameId,
                    capabilityId: authority.execution.capabilityId,
                    expectedRevision: authority.execution.revision,
                    operation: 'reveal'
                });
                executablePath = execution.details.executablePath || '';
                if (executablePath && !strictChildPath(install.details.rootPath, executablePath)) {
                    throw new Error('The approved game executable is no longer inside the Sail-installed folder.');
                }
                if (executablePath) {
                    const running = await getRunningProcessSnapshot();
                    if (running.names.has(path.basename(executablePath).toLowerCase())) {
                        throw new Error('Close the game before uninstalling it.');
                    }
                }
            } catch (error) {
                if (/no longer inside|close the game/i.test(String(error && error.message || ''))) throw error;
            }
        }

        const resumeAchievementTracking = achievementService
            && typeof achievementService.suspendGame === 'function'
            && achievementService.suspendGame(input.gameId);
        try {
            await removeOwnedInstallDirectory(install.details.rootPath, {
                protectedRoots: [app.getPath('userData'), app.getAppPath(), os.homedir()]
            });
        } catch (error) {
            if (resumeAchievementTracking && achievementService
                && typeof achievementService.resumeGame === 'function') {
                achievementService.resumeGame(input.gameId);
            }
            throw error;
        }
        if (achievementService && typeof achievementService.forgetGame === 'function') {
            achievementService.forgetGame(input.gameId);
        }
        const runtimeRemoved = runtimeRecovery
            ? runtimeRecovery.purgeGame({ gameId: input.gameId, libraryKey })
            : { completedSessions: 0, postExitJobs: 0 };
        const managed = input.removeSailData
            ? removeSailManagedGameFiles(store, input.gameId, executablePath)
            : { removed: 0, warning: '' };
        const profileResult = store.removeGameFromActiveLibrary(input.gameId, { keepSailData: input.keepSailData });
        const cloud = input.removeSailData
            ? await removeSailCloudGameArtifacts(input.gameId)
            : { removed: 0, warning: '' };
        return {
            success: true,
            gameName: metadata.name,
            removeSailData: input.removeSailData,
            keepSailData: input.keepSailData,
            runtimeRemoved,
            managedFilesRemoved: managed.removed,
            cloudFilesRemoved: cloud.removed,
            warning: [managed.warning, cloud.warning].filter(Boolean).join(' '),
            state: profileResult.state,
            snapshot: profileResult.snapshot
        };
    } finally {
        uninstallingGameIds.delete(uninstallGameId);
    }
});

ipcMain.handle('check-backup-running', () => activeBackupProcess !== null);

function resolveGameBackupLayout(payload, operation) {
    const input = exactGateAPayload(payload, ['gameId', 'capabilityId', 'expectedRevision'], `Game backup ${operation}`);
    const store = gateAProfileStore();
    const resolved = store.resolveExecutionCapability({
        capabilityId: input.capabilityId,
        expectedRevision: input.expectedRevision,
        gameId: input.gameId,
        operation
    });
    const exePath = resolved.details.executablePath;
    if (!exePath) throw new Error('This game does not have a locally approved executable backup root.');
    const gameDir = path.dirname(exePath);
    const backupDir = path.dirname(gameDir);
    const legacyAlias = store.legacyStorageAlias(input.gameId);
    const [safeName, legacyName = null] = scopedArtifactStems(
        store.authorityScope(input.gameId),
        legacyAlias && legacyAlias.stem || ''
    );
    return { input, store, exePath, gameDir, backupDir, safeName, legacyName };
}

function spawnBoundArchivePowerShell(action, sourcePath, destinationPath) {
    const invocation = createArchivePowerShellInvocation(action, sourcePath, destinationPath);
    return spawn(invocation.file, invocation.args, invocation.options);
}

ipcMain.handle('check-backup', (e, payload) => {
    if (activeBackupProcess !== null) return [];
    try {
        const { input, store, backupDir, safeName, legacyName } = resolveGameBackupLayout(payload, 'backup-list');
        const stems = [safeName, legacyName].filter(Boolean);

        if (!fs.existsSync(backupDir)) return [];

        const backups = [];
        const seen = new Set();
        for (const f of fs.readdirSync(backupDir)) {
            const stem = stems.find(candidate => f.startsWith(`${candidate}_backup_`) && f.endsWith('.zip'));
            if (!stem || seen.has(f)) continue;
            try {
                const backupPath = path.join(backupDir, f);
                const stat = fs.lstatSync(backupPath);
                if (!stat.isFile() || stat.isSymbolicLink()) continue;
                const prefix = `${stem}_backup_`;
                let dateStr = f.slice(prefix.length, -4);
                let parsedDate = null;
                if (dateStr.length === 19) {
                    const year = dateStr.slice(0, 4);
                    const month = dateStr.slice(5, 7);
                    const day = dateStr.slice(8, 10);
                    const hour = dateStr.slice(11, 13);
                    const min = dateStr.slice(14, 16);
                    parsedDate = `${year}-${month}-${day} ${hour}:${min}`;
                }
                const capability = store.createBackupFileCapability(input.gameId, backupPath);
                backups.push({ filename: f, date: parsedDate || dateStr, capabilityId: capability.capabilityId, revision: capability.revision });
                seen.add(f);
            } catch (_) {}
        }
        backups.sort((a, b) => b.filename.localeCompare(a.filename)); // newest first

        for (const stem of stems) {
            const filename = `${stem} backup.zip`;
            const oldZipPath = path.join(backupDir, filename);
            if (!fs.existsSync(oldZipPath) || seen.has(filename)) continue;
            try {
                const stat = fs.lstatSync(oldZipPath);
                if (!stat.isFile() || stat.isSymbolicLink()) continue;
                const capability = store.createBackupFileCapability(input.gameId, oldZipPath);
                backups.push({ filename, date: 'Legacy Backup', capabilityId: capability.capabilityId, revision: capability.revision });
                seen.add(filename);
            } catch (_) {}
        }

        return backups;
    } catch (err) { return []; }
});

ipcMain.handle('backup-game', async (e, payload) => {
    const { gameDir, backupDir, safeName } = resolveGameBackupLayout(payload, 'backup-create');
    return new Promise((resolve) => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        backingUpZipPath = path.join(backupDir, `${safeName}_backup_${timestamp}.zip`);

        if (fs.existsSync(backingUpZipPath)) fs.unlinkSync(backingUpZipPath);
        activeBackupProcess = spawnBoundArchivePowerShell('compress', gameDir, backingUpZipPath);
        activeBackupProcess.on('close', (code) => {
            activeBackupProcess = null;

            if (code === 0) {
                try {
                    const prefix = `${safeName}_backup_`;
                    let existing = fs.readdirSync(backupDir)
                        .filter(f => f.startsWith(prefix) && f.endsWith('.zip'))
                        .map(f => path.join(backupDir, f))
                        .sort();

                    while (existing.length > 3) {
                        try { fs.unlinkSync(existing.shift()); } catch (e) { }
                    }
                } catch (e) { }
            }

            resolve({ success: code === 0 });
        });
    });
});

ipcMain.handle('cancel-backup', () => {
    if (activeBackupProcess) {
        exec(`taskkill /F /T /PID ${activeBackupProcess.pid}`);
        activeBackupProcess = null;
        if (backingUpZipPath && fs.existsSync(backingUpZipPath)) {
            try { fs.unlinkSync(backingUpZipPath); } catch (err) { }
        }
        return true;
    }
    return false;
});

ipcMain.handle('restore-backup', async (e, payload) => {
    const input = exactGateAPayload(payload, [
        'gameId', 'capabilityId', 'expectedRevision',
        'backupCapabilityId', 'backupExpectedRevision'
    ], 'Game backup restore');
    const { store, gameDir } = resolveGameBackupLayout({
        gameId: input.gameId,
        capabilityId: input.capabilityId,
        expectedRevision: input.expectedRevision
    }, 'backup-restore');
    const backup = store.resolveTransferCapability({
        gameId: input.gameId,
        capabilityId: input.backupCapabilityId,
        expectedRevision: input.backupExpectedRevision,
        operation: 'backup-read'
    });
    return new Promise((resolve) => {
        const zipPath = backup.details.targetPath;

        if (!fs.existsSync(zipPath)) return resolve(false);
        const child = spawnBoundArchivePowerShell('expand', zipPath, gameDir);
        child.on('close', (code) => resolve(code === 0));
    });
});

ipcMain.handle('open-backup-folder', (e, payload) => {
    try {
        const { backupDir } = resolveGameBackupLayout(payload, 'backup-open');
        if (fs.existsSync(backupDir)) {
            shell.openPath(backupDir);
            return true;
        }
    } catch (err) { }
    return false;
});

ipcMain.handle('delete-backup', (e, payload) => {
    try {
        const input = exactGateAPayload(payload, [
            'gameId', 'backupCapabilityId', 'backupExpectedRevision'
        ], 'Game backup deletion');
        const backup = gateAProfileStore().resolveTransferCapability({
            gameId: input.gameId,
            capabilityId: input.backupCapabilityId,
            expectedRevision: input.backupExpectedRevision,
            operation: 'backup-delete'
        });
        const zipPath = backup.details.targetPath;
        if (fs.existsSync(zipPath)) { fs.unlinkSync(zipPath); return true; }
    } catch (err) { }
    return false;
});

// --- SAVE VERSIONING (Google Drive sync) ---
function localSaveVersionLayout(gameId) {
    const store = gateAProfileStore();
    const root = path.join(os.homedir(), 'SailLauncherSaves');
    const legacyAlias = store.legacyStorageAlias(gameId);
    const [cleanName, legacyName = null] = scopedArtifactStems(
        store.authorityScope(gameId),
        legacyAlias && legacyAlias.stem || ''
    );
    const savesDir = path.join(root, cleanName, 'Saves');
    const legacySavesDir = legacyName ? path.join(root, legacyName, 'Saves') : null;
    return { store, cleanName, legacyName, root, savesDir, legacySavesDir };
}

ipcMain.handle('zip-save-to-drive', async (e, payload) => {
    const input = exactGateAPayload(payload, ['gameId', 'capabilityId', 'expectedRevision', 'maxVersions'], 'Local save backup');
    const { store, cleanName, savesDir } = localSaveVersionLayout(input.gameId);
    const source = store.resolveFilesystemCapability({
        gameId: input.gameId,
        capabilityId: input.capabilityId,
        expectedRevision: input.expectedRevision,
        operation: 'backup-read'
    });
    const localSavePath = source.details.rootPath;
    const maxVersions = Number.isSafeInteger(input.maxVersions) ? Math.max(1, Math.min(50, input.maxVersions)) : 3;
    return new Promise((resolve) => {
        try {
            if (!fs.existsSync(savesDir)) fs.mkdirSync(savesDir, { recursive: true });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const zipName = `${cleanName}_save_${timestamp}.zip`;
            const zipPath = path.join(savesDir, zipName);
            const partialPrefix = `.${cleanName}_save_`;
            for (const fileName of fs.readdirSync(savesDir)) {
                if (!fileName.startsWith(partialPrefix) || !fileName.endsWith('.partial.zip')) continue;
                try { fs.unlinkSync(path.join(savesDir, fileName)); } catch (_) {}
            }
            const partialZipPath = path.join(savesDir, `.${zipName}.partial.zip`);

            const child = spawnBoundArchivePowerShell('compress', localSavePath, partialZipPath);
            let settled = false;
            const finish = success => {
                if (settled) return;
                settled = true;
                if (!success) {
                    try { fs.unlinkSync(partialZipPath); } catch (_) {}
                }
                resolve(success);
            };
            child.on('error', () => finish(false));
            child.on('close', (code) => {
                let succeeded = false;
                if (code === 0 && fs.existsSync(partialZipPath)) {
                    try {
                        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
                        fs.renameSync(partialZipPath, zipPath);
                        succeeded = true;
                    } catch (_) {}
                }
                if (succeeded && maxVersions > 0) {
                    try {
                        const prefix = `${cleanName}_save_`;
                        let existing = fs.readdirSync(savesDir)
                            .filter(f => f.startsWith(prefix) && f.endsWith('.zip'))
                            .sort();
                        while (existing.length > maxVersions) {
                            try { fs.unlinkSync(path.join(savesDir, existing.shift())); } catch (e) { }
                        }
                    } catch (e) { }
                }
                finish(succeeded);
            });
        } catch (err) { resolve(false); }
    });
});

ipcMain.handle('list-save-versions', (e, payload) => {
    try {
        const input = exactGateAPayload(payload, ['gameId', 'capabilityId', 'expectedRevision'], 'Local save backup list');
        const { store, cleanName, legacyName, savesDir, legacySavesDir } = localSaveVersionLayout(input.gameId);
        store.resolveFilesystemCapability({
            gameId: input.gameId,
            capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision,
            operation: 'backup-read'
        });
        const locations = [{ stem: cleanName, directory: savesDir }];
        if (legacyName && legacySavesDir) locations.push({ stem: legacyName, directory: legacySavesDir });
        const versions = [];
        const seen = new Set();
        for (const location of locations) {
            if (!fs.existsSync(location.directory)) continue;
            const prefix = `${location.stem}_save_`;
            for (const f of fs.readdirSync(location.directory)) {
                const identity = `${location.directory.toLocaleLowerCase('en-US')}\u0000${f.toLocaleLowerCase('en-US')}`;
                if (!f.startsWith(prefix) || !f.endsWith('.zip') || seen.has(identity)) continue;
                try {
                    const backupPath = path.join(location.directory, f);
                    const stat = fs.lstatSync(backupPath);
                    if (!stat.isFile() || stat.isSymbolicLink()) continue;
                    let dateStr = f.slice(prefix.length, -4);
                    let parsedDate = null;
                    if (dateStr.length === 19) {
                        parsedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(5, 7)}-${dateStr.slice(8, 10)} ${dateStr.slice(11, 13)}:${dateStr.slice(14, 16)}`;
                    }
                    const capability = store.createBackupFileCapability(input.gameId, backupPath);
                    versions.push({ filename: f, date: parsedDate || dateStr, capabilityId: capability.capabilityId, revision: capability.revision });
                    seen.add(identity);
                } catch (_) {}
            }
        }
        return versions.sort((a, b) => b.filename.localeCompare(a.filename)); // newest first
    } catch (err) { return []; }
});

ipcMain.handle('restore-save-version', async (e, payload) => {
    const input = exactGateAPayload(payload, [
        'gameId', 'destinationCapabilityId', 'destinationExpectedRevision',
        'backupCapabilityId', 'backupExpectedRevision'
    ], 'Local save backup restore');
    const store = gateAProfileStore();
    const destination = store.resolveFilesystemCapability({
        gameId: input.gameId,
        capabilityId: input.destinationCapabilityId,
        expectedRevision: input.destinationExpectedRevision,
        operation: 'backup-write'
    });
    const backup = store.resolveTransferCapability({
        gameId: input.gameId,
        capabilityId: input.backupCapabilityId,
        expectedRevision: input.backupExpectedRevision,
        operation: 'backup-read'
    });
    return new Promise((resolve) => {
        try {
            const zipPath = backup.details.targetPath;
            const localSavePath = destination.details.rootPath;

            if (!zipPath || !fs.existsSync(zipPath)) return resolve(false);
            const child = spawnBoundArchivePowerShell('expand', zipPath, localSavePath);
            child.on('close', (code) => resolve(code === 0));
        } catch (err) { resolve(false); }
    });
});

ipcMain.handle('open-save-versions-folder', (e, payload) => {
    try {
        const input = exactGateAPayload(payload, ['gameId', 'capabilityId', 'expectedRevision'], 'Local save backup folder');
        const { store, root, savesDir, legacySavesDir } = localSaveVersionLayout(input.gameId);
        store.resolveFilesystemCapability({
            gameId: input.gameId,
            capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision,
            operation: 'backup-read'
        });
        const existing = [savesDir, legacySavesDir].filter(directory => directory && fs.existsSync(directory));
        if (existing.length > 1 && fs.existsSync(root)) { shell.openPath(root); return true; }
        if (existing.length === 1) { shell.openPath(existing[0]); return true; }
    } catch (err) { }
    return false;
});

// --- CLOUD SYNC IPC HANDLERS ---
ipcMain.handle('cloud-link-account', async (e, { provider, customCreds }) => {
    if (!customCreds && accountServices && ['google', 'dropbox'].includes(provider)) {
        try {
                const account = await accountServices.accountService.state();
                if (account.signedIn) {
                    const pending = await accountServices.accountService.startCloudOAuth(provider);
                    if (!openExternalWebUrl(shell, pending.url)) throw new Error('Cloud authorization URL was rejected.');
                    return { success: true, pending: true, email: account.user.email };
                }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    const oauthState = crypto.randomBytes(32).toString('hex');
    let authUrl = '';
    if (provider === 'google') authUrl = cloudSync.googleDrive.getAuthUrl(customCreds);
    else if (provider === 'onedrive') authUrl = cloudSync.oneDrive.getAuthUrl(customCreds);
    else if (provider === 'dropbox') authUrl = cloudSync.dropbox.getAuthUrl(customCreds);
    else return { success: false, error: 'Unknown provider' };
    authUrl = cloudSync.appendOauthState(authUrl, oauthState);

    // Start local server
    const serverPromise = cloudSync.startOauthServer(oauthState);
    
    // Open auth window
    const parentWin = BrowserWindow.fromWebContents(e.sender);
    const authWin = new BrowserWindow({
        width: 600,
        height: 700,
        parent: parentWin || undefined,
        modal: true,
        show: true,
        title: `Link ${provider.toUpperCase()}`,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
        }
    });
    installIsolatedRemoteNavigationPolicy(authWin.webContents, { shell });
    authWin.loadURL(authUrl);

    try {
        const code = await Promise.race([
            serverPromise,
            new Promise((_, reject) => {
                authWin.on('close', () => reject(new Error('Window closed by user')));
            })
        ]);

        // Exchange code for tokens
        let profile = null;
        if (provider === 'google') profile = await cloudSync.googleDrive.exchangeCode(code, customCreds);
        else if (provider === 'onedrive') profile = await cloudSync.oneDrive.exchangeCode(code, customCreds);
        else if (provider === 'dropbox') profile = await cloudSync.dropbox.exchangeCode(code, customCreds);

        try { authWin.destroy(); } catch(err) {}
        return { success: true, email: profile.email };
    } catch(err) {
        try { authWin.destroy(); } catch(e) {}
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cloud-mediafire-login', async (e, { email, password, appId, apiKey }) => {
    try {
        const profile = await cloudSync.mediaFire.connect(email, password, appId, apiKey);
        return { success: true, email: profile.email };
    } catch(err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cloud-unlink-account', async (e, provider) => {
    cloudSync.deleteTokens(provider);
    if (accountServices && ['google', 'dropbox'].includes(provider)) {
        try {
            const account = await accountServices.accountService.state();
            if (account.signedIn) await accountServices.accountService.disconnectPortableCloud(provider);
        } catch (_) {}
    }
    return true;
});

ipcMain.handle('cloud-get-status', async () => {
    try {
        const tokens = cloudSync.loadAllTokens();
        const status = {};
        for (const provider in tokens) {
            status[provider] = {
                linked: !!tokens[provider].access_token || !!tokens[provider].session_token,
                email: tokens[provider].email || ''
            };
        }
        if (accountServices) {
            try {
                const account = await accountServices.accountService.state();
                if (account.signedIn) {
                    const remote = await accountServices.accountService.listRemoteControlPlane();
                    for (const connection of remote.connections || []) {
                        status[connection.provider] = {
                            linked: connection.status === 'connected',
                            portable: true,
                            email: connection.provider_account_label || status[connection.provider] && status[connection.provider].email || ''
                        };
                    }
                }
            } catch (_) {}
        }
        return status;
    } catch(e) {
        return {};
    }
});

async function hydratePortableCloudToken(provider, customCreds) {
    if (customCreds || !accountServices || !['google', 'dropbox'].includes(provider)) return;
    const account = await accountServices.accountService.state();
    if (!account.signedIn) return;
    const token = await accountServices.accountService.portableCloudAccess(provider);
    if (!token || !token.access_token) return;
    const remote = await accountServices.accountService.listRemoteControlPlane();
    const connection = (remote.connections || []).find(item => item.provider === provider);
    cloudSync.saveTokens(provider, {
        access_token: token.access_token,
        email: connection && connection.provider_account_label || `${provider} account`
    });
}

function gateAProfileStore() {
    if (!accountServices || !accountServices.profileStore) throw new Error('Local filesystem authority is not ready.');
    return accountServices.profileStore;
}

function gateATransferPath(extension = '.zip') {
    const root = path.join(app.getPath('userData'), 'SailGateATransfers');
    fs.mkdirSync(root, { recursive: true });
    return path.join(root, `${crypto.randomUUID()}${extension}`);
}

function safeRemoteFolder(value) {
    const text = String(value || '').trim();
    if (!text) return undefined;
    if (text.length > 200 || text.includes('..') || /[\u0000-\u001f\\]/.test(text)) throw new Error('The remote folder name is invalid.');
    return text;
}

const legacyCloudReferences = new LegacyCloudReferenceStore(() => gateAProfileStore());

function newestApprovedMtime(rootPath) {
    let newest = 0;
    let visited = 0;
    const visit = (targetPath, depth) => {
        if (depth > 20 || ++visited > 100000) return;
        let stat;
        try { stat = fs.lstatSync(targetPath); } catch (_) { return; }
        if (stat.isSymbolicLink()) return;
        newest = Math.max(newest, stat.mtimeMs || 0);
        if (!stat.isDirectory()) return;
        let names;
        try { names = fs.readdirSync(targetPath); } catch (_) { return; }
        for (const name of names) visit(path.join(targetPath, name), depth + 1);
    };
    visit(rootPath, 0);
    return newest;
}

ipcMain.handle('authority-filesystem-newest-mtime', async (e, payload) => {
    const input = exactGateAPayload(payload, [
        'gameId', 'capabilityId', 'expectedRevision', 'kind'
    ], 'Local filesystem timestamp');
    if (!['save', 'config'].includes(input.kind)) throw new Error('Unsupported local data kind.');
    const resolved = gateAProfileStore().resolveFilesystemCapability({
        gameId: input.gameId,
        capabilityId: input.capabilityId,
        expectedRevision: input.expectedRevision,
        operation: input.kind === 'save' ? 'save-read' : 'config-read'
    });
    return newestApprovedMtime(resolved.details.rootPath);
});

ipcMain.handle('cloud-upload-save', async (e, payload) => {
    try {
        const input = exactGateAPayload(payload, [
            'provider', 'gameId', 'capabilityId', 'expectedRevision',
            'maxVersions', 'customCreds', 'artifactType', 'configEntryId'
        ], 'Cloud upload');
        const provider = String(input.provider || '');
        if (!['google', 'onedrive', 'dropbox', 'mediafire'].includes(provider)) return { success: false, error: 'Unknown provider' };
        if (!Number.isSafeInteger(input.maxVersions) || input.maxVersions < 1 || input.maxVersions > 50) {
            throw new Error('The cloud version count is outside its allowed range.');
        }
        const store = gateAProfileStore();
        const artifactScope = legacyCloudReferences.scope(input);
        const resolved = store.resolveTransferCapability({
            capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision,
            gameId: input.gameId,
            operation: 'transfer-read'
        });
        if (artifactScope.artifactType === 'launcher-config') {
            const canonical = canonicalPortableBytes(fs.readFileSync(resolved.details.targetPath), {
                kindHint: 'launcher-snapshot',
                expectedKind: 'launcher-snapshot'
            });
            fs.writeFileSync(resolved.details.targetPath, canonical.bytes);
            const verified = canonicalPortableBytes(fs.readFileSync(resolved.details.targetPath), {
                kindHint: 'launcher-snapshot',
                expectedKind: 'launcher-snapshot'
            });
            if (!canonical.bytes.equals(verified.bytes)) throw new Error('The portable upload failed independent V3 readback verification.');
        }
        await hydratePortableCloudToken(provider, input.customCreds);
        try {
            if (provider === 'google') await cloudSync.googleDrive.uploadFile(input.customCreds, artifactScope.gameName, resolved.details.targetPath, input.maxVersions, artifactScope.subFolder);
            else if (provider === 'onedrive') await cloudSync.oneDrive.uploadFile(input.customCreds, artifactScope.gameName, resolved.details.targetPath, input.maxVersions, artifactScope.subFolder);
            else if (provider === 'dropbox') await cloudSync.dropbox.uploadFile(input.customCreds, artifactScope.gameName, resolved.details.targetPath, input.maxVersions, artifactScope.subFolder);
            else if (provider === 'mediafire') await cloudSync.mediaFire.uploadFile(artifactScope.gameName, resolved.details.targetPath);
        } finally {
            try { fs.unlinkSync(resolved.details.targetPath); } catch (_) {}
        }
        return { success: true };
    } catch(err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cloud-list-versions', async (e, payload) => {
    try {
        const input = exactGateAPayload(payload, [
            'provider', 'gameId', 'artifactType', 'configEntryId', 'customCreds'
        ], 'Cloud version list');
        const provider = String(input.provider || '');
        if (!['google', 'onedrive', 'dropbox', 'mediafire'].includes(provider)) return { success: false, error: 'Unknown provider' };
        const scope = legacyCloudReferences.scope(input);
        await hydratePortableCloudToken(provider, input.customCreds);
        let versions = [];
        if (provider === 'google') versions = await cloudSync.googleDrive.listFiles(input.customCreds, scope.gameName, scope.subFolder);
        else if (provider === 'onedrive') versions = await cloudSync.oneDrive.listFiles(input.customCreds, scope.gameName, scope.subFolder);
        else if (provider === 'dropbox') versions = await cloudSync.dropbox.listFiles(input.customCreds, scope.gameName, scope.subFolder);
        else if (provider === 'mediafire') versions = await cloudSync.mediaFire.listFiles(scope.gameName);
        return { success: true, versions: legacyCloudReferences.issue(scope, provider, versions) };
    } catch(err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cloud-create-download-transfer', async (e, payload) => {
    const input = exactGateAPayload(payload, ['gameId', 'extension'], 'Cloud download preparation');
    const extension = input.extension === '.json' ? '.json' : '.zip';
    const targetPath = gateATransferPath(extension);
    return input.gameId === 'launcher-portable'
        ? gateAProfileStore().createLauncherTransferCapability(targetPath, 'transfer-write')
        : gateAProfileStore().createTransferCapability(input.gameId, targetPath, 'transfer-write');
});

ipcMain.handle('cloud-download-save', async (e, payload) => {
    try {
        const input = exactGateAPayload(payload, [
            'provider', 'reference', 'gameId', 'artifactType', 'configEntryId',
            'capabilityId', 'expectedRevision', 'customCreds'
        ], 'Cloud download');
        const provider = String(input.provider || '');
        if (!['google', 'onedrive', 'dropbox', 'mediafire'].includes(provider)) return { success: false, error: 'Unknown provider' };
        const remote = legacyCloudReferences.resolve(input, provider);
        const store = gateAProfileStore();
        const resolved = store.resolveTransferCapability({
            capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision,
            gameId: input.gameId,
            operation: 'transfer-write'
        });
        await hydratePortableCloudToken(provider, input.customCreds);
        if (provider === 'google') await cloudSync.googleDrive.downloadFile(input.customCreds, remote.fileId, resolved.details.targetPath);
        else if (provider === 'onedrive') await cloudSync.oneDrive.downloadFile(input.customCreds, remote.fileId, resolved.details.targetPath);
        else if (provider === 'dropbox') await cloudSync.dropbox.downloadFile(input.customCreds, remote.fileId, resolved.details.targetPath);
        else if (provider === 'mediafire') await cloudSync.mediaFire.downloadFile(remote.fileId, resolved.details.targetPath);
        const transfer = input.gameId === 'launcher-portable'
            ? store.createLauncherTransferCapability(resolved.details.targetPath, 'transfer-read')
            : store.createTransferCapability(input.gameId, resolved.details.targetPath, 'transfer-read');
        return { success: true, transfer };
    } catch(err) {
        return { success: false, error: err.message };
    }
});

function createCloudZipWithPowerShell(localSavePath, zipPath) {
    return new Promise((resolve) => {
        const env = {
            ...process.env,
            SAIL_LAUNCHER_CLOUD_SAVE_SOURCE: localSavePath,
            SAIL_LAUNCHER_CLOUD_SAVE_DESTINATION: zipPath
        };
        const command = [
            "$ErrorActionPreference = 'Stop'",
            "$source = [Environment]::GetEnvironmentVariable('SAIL_LAUNCHER_CLOUD_SAVE_SOURCE')",
            "$destination = [Environment]::GetEnvironmentVariable('SAIL_LAUNCHER_CLOUD_SAVE_DESTINATION')",
            '$sourceItem = Get-Item -LiteralPath $source -Force',
            '$entries = @($(if ($sourceItem.PSIsContainer) { Get-ChildItem -LiteralPath $source -Force } else { $sourceItem }))',
            'if ($entries.Count -eq 0) { exit 0 }',
            'Compress-Archive -LiteralPath $entries.FullName -DestinationPath $destination -Force'
        ].join('; ');
        let settled = false;
        const finish = success => {
            if (settled) return;
            settled = true;
            resolve(!!success && fs.existsSync(zipPath));
        };
        try {
            const child = spawn('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                command
            ], { windowsHide: true, env });
            child.on('error', () => finish(false));
            child.on('close', code => finish(code === 0));
        } catch (_) {
            finish(false);
        }
    });
}

ipcMain.handle('cloud-zip-folder', async (e, payload) => {
    try {
        const input = exactGateAPayload(payload, [
            'gameId', 'capabilityId', 'expectedRevision', 'kind'
        ], 'Cloud archive preparation');
        if (!['save', 'config'].includes(input.kind)) throw new Error('Unsupported local data kind.');
        const store = gateAProfileStore();
        const resolved = store.resolveFilesystemCapability({
            capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision,
            gameId: input.gameId,
            operation: input.kind === 'save' ? 'save-read' : 'config-read'
        });
        const localSavePath = resolved.details.rootPath;
        const zipPath = gateATransferPath('.zip');
        if (!localSavePath || !fs.existsSync(localSavePath)) return { success: false };
        fs.mkdirSync(path.dirname(zipPath), { recursive: true });
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

        // Use the same compressor as local save backups first. Bundled 7-Zip
        // can return warning code 1 when a game has just released a file,
        // even though the archive may have been created successfully.
        if (await createCloudZipWithPowerShell(localSavePath, zipPath)) {
            return { success: true, transfer: store.createTransferCapability(input.gameId, zipPath, 'transfer-read') };
        }
        try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}

        let sevenZipError = null;
        try {
            await new Promise((resolve, reject) => {
                _7z.cmd(
                    ['a', '-tzip', '-mx=5', zipPath, path.join(localSavePath, '*')],
                    (error) => error ? reject(error) : resolve()
                );
            });
            if (fs.existsSync(zipPath)) {
                return { success: true, transfer: store.createTransferCapability(input.gameId, zipPath, 'transfer-read') };
            }
        } catch (error) {
            sevenZipError = error;
        }

        try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}
        if (sevenZipError) {
            const detail = [sevenZipError.message, sevenZipError.stderr].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 400);
            console.error('Cloud archive creation failed with PowerShell and 7-Zip:', detail);
        }
        return { success: false };
    } catch (error) {
        console.error('Cloud archive creation failed:', error);
        return { success: false, error: error && error.message || 'Cloud archive creation failed.' };
    }
});

ipcMain.handle('cloud-extract-zip', async (e, payload) => {
    try {
        const input = exactGateAPayload(payload, [
            'gameId', 'transferCapabilityId', 'transferExpectedRevision',
            'destinationCapabilityId', 'destinationExpectedRevision', 'kind'
        ], 'Cloud archive extraction');
        if (!['save', 'config'].includes(input.kind)) throw new Error('Unsupported local data kind.');
        const store = gateAProfileStore();
        const archive = store.resolveTransferCapability({
            capabilityId: input.transferCapabilityId,
            expectedRevision: input.transferExpectedRevision,
            gameId: input.gameId,
            operation: 'transfer-read'
        });
        const destination = store.resolveFilesystemCapability({
            capabilityId: input.destinationCapabilityId,
            expectedRevision: input.destinationExpectedRevision,
            gameId: input.gameId,
            operation: input.kind === 'save' ? 'save-write' : 'config-write'
        });
        const zipPath = archive.details.targetPath;
        const localSavePath = destination.details.rootPath;
        if (!zipPath || !localSavePath || !fs.existsSync(zipPath)) return { success: false };
        const destinationIsFile = destination.details.rootIdentity && destination.details.rootIdentity.kind === 'file';
        const extractionPath = destinationIsFile ? path.dirname(localSavePath) : localSavePath;
        if (input.kind === 'config' && fs.existsSync(localSavePath)) {
            const backupPath = `${localSavePath}.sail-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            fs.cpSync(localSavePath, backupPath, { recursive: true, errorOnExist: true });
        }
        fs.mkdirSync(extractionPath, { recursive: true });
        try {
            await _7z.unpack(zipPath, extractionPath);
            return { success: true };
        } finally {
            try { fs.unlinkSync(zipPath); } catch (_) {}
        }
    } catch (error) {
        console.error('Cloud archive extraction failed:', error);
        return { success: false, error: error && error.message || 'Cloud archive extraction failed.' };
    }
});

function setWindowFullscreen(win, enabled) {
    if (!win || win.isDestroyed()) return;
    const controller = fullscreenControllers.get(win);
    if (controller) controller.setFullscreen(enabled === true);
    else win.setFullScreen(enabled === true);
}

function isWindowFullscreen(win) {
    if (!win || win.isDestroyed()) return false;
    return fullscreenStates.has(win) ? fullscreenStates.get(win) === true : win.isFullScreen();
}

ipcMain.on('window-min', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window-fullscreen-toggle', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) setWindowFullscreen(win, !isWindowFullscreen(win));
});
ipcMain.on('window-set-fullscreen', (e, enabled) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) setWindowFullscreen(win, enabled === true);
});
ipcMain.on('window-close', (e, exitWhenClosed) => {
    if (exitWhenClosed) requestApplicationQuit();
    else { BrowserWindow.fromWebContents(e.sender)?.hide(); }
});

ipcMain.on('exit-sync-completed', () => {
    exitSynced = true;
    isQuitting = true;
    app.quit();
});

ipcMain.handle('get-displays', () => {
    return screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor,
        isPrimary: d.bounds.x === 0 && d.bounds.y === 0
    }));
});

ipcMain.on('move-to-display-fullscreen', (e, displayId) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;

    const display = displayId ? screen.getAllDisplays().find(d => d.id == displayId) : null;
    const controller = fullscreenControllers.get(win);
    const enterFullscreen = () => {
        if (controller) controller.finishDisplayTransfer();
        if (display) win.setBounds(display.bounds);
        setWindowFullscreen(win, true);
    };
    if (isWindowFullscreen(win)) {
        if (controller) controller.beginDisplayTransfer();
        win.once('leave-full-screen', enterFullscreen);
        setWindowFullscreen(win, false);
    } else {
        if (controller) controller.rememberNormalWindowState();
        enterFullscreen();
    }
});

ipcMain.handle('dialog-select-folder', async (e, defaultPath) => {
    const options = { properties: ['openDirectory'] };
    if (defaultPath) options.defaultPath = defaultPath;
    const r = await dialog.showOpenDialog(options);
    return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog-select-file', async () => { const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Executables & Shortcuts', extensions: ['exe', 'lnk', 'bat', 'cmd'] }] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('dialog-select-image', async () => { const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'png', 'jpeg', 'webp', 'ico'] }] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('dialog-select-font', async () => { const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('dialog-select-icon', async () => { const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Icons & Executables', extensions: ['ico', 'exe'] }] }); return r.canceled ? null : r.filePaths[0]; });

ipcMain.handle('dialog-save-json', async () => { const r = await dialog.showSaveDialog({ defaultPath: 'sail_library_backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] }); return r.canceled ? null : r.filePath; });
ipcMain.handle('dialog-open-json', async () => { const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('dialog-save-theme', async () => { const r = await dialog.showSaveDialog({ defaultPath: 'my_theme.json', filters: [{ name: 'JSON Theme', extensions: ['json'] }] }); return r.canceled ? null : r.filePath; });
ipcMain.handle('dialog-open-theme', async () => { const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON Theme', extensions: ['json'] }] }); return r.canceled ? null : r.filePaths[0]; });

// --- Plugin Manager IPC Handlers ---
ipcMain.handle('open-file-dialog', async (e, opts) => {
    const r = await dialog.showOpenDialog({ title: opts.title, properties: ['openFile'], filters: opts.filters || [] });
    return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('save-file-dialog', async (e, opts) => {
    const r = await dialog.showSaveDialog({ title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters || [] });
    return r.canceled ? null : r.filePath;
});
ipcMain.handle('extract-zip', async (e, { zipPath, destPath }) => {
    await extractArchive(zipPath, destPath);
    return true;
});

ipcMain.handle('extract-rar', async (e, { rarPath, destPath }) => {
    try {
        if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
        }
        const extractor = await unrar.createExtractorFromFile({ filepath: rarPath, targetPath: destPath });
        const extracted = extractor.extract({});
        for (const file of extracted.files) { } // Exhaust iterator to extract
        return true;
    } catch (err) {
        console.error('Error extracting RAR:', err);
        throw err;
    }
});

ipcMain.handle('extract-7z', async (e, { archivePath, destPath }) => {
    return new Promise((resolve, reject) => {
        _7z.unpack(archivePath, destPath, (err) => {
            if (err) reject(err);
            else resolve(true);
        });
    });
});
ipcMain.handle('create-zip', async (e, { sourceDir, destPath }) => {
    return new Promise((resolve, reject) => {
        const cmd = `powershell -Command "Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${destPath}' -Force"`;
        exec(cmd, { windowsHide: true }, (err) => { if (err) reject(err); else resolve(true); });
    });
});

ipcMain.handle('open-url', (e, url) => {
    if (!openExternalWebUrl(shell, url)) throw new Error('This link cannot be opened.');
    return true;
});
ipcMain.handle('show-game-local-file', (e, payload) => {
    const input = exactGateAPayload(payload, ['gameId', 'capabilityId', 'expectedRevision'], 'Reveal game file');
    const resolved = gateAProfileStore().resolveExecutionCapability({
        capabilityId: input.capabilityId,
        expectedRevision: input.expectedRevision,
        gameId: input.gameId,
        operation: 'reveal'
    });
    if (!resolved.details.executablePath) return false;
    shell.showItemInFolder(resolved.details.executablePath);
    return true;
});
ipcMain.handle('open-folder-capability', async (e, payload) => {
    const input = exactGateAPayload(payload, ['gameId', 'capabilityId', 'expectedRevision'], 'Open local folder');
    const resolved = gateAProfileStore().resolveFilesystemCapability({
        capabilityId: input.capabilityId,
        expectedRevision: input.expectedRevision,
        gameId: input.gameId,
        operation: 'folder-open'
    });
    const target = resolved.details && resolved.details.rootPath;
    if (!target) throw new Error('The approved folder is unavailable.');
    const result = await shell.openPath(target);
    if (result) throw new Error(result);
    return { success: true, capability: resolved.replacement };
});

// ============================================================================
// Auto-updater: download the launcher installer, run it silently, restart.
// ----------------------------------------------------------------------------
// The installer lives in %LOCALAPPDATA%\sail-launcher-updater\installer.exe.
// The SAME NSIS installer serves double duty: double-clicked by a user it shows
// the normal wizard; run by Sail with "/S --force-run" it installs silently and
// relaunches the app — so there is only ONE installer and ONE release asset.
// ============================================================================
const UPDATER_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'sail-launcher-updater');
const UPDATER_EXE = path.join(UPDATER_DIR, 'installer.exe');

// Download `url` (a GitHub release .exe asset) to installer.exe, following the
// redirect chain GitHub uses for asset downloads, streaming percent progress
// back to the renderer via 'update-download-progress'.
ipcMain.handle('download-update-installer', async (e, url) => {
    const wc = e.sender;
    // Wipe any stale folder/installer first so we never launch an old build.
    try { fs.rmSync(UPDATER_DIR, { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(UPDATER_DIR, { recursive: true });

    await new Promise((resolve, reject) => {
        let hops = 0;
        const get = (u) => {
            if (++hops > 8) return reject(new Error('Too many redirects'));
            const lib = u.startsWith('http:') ? http : https;
            lib.get(u, { headers: { 'User-Agent': 'Sail-Launcher' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return get(new URL(res.headers.location, u).toString());
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
                const total = Number(res.headers['content-length']) || 0;
                let received = 0;
                const out = fs.createWriteStream(UPDATER_EXE);
                res.on('data', (chunk) => {
                    received += chunk.length;
                    try { wc.send('update-download-progress', { received, total, percent: total ? Math.round(received / total * 100) : 0 }); } catch (_) {}
                });
                res.pipe(out);
                out.on('finish', () => out.close(() => resolve()));
                out.on('error', (err) => { try { fs.rmSync(UPDATER_EXE, { force: true }); } catch (_) {} reject(err); });
            }).on('error', reject);
        };
        get(url);
    });
    return UPDATER_EXE;
});

// Run the freshly-downloaded installer silently, then quit so it can replace our
// files. "--force-run" tells electron-builder's NSIS installer to relaunch the
// app after a silent install (the same flags electron-updater itself uses).
ipcMain.handle('run-update-installer', async () => {
    if (!fs.existsSync(UPDATER_EXE)) throw new Error('Installer not found — download it first.');
    const child = spawn(UPDATER_EXE, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' });
    child.unref();
    // Give the installer a beat to spin up before we release our file locks.
    setTimeout(() => { isQuitting = true; app.quit(); }, 1500);
    return true;
});

// Best-effort removal of the updater folder (called on startup once an update
// has been applied — the installer is no longer running so the exe is unlocked).
ipcMain.handle('cleanup-update-folder', async () => {
    try { fs.rmSync(UPDATER_DIR, { recursive: true, force: true }); return true; } catch (_) { return false; }
});

ipcMain.handle('kill-game-process', (e, payload) => {
    const input = exactGateAPayload(payload, ['gameId', 'capabilityId', 'expectedRevision'], 'Stop game process');
    const resolved = gateAProfileStore().resolveExecutionCapability({
        capabilityId: input.capabilityId,
        expectedRevision: input.expectedRevision,
        gameId: input.gameId,
        operation: 'terminate'
    });
    const target = resolved.details.playDetectionPath || resolved.details.executablePath;
    if (!target) return false;
    const imageName = path.basename(target);
    if (!/^[^<>:"/\\|?*\u0000-\u001f]{1,255}\.exe$/i.test(imageName)) return false;
    execFile('taskkill.exe', ['/F', '/T', '/IM', imageName], { windowsHide: true }, () => {});
    return true;
});

ipcMain.handle('detect-saves-ludusavi', async (event, request) => {
    const input = typeof request === 'string' ? { gameName: request } : Object.assign({}, request || {});
    const sendStatus = status => {
        try {
            if (!event.sender.isDestroyed()) event.sender.send('save-detection-status', {
                scanId: input.scanId || '',
                phase: status.phase,
                message: status.message
            });
        } catch (_) {}
    };
    try {
        const loaded = await loadLudusaviManifest({
            cachePath: path.join(app.getPath('userData'), 'ludusavi_manifest.yaml'),
            fetchImpl: globalThis.fetch,
            onStatus: sendStatus
        });
        sendStatus({ phase: 'matching', message: 'Checking known Ludusavi save locations…' });
        const steamRoot = findSteamRoot();
        const result = detectLudusaviSaveCandidates(loaded.manifest, input, {
            documentsPath: app.getPath('documents'),
            homePath: app.getPath('home'),
            steamRoot
        });
        return {
            success: true,
            paths: result.candidates.map(candidate => candidate.path),
            candidates: result.candidates,
            matchedGame: result.matchedGame,
            stale: loaded.stale,
            warning: loaded.warning || null
        };
    } catch (error) {
        console.error('Ludusavi save detection failed:', error && error.message || error);
        return { success: false, paths: [], candidates: [], error: 'Failed to load the Ludusavi save database.' };
    }
});

ipcMain.handle('detect-saves-auto', async (e, gameName) => {
    const searchDirs = [
        path.join(process.env.APPDATA || ''),
        path.join(process.env.LOCALAPPDATA || ''),
        path.join(process.env.LOCALAPPDATA || '', 'Low'),
        path.join(process.env.USERPROFILE || '', 'Documents'),
        path.join(process.env.USERPROFILE || '', 'Documents', 'My Games'),
        path.join(process.env.USERPROFILE || '', 'Saved Games')
    ].filter(Boolean);
    
    const results = [];
    const normalizedTarget = gameName.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Very simple heuristic folder scanner
    for (const baseDir of searchDirs) {
        try {
            if (!fs.existsSync(baseDir)) continue;
            const items = fs.readdirSync(baseDir, { withFileTypes: true });
            for (const item of items) {
                if (!item.isDirectory()) continue;
                const dirNameNorm = item.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                
                // If folder name closely matches game name
                if (dirNameNorm && (normalizedTarget.includes(dirNameNorm) || dirNameNorm.includes(normalizedTarget))) {
                    results.push(path.join(baseDir, item.name));
                }
            }
        } catch (err) {
            // Ignore access denied errors
        }
    }
    
    return { success: true, paths: results };
});

function runScript(scriptPath, wait = true) {
    if (!scriptPath || !fs.existsSync(scriptPath)) return Promise.resolve();
    return new Promise((resolve) => {
        try {
            const ext = path.extname(scriptPath).toLowerCase();
            let child;
            if (ext === '.ps1') {
                child = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], { windowsHide: true, detached: !wait });
            } else if (ext === '.bat' || ext === '.cmd') {
                child = spawn('cmd.exe', ['/c', `"${scriptPath}"`], { windowsHide: true, detached: !wait });
            } else {
                child = spawn(scriptPath, [], { windowsHide: true, detached: !wait });
            }

            if (wait) {
                child.on('close', resolve);
                child.on('error', resolve);
            } else {
                child.unref();
                resolve();
            }
        } catch (err) { resolve(); }
    });
}

function exactGateAPayload(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        const error = new Error(`${label} must be an object.`);
        error.code = 'SAIL_GATE_A_INVALID_PAYLOAD';
        throw error;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        const error = new Error(`${label} has an unsupported prototype.`);
        error.code = 'SAIL_GATE_A_INVALID_PAYLOAD';
        throw error;
    }
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
            const error = new Error(`${label}.${key} is not allowed.`);
            error.code = 'SAIL_GATE_A_INVALID_PAYLOAD';
            throw error;
        }
    }
    return value;
}

ipcMain.handle('launch-game', async (e, payload) => {
    const input = exactGateAPayload(payload, [
        'capabilityId', 'expectedRevision', 'gameId',
        'needsSaveSync', 'needsGameConfigSync'
    ], 'Launch request');
    if (uninstallingGameIds.has(String(input.gameId || ''))) throw new Error('This game is currently being uninstalled.');
    if (!accountServices || !accountServices.profileStore) throw new Error('Local game authority is not ready.');
    const gameMetadata = accountServices.profileStore.activeGameMetadata(input.gameId);
    const resolved = accountServices.profileStore.resolveExecutionCapability({
        capabilityId: input.capabilityId,
        expectedRevision: input.expectedRevision,
        gameId: input.gameId,
        operation: 'launch'
    });
    const phaseAuthority = createExecutionPhaseAuthority({
        profileStore: accountServices.profileStore,
        gameId: input.gameId,
        resolvedCapability: resolved
    });
    const {
        executablePath: exePath,
        steamAppId,
        playDetectionPath
    } = resolved.details;
    if (!exePath && !steamAppId) throw new Error('Local game setup is incomplete.');
    const gameId = gameMetadata.id;
    const gameName = gameMetadata.name;
    const libraryKey = `${gameMetadata.profileId}:${gameMetadata.libraryId}`;
    const needsSaveSync = input.needsSaveSync === true;
    const needsGameConfigSync = input.needsGameConfigSync === true;
    const exeName = exePath ? path.basename(exePath).toLowerCase() : 'steam.exe';
    const trackedExeName = path.basename(playDetectionPath || exePath || 'steam.exe').toLowerCase();
    const startTrackedSession = pid => {
        if (!runtimeRecovery || !gameId) return null;
        return runtimeRecovery.startSession({
            gameId,
            gameName,
            libraryKey,
            pid,
            exeName: trackedExeName,
            processConfirmed: !!pid && trackedExeName === exeName,
            startedAt: Date.now(),
            needsSaveSync,
            needsGameConfigSync
        });
    };

    const beforePreLaunch = phaseAuthority.resolve('pre-script');
    if (beforePreLaunch.preLaunchScript) await runScript(beforePreLaunch.preLaunchScript, true);
    const beforeCompanion = phaseAuthority.resolve('companion');
    if (beforeCompanion.companionPath) {
        try {
            if (beforeCompanion.companionPath.toLowerCase().endsWith('.exe')) {
                const comp = spawn(beforeCompanion.companionPath, [], { cwd: path.dirname(beforeCompanion.companionPath), detached: true, stdio: 'ignore' });
                comp.unref();
            } else { shell.openPath(beforeCompanion.companionPath); }
        } catch (err) { console.log("Companion launch failed", err); }
    }
    const launchDetails = phaseAuthority.resolve('launch');

    return new Promise(async (resolve, reject) => {
        const launchExePath = launchDetails.executablePath;
        const launchSteamAppId = launchDetails.steamAppId;
        const launchWorkingDirectory = launchDetails.workingDirectory;
        const launchArgv = Array.isArray(launchDetails.argv) ? launchDetails.argv : [];
        const launchPlayDetectionPath = launchDetails.playDetectionPath;
        const launchExt = launchExePath ? path.extname(launchExePath).toLowerCase() : '';
        const launchExeName = launchExePath ? path.basename(launchExePath).toLowerCase() : 'steam.exe';
        if (launchSteamAppId && !launchExePath) {
            try {
                await shell.openExternal(`steam://run/${launchSteamAppId}`);
                const session = launchPlayDetectionPath ? startTrackedSession(null) : null;
                resolve({ pid: null, exeName: 'steam.exe', runAsAdmin: false, untrackable: !launchPlayDetectionPath, sessionId: session && session.sessionId, startedAt: session && session.startedAt });
            } catch (error) {
                reject(error);
            }
            return;
        }
        if (launchDetails.runAsAdmin) {
            const env = {
                ...process.env,
                SAIL_APPROVED_EXECUTABLE: launchExePath,
                SAIL_APPROVED_WORKING_DIRECTORY: launchWorkingDirectory,
                SAIL_APPROVED_ARGV_JSON: JSON.stringify(launchArgv)
            };
            const command = [
                "$approvedExe = [Environment]::GetEnvironmentVariable('SAIL_APPROVED_EXECUTABLE')",
                "$approvedCwd = [Environment]::GetEnvironmentVariable('SAIL_APPROVED_WORKING_DIRECTORY')",
                "$approvedArgv = @((ConvertFrom-Json ([Environment]::GetEnvironmentVariable('SAIL_APPROVED_ARGV_JSON'))))",
                'Start-Process -FilePath $approvedExe -ArgumentList $approvedArgv -WorkingDirectory $approvedCwd -Verb RunAs'
            ].join('; ');
            spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, env });
            const trackable = launchExt === '.exe' || !!launchPlayDetectionPath;
            const session = trackable ? startTrackedSession(null) : null;
            resolve({ pid: null, exeName: launchExeName, runAsAdmin: true, untrackable: !trackable, sessionId: session && session.sessionId, startedAt: session && session.startedAt });
        } else if ((launchExt === '.lnk' || launchExt === '.bat' || launchExt === '.cmd') && launchArgv.length === 0) {
            await shell.openPath(launchExePath);
            const session = launchPlayDetectionPath ? startTrackedSession(null) : null;
            resolve({ pid: null, exeName: launchExeName, runAsAdmin: false, untrackable: !launchPlayDetectionPath, sessionId: session && session.sessionId, startedAt: session && session.startedAt });
        } else {
            const gameProcess = spawn(launchExePath, launchArgv, { cwd: launchWorkingDirectory, stdio: 'ignore' });

            if (launchDetails.highPriority && gameProcess.pid) {
                exec(`wmic process where processid=${gameProcess.pid} CALL setpriority 128`, () => { });
            }

            const session = startTrackedSession(gameProcess.pid);
            gameProcess.on('close', () => {
                try {
                    const afterClose = phaseAuthority.resolve('post-script');
                    if (afterClose.postLaunchScript) runScript(afterClose.postLaunchScript, false);
                } catch (_) {
                    console.warn('Post-launch script skipped because its local capability is no longer current.');
                }
                if (session && (!launchPlayDetectionPath || trackedExeName === launchExeName)) {
                    finishRuntimeSession({
                        gameId,
                        libraryKey,
                        sessionId: session.sessionId,
                        endedAt: Date.now(),
                        reason: 'process-close-event'
                    });
                }
                if (!e.sender.isDestroyed()) e.sender.send('game-closed', gameProcess.pid);
            });
            resolve({ pid: gameProcess.pid, exeName: exeName, runAsAdmin: false, sessionId: session && session.sessionId, startedAt: session && session.startedAt });
        }
    });
});

ipcMain.handle('get-system-specs', async () => {
    return new Promise((resolve) => {
        exec('wmic path win32_VideoController get name', (err, stdout) => {
            let gpuName = "Unknown GPU";
            if (!err && stdout) { const lines = stdout.split('\n'); if (lines.length > 1) gpuName = lines[1].trim(); }
            const display = screen.getPrimaryDisplay();
            resolve({
                os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0].model,
                ram: Math.round(os.totalmem() / 1024 / 1024 / 1024), gpu: gpuName,
                resolution: `${Math.round(display.size.width * display.scaleFactor)}x${Math.round(display.size.height * display.scaleFactor)}`
            });
        });
    });
});

// --- SAIL HUB: Custom Protocol Handler ---
function handleProtocolUrl(url) {
    try {
        // url looks like: sail-launcher://install-theme?url=https%3A%2F%2F...
        const parsed = new URL(url);
        const action = parsed.hostname; // e.g. "install-theme" or "install-plugin"
        if (action === 'cloud-callback') {
            const win = BrowserWindow.getAllWindows()[0];
            if (win) {
                if (win.isMinimized()) win.restore();
                win.show();
                win.focus();
                win.webContents.send('account-cloud-callback', {
                    success: parsed.searchParams.get('success') === '1',
                    provider: parsed.searchParams.get('provider') || '',
                    error: parsed.searchParams.get('error') || ''
                });
            }
            return;
        }
        const fileUrl = parsed.searchParams.get('url');
        if (fileUrl && (action === 'install-theme' || action === 'install-plugin')) {
            const win = BrowserWindow.getAllWindows()[0];
            if (win) {
                if (win.isMinimized()) win.restore();
                win.show();
                win.focus();
                win.webContents.send('hub-install', { action, fileUrl });
            }
        }
    } catch (err) { console.log('Protocol parse error:', err); }
}

// Download a Sail Hub item without exposing partial files or allowing an encoded
// filename to escape the per-user themes/plugins directory.
function downloadHubFile(fileUrl, targetDir, redirects = 0) {
    if (redirects > 6) return Promise.reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(fileUrl); } catch (_) { return Promise.reject(new Error('Invalid download URL')); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return Promise.reject(new Error('Only HTTP and HTTPS downloads are supported'));
    }

    let fileName;
    try { fileName = decodeURIComponent(path.posix.basename(parsed.pathname)); }
    catch (_) { return Promise.reject(new Error('Invalid download filename')); }
    if (!fileName || fileName === '.' || fileName === '..' || path.basename(fileName) !== fileName) {
        return Promise.reject(new Error('Invalid download filename'));
    }

    return new Promise((resolve, reject) => {
        const client = parsed.protocol === 'https:' ? https : http;
        const request = client.get(parsed, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                let redirectUrl;
                try { redirectUrl = new URL(response.headers.location, parsed).href; }
                catch (_) { reject(new Error('Invalid redirect URL')); return; }
                downloadHubFile(redirectUrl, targetDir, redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Download failed with HTTP ${response.statusCode || 'error'}`));
                return;
            }

            fs.mkdirSync(targetDir, { recursive: true });
            const filePath = path.join(targetDir, fileName);
            const partialPath = `${filePath}.${process.pid}.${Date.now()}.part`;
            const file = fs.createWriteStream(partialPath);
            let settled = false;
            const fail = (error) => {
                if (settled) return;
                settled = true;
                try { file.destroy(); } catch (_) {}
                fs.rm(partialPath, { force: true }, () => reject(error instanceof Error ? error : new Error(String(error))));
            };

            response.on('error', fail);
            file.on('error', fail);
            file.on('finish', () => {
                file.close((error) => {
                    if (error) return fail(error);
                    try {
                        fs.rmSync(filePath, { force: true });
                        fs.renameSync(partialPath, filePath);
                        settled = true;
                        resolve({ success: true, path: filePath, fileName });
                    } catch (moveError) {
                        fail(moveError);
                    }
                });
            });
            response.pipe(file);
        });
        request.setTimeout(30000, () => request.destroy(new Error('Download timed out')));
        request.on('error', reject);
    });
}

// IPC handler to download a file from a URL to the user's themes/plugins folder.
ipcMain.handle('hub-download-file', async (e, { fileUrl, type }) => {
    if (type !== 'theme' && type !== 'plugin') throw new Error('Invalid Sail Hub item type');
    const targetDir = path.join(app.getPath('userData'), type === 'theme' ? 'themes' : 'plugins');
    return downloadHubFile(fileUrl, targetDir);
});

const remoteDataService = createRemoteDataService();
registerRemoteDataIpc(ipcMain, remoteDataService);

async function resolveSteamMetadataForDownload(gameName, sourceId) {
    if (!DownloadSourceLogic.isSteamCatalogDownloadSource(sourceId)) return null;
    const cleanName = DownloadSourceLogic.cleanDownloadedGameName(gameName);
    if (!cleanName) return null;
    try {
        const response = await remoteDataService.execute({ operation: 'steam.storeSearch', query: cleanName });
        return DownloadSourceLogic.steamStoreMetadataForDownloadedGame(cleanName, response && response.data);
    } catch (_) {
        return null;
    }
}

// ============================================================
//  Game Download Engine — aria2 + link resolver + post-process
// ============================================================
const ARIA2_DL_URL = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip';
const DL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let aria2BinPath = null;
const activeDownloads = new Map(); // id -> { proc, dir, meta }
const downloadQuarantineCatalog = new DownloadQuarantineCatalog({
    catalogPath: path.join(app.getPath('userData'), 'download-quarantine-roots.json')
});
const downloadJobDirectories = new DownloadJobDirectoryRegistry({ quarantineCatalog: downloadQuarantineCatalog });
const downloadWork = createDownloadWorkCoordinator(downloadJobDirectories);
let browserDownloadCapture = { enabled: false, defaults: {} };
const browserDownloadWebContents = new Set();
const managedResolverWebContents = new Set();
const pendingBrowserDownloads = new Map();
const browserDownloadIntents = new BrowserDownloadIntentRegistry({ beginJob: beginDownloadJob });
const managedVerificationCoordinator = new ManagedVerificationCoordinator();

const AD_BLOCK_HOSTS = [
    'a-ads.com', 'ad.a-ads.com', 'aads.com', 'hilltopads.net', 'hilltopads.com', 'clickadu.com',
    'adcash.com', 'revcontent.com', 'mgid.com', 'adskeeper.com', 'admaven.com', 'galaksion.com',
    'onclickalgo.com', 'onclickperformance.com', 'clickaine.com', 'realsrv.com', 'tsyndicate.com',
    'vidoomy.com', 'smartadserver.com', 'yieldmo.com', 'admixer.net', 'bidvertiser.com',
    'adsterra.net', 'highperformanceformat.com', 'pushwhy.com', 'push-ad.com', 'propu.sh',
    'adservetx.media', 'adsco.re', 'monetag.com', 'pushpushgo.com', 'partners.adxbid.info',
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
    'adservice.google.com', 'adnxs.com', 'popads.net', 'propellerads.com', 'poptm.com', 'popcash.net',
    'taboola.com', 'outbrain.com', 'exoclick.com', 'exosrv.com', 'juicyads.com', 'adsterra.com',
    'a-ads.com', 'clickadu.com', 'hilltopads.com', 'mgid.com', 'revcontent.com', 'bidvertiser.com',
    'adcash.com', 'onclickads.net', 'highperformanceformat.com', 'effectivecreativeformats.com',
    'propu.sh', 'onclicksuper.com', 'admaven.com', 'popunder', 'trafficjunky.com', 'ero-advertising.com',
    'plugrush.com', 'adsterra', 'pushwhy', 'amazon-adsystem.com', 'media.net', 'criteo.com'
];
let adBlockEnabled = true;
const HUMAN_VERIFICATION_RESOURCE_HOSTS = new Set(DEFAULT_VERIFICATION_RESOURCE_HOSTS);
// hosts that are legitimate download targets — never treat these as ads
const DL_HOST_ALLOW = /(gofile|pixeldrain|datanodes|fuckingfast|1fichier|mediafire|mega\.nz|megadb|qiwi|multiup|bowfile|hexload|vikingfile|rootz|akirabox|filekeeper|fileditch(?:files)?|buzzheavier|bzzhr|steamrip|fitgirl|rutor\.info|1337x)/i;
function isAdHost(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
        if (HUMAN_VERIFICATION_RESOURCE_HOSTS.has(h)) return false;
        if (DL_HOST_ALLOW.test(h)) return false;
        if (AD_BLOCK_HOSTS.some(d => h.includes(d))) return true;
        // generic ad/popunder subdomains (ad., ads., adserver., banner., popunder., popads.)
        if (/(^|\.)(ads?|adserver|adserv|adservice|banner|banners|popunder|popads|popcash)\./.test(h)) return true;
        return false;
    } catch (e) { return false; }
}
function applyAdBlock(sess) {
    if (!sess || sess.__sailAdBlock) return;
    sess.__sailAdBlock = true;
    sess.webRequest.onBeforeRequest((details, cb) => {
        if (adBlockEnabled && details.url && isAdHost(details.url)) return cb({ cancel: true });
        cb({});
    });
}
ipcMain.handle('set-adblock', (e, enabled) => { adBlockEnabled = !!enabled; return adBlockEnabled; });

function dlHttpToFile(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 6) return reject(new Error('Too many redirects'));
        const client = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(dest);
        client.get(url, { headers: { 'User-Agent': DL_UA } }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close(); fs.unlink(dest, () => {});
                let loc = response.headers.location;
                try { loc = new URL(loc, url).href; } catch (e) {}
                return resolve(dlHttpToFile(loc, dest, redirects + 1));
            }
            if (response.statusCode !== 200) { file.close(); fs.unlink(dest, () => {}); return reject(new Error('HTTP ' + response.statusCode)); }
            response.pipe(file);
            file.on('finish', () => file.close(() => resolve(dest)));
        }).on('error', (err) => { file.close(); fs.unlink(dest, () => {}); reject(err); });
    });
}

function findFileRecursive(dir, fileName, depth = 0) {
    if (depth > 8) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isFile() && ent.name.toLowerCase() === fileName.toLowerCase()) return full;
        if (ent.isDirectory()) { const r = findFileRecursive(full, fileName, depth + 1); if (r) return r; }
    }
    return null;
}

async function ensureAria2(wc) {
    if (aria2BinPath && fs.existsSync(aria2BinPath)) return aria2BinPath;
    const binDir = path.join(app.getPath('userData'), 'bin');
    const target = path.join(binDir, 'aria2c.exe');
    if (fs.existsSync(target)) { aria2BinPath = target; return target; }
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    if (wc) wc.send('download-engine-status', { state: 'installing', label: 'Setting up download engine (first run)...' });
    const zipPath = path.join(binDir, 'aria2.zip');
    await dlHttpToFile(ARIA2_DL_URL, zipPath);
    const extractDir = path.join(binDir, '_aria2_extract');
    await new Promise((res, rej) => _7z.unpack(zipPath, extractDir, (err) => err ? rej(err) : res()));
    const found = findFileRecursive(extractDir, 'aria2c.exe');
    if (!found) throw new Error('aria2c.exe missing after extraction');
    fs.copyFileSync(found, target);
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.unlinkSync(zipPath); } catch (e) {}
    aria2BinPath = target;
    return target;
}

function beginDownloadJob(id, opts) {
    return downloadJobDirectories.begin(id, {
        gameName: opts && opts.gameName,
        installDir: opts && opts.installDir,
        defaultRoot: path.join(app.getPath('userData'), 'SailDownloads')
    });
}

async function finishDownloadJob(jobRef, result, steamMetadataPromise = null) {
    const job = jobRef && jobRef.job ? jobRef.job : jobRef;
    if (!job || job.cancelled) throw new Error('The cancelled download cannot be completed.');
    const publication = await downloadJobDirectories.publish(jobRef);
    const publishedResult = downloadJobDirectories.mapPublishedResult(result, publication);
    downloadJobDirectories.forget(job);
    let adopted = null;
    let location = null;
    let warning = String(publishedResult.warning || '').slice(0, 2000);
    const steamMetadata = await Promise.resolve(
        steamMetadataPromise || resolveSteamMetadataForDownload(publishedResult.gameName, publishedResult.sourceId)
    ).catch(() => null);
    try {
        const canRegisterGame = publishedResult.autoAdd !== false
            && publishedResult.usable === true
            && publishedResult.needsInstall !== true
            && publishedResult.installFailed !== true
            && !!publishedResult.exePath
            && fs.existsSync(publishedResult.exePath);
        if (canRegisterGame) {
            adopted = gateAProfileStore().registerDownloadedGameProposal({
                gameName: publishedResult.gameName,
                executablePath: publishedResult.exePath,
                folderPath: publishedResult.folder,
                coverPath: publishedResult.cover,
                sourceId: publishedResult.sourceId,
                steamAppId: steamMetadata && steamMetadata.steamAppId
            });
            location = adopted.location;
        } else if (publishedResult.folder) {
            location = gateAProfileStore().createLauncherDirectoryCapability(publishedResult.folder);
            if (publishedResult.autoAdd !== false && !warning) {
                warning = 'The files were saved, but Sail did not add the game because setup has not produced a playable executable yet.';
            }
        }
    } catch (error) {
        warning = `${warning ? `${warning} ` : ''}The files were saved, but local setup still needs to be completed.`;
    }
    return {
        gameName: String(publishedResult.gameName || 'Download').slice(0, 240),
        usable: publishedResult.usable === true,
        installFailed: publishedResult.installFailed === true,
        warning,
        gameId: adopted ? adopted.gameId : 'launcher-device',
        execution: adopted && adopted.execution || null,
        localSetupStatus: adopted && adopted.execution ? 'active' : 'local-setup-required',
        location,
        state: adopted && adopted.state || null,
        snapshot: adopted && adopted.snapshot || null
    };
}

function installerTargetForDownload(downloadDir, installerPath) {
    const extractedPayload = path.resolve(downloadDir, '_game');
    const resolvedInstaller = path.resolve(String(installerPath || ''));
    const relative = path.relative(extractedPayload, resolvedInstaller);
    const installerIsInsideExtractedPayload = relative === ''
        || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    return path.join(downloadDir, installerIsInsideExtractedPayload ? 'i' : '_game');
}

function applyInstallerCompletionPolicy(result, opts) {
    if (!result || (result.needsInstall !== true && result.installFailed !== true)) return result;
    result.autoAdd = false;
    result.exePath = '';
    if (result.installFailed) {
        result.warning = 'Downloaded, but auto-install did not complete'
            + (result.installError ? ' (' + result.installError + ')' : '')
            + '. Open the folder and run setup.exe manually.';
    } else if (opts && opts.autoInstall === false) {
        result.warning = 'Downloaded, but automatic setup is turned off. Open the folder and run setup.exe manually.';
    } else {
        result.warning = 'Downloaded, but setup could not be started. Open the folder and run setup.exe manually.';
    }
    return result;
}

async function retainDownloadJobError(jobRef) {
    const job = jobRef && jobRef.job ? jobRef.job : jobRef;
    if (job && !job.cancelled) await downloadJobDirectories.setState(jobRef, 'error');
}

// --- Host scrapers (pure HTTP — ported from Black-Pearl) ---------------------
// These resolve a file-host page link directly into a downloadable URL via the
// host's own API/redirect, WITHOUT opening a browser, so the resolver can never
// "catch an ad". Each returns an array of { url, kind, headers?, name? } or null.

// Generic HTTP request with optional body and redirect control. Returns
// { status, headers, body }. follow:false lets callers read 3xx Location headers.
function dlRequest(method, url, { headers, body, follow = true, timeoutMs = 25000, headersOnly = false } = {}, _depth = 0) {
    return new Promise((resolve, reject) => {
        if (_depth > 6) return reject(new Error('Too many redirects'));
        let u; try { u = new URL(url); } catch (e) { return reject(e); }
        const client = u.protocol === 'https:' ? https : http;
        const opts = { method, headers: Object.assign({ 'User-Agent': DL_UA, 'Accept': '*/*' }, headers || {}) };
        const req = client.request(u, opts, (res) => {
            if (follow && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let loc = res.headers.location; try { loc = new URL(loc, url).href; } catch (e) {}
                res.resume(); return resolve(dlRequest(method, loc, { headers, body, follow, timeoutMs, headersOnly }, _depth + 1));
            }
            if (headersOnly) {
                const result = { status: res.statusCode, headers: res.headers, body: '' };
                res.on('error', () => {});
                res.destroy();
                return resolve(result);
            }
            let data = ''; res.setEncoding('utf8');
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(Math.max(1000, Math.min(30000, Number(timeoutMs) || 25000)), () => req.destroy(new Error('timeout')));
        if (body) req.write(body);
        req.end();
    });
}

async function dlElectronRequest(method, url, { headers, body, follow = false, timeoutMs = 25000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(30000, Number(timeoutMs) || 25000)));
    try {
        const requestHeaders = Object.assign({ 'User-Agent': DL_UA, 'Accept': '*/*' }, headers || {});
        delete requestHeaders['Content-Length'];
        delete requestHeaders['content-length'];
        const response = await net.fetch(url, {
            method,
            headers: requestHeaders,
            body: body || undefined,
            redirect: follow ? 'follow' : 'manual',
            signal: controller.signal
        });
        const outputHeaders = {};
        for (const [name, value] of response.headers.entries()) outputHeaders[name.toLowerCase()] = value;
        if (typeof response.headers.getSetCookie === 'function') outputHeaders['set-cookie'] = response.headers.getSetCookie();
        return { status: response.status, headers: outputHeaders, body: await response.text() };
    } finally {
        clearTimeout(timeout);
    }
}
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GOFILE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0';

// GoFile: the host rotates its website-token generator. The resolver discovers
// the current same-origin script, caches one guest account, and walks folders.
async function scrapeGofile(rawUrl) {
    return resolveGofileUrl(rawUrl, {
        request: dlElectronRequest,
        userAgent: GOFILE_UA
    });
}

function mergeDownloadCookies(current, setCookie) {
    const rows = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
    const cookies = new Map(String(current || '').split(/;\s*/).filter(Boolean).map(value => {
        const split = value.indexOf('=');
        return split > 0 ? [value.slice(0, split), value.slice(split + 1)] : ['', ''];
    }).filter(row => row[0]));
    for (const row of rows) {
        const pair = String(row || '').split(';')[0];
        const split = pair.indexOf('=');
        if (split > 0) cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function scrapeSteamRipGofileContainer(rawUrl, referer) {
    const containerUrl = normalizeFileCryptContainerUrl(rawUrl);
    if (!containerUrl || !/^https:\/\/steamrip\.com\//i.test(String(referer || ''))) return null;
    let proofStarted = false;
    const browserResult = await resolveWithSystemChromium(containerUrl, FILECRYPT_CHALLENGE_EXPRESSION, {
        executablePath: findSystemChromiumExecutable(),
        timeoutMs: 6 * 60 * 1000,
        evaluationTimeoutMs: 15000,
        tempRoot: path.join(app.getPath('temp'), 'sail-filecrypt-resolver'),
        navigationReferrer: referer,
        clickSelector: '.pow-captcha__box',
        clickTimeoutMs: 20000,
        isAllowedUrl: parsed => /^(?:www\.)?filecrypt\.cc$/i.test(parsed.hostname),
        captureResponseUrl: value => {
            try {
                const parsed = new URL(value);
                return parsed.origin === new URL(containerUrl).origin
                    && /^\/captchasession\/[A-Fa-f0-9]+\.json$/.test(parsed.pathname);
            } catch (_) { return false; }
        },
        handleResponse: async response => {
            if (proofStarted) return null;
            let payload = null;
            try { payload = JSON.parse(response && response.body || ''); } catch (_) {}
            if (!payload || !payload.challenge) return null;
            proofStarted = true;
            const startedAt = Date.now();
            const proof = await solveFileCryptProof(payload.challenge, { timeoutMs: 5 * 60 * 1000 });
            const remaining = 30000 - (Date.now() - startedAt);
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
            proof.elapsed = Date.now() - startedAt;
            return { expression: fileCryptSubmitExpression({ challenge: payload.challenge }, proof) };
        },
        acceptResult: value => value && ['container', 'rejected', 'error'].includes(value.stage)
    });
    if (!browserResult || browserResult.stage !== 'container'
        || normalizeFileCryptContainerUrl(browserResult.location) !== containerUrl) return null;

    const containerHealth = classifyFileCryptResponse({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: String(browserResult.statusText || '')
    });
    if (containerHealth.status === HEALTH_STATES.DOWN) {
        throw buildLinkDownError(containerUrl, containerHealth.reason);
    }

    for (const link of browserResult.links || []) {
        const details = gofileShareDetails(link && link.href);
        if (details && details.contentId) return scrapeGofile(link.href);
    }

    const candidates = fileCryptLinkCandidates(browserResult.links, containerUrl);
    if (!candidates.length) return null;
    let cookie = String(browserResult.cookie || '').replace(/[\r\n]/g, '').slice(0, 8192);
    const userAgent = String(browserResult.ua || GOFILE_UA).replace(/[\r\n]/g, '').slice(0, 1024);
    for (const candidate of candidates) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const headers = {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml',
                'Referer': containerUrl
            };
            if (cookie) headers.Cookie = cookie;
            const response = await dlRequest('GET', candidate, { headers, follow: false, timeoutMs: 15000 });
            cookie = mergeDownloadCookies(cookie, response && response.headers && response.headers['set-cookie']);
            const locations = [response && response.headers && response.headers.location];
            const body = String(response && response.body || '');
            for (const match of body.matchAll(/https:\/\/gofile\.io\/d\/[A-Za-z0-9_-]{4,128}/gi)) locations.push(match[0]);
            const goMatch = body.match(/https:\/\/(?:www\.)?filecrypt\.cc\/Go\/[A-Fa-f0-9]{40,64}\.html/i);
            if (goMatch) {
                const goUrl = new URL(goMatch[0]);
                if (goUrl.origin === new URL(containerUrl).origin) {
                    const goHeaders = Object.assign({}, headers, { Referer: candidate });
                    if (cookie) goHeaders.Cookie = cookie;
                    const goResponse = await dlRequest('GET', goUrl.href, {
                        headers: goHeaders,
                        follow: false,
                        timeoutMs: 15000
                    });
                    cookie = mergeDownloadCookies(cookie, goResponse && goResponse.headers && goResponse.headers['set-cookie']);
                    locations.push(goResponse && goResponse.headers && goResponse.headers.location);
                }
            }
            for (const location of locations) {
                const details = gofileShareDetails(location);
                if (details && details.contentId) return scrapeGofile(location);
            }
        }
    }
    return null;
}
async function scrapePixeldrain(rawUrl, referer) {
    return resolvePixeldrainUrl(rawUrl, {
        request: dlElectronRequest,
        userAgent: CHROME_UA,
        referer,
        proxyUrls: pixeldrainProxies
    });
}
async function scrapeDatanodes(rawUrl, referer) {
    return resolveDataNodesUrl(rawUrl, {
        request: dlRequest,
        userAgent: CHROME_UA,
        referer,
        acceptDirectUrl: url => !isAdHost(url)
    });
}
const BUZZHEAVIER_BROWSER_RESOLVE_JS = `(async function () {
    var text = String(document.body && document.body.innerText || '').replace(/\\s+/g, ' ');
    if (/whatever lived here has returned to the void/i.test(text)
        || /every file is given time.{0,160}this one(?:'s| has) ran out/i.test(text)) {
        return { linkHealth: 'down', healthReason: 'buzzheavier-page-reports-down' };
    }
    var controls = [].slice.call(document.querySelectorAll('[hx-get]'));
    var control = controls.find(function (node) { return /\\/download\\?t=/i.test(node.getAttribute('hx-get') || ''); });
    if (!control) return null;
    var endpoint = new URL(control.getAttribute('hx-get'), location.href);
    endpoint.searchParams.delete('alt');
    if (window.__sailBuzzHeavierEndpoint === endpoint.href) return null;
    window.__sailBuzzHeavierEndpoint = endpoint.href;
    try {
        var response = await fetch(endpoint.href, {
            method: 'GET',
            credentials: 'include',
            redirect: 'manual',
            headers: { 'HX-Current-URL': location.href, 'HX-Request': 'true' }
        });
        return {
            url: response.headers.get('HX-Redirect') || response.headers.get('Location') || '',
            pageUrl: location.origin + location.pathname.replace(/\\/$/, ''),
            userAgent: navigator.userAgent
        };
    } catch (error) { return null; }
})();`;

const BUZZHEAVIER_BROWSER_HEALTH_JS = `(function () {
    var text = String(document.body && document.body.innerText || '').replace(/\\s+/g, ' ');
    if (/whatever lived here has returned to the void/i.test(text)
        || /every file is given time.{0,160}this one(?:'s| has) ran out/i.test(text)) {
        return { status: 'down', reason: 'buzzheavier-page-reports-down' };
    }
    var control = [].slice.call(document.querySelectorAll('[hx-get]')).find(function (node) {
        return /\\/download\\?t=/i.test(node.getAttribute('hx-get') || '');
    });
    return control ? { status: 'available', reason: 'buzzheavier-token-available' } : null;
})();`;

async function checkBuzzheavierWithSystemBrowser(rawUrl, timeoutMs = 8000, sourceReferer = '') {
    const executablePath = findSystemChromiumExecutable();
    if (!executablePath) return null;
    try {
        return await resolveWithSystemChromium(rawUrl, BUZZHEAVIER_BROWSER_HEALTH_JS, {
            executablePath,
            tempRoot: path.join(app.getPath('temp'), 'SailLauncherHostHealth'),
            timeoutMs,
            navigationReferrer: sourceReferer,
            isAllowedUrl: parsed => BUZZHEAVIER_HOST_RE.test(parsed.hostname),
            acceptResult: value => value && [HEALTH_STATES.AVAILABLE, HEALTH_STATES.DOWN].includes(value.status)
        });
    } catch (_) {
        return null;
    }
}

const DATANODES_BROWSER_HEALTH_JS = `(function () {
    var text = String(document.body && document.body.innerText || '').replace(/\\s+/g, ' ');
    if (/\\bfile not found\\b/i.test(text)
        && /the file you were looking for could not be found|the file expired|the file was deleted/i.test(text)) {
        return { status: 'down', reason: 'datanodes-page-reports-down' };
    }
    var active = document.querySelector('download-countdown,#downloadForm,form[action*="/download"]');
    return active ? { status: 'available', reason: 'datanodes-download-page-active' } : null;
})();`;

async function checkDatanodesWithSystemBrowser(rawUrl, timeoutMs = 8000, sourceReferer = '') {
    const executablePath = findSystemChromiumExecutable();
    if (!executablePath) return null;
    try {
        return await resolveWithSystemChromium(rawUrl, DATANODES_BROWSER_HEALTH_JS, {
            executablePath,
            tempRoot: path.join(app.getPath('temp'), 'SailLauncherHostHealth'),
            timeoutMs,
            navigationReferrer: sourceReferer,
            isAllowedUrl: parsed => DATANODES_HOST_RE.test(parsed.hostname),
            acceptResult: value => value && [HEALTH_STATES.AVAILABLE, HEALTH_STATES.DOWN].includes(value.status)
        });
    } catch (_) {
        return null;
    }
}

async function resolveBuzzheavierWithSystemBrowser(rawUrl, timeoutMs = 20000, sourceReferer = '') {
    const executablePath = findSystemChromiumExecutable();
    if (!executablePath) return null;
    try {
        const result = await resolveWithSystemChromium(rawUrl, BUZZHEAVIER_BROWSER_RESOLVE_JS, {
            executablePath,
            tempRoot: path.join(app.getPath('temp'), 'SailLauncherHostBrowser'),
            timeoutMs,
            navigationReferrer: sourceReferer,
            isAllowedUrl: parsed => BUZZHEAVIER_HOST_RE.test(parsed.hostname),
            acceptResult: value => value && (value.linkHealth === HEALTH_STATES.DOWN
                || typeof value.url === 'string' && /^https:\/\//i.test(value.url))
        });
        if (result && result.linkHealth === HEALTH_STATES.DOWN) {
            return { linkHealth: HEALTH_STATES.DOWN, healthReason: result.healthReason || 'buzzheavier-page-reports-down' };
        }
        if (!result || !result.url) return null;
        let pageUrl = rawUrl;
        try {
            const parsedPage = new URL(result.pageUrl || rawUrl);
            if (parsedPage.protocol === 'https:' && !parsedPage.username && !parsedPage.password
                && BUZZHEAVIER_HOST_RE.test(parsedPage.hostname)) pageUrl = parsedPage.href;
        } catch (_) {}
        const browserUserAgent = String(result.userAgent || CHROME_UA)
            .replace(/[\r\n]/g, '')
            .slice(0, 512);
        return {
            url: result.url,
            pageUrl,
            headers: ['Referer: ' + pageUrl, 'User-Agent: ' + browserUserAgent]
        };
    } catch (error) {
        if (process.argv.includes('--sail-host-transfer-probe')) {
            console.error('BUZZ_SYSTEM_BROWSER_PROBE=' + JSON.stringify({ message: error.message }));
        }
        return null;
    }
}

function resolveBuzzheavierWithElectronBrowser(rawUrl, timeoutMs = 15000, sourceReferer = '') {
    return new Promise((resolve) => {
        let done = false, win = null, poller = null, sess = null, downloadHandler = null, browserUserAgent = CHROME_UA;
        const finish = (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (poller) clearInterval(poller);
            try { if (sess && downloadHandler) sess.removeListener('will-download', downloadHandler); } catch (_) {}
            try { if (win && win.webContents) managedResolverWebContents.delete(win.webContents.id); } catch (_) {}
            try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
            resolve(value || null);
        };
        const timer = setTimeout(async () => {
            if (process.argv.includes('--sail-host-transfer-probe') && win && !win.isDestroyed()) {
                try {
                    const diagnostic = await win.webContents.executeJavaScript(`({
                        url: location.href,
                        title: document.title,
                        text: String(document.body && document.body.innerText || '').slice(0, 800),
                        userAgent: navigator.userAgent,
                        webdriver: navigator.webdriver,
                        hasDownloadControl: !!document.querySelector('[hx-get*="/download"]')
                    })`, true);
                    const cookies = await win.webContents.session.cookies.get({ url: rawUrl });
                    diagnostic.cookieNames = cookies.map(cookie => cookie.name);
                    console.error('BUZZ_TRANSFER_PROBE_DIAGNOSTIC=' + JSON.stringify(diagnostic));
                } catch (_) {}
            }
            finish(null);
        }, timeoutMs);
        try {
            win = new BrowserWindow({
                show: false,
                width: 1100,
                height: 760,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true,
                    webSecurity: true,
                    backgroundThrottling: false
                }
            });
        } catch (_) { return finish(null); }
        managedResolverWebContents.add(win.webContents.id);

        sess = win.webContents.session;
        applyAdBlock(sess);
        // Cloudflare validates browser client hints against the browser's real Chromium
        // version. A hard-coded Chrome UA can disagree with Electron's hints and keep the
        // managed check in a loop, so retain the runtime UA and remove only Electron's tag.
        browserUserAgent = win.webContents.getUserAgent()
            .replace(/\s(?:Electron|SailLauncher)\/[\d.]+/gi, '')
            .trim();
        win.webContents.setUserAgent(browserUserAgent);
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const keepOnProvider = (event, target) => {
            try {
                if (!BUZZHEAVIER_HOST_RE.test(new URL(target).hostname)) event.preventDefault();
            } catch (_) { event.preventDefault(); }
        };
        win.webContents.on('will-navigate', keepOnProvider);
        win.webContents.on('will-redirect', keepOnProvider);

        const browserHeaders = async pageUrl => {
            const headers = [`Referer: ${pageUrl}`, `User-Agent: ${browserUserAgent}`];
            try {
                const cookies = await sess.cookies.get({ url: pageUrl });
                const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                if (cookieHeader) headers.push(`Cookie: ${cookieHeader}`);
            } catch (_) {}
            return headers;
        };
        downloadHandler = (event, item, downloadWebContents) => {
            if (downloadWebContents !== win.webContents) return;
            const fileUrl = item.getURL();
            let name = '';
            try { name = item.getFilename() || ''; } catch (_) {}
            try { item.cancel(); } catch (_) {}
            browserHeaders(rawUrl).then(headers => finish({
                url: fileUrl,
                name,
                pageUrl: rawUrl,
                headers,
                capturedDownload: true
            })).catch(() => finish(null));
        };
        sess.on('will-download', downloadHandler);

        const inspect = () => {
            if (done || !win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return;
            win.webContents.executeJavaScript(BUZZHEAVIER_BROWSER_RESOLVE_JS, true)
                .then(async result => {
                    if (result && result.linkHealth === HEALTH_STATES.DOWN) {
                        finish({ linkHealth: HEALTH_STATES.DOWN, healthReason: result.healthReason || 'buzzheavier-page-reports-down' });
                        return;
                    }
                    if (result && result.url) {
                        result.headers = await browserHeaders(result.pageUrl || rawUrl);
                        finish(result);
                    }
                })
                .catch(() => {});
        };
        win.webContents.on('did-finish-load', inspect);
        poller = setInterval(inspect, 1200);
        const loadOptions = sourceReferer ? { httpReferrer: sourceReferer } : undefined;
        win.loadURL(rawUrl, loadOptions).catch(() => finish(null));
    });
}

async function resolveBuzzheavierWithBrowser(rawUrl, timeoutMs = 35000, sourceReferer = '') {
    const systemResult = await resolveBuzzheavierWithSystemBrowser(rawUrl, Math.min(timeoutMs, 20000), sourceReferer);
    if (systemResult) return systemResult;
    return resolveBuzzheavierWithElectronBrowser(rawUrl, Math.min(timeoutMs, 15000), sourceReferer);
}

const BUZZHEAVIER_TRANSFER_HOST_RE = /(^|\.)(?:buzzheavier\.com|bzzhr\.(?:to|co)|fuckingfast\.net)$/i;
const BUZZHEAVIER_FALLBACK_DNS = Object.freeze(['1.1.1.1', '8.8.8.8']);

function usableSystemDnsAddress(value) {
    const address = String(value || '').toLowerCase();
    if (!nodeNet.isIP(address) || address === '0.0.0.0' || address === '::' || address === '::1') return false;
    return !address.startsWith('127.');
}

async function managedTransferNeedsDnsFallback(rawUrl) {
    let host;
    try { host = new URL(rawUrl).hostname; } catch (_) { return false; }
    if (!BUZZHEAVIER_TRANSFER_HOST_RE.test(host) && !FUCKINGFAST_HOST_RE.test(host)) return false;
    try {
        const addresses = await dnsPromises.lookup(host, { all: true, verbatim: true });
        return !addresses.some(entry => usableSystemDnsAddress(entry && entry.address));
    } catch (_) { return true; }
}

async function scrapeBuzzheavier(rawUrl, referer) {
    const resolved = await resolveBuzzHeavierUrl(rawUrl, {
        request: dlRequest,
        userAgent: CHROME_UA,
        referer,
        acceptDirectUrl: url => !isAdHost(url),
        // Give ordinary BuzzHeavier pages one short invisible pass first. Pages
        // that really need a human challenge still fall through to the visible,
        // provider-scoped verification handoff below.
        browserResolve: (pageUrl, sourceReferer) => resolveBuzzheavierWithSystemBrowser(
            pageUrl,
            8000,
            sourceReferer
        )
    });
    if (!resolved || !resolved.length) return resolved;
    return Promise.all(resolved.map(async file => {
        if (!await managedTransferNeedsDnsFallback(file.url)) return file;
        return Object.assign({}, file, { dnsServers: BUZZHEAVIER_FALLBACK_DNS.slice() });
    }));
}

async function scrapeFileditch(rawUrl) {
    return resolveFileDitchUrl(rawUrl, {
        request: dlRequest,
        userAgent: CHROME_UA,
        acceptDirectUrl: url => !isAdHost(url)
    });
}
async function scrapeFuckingfast(rawUrl) {
    const u = new URL(rawUrl);
    if (!FUCKINGFAST_HOST_RE.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const id = parts[0] && parts[0].toLowerCase() === 'f' ? parts[1] : parts[0];
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(id || '')) return null;
    const pageUrl = u.origin + u.pathname.replace(/\/$/, '');
    const goUrl = `${u.origin}/f/${encodeURIComponent(id)}/go`;
    try {
        const page = await dlElectronRequest('GET', pageUrl, {
            headers: { 'User-Agent': CHROME_UA, Referer: u.origin + '/' },
            follow: false,
            timeoutMs: 10000
        });
        if (!page || page.status < 200 || page.status >= 400) return null;
        const cookie = mergeDownloadCookies('', page.headers && page.headers['set-cookie']);
        const headers = {
            'User-Agent': CHROME_UA,
            Accept: '*/*',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'HX-Current-URL': pageUrl,
            'HX-Request': 'true',
            Origin: u.origin,
            Referer: pageUrl
        };
        if (cookie) headers.Cookie = cookie;
        const response = await dlElectronRequest('POST', goUrl, {
            headers,
            body: '',
            follow: false,
            timeoutMs: 10000
        });
        const captured = extractFuckingFastBrowserDownload({
            status: response && response.status,
            headers: response && response.headers,
            body: response && response.body,
            url: goUrl
        }, rawUrl);
        if (captured) return [{
            url: captured.url,
            kind: 'http',
            maxConn: 1,
            disableIpv6: true,
            ...(await managedTransferNeedsDnsFallback(captured.url)
                ? { dnsServers: BUZZHEAVIER_FALLBACK_DNS.slice() }
                : {}),
            name: captured.name || ''
        }];
    } catch (_) {}
    return null;
}
async function scrapeMediafire(rawUrl) {
    const res = await dlRequest('GET', rawUrl, { headers: { 'User-Agent': CHROME_UA } });
    let m = res.body.match(/href="([^"]+mediafire\.com\/(?:file|view|download)\/[^"]+\?dkey=[^"]+)"/);
    if (m) return [{ url: m[1].startsWith('//') ? 'https:' + m[1] : m[1], kind: 'http' }];
    m = res.body.match(/href="(https?:\/\/download\d+\.mediafire\.com\/[^"]+)"/);
    if (m) return [{ url: m[1], kind: 'http' }];
    return null;
}
// FileKeeper (filekeeper.net) — XFileSharing-style, but the op=download2 POST 302s
// to a signed CDN URL (tunnelN.dlproxy.uk) with NO file extension, so the generic
// scrapeXFS extension check rejects it. Handle it directly: the file code is the
// first path segment and the real filename is the last segment.
async function scrapeFilekeeper(rawUrl) {
    return resolveFileKeeperUrl(rawUrl, {
        request: dlRequest,
        userAgent: CHROME_UA
    });
}

async function scrapeAkiraBox(rawUrl) {
    return resolveAkiraBoxUrl(rawUrl, {
        request: dlRequest,
        userAgent: CHROME_UA
    });
}

async function scrape1337x(rawUrl) {
    return resolve1337xUrl(rawUrl, {
        request: dlRequest,
        userAgent: CHROME_UA
    });
}
const X1337_SYSTEM_BROWSER_RESOLVE_JS = [
    '(function(){',
    "if(document.readyState!=='complete'||/just a moment/i.test(document.title||''))return null;",
    "var links=[].slice.call(document.querySelectorAll('a[href]'));",
    "var magnet=links.find(function(link){return /^magnet:\\?xt=urn:btih:[A-Za-z0-9]{32,64}(?:&|$)/i.test(link.href||'');});",
    "if(magnet)return {url:magnet.href,name:(document.title||'Torrent download').slice(0,240),pageUrl:location.href,userAgent:navigator.userAgent};",
    "var torrent=links.find(function(link){try{var parsed=new URL(link.href,location.href);return parsed.protocol==='https:'&&/(^|\\.)1337x\\.(?:to|st|gd|is|tw|ws)$/i.test(parsed.hostname)&&/\\.torrent$/i.test(parsed.pathname);}catch(e){return false;}});",
    "return torrent?{url:torrent.href,name:(document.title||'Torrent download').slice(0,240),pageUrl:location.href,userAgent:navigator.userAgent}:null;",
    '})()'
].join('');

async function resolve1337xWithSystemBrowser(rawUrl, timeoutMs = 20000, sourceReferer = '', signal = null) {
    const executablePath = findSystemChromiumExecutable();
    if (!executablePath) return null;
    try {
        const result = await resolveWithSystemChromium(rawUrl, X1337_SYSTEM_BROWSER_RESOLVE_JS, {
            executablePath,
            tempRoot: path.join(app.getPath('temp'), 'SailLauncherHostBrowser'),
            timeoutMs,
            navigationReferrer: sourceReferer,
            isAllowedUrl: parsed => X1337_HOST_RE.test(parsed.hostname),
            acceptResult: value => value && managedHostUrlAllowed('1337x', value.url, rawUrl),
            signal
        });
        if (!result || !managedHostUrlAllowed('1337x', result.url, rawUrl)) return null;
        if (/^magnet:/i.test(result.url)) {
            return [{ url: result.url, name: result.name || 'Torrent download', kind: 'magnet', maxConn: 1 }];
        }
        const pageUrl = managedHostPageAllowed('1337x', new URL(result.pageUrl || rawUrl), rawUrl)
            ? result.pageUrl || rawUrl
            : rawUrl;
        const browserUserAgent = String(result.userAgent || CHROME_UA).replace(/[\r\n]/g, '').slice(0, 512);
        return [{
            url: result.url,
            name: result.name || 'Torrent download',
            kind: 'http',
            maxConn: 1,
            headers: ['Referer: ' + pageUrl, 'User-Agent: ' + browserUserAgent]
        }];
    } catch (_) {
        return null;
    }
}
// MegaDB requires both the approved source referrer and its short on-page timer.
// Keep that handshake in the testable host resolver rather than downloading the
// referrer-error HTML page as though it were a game archive.
async function scrapeXFS(rawUrl, referer) {
    return resolveMegaDbUrl(rawUrl, {
        request: dlRequest,
        userAgent: CHROME_UA,
        referer
    });
}

// rutor.info — Russian torrent tracker. Fetch the torrent page, pull the magnet link
// (preferred, works without downloading a .torrent file), or fall back to the direct
// torrent download URL. Direct /download/{id} links are returned as-is.
async function scrapeRutor(rawUrl) {
    if (/(?:d\.)?rutor\.info\/download\/\d+/i.test(rawUrl)) return [{ url: rawUrl, kind: 'http' }];
    const res = await dlRequest('GET', rawUrl, { headers: { 'User-Agent': CHROME_UA } });
    if (!res || !res.body) return null;
    const magnet = res.body.match(/href="(magnet:\?[^"]+)"/i);
    if (magnet) return [{ url: magnet[1].replace(/&amp;/gi, '&'), kind: 'magnet' }];
    const dl = res.body.match(/href="((?:https?:\/\/d\.rutor\.info)?\/download\/\d+[^"]*)"/i);
    if (dl) {
        const u = dl[1].startsWith('http') ? dl[1] : 'http://d.rutor.info' + dl[1];
        return [{ url: u, kind: 'http' }];
    }
    return null;
}

// Rootz exposes file metadata behind a short-lived page token. Keep that handshake in
// the strict resolver so deleted files are reported before any browser is opened.
async function scrapeRootz(rawUrl) {
    return resolveRootzUrl(rawUrl, {
        request: dlRequest,
        userAgent: CHROME_UA
    });
}

// VikingFile redirects its public domain to vik1ngfile.site. The strict resolver only
// follows those two provider domains and never treats Telegram/support links as files.
async function scrapeVikingfile(rawUrl) {
    return resolveVikingFileUrl(rawUrl, {
        request: dlRequest,
        userAgent: CHROME_UA
    });
}

// Resolve a (possibly indirect) link into one or more concrete files aria2 can
// fetch. ALWAYS returns an array of { url, kind, headers?, name? } or null.
// Host-specific HTTP scrapers run first (no browser → no ads); a single Gofile
// folder can expand into several part files. Browser intercept is the last resort.
// Hosts that have a dedicated scraper. If one of these fails we must NOT fall
// through to the "direct archive" check (their page URLs often end in .bin/.rar
// and would otherwise download the HTML landing page) nor to the browser (which
// hangs on their JS/captcha). We just report failure so the user can pick another host.
const DL_KNOWN_HOST = /gofile|pixeldrain\.(com|net|in|nl|biz|tech|dev)|datanodes|fuckingfast\.(co|com|net)|mediafire|megadb|filekeeper|fileditch(?:files)?|buzzheavier|bzzhr|akirabox\.(com|to)|multiup\.(?:io|org)|1337x\.|rootz\.so|vikingfile\.com|vik1ngfile\.site/i;
const DL_MANAGED_RETRY_HOST = /datanodes|fuckingfast\.(?:co|com|net)|filekeeper|fileditch(?:files)?|buzzheavier|bzzhr|akirabox\.(?:com|to)|multiup\.(?:io|org)|1337x\.|rootz\.so|vikingfile\.com|vik1ngfile\.site/i;

// Per-source Referer to spoof when a host applies hotlink protection.
const SOURCE_REFERER = {
    steamgg: 'https://steamgg.net/',
    fitgirl: 'https://fitgirl-repacks.site/',
    steamrip: 'https://steamrip.com/'
};

const downloadLinkHealthChecker = createDownloadLinkHealthChecker({
    request: dlRequest,
    ttlMs: 60 * 1000,
    buzzHeavierBrowserCheck: (url, options = {}) => checkBuzzheavierWithSystemBrowser(
        url,
        8000,
        options.referer || ''
    ),
    dataNodesBrowserCheck: (url, options = {}) => checkDatanodesWithSystemBrowser(
        url,
        8000,
        options.referer || ''
    )
});

async function inspectDownloadLinkHealth(rawUrl, sourceId) {
    const normalizedSource = String(sourceId || '').toLowerCase();
    if (!isHealthTargetAllowed(rawUrl, normalizedSource)) {
        return { status: HEALTH_STATES.UNKNOWN, reason: 'unsupported-health-target', httpStatus: 0 };
    }
    const referer = SOURCE_REFERER[normalizedSource] || '';
    const value = await downloadLinkHealthChecker(rawUrl, {
        sourceId: normalizedSource,
        referer,
        headers: {
            'User-Agent': CHROME_UA,
            ...(referer ? { Referer: referer } : {})
        }
    });
    return {
        status: Object.values(HEALTH_STATES).includes(value && value.status) ? value.status : HEALTH_STATES.UNKNOWN,
        reason: String(value && value.reason || 'unknown').slice(0, 160),
        httpStatus: Number.isInteger(value && value.httpStatus) ? value.httpStatus : 0
    };
}

ipcMain.handle('get-download-link-health', async (_event, payload) => {
    const input = exactGateAPayload(payload, ['url', 'sourceId'], 'Download link health');
    const url = typeof input.url === 'string' && input.url.length <= 8192 ? input.url : '';
    const sourceId = typeof input.sourceId === 'string' && input.sourceId.length <= 32 ? input.sourceId : '';
    return inspectDownloadLinkHealth(url, sourceId);
});

// ===================================================================
// PixelDrain Cloudflare-Worker proxy pool + Debrid services
// (config is pushed from the renderer via the IPC handlers below)
// ===================================================================
// The former public Worker pool is retired: PixelDrain now rejects those proxy
// requests as hotlinking. Keep user-supplied Workers supported, but never restore
// or silently retry the known-dead defaults from an older settings file.
const RETIRED_PIXELDRAIN_PROXIES = new Set([
    'https://saillauncher.alissatorz.workers.dev',
    'https://saillauncher2.alissatorz.workers.dev',
    'https://saillauncher3.alissatorz.workers.dev',
    'https://saillauncher4.alissatorz.workers.dev',
]);
let pixeldrainProxies = []; // optional custom Worker base URLs, e.g. https://xyz.workers.dev
ipcMain.on('set-pixeldrain-proxies', (e, list) => {
    const cleaned = Array.isArray(list)
        ? [...new Set(list.map(value => {
            const safe = credentialFreeHttpsUrl(value);
            if (!safe) return '';
            const parsed = new URL(safe);
            if (parsed.search) return '';
            const normalized = parsed.href.replace(/\/$/, '');
            return RETIRED_PIXELDRAIN_PROXIES.has(normalized) ? '' : normalized;
        }).filter(Boolean))]
        : [];
    pixeldrainProxies = cleaned;
});

// Debrid services. Each: validate(key) -> {ok, user?} ; unrestrict(key, link) -> {url, name?} | null
const DEBRID = {
    realdebrid: {
        name: 'Real-Debrid',
        async validate(key) {
            const r = await dlRequest('GET', 'https://api.real-debrid.com/rest/1.0/user', { headers: { Authorization: 'Bearer ' + key } });
            if (r.status === 200) { try { const j = JSON.parse(r.body); return { ok: true, user: j.username || '' }; } catch (e) {} }
            return { ok: false };
        },
        async unrestrict(key, link) {
            const r = await dlRequest('POST', 'https://api.real-debrid.com/rest/1.0/unrestrict/link', { headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'link=' + encodeURIComponent(link) });
            try { const j = JSON.parse(r.body); if (j && j.download) return { url: j.download, name: j.filename || '' }; } catch (e) {}
            return null;
        }
    },
    alldebrid: {
        name: 'AllDebrid',
        async validate(key) {
            const r = await dlRequest('GET', 'https://api.alldebrid.com/v4/user?agent=SailLauncher&apikey=' + encodeURIComponent(key));
            try { const j = JSON.parse(r.body); if (j.status === 'success') return { ok: true, user: (j.data && j.data.user && j.data.user.username) || '' }; } catch (e) {}
            return { ok: false };
        },
        async unrestrict(key, link) {
            const r = await dlRequest('GET', 'https://api.alldebrid.com/v4/link/unlock?agent=SailLauncher&apikey=' + encodeURIComponent(key) + '&link=' + encodeURIComponent(link));
            try { const j = JSON.parse(r.body); if (j.status === 'success' && j.data && j.data.link) return { url: j.data.link, name: j.data.filename || '' }; } catch (e) {}
            return null;
        }
    },
    premiumize: {
        name: 'Premiumize',
        async validate(key) {
            const r = await dlRequest('GET', 'https://www.premiumize.me/api/account/info?apikey=' + encodeURIComponent(key));
            try { const j = JSON.parse(r.body); if (j.status === 'success') return { ok: true, user: j.customer_id ? String(j.customer_id) : '' }; } catch (e) {}
            return { ok: false };
        },
        async unrestrict(key, link) {
            const r = await dlRequest('POST', 'https://www.premiumize.me/api/transfer/directdl?apikey=' + encodeURIComponent(key), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'src=' + encodeURIComponent(link) });
            try {
                const j = JSON.parse(r.body);
                if (j.status === 'success') {
                    if (j.location) return { url: j.location, name: j.filename || '' };
                    if (Array.isArray(j.content) && j.content[0] && j.content[0].link) return { url: j.content[0].link, name: j.content[0].path || '' };
                }
            } catch (e) {}
            return null;
        }
    },
    debridlink: {
        name: 'Debrid-Link',
        async validate(key) {
            const r = await dlRequest('GET', 'https://debrid-link.com/api/v2/account/infos', { headers: { Authorization: 'Bearer ' + key } });
            try { const j = JSON.parse(r.body); if (j.success && j.value) return { ok: true, user: j.value.username || j.value.email || '' }; } catch (e) {}
            return { ok: false };
        },
        async unrestrict(key, link) {
            const r = await dlRequest('POST', 'https://debrid-link.com/api/v2/downloader/add', { headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'url=' + encodeURIComponent(link) });
            try { const j = JSON.parse(r.body); if (j.success && j.value && j.value.downloadUrl) return { url: j.value.downloadUrl, name: j.value.name || '' }; } catch (e) {}
            return null;
        }
    },
    torbox: {
        name: 'TorBox',
        async validate(key) {
            const r = await dlRequest('GET', 'https://api.torbox.app/v1/api/user/me', { headers: { Authorization: 'Bearer ' + key } });
            try { const j = JSON.parse(r.body); if (j.success) return { ok: true, user: (j.data && (j.data.email || j.data.username)) || '' }; } catch (e) {}
            return { ok: false };
        },
        async unrestrict(key, link) {
            // TorBox web-downloads are async: create the job, briefly poll for a ready
            // link (cached hoster links resolve in seconds), then request the direct URL.
            const auth = { Authorization: 'Bearer ' + key };
            let id = null;
            try {
                const c = await dlRequest('POST', 'https://api.torbox.app/v1/api/webdl/createwebdownload', { headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, auth), body: 'link=' + encodeURIComponent(link) });
                const j = JSON.parse(c.body); if (j.success && j.data) id = j.data.webdownload_id || j.data.id || j.data.hash;
            } catch (e) {}
            if (!id) return null;
            for (let attempt = 0; attempt < 6; attempt++) {
                try {
                    const l = await dlRequest('GET', 'https://api.torbox.app/v1/api/webdl/mylist?id=' + encodeURIComponent(id), { headers: auth });
                    const j = JSON.parse(l.body);
                    const item = j && j.data ? (Array.isArray(j.data) ? j.data[0] : j.data) : null;
                    if (item && (item.download_present || item.download_finished || item.cached)) {
                        const fileId = (item.files && item.files[0] && (item.files[0].id != null ? item.files[0].id : 0)) || 0;
                        const dl = await dlRequest('GET', 'https://api.torbox.app/v1/api/webdl/requestdl?token=' + encodeURIComponent(key) + '&web_id=' + encodeURIComponent(id) + '&file_id=' + fileId, { headers: auth });
                        const dj = JSON.parse(dl.body);
                        if (dj.success && dj.data) {
                            const url = typeof dj.data === 'string' ? dj.data : (dj.data.url || dj.data);
                            if (typeof url === 'string') return { url, name: (item.files && item.files[0] && item.files[0].name) || item.name || '' };
                        }
                    }
                } catch (e) {}
                await new Promise(res => setTimeout(res, 1500));
            }
            return null;
        }
    }
};
let debridService = '', debridKey = '';
function debridActive() { return !!(debridService && debridKey && DEBRID[debridService]); }
function debridServiceName() { return (debridService && DEBRID[debridService] && DEBRID[debridService].name) || ''; }

// Resolved-link cache. A debrid service hands back a direct URL that stays valid
// for a while, so caching it lets a repeat request for the same source link skip
// the API round-trip and resolve instantly. Keyed by service + original URL (the
// direct link is service-specific); entries expire after 24h because debrid links
// go stale. In-memory only — a fresh app session re-resolves, which is the safe
// default for links that may have already expired.
const DEBRID_CACHE_TTL = 24 * 60 * 60 * 1000;
const debridCache = new Map(); // key -> { url, name, ts }
let debridCacheEnabled = true;  // user toggle (Download settings) — off skips get + put
function debridCacheKey(link) { return debridService + '\n' + link; }
function debridCacheGet(link) {
    if (!debridCacheEnabled) return null;
    const key = debridCacheKey(link);
    const hit = debridCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > DEBRID_CACHE_TTL) { debridCache.delete(key); return null; }
    return { url: hit.url, name: hit.name || '' };
}
function debridCachePut(link, res) {
    if (!debridCacheEnabled) return;
    if (res && res.url) debridCache.set(debridCacheKey(link), { url: res.url, name: res.name || '', ts: Date.now() });
}
// True when this source link already has a fresh cached direct URL (i.e. it'll resolve
// instantly). Used to flag a download as "cached" in the UI before resolution starts.
function debridCacheHas(link) { return !!debridCacheGet(link); }
async function debridUnrestrict(link) {
    if (!debridActive()) return null;
    const cached = debridCacheGet(link);
    if (cached) return cached;
    try {
        const r = await DEBRID[debridService].unrestrict(debridKey, link);
        if (r && r.url) debridCachePut(link, r);
        return r;
    } catch (e) { return null; }
}
ipcMain.on('set-debrid-cache-enabled', (e, on) => {
    debridCacheEnabled = (on !== false);
    if (!debridCacheEnabled) debridCache.clear();
});
ipcMain.on('set-debrid-config', (e, cfg) => {
    cfg = cfg || {};
    debridService = (cfg.service && DEBRID[cfg.service]) ? cfg.service : '';
    debridKey = (debridService && cfg.key) ? String(cfg.key) : '';
});
ipcMain.handle('debrid-validate', async (e, payload) => {
    const input = exactGateAPayload(payload, ['service', 'key'], 'Debrid validation');
    const service = String(input.service || '');
    const key = typeof input.key === 'string' && input.key.length <= 8192 && !/[\u0000\r\n]/.test(input.key) ? input.key : '';
    if (!service || !key || !DEBRID[service]) return { ok: false, error: 'Unknown service' };
    const displayText = (value, fallback = '') => {
        const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
        return text || fallback;
    };
    try {
        const result = await DEBRID[service].validate(key);
        return result && result.ok === true
            ? { ok: true, user: displayText(result.user) }
            : { ok: false, error: displayText(result && result.error, 'Invalid key') };
    } catch (err) {
        return { ok: false, error: displayText(err && err.message || err, 'Request failed') };
    }
});

async function resolveDirectUrl(rawUrl, opts) {
    opts = opts || {};
    const throwIfCancelled = () => {
        if (opts.signal && opts.signal.aborted) {
            throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        }
    };
    throwIfCancelled();
    const referer = opts.referer || SOURCE_REFERER[opts.sourceId] || '';
    const forceManagedBrowser = opts.forceManagedBrowser === true;
    if (!rawUrl) return null;
    if (rawUrl.startsWith('magnet:') || /\.torrent(\?|#|$)/i.test(rawUrl)) return [{ url: rawUrl, kind: rawUrl.startsWith('magnet:') ? 'magnet' : 'http' }];
    const gofileContainer = normalizeFileCryptContainerUrl(rawUrl);
    if (gofileContainer) {
        if (opts.sourceId !== 'steamrip') return null;
        const health = await inspectDownloadLinkHealth(gofileContainer, opts.sourceId);
        if (health.status === HEALTH_STATES.DOWN) throw buildLinkDownError(gofileContainer, health.reason);
        try {
            return await scrapeSteamRipGofileContainer(gofileContainer, referer);
        } catch (error) {
            if (error && error.linkHealth === HEALTH_STATES.DOWN) throw error;
            return null;
        }
    }
    // Debrid FIRST — before any host gives up. When a service is connected it unlocks the
    // link server-side, which bypasses the Cloudflare / captcha / download restrictions on
    // EVERY filehost (GoFile, 1Fichier, Rapidgator, AND CF-interactive ones like AkiraBox
    // and DataNodes). So we try debrid on every http filehost link, not
    // just ones we already know are "free". pixeldrain keeps its own Worker-proxy pool, and
    // magnets/torrents are handled above. On any failure we fall through to the old behaviour.
    if (debridActive() && /^https?:/i.test(rawUrl) && !/pixeldrain/i.test(rawUrl)) {
        const dr = await debridUnrestrict(rawUrl);
        if (dr && dr.url) return [{ url: dr.url, kind: 'http', name: dr.name || '' }];
    }
    if (DL_KNOWN_HOST.test(rawUrl)) {
        let r = null;
        if (!forceManagedBrowser) {
            try {
                if (/gofile/i.test(rawUrl)) r = await scrapeGofile(rawUrl);
                else if (/pixeldrain/i.test(rawUrl)) r = await scrapePixeldrain(rawUrl, referer);
                else if (/datanodes/i.test(rawUrl)) r = await scrapeDatanodes(rawUrl, referer);
                else if (/akirabox\.(com|to)/i.test(rawUrl)) r = await scrapeAkiraBox(rawUrl);
                else if (/1337x\./i.test(rawUrl)) r = await scrape1337x(rawUrl);
                else if (/buzzheavier|bzzhr/i.test(rawUrl)) r = await scrapeBuzzheavier(rawUrl, referer);
                else if (/fileditch(?:files)?/i.test(rawUrl)) r = await scrapeFileditch(rawUrl);
                else if (/fuckingfast\.(co|com|net)/i.test(rawUrl)) r = await scrapeFuckingfast(rawUrl);
                else if (/mediafire/i.test(rawUrl)) r = await scrapeMediafire(rawUrl);
                else if (/filekeeper/i.test(rawUrl)) r = await scrapeFilekeeper(rawUrl);
                else if (/megadb/i.test(rawUrl)) r = await scrapeXFS(rawUrl, referer);
                else if (/rootz\.so/i.test(rawUrl)) r = await scrapeRootz(rawUrl);
                else if (/vikingfile\.com|vik1ngfile\.site/i.test(rawUrl)) r = await scrapeVikingfile(rawUrl);
            } catch (e) {
                if (e && e.name === 'AbortError') throw e;
                if (e && e.linkHealth === HEALTH_STATES.DOWN) throw e;
                if (e && e.providerRateLimited) throw e;
                if (/gofile/i.test(rawUrl) && /^error-(?:notFound|contentNotFound|deleted)$/i.test(String(e && e.gofileStatus || ''))) {
                    throw buildLinkDownError(rawUrl, e.gofileStatus);
                }
                // All other failures continue into the provider-scoped visible handoff below.
            }
        }
        throwIfCancelled();
        if ((!r || !r.length) && /filekeeper/i.test(rawUrl)) {
            r = await resolveWithManagedHostBrowser(rawUrl, 'filekeeper', referer, opts.onProgress, opts.signal);
        } else if ((!r || !r.length) && /datanodes/i.test(rawUrl)) {
            r = await resolveWithManagedHostBrowser(rawUrl, 'datanodes', referer, opts.onProgress, opts.signal);
        } else if ((!r || !r.length) && /buzzheavier|bzzhr/i.test(rawUrl)) {
            r = await resolveWithManagedHostBrowser(rawUrl, 'buzzheavier', referer, opts.onProgress, opts.signal);
        } else if ((!r || !r.length) && /fileditch(?:files)?/i.test(rawUrl)) {
            r = await resolveWithManagedHostBrowser(rawUrl, 'fileditch', referer, opts.onProgress, opts.signal);
        } else if ((!r || !r.length) && /fuckingfast/i.test(rawUrl)) {
            r = await resolveWithManagedHostBrowser(rawUrl, 'fuckingfast', referer, opts.onProgress, opts.signal);
        } else if ((!r || !r.length) && /multiup\.(?:io|org)/i.test(rawUrl)) {
            r = await resolveWithManagedHostBrowser(rawUrl, 'multiup', referer, opts.onProgress, opts.signal);
        } else if ((!r || !r.length) && /1337x/i.test(rawUrl)) {
            r = await resolve1337xWithSystemBrowser(rawUrl, 20000, referer, opts.signal);
            if (!r || !r.length) r = await resolveWithManagedHostBrowser(rawUrl, '1337x', referer, opts.onProgress, opts.signal);
        } else if ((!r || !r.length) && /pixeldrain/i.test(rawUrl)) {
            r = await resolveWithManagedHostBrowser(rawUrl, 'pixeldrain', referer, opts.onProgress, opts.signal);
        } else if ((!r || !r.length) && /rootz\.so/i.test(rawUrl)) {
            r = await resolveWithManagedHostBrowser(rawUrl, 'rootz', referer, opts.onProgress, opts.signal);
        } else if ((!r || !r.length) && /vikingfile\.com|vik1ngfile\.site/i.test(rawUrl)) {
            r = await resolveWithManagedHostBrowser(rawUrl, 'vikingfile', referer, opts.onProgress, opts.signal);
        }
        return (r && r.length) ? r : null; // never fall through for a known host
    }
    // rutor.info — extract magnet/torrent link from the page. Falls through to the
    // browser interceptor if scraping fails.
    if (/rutor\.info/i.test(rawUrl)) {
        try { const r = await scrapeRutor(rawUrl); if (r && r.length) return r; } catch (e) {}
    }
    // already a direct CDN archive / iso link
    if (/\.(zip|rar|7z|bin|iso)(\?|#|$)/i.test(rawUrl)) return [{ url: rawUrl, kind: 'http' }];
    // unknown host → last resort: load the page hidden and intercept the file download
    const intercepted = await interceptDownload(rawUrl, 55000, { signal: opts.signal });
    if (intercepted && intercepted.url) {
        const hdrs = (intercepted.headers && intercepted.headers.Cookie) ? ['Cookie: ' + intercepted.headers.Cookie] : null;
        return [{ url: intercepted.url, kind: intercepted.url.startsWith('magnet:') ? 'magnet' : 'http', headers: hdrs, name: intercepted.name }];
    }
    return null;
}

// Build the user-facing "couldn't resolve" error for a host, with host-specific
// guidance.
function buildUnresolvedError(url) {
    let host = 'this host'; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (er) {}
    const exhaustedProtectedHandoff = /(?:gofile|pixeldrain|filecrypt|filekeeper|datanodes|akirabox|buzzheavier|bzzhr|fileditch|fuckingfast|multiup|1337x|rootz|vikingfile|vik1ngfile|megadb|mediafire)/i.test(host);
    let msg = 'Could not auto-resolve a direct link for ' + host + '. Use "Open game page" to download it manually.';
    if (/megadb/i.test(host)) msg = 'MegaDB did not return an approved signed download link. Retry once, or choose another mirror.';
    else if (/pixeldrain/i.test(host)) msg = 'PixelDrain did not return a usable file through the direct API or any trusted custom Worker. Try another mirror or add a Worker you trust in Download Settings.';
    else if (/gofile/i.test(host)) msg = 'Gofile\'s API is temporarily unavailable (their servers, not the launcher). Try again in a minute, or pick another host.';
    else if (/filecrypt/i.test(host)) msg = 'The GoFile mirror could not finish its protected handoff. Retry once, or pick another host while the mirror refreshes.';
    else if (/filekeeper/i.test(host)) msg = 'FileKeeper did not return an approved provider download. Retry once, or choose another mirror.';
    else if (/fuckingfast/i.test(host)) msg = 'FuckingFast did not produce an approved file URL through Sail\'s protected verification. The ad blocker stayed enabled; choose another mirror.';
    else if (/datanodes/i.test(host)) msg = 'DataNodes did not produce an approved file URL through Sail\'s protected verification. The ad blocker stayed enabled; choose another mirror.';
    else if (/akirabox/i.test(host)) msg = 'AkiraBox\'s Cloudflare check only completes in your normal browser. Use "Open in Browser"; Sail will not disable your browser\'s ad blocker or loop the check.';
    else if (/buzzheavier|bzzhr/i.test(host)) msg = 'BuzzHeavier did not return an approved download token through Sail\'s protected handoff. Retry once, or choose another mirror.';
    else if (/fileditch/i.test(host)) msg = 'FileDitch did not return an approved file redirect through Sail\'s protected handoff. Retry once, or choose another mirror.';
    else if (/multiup/i.test(host)) msg = 'MultiUp did not return a file through any approved mirror in Sail\'s protected handoff. Choose another host.';
    else if (/1337x/i.test(host)) msg = '1337x did not expose an approved magnet or same-site torrent file. Try another mirror.';
    else if (/rootz/i.test(host)) msg = 'Rootz did not expose an active file through its status API. Retry once, or choose another mirror.';
    else if (/vikingfile|vik1ngfile/i.test(host)) msg = 'VikingFile did not expose an approved provider download. Choose another mirror.';
    else if (/mediafire/i.test(host)) msg = 'MediaFire did not return an approved direct download. Retry once, or choose another mirror.';
    return Object.assign(new Error(msg), { needsBrowser: /akirabox/i.test(host) || !exhaustedProtectedHandoff });
}

function buildLinkDownError(url, reason) {
    let host = 'This mirror';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}
    const error = new Error(host + ' reports that this download is offline or no longer exists. Choose another mirror.');
    error.needsBrowser = false;
    error.linkHealth = HEALTH_STATES.DOWN;
    error.downloadUrl = String(url || '');
    error.healthReason = String(reason || '').slice(0, 160);
    return error;
}

// Click script: find the real download control while skipping ad links. Prefers
// anchors that point at an actual file/known host; only then falls back to
// buttons/elements whose visible text is a download verb. Returns true if it
// clicked something plausible.
const INTERCEPT_CLICK_JS = `(function(){
    var FILE=/\\.(zip|rar|7z|bin|iso|exe|torrent|part\\d+)(\\?|#|$)/i;
    var HOST=/gofile|pixeldrain|datanodes|fuckingfast|1fichier|mediafire|mega(\\.nz|db)|qiwi|multiup|bowfile|hexload|vikingfile|rootz|akirabox|buzzheavier|bzzhr|fileditch(files)?|store\\d+\\.gofile|1337x/i;
    var AD=/a-ads|doubleclick|googlesyndication|adnxs|popads|propeller|exoclick|juicyads|adsterra|hilltop|clickadu|adcash|monetag|onclick(algo|performance)|realsrv|tsyndicate|\\/ads?\\//i;
    function vis(el){ try{ return el.offsetParent!==null && el.getClientRects().length>0; }catch(e){ return false; } }
    // A premature or repeated download click can invalidate a pending provider
    // verification. Wait until the widget has produced a token; the user remains
    // in control of the challenge itself.
    var gate=document.querySelector('.cf-turnstile,iframe[src*="challenges.cloudflare.com"],.h-captcha,.g-recaptcha,[data-sitekey]');
    var token=document.querySelector('input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"],input[name="h-captcha-response"],textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"]');
    if(gate && !globalThis.__sailHumanVerificationComplete && (!token || !String(token.value||'').trim())) return false;
    // Repeated clicks can invalidate one-time host tokens. This script is polled,
    // so allow the page time to navigate or produce a download event.
    if(globalThis.__sailLastDownloadClickAt && Date.now()-globalThis.__sailLastDownloadClickAt<2500) return false;
    function activate(el){
        var now=Date.now(), attempts=Number(el.__sailDownloadClickAttempts||0), last=Number(el.__sailDownloadClickedAt||0);
        if(attempts>=3||(last&&now-last<8000)||el.disabled||(typeof el.matches==='function'&&el.matches('[disabled]'))||String(typeof el.getAttribute==='function'&&el.getAttribute('aria-disabled')||'').toLowerCase()==='true')return false;
        try{var style=getComputedStyle(el);if(style.pointerEvents==='none'||style.visibility==='hidden')return false;}catch(e){}
        el.__sailDownloadClickAttempts=attempts+1; el.__sailDownloadClickedAt=now; globalThis.__sailLastDownloadClickAt=now; el.click(); return true;
    }
    // 1) anchors to a real file or known host
    var as=[].slice.call(document.querySelectorAll('a[href]'));
    for(var i=0;i<as.length;i++){ var h=as[i].href||'', cross=false; try{ cross=new URL(h,location.href).origin!==location.origin; }catch(e){} if(AD.test(h)) continue; if(/^magnet:\\?xt=urn:btih:/i.test(h) && vis(as[i])) return h; if((FILE.test(h)||(HOST.test(h)&&cross)) && vis(as[i])) return activate(as[i]); }
    // 2) explicit download controls (id/class)
    var sels=['#download','#download-button','#downloadButton','#btndownload','#download-url','.download-btn','a.download','button.download','a#downloadB','.btn-download'];
    for(var j=0;j<sels.length;j++){ var el=document.querySelector(sels[j]); if(el && vis(el)) return activate(el); }
    // 3) buttons/links whose visible text is a download verb (not ads)
    var cand=[].slice.call(document.querySelectorAll('a,button,input[type=button],input[type=submit]'));
    for(var k=0;k<cand.length;k++){ var c=cand[k]; var t=((c.textContent||'')+' '+(c.value||'')).replace(/\\s+/g,' ').trim().toLowerCase(); var hh=c.href||''; if(AD.test(hh)) continue; if(/^(download|download now|start download|free download(?: (?:standard|slow) speed)?|скачать|создать ссылку|get link|continue)$/.test(t) && vis(c)) return activate(c); }
    return false;
})();`;

// Keep polling after ordinary clicks so DevTools can capture the browser's real
// file transfer. Magnet links are returned directly because they do not create a
// browser download event.
const MANAGED_SYSTEM_BROWSER_CLICK_JS = `(function(){
    var result=${INTERCEPT_CLICK_JS}
    if(typeof result==='string') return {url:result,pageUrl:location.href,userAgent:navigator.userAgent};
    if(result===true) return {postVerificationControlActivated:true};
    return null;
})()`;

// A Cloudflare interstitial can appear before FuckingFast's own Turnstile page.
// Only the provider page's verified /go control is the completed handoff.
const FUCKINGFAST_VERIFICATION_STATE_JS = `(function(){
    var control=document.querySelector('[hx-post*="/go"]');
    var token=document.querySelector('input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"],input[name="h-captcha-response"],textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"]');
    var gate=document.querySelector('.cf-turnstile,iframe[src*="challenges.cloudflare.com"],.h-captcha,.g-recaptcha,[data-sitekey]');
    var providerReady=globalThis.__sailHumanVerificationComplete===true||globalThis.dlCleared===true||(typeof globalThis.turnstileToken==='string'&&!!globalThis.turnstileToken.trim())||!!(token&&String(token.value||token.getAttribute('value')||'').trim());
    var text=String(document.body&&document.body.innerText||'').slice(0,20000);
    var failed=!!control&&/\\bverification failed\\b|\\bchallenge failed\\b|\\bverification expired\\b/i.test(text);
    if(control&&gate&&!providerReady&&!window.__sailVerificationCentered){
        window.__sailVerificationCentered=true;
        try{gate.scrollIntoView({block:'center',inline:'center',behavior:'auto'});}catch(e){}
    }
    return {gatePresent:!!gate,verified:!!control&&providerReady,failed:failed};
})()`;

// FuckingFast can consume the first activation with an ad pop-under and does
// not always expose its internal cleared flag after Turnstile succeeds. Keep
// the accepted verification latched in this page and retry the same provider
// control at the host's measured cadence. DevTools captures the resulting /go
// HX redirect or /dl request; it never follows an ad target.
const FUCKINGFAST_SYSTEM_BROWSER_CLICK_JS = `(function(){
    function vis(el){try{return !!el&&el.offsetParent!==null&&el.getClientRects().length>0;}catch(e){return false;}}
    var gate=document.querySelector('.cf-turnstile,iframe[src*="challenges.cloudflare.com"],.h-captcha,.g-recaptcha,[data-sitekey]');
    var token=document.querySelector('input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"],input[name="h-captcha-response"],textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"]');
    var ready=!!(globalThis.dlCleared===true||(typeof globalThis.turnstileToken==='string'&&globalThis.turnstileToken.trim())||(token&&String(token.value||token.getAttribute('value')||'').trim()));
    var verifiedBefore=globalThis.__sailHumanVerificationComplete===true;
    if(gate&&!ready&&!verifiedBefore)return null;
    var control=document.querySelector('[hx-post*="/go"]');
    if(!vis(control)||control.disabled||String(control.getAttribute&&control.getAttribute('aria-disabled')||'').toLowerCase()==='true')return null;
    var now=Date.now(),attempts=Number(globalThis.__sailFuckingFastGoAttempts||0),last=Number(globalThis.__sailFuckingFastGoAt||0);
    if(attempts>=4||(last&&now-last<8000))return null;
    globalThis.__sailFuckingFastGoAttempts=attempts+1;globalThis.__sailFuckingFastGoAt=now;control.click();
    return {postVerificationControlActivated:true};
})()`;

// DataNodes uses one-time form state. Submit the legacy first step once, then
// activate each distinct step-two label once as the provider replaces controls.
const DATANODES_SYSTEM_BROWSER_CLICK_JS = `(function(){
    var pageText=String(document.body&&document.body.innerText||'').replace(/\\s+/g,' ');
    if(/\\bfile not found\\b/i.test(pageText)&&/the file you were looking for could not be found|the file expired|the file was deleted/i.test(pageText))return {linkHealth:'down',healthReason:'datanodes-page-reports-down'};
    function vis(el){try{if(!el)return false;var r=typeof el.getBoundingClientRect==='function'?el.getBoundingClientRect():null;return r?Number(r.width)>0&&Number(r.height)>0:el.offsetParent!==null&&el.getClientRects().length>0;}catch(e){return false;}}
    function label(el){return String((el&&el.innerText||el&&el.textContent||'')+' '+(el&&el.value||'')).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
    function enabled(el){if(!vis(el)||el.disabled||String(el.getAttribute&&el.getAttribute('aria-disabled')||'').toLowerCase()==='true')return false;try{var s=getComputedStyle(el);return s.pointerEvents!=='none'&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';}catch(e){return true;}}
    var gate=document.querySelector('.cf-turnstile,iframe[src*="challenges.cloudflare.com"],.h-captcha,.g-recaptcha,[data-sitekey]');
    var token=document.querySelector('input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"],input[name="h-captcha-response"],textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"]');
    var verified=!!(globalThis.__sailHumanVerificationComplete||(token&&String(token.value||token.getAttribute('value')||'').trim()));
    if(gate&&!verified)return null;
    var form=document.querySelector('#downloadForm,form[action*="/download"]');
    var reveal=document.querySelector('#downloadReveal');
    var submit=document.querySelector('#method_free,input[name="method_free"],button[name="method_free"]');
    if(form&&reveal&&submit){
        if(globalThis.__sailDataNodesStep1Submitted||!enabled(submit))return null;
        try{var revealStyle=getComputedStyle(reveal);if(revealStyle.pointerEvents==='none'||revealStyle.visibility==='hidden'||revealStyle.display==='none'||revealStyle.opacity==='0')return null;}catch(e){}
        var field=form.querySelector&&form.querySelector('input[type="hidden"][name="method_free"]');
        if(!field){field=document.createElement('input');field.type='hidden';field.name='method_free';form.appendChild(field);}
        field.value='Free Download >>';globalThis.__sailDataNodesStep1Submitted=true;
        if(typeof form.submit==='function')form.submit();else if(typeof form.requestSubmit==='function')form.requestSubmit();else return null;
        return {postVerificationControlActivated:true};
    }
    var text=String(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').toLowerCase();
    var controls=[].slice.call(document.querySelectorAll('a,button,[role="button"],input[type=button],input[type=submit]'));
    var choices=[];
    for(var i=0;i<controls.length;i++){
        var current=label(controls[i]);
        if(enabled(controls[i])&&/^(?:start download|download now|get link|proceed to download|download file|free download(?: standard speed)?|your file is ready)(?:\\b|$)/.test(current))choices.push({el:controls[i],key:current,priority:/^(?:start download|download now|your file is ready)/.test(current)?0:1});
    }
    if(!/step\\s*2\\s*of\\s*2|quick check to unlock|unlock your download|your file is ready|start download/.test(text)&&!choices.length)return null;
    choices.sort(function(a,b){return a.priority-b.priority;});
    var clicked=globalThis.__sailDataNodesClickedLabels||(globalThis.__sailDataNodesClickedLabels=Object.create(null));
    for(var j=0;j<choices.length;j++){
        if(clicked[choices[j].key])continue;
        if(Number(globalThis.__sailDataNodesStepClicks||0)>=4)return null;
        clicked[choices[j].key]=true;globalThis.__sailDataNodesStepClicks=Number(globalThis.__sailDataNodesStepClicks||0)+1;choices[j].el.click();
        return {postVerificationControlActivated:true};
    }
    return null;
})()`;

function managedHostClickExpression(provider) {
    if (provider === 'fuckingfast') return FUCKINGFAST_SYSTEM_BROWSER_CLICK_JS;
    if (provider === 'datanodes') return DATANODES_SYSTEM_BROWSER_CLICK_JS;
    return MANAGED_SYSTEM_BROWSER_CLICK_JS;
}

function managedHostVerificationOptions(provider) {
    if (provider !== 'fuckingfast') return {};
    return {
        verificationStateExpression: FUCKINGFAST_VERIFICATION_STATE_JS,
        // The generic observer also sees the preceding Cloudflare interstitial.
        // Poll the provider-specific state instead so Sail does not minimize or
        // advance until the real FuckingFast /go control is present.
        installVerificationObserver: false
    };
}

// Open a host page invisibly, auto-click the real download control, and capture
// the resulting file download URL (+ cookies) without actually saving it here.
function interceptDownload(url, timeoutMs = 55000, options = {}) {
    return new Promise((resolve) => {
        let done = false, win = null, clicker = null, verificationWatcher = null;
        let revealTimer = null, hideTimer = null, sess = null, downloadHandler = null;
        let timer = null, abortHandler = null;
        let verificationReported = false;
        let lastBlockedNavigationHost = '';
        let browserUserAgent = DL_UA;
        const signal = options.signal || null;
        const revealAfterMs = Math.max(0, Math.min(Number(options.revealAfterMs) || 0, 10000));
        const managedHandoffVisible = revealAfterMs > 0 || DL_KNOWN_HOST.test(String(url || ''));
        const humanVerification = options.humanVerification === true;
        const finish = (val, reason = '') => {
            if (done) return; done = true;
            clearTimeout(timer); if (clicker) clearInterval(clicker); if (verificationWatcher) clearInterval(verificationWatcher);
            if (revealTimer) clearTimeout(revealTimer); if (hideTimer) clearTimeout(hideTimer);
            if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
            try { if (sess && downloadHandler) sess.removeListener('will-download', downloadHandler); } catch (e) {}
            try { if (win && win.webContents) managedResolverWebContents.delete(win.webContents.id); } catch (_) {}
            try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
            resolve(val);
        };
        abortHandler = () => finish(null, 'cancelled');
        if (signal) {
            if (signal.aborted) return finish(null, 'cancelled');
            signal.addEventListener('abort', abortHandler, { once: true });
        }
        timer = setTimeout(() => finish(null, 'timeout'), timeoutMs);
        try {
            // Reuse the isolated persistent Sources session so clearance/site state
            // from the in-app browser carries into the one-click handoff. Keep the
            // renderer unthrottled so provider challenges can finish. Managed hosts
            // are visible from creation: some provider pages request window.close()
            // or fail navigation before a delayed show() can run.
            win = new BrowserWindow({
                show: managedHandoffVisible,
                width: humanVerification ? 680 : 1200,
                height: humanVerification ? 560 : 800,
                autoHideMenuBar: true,
                skipTaskbar: humanVerification,
                // Keep verification as an independent top-level window. A child of
                // the transparent frameless launcher can be suppressed by Windows
                // before a challenged navigation finishes, leaving only the dock
                // error and no usable browser step.
                parent: humanVerification && mainWindow && !mainWindow.isDestroyed()
                    ? mainWindow
                    : !managedHandoffVisible && mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
                webPreferences: {
                    // Never reuse the Sources webview's cookies while presenting a
                    // different browser identity to a challenge. The fallback gets
                    // a fresh in-memory session for this single attempt.
                    partition: humanVerification ? `sail-verification-${crypto.randomUUID()}` : SOURCES_PARTITION,
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true,
                    webSecurity: true,
                    backgroundThrottling: false
                }
            });
        } catch (e) {
            console.error('[download-resolver] Could not create the verification window: ' + String(e && e.message || e).slice(0, 240));
            return finish(null, 'window-create-error');
        }
        managedResolverWebContents.add(win.webContents.id);
        win.once('closed', () => finish(null, 'window-closed'));
        win.on('page-title-updated', event => {
            if (!win || win.isDestroyed() || !win.isVisible()) return;
            try { event.preventDefault(); win.setTitle('Sail Launcher — Complete download verification'); } catch (_) {}
        });
        sess = win.webContents.session;
        // Keep Sail's blocker active during verification too. Challenge resources
        // are explicitly exempted in isAdHost; ad networks and popunders are not.
        applyAdBlock(sess);
        const pageUrlAllowed = navUrl => {
            if (isAdHost(navUrl)) return false;
            if (typeof options.isAllowedPageUrl !== 'function') return true;
            try { return options.isAllowedPageUrl(new URL(navUrl)); } catch (_) { return false; }
        };
        const reportBlockedNavigation = navUrl => {
            if (typeof options.onBlockedNavigation !== 'function') return;
            try {
                const host = new URL(String(navUrl || '')).hostname.toLowerCase();
                if (!host || host === lastBlockedNavigationHost) return;
                lastBlockedNavigationHost = host;
                options.onBlockedNavigation(host);
            } catch (_) {}
        };
        // Keep pop-ups suppressed, but route an approved provider target into this same
        // isolated window so hosts using target=_blank can still reach will-download.
        win.webContents.setWindowOpenHandler(details => {
            const target = String(details && details.url || '');
            let acceptedMagnet = false;
            if (typeof options.acceptDownloadUrl === 'function' && /^magnet:/i.test(target)) {
                try { acceptedMagnet = !!options.acceptDownloadUrl(target); } catch (_) {}
            }
            if (acceptedMagnet) {
                finish({ url: target, name: '', headers: null, userAgent: browserUserAgent });
            } else if (pageUrlAllowed(target)) {
                setImmediate(() => {
                    if (!done && win && !win.isDestroyed()) win.loadURL(target).catch(() => {});
                });
            } else reportBlockedNavigation(target);
            return { action: 'deny' };
        });
        // never let the page bounce the main frame onto an ad/redirect
        win.webContents.on('will-navigate', (e, navUrl) => { if (!pageUrlAllowed(navUrl)) { try { e.preventDefault(); } catch (err) {} reportBlockedNavigation(navUrl); } });
        win.webContents.on('will-redirect', (e, navUrl) => { if (!pageUrlAllowed(navUrl)) { try { e.preventDefault(); } catch (err) {} reportBlockedNavigation(navUrl); } });
        downloadHandler = (e, item, downloadWebContents) => {
            if (downloadWebContents !== win.webContents) return;
            const fileUrl = item.getURL();
            let fname = '';
            try { fname = item.getFilename() || ''; } catch (err) {}
            // ignore ad/redirect/non-file payloads
            let accepted = !isAdHost(fileUrl) && !/\.(html?|php)(\?|#|$)/i.test(fileUrl) && !/^download$/i.test(fname);
            if (accepted && typeof options.acceptDownloadUrl === 'function') {
                try { accepted = !!options.acceptDownloadUrl(fileUrl); } catch (_) { accepted = false; }
            }
            if (!accepted) { try { item.cancel(); } catch (err) {} return; }
            try { item.pause(); } catch (_) {}
            // Attach only cookies scoped to the captured transfer URL. Reading
            // cookies for the source page and forwarding them to a separate CDN
            // would leak provider-session state across origins.
            sess.cookies.get({ url: fileUrl }).then((cookies) => {
                const cookieHeader = (cookies || []).map(c => `${c.name}=${c.value}`).join('; ');
                try { item.cancel(); } catch (err) {}
                finish({ url: fileUrl, name: fname, headers: cookieHeader ? { Cookie: cookieHeader } : null, userAgent: browserUserAgent });
            }).catch(() => { try { item.cancel(); } catch (err) {} finish({ url: fileUrl, name: fname, headers: null, userAgent: browserUserAgent }); });
        };
        sess.on('will-download', downloadHandler);
        // Keep Electron's real identity intact in the last-resort fallback. Stripping
        // only the UA token leaves Sec-CH-UA/navigator.userAgentData inconsistent and
        // causes Cloudflare to reject an otherwise valid human interaction.
        browserUserAgent = String(win.webContents.getUserAgent() || DL_UA)
            .replace(/[\r\n]/g, '')
            .trim()
            .slice(0, 512) || DL_UA;
        // retry clicking as the page/SPA settles (some hosts render the button late)
        const tryClick = () => {
            if (done || !win || win.isDestroyed()) return;
            const clickExpression = String(options.clickExpression || INTERCEPT_CLICK_JS);
            win.webContents.executeJavaScript(clickExpression, true).then(result => {
                if (result && result.linkHealth === HEALTH_STATES.DOWN) return finish(result, 'provider-down');
                const activated = result === true || !!(result && result.postVerificationControlActivated === true);
                if (activated && humanVerification && verificationReported
                    && options.hideOnVerification === true && win && !win.isDestroyed() && win.isVisible()) {
                    if (hideTimer) clearTimeout(hideTimer);
                    hideTimer = setTimeout(() => {
                        if (done || !win || win.isDestroyed()) return;
                        try { win.hide(); } catch (_) {}
                    }, 150);
                }
                const resultUrl = typeof result === 'string' ? result : result && result.url;
                if (typeof resultUrl !== 'string' || !/^magnet:\\?xt=urn:btih:/i.test(resultUrl)) return;
                if (typeof options.acceptDownloadUrl === 'function') {
                    try { if (!options.acceptDownloadUrl(resultUrl)) return; } catch (_) { return; }
                }
                finish({ url: resultUrl, name: '', headers: null, userAgent: browserUserAgent });
            }).catch(() => {});
        };
        const checkVerification = () => {
            if (!humanVerification || done || !win || win.isDestroyed()) return;
            const verificationStateExpression = String(options.verificationStateExpression || `(function(){
                var token=document.querySelector('input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"],input[name="h-captcha-response"],textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"]');
                var gate=document.querySelector('.cf-turnstile,iframe[src*="challenges.cloudflare.com"],.h-captcha,.g-recaptcha,[data-sitekey]');
                var providerReady=globalThis.dlCleared===true||(typeof globalThis.turnstileToken==='string'&&!!globalThis.turnstileToken.trim());
                var verified=providerReady||!!(token&&String(token.value||token.getAttribute('value')||'').trim());
                var text=String(document.body&&document.body.innerText||'').slice(0,20000);
                var failed=/\\bverification failed\\b|\\bchallenge failed\\b|\\bverification expired\\b/i.test(text);
                if(gate&&!verified&&!window.__sailVerificationCentered){
                    window.__sailVerificationCentered=true;
                    try{gate.scrollIntoView({block:'center',inline:'center',behavior:'auto'});}catch(e){}
                }
                return {verified:verified,gatePresent:!!gate,failed:failed};
            })()`);
            win.webContents.executeJavaScript(verificationStateExpression, true).then(async state => {
                if (!state || done || !win || win.isDestroyed()) return;
                if (!state.verified) {
                    if (verificationNeedsAttention(state, verificationReported)) {
                        verificationReported = false;
                        await win.webContents.executeJavaScript('globalThis.__sailHumanVerificationComplete=false;true', true).catch(() => {});
                        if (done || !win || win.isDestroyed()) return;
                        try { win.show(); win.focus(); } catch (_) {}
                        if (typeof options.onVerificationNeedsAttention === 'function') {
                            try { options.onVerificationNeedsAttention(); } catch (_) {}
                        }
                    }
                    return;
                }
                // The provider may remove the challenge widget before revealing its
                // real download button. Persist the accepted state for the clicker so
                // it does not mistake that post-verification render for a fresh gate.
                await win.webContents.executeJavaScript('globalThis.__sailHumanVerificationComplete=true;true', true).catch(() => {});
                if (done || !win || win.isDestroyed()) return;
                if (!verificationReported) {
                    verificationReported = true;
                    if (typeof options.onVerificationComplete === 'function') {
                        try { options.onVerificationComplete(); } catch (_) {}
                    }
                }
                // Advance the host's post-verification download control. tryClick hides
                // only after it actually activates that control, so a rejected token can
                // return to the visible handoff instead of looping invisibly.
                tryClick();
            }).catch(() => {});
        };
        win.webContents.on('did-finish-load', () => setTimeout(tryClick, 1500));
        clicker = setInterval(tryClick, 3500);
        if (humanVerification) {
            win.webContents.on('did-finish-load', () => setTimeout(checkVerification, 100));
            verificationWatcher = setInterval(checkVerification, 200);
        }
        const loadOptions = { ...(options.loadOptions || {}) };
        if (options.referrer && !loadOptions.httpReferrer) loadOptions.httpReferrer = options.referrer;
        const revealVerificationWindow = () => {
            if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
            if (done || !win || win.isDestroyed()) return;
            try {
                win.setTitle('Sail Launcher — Complete download verification');
                win.show();
                win.focus();
            } catch (_) {}
        };
        if (managedHandoffVisible) {
            // Start this clock before navigation. Provider challenges can keep
            // loadURL pending, which previously hid the only window the user
            // could use to finish verification.
            if (revealAfterMs) revealTimer = setTimeout(revealVerificationWindow, revealAfterMs);
            // A provider may call window.close() after a failed/blocked navigation.
            // Keep the user-owned verification handoff open; the title-bar close
            // button still closes the BrowserWindow normally.
            win.webContents.on('close', event => {
                if (done || !win || win.isDestroyed()) return;
                try { event.preventDefault(); } catch (_) {}
                revealVerificationWindow();
            });
        }
        win.loadURL(url, loadOptions).catch(() => {
            // Chromium rejects some provider challenge/error responses before the
            // reveal timer fires. Keep the managed handoff visible so this never
            // collapses into a silent "browser step" error again.
            if (!managedHandoffVisible) return finish(null);
            revealVerificationWindow();
        });
    });
}

function managedHostUrlAllowed(provider, value, sourceUrl) {
    const raw = String(value || '');
    if (/^magnet:\?xt=urn:btih:[A-Za-z0-9]{32,64}(?:&|$)/i.test(raw)) return provider === '1337x';
    if (provider === 'filekeeper') {
        const source = credentialFreeHttpsUrl(sourceUrl);
        if (!source || !FILEKEEPER_HOST_RE.test(new URL(source).hostname)) return false;
        return !!fileKeeperDownloadUrl(raw, source, new URL(source).hostname);
    }
    let parsed;
    try { parsed = new URL(raw); } catch (_) { return false; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.port && parsed.port !== '443') return false;
    const host = parsed.hostname.toLowerCase();
    if (provider === 'datanodes') return DATANODES_HOST_RE.test(host);
    if (provider === 'akirabox') return AKIRABOX_HOST_RE.test(host);
    if (provider === 'buzzheavier') return BUZZHEAVIER_HOST_RE.test(host);
    if (provider === 'fileditch') return FILEDITCH_HOST_RE.test(host);
    if (provider === 'rootz') {
        return ROOTZ_HOST_RE.test(host) && /^\/api\/files\/proxy-download\/[A-Za-z0-9_-]{8,128}\/?$/i.test(parsed.pathname);
    }
    if (provider === 'vikingfile') {
        return VIKINGFILE_HOST_RE.test(host) && /^\/download\//i.test(parsed.pathname);
    }
    if (provider === 'fuckingfast') {
        return FUCKINGFAST_HOST_RE.test(host) || BUZZHEAVIER_HOST_RE.test(host);
    }
    if (provider === 'multiup') {
        // MultiUp is a mirror index. Keep its interactive flow on MultiUp itself,
        // and permit only the established download providers it currently lists.
        // Unknown redirect/ad hosts remain blocked and never reach aria2.
        return /(^|\.)(?:multiup\.(?:io|org)|datanodes\.(?:to|net)|mediafire\.com|vikingfile\.com|vik1ngfile\.site|rootz\.so|buzzheavier\.com|bzzhr\.(?:to|co)|fuckingfast\.(?:co|com|net)|hexload\.com|mega\.nz|gofile\.io|1fichier\.com)$/i.test(host);
    }
    if (provider === '1337x') return X1337_HOST_RE.test(host) && /\.torrent$/i.test(parsed.pathname);
    if (provider === 'pixeldrain') return PIXELDRAIN_HOST_RE.test(host);
    return false;
}

function managedHostPageAllowed(provider, parsed, sourceUrl) {
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.port && parsed.port !== '443') return false;
    if (provider === 'rootz' && ROOTZ_HOST_RE.test(parsed.hostname)) return true;
    if (provider === 'vikingfile' && VIKINGFILE_HOST_RE.test(parsed.hostname)) return true;
    if (managedHostUrlAllowed(provider, parsed.href, sourceUrl)) return true;
    try { return parsed.origin === new URL(sourceUrl).origin; } catch (_) { return false; }
}

function managedHostInitialLoad(provider, rawUrl, referer) {
    let pageUrl = rawUrl;
    if (provider === 'akirabox') {
        try {
            const parsed = new URL(rawUrl);
            const id = parsed.pathname.split('/').filter(Boolean)[0] || '';
            if (/^[A-Za-z0-9_-]{4,128}$/.test(id)) {
                parsed.hostname = 'akirabox.to';
                parsed.pathname = `/${encodeURIComponent(id)}/file`;
                parsed.search = '';
                parsed.hash = '';
                pageUrl = parsed.href;
            }
        } catch (_) {}
    }
    return {
        url: pageUrl,
        loadOptions: {
            ...(referer ? { httpReferrer: referer } : {})
        }
    };
}

function managedHostResponseCapture(provider, rawUrl) {
    if (provider === 'fuckingfast') {
        return {
            captureResponseUrl(value) {
                try {
                    const parsed = new URL(value);
                    return FUCKINGFAST_HOST_RE.test(parsed.hostname) && /^\/f\/[A-Za-z0-9_-]{4,128}\/go\/?$/i.test(parsed.pathname);
                } catch (_) { return false; }
            },
            async handleResponse(response) {
                const captured = extractFuckingFastBrowserDownload(response, rawUrl);
                return captured ? { attachBrowserContext: true, value: captured } : null;
            }
        };
    }
    if (provider !== 'datanodes') return {};
    return {
        captureResponseUrl(value) {
            try {
                const parsed = new URL(value);
                return DATANODES_HOST_RE.test(parsed.hostname) && /^\/download\/?$/i.test(parsed.pathname);
            } catch (_) { return false; }
        },
        async handleResponse(response) {
            const captured = extractDataNodesBrowserDownload(response, rawUrl);
            if (!captured) {
                let candidate = '';
                try {
                    const payload = JSON.parse(String(response && response.body || ''));
                    candidate = payload && (payload.downloadUrl || payload.download_url || payload.url)
                        || payload && payload.data && (payload.data.downloadUrl || payload.data.download_url || payload.data.url)
                        || '';
                } catch (_) {}
                try {
                    const rejectedHost = new URL(candidate).hostname.toLowerCase();
                    console.warn('[download-resolver] DataNodes returned an unapproved transfer host: ' + rejectedHost);
                } catch (_) {}
                return null;
            }
            return {
                attachBrowserContext: true,
                value: captured
            };
        }
    };
}

async function resolveWithManagedHostBrowser(rawUrl, provider, referer, onProgress, signal = null) {
    const initial = managedHostInitialLoad(provider, rawUrl, referer);
    const reportProgress = label => {
        if (typeof onProgress !== 'function') return;
        try { onProgress(label); } catch (_) {}
    };
    const systemBrowser = findSystemChromiumExecutable();
    reportProgress('Waiting for the secure verification window…');
    console.info('[download-resolver] Opening a visible ' + provider + ' verification handoff in '
        + (systemBrowser ? 'the system browser.' : 'the Electron fallback.'));
    let captured = await managedVerificationCoordinator.run(`${provider}:${rawUrl}`, async ownedSignal => {
        reportProgress('Verification window opened — complete the check there to continue…');
        if (systemBrowser) {
            try {
                let parentBounds = null;
                try {
                    if (mainWindow && !mainWindow.isDestroyed()) parentBounds = mainWindow.getBounds();
                } catch (_) {}
                const verificationResourceHosts = [
                    ...HUMAN_VERIFICATION_RESOURCE_HOSTS,
                    new URL(initial.url).hostname
                ];
                const systemCaptured = await resolveWithSystemChromium(initial.url, managedHostClickExpression(provider), {
                    executablePath: systemBrowser,
                    tempRoot: path.join(app.getPath('temp'), 'SailLauncherVerificationBrowser'),
                    timeoutMs: 120000,
                    visible: true,
                    appMode: true,
                    parentBounds,
                    captureDownloads: true,
                    observeVerification: true,
                    minimizeOnVerification: true,
                    onVerificationComplete: () => reportProgress('Verification accepted — waiting for the host to prepare the file…'),
                    onVerificationNeedsAttention: () => reportProgress('The host rejected or reset that verification — the check is ready to try again…'),
                    onBlockedPopup: () => reportProgress('Blocked an off-site ad pop-up — still waiting for the real provider download…'),
                    blockedHosts: adBlockEnabled ? AD_BLOCK_HOSTS : [],
                    allowedResourceHosts: verificationResourceHosts,
                    navigationReferrer: referer,
                    isAllowedUrl: parsed => managedHostPageAllowed(provider, parsed, rawUrl),
                    acceptDownloadUrl: value => managedHostUrlAllowed(provider, value, rawUrl),
                    captureRequestUrl: value => managedHostTransferRequest(provider, value, rawUrl),
                    // FuckingFast /dl URLs are single-use. Capture the main-frame
                    // request before Chromium sends it so aria2 gets the first and
                    // only transfer attempt instead of an already-consumed token.
                    interceptTransferRequests: provider === 'fuckingfast',
                    acceptResult: value => value && (value.linkHealth === HEALTH_STATES.DOWN
                        || managedHostUrlAllowed(provider, value.url, rawUrl)),
                    ...managedHostVerificationOptions(provider),
                    ...managedHostResponseCapture(provider, rawUrl),
                    signal: ownedSignal
                });
                if (systemCaptured) return systemCaptured;
                if (provider === 'fuckingfast') {
                    reportProgress('FuckingFast did not return a file after that verification — no second verification window was opened.');
                    return null;
                }
                reportProgress('The system browser did not return a file — trying Sail’s in-app handoff…');
            } catch (error) {
                if (error && error.name === 'AbortError') throw error;
                console.warn('[download-resolver] System-browser verification failed: '
                    + String(error && error.message || error).slice(0, 240));
                if (provider === 'fuckingfast') {
                    reportProgress('The FuckingFast handoff failed — no second verification window was opened.');
                    return null;
                }
                reportProgress('The system browser handoff failed — trying Sail’s in-app handoff…');
            }
        }
        return interceptDownload(initial.url, 120000, {
            loadOptions: initial.loadOptions,
            revealAfterMs: ['datanodes', 'akirabox', 'buzzheavier', 'fileditch', 'fuckingfast', 'multiup', '1337x', 'rootz', 'vikingfile'].includes(provider) ? 1200 : 0,
            humanVerification: true,
            hideOnVerification: true,
            clickExpression: managedHostClickExpression(provider),
            onVerificationComplete: () => reportProgress('Verification accepted — waiting for the host to prepare the file…'),
            onVerificationNeedsAttention: () => reportProgress('The host rejected or reset that verification — the check is ready to try again…'),
            onBlockedNavigation: () => reportProgress('Blocked an off-site ad redirect — still waiting for the real provider download…'),
            isAllowedPageUrl: parsed => managedHostPageAllowed(provider, parsed, rawUrl),
            acceptDownloadUrl: value => managedHostUrlAllowed(provider, value, rawUrl),
            ...managedHostVerificationOptions(provider),
            signal: ownedSignal
        });
    }, { signal });
    if (captured && captured.linkHealth === HEALTH_STATES.DOWN) {
        throw buildLinkDownError(rawUrl, captured.healthReason || `${provider}-page-reports-down`);
    }
    if (provider === 'datanodes' && captured
        && captured.transferAuthority === DATANODES_BROWSER_TRANSFER_AUTHORITY) {
        reportProgress('DataNodes returned a file link — confirming the transfer…');
        captured = await validateDataNodesBrowserTransfer(captured, {
            request: dlRequest,
            userAgent: DL_UA,
            acceptUrl: value => !isAdHost(value)
        });
        if (!captured) {
            reportProgress('DataNodes returned a non-file or blocked destination — choose another mirror.');
            return null;
        }
    }
    const capturedAllowed = captured && (managedHostUrlAllowed(provider, captured.url, rawUrl)
        || provider === 'datanodes' && captured.transferAuthority === DATANODES_BROWSER_TRANSFER_AUTHORITY
            && captured.validatedTransfer === true);
    if (!capturedAllowed) return null;
    reportProgress('File link captured — starting the download…');
    if (captured.url.startsWith('magnet:')) {
        return [{ url: captured.url, name: captured.name || 'Torrent download', kind: 'magnet', maxConn: 1 }];
    }
    let pageUrl = rawUrl;
    try {
        const candidate = new URL(captured.pageUrl || rawUrl);
        if (managedHostPageAllowed(provider, candidate, rawUrl)) pageUrl = candidate.href;
    } catch (_) {}
    const browserUserAgent = String(captured.userAgent || DL_UA).replace(/[\r\n]/g, '').slice(0, 512);
    const headers = [`Referer: ${pageUrl}`, `User-Agent: ${browserUserAgent}`];
    const capturedCookie = Array.isArray(captured.cookies)
        ? captured.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
        : captured.headers && captured.headers.Cookie;
    const cookie = String(capturedCookie || '').replace(/[\r\n]/g, '');
    if (cookie) headers.push(`Cookie: ${cookie}`);
    const managedFile = {
        url: captured.url,
        name: captured.name || '',
        kind: 'http',
        maxConn: ['buzzheavier', 'fuckingfast', 'datanodes'].includes(provider) ? 1 : 16,
        headers
    };
    if (provider === 'fuckingfast') {
        try {
            const transfer = new URL(captured.url);
            console.info('[download-resolver] FuckingFast transfer captured: host=' + transfer.hostname
                + ' path=' + (transfer.pathname.split('/').filter(Boolean)[0] || '/')
                + ' pathLength=' + transfer.pathname.length
                + ' queryLength=' + transfer.search.length
                + ' urlLength=' + captured.url.length
                + ' cookies=' + (cookie ? 'yes' : 'no'));
        } catch (_) {}
        managedFile.requiresFreshVerification = true;
        managedFile.disableIpv6 = true;
        if (await managedTransferNeedsDnsFallback(captured.url)) {
            managedFile.dnsServers = BUZZHEAVIER_FALLBACK_DNS.slice();
        }
    }
    if (provider === 'buzzheavier') {
        managedFile.resumeAcrossFreshUrl = true;
        if (await managedTransferNeedsDnsFallback(captured.url)) {
            managedFile.dnsServers = BUZZHEAVIER_FALLBACK_DNS.slice();
        }
    }
    return [managedFile];
}

// Find the most likely game executable in a folder, ignoring installers/redists.
// `gameName` (optional) biases selection toward an exe whose name matches the title.
function findGameExe(dir, gameName) {
    // Hard excludes — these are NEVER a game launcher. `setup`/`installer` stay excluded
    // in every tier so a repack's setup.exe can never become the launch target.
    const skip = /(unins|setup|vc_?redist|vcredist|dxsetup|directx|dotnet|dotnetfx|oalinst|redist|crashreport|crashhandler|uninstall|launcher_settings|notification_helper|quicksfv|sfv|installer)/i;
    // Soft excludes — usually not the main game, but allowed as a last resort.
    const soft = /(config|settings|editor|server|benchmark|cleanup|dxdiag|prereq|helper|report)/i;
    const exes = [];
    const walk = (d, depth) => {
        if (depth > 10) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
            const full = path.join(d, ent.name);
            if (ent.isSymbolicLink()) continue;
            if (ent.isDirectory()) { walk(full, depth + 1); continue; }
            if (!ent.name.toLowerCase().endsWith('.exe')) continue;
            // ignore repack helper exes tucked in an MD5/checksum folder
            if (/[\\/]md5[\\/]/i.test(full)) continue;
            let size = 0;
            try { size = fs.statSync(full).size; } catch (e) {}
            exes.push({ name: ent.name, full, size, hard: skip.test(ent.name), soft: soft.test(ent.name) });
        }
    };
    walk(dir, 0);
    if (!exes.length) return null;
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(gameName);
    // Tier 1: real game exes (not installers/redists). Tier 2 (relaxed) recovers games
    // whose launcher tripped a soft keyword — but still never an installer/uninstaller.
    let pool = exes.filter(e => !e.hard);
    if (!pool.length) return null;
    pool.sort((a, b) => {
        const am = target && norm(a.name).includes(target) ? 1 : 0;
        const bm = target && norm(b.name).includes(target) ? 1 : 0;
        if (am !== bm) return bm - am;                 // name matches the game → strongly preferred
        if (a.soft !== b.soft) return a.soft ? 1 : -1; // demote config/editor/launcher helpers
        return b.size - a.size;                        // otherwise the biggest exe wins
    });
    return pool[0].full;
}

function findArchives(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
    const primaries = [];
    for (const en of entries) {
        // Recurse into non-underscore subdirs (handles torrent root folders)
        if (en.isDirectory() && !en.name.startsWith('_')) {
            primaries.push(...findArchives(path.join(dir, en.name)));
            continue;
        }
        if (!en.isFile()) continue;
        const f = en.name, low = f.toLowerCase();
        // skip non-first split parts
        if (/\.part(?!0*1\.)\d+\.rar$/i.test(f)) continue;          // part2.rar, part3.rar...
        if (/\.part(?!0*1\.)\d+\.zip$/i.test(f)) continue;           // part2.zip, part3.zip...
        if (/\.(r\d{2}|z\d{2})$/i.test(f)) continue;                 // .r00/.z01 split volumes
        if (/\.\d{3}$/.test(f) && !/\.001$/.test(f)) continue;       // .002, .003 ... keep .001
        if (/\.(zip|rar|7z)$/i.test(low) || /\.7z\.001$/i.test(low) || /\.zip\.001$/i.test(low)) {
            primaries.push(path.join(dir, f));
        }
    }
    return primaries;
}

// Extract a .rar via node-unrar-js (pure-JS, supports RAR4 AND RAR5). The bundled
// 7za.exe ships WITHOUT the RAR codec — it can't open ANY .rar ("Cannot open the
// file as archive", exit 2) — so SteamRIP/SteamGG rars must go through unrar instead.
async function extractRar(archivePath, destDir, work) {
    if (work) await work.checkpoint();
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    await runOwnedWorker(ARCHIVE_EXTRACT_WORKER, {
        archivePath,
        targetPath: destDir
    }, work);
    if (work) await work.checkpoint();
    return destDir;
}

async function extractArchive(archivePath, destDir, work) {
    if (work) await work.checkpoint();
    if (/\.rar$/i.test(archivePath)) {
        // RAR (incl. RAR5) — 7za can't do these at all; use node-unrar-js.
        return extractRar(archivePath, destDir, work).catch((e) => {
            console.error('[extract] unrar failed for', archivePath, '-', e && e.message);
            throw e;
        });
    }
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const binaryPath = _7z.getConfig().binaryPath;
    try {
        await runOwnedChildProcess(binaryPath, ['x', archivePath, `-o${destDir}`, '-y'], work);
        if (work) await work.checkpoint();
        return destDir;
    } catch (err) {
        console.error('[extract] 7-Zip failed for', archivePath, '-', err && err.message);
        if (!/\.zip$/i.test(archivePath)) throw err;
        if (work) await work.checkpoint();
        const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
        const cmd = 'Expand-Archive -LiteralPath ' + psQuote(archivePath) + ' -DestinationPath ' + psQuote(destDir) + ' -Force';
        try {
            await runOwnedChildProcess('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], work);
            if (work) await work.checkpoint();
            return destDir;
        } catch (fallbackError) {
            throw new Error('7-Zip: ' + (err && err.message || 'failed') + ' | Expand-Archive: ' + (fallbackError && fallbackError.message || 'failed'));
        }
    }
}

// Read the leading bytes of a file and return the archive extension its magic
// number indicates (zip/rar/7z), or '' if it isn't a recognised archive.
function sniffArchiveExt(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(8);
        const n = fs.readSync(fd, buf, 0, 8, 0);
        if (n < 4) return '';
        // ZIP: "PK" 03 04 (local file), also 05 06 (empty) / 07 08 (spanned)
        if (buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
        // RAR: "Rar!" 1A 07
        if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return 'rar';
        // 7z: 37 7A BC AF 27 1C
        if (buf[0] === 0x37 && buf[1] === 0x7A && buf[2] === 0xBC && buf[3] === 0xAF) return '7z';
        return '';
    } catch (e) { return ''; }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
}

// A link resolved through a debrid service (e.g. SteamRIP, which is debrid-gated)
// often saves the file WITHOUT a recognisable archive extension — the direct URL
// is a tokenised hash and there's no Content-Disposition, so aria2 names it after
// the URL. A SteamRIP .zip then lands as an extension-less blob that findArchives()
// can't see, so it's never auto-extracted. Sniff the magic bytes of extension-less
// payload files and rename them with the right extension so the normal extract path
// (and split-part handling) picks them up exactly like a SteamGG download.
function normalizeArchiveExtensions(dir, depth) {
    if ((depth || 0) > 4) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const en of ents) {
        if (en.isDirectory()) { if (!en.name.startsWith('_')) normalizeArchiveExtensions(path.join(dir, en.name), (depth || 0) + 1); continue; }
        if (!en.isFile()) continue;
        const name = en.name;
        if (/^_cover\./i.test(name)) continue;
        // Leave anything that already carries an archive/installer/media/control extension —
        // only truly extension-less (or opaque) blobs are candidates for sniffing.
        if (/\.(zip|rar|7z|bin|iso|exe|msi|cab|pkg|001|002|003|004|005|part\d+|r\d{2}|z\d{2}|aria2|tmp)$/i.test(name)) continue;
        const full = path.join(dir, name);
        let size = 0; try { size = fs.statSync(full).size; } catch (e) { continue; }
        if (size < 1024) continue; // skip tiny/HTML error payloads
        const ext = sniffArchiveExt(full);
        if (!ext) continue;
        const target = full + '.' + ext;
        try { if (!fs.existsSync(target)) fs.renameSync(full, target); } catch (e) {}
    }
}

// Total size (bytes) of everything under a folder — used for soft install progress.
function dirSizeBytes(d, depth) {
    if (depth > 8) return 0;
    let total = 0, ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return 0; }
    for (const en of ents) {
        const full = path.join(d, en.name);
        if (en.isDirectory()) total += dirSizeBytes(full, (depth || 0) + 1);
        else { try { total += fs.statSync(full).size; } catch (e) {} }
    }
    return total;
}

// Run a FitGirl (InnoSetup) installer unattended into targetDir. These repacks
// support InnoSetup's silent switches; /VERYSILENT skips the custom UI, /DIR sets the
// destination. The installer may still raise a single UAC prompt if it needs admin.
function runSilentInstall(installerPath, targetDir, ctl, skipExtras, work) {
    return new Promise((resolve, reject) => {
        try { if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
        // FitGirl installers require admin to install. The policy script checkpoints the
        // job first, requests one UAC prompt for itself, and then owns the exact elevated
        // installer process tree so prerequisite handling never targets unrelated setups.
        //
        // skipExtras keeps the normal Inno task deselection and also applies a scoped
        // descendant policy for FitGirl's custom post-install integrity/prerequisite steps.
        //
        // Audio: FitGirl installers play background music even under /VERYSILENT.
        // Rather than muting the WHOLE system, we mute ONLY the installer's own audio
        // session(s) — its process plus any children — via the per-app ISimpleAudioVolume
        // COM API, polling because the session appears a moment after launch. Nothing global
        // is touched, so the user's other audio keeps playing and there's nothing to restore.
        const extras = skipExtras ? ' /NOICONS /TASKS=""' : '';
        const innoArgs = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL /SP-' + extras;

        // Build a self-contained PS1 that handles mute + elevated run in one shot.
        // Written to a temp file to avoid command-line escaping of the here-string.
        let psScript;
        try {
            psScript = fs.readFileSync(path.join(__dirname, 'runtime', 'fitGirlInstaller.ps1'), 'utf8');
        } catch (error) {
            return reject(new Error('FitGirl installer policy could not be loaded: ' + error.message));
        }
        // Fail fast (with a clear message) if the installer the caller handed us is missing,
        // rather than spawning PowerShell only to hit LAUNCH_FAIL.
        if (!installerPath || !fs.existsSync(installerPath)) {
            return reject(new Error('Installer not found: ' + installerPath));
        }
        const jobStamp = Date.now() + '_' + crypto.randomBytes(6).toString('hex');
        const tmpFile = path.join(process.env.TEMP || process.env.TMP || path.dirname(installerPath), 'sail_inst_' + jobStamp + '.ps1');
        const launchGate = tmpFile + '.launch';
        const statusFile = tmpFile + '.status';
        const innoLogFile = tmpFile + '.inno.log';
        // Write WITH a UTF-8 BOM so Windows PowerShell 5.1 decodes the script as UTF-8 (it
        // falls back to the ANSI code page for BOM-less files). The dynamic paths now travel
        // via env vars below, but the BOM is cheap belt-and-suspenders.
        try { fs.writeFileSync(tmpFile, '﻿' + psScript, 'utf8'); }
        catch (e) { return reject(e); }

        let proc;
        // Pass the Unicode paths as env vars — Windows hands these to the child as UTF-16, so a
        // game folder with accents / apostrophes / CJK characters reaches PowerShell intact.
        const psEnv = Object.assign({}, process.env, {
            SAIL_INSTALLER: installerPath,
            SAIL_TARGET: targetDir,
            SAIL_ARGS: innoArgs,
            SAIL_LAUNCH_GATE: launchGate,
            SAIL_MUTE_FLAG: path.join(app.getPath('userData'), '.installer_mute'),
            SAIL_SKIP_REDIST: skipExtras ? '1' : '0',
            SAIL_STATUS_FILE: statusFile,
            SAIL_INNO_LOG: innoLogFile,
            SAIL_ELEVATED: '0'
        });
        try { proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], { windowsHide: true, env: psEnv }); }
        catch (e) { try { fs.unlinkSync(tmpFile); } catch (er) {} return reject(e); }
        ctl.proc = proc;
        Promise.resolve(work && work.setStop(() => { try { proc.kill(); } catch (_) {} })).catch(() => {});
        // Capture the watcher's diagnostic output (LAUNCH/ROOT/PHASE1/DONE lines). Mirrored to
        // the console AND a log file next to the install so a failed auto-install is debuggable.
        let psOut = '';
        let launchAuthorized = false;
        const inspectInstallerOutput = () => {
            if (launchAuthorized || !psOut.includes('READY_TO_LAUNCH')) return;
            launchAuthorized = true;
            Promise.resolve().then(async () => {
                if (work) {
                    await work.checkpoint();
                    await work.markInstallerRunning();
                    await work.setStop(null);
                }
                fs.writeFileSync(launchGate, 'launch', { flag: 'wx' });
            }).catch(() => { try { proc.kill(); } catch (_) {} });
        };
        try { proc.stdout && proc.stdout.on('data', d => { psOut += d.toString(); inspectInstallerOutput(); }); } catch (e) {}
        try { proc.stderr && proc.stderr.on('data', d => { psOut += d.toString(); }); } catch (e) {}
        const cleanupInstallerPolicyFiles = () => {
            for (const file of [tmpFile, launchGate, statusFile, innoLogFile]) {
                try { fs.unlinkSync(file); } catch (_) {}
            }
        };
        proc.on('error', (e) => { cleanupInstallerPolicyFiles(); reject(e); });
        proc.on('close', (code) => {
            try {
                const trimmed = psOut.trim();
                if (trimmed) console.log('[auto-install] ' + trimmed.replace(/\r?\n/g, ' | '));
                let innoLog = '';
                try {
                    const raw = fs.readFileSync(innoLogFile);
                    innoLog = raw.subarray(0, 4 * 1024 * 1024).toString('utf8');
                } catch (_) {}
                fs.writeFileSync(path.join(path.dirname(targetDir), '_sail_install_log.txt'),
                    '[' + new Date().toISOString() + '] exit=' + code + '\r\n' + psOut
                    + (innoLog ? '\r\n[Inno Setup]\r\n' + innoLog : ''), 'utf8');
            } catch (e) {}
            cleanupInstallerPolicyFiles();
            Promise.resolve(work && work.markInstallerExited()).catch(() => {}).finally(() => {
                if (ctl.cancelled) return reject(new Error('Cancelled'));
                if (code === 1223) return reject(new Error('Windows permission prompt was declined'));   // UAC cancelled
                if (code !== 0) return reject(new Error('FitGirl installer failed with exit code ' + code));
                resolve(0);
            });
        });
    });
}

// FitGirl installers are InnoSetup bootstrappers: the setup.exe we launch often
// extracts a second installer to %TEMP%, hands off, and EXITS within a second — so the
// process we waited on is gone long before the game has finished being written. Polling
// the process tree alone declares "done" too early, we find no game exe, and the whole
// install is wrongly reported as failed. Instead, after the launched process exits, watch
// the destination folder and only consider the install finished once it has STOPPED
// growing for a sustained window (or nothing was ever written → genuinely failed).
async function waitForDirSettle(dir, ctl, onTick, work) {
    const interval = 2500;          // poll cadence
    const stableMs = 9000;          // size must hold steady this long to count as done
    const graceZeroMs = 30000;      // if NOTHING is written within this, treat as failed
    const maxMs = 90 * 60 * 1000;   // hard ceiling (huge repacks can take a while)
    let last = -1, stableFor = 0, waited = 0;
    while (waited < maxMs) {
        await new Promise(resolve => setTimeout(resolve, interval));
        if (ctl && ctl.cancelled) return;
        if (work) await work.checkpoint();
        let sz = 0;
        try { sz = await preparedDirectorySize(dir, work); }
        catch (error) {
            if (/cancelled/i.test(error && error.message || '')) throw error;
        }
        if (typeof onTick === 'function') { try { onTick(sz); } catch (e) {} }
        if (sz === 0) {
            if (waited >= graceZeroMs) return;   // installer wrote nothing → give up
        } else if (last >= 0 && Math.abs(sz - last) < 1024 * 1024) {
            stableFor += interval;
            if (stableFor >= stableMs) return;  // size held steady → install finished
        } else {
            stableFor = 0;
        }
        last = sz;
        waited += interval;
    }
}

// After a successful extraction, delete the source archive(s) we just unpacked so the
// download folder isn't left holding both the game AND its (often huge) original zip/rar.
// Only top-level archive files are removed — never the extracted _game folder or cover.
function deleteArchiveSources(dir) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    // primary archives + split-volume siblings (.zip/.7z .001/.002, .partN.rar, .r00/.z01)
    const ARCHIVE = /\.(zip|rar|7z|iso)$|\.(zip|7z)\.\d{3}$|\.part\d+\.rar$|\.r\d{2}$|\.z\d{2}$|\.\d{3}$/i;
    for (const en of ents) {
        if (!en.isFile()) continue;
        if (/^_cover\./i.test(en.name)) continue;
        if (ARCHIVE.test(en.name)) { try { fs.unlinkSync(path.join(dir, en.name)); } catch (e) {} }
    }
}

// SteamRIP (and similar pre-installed) zips bundle filler alongside the game: a
// "read_me" / instructions txt, a "Visit SteamRIP".url internet shortcut, and a
// _CommonRedist folder of VC++/DirectX installers. After extraction we strip these
// so the library folder holds only the playable game. Redist removal honours the
// skipRedist setting (default on) — turn it off to keep the bundled installers.
function cleanExtractedJunk(root, skipRedist) {
    (function walk(d, depth) {
        if (depth > 4) return;
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const en of ents) {
            const full = path.join(d, en.name);
            if (en.isDirectory()) {
                // _CommonRedist / CommonRedist / Redist / DirectX / _Redist bundles
                if (skipRedist && /^_?(common[ _-]?)?redist$/i.test(en.name)) {
                    try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) {}
                    continue;
                }
                walk(full, depth + 1);
                continue;
            }
            if (!en.isFile()) continue;
            const n = en.name;
            // internet shortcuts (Visit SteamRIP.url, etc.)
            if (/\.url$/i.test(n)) { try { fs.unlinkSync(full); } catch (e) {} continue; }
            // SteamRIP readme / instructions notes (kept narrow so real game text isn't touched)
            if (/\.txt$/i.test(n) && /(read[ _-]?me|steamrip|instruction)/i.test(n)) { try { fs.unlinkSync(full); } catch (e) {} continue; }
        }
    })(root, 0);
}

// After a successful install, remove the downloaded repack (setup.exe + fg-*.bin +
// torrent subfolder + verify .bat etc.), keeping only the installed game folder and cover.
function cleanRepackSource(dir, keepDir) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const en of ents) {
        const full = path.join(dir, en.name);
        if (full === keepDir) continue;
        if (/^_cover\./i.test(en.name)) continue;
        try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) {}
    }
}

async function postProcessDownload(job, dir, opts) {
    return downloadWork.run(job, { type: 'post-processing', state: 'post_processing' }, work => postProcessDownloadBody(dir, opts, work));
}

async function runDownloadPreparation(operation, dir, work, extra = {}) {
    return runOwnedWorker(DOWNLOAD_PREPARATION_WORKER, Object.assign({ operation, dir }, extra), work);
}

async function scanDownloadedPayload(dir, gameName, work) {
    return runDownloadPreparation('scan-payload', dir, work, { gameName: String(gameName || '') });
}

async function preparedDirectorySize(dir, work) {
    const result = await runDownloadPreparation('directory-size', dir, work);
    return Number(result && result.bytes) || 0;
}

async function postProcessDownloadBody(dir, opts, work) {
    await work.checkpoint();
    const result = {
        gameName: opts.gameName, folder: dir, exePath: '', cover: '', extracted: false,
        usable: false, junk: false, autoAdd: opts.autoAdd !== false, sourceId: opts.sourceId
    };
    // locate cover saved earlier
    try {
        const coverFile = fs.readdirSync(dir).find(f => /^_cover\./i.test(f));
        if (coverFile) result.cover = path.join(dir, coverFile);
    } catch (e) {}

    // Give extension-less downloads (debrid-resolved SteamRIP .zips, etc.) the right
    // archive extension by content, BEFORE we walk/detect — so they auto-extract.
    await work.checkpoint();
    if (opts.autoExtract !== false) {
        try { await runDownloadPreparation('normalize-archives', dir, work); }
        catch (error) {
            if (/cancelled/i.test(error && error.message || '')) throw error;
        }
    }

    // walk ALL payload files recursively (torrents/installers nest in a subfolder)
    const initialScan = await scanDownloadedPayload(dir, opts.gameName, work);
    const allFiles = initialScan.files.slice();
    const archives = initialScan.archives;

    let archiveValidationFailed = false;
    if (opts.autoExtract !== false && archives.length) {
        const extractTo = path.join(dir, '_game');
        let anyExtracted = false, extractErr = null;
        for (const arc of archives) {
            await work.checkpoint();
            try { await extractArchive(arc, extractTo, work); await work.checkpoint(); result.extracted = true; anyExtracted = true; }
            catch (e) { await work.checkpoint(); extractErr = e; console.error('[postProcess] extraction failed for', arc, '-', e && e.message); /* leave archive in place */ }
        }
        // Strip SteamRIP/pre-installed filler (readme, .url shortcut, _CommonRedist) so the
        // library folder is just the game. Runs before findGameExe so a redist installer
        // exe can't be mistaken for the game.
        await work.checkpoint();
        if (result.extracted) {
            await runDownloadPreparation('clean-extracted-junk', extractTo, work, {
                skipRedist: opts.skipRedist !== false
            });
        }
        // Extraction was attempted but every archive failed → tell the user why instead of
        // silently reporting success with the un-extracted archive sitting in the folder.
        if (!anyExtracted && extractErr) {
            archiveValidationFailed = true;
            result.warning = 'Auto-extract failed: ' + extractErr.message + ' The archive is in the game folder — extract it manually.';
        }
        // CRITICAL: the file list above was captured BEFORE extraction, so it only knew about
        // the archives (now deleted). A repack can ship setup.exe + fg-*.bin INSIDE that archive
        // (FitGirl sometimes wraps the installer in a .rar). Re-walk the extracted folder and
        // append its files so the installer detection below can see them — otherwise needsInstall
        // is never set and the auto-installer never runs.
        if (result.extracted) {
            const extractedScan = await scanDownloadedPayload(extractTo, opts.gameName, work);
            result.exePath = extractedScan.exePath || initialScan.exePath || '';
            allFiles.push(...extractedScan.files);
        }
        // Free the disk: once extraction succeeded and produced real content, delete the
        // source archive(s) + their split-part siblings (e.g. SteamGG's leftover 18 GB zip).
        let extractedSize = 0;
        try { extractedSize = await preparedDirectorySize(extractTo, work); } catch (e) {}
        await work.checkpoint();
        if (anyExtracted && extractedSize > 5 * 1024 * 1024) {
            await runDownloadPreparation('delete-archive-sources', dir, work);
        }
    }
    await work.checkpoint();
    if (!result.exePath) result.exePath = initialScan.exePath || '';

    // Installer-style payloads (e.g. FitGirl: setup.exe + fg-*.bin parts, often in a
    // torrent subfolder) aren't auto-extractable but ARE a successful download — the
    // user runs the installer. Scan recursively.
    const redist = /(unins|vc_?redist|vcredist|dxsetup|directx|dotnet|dotnetfx|oalinst|quicksfv)/i;
    const hasBin = allFiles.some(f => /\.bin$/i.test(f.name) || /^fg-/i.test(f.name));
    const bigFile = allFiles.some(f => f.size > 50 * 1024 * 1024);
    // Locate the repack's real installer: a setup/install*.exe that isn't a redist/helper
    // and isn't tucked inside an MD5/checksum folder.
    const setupExe = allFiles.find(f => /(setup|install|installer)[^\\/]*\.exe$/i.test(f.name)
        && !redist.test(f.name) && !/[\\/]md5[\\/]/i.test(f.full));
    const installer = setupExe
        || allFiles.find(f => /\.exe$/i.test(f.name) && !redist.test(f.name) && !/[\\/]md5[\\/]/i.test(f.full));
    // SteamRIP (and similar "pre-installed" sources) ship the game ready to run inside the
    // zip — there is NO setup.exe to execute. They must be treated as extract-and-play: pick
    // the real game exe (findGameExe already skips setup/redist/uninstall exes) and never route
    // them through the repack auto-installer (which would run a non-installer .exe and fail, so
    // the game would never get added to the library). This is what makes a finished SteamRIP
    // download land in the library with its exe + Steam art, exactly like a FitGirl install.
    const preInstalled = /^(steamrip|steamgg)$/i.test(opts.sourceId || '');
    if (preInstalled) {
        // Already extracted above → result.exePath is the findGameExe pick. If that came back
        // empty (an oddly-named launcher), fall back to the best non-installer/redist exe so we
        // still hand back something playable rather than nothing.
        if (!result.exePath) {
            const gameExe = allFiles.find(f => /\.exe$/i.test(f.name)
                && !redist.test(f.name) && !/(setup|install|installer)[^\\/]*\.exe$/i.test(f.name) && !/[\\/]md5[\\/]/i.test(f.full));
            if (gameExe) result.exePath = gameExe.full;
        }
        // never set needsInstall for a pre-installed source
    }
    // FitGirl repacks ship as setup.exe + .bin parts → always treat as an install,
    // overriding any stray tiny helper .exe (e.g. QuickSFV) that findGameExe may have grabbed.
    else if (setupExe && hasBin) { result.exePath = setupExe.full; result.needsInstall = true; }
    else if (!result.exePath && installer) { result.exePath = installer.full; result.needsInstall = true; }

    // Did we actually end up with something playable/installable?
    result.usable = !archiveValidationFailed && !!(result.extracted || result.exePath || archives.length || installer || hasBin || bigFile);
    if (!result.usable) {
        // common failure: the host served an ad/redirect HTML page saved as "download"
        result.junk = allFiles.length === 0 || allFiles.every(f => /^download(\.|$)/i.test(f.name) || /\.(html?|php|txt)$/i.test(f.name));
        if (!result.junk && allFiles.length === 1 && allFiles[0].size < 100 * 1024) result.junk = true;
    }
    await work.checkpoint();
    return result;
}

// Generic repair bundles are not game payloads. Matches on filename or URL.
const DL_SKIP_FILE = /fix[_\s.-]*repair[_\s.-]*steam[_\s.-]*(v\d+[_\s.-]*)?generic|_repair_steam_|repair[_\s.-]*steam[_\s.-]*generic/i;

function safeOutName(name) {
    let s = (name || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
    // Some debrid responses hand back the filename concatenated with itself, e.g.
    // "Game-SteamRIP.com.rarGame-SteamRIP.com.rar" → aria2 then saves that doubled name.
    // Collapse an exact doubling when the half ends in an archive extension (so only the
    // bug pattern is touched, never a legitimately repetitive title).
    const dup = s.match(/^(.+?\.(?:zip|rar|7z|bin|iso|001))\1$/i);
    if (dup) s = dup[1];
    return s.slice(0, 120);
}

// Remove a partial file + aria2 control file so a retry starts fresh (needed when
// a single-use token URL can no longer be resumed).
function cleanPartial(dir, file) {
    try {
        let nm = file.name;
        if (!nm) { try { nm = decodeURIComponent(file.url.split('?')[0].split('/').pop() || ''); } catch (e) {} }
        nm = safeOutName(nm);
        if (!nm) return;
        [path.join(dir, nm), path.join(dir, nm + '.aria2')].forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
    } catch (e) {}
}

// Download a single resolved file with aria2. Resolves on exit 0, rejects otherwise.
// `file` is { url, kind, headers?, name? }. `ctl` lets cancel() kill the process.
function runAria2Download(aria2, file, dir, opts, ctl, onProgress) {
    return new Promise((resolve, reject) => {
        // Some hosts hand out single-use token URLs (fuckingfast) — parallel
        // connections/resume break them, so cap connections for those.
        const conns = file.maxConn || 16;
        const args = [
            file.url, '--dir=' + dir, '--summary-interval=1', '--console-log-level=warn',
            '--allow-overwrite=true', '--auto-file-renaming=false', '--continue=true',
            // Large sparse/preallocated files can look frozen at 0% for minutes on
            // Windows. Allocate as bytes arrive so the transfer becomes visible
            // immediately and cancellation stays responsive.
            '--file-allocation=none',
            '--max-connection-per-server=' + conns, '--split=' + conns, '--min-split-size=1M', '--check-certificate=true',
            '--max-tries=3', '--retry-wait=3', '--connect-timeout=30', '--timeout=60',
            '--user-agent=' + DL_UA
        ];
        // FuckingFast currently advertises IPv6 even on Windows hosts without a
        // usable IPv6 route. aria2 then exits immediately with WSAEADDRNOTAVAIL
        // before trying the working IPv4 address. Keep this provider-specific so
        // other download hosts retain their existing address-family behavior.
        if (file.disableIpv6 === true) args.push('--disable-ipv6=true');
        // Name the file ONLY when we have a real archive/game filename. The link
        // "name" is often just a host label (e.g. "fuckingfast.co") whose ".co"
        // looks like an extension — using it as --out saved the file as
        // "fuckingfast.co". When we don't have a good name, omit --out so aria2
        // uses the server's Content-Disposition filename (the real .bin/.rar).
        const VALID_EXT = /\.(zip|rar|7z|bin|iso|exe|msi|cab|pkg|001|002|003|004|005|part\d+|r\d{2}|z\d{2})$/i;
        const outName = safeOutName(file.name || '');
        if (file.kind !== 'magnet' && outName && VALID_EXT.test(outName)) args.push('--out=' + outName);
        if (file.kind === 'magnet') { args.push('--seed-time=0', '--bt-stop-timeout=180', '--bt-max-peers=80'); }
        if (opts.maxSpeed && Number(opts.maxSpeed) > 0) args.push('--max-overall-download-limit=' + Math.round(Number(opts.maxSpeed)) + 'K');
        // per-host auth headers (array of "Key: Value" strings), or legacy {Cookie}
        if (Array.isArray(file.headers)) { file.headers.forEach(h => { if (h) args.push('--header=' + h); }); }
        else if (file.headers && file.headers.Cookie) { args.push('--header=Cookie: ' + file.headers.Cookie); }
        const dnsServers = Array.isArray(file.dnsServers)
            ? file.dnsServers.filter(server => nodeNet.isIP(String(server || ''))).slice(0, 4)
            : [];
        if (dnsServers.length) {
            args.push('--async-dns=true', '--async-dns-server=' + dnsServers.join(','));
        }

        const proc = spawn(aria2, args, { windowsHide: true });
        ctl.proc = proc;
        let buf = '';
        let diagnosticTail = '';
        let sawTransferProgress = false;
        const startingLabel = file.kind === 'magnet'
            ? 'Connecting to torrent peers and fetching file metadata…'
            : 'Connecting to the host and preparing the file…';
        try { onProgress({ phase: 'starting', percent: 0, label: startingLabel }); } catch (_) {}
        const slowStartTimer = setTimeout(() => {
            if (sawTransferProgress || ctl.cancelled || ctl.paused) return;
            const label = file.kind === 'magnet'
                ? 'Still fetching torrent metadata — peer availability controls this step…'
                : 'The link is ready — waiting for the host to send the first bytes…';
            try { onProgress({ phase: 'starting', percent: 0, label }); } catch (_) {}
        }, 8000);
        const onData = (data) => {
            const chunk = data.toString();
            buf += chunk;
            diagnosticTail = (diagnosticTail + chunk).slice(-4096);
            const lines = buf.split(/\r|\n/);
            buf = lines.pop();
            for (const line of lines) {
                const mm = line.match(/\[#\w+\s+([\d.]+\s*[KMGT]?i?B)\/([\d.]+\s*[KMGT]?i?B)\((\d+)%\).*?DL:\s*([\d.]+\s*[KMGT]?i?B)(?:.*?ETA:\s*(\S+?))?\]/);
                if (mm) {
                    sawTransferProgress = true;
                    clearTimeout(slowStartTimer);
                    onProgress({
                        phase: 'downloading',
                        downloaded: mm[1].replace(/\s/g, ''), total: mm[2].replace(/\s/g, ''),
                        percent: Number(mm[3]), speed: mm[4].replace(/\s/g, ''), eta: mm[5] || ''
                    });
                }
            }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', error => { clearTimeout(slowStartTimer); reject(error); });
        proc.on('close', (code) => {
            clearTimeout(slowStartTimer);
            ctl.proc = null;
            if (ctl.cancelled) return reject(new Error('Cancelled'));
            // Pause = kill aria2 but keep the partial file + .aria2 control file so a later
            // resume continues from where it stopped (aria2 --continue). Don't treat as an error.
            if (ctl.paused) return reject(new Error('Paused'));
            if (code === 0) return resolve();
            const safeDiagnostic = diagnosticTail
                .replace(/https?:\/\/\S+/gi, '[url]')
                .replace(/[\r\n]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(-1000);
            if (safeDiagnostic) console.warn(`[download-resolver] aria2 exit ${code}: ${safeDiagnostic}`);
            // Translate the common aria2 exit codes into something a user can act on.
            // 22 = the host returned an HTTP 4xx/5xx (rate-limited, expired, or captcha-walled).
            let msg = 'aria2 exit ' + code;
            if (code === 22) msg = 'The file host returned an error (HTTP 4xx/5xx). The link is usually rate-limited, expired, or behind a captcha — try another host or "Open game page".';
            else if (code === 3) msg = 'The file no longer exists on the host (404). Try another host or "Open game page".';
            else if (code === 8) msg = 'The host dropped the connection and the link can\'t be resumed. Retrying with a fresh link…';
            else if (code === 9) msg = 'Not enough disk space to finish the download.';
            const err = new Error(msg); err.aria2Code = code;
            reject(err);
        });
    });
}

function browserBytes(n) {
    n = Number(n) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + units[i];
}

function browserGameName(fileName) {
    let s = String(fileName || 'Browser download').replace(/\.(zip|rar|7z|iso|torrent)$/i, '');
    s = s.replace(/[-_. ]*(steamrip|steamgg)(\.com|\.net)?/ig, '').replace(/[-_. ]+$/g, '').trim();
    return s || 'Browser download';
}

function unusedDownloadPath(dir, fileName) {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    let dest = path.join(dir, fileName), n = 2;
    while (fs.existsSync(dest)) dest = path.join(dir, stem + ' (' + n++ + ')' + ext);
    return dest;
}

async function finishCapturedGameDownload(wc, id, dir, opts, ctl, job, steamMetadataPromise) {
    wc.send('download-progress', { id, state: 'processing', label: 'Extracting & preparing game...' });
    try {
        const res = await postProcessDownload(job, dir, opts);
        if (ctl.cancelled) throw new Error('Cancelled');
        if (res.needsInstall && res.exePath && opts.autoInstall !== false) {
            await downloadJobDirectories.setState(job, 'installing');
            const installTarget = installerTargetForDownload(dir, res.exePath);
            let polling = true;
            (async function pollSize() {
                while (polling) {
                    let gb = 0;
                    try { gb = await preparedDirectorySize(installTarget, null) / (1024 * 1024 * 1024); } catch (e) {}
                    wc.send('download-progress', { id, state: 'installing', percent: 100, label: gb > 0.01 ? 'Installing game... ' + gb.toFixed(2) + ' GB written' : 'Installing game... preparing files' });
                    await new Promise(r => setTimeout(r, 2500));
                }
            })();
            try {
                const exe = await downloadWork.run(job, { type: 'installer', state: 'launching_installer' }, async work => {
                    await runSilentInstall(res.exePath, installTarget, ctl, opts.skipRedist !== false, work);
                    await work.checkpoint();
                    polling = false;
                    await waitForDirSettle(installTarget, ctl, null, work);
                    await work.checkpoint();
                    let found = (await scanDownloadedPayload(installTarget, opts.gameName, work)).exePath;
                    for (let t = 0; !found && t < 3; t++) {
                        await new Promise(r => setTimeout(r, 3000));
                        await work.checkpoint();
                        found = (await scanDownloadedPayload(installTarget, opts.gameName, work)).exePath;
                    }
                    if (found) {
                        await work.checkpoint();
                        await runDownloadPreparation('clean-repack-source', dir, work, { keepDir: installTarget });
                    }
                    return found;
                });
                if (exe) {
                    res.exePath = exe; res.folder = installTarget; res.needsInstall = false; res.installed = true;
                } else {
                    res.installFailed = true; res.exePath = '';
                }
            } catch (e) {
                polling = false;
                if (ctl.cancelled || /cancelled/i.test(e.message)) throw e;
                res.installFailed = true; res.exePath = ''; res.installError = e.message;
            }
        }
        if (ctl.cancelled) throw new Error('Cancelled');
        if (!res.usable) {
            wc.send('download-error', { id, url: opts.url, needsBrowser: false, error: 'Browser download finished but no usable game files were found.' });
            await retainDownloadJobError(job);
            return;
        }
        applyInstallerCompletionPolicy(res, opts);
        if (res.exePath && !fs.existsSync(res.exePath)) res.exePath = '';
        if (!res.exePath && !res.installFailed) {
            const finalRoot = (res.folder && fs.existsSync(res.folder)) ? res.folder : dir;
            try { res.exePath = (await scanDownloadedPayload(finalRoot, opts.gameName, null)).exePath || ''; } catch (e) {}
            if (!res.exePath && finalRoot !== dir) {
                try { res.exePath = (await scanDownloadedPayload(dir, opts.gameName, null)).exePath || ''; } catch (e) {}
            }
        }
        if (ctl.cancelled) throw new Error('Cancelled');
        const completed = await finishDownloadJob(job, res, steamMetadataPromise);
        wc.send('download-complete', Object.assign({ id }, completed));
    } catch (e) {
        if (ctl.cancelled || /cancelled/i.test(e.message)) return;
        await retainDownloadJobError(job);
        wc.send('download-error', {
            id,
            error: 'The downloaded bytes could not be validated or prepared: ' + String(e && e.message || 'Unknown processing error')
        });
    }
}

async function captureBrowserDownload(wc, item, webContentsId, intent) {
    if (!intent || !intent.job || !intent.continuation || !intent.options) {
        try { item.cancel(); } catch (e) {}
        return;
    }
    const preparedOpts = intent.options;
    const fileName = safeOutName(item.getFilename() || 'download') || 'download';
    const id = intent.job.id;
    const opts = Object.assign({}, preparedOpts, {
        id: intent.job.id,
        gameName: preparedOpts.gameName || browserGameName(fileName),
        sourceId: preparedOpts.sourceId || 'browser',
        url: (() => { try { return item.getURL(); } catch (e) { return preparedOpts.url || ''; } })()
    });
    const steamMetadataPromise = resolveSteamMetadataForDownload(opts.gameName, opts.sourceId);
    const job = intent.job;
    const continuation = intent.continuation;
    let dir;
    try {
        dir = await downloadJobDirectories.ensureDirectory(continuation);
    } catch (error) {
        try { item.cancel(); } catch (e) {}
        wc.send('download-error', { id, url: opts.url, needsBrowser: true, error: 'This download name or folder cannot be used.' });
        return;
    }
    const savePath = unusedDownloadPath(dir, fileName);
    const ctl = { proc: null, item, dir, cancelled: false, paused: false, browserCapture: true, job, continuation };
    await downloadJobDirectories.attachControl(continuation, ctl);
    const browserOperation = await downloadJobDirectories.beginOperation(continuation, {
        type: 'browser-download',
        state: 'downloading',
        stop: () => { try { item.cancel(); } catch (_) {} }
    });
    activeDownloads.set(id, ctl);
    item.setSavePath(savePath);
    item.resume();
    let coverPromise = Promise.resolve();
    if (opts.image && /^https?:/i.test(opts.image)) {
        let ext = '.jpg'; try { ext = path.extname(new URL(opts.image).pathname) || '.jpg'; } catch (e) {}
        coverPromise = dlHttpToFile(opts.image, path.join(dir, '_cover' + ext)).catch(() => {});
    }
    wc.send('browser-download-started', {
        id,
        gameName: String(opts.gameName || '').slice(0, 240),
        fileName,
        image: String(opts.image || '').slice(0, 4096),
        sourceId: String(opts.sourceId || 'browser').slice(0, 80),
        url: String(opts.url || '').slice(0, 8192)
    });
    let lastBytes = 0, lastAt = Date.now();
    item.on('updated', () => {
        if (ctl.cancelled) return;
        const now = Date.now();
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        const seconds = Math.max(0.1, (now - lastAt) / 1000);
        const speedBytes = Math.max(0, received - lastBytes) / seconds;
        const percent = total > 0 ? Math.min(100, Math.round(received / total * 100)) : 0;
        const eta = total > received && speedBytes > 0 ? Math.ceil((total - received) / speedBytes) : 0;
        wc.send('download-progress', {
            id, state: ctl.paused ? 'paused' : 'downloading', percent,
            downloaded: browserBytes(received), total: total > 0 ? browserBytes(total) : '',
            speed: browserBytes(speedBytes), eta: eta ? (eta < 60 ? eta + 's' : Math.ceil(eta / 60) + 'm') : ''
        });
        lastBytes = received; lastAt = now;
    });
    item.once('done', async (event, state) => {
        activeDownloads.delete(id);
        await coverPromise;
        await downloadJobDirectories.endOperation(browserOperation);
        if (ctl.cancelled || state === 'cancelled') return;
        if (state !== 'completed') {
            wc.send('download-error', { id, url: opts.url, needsBrowser: true, error: 'Browser download was interrupted (' + state + ').' });
            await retainDownloadJobError(continuation);
            return;
        }
        browserDownloadIntents.complete(intent);
        await downloadJobDirectories.setState(continuation, 'post_processing');
        await finishCapturedGameDownload(wc, id, dir, opts, ctl, continuation, steamMetadataPromise);
    });
}

ipcMain.on('set-browser-download-capture', (e, config) => {
    config = config || {};
    const defaults = config.defaults && typeof config.defaults === 'object' ? config.defaults : {};
    browserDownloadCapture = {
        enabled: !!config.enabled,
        defaults: {
            maxSpeed: Math.max(0, Number(defaults.maxSpeed) || 0),
            autoExtract: defaults.autoExtract !== false,
            autoInstall: defaults.autoInstall !== false,
            skipRedist: defaults.skipRedist !== false,
            autoAdd: defaults.autoAdd !== false
        }
    };
});
ipcMain.handle('register-browser-webview', (e, webContentsId) => {
    if (Number.isFinite(Number(webContentsId))) browserDownloadWebContents.add(Number(webContentsId));
    return true;
});
ipcMain.handle('prepare-browser-download', createPrepareBrowserDownloadHandler({
    intents: browserDownloadIntents,
    registry: downloadJobDirectories,
    getDefaults: () => browserDownloadCapture.defaults || {},
    registerWebContents: id => browserDownloadWebContents.add(id),
    authorizeOptions: (_event, payload, prepared) => {
        const outer = exactGateAPayload(payload, ['webContentsId', 'metadata', 'rootCapabilityId', 'rootExpectedRevision'], 'Browser download preparation');
        const metadata = exactGateAPayload(outer.metadata, ['gameName', 'image', 'sourceId', 'url'], 'Browser download metadata');
        const normalized = normalizeDownloadRequest({
            id: 'browser-download',
            gameName: metadata.gameName,
            image: metadata.image || '',
            sourceId: metadata.sourceId || 'browser',
            url: metadata.url,
            maxSpeed: prepared.maxSpeed,
            autoExtract: prepared.autoExtract,
            autoInstall: prepared.autoInstall,
            skipRedist: prepared.skipRedist,
            autoAdd: prepared.autoAdd,
            ...(outer.rootCapabilityId !== undefined ? {
                rootCapabilityId: outer.rootCapabilityId,
                rootExpectedRevision: outer.rootExpectedRevision
            } : {})
        });
        delete normalized.id;
        return { ...normalized, browserCapture: true };
    }
}));
ipcMain.handle('resume-browser-download', async (e, id) => {
    const d = activeDownloads.get(id);
    if (!d || !d.item) return false;
    try {
        d.paused = false;
        if (d.job) await downloadJobDirectories.setState(d.continuation || d.job, 'downloading');
        d.item.resume();
        return true;
    } catch (err) { return false; }
});

function boundedDownloadText(value, label, maxLength, pattern = null) {
    const text = String(value || '').trim();
    if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text) || pattern && !pattern.test(text)) {
        throw new Error(`${label} is invalid.`);
    }
    return text;
}

function typedDownloadUrl(value, label, { allowMagnet = true } = {}) {
    const source = boundedDownloadText(value, label, 8192);
    if (allowMagnet && source.startsWith('magnet:')) {
        if (!/^magnet:\?xt=urn:[A-Za-z0-9][A-Za-z0-9:._-]{1,300}(?:&[^\s]*)?$/i.test(source)) throw new Error(`${label} is invalid.`);
        return source;
    }
    let parsed;
    try { parsed = new URL(source); } catch (_) { throw new Error(`${label} is invalid.`); }
    // FitGirl still publishes Rutor page links as HTTP even though the same tracker page is
    // available over HTTPS. Upgrade only the exact known tracker hosts; every other inbound
    // download URL remains subject to the credential-free HTTPS gate below.
    if (parsed.protocol === 'http:' && !parsed.username && !parsed.password
        && (!parsed.port || parsed.port === '80') && /^(?:d\.)?rutor\.info$/i.test(parsed.hostname)) {
        parsed.protocol = 'https:';
        parsed.port = '';
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port && parsed.port !== '443' || source.includes('\\')) {
        throw new Error(`${label} must be a credential-free HTTPS URL.`);
    }
    return parsed.href;
}

function normalizeDownloadRequest(value) {
    const input = exactGateAPayload(value, [
        'id', 'gameName', 'image', 'url', 'links', 'sourceId', 'mirrors', 'maxSpeed',
        'autoExtract', 'autoInstall', 'skipRedist', 'autoAdd', 'referrer',
        'rootCapabilityId', 'rootExpectedRevision'
    ], 'Download request');
    const output = {
        id: boundedDownloadText(input.id, 'Download ID', 128, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
        gameName: boundedDownloadText(input.gameName, 'Download game name', 240),
        image: input.image ? typedDownloadUrl(input.image, 'Download image', { allowMagnet: false }) : '',
        sourceId: boundedDownloadText(input.sourceId || 'download', 'Download source', 80, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
        mirrors: [],
        links: [],
        maxSpeed: Math.max(0, Math.min(100000000, Number(input.maxSpeed) || 0)),
        autoExtract: input.autoExtract !== false,
        autoInstall: input.autoInstall !== false,
        skipRedist: input.skipRedist !== false,
        autoAdd: input.autoAdd !== false
    };
    if (input.referrer) output.referer = typedDownloadUrl(input.referrer, 'Download referrer', { allowMagnet: false });
    if (input.url) output.url = typedDownloadUrl(input.url, 'Download URL');
    if (input.links !== undefined) {
        if (!Array.isArray(input.links) || !input.links.length || input.links.length > 32) throw new Error('Download links are invalid.');
        output.links = input.links.map((row, index) => {
            const link = exactGateAPayload(row, ['url', 'name'], `Download link ${index}`);
            return {
                url: typedDownloadUrl(link.url, `Download link ${index}`),
                name: String(link.name || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240)
            };
        });
    }
    if (input.mirrors !== undefined) {
        if (!Array.isArray(input.mirrors) || input.mirrors.length > 16) throw new Error('Download mirrors are invalid.');
        // Older renderers may still send alternate hosts. Validate the legacy field
        // for a clean error, but never copy it into the authorized download job.
        input.mirrors.forEach((url, index) => typedDownloadUrl(url, `Download mirror ${index}`));
    }
    if (!output.url && !output.links.length) throw new Error('A typed download URL is required.');
    if (input.rootCapabilityId !== undefined || input.rootExpectedRevision !== undefined) {
        if (typeof input.rootCapabilityId !== 'string' || !Number.isSafeInteger(input.rootExpectedRevision)) throw new Error('The download root reference is invalid.');
        const resolved = gateAProfileStore().resolveDeviceRootCapability({
            kind: 'download-root',
            capabilityId: input.rootCapabilityId,
            expectedRevision: input.rootExpectedRevision
        });
        output.installDir = resolved.details.rootPath;
    } else output.installDir = '';
    return output;
}

ipcMain.handle('download-game', async (e, opts) => {
    opts = normalizeDownloadRequest(opts);
    const steamMetadataPromise = resolveSteamMetadataForDownload(opts.gameName, opts.sourceId);
    const wc = e.sender;
    const id = opts.id;
    const ctl = { proc: null, cancelled: false, paused: false };
    let job = null;
    let continuation = null;
    let slowTimer = null;
    try {
        job = beginDownloadJob(id, opts);
        continuation = await downloadJobDirectories.beginAttempt(job);
        ctl.job = job;
        ctl.continuation = continuation;
        await downloadJobDirectories.attachControl(continuation, ctl, 'resolving');
        // Normalise to a list of files. New callers pass opts.links = [{url,name}];
        // legacy single-link callers pass opts.url.
        let links = (Array.isArray(opts.links) && opts.links.length)
            ? opts.links.slice()
            : (opts.url ? [{ url: opts.url, name: opts.gameName }] : []);
        // never download the generic steam-fix bundle
        links = links.filter(l => !DL_SKIP_FILE.test((l.name || '') + ' ' + (l.url || '')));
        if (!links.length) {
            wc.send('download-error', { id, error: 'No usable download links found.', url: opts.url, needsBrowser: true });
            await retainDownloadJobError(continuation);
            return { success: false };
        }

        // Resolve as EARLY as possible: the instant the user starts the download we fire
        // the resolution (debrid API / scraper) — BEFORE aria2 setup and cover-art fetch —
        // so that round-trip overlaps with everything else instead of queuing behind it.
        activeDownloads.set(id, ctl);
        const svcName = debridServiceName();
        const resolveLabel = svcName ? ('Resolving via ' + svcName + '…') : 'Resolving download links…';
        // "Cached" = this source link already has a fresh resolved direct URL, so resolution
        // is instant. Flag it through every progress event so the UI can badge the download.
        const isCached = debridActive() && links.some(l => debridCacheHas(l.url));
        wc.send('download-progress', { id, state: 'resolving', label: resolveLabel, cached: isCached });
        // If resolution drags on (an uncached file-host job that has to be prepared),
        // reassure the user it isn't frozen rather than leaving a silent spinner.
        slowTimer = setTimeout(() => {
            if (ctl.cancelled) return;
            wc.send('download-progress', { id, state: 'resolving', label: resolveLabel, subLabel: 'This may take a moment for uncached files…' });
        }, 4000);

        const reportResolutionProgress = label => {
            if (ctl.cancelled || ctl.paused) return;
            wc.send('download-progress', { id, state: 'resolving', label, subLabel: '' });
        };
        const runOwnedLinkResolution = resolveTask => {
            const abortController = new AbortController();
            return downloadWork.run(continuation, {
                type: 'link-resolution',
                state: 'resolving',
                stop: () => abortController.abort()
            }, async work => {
                const result = await resolveTask(abortController.signal);
                await work.checkpoint();
                return result;
            });
        };
        const aria2 = await ensureAria2(wc);
        const dir = await downloadJobDirectories.ensureDirectory(continuation);
        ctl.dir = dir;

        // Keep the cover destination ready; the actual write is serialized as owned job work
        // after the payload so cancellation can never quarantine while it is still writing.
        let coverDownload = null;
        if (opts.image && /^https?:/i.test(opts.image)) {
            let ext = '.jpg';
            try { ext = path.extname(new URL(opts.image).pathname) || '.jpg'; } catch (er) {}
            coverDownload = { url: opts.image, destination: path.join(dir, '_cover' + ext) };
        }

        // Resolve and download one selected source link at a time. Short-lived host
        // tokens are consumed immediately instead of expiring while later CAPTCHA
        // windows are still queued, and only one verification owner exists at once.
        const sourceTotal = links.length;
        const seenUrl = new Set();
        let downloadedAny = false;
        for (let sourceIndex = 0; sourceIndex < sourceTotal; sourceIndex++) {
            if (ctl.cancelled) throw new Error('Cancelled');
            const sourceLink = links[sourceIndex];
            const sourceLabel = sourceTotal > 1 ? `Part ${sourceIndex + 1}/${sourceTotal}` : '';
            wc.send('download-progress', {
                id,
                state: 'resolving',
                part: sourceIndex + 1,
                partCount: sourceTotal,
                label: (sourceLabel ? sourceLabel + ' — ' : '') + 'Resolving this file…',
                subLabel: ''
            });
            const resolved = await runOwnedLinkResolution(signal => resolveDirectUrl(sourceLink.url, {
                sourceId: opts.sourceId,
                referer: opts.referer,
                onProgress: label => reportResolutionProgress((sourceLabel ? sourceLabel + ' — ' : '') + label),
                signal
            }));
            clearTimeout(slowTimer);
            if (!resolved || !resolved.length) {
                const error = buildUnresolvedError(sourceLink.url);
                error.downloadUrl = sourceLink.url;
                throw error;
            }
            let sourceFiles = resolved.map((file, originIndex) => Object.assign({
                name: file.name || sourceLink.name,
                origin: sourceLink.url,
                originIndex
            }, file));
            const filtered = sourceFiles.filter(file => !DL_SKIP_FILE.test((file.name || '') + ' ' + (file.url || '')));
            if (filtered.length) sourceFiles = filtered;
            sourceFiles = sourceFiles.filter(file => !seenUrl.has(file.url) && seenUrl.add(file.url));
            if (!sourceFiles.length) continue;

            await downloadJobDirectories.assertActive(continuation);
            await downloadJobDirectories.setState(continuation, 'downloading');
            for (let resolvedIndex = 0; resolvedIndex < sourceFiles.length; resolvedIndex++) {
                let file = sourceFiles[resolvedIndex];
                const expandedLabel = sourceFiles.length > 1
                    ? `${sourceLabel || 'File'} · file ${resolvedIndex + 1}/${sourceFiles.length}`
                    : sourceLabel;
                let attempt = 0, ok = false, lastErr = null;
                while (attempt < 3 && !ok) {
                    attempt++;
                    try {
                        await downloadWork.run(continuation, {
                            type: 'payload-download',
                            state: 'downloading',
                            stop: () => { try { if (ctl.proc) ctl.proc.kill(); } catch (_) {} }
                        }, () => runAria2Download(aria2, file, dir, opts, ctl, (p) => {
                            const sourceFraction = (resolvedIndex + (p.percent || 0) / 100) / sourceFiles.length;
                            const overall = Math.round(((sourceIndex + sourceFraction) / sourceTotal) * 100);
                            const progressState = p.phase === 'starting' ? 'starting' : 'downloading';
                            const retryLabel = expandedLabel + (attempt > 1 ? ' (retry ' + (attempt - 1) + ')' : '');
                            wc.send('download-progress', {
                                id, state: progressState, percent: overall, partPercent: p.percent,
                                part: sourceIndex + 1, partCount: sourceTotal, downloaded: p.downloaded, total: p.total,
                                speed: p.speed, eta: p.eta,
                                label: p.label || retryLabel
                            });
                        }));
                        await downloadJobDirectories.assertActive(continuation);
                        ok = true;
                        downloadedAny = true;
                    } catch (e) {
                        lastErr = e;
                        if (ctl.cancelled || ctl.paused || /cancelled|paused/i.test(e.message)) throw e;
                        if (file.requiresFreshVerification === true) {
                            cleanPartial(dir, file);
                            lastErr = Object.assign(new Error(
                                'FuckingFast\'s one-time link ended before the file completed. Sail stopped instead of reopening verification in a loop. Click Retry to request one fresh link, or choose another mirror.'
                            ), {
                                downloadUrl: file.origin || file.url || '',
                                needsBrowser: false
                            });
                            attempt = 3;
                            break;
                        }
                        if (e && e.aria2Code === 22 && file.origin && DL_MANAGED_RETRY_HOST.test(file.origin)) {
                            if (!shouldPreservePartialForRetry(file, e)) cleanPartial(dir, file);
                            wc.send('download-progress', {
                                id, state: 'resolving', part: sourceIndex + 1, partCount: sourceTotal, subLabel: '',
                                label: (expandedLabel ? expandedLabel + ' — ' : '') + 'Complete the host verification window to continue…'
                            });
                            let managed = null;
                            try {
                                managed = await runOwnedLinkResolution(signal => resolveDirectUrl(file.origin, {
                                    sourceId: opts.sourceId,
                                    referer: opts.referer,
                                    forceManagedBrowser: true,
                                    onProgress: label => reportResolutionProgress((expandedLabel ? expandedLabel + ' — ' : '') + label),
                                    signal
                                }));
                            } catch (managedError) {
                                if (ctl.cancelled || managedError && managedError.name === 'AbortError') throw managedError;
                                if (managedError && managedError.linkHealth === HEALTH_STATES.DOWN) throw managedError;
                            }
                            if (managed && managed.length) {
                                const next = managed[file.originIndex] || managed.find(item => item.name === file.name) || managed[0];
                                file = mergeRefreshedDownload(file, next);
                                continue;
                            }
                            lastErr = buildUnresolvedError(file.origin);
                            attempt = 3;
                        }
                        if (e && e.aria2Code === 3) {
                            e.linkHealth = HEALTH_STATES.DOWN;
                            e.needsBrowser = false;
                            e.downloadUrl = file.origin || file.url || '';
                            attempt = 3;
                        }
                        if (attempt < 3) {
                            const preservingPartial = shouldPreservePartialForRetry(file, e);
                            if (!preservingPartial) cleanPartial(dir, file);
                            wc.send('download-progress', {
                                id, state: 'resolving', part: sourceIndex + 1, partCount: sourceTotal, subLabel: '',
                                label: (expandedLabel ? expandedLabel + ' — ' : '') + (preservingPartial
                                    ? 'Connection lost — refreshing the BuzzHeavier link and resuming the saved partial…'
                                    : 'Connection lost, retrying with a fresh link...')
                            });
                            if (file.origin) {
                                try {
                                    const refreshed = await runOwnedLinkResolution(signal => resolveDirectUrl(file.origin, {
                                        sourceId: opts.sourceId,
                                        referer: opts.referer,
                                        onProgress: label => reportResolutionProgress((expandedLabel ? expandedLabel + ' — ' : '') + label),
                                        signal
                                    }));
                                    if (refreshed && refreshed.length) {
                                        const next = refreshed[file.originIndex] || refreshed.find(item => item.name === file.name) || refreshed[0];
                                        file = mergeRefreshedDownload(file, next);
                                    }
                                } catch (refreshError) {
                                    if (ctl.cancelled || refreshError && refreshError.name === 'AbortError') throw refreshError;
                                }
                            }
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        }
                    }
                }
                if (!ok) throw lastErr || new Error('Download failed');
            }
        }
        if (!downloadedAny) throw new Error('No usable download files were returned by this host.');

        if (coverDownload) {
            await downloadWork.run(continuation, { type: 'cover-download', state: 'downloading' }, async work => {
                await dlHttpToFile(coverDownload.url, coverDownload.destination).catch(() => {});
                await work.checkpoint();
            });
        }
        activeDownloads.delete(id);
        await downloadJobDirectories.setState(continuation, 'processing');
        wc.send('download-progress', { id, state: 'processing', label: 'Extracting & preparing game...' });
        try {
            const res = await postProcessDownload(continuation, dir, opts);
            await downloadJobDirectories.assertActive(continuation);
            if (ctl.cancelled) throw new Error('Cancelled');

            // Auto-install: FitGirl repacks come as setup.exe + .bin parts. If the
            // user has auto-install on, run the installer unattended into a clean folder,
            // then delete the repack source so only the playable game remains.
            if (res.needsInstall && res.exePath && opts.autoInstall !== false) {
                await downloadJobDirectories.setState(continuation, 'installing');
                const installTarget = installerTargetForDownload(dir, res.exePath);
                let polling = true;
                (async function pollSize() {
                    while (polling) {
                        let gb = 0;
                        try { gb = await preparedDirectorySize(installTarget, null) / (1024 * 1024 * 1024); } catch (e) {}
                        wc.send('download-progress', {
                            id, state: 'installing', percent: 100,
                            label: gb > 0.01
                                ? 'Installing game… ' + gb.toFixed(2) + ' GB written (this can take several minutes — keep the launcher open)'
                                : 'Installing game… preparing files (this can take several minutes — keep the launcher open)'
                        });
                        await new Promise(r => setTimeout(r, 2500));
                    }
                })();
                try {
                    wc.send('download-progress', { id, state: 'installing', percent: 100, label: 'Starting the installer — approve the Windows admin prompt if it appears…' });
                    // runSilentInstall now blocks until the orphaned InnoSetup child (setup.tmp)
                    // has fully exited, so the game files are already written when it returns.
                    const exe = await downloadWork.run(continuation, { type: 'installer', state: 'launching_installer' }, async work => {
                        await runSilentInstall(res.exePath, installTarget, ctl, opts.skipRedist !== false, work);
                        await work.checkpoint();
                        polling = false;
                        // A short settle catches any trailing writes (shortcuts, config) flushed in the
                        // last moment after the installer process exited.
                        await waitForDirSettle(installTarget, ctl, (sz) => {
                            const gb = sz / (1024 * 1024 * 1024);
                            wc.send('download-progress', { id, state: 'installing', percent: 100, label: 'Finishing up… ' + gb.toFixed(2) + ' GB installed' });
                        }, work);
                        await work.checkpoint();
                        // The exe occasionally lands a beat after the final byte — retry a couple times.
                        let found = (await scanDownloadedPayload(installTarget, opts.gameName, work)).exePath;
                        for (let t = 0; !found && t < 3; t++) {
                            await new Promise(r => setTimeout(r, 3000));
                            await work.checkpoint();
                            found = (await scanDownloadedPayload(installTarget, opts.gameName, work)).exePath;
                        }
                        if (found) {
                            await work.checkpoint();
                            await runDownloadPreparation('clean-repack-source', dir, work, { keepDir: installTarget });
                        }
                        return found;
                    });
                    if (exe) {
                        res.exePath = exe;
                        res.folder = installTarget;
                        res.needsInstall = false;
                        res.installed = true;
                    } else {
                        // Installer ran but we couldn't find a game exe — keep the repack so
                        // the user can install it manually; report it instead of faking success.
                        // Clear exePath so setup.exe is never handed back as the launch target.
                        res.installFailed = true;
                        res.exePath = '';
                    }
                } catch (instErr) {
                    polling = false;
                    if (ctl.cancelled || /cancelled/i.test(instErr.message)) throw instErr;
                    res.installFailed = true;
                    res.exePath = '';
                    res.installError = instErr.message;
                }
            }

            if (ctl.cancelled) throw new Error('Cancelled');
            if (!res.usable) {
                wc.send('download-error', {
                    id, url: opts.url, needsBrowser: true,
                    error: res.junk
                        ? 'The host returned a web page instead of the game file. Use "Open game page" to grab it manually.'
                        : 'Download finished but no game files were found.'
                });
                await retainDownloadJobError(continuation);
            } else {
                applyInstallerCompletionPolicy(res, opts);
                // Never persist a guessed path that no longer exists. Some pre-installed
                // archives (notably SteamGG) add a provider suffix to their root folder,
                // e.g. "Discounty - SteamGG.NET". Re-scan the final on-disk tree here so
                // the library receives the real path instead of a stale/predicted one.
                if (res.exePath && !fs.existsSync(res.exePath)) res.exePath = '';
                if (!res.exePath && !res.installFailed) {
                    const finalRoot = (res.folder && fs.existsSync(res.folder)) ? res.folder : dir;
                    try { res.exePath = (await scanDownloadedPayload(finalRoot, opts.gameName, null)).exePath || ''; } catch (e) {}
                    if (!res.exePath && finalRoot !== dir) {
                        try { res.exePath = (await scanDownloadedPayload(dir, opts.gameName, null)).exePath || ''; } catch (e) {}
                    }
                }
                if (ctl.cancelled) throw new Error('Cancelled');
                const completed = await finishDownloadJob(continuation, res, steamMetadataPromise);
                wc.send('download-complete', Object.assign({ id }, completed));
            }
        } catch (perr) {
            if (ctl.cancelled || /cancelled/i.test(perr.message)) throw perr;
            await retainDownloadJobError(continuation);
            wc.send('download-error', {
                id,
                error: 'The downloaded bytes could not be validated or prepared: ' + String(perr && perr.message || 'Unknown processing error')
            });
        }
        return { success: true };
    } catch (err) {
        clearTimeout(slowTimer);
        activeDownloads.delete(id);
        // Paused = a clean, resumable stop. Tell the renderer so it shows "Paused" + a Resume
        // button instead of an error, and keep the partial files on disk.
        if (ctl.paused || /paused/i.test(err.message)) {
            try { if (continuation) await downloadJobDirectories.setState(continuation, 'paused'); }
            catch (_) { return { success: false, stale: true }; }
            wc.send('download-progress', { id, state: 'paused', label: 'Paused' });
            return { success: false, paused: true };
        }
        if (ctl.cancelled || /cancelled/i.test(err.message)) return { success: false, cancelled: true };
        const errMsg = err.message;
        await retainDownloadJobError(continuation || job);
        const failedUrl = err.downloadUrl || opts.url || (opts.links && opts.links[0] && opts.links[0].url) || '';
        wc.send('download-error', {
            id,
            error: errMsg,
            url: failedUrl,
            needsBrowser: !!err.needsBrowser,
            linkHealth: err.linkHealth === HEALTH_STATES.DOWN ? HEALTH_STATES.DOWN : ''
        });
        return { success: false, error: errMsg };
    }
});

// Cancellation is registered from the shared production module so runtime tests execute
// the same ownership checks, control shutdown, bounded retries, and cleanup authority.
registerDownloadCancellationIpc(ipcMain, {
    registry: downloadJobDirectories,
    activeDownloads,
    pendingBrowserDownloads,
    browserIntents: browserDownloadIntents,
    onCleanupOutcome(job, outcome) {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-cancel-outcome', { id: job.id, ...outcome });
            }
        } catch (_) {}
    }
});
registerDownloadQuarantineIpc(ipcMain, { catalog: downloadQuarantineCatalog, shell });

// Pause = kill aria2 but keep the partial download + .aria2 control file so Resume can
// continue from where it stopped. Removed from activeDownloads; files stay on disk.
ipcMain.handle('pause-download', async (e, id) => {
    const d = activeDownloads.get(id);
    if (d && d.item) {
        d.paused = true;
        if (d.job) await downloadJobDirectories.setState(d.continuation || d.job, 'paused');
        try { d.item.pause(); return true; } catch (err) { return false; }
    }
    if (d) {
        d.paused = true;
        if (d.job) await downloadJobDirectories.setState(d.continuation || d.job, 'paused');
        try { d.proc && d.proc.kill(); } catch (err) {}
        activeDownloads.delete(id);
        return true;
    }
    return false;
});

// Clear cached data (Download settings → Clear Cache). Wipes the in-memory resolved
// debrid-link cache and the in-app browser's HTTP cache, so stale/expired links and pages
// are re-fetched fresh. Does NOT touch the user's settings, library, or downloaded games.
ipcMain.handle('get-download-cache-size', async () => {
    let bytes = 0;
    try { bytes += await session.defaultSession.getCacheSize(); } catch (e) {}
    try { bytes += Buffer.byteLength(JSON.stringify([...debridCache.entries()]), 'utf8'); } catch (e) {}
    return { bytes };
});

ipcMain.handle('clear-cache', async () => {
    const cleared = [];
    try { const n = debridCache.size; debridCache.clear(); cleared.push('resolved links (' + n + ')'); } catch (e) {}
    try { await session.defaultSession.clearCache(); cleared.push('browser cache'); } catch (e) {}
    try {
        await session.defaultSession.clearStorageData({ storages: ['cachestorage', 'shadercache', 'serviceworkers'] });
        cleared.push('web cache storage');
    } catch (e) {}
    return { success: true, cleared };
});

// Scan the common Windows save-game locations for a folder matching `gameName`.
// Called AFTER the user first plays & exits a downloaded game (saves don't exist at
// install time). `playedSince` (ms epoch, optional) prefers folders touched during/after
// the just-finished session. Returns the best-matching folder path, or null.
ipcMain.handle('scan-game-saves', async (_event, payload) => {
    const input = exactGateAPayload(payload, ['gameId', 'capabilityId', 'expectedRevision', 'playedSince'], 'Save discovery');
    const game = gateAProfileStore().activeGameMetadata(input.gameId);
    const resolved = gateAProfileStore().resolveExecutionCapability({
        gameId: input.gameId,
        capabilityId: input.capabilityId,
        expectedRevision: input.expectedRevision,
        operation: 'save-scan'
    });
    try {
        const candidates = await scanSaveCandidates({
            gameName: game.name,
            installRoot: resolved.details.workingDirectory || '',
            includeInstallRoot: true,
            customRoots: []
        });
        const playedSince = Number(input.playedSince) || 0;
        const recent = playedSince ? candidates.filter(item => new Date(item.modifiedAt).getTime() >= playedSince - 5 * 60 * 1000) : candidates;
        return { found: candidates.length > 0, count: candidates.length, recent: recent.length > 0 };
    } catch (error) { return { found: false, count: 0, recent: false }; }
});

ipcMain.handle('authority-get-device-root-status', (_event, payload) => {
    const input = exactGateAPayload(payload, ['kind'], 'Device root status');
    return gateAProfileStore().deviceRootStatus(input.kind);
});

ipcMain.handle('pick-download-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const capability = gateAProfileStore().createDeviceRootCapability('download-root', r.filePaths[0]);
    return { canceled: false, capability, label: path.basename(r.filePaths[0]) || 'Selected folder' };
});

const allowMultiInstance = process.env.SAIL_ALLOW_MULTI_INSTANCE === '1';
const gotTheLock = allowMultiInstance || app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();
else {
    app.setAppUserModelId("com.aseoriy.saillauncher");

    // Isolated verification instances must not replace the installed launcher's
    // sail-launcher:// registration while a source build is under test.
    if (!allowMultiInstance) {
        if (process.defaultApp) {
            app.setAsDefaultProtocolClient('sail-launcher', process.execPath, [path.resolve(process.argv[1])]);
        } else {
            app.setAsDefaultProtocolClient('sail-launcher');
        }
    }

    app.on('second-instance', (e, commandLine) => {
        // Check for sail-launcher:// protocol URL first
        const protocolUrl = commandLine.find(a => a.startsWith('sail-launcher://'));
        if (protocolUrl) {
            handleProtocolUrl(protocolUrl);
            return;
        }

        const newLaunchArg = commandLine.find(a => a.startsWith('--launch-game-id='));
        if (newLaunchArg) {
            BrowserWindow.getAllWindows()[0].webContents.send('shortcut-triggered', newLaunchArg.split('=')[1].replace(/"/g, ''));
        } else {
            if (BrowserWindow.getAllWindows().length > 0) {
                const mainWindow = BrowserWindow.getAllWindows()[0];
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
        }
    });

    ipcMain.handle('import-steam-games', async () => {
        return new Promise((resolve, reject) => {
            exec('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', (err, stdout) => {
                if (err) return resolve(gateAProfileStore().registerDiscoveredGames([], 'steam-import'));
                const match = stdout.match(/SteamPath\s+REG_SZ\s+(.*)/);
                if (!match) return resolve(gateAProfileStore().registerDiscoveredGames([], 'steam-import'));
                const steamPath = match[1].trim().replace(/\//g, '\\');
                const libraryFoldersPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');

                let libraryPaths = [steamPath];
                if (fs.existsSync(libraryFoldersPath)) {
                    const vdf = fs.readFileSync(libraryFoldersPath, 'utf8');
                    const paths = [...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map(m => m[1].replace(/\\\\/g, '\\'));
                    libraryPaths = [...new Set([...libraryPaths, ...paths])];
                }

                let games = [];
                libraryPaths.forEach(lib => {
                    const appsPath = path.join(lib, 'steamapps');
                    if (!fs.existsSync(appsPath)) return;
                    const files = fs.readdirSync(appsPath).filter(f => f.startsWith('appmanifest_') && f.endsWith('.acf'));
                    files.forEach(f => {
                        try {
                            const acf = fs.readFileSync(path.join(appsPath, f), 'utf8');
                            const nameMatch = acf.match(/"name"\s+"([^"]+)"/);
                            const idMatch = acf.match(/"appid"\s+"([^"]+)"/);
                            const dirMatch = acf.match(/"installdir"\s+"([^"]+)"/); // <-- We grab the folder name here

                            // AppID 228980 is Steamworks Common Redistributables, skip it
                            if (nameMatch && idMatch && dirMatch && idMatch[1] !== "228980") {

                                // Figure out exactly where the game folder is on this specific drive
                                const gameFolderPath = path.join(lib, 'steamapps', 'common', dirMatch[1]);

                                // Send in the detective to find the .exe!
                                const guessedExe = findBestExe(gameFolderPath, nameMatch[1]);

                                // Save it to the array
                                games.push({
                                    name: nameMatch[1],
                                    steamAppId: idMatch[1],
                                    executablePath: guessedExe || '',
                                    platform: 'steam'
                                });
                            }
                        } catch (e) { }
                    });
                });
                try { resolve(gateAProfileStore().registerDiscoveredGames(games, 'steam-import')); }
                catch (error) { reject(error); }
            });
        });
    });

    ipcMain.handle('import-epic-games', async () => {
        return new Promise((resolve) => {
            const manifestDir = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
            if (!fs.existsSync(manifestDir)) return resolve(gateAProfileStore().registerDiscoveredGames([], 'epic-import'));
            
            let games = [];
            const files = fs.readdirSync(manifestDir).filter(f => f.endsWith('.item'));
            files.forEach(f => {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(manifestDir, f), 'utf8'));
                    if (data.bIsApplication && data.InstallLocation && data.AppName && data.DisplayName) {
                        const exeName = data.LaunchExecutable || "";
                        const fullExePath = exeName ? path.join(data.InstallLocation, exeName) : findBestExe(data.InstallLocation, data.DisplayName);
                        
                        games.push({
                            name: data.DisplayName,
                            executablePath: fullExePath || '',
                            epicId: data.AppName,
                            platform: 'epic'
                        });
                    }
                } catch(e) {}
            });
            resolve(gateAProfileStore().registerDiscoveredGames(games, 'epic-import'));
        });
    });

    ipcMain.handle('import-gog-games', async () => {
        return new Promise((resolve, reject) => {
            exec('reg query "HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games" /s', (err, stdout) => {
                if (err) return resolve(gateAProfileStore().registerDiscoveredGames([], 'gog-import'));
                
                let games = [];
                const lines = stdout.split('\n');
                let currentGame = {};
                
                lines.forEach(line => {
                    const l = line.trim();
                    if (l.startsWith('HKEY_')) {
                        if (currentGame.name && currentGame.exePath) games.push({ name: currentGame.name, executablePath: currentGame.exePath, platform: 'gog' });
                        currentGame = {};
                    } else if (l.includes('gameName')) {
                        const match = l.match(/gameName\s+REG_SZ\s+(.*)/);
                        if (match) currentGame.name = match[1].trim();
                    } else if (l.includes('exe')) {
                        const match = l.match(/exe\s+REG_SZ\s+(.*)/);
                        if (match) currentGame.exePath = match[1].trim().replace(/\//g, '\\');
                    } else if (l.includes('path')) {
                        const match = l.match(/path\s+REG_SZ\s+(.*)/);
                        if (match) currentGame.path = match[1].trim().replace(/\//g, '\\');
                    }
                });
                
                if (currentGame.name && currentGame.exePath) {
                    if (currentGame.path && !path.isAbsolute(currentGame.exePath)) {
                        currentGame.exePath = path.join(currentGame.path, currentGame.exePath);
                    }
                    games.push({ name: currentGame.name, executablePath: currentGame.exePath, platform: 'gog' });
                }

                try { resolve(gateAProfileStore().registerDiscoveredGames(games, 'gog-import')); }
                catch (error) { reject(error); }
            });
        });
    });

    // Handle protocol URL on first launch (Windows)
    app.on('open-url', (e, url) => { e.preventDefault(); handleProtocolUrl(url); });

    app.commandLine.appendSwitch('enable-features', 'GamepadButtonAxisEvents');

    app.on('before-quit', () => {
        if (achievementService) achievementService.dispose();
        clearInterval(runtimeMonitorTimer);
        clearTimeout(deferredQuitTimer);
    });

    app.whenReady().then(() => {
        try { applyAdBlock(session.defaultSession); } catch (e) {}
        try { applyAdBlock(session.fromPartition(SOURCES_PARTITION)); } catch (e) {}
        runtimeRecovery = new RecoveryJournal(path.join(app.getPath('userData'), 'runtime', 'recovery.json'));
        accountServices = registerAccountIpc({
            app,
            ipcMain: electronIpcMain,
            safeStorage,
            authorizeIpcEvent,
            dialog,
            validateSteamAppId: isLocallyInstalledSteamAppId,
            onSessionChanged: notifySailHubGuestAuthChange
        });
        maintenanceService = registerMaintenanceIpc({
            app, ipcMain: electronIpcMain, BrowserWindow, dialog, shell,
            findExecutable: findBestExe, authorizeIpcEvent,
            profileStore: accountServices.profileStore
        });
        achievementService = registerAchievementIpc({
            app, ipcMain: electronIpcMain, BrowserWindow, Notification, dialog, authorizeIpcEvent,
            profileStore: accountServices.profileStore,
            resolveSteamInstallation: resolveLocallyInstalledSteamAppId
        });
        createWindow();
        startRuntimeMonitor();
        tray = new Tray(path.join(__dirname, 'icon.ico'));
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Open Sail Launcher', click: () => BrowserWindow.getAllWindows()[0].show() },
            { label: 'Quit', click: () => requestApplicationQuit() }
        ]);
        tray.setToolTip('Sail Launcher');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => BrowserWindow.getAllWindows()[0].show());

        // Handle protocol URL if app was launched via it
        const protocolArg = process.argv.find(a => a.startsWith('sail-launcher://'));
        if (protocolArg) handleProtocolUrl(protocolArg);
    });
}
