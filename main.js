const { app, BrowserWindow, ipcMain, dialog, shell, screen, Tray, Menu, session } = require('electron');
const { exec, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const unrar = require('node-unrar-js');
const _7z = require('7zip-min');
try {
    const sevenZipBin = require('7zip-bin');
    const pathTo7zip = sevenZipBin.path7za.replace('app.asar', 'app.asar.unpacked');
    _7z.config({ binaryPath: pathTo7zip });
} catch (e) {
    console.error('Failed to configure 7zip-min path:', e);
}
const DiscordRPC = require('discord-rpc');
const cloudSync = require('./cloudSync');
const args = process.argv;
let autoLaunchGameId = null;
const launchArg = args.find(a => a.startsWith('--launch-game-id='));
if (launchArg) autoLaunchGameId = launchArg.split('=')[1].replace(/"/g, '');

const startHidden = args.includes('--hidden');
let activeBackupProcess = null;
let backingUpZipPath = null;
let tray = null;
let isQuitting = false;
let exitSynced = false;

let exitWhenClosedSetting = false;
let devToolsEnabled = false;
ipcMain.on('set-exit-behavior', (e, val) => exitWhenClosedSetting = val);
ipcMain.on('set-devtools-setting', (e, val) => devToolsEnabled = val);

let currentInstallerMute = true;
ipcMain.on('toggle-installer-mute', (e, state) => {
    currentInstallerMute = !!state;
    try { require('fs').writeFileSync(require('path').join(app.getPath('userData'), '.installer_mute'), state ? '1' : '0'); } catch(e) {}
});

// --- DISCORD RPC ENGINE (WITH RETRY SYSTEM) ---
const clientId = '1486922616701849700';
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
            instance: false,
        } : {
            details: 'Browsing Library',
            state: 'Looking for something to play',
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
            try { stat = fs.statSync(full); } catch(e) { continue; }
            
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

// --- LAUNCH SPLASH SCREEN ---
ipcMain.on('show-launch-splash', (e, gameName) => {
    const splash = new BrowserWindow({
        width: 350, height: 80, frame: false, transparent: true, alwaysOnTop: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    const html = `
        <div style="background: rgba(24, 24, 27, 0.95); border: 1px solid #a855f7; border-radius: 12px; height: 100%; display: flex; align-items: center; justify-content: center; color: #fafafa; font-family: 'Segoe UI', sans-serif; font-weight: bold; box-sizing: border-box; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
            🚀 Launching ${gameName}...
        </div>
    `;
    splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    setTimeout(() => { if (!splash.isDestroyed()) splash.close(); }, 2500);
});

function createWindow() {
    const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');
    let state = { width: 1300, height: 850 };
    try { if (fs.existsSync(windowStatePath)) state = JSON.parse(fs.readFileSync(windowStatePath, 'utf8')); } catch (e) { }

    const win = new BrowserWindow({
        width: state.width, height: state.height, x: state.x, y: state.y, frame: false, titleBarStyle: 'hidden', transparent: true,
        icon: path.join(__dirname, 'icon.ico'),
        show: !startHidden,
        webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false, webviewTag: true }
    });

    const saveBounds = () => {
        if (!win.isMaximized() && !win.isMinimized()) {
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

    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return;
        }
        if (!url.startsWith('https://sailhub.fyi')) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    win.webContents.on('will-frame-navigate', (event) => {
        const url = event.url;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return;
        }
        if (!event.isMainFrame && !url.startsWith('https://sailhub.fyi')) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return { action: 'allow' };
        }
        if (!url.startsWith('https://sailhub.fyi')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
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

    win.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        const url = details.url.toLowerCase();
        const shouldBlock = adBlockList.some(domain => url.includes(domain));
        if (shouldBlock) {
            callback({ cancel: true });
        } else {
            callback({ cancel: false });
        }
    });

    win.loadFile('index.html');

    win.webContents.session.on('will-download', (event, item, webContents) => {
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
    });

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

    win.on('close', (event) => {
        if (!isQuitting && !exitWhenClosedSetting) {
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
}

// NEW: Restart App Hook
ipcMain.on('restart-app', () => {
    app.relaunch();
    app.exit(0);
});

ipcMain.handle('get-user-data', () => app.getPath('userData'));
ipcMain.handle('get-auto-launch', () => autoLaunchGameId);

ipcMain.handle('search-steam-workshop', async (e, appId, query, page = 1) => {
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
            res.on('data', (chunk) => { chunks.push(chunk); });
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
                    resolve(items);
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

ipcMain.handle('download-workshop-item', async (e, appId, itemId) => {
    return new Promise((resolve) => {
        const steamCmdDir = path.join(app.getPath('userData'), 'steamcmd');
        const steamCmdExe = path.join(steamCmdDir, 'steamcmd.exe');
        
        if (!fs.existsSync(steamCmdDir)) fs.mkdirSync(steamCmdDir, { recursive: true });

        const runSteamCmd = () => {
            const child = spawn(steamCmdExe, ['+login', 'anonymous', '+workshop_download_item', appId, itemId, '+quit']);
            
            child.on('close', (code) => {
                if (code === 0 || code === 7) { // 7 is usually a success code in steamcmd indicating it needs a restart or finished with minor warnings
                    const downloadPath = path.join(steamCmdDir, 'steamapps', 'workshop', 'content', appId, itemId);
                    resolve({ success: true, path: downloadPath });
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

ipcMain.handle('create-shortcut', (e, gameId, gameName, gameExePath, shortcutIcon) => {
    const desktop = app.getPath('desktop');
    const shortcutPath = path.join(desktop, `${gameName.replace(/[<>:"/\\|?*]+/g, '')}.lnk`);
    const ext = path.extname(gameExePath).toLowerCase();

    let iconToUse = gameExePath;
    if (shortcutIcon) { iconToUse = shortcutIcon; }
    else if (ext === '.bat' || ext === '.cmd' || ext === '.lnk') { iconToUse = process.execPath; }

    shell.writeShortcutLink(shortcutPath, 'create', {
        target: process.execPath,
        args: `--launch-game-id="${gameId}"`,
        description: `Launch ${gameName}`,
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
        { label: '🗑️ Delete Game', click: () => e.sender.send('context-delete-game', index) }
    ]);
    menu.popup(BrowserWindow.fromWebContents(e.sender));
});

ipcMain.handle('get-running-exes', () => {
    return new Promise(resolve => {
        // Use tasklist with CSV format and no headers
        exec('tasklist /FO CSV /NH', (err, stdout) => {
            if (err) return resolve([]);
            const exes = stdout.split('\n').map(line => {
                // Regex to match CSV parts properly even if they contain commas
                const matches = line.match(/"([^"]*)"/);
                return matches ? matches[1].toLowerCase() : '';
            }).filter(Boolean);
            resolve([...new Set(exes)]);
        });
    });
});

ipcMain.handle('check-backup-running', () => activeBackupProcess !== null);

ipcMain.handle('check-backup', (e, exePath, gameName) => {
    if (!exePath || activeBackupProcess !== null) return [];
    try {
        const backupDir = path.dirname(path.dirname(exePath));
        const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
        const prefix = `${safeName}_backup_`;

        if (!fs.existsSync(backupDir)) return [];

        let backups = fs.readdirSync(backupDir)
            .filter(f => f.startsWith(prefix) && f.endsWith('.zip'))
            .map(f => {
                let dateStr = f.replace(prefix, '').replace('.zip', '');
                let parsedDate = null;
                if (dateStr.length === 19) {
                    const year = dateStr.slice(0, 4);
                    const month = dateStr.slice(5, 7);
                    const day = dateStr.slice(8, 10);
                    const hour = dateStr.slice(11, 13);
                    const min = dateStr.slice(14, 16);
                    parsedDate = `${year}-${month}-${day} ${hour}:${min}`;
                }
                return { filename: f, date: parsedDate || dateStr, fullPath: path.join(backupDir, f) };
            })
            .sort((a, b) => b.filename.localeCompare(a.filename)); // newest first

        const oldZipPath = path.join(backupDir, `${safeName} backup.zip`);
        if (fs.existsSync(oldZipPath)) {
            backups.push({ filename: `${safeName} backup.zip`, date: 'Legacy Backup', fullPath: oldZipPath });
        }

        return backups;
    } catch (err) { return []; }
});

ipcMain.handle('backup-game', async (e, exePath, gameName) => {
    return new Promise((resolve) => {
        const gameDir = path.dirname(exePath);
        const backupDir = path.dirname(gameDir);
        const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        backingUpZipPath = path.join(backupDir, `${safeName}_backup_${timestamp}.zip`);

        if (fs.existsSync(backingUpZipPath)) fs.unlinkSync(backingUpZipPath);
        activeBackupProcess = spawn('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path "${gameDir}\\*" -DestinationPath "${backingUpZipPath}" -Force`]);
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

            resolve(code === 0 ? backingUpZipPath : null);
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

ipcMain.handle('restore-backup', async (e, exePath, gameName, backupFilename) => {
    return new Promise((resolve) => {
        const gameDir = path.dirname(exePath);
        const backupDir = path.dirname(gameDir);
        const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
        const zipPath = backupFilename ? path.join(backupDir, backupFilename) : path.join(backupDir, `${safeName} backup.zip`);

        if (!fs.existsSync(zipPath)) return resolve(false);
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${gameDir}" -Force`]);
        child.on('close', (code) => resolve(code === 0));
    });
});

ipcMain.handle('open-backup-folder', (e, exePath, gameName) => {
    try {
        const backupDir = path.dirname(path.dirname(exePath));
        if (fs.existsSync(backupDir)) {
            shell.openPath(backupDir);
            return true;
        }
    } catch (err) { }
    return false;
});

ipcMain.handle('delete-backup', (e, exePath, gameName, backupFilename) => {
    try {
        const backupDir = path.dirname(path.dirname(exePath));
        const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
        const zipPath = backupFilename ? path.join(backupDir, backupFilename) : path.join(backupDir, `${safeName} backup.zip`);
        if (fs.existsSync(zipPath)) { fs.unlinkSync(zipPath); return true; }
    } catch (err) { }
    return false;
});

// --- SAVE VERSIONING (Google Drive sync) ---
ipcMain.handle('zip-save-to-drive', async (e, localSavePath, driveFolder, gameName, maxVersions) => {
    return new Promise((resolve) => {
        try {
            const cleanName = gameName.replace(/[<>:"/\\|?*]+/g, '');
            const savesDir = path.join(os.homedir(), 'SailLauncherSaves', cleanName, 'Saves');
            if (!fs.existsSync(savesDir)) fs.mkdirSync(savesDir, { recursive: true });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const zipName = `${cleanName}_save_${timestamp}.zip`;
            const zipPath = path.join(savesDir, zipName);

            const child = spawn('powershell.exe', ['-NoProfile', '-Command',
                `Compress-Archive -Path "${localSavePath}\\*" -DestinationPath "${zipPath}" -Force`
            ]);
            child.on('close', (code) => {
                if (code === 0 && maxVersions > 0) {
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
                resolve(code === 0);
            });
        } catch (err) { resolve(false); }
    });
});

ipcMain.handle('list-save-versions', (e, driveFolder, gameName) => {
    try {
        const cleanName = gameName.replace(/[<>:"/\\|?*]+/g, '');
        const savesDir = path.join(os.homedir(), 'SailLauncherSaves', cleanName, 'Saves');
        if (!fs.existsSync(savesDir)) return [];
        const prefix = `${cleanName}_save_`;
        return fs.readdirSync(savesDir)
            .filter(f => f.startsWith(prefix) && f.endsWith('.zip'))
            .map(f => {
                let dateStr = f.replace(prefix, '').replace('.zip', '');
                let parsedDate = null;
                if (dateStr.length === 19) {
                    parsedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(5, 7)}-${dateStr.slice(8, 10)} ${dateStr.slice(11, 13)}:${dateStr.slice(14, 16)}`;
                }
                return { filename: f, date: parsedDate || dateStr, fullPath: path.join(savesDir, f) };
            })
            .sort((a, b) => b.filename.localeCompare(a.filename)); // newest first
    } catch (err) { return []; }
});

ipcMain.handle('restore-save-version', async (e, driveFolder, gameName, localSavePath, saveFilename) => {
    return new Promise((resolve) => {
        try {
            const cleanName = gameName.replace(/[<>:"/\\|?*]+/g, '');
            const savesDir = path.join(os.homedir(), 'SailLauncherSaves', cleanName, 'Saves');
            const zipPath = saveFilename ? path.join(savesDir, saveFilename) : null;

            if (!zipPath || !fs.existsSync(zipPath)) return resolve(false);
            const child = spawn('powershell.exe', ['-NoProfile', '-Command',
                `Expand-Archive -Path "${zipPath}" -DestinationPath "${localSavePath}" -Force`
            ]);
            child.on('close', (code) => resolve(code === 0));
        } catch (err) { resolve(false); }
    });
});

ipcMain.handle('open-save-versions-folder', (e, driveFolder, gameName) => {
    try {
        const cleanName = gameName.replace(/[<>:"/\\|?*]+/g, '');
        const savesDir = path.join(os.homedir(), 'SailLauncherSaves', cleanName, 'Saves');
        if (fs.existsSync(savesDir)) { shell.openPath(savesDir); return true; }
    } catch (err) { }
    return false;
});

// --- CLOUD SYNC IPC HANDLERS ---
ipcMain.handle('cloud-link-account', async (e, { provider, customCreds }) => {
    let authUrl = '';
    if (provider === 'google') authUrl = cloudSync.googleDrive.getAuthUrl(customCreds);
    else if (provider === 'onedrive') authUrl = cloudSync.oneDrive.getAuthUrl(customCreds);
    else if (provider === 'dropbox') authUrl = cloudSync.dropbox.getAuthUrl(customCreds);
    else return { success: false, error: 'Unknown provider' };

    // Start local server
    const serverPromise = cloudSync.startOauthServer();
    
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
            contextIsolation: true
        }
    });
    
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
        return status;
    } catch(e) {
        return {};
    }
});

ipcMain.handle('cloud-upload-save', async (e, { provider, gameName, localZipPath, maxVersions, customCreds, subFolder }) => {
    try {
        if (provider === 'google') await cloudSync.googleDrive.uploadFile(customCreds, gameName, localZipPath, maxVersions, subFolder);
        else if (provider === 'onedrive') await cloudSync.oneDrive.uploadFile(customCreds, gameName, localZipPath, maxVersions, subFolder);
        else if (provider === 'dropbox') await cloudSync.dropbox.uploadFile(customCreds, gameName, localZipPath, maxVersions, subFolder);
        else if (provider === 'mediafire') await cloudSync.mediaFire.uploadFile(gameName, localZipPath);
        else return { success: false, error: 'Unknown provider' };
        return { success: true };
    } catch(err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cloud-list-versions', async (e, { provider, gameName, customCreds, subFolder }) => {
    try {
        let versions = [];
        if (provider === 'google') versions = await cloudSync.googleDrive.listFiles(customCreds, gameName, subFolder);
        else if (provider === 'onedrive') versions = await cloudSync.oneDrive.listFiles(customCreds, gameName, subFolder);
        else if (provider === 'dropbox') versions = await cloudSync.dropbox.listFiles(customCreds, gameName, subFolder);
        else if (provider === 'mediafire') versions = await cloudSync.mediaFire.listFiles(gameName);
        return { success: true, versions };
    } catch(err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cloud-download-save', async (e, { provider, fileId, localZipPath, customCreds }) => {
    try {
        if (provider === 'google') await cloudSync.googleDrive.downloadFile(customCreds, fileId, localZipPath);
        else if (provider === 'onedrive') await cloudSync.oneDrive.downloadFile(customCreds, fileId, localZipPath);
        else if (provider === 'dropbox') await cloudSync.dropbox.downloadFile(customCreds, fileId, localZipPath);
        else if (provider === 'mediafire') await cloudSync.mediaFire.downloadFile(fileId, localZipPath);
        else return { success: false, error: 'Unknown provider' };
        return { success: true };
    } catch(err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cloud-zip-folder', async (e, { localSavePath, zipPath }) => {
    return new Promise((resolve) => {
        try {
            const child = spawn('powershell.exe', ['-NoProfile', '-Command',
                `Compress-Archive -Path "${localSavePath}\\*" -DestinationPath "${zipPath}" -Force`
            ]);
            child.on('close', (code) => resolve(code === 0));
        } catch(e) { resolve(false); }
    });
});

ipcMain.handle('cloud-extract-zip', async (e, { zipPath, localSavePath }) => {
    return new Promise((resolve) => {
        try {
            const child = spawn('powershell.exe', ['-NoProfile', '-Command',
                `Expand-Archive -Path "${zipPath}" -DestinationPath "${localSavePath}" -Force`
            ]);
            child.on('close', (code) => resolve(code === 0));
        } catch(e) { resolve(false); }
    });
});

ipcMain.on('window-min', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window-max', (e) => { const win = BrowserWindow.fromWebContents(e.sender); if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('window-close', (e, exitWhenClosed) => {
    if (exitWhenClosed) { isQuitting = true; app.quit(); }
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
    
    if (displayId) {
        const display = screen.getAllDisplays().find(d => d.id == displayId);
        if (display) {
            win.setBounds(display.bounds);
        }
    }
    
    // Toggle fullscreen after moving
    win.setFullScreen(!win.isFullScreen());
});

ipcMain.on('restart-app', () => {
    app.relaunch();
    app.quit();
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
    return new Promise((resolve, reject) => {
        const cmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destPath}' -Force"`;
        exec(cmd, { windowsHide: true }, (err) => { if (err) reject(err); else resolve(true); });
    });
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

ipcMain.handle('open-url', (e, url) => shell.openExternal(url));
ipcMain.handle('show-item-in-folder', (e, itemPath) => shell.showItemInFolder(itemPath));

ipcMain.handle('kill-process', (e, targetExeName) => exec(`taskkill /F /T /IM "${targetExeName}"`));

let ludusaviManifestCache = null;

async function getLudusaviManifest() {
    if (ludusaviManifestCache) return ludusaviManifestCache;
    
    const manifestPath = path.join(app.getPath('userData'), 'ludusavi_manifest.json');
    
    try {
        if (fs.existsSync(manifestPath)) {
            const stats = fs.statSync(manifestPath);
            const ageDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
            if (ageDays < 7) {
                ludusaviManifestCache = fs.readJsonSync(manifestPath);
                return ludusaviManifestCache;
            }
        }
    } catch(e) {}
    
    try {
        const res = await fetch('https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.json');
        if (res.ok) {
            const json = await res.json();
            fs.writeJsonSync(manifestPath, json);
            ludusaviManifestCache = json;
            return json;
        }
    } catch(e) {
        console.error("Ludusavi fetch error:", e);
    }
    
    if (fs.existsSync(manifestPath)) {
        ludusaviManifestCache = fs.readJsonSync(manifestPath);
        return ludusaviManifestCache;
    }
    return null;
}

function resolveLudusaviPath(rawPath) {
    let p = rawPath;
    p = p.replace(/<winAppData>/gi, process.env.APPDATA || '');
    p = p.replace(/<winLocalAppData>/gi, process.env.LOCALAPPDATA || '');
    p = p.replace(/<winDocuments>/gi, path.join(process.env.USERPROFILE || '', 'Documents'));
    p = p.replace(/<winPublic>/gi, 'C:\\Users\\Public');
    p = p.replace(/<winProgramData>/gi, process.env.PROGRAMDATA || '');
    p = p.replace(/<winDir>/gi, process.env.windir || '');
    p = p.replace(/<winProfile>/gi, process.env.USERPROFILE || '');
    p = p.replace(/<osUserName>/gi, process.env.USERNAME || '');
    p = p.replace(/\//g, '\\');
    return p;
}

ipcMain.handle('detect-saves-ludusavi', async (e, gameName) => {
    const manifest = await getLudusaviManifest();
    if (!manifest) return { success: false, error: "Failed to download Ludusavi database." };
    
    const gameKey = Object.keys(manifest).find(k => k.toLowerCase() === gameName.toLowerCase());
    if (!gameKey) return { success: true, paths: [] };
    
    const gameData = manifest[gameKey];
    if (!gameData.files) return { success: true, paths: [] };
    
    const dirs = new Set();
    for (const rawPath of Object.keys(gameData.files)) {
        if (!rawPath.toLowerCase().includes('<win') && !rawPath.toLowerCase().includes('<os')) continue;
        
        let resolved = resolveLudusaviPath(rawPath);
        let dirPath = resolved;
        if (resolved.includes('*')) {
            dirPath = resolved.substring(0, resolved.indexOf('*'));
        }
        
        dirPath = path.normalize(dirPath).replace(/\\$/, '');
        
        try {
            if (fs.existsSync(dirPath)) {
                if (fs.statSync(dirPath).isDirectory()) dirs.add(dirPath);
                else dirs.add(path.dirname(dirPath));
            } else {
                dirs.add(path.dirname(dirPath));
            }
        } catch(e) {
            dirs.add(path.dirname(dirPath));
        }
    }
    
    return { success: true, paths: [...dirs] };
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

ipcMain.handle('run-script', (e, scriptPath) => runScript(scriptPath, false));

ipcMain.handle('launch-game', async (e, { exePath, steamAppId, runAsAdmin, highPriority, launchArgs, preLaunchScript, postLaunchScript, companionApp }) => {


    // 2. Fallback to prevent crashes if exePath is completely missing
    if (!exePath) return { pid: null, exeName: 'unknown', runAsAdmin: false, untrackable: true };

    // 3. Normal launch logic for pirated/custom games
    const exeName = path.basename(exePath).toLowerCase();
    const ext = path.extname(exePath).toLowerCase();

    // ... (Leave preLaunchScript, companionApp, and everything below this exactly as is)

    if (companionApp) {
        try {
            if (companionApp.toLowerCase().endsWith('.exe')) {
                const comp = spawn(companionApp, [], { cwd: path.dirname(companionApp), detached: true, stdio: 'ignore' });
                comp.unref();
            } else { shell.openPath(companionApp); }
        } catch (err) { console.log("Companion launch failed", err); }
    }

    return new Promise(async (resolve) => {
        if (runAsAdmin) {
            const argsString = launchArgs ? `-ArgumentList '${launchArgs}'` : '';
            spawn('powershell.exe', ['-Command', `Start-Process -FilePath "${exePath}" ${argsString} -WorkingDirectory "${path.dirname(exePath)}" -Verb RunAs`]);
            resolve({ pid: null, exeName: exeName, runAsAdmin: true });
        } else if ((ext === '.lnk' || ext === '.bat' || ext === '.cmd') && !launchArgs) {
            await shell.openPath(exePath);
            resolve({ pid: null, exeName: exeName, runAsAdmin: false, untrackable: true });
        } else {
            const argsArray = launchArgs ? launchArgs.split(' ') : [];
            const gameProcess = spawn(exePath, argsArray, { cwd: path.dirname(exePath), stdio: 'ignore' });

            if (highPriority && gameProcess.pid) {
                exec(`wmic process where processid=${gameProcess.pid} CALL setpriority 128`, () => { });
            }

            gameProcess.on('close', () => {
                if (postLaunchScript) runScript(postLaunchScript, false);
                e.sender.send('game-closed', gameProcess.pid);
            });
            resolve({ pid: gameProcess.pid, exeName: exeName, runAsAdmin: false });
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

// IPC handler to download a file from a URL to the user's themes/plugins folder
ipcMain.handle('hub-download-file', async (e, { fileUrl, type }) => {
    const userDataPath = app.getPath('userData');
    const targetDir = path.join(userDataPath, type === 'theme' ? 'themes' : 'plugins');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const fileName = decodeURIComponent(fileUrl.split('/').pop().split('?')[0]);
    const filePath = path.join(targetDir, fileName);

    return new Promise((resolve, reject) => {
        const client = fileUrl.startsWith('https') ? https : http;
        const file = fs.createWriteStream(filePath);
        client.get(fileUrl, (response) => {
            // Follow redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close();
                fs.unlinkSync(filePath);
                return resolve(ipcMain.handle('hub-download-file', e, { fileUrl: response.headers.location, type }));
            }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve({ success: true, path: filePath, fileName }); });
        }).on('error', (err) => { fs.unlink(filePath, () => { }); reject(err.message); });
    });
});

// --- Game Download Sources: fetch raw HTML with a browser-like User-Agent ---
// Used by the "Download" tab scrapers (SteamRIP / FitGirl / Online-Fix / DODI).
// Routed through the main process so we can set a desktop UA, follow redirects,
// and sidestep renderer CORS / Cloudflare fetch fingerprinting.
function fetchSourceHtml(url, redirects = 0) {
    return new Promise((resolve) => {
        if (redirects > 6) return resolve({ ok: false, status: 0, html: '', error: 'Too many redirects' });
        let client;
        try {
            client = url.startsWith('https') ? https : http;
        } catch (e) {
            return resolve({ ok: false, status: 0, html: '', error: 'Bad URL' });
        }
        const req = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': url
            },
            timeout: 20000
        }, (response) => {
            // Follow redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                let loc = response.headers.location;
                try { loc = new URL(loc, url).href; } catch (e) {}
                return resolve(fetchSourceHtml(loc, redirects + 1));
            }
            let data = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, html: data, finalUrl: url });
            });
        });
        req.on('error', (err) => resolve({ ok: false, status: 0, html: '', error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, html: '', error: 'Request timed out' }); });
    });
}

ipcMain.handle('scrape-fetch', async (e, url) => {
    try {
        return await fetchSourceHtml(url);
    } catch (err) {
        return { ok: false, status: 0, html: '', error: err.message };
    }
});

// ============================================================
//  Game Download Engine — aria2 + link resolver + post-process
// ============================================================
const ARIA2_DL_URL = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip';
const DL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let aria2BinPath = null;
const activeDownloads = new Map(); // id -> { proc, dir, meta }

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
// hosts that are legitimate download targets — never treat these as ads
const DL_HOST_ALLOW = /(gofile|pixeldrain|datanodes|fuckingfast|1fichier|mediafire|mega\.nz|megadb|qiwi|multiup|bowfile|hexload|vikingfile|rootz|akirabox|filekeeper|filecrypt|online-fix|steamrip|fitgirl|dodi|rutor\.info)/i;
function isAdHost(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
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

// Render a page in a hidden Chromium window so Cloudflare / DDoS-Guard JS
// challenges are solved automatically, and so login cookies from the in-app
// browser (same default session) carry over (e.g. Online-Fix). Returns the
// fully-rendered HTML.
function renderPageHtml(url, { timeout = 45000 } = {}) {
    return new Promise((resolve) => {
        let done = false, win = null, poll = null;
        const finish = (val) => {
            if (done) return; done = true;
            clearTimeout(timer); if (poll) clearInterval(poll);
            try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
            resolve(val);
        };
        const timer = setTimeout(() => finish({ ok: false, status: 0, html: '', error: 'render timeout' }), timeout);
        try {
            // backgroundThrottling:false is REQUIRED — otherwise the hidden window's
            // timers are throttled and Cloudflare's JS challenge never completes.
            win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, backgroundThrottling: false } });
        } catch (e) { return finish({ ok: false, status: 0, html: '', error: e.message }); }
        try { applyAdBlock(win.webContents.session); } catch (e) {}
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const isChallenge = (html) => /just a moment|checking your browser|cf-browser-verification|challenge-platform|_cf_chl|enable javascript and cookies|verifying you are human|attention required|ddos-guard/i.test(html);
        const tryGrab = async () => {
            if (done || !win || win.isDestroyed()) return;
            let html = '';
            try { html = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true); } catch (e) { return; }
            // the window may have been destroyed (timeout/finish) while we awaited
            if (done || !win || win.isDestroyed()) return;
            if (!html || html.length < 800) return;
            if (isChallenge(html) && html.length < 80000) return; // wait for challenge to clear
            let finalUrl = url;
            try { finalUrl = win.webContents.getURL(); } catch (e) {}
            finish({ ok: true, status: 200, html, finalUrl });
        };
        win.webContents.on('did-finish-load', () => setTimeout(tryGrab, 1200));
        poll = setInterval(tryGrab, 2000);
        win.loadURL(url, { userAgent: DL_UA }).catch(() => {});
    });
}
ipcMain.handle('scrape-render', async (e, url) => {
    try { return await renderPageHtml(url); }
    catch (err) { return { ok: false, status: 0, html: '', error: err.message }; }
});

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

function sanitizeName(name) {
    return (name || '').replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || ('game_' + Date.now());
}

function getDownloadsRoot(custom) {
    const root = (custom && custom.trim()) ? custom : path.join(app.getPath('userData'), 'SailDownloads');
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    return root;
}

// --- Host scrapers (pure HTTP — ported from Black-Pearl) ---------------------
// These resolve a file-host page link directly into a downloadable URL via the
// host's own API/redirect, WITHOUT opening a browser, so the resolver can never
// "catch an ad". Each returns an array of { url, kind, headers?, name? } or null.

// Generic HTTP request with optional body and redirect control. Returns
// { status, headers, body }. follow:false lets callers read 3xx Location headers.
function dlRequest(method, url, { headers, body, follow = true } = {}, _depth = 0) {
    return new Promise((resolve, reject) => {
        if (_depth > 6) return reject(new Error('Too many redirects'));
        let u; try { u = new URL(url); } catch (e) { return reject(e); }
        const client = u.protocol === 'https:' ? https : http;
        const opts = { method, headers: Object.assign({ 'User-Agent': DL_UA, 'Accept': '*/*' }, headers || {}) };
        const req = client.request(u, opts, (res) => {
            if (follow && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let loc = res.headers.location; try { loc = new URL(loc, url).href; } catch (e) {}
                res.resume(); return resolve(dlRequest(method, loc, { headers, body, follow }, _depth + 1));
            }
            let data = ''; res.setEncoding('utf8');
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(25000, () => req.destroy(new Error('timeout')));
        if (body) req.write(body);
        req.end();
    });
}
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GOFILE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0';

// GoFile: guest token + a computed (NOT scraped) X-Website-Token SHA256 header.
async function scrapeGofile(rawUrl) {
    const contentId = rawUrl.split('?')[0].split('/').filter(Boolean).pop();
    if (!contentId) return null;
    const xbl = 'en';
    const acc = await dlRequest('POST', 'https://api.gofile.io/accounts', { headers: { 'User-Agent': GOFILE_UA, 'Content-Length': '0' } });
    let token = null; try { const j = JSON.parse(acc.body); if (j.status === 'ok') token = j.data.token; } catch (e) {}
    if (!token) return null;
    const timeSlot = Math.floor(Date.now() / 1000 / 14400);
    const xwt = crypto.createHash('sha256').update(`${GOFILE_UA}::${xbl}::${token}::${timeSlot}::5d4f7g8sd45fsd`).digest('hex');
    const res = await dlRequest('GET', `https://api.gofile.io/contents/${contentId}`, {
        headers: { 'User-Agent': GOFILE_UA, 'Authorization': 'Bearer ' + token, 'X-BL': xbl, 'X-Website-Token': xwt }
    });
    let info = null; try { info = JSON.parse(res.body); } catch (e) {}
    if (!info || info.status !== 'ok' || !info.data) return null;
    const dlHeaders = [`Cookie: accountToken=${token}`, `User-Agent: ${GOFILE_UA}`, `Accept: */*`, `Referer: https://gofile.io/`];
    const d = info.data, out = [];
    if (d.type === 'file' && d.link) out.push({ url: d.link, name: d.name, kind: 'http', headers: dlHeaders });
    if (d.type === 'folder' && d.children) {
        for (const k in d.children) { const c = d.children[k]; if (c && c.type === 'file' && c.link) out.push({ url: c.link, name: c.name, kind: 'http', headers: dlHeaders }); }
    }
    return out.length ? out : null;
}
async function scrapePixeldrain(rawUrl, referer) {
    // The /api/file/{id}?download endpoint serves the file directly. Pixeldrain's
    // hotlink protection rejects a FOREIGN Referer (e.g. steamgg.net) → 403 → aria2
    // exit 22. Sending pixeldrain's OWN domain as the Referer always passes the check,
    // so we use that regardless of the embedding site.
    const headers = ['Referer: https://pixeldrain.com/', 'User-Agent: ' + CHROME_UA];
    const probeHeaders = { 'User-Agent': CHROME_UA, 'Referer': 'https://pixeldrain.com/' };

    // Pixeldrain "list" links (/l/{id}) are albums/folders holding every part of the
    // game. SteamGG posts these a lot — expand the list into its individual files.
    const lm = rawUrl.match(/pixeldrain\.com\/l\/([a-zA-Z0-9_-]+)/i) || rawUrl.match(/\/api\/list\/([a-zA-Z0-9_-]+)/i);
    if (lm) {
        try {
            const res = await dlRequest('GET', `https://pixeldrain.com/api/list/${lm[1]}`, { headers: probeHeaders });
            let data = null; try { data = JSON.parse(res.body); } catch (e) {}
            const files = (data && Array.isArray(data.files)) ? data.files : [];
            const out = [];
            for (const f of files.filter(f => f && f.id)) {
                const direct = `https://pixeldrain.com/api/file/${f.id}?download`;
                const prox = await pixeldrainProxyUrl(direct);
                out.push({ url: prox || direct, name: f.name || '', kind: 'http', headers });
            }
            if (out.length) return out;
        } catch (e) {}
        return null;
    }

    // Single file: /u/{id}, /d/{id} or /api/file/{id}
    const m = rawUrl.match(/\/(?:u|d|api\/file)\/([a-zA-Z0-9_-]+)/i);
    if (!m) return null;
    const direct = `https://pixeldrain.com/api/file/${m[1]}?download`;
    // Route through a randomly-chosen Cloudflare Worker proxy when one is configured:
    // the fetch then originates from Cloudflare's IP (not the user's), transparently
    // bypassing pixeldrain's 10GB/day per-IP cap. pixeldrainProxyUrl HEAD-probes the
    // chosen worker and falls back to the next; null means every worker was dead.
    const prox = await pixeldrainProxyUrl(direct);
    if (prox) return [{ url: prox, kind: 'http', headers }];
    // No (working) proxy → go direct, but verify the file is actually servable BEFORE
    // handing it to aria2. When this IP has hit Pixeldrain's free transfer cap, the API
    // answers 403 / 429 with a body like {success:false,value:"file_rate_limited_captcha_required"}
    // — that needs a human captcha on the website and can't be bypassed here. Detect it and
    // bail cleanly (a HEAD request never buffers the multi-GB body) so the user gets a clear message.
    try {
        const chk = await dlRequest('HEAD', direct, { headers: probeHeaders, follow: false });
        if (chk.status === 403 || chk.status === 429 || /captcha|rate.?limited|too.?many/i.test(chk.body || '')) return null;
    } catch (e) { /* network hiccup — let aria2 try the link anyway */ }
    return [{ url: direct, kind: 'http', headers }];
}
async function scrapeDatanodes(rawUrl) {
    // the file code is the FIRST path segment (an extra /filename.bin may follow)
    const idm = rawUrl.match(/datanodes\.\w+\/([a-z0-9]+)/i);
    const fileId = idm ? idm[1] : rawUrl.split('?')[0].split('/').filter(Boolean)[0];
    if (!fileId) return null;
    const form = new URLSearchParams({ op: 'download2', id: fileId, rand: '', referer: `https://datanodes.to/${fileId}`, method_free: 'Free Download >>', __dl: '1' }).toString();
    const res = await dlRequest('POST', 'https://datanodes.to/download', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': 'lang=english', 'Referer': `https://datanodes.to/${fileId}`, 'X-Requested-With': 'XMLHttpRequest' }, body: form, follow: false });
    // datanodes either returns JSON {url} or a 302 Location to the file CDN
    let data = null; try { data = JSON.parse(res.body); } catch (e) {}
    if (data && data.url) return [{ url: decodeURIComponent(data.url), kind: 'http' }];
    const loc = res.headers['location'];
    if (loc && /^https?:\/\//i.test(loc) && !/datanodes\.\w+\/?$/i.test(loc)) return [{ url: loc, kind: 'http' }];
    return null;
}
async function scrapeBuzzheavier(rawUrl) {
    const u = new URL(rawUrl);
    const domain = u.origin;
    const cleanUrl = u.origin + u.pathname.replace(/\/$/, '');
    // Fast path: plain HTTP (works only if Cloudflare isn't challenging this request).
    try {
        const page = await dlRequest('GET', cleanUrl, { headers: { 'User-Agent': CHROME_UA, 'Referer': domain } });
        if (page.status < 400 && /hx-get/i.test(page.body)) {
            const hxAll = [...page.body.matchAll(/hx-get\s*=\s*"([^"]+)"/gi)].map(m => m[1]);
            const endpoint = hxAll.find(h => /\/download\?t=/i.test(h)) || hxAll.find(h => /\/download/i.test(h)) || '';
            if (endpoint) {
                const full = endpoint.startsWith('http') ? endpoint : domain + endpoint;
                const resp = await dlRequest('GET', full, { headers: { 'hx-current-url': cleanUrl, 'hx-request': 'true', 'referer': cleanUrl, 'User-Agent': CHROME_UA }, follow: false });
                const direct = resp.headers['hx-redirect'] || resp.headers['location'];
                if (direct) return [{ url: direct.startsWith('http') ? direct : domain + direct, kind: 'http' }];
            }
        }
    } catch (e) {}
    // Otherwise it's behind Cloudflare's interactive "verify you are human" (Turnstile)
    // challenge, which genuinely can't be solved automatically (it needs a human click).
    // Return null fast; the handler shows an accurate, host-specific message.
    return null;
}
async function scrapeFuckingfast(rawUrl) {
    const u = new URL(rawUrl);
    const cleanUrl = u.origin + u.pathname.replace(/\/$/, '');
    // current layout: the direct dl.fuckingfast.co link is embedded in the page JS
    try {
        const page = await dlRequest('GET', cleanUrl, { headers: { 'User-Agent': CHROME_UA } });
        const m = page.body.match(/https:\/\/dl\.fuckingfast\.co\/dl\/[^"'\s)]+/);
        if (m) {
            // grab the real filename from the page so aria2 saves it correctly
            const tm = page.body.match(/<title>\s*([^<]+?)\s*<\/title>/i);
            const name = tm && /\.(rar|zip|7z|bin|iso|exe)/i.test(tm[1]) ? tm[1].trim() : '';
            // token links are single-use → force a single connection so aria2 never
            // needs to "resume" on a consumed token (which causes exit code 8)
            return [{ url: m[0], kind: 'http', maxConn: 1, name }];
        }
    } catch (e) {}
    // fallback: older HEAD /download → hx-redirect/location
    const resp = await dlRequest('HEAD', cleanUrl + '/download', { headers: { 'hx-current-url': cleanUrl, 'hx-request': 'true', 'referer': cleanUrl, 'User-Agent': CHROME_UA }, follow: false });
    const hx = resp.headers['hx-redirect']; if (hx) return [{ url: hx.startsWith('http') ? hx : u.origin + hx, kind: 'http' }];
    const loc = resp.headers['location']; if (loc) return [{ url: loc.startsWith('http') ? loc : u.origin + loc, kind: 'http' }];
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
    const u = new URL(rawUrl);
    const segs = u.pathname.split('/').filter(Boolean);
    const code = segs[0];
    if (!code) return null;
    const name = segs.length > 1 ? decodeURIComponent(segs[segs.length - 1]) : '';
    const form = new URLSearchParams({ op: 'download2', id: code, rand: '', referer: '', method_free: '', down_direct: '1' }).toString();
    const resp = await dlRequest('POST', rawUrl, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CHROME_UA, 'Referer': rawUrl },
        body: form, follow: false
    });
    const loc = resp.headers['location'];
    if (loc && /^https?:\/\//i.test(loc)) return [{ url: loc, kind: 'http', name }];
    const m = (resp.body || '').match(/https?:\/\/[^"'\s<>]+\/download\/[^"'\s<>]+/i);
    if (m) return [{ url: m[0], kind: 'http', name }];
    return null;
}
// Generic XFileSharing-style host (megadb.net etc.): GET the page, look for a
// direct link, else submit the op=download2 form. Best-effort (these hosts are
// often Cloudflare-gated); returns null cleanly on failure instead of hanging.
async function scrapeXFS(rawUrl) {
    const u = new URL(rawUrl);
    const page = await dlRequest('GET', rawUrl, { headers: { 'User-Agent': CHROME_UA, 'Referer': u.origin } });
    const findDirect = (html) => {
        let m = html.match(/href="(https?:\/\/[^"]+\/d\/[^"]+)"/i)
            || html.match(/(https?:\/\/[a-z0-9.\-]+\/(?:files?|d|dl|download)\/[^"'\s<>]+\.(?:rar|zip|7z|bin|iso)[^"'\s<>]*)/i)
            || html.match(/href="(https?:\/\/[^"]+\.(?:rar|zip|7z|bin|iso)(?:\?[^"]*)?)"/i);
        return m ? (m[1] || m[0]) : null;
    };
    let direct = findDirect(page.body);
    if (direct) return [{ url: direct, kind: 'http' }];
    // collect the download form's hidden fields and re-POST as op=download2
    const fields = {};
    const inputRe = /<input[^>]*name=["']([^"']+)["'][^>]*?value=["']([^"']*)["']/gi;
    let im; while ((im = inputRe.exec(page.body))) fields[im[1]] = im[2];
    if (!fields.id) { const idm = rawUrl.match(/\/([a-z0-9]{8,})/i); if (idm) fields.id = idm[1]; }
    if (!fields.id) return null;
    fields.op = 'download2';
    fields.method_free = fields.method_free || 'Free Download';
    fields.down_direct = '1';
    const cookies = (page.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const resp = await dlRequest('POST', rawUrl, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CHROME_UA, 'Referer': rawUrl, 'Cookie': cookies },
        body: new URLSearchParams(fields).toString(), follow: false
    });
    const loc = resp.headers['location'];
    if (loc && /^https?:\/\//i.test(loc) && /\.(rar|zip|7z|bin|iso)/i.test(loc)) return [{ url: loc, kind: 'http' }];
    direct = findDirect(resp.body || '');
    return direct ? [{ url: direct, kind: 'http' }] : null;
}

// rutor.info — Russian torrent tracker. Fetch the torrent page, pull the magnet link
// (preferred, works without downloading a .torrent file), or fall back to the direct
// torrent download URL. Direct /download/{id} links are returned as-is.
async function scrapeRutor(rawUrl) {
    if (/(?:d\.)?rutor\.info\/download\/\d+/i.test(rawUrl)) return [{ url: rawUrl, kind: 'http' }];
    const res = await dlRequest('GET', rawUrl, { headers: { 'User-Agent': CHROME_UA } });
    if (!res || !res.body) return null;
    const magnet = res.body.match(/href="(magnet:\?[^"]+)"/i);
    if (magnet) return [{ url: magnet[1], kind: 'magnet' }];
    const dl = res.body.match(/href="((?:https?:\/\/d\.rutor\.info)?\/download\/\d+[^"]*)"/i);
    if (dl) {
        const u = dl[1].startsWith('http') ? dl[1] : 'http://d.rutor.info' + dl[1];
        return [{ url: u, kind: 'http' }];
    }
    return null;
}

// VikingFile (vikingfile.com) — common on SteamGG/FitGirl mirrors. The download page
// has no static file anchor; clicking "Download" POSTs the file hash to the site API,
// which returns the direct server URL. We replicate that POST over plain HTTP (no
// browser, no ads). Tries several endpoint/field/response shapes since the site has
// changed its API over time; returns null cleanly so the caller can fall back.
async function scrapeVikingfile(rawUrl) {
    let u; try { u = new URL(rawUrl); } catch (e) { return null; }
    const origin = u.origin; // e.g. https://vikingfile.com
    const segs = u.pathname.split('/').filter(Boolean);
    let hash = segs.length ? segs[segs.length - 1] : '';   // …/f/<hash>
    let page = '';
    try {
        const res = await dlRequest('GET', rawUrl, { headers: { 'User-Agent': CHROME_UA, 'Referer': origin } });
        page = res.body || '';
    } catch (e) {}
    // 1) a full direct server link already sitting in the page / inline JS
    let m = page.match(/https?:\\?\/\\?\/[a-z0-9.\-]*vikingfile\.com\\?\/download\\?\/[^"'\s<>\\]+/i);
    if (m) return [{ url: m[0].replace(/\\\//g, '/'), kind: 'http' }];
    // pull the hash from a hidden input / JS var if the URL didn't carry it
    const hm = page.match(/name=["']hash["'][^>]*value=["']([^"']+)["']/i)
        || page.match(/id=["']hash["'][^>]*value=["']([^"']+)["']/i)
        || page.match(/["']?hash["']?\s*[:=]\s*["']([a-z0-9]{6,})["']/i);
    if (hm) hash = hm[1];
    if (!hash) return null;
    // best-effort filename for aria2
    let name = '';
    const nm = page.match(/<title>\s*([^<]+?)\s*<\/title>/i);
    if (nm && /\.(rar|zip|7z|bin|iso|exe)/i.test(nm[1])) name = nm[1].replace(/\s*[\-|–·].*$/, '').trim();
    const pickUrl = (resp) => {
        if (!resp) return '';
        let data = null; try { data = JSON.parse(resp.body); } catch (e) {}
        const cand = data && (data.url || data.link || data.download || data.direct);
        if (cand && /^https?:\/\//i.test(cand)) return cand;
        const tm = (resp.body || '').match(/https?:\/\/[^\s"'<>]+/i);
        if (tm && /vikingfile\.com\/download\//i.test(tm[0])) return tm[0];
        const loc = resp.headers && resp.headers['location'];
        if (loc && /^https?:\/\//i.test(loc)) return loc;
        return '';
    };
    // 2) POST the hash to the download API (try the known endpoints / field names)
    const attempts = [
        { ep: origin + '/api/download', body: { hash } },
        { ep: origin + '/download', body: { hash } },
        { ep: origin + '/api/get-url', body: { hash } }
    ];
    for (const a of attempts) {
        try {
            const resp = await dlRequest('POST', a.ep, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CHROME_UA, 'Referer': rawUrl, 'Origin': origin, 'X-Requested-With': 'XMLHttpRequest' },
                body: new URLSearchParams(a.body).toString(), follow: false
            });
            const url = pickUrl(resp);
            if (url) return [{ url, kind: 'http', name }];
        } catch (e) {}
    }
    return null;
}

// Resolve a (possibly indirect) link into one or more concrete files aria2 can
// fetch. ALWAYS returns an array of { url, kind, headers?, name? } or null.
// Host-specific HTTP scrapers run first (no browser → no ads); a single Gofile
// folder can expand into several part files. Browser intercept is the last resort.
// Hosts that have a dedicated scraper. If one of these fails we must NOT fall
// through to the "direct archive" check (their page URLs often end in .bin/.rar
// and would otherwise download the HTML landing page) nor to the browser (which
// hangs on their JS/captcha). We just report failure so the user can pick another host.
const DL_KNOWN_HOST = /gofile|pixeldrain\.(com|net|in|nl|biz|tech|dev)|datanodes|fuckingfast\.(co|net)|mediafire|megadb|filekeeper/i;

// Per-source Referer to spoof when a host applies hotlink protection.
const SOURCE_REFERER = { steamgg: 'https://steamgg.net/' };

// ===================================================================
// PixelDrain Cloudflare-Worker proxy pool + Debrid services
// (config is pushed from the renderer via the IPC handlers below)
// ===================================================================
// Built-in Worker pool — used whenever the user hasn't configured their own in
// Download Settings. These bypass pixeldrain's 10GB/day per-IP cap by fetching from
// Cloudflare's IP. Rewriting through one of these is the whole point of the proxy, so
// we default to them rather than ever handing aria2 a bare pixeldrain.com URL.
const DEFAULT_PIXELDRAIN_PROXIES = [
    'https://saillauncher.alissatorz.workers.dev',
    'https://saillauncher2.alissatorz.workers.dev',
    'https://saillauncher3.alissatorz.workers.dev',
    'https://saillauncher4.alissatorz.workers.dev',
];
let pixeldrainProxies = DEFAULT_PIXELDRAIN_PROXIES.slice(); // list of Worker base URLs, e.g. https://xyz.workers.dev
ipcMain.on('set-pixeldrain-proxies', (e, list) => {
    const cleaned = Array.isArray(list)
        ? list.map(u => String(u || '').trim()).filter(u => /^https?:\/\//i.test(u))
        : [];
    // An empty/invalid push (e.g. the renderer sending defaults on startup) must NOT
    // wipe the built-in pool — fall back to the defaults so pixeldrain always proxies.
    pixeldrainProxies = cleaned.length ? cleaned : DEFAULT_PIXELDRAIN_PROXIES.slice();
});

// Wrap a direct pixeldrain API url through a RANDOMLY chosen Worker proxy so the
// download originates from Cloudflare's IP (bypassing the 10GB/day per-IP cap).
// NO blocking liveness probe: a HEAD probe that timed out/failed on the very first
// click used to make this return null → aria2 hit pixeldrain DIRECTLY (4xx/5xx),
// while the second click "worked" because the worker was warm by then. Instead we
// shuffle and return a worker IMMEDIATELY — the rewrite is the whole point, and
// aria2's own retry/failover handles a truly dead worker. Returns null only when
// the pool is literally empty (which, with DEFAULT_PIXELDRAIN_PROXIES, never happens).
function pixeldrainProxyUrl(directUrl) {
    const pool = (pixeldrainProxies || []).slice();
    if (!pool.length) return null; // no workers configured → fall back to direct pixeldrain
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    const wrap = (base) => base.replace(/\/+$/, '') + '/?url=' + encodeURIComponent(directUrl);
    return wrap(pool[0]);
}

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
    payload = payload || {};
    const service = payload.service, key = payload.key;
    if (!service || !key || !DEBRID[service]) return { ok: false, error: 'Unknown service' };
    try { const r = await DEBRID[service].validate(key); return r || { ok: false }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

async function resolveDirectUrl(rawUrl, opts) {
    opts = opts || {};
    const referer = opts.referer || SOURCE_REFERER[opts.sourceId] || '';
    if (!rawUrl) return null;
    if (rawUrl.startsWith('magnet:') || /\.torrent(\?|#|$)/i.test(rawUrl)) return [{ url: rawUrl, kind: rawUrl.startsWith('magnet:') ? 'magnet' : 'http' }];
    // BuzzHeavier is removed entirely — its Cloudflare "verify you are human" check can't be
    // passed automatically, and even a debrid service (TorBox/etc.) can't resolve it. Bail
    // before debrid/scrapers so it's never attempted.
    if (/buzzheavier|bzzhr/i.test(rawUrl)) return null;
    // Debrid FIRST — before any host gives up. When a service is connected it unlocks the
    // link server-side, which bypasses the Cloudflare / captcha / download restrictions on
    // EVERY filehost (GoFile, 1Fichier, Rapidgator, AND the CF-interactive ones below like
    // AkiraBox, DataNodes, BuzzHeavier). So we try debrid on every http filehost link, not
    // just ones we already know are "free". pixeldrain keeps its own Worker-proxy pool, and
    // magnets/torrents are handled above. On any failure we fall through to the old behaviour.
    if (debridActive() && /^https?:/i.test(rawUrl) && !/pixeldrain/i.test(rawUrl)) {
        const dr = await debridUnrestrict(rawUrl);
        if (dr && dr.url) return [{ url: dr.url, kind: 'http', name: dr.name || '' }];
    }
    // CF-interactive hosts that can't be auto-resolved WITHOUT debrid — bail now (after the
    // debrid attempt above) instead of spending 30+ s in the browser interceptor before failing.
    if (/akirabox\.(com|to)/i.test(rawUrl)) return null;
    // 1337x is a Cloudflare-gated torrent index (no direct file link); browse-only.
    if (/1337x\.[a-z]+/i.test(rawUrl)) return null;
    if (DL_KNOWN_HOST.test(rawUrl)) {
        let r = null;
        try {
            if (/gofile/i.test(rawUrl)) r = await scrapeGofile(rawUrl);
            else if (/pixeldrain/i.test(rawUrl)) r = await scrapePixeldrain(rawUrl, referer);
            else if (/datanodes/i.test(rawUrl)) r = await scrapeDatanodes(rawUrl);
            else if (/fuckingfast\.(co|net)/i.test(rawUrl)) r = await scrapeFuckingfast(rawUrl);
            else if (/mediafire/i.test(rawUrl)) r = await scrapeMediafire(rawUrl);
            else if (/filekeeper/i.test(rawUrl)) r = await scrapeFilekeeper(rawUrl);
            else if (/megadb/i.test(rawUrl)) r = await scrapeXFS(rawUrl);
        } catch (e) { /* report failure below */ }
        return (r && r.length) ? r : null; // never fall through for a known host
    }
    // rutor.info — extract magnet/torrent link from the page. Falls through to the
    // browser interceptor if scraping fails.
    if (/rutor\.info/i.test(rawUrl)) {
        try { const r = await scrapeRutor(rawUrl); if (r && r.length) return r; } catch (e) {}
    }
    // VikingFile needs its own POST-to-API scrape. If that fails we deliberately DO
    // fall through to the browser interceptor below (unlike the known hosts above).
    if (/vikingfile\.com/i.test(rawUrl)) {
        try { const r = await scrapeVikingfile(rawUrl); if (r && r.length) return r; } catch (e) {}
    }
    // already a direct CDN archive / iso link
    if (/\.(zip|rar|7z|bin|iso)(\?|#|$)/i.test(rawUrl)) return [{ url: rawUrl, kind: 'http' }];
    // unknown host → last resort: load the page hidden and intercept the file download
    const intercepted = await interceptDownload(rawUrl);
    if (intercepted && intercepted.url) {
        const hdrs = (intercepted.headers && intercepted.headers.Cookie) ? ['Cookie: ' + intercepted.headers.Cookie] : null;
        return [{ url: intercepted.url, kind: intercepted.url.startsWith('magnet:') ? 'magnet' : 'http', headers: hdrs, name: intercepted.name }];
    }
    return null;
}

// Race the resolver across several mirror URLs that point at the SAME download
// (the same game hosted on different file-hosts). The first host to yield a usable
// direct link wins and the slower ones are abandoned — so a fast/cached mirror is
// used instantly instead of blocking on a slow or rate-limited primary host.
// Returns { files, origin } of the winning host, or null if every mirror failed.
function resolveFirstMirror(urls, opts) {
    const list = (urls || []).filter(Boolean);
    if (!list.length) return Promise.resolve(null);
    if (list.length === 1) return resolveDirectUrl(list[0], opts).then(r => (r && r.length) ? { files: r, origin: list[0] } : null);
    return new Promise((resolve) => {
        let pending = list.length, settled = false;
        for (const u of list) {
            resolveDirectUrl(u, opts).then(r => {
                if (settled) return;
                if (r && r.length) { settled = true; resolve({ files: r, origin: u }); }
                else if (--pending === 0) { settled = true; resolve(null); }
            }).catch(() => { if (!settled && --pending === 0) { settled = true; resolve(null); } });
        }
    });
}

// Build the user-facing "couldn't resolve" error for a host, with host-specific
// guidance. Shared by the normal and mirror-race resolution paths.
function buildUnresolvedError(url) {
    let host = 'this host'; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (er) {}
    let msg = 'Could not auto-resolve a direct link for ' + host + '. Use "Open game page" to download it manually.';
    if (/megadb/i.test(host)) msg = 'MegaDB requires a captcha that can\'t be bypassed automatically. Click "Open game page" and download it from the site.';
    else if (/pixeldrain/i.test(host)) msg = 'Pixeldrain is rate-limiting this connection (its free transfer cap / captcha). It\'s not a launcher bug — wait for the cap to reset, pick another host (FileKeeper / FuckingFast / Gofile), or use "Open game page" to solve the captcha on the site.';
    else if (/gofile/i.test(host)) msg = 'Gofile\'s API is temporarily unavailable (their servers, not the launcher). Try again in a minute, or pick another host.';
    else if (/datanodes/i.test(host)) msg = 'DataNodes is now behind a Cloudflare "verify you are human" check, so it can\'t download automatically. Pick another host (Pixeldrain / FileKeeper / FuckingFast), or use "Open game page".';
    else if (/akirabox/i.test(host)) msg = 'AkiraBox is behind a Cloudflare "verify you are human" check (a checkbox you have to click), so it can\'t download automatically. Pick another host (Pixeldrain / FileKeeper / FuckingFast), or use "Open game page".';
    else if (/buzzheavier|bzzhr/i.test(host)) msg = 'Buzzheavier is behind a Cloudflare "verify you are human" check (a checkbox you have to click), so it can\'t download automatically. Pick another host (Pixeldrain / FileKeeper / FuckingFast), or use "Open game page".';
    else if (/1337x/i.test(host)) msg = '1337x is a Cloudflare-protected torrent index, so it can\'t download automatically. Use "Open game page" / "Browse" to grab the torrent from the site.';
    return Object.assign(new Error(msg), { needsBrowser: true });
}

// Click script: find the real download control while skipping ad links. Prefers
// anchors that point at an actual file/known host; only then falls back to
// buttons/elements whose visible text is a download verb. Returns true if it
// clicked something plausible.
const INTERCEPT_CLICK_JS = `(function(){
    var FILE=/\\.(zip|rar|7z|bin|iso|exe|torrent|part\\d+)(\\?|#|$)/i;
    var HOST=/gofile|pixeldrain|datanodes|fuckingfast|1fichier|mediafire|mega(\\.nz|db)|qiwi|multiup|bowfile|hexload|vikingfile|rootz|akirabox|store\\d+\\.gofile/i;
    var AD=/a-ads|doubleclick|googlesyndication|adnxs|popads|propeller|exoclick|juicyads|adsterra|hilltop|clickadu|adcash|monetag|onclick(algo|performance)|realsrv|tsyndicate|\\/ads?\\//i;
    function vis(el){ try{ return el.offsetParent!==null && el.getClientRects().length>0; }catch(e){ return false; } }
    // 1) anchors to a real file or known host
    var as=[].slice.call(document.querySelectorAll('a[href]'));
    for(var i=0;i<as.length;i++){ var h=as[i].href||''; if(AD.test(h)) continue; if((FILE.test(h)||HOST.test(h)) && vis(as[i])){ as[i].click(); return true; } }
    // 2) explicit download controls (id/class)
    var sels=['#download','#downloadButton','#btndownload','#download-url','.download-btn','a.download','button.download','a#downloadB','.btn-download'];
    for(var j=0;j<sels.length;j++){ var el=document.querySelector(sels[j]); if(el && vis(el)){ el.click(); return true; } }
    // 3) buttons/links whose visible text is a download verb (not ads)
    var cand=[].slice.call(document.querySelectorAll('a,button,input[type=button],input[type=submit]'));
    for(var k=0;k<cand.length;k++){ var c=cand[k]; var t=((c.textContent||'')+' '+(c.value||'')).trim().toLowerCase(); var hh=c.href||''; if(AD.test(hh)) continue; if(/^(download|download now|free download|скачать|создать ссылку|get link|continue)$/.test(t) && vis(c)){ c.click(); return true; } }
    return false;
})();`;

// Open a host page invisibly, auto-click the real download control, and capture
// the resulting file download URL (+ cookies) without actually saving it here.
function interceptDownload(url, timeoutMs = 55000) {
    return new Promise((resolve) => {
        let done = false, win = null, clicker = null;
        const finish = (val) => {
            if (done) return; done = true;
            clearTimeout(timer); if (clicker) clearInterval(clicker);
            try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
            resolve(val);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        try {
            // default session (no partition) so Cloudflare clearance / site logins
            // from the in-app browser carry over; no throttling so challenges run
            win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, backgroundThrottling: false } });
        } catch (e) { return finish(null); }
        const sess = win.webContents.session;
        applyAdBlock(sess);
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // block ad popups
        // never let the page bounce the main frame onto an ad/redirect
        win.webContents.on('will-navigate', (e, navUrl) => { if (isAdHost(navUrl)) { try { e.preventDefault(); } catch (err) {} } });
        win.webContents.on('will-redirect', (e, navUrl) => { if (isAdHost(navUrl)) { try { e.preventDefault(); } catch (err) {} } });
        sess.on('will-download', (e, item) => {
            const fileUrl = item.getURL();
            let fname = '';
            try { fname = item.getFilename() || ''; } catch (err) {}
            // ignore ad/redirect/non-file payloads
            if (isAdHost(fileUrl) || /\.(html?|php)(\?|#|$)/i.test(fileUrl) || /^download$/i.test(fname)) { try { item.cancel(); } catch (err) {} return; }
            sess.cookies.get({ url }).then((cookies) => {
                const cookieHeader = (cookies || []).map(c => `${c.name}=${c.value}`).join('; ');
                try { item.cancel(); } catch (err) {}
                finish({ url: fileUrl, name: fname, headers: cookieHeader ? { Cookie: cookieHeader } : null });
            }).catch(() => { try { item.cancel(); } catch (err) {} finish({ url: fileUrl, name: fname, headers: null }); });
        });
        // retry clicking as the page/SPA settles (some hosts render the button late)
        const tryClick = () => { if (done || !win || win.isDestroyed()) return; win.webContents.executeJavaScript(INTERCEPT_CLICK_JS, true).catch(() => {}); };
        win.webContents.on('did-finish-load', () => setTimeout(tryClick, 1500));
        clicker = setInterval(tryClick, 3500);
        win.loadURL(url, { userAgent: DL_UA }).catch(() => finish(null));
    });
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
async function extractRar(archivePath, destDir) {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const extractor = await unrar.createExtractorFromFile({ filepath: archivePath, targetPath: destDir });
    // The files iterator is lazy — extraction only happens as it's consumed.
    const result = extractor.extract();
    let count = 0;
    for (const _f of result.files) count++;
    if (!count) throw new Error('node-unrar-js extracted 0 files (archive empty or split-volume missing parts)');
    return destDir;
}

function extractArchive(archivePath, destDir) {
    if (/\.rar$/i.test(archivePath)) {
        // RAR (incl. RAR5) — 7za can't do these at all; use node-unrar-js.
        return extractRar(archivePath, destDir).catch((e) => {
            console.error('[extract] unrar failed for', archivePath, '-', e && e.message);
            throw e;
        });
    }
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        // 7-Zip (bundled via 7zip-min) handles zip / 7z / split 7z/zip archives
        _7z.unpack(archivePath, destDir, (err) => {
            if (!err) return resolve(destDir);
            console.error('[extract] 7-Zip failed for', archivePath, '-', err && err.message);
            // For .zip, fall back to PowerShell's Expand-Archive: it unpacks some zips
            // (Zip64 / unusual metadata) that the bundled 7za rejects with "cannot open".
            if (/\.zip$/i.test(archivePath)) {
                const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
                const cmd = 'Expand-Archive -LiteralPath ' + psQuote(archivePath) + ' -DestinationPath ' + psQuote(destDir) + ' -Force';
                const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true });
                let errBuf = '';
                ps.stderr.on('data', (d) => { errBuf += d.toString(); });
                ps.on('error', () => reject(err));
                ps.on('close', (code) => {
                    if (code === 0) { console.error('[extract] Expand-Archive fallback succeeded for', archivePath); return resolve(destDir); }
                    const detail = errBuf.trim().split(/\r?\n/)[0] || ('exit ' + code);
                    reject(new Error('7-Zip: ' + (err && err.message || 'failed') + ' | Expand-Archive: ' + detail));
                });
            } else {
                reject(err);
            }
        });
    });
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

// Run a FitGirl / DODI (InnoSetup) installer unattended into targetDir. These repacks
// support InnoSetup's silent switches; /VERYSILENT skips the custom UI, /DIR sets the
// destination. The installer may still raise a single UAC prompt if it needs admin.
function runSilentInstall(installerPath, targetDir, ctl, skipExtras) {
    return new Promise((resolve, reject) => {
        try { if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
        // FitGirl/DODI installers require admin to install — a plain spawn (non-elevated)
        // exits instantly without installing anything. Launch ELEVATED via Start-Process
        // -Verb RunAs (one UAC prompt), wait for it, and capture the real exit code.
        //
        // skipExtras: /TASKS="" deselects every optional InnoSetup task (DirectX/VC++
        // redists, desktop shortcuts, "visit site" URL). Hard-wired [Run] steps can't be
        // overridden — those are baked into the repack.
        //
        // Audio: FitGirl/DODI installers play background music even under /VERYSILENT.
        // Rather than muting the WHOLE system, we mute ONLY the installer's own audio
        // session(s) — its process plus any children — via the per-app ISimpleAudioVolume
        // COM API, polling because the session appears a moment after launch. Nothing global
        // is touched, so the user's other audio keeps playing and there's nothing to restore.
        const extras = skipExtras ? ' /NOICONS /TASKS=""' : '';
        const innoArgs = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL /SP-' + extras;
        const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

        // Build a self-contained PS1 that handles mute + elevated run in one shot.
        // Written to a temp file to avoid command-line escaping of the here-string.
        const psLines = [
            'try {',
            '    Add-Type -TypeDefinition @"',
            'using System;',
            'using System.Runtime.InteropServices;',
            'using System.Collections.Generic;',
            '[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]',
            '[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
            '[ComImport]',
            'interface IMMDeviceEnumerator {',
            '    void EnumAudioEndpoints(int df, int sm, out IntPtr p);',
            '    void GetDefaultAudioEndpoint(int df, int role, out IMMDevice d);',
            '    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice d);',
            '    void RegisterEndpointNotificationCallback(IntPtr p);',
            '    void UnregisterEndpointNotificationCallback(IntPtr p);',
            '}',
            '[Guid("D666063F-1587-4E43-81F1-B948E807363F")]',
            '[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
            '[ComImport]',
            'interface IMMDevice {',
            '    void Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);',
            '    void OpenPropertyStore(uint a, [MarshalAs(UnmanagedType.Interface)] out object o);',
            '    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);',
            '    void GetState(out uint s);',
            '}',
            '[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]',
            '[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
            '[ComImport]',
            'interface IAudioSessionManager2 {',
            '    int NotImpl0();',
            '    int NotImpl1();',
            '    void GetSessionEnumerator(out IAudioSessionEnumerator e);',
            '}',
            '[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]',
            '[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
            '[ComImport]',
            'interface IAudioSessionEnumerator {',
            '    void GetCount(out int c);',
            '    void GetSession(int i, out IAudioSessionControl s);',
            '}',
            '[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]',
            '[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
            '[ComImport]',
            'interface IAudioSessionControl {',
            '    int N0(); int N1(); int N2(); int N3(); int N4();',
            '    int N5(); int N6(); int N7(); int N8();',
            '}',
            '[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]',
            '[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
            '[ComImport]',
            'interface IAudioSessionControl2 {',
            '    int C0(); int C1(); int C2(); int C3(); int C4();',
            '    int C5(); int C6(); int C7(); int C8();',
            '    int GetSessionIdentifier(out IntPtr s);',
            '    int GetSessionInstanceIdentifier(out IntPtr s);',
            '    int GetProcessId(out uint pid);',
            '}',
            '[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]',
            '[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
            '[ComImport]',
            'interface ISimpleAudioVolume {',
            '    void SetMasterVolume(float l, ref Guid g);',
            '    void GetMasterVolume(out float l);',
            '    void SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g);',
            '    void GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);',
            '}',
            '[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]',
            'class MDE {}',
            'public class AppMuter {',
            '    static IAudioSessionEnumerator Sessions() {',
            '        var e = (IMMDeviceEnumerator)(new MDE());',
            '        IMMDevice d; e.GetDefaultAudioEndpoint(0, 1, out d);',
            '        var iid = typeof(IAudioSessionManager2).GUID;',
            '        object o; d.Activate(ref iid, 23, IntPtr.Zero, out o);',
            '        var mgr = (IAudioSessionManager2)o;',
            '        IAudioSessionEnumerator se; mgr.GetSessionEnumerator(out se); return se;',
            '    }',
            '    public static int SetMute(uint[] pids, bool state) {',
            '        var set = new HashSet<uint>(pids); int n = 0;',
            '        IAudioSessionEnumerator se; try { se = Sessions(); } catch { return 0; }',
            '        int c; se.GetCount(out c);',
            '        for (int i = 0; i < c; i++) {',
            '            IAudioSessionControl ctl; try { se.GetSession(i, out ctl); } catch { continue; }',
            '            try {',
            '                var ctl2 = (IAudioSessionControl2)ctl;',
            '                uint pid; ctl2.GetProcessId(out pid);',
            '                if (set.Contains(pid)) { var v = (ISimpleAudioVolume)ctl; var g = Guid.Empty; v.SetMute(state, ref g); n++; }',
            '            } catch {}',
            '        }',
            '        return n;',
            '    }',
            '}',
            '"@',
            '} catch {}',
            '$ec = 0',
            '# Paths come in via environment variables (set by the Node spawn), NOT embedded in',
            '# this script. Windows passes env vars to the child as proper UTF-16, so non-ASCII',
            '# game-folder names survive intact. Embedding them in the .ps1 text would corrupt',
            '# them because Windows PowerShell 5.1 decodes a BOM-less script with the ANSI code',
            '# page, mangling any Unicode path -> Start-Process "file not found" -> LAUNCH_FAIL.',
            '$installer = $env:SAIL_INSTALLER',
            '$target = $env:SAIL_TARGET',
            '$innoArgs = $env:SAIL_ARGS',
            '$base = ""',
            'try { $base = [System.IO.Path]::GetFileNameWithoutExtension($installer) } catch {}',
            '# Snapshot installer-named processes that ALREADY exist so we never mistake an',
            '# unrelated "setup" for ours.',
            '$pre = @{}',
            'try { foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $base -ne "" -and $_.ProcessName -ieq $base })) { $pre[[int]$p.Id] = $true } } catch {}',
            'function Get-FolderSize($p) { try { return [double]((Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum) } catch { return [double]0 } }',
            'Write-Host ("LAUNCH base=" + $base + " installer=" + $installer + " target=" + $target)',
            '# Bail clearly if the installer path the renderer handed us does not actually exist',
            '# (avoids a cryptic ShellExecute failure and tells us WHICH path was wrong).',
            'if ([string]::IsNullOrEmpty($installer) -or -not (Test-Path -LiteralPath $installer)) { Write-Host ("LAUNCH_FAIL installer not found: " + $installer); exit 2 }',
            '# Launch the installer ELEVATED. Start-Process blocks on the UAC dialog, so by the',
            '# time it returns the prompt has already been answered. We do NOT rely on -PassThru',
            '# returning a usable object (it can be $null even on success) — instead the wait below',
            '# tracks the installer purely by process base name + folder growth.',
            '$proc = $null',
            'try {',
            '    $psi = New-Object System.Diagnostics.ProcessStartInfo',
            '    $psi.FileName = $installer',
            '    $psi.Arguments = $innoArgs + \' "/DIR=\' + $target + \'"\'',
            '    $psi.Verb = \'RunAs\'',
            '    $psi.UseShellExecute = $true',
            '    $psi.WorkingDirectory = [System.IO.Path]::GetDirectoryName($installer)',
            '    $proc = [System.Diagnostics.Process]::Start($psi)',
            '} catch { Write-Host ("LAUNCH_FAIL " + $_.Exception.Message); exit 1223 }',
            '$root = 0',
            'if ($proc -ne $null) { try { $root = [int]$proc.Id } catch { $root = 0 } }',
            'Write-Host ("ROOT=" + $root)',
            '# Phase 1 — startup grace: wait until the installer is observably working, i.e. a NEW',
            '# installer-named process appears OR the target folder starts growing. InnoSetup setup.exe',
            '# may relaunch itself as setup.tmp (same base name "setup"); either satisfies this.',
            '$startSize = Get-FolderSize $target',
            '$seen = $false',
            '$g = 0',
            'while ($g -lt 30) {',
            '    $act = @()',
            '    try { $act = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { ($root -ne 0 -and $_.Id -eq $root) -or ($base -ne "" -and $_.ProcessName -ieq $base -and -not $pre.ContainsKey([int]$_.Id)) }) } catch {}',
            '    if ($act.Count -gt 0) { $seen = $true; break }',
            '    if (((Get-FolderSize $target) - $startSize) -gt 2MB) { $seen = $true; break }',
            '    Start-Sleep -Milliseconds 1000',
            '    $g++',
            '}',
            'Write-Host ("PHASE1 seen=" + $seen)',
            '# Phase 2 — wait for completion. While ANY installer process is alive we keep waiting',
            '# (and mute its audio). Once none are alive we fall back to watching folder growth, so',
            '# even if process detection ever misses the orphaned child the trailing writes keep us',
            '# here. Done = sustained idle (no installer process AND no folder growth). Folder size is',
            '# only measured while no process is active, so the hot install loop stays cheap.',
            '$lastSize = Get-FolderSize $target',
            '$idle = 0',
            '$loops = 0',
            'while ($true) {',
            '    $act = @()',
            '    try { $act = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { ($root -ne 0 -and $_.Id -eq $root) -or ($base -ne "" -and $_.ProcessName -ieq $base -and -not $pre.ContainsKey([int]$_.Id)) }) } catch {}',
            '    if ($act.Count -gt 0) {',
            '        $seen = $true',
            '        $idle = 0',
            '        $ids = New-Object System.Collections.Generic.List[uint32]',
            '        foreach ($p in $act) { try { [void]$ids.Add([uint32]$p.Id) } catch {} }',
            '        $muteState = $true',
            '        try { if ((Get-Content -LiteralPath "$env:SAIL_MUTE_FLAG" -ErrorAction SilentlyContinue) -eq "0") { $muteState = $false } } catch {}',
            '        try { [void][AppMuter]::SetMute($ids.ToArray(), $muteState) } catch {}',
            '        if ($env:SAIL_SKIP_REDIST -eq "1") { try { Get-Process -Name "dxwebsetup", "vcredist*", "vc_redist*", "dotNetFx*", "dotnet*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }',
            '    } else {',
            '        $sz = Get-FolderSize $target',
            '        if (($sz - $lastSize) -gt 1MB) { $idle = 0 } else { $idle++ }',
            '        $lastSize = $sz',
            '    }',
            '    $need = 8',
            '    if ($seen) { $need = 6 }',
            '    if ($idle -ge $need) { break }',
            '    $loops++',
            '    if ($loops -gt 8000) { break }',
            '    Start-Sleep -Milliseconds 1000',
            '}',
            'Write-Host ("DONE size=" + $lastSize)',
            'if ($proc -ne $null) { try { $ec = $proc.ExitCode } catch { $ec = 0 } }',
            'if ($null -eq $ec) { $ec = 0 }',
            'exit $ec'
        ];
        // Fail fast (with a clear message) if the installer the caller handed us is missing,
        // rather than spawning PowerShell only to hit LAUNCH_FAIL.
        if (!installerPath || !fs.existsSync(installerPath)) {
            return reject(new Error('Installer not found: ' + installerPath));
        }
        const psScript = psLines.join('\r\n');
        const tmpFile = path.join(process.env.TEMP || process.env.TMP || path.dirname(installerPath), 'sail_inst_' + Date.now() + '.ps1');
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
            SAIL_MUTE_FLAG: path.join(app.getPath('userData'), '.installer_mute'),
            SAIL_SKIP_REDIST: skipExtras ? '1' : '0'
        });
        try { proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], { windowsHide: true, env: psEnv }); }
        catch (e) { try { fs.unlinkSync(tmpFile); } catch (er) {} return reject(e); }
        ctl.proc = proc;
        // Capture the watcher's diagnostic output (LAUNCH/ROOT/PHASE1/DONE lines). Mirrored to
        // the console AND a log file next to the install so a failed auto-install is debuggable.
        let psOut = '';
        try { proc.stdout && proc.stdout.on('data', d => { psOut += d.toString(); }); } catch (e) {}
        try { proc.stderr && proc.stderr.on('data', d => { psOut += d.toString(); }); } catch (e) {}
        proc.on('error', (e) => { try { fs.unlinkSync(tmpFile); } catch (er) {} reject(e); });
        proc.on('close', (code) => {
            try { fs.unlinkSync(tmpFile); } catch (er) {}
            try {
                const trimmed = psOut.trim();
                if (trimmed) console.log('[auto-install] ' + trimmed.replace(/\r?\n/g, ' | '));
                fs.writeFileSync(path.join(path.dirname(targetDir), '_sail_install_log.txt'),
                    '[' + new Date().toISOString() + '] exit=' + code + '\r\n' + psOut, 'utf8');
            } catch (e) {}
            if (ctl.cancelled) return reject(new Error('Cancelled'));
            if (code === 1223) return reject(new Error('Windows permission prompt was declined'));   // UAC cancelled
            resolve(code);
        });
    });
}

// FitGirl/DODI installers are InnoSetup bootstrappers: the setup.exe we launch often
// extracts a second installer to %TEMP%, hands off, and EXITS within a second — so the
// process we waited on is gone long before the game has finished being written. Polling
// the process tree alone declares "done" too early, we find no game exe, and the whole
// install is wrongly reported as failed. Instead, after the launched process exits, watch
// the destination folder and only consider the install finished once it has STOPPED
// growing for a sustained window (or nothing was ever written → genuinely failed).
function waitForDirSettle(dir, ctl, onTick) {
    return new Promise((resolve) => {
        const interval = 2500;          // poll cadence
        const stableMs = 9000;          // size must hold steady this long to count as done
        const graceZeroMs = 30000;      // if NOTHING is written within this, treat as failed
        const maxMs = 90 * 60 * 1000;   // hard ceiling (huge repacks can take a while)
        let last = -1, stableFor = 0, waited = 0;
        const tick = () => {
            if (ctl && ctl.cancelled) return resolve();
            let sz = 0; try { sz = dirSizeBytes(dir, 0); } catch (e) {}
            if (typeof onTick === 'function') { try { onTick(sz); } catch (e) {} }
            if (sz === 0) {
                if (waited >= graceZeroMs) return resolve();   // installer wrote nothing → give up
            } else if (last >= 0 && Math.abs(sz - last) < 1024 * 1024) {
                stableFor += interval;
                if (stableFor >= stableMs) return resolve();    // size held steady → install finished
            } else {
                stableFor = 0;
            }
            last = sz;
            waited += interval;
            if (waited >= maxMs) return resolve();
            setTimeout(tick, interval);
        };
        setTimeout(tick, interval);
    });
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

async function postProcessDownload(dir, opts) {
    const result = { gameName: opts.gameName, folder: dir, exePath: '', cover: '', extracted: false, usable: false, junk: false };
    // locate cover saved earlier
    try {
        const coverFile = fs.readdirSync(dir).find(f => /^_cover\./i.test(f));
        if (coverFile) result.cover = path.join(dir, coverFile);
    } catch (e) {}

    // Give extension-less downloads (debrid-resolved SteamRIP .zips, etc.) the right
    // archive extension by content, BEFORE we walk/detect — so they auto-extract.
    if (opts.autoExtract !== false) { try { normalizeArchiveExtensions(dir, 0); } catch (e) {} }

    // walk ALL payload files recursively (torrents/installers nest in a subfolder)
    const allFiles = [];
    (function walk(d, depth) {
        if (depth > 6) return;
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const en of ents) {
            const full = path.join(d, en.name);
            if (en.isDirectory()) { walk(full, depth + 1); continue; }
            if (/^_cover\./i.test(en.name)) continue;
            let size = 0; try { size = fs.statSync(full).size; } catch (e) {}
            allFiles.push({ name: en.name, full, size });
        }
    })(dir, 0);
    const archives = findArchives(dir);

    if (opts.autoExtract !== false && archives.length) {
        const extractTo = path.join(dir, '_game');
        let anyExtracted = false, extractErr = null;
        for (const arc of archives) {
            try { await extractArchive(arc, extractTo); result.extracted = true; anyExtracted = true; }
            catch (e) { extractErr = e; console.error('[postProcess] extraction failed for', arc, '-', e && e.message); /* leave archive in place */ }
        }
        // Strip SteamRIP/pre-installed filler (readme, .url shortcut, _CommonRedist) so the
        // library folder is just the game. Runs before findGameExe so a redist installer
        // exe can't be mistaken for the game.
        if (result.extracted) { try { cleanExtractedJunk(extractTo, opts.skipRedist !== false); } catch (e) {} }
        // Extraction was attempted but every archive failed → tell the user why instead of
        // silently reporting success with the un-extracted archive sitting in the folder.
        if (!anyExtracted && extractErr) result.warning = 'Auto-extract failed: ' + extractErr.message + ' The archive is in the game folder — extract it manually.';
        if (result.extracted) result.exePath = findGameExe(extractTo, opts.gameName) || findGameExe(dir, opts.gameName) || '';
        // CRITICAL: the file list above was captured BEFORE extraction, so it only knew about
        // the archives (now deleted). A repack can ship setup.exe + fg-*.bin INSIDE that archive
        // (FitGirl/DODI sometimes wrap the installer in a .rar). Re-walk the extracted folder and
        // append its files so the installer detection below can see them — otherwise needsInstall
        // is never set and the auto-installer never runs.
        if (result.extracted) {
            (function walk(d, depth) {
                if (depth > 6) return;
                let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
                for (const en of ents) {
                    const full = path.join(d, en.name);
                    if (en.isDirectory()) { walk(full, depth + 1); continue; }
                    if (/^_cover\./i.test(en.name)) continue;
                    let size = 0; try { size = fs.statSync(full).size; } catch (e) {}
                    allFiles.push({ name: en.name, full, size });
                }
            })(extractTo, 0);
        }
        // Free the disk: once extraction succeeded and produced real content, delete the
        // source archive(s) + their split-part siblings (e.g. SteamGG's leftover 18 GB zip).
        let extractedSize = 0; try { extractedSize = dirSizeBytes(extractTo, 0); } catch (e) {}
        if (anyExtracted && extractedSize > 5 * 1024 * 1024) deleteArchiveSources(dir);
    }
    if (!result.exePath) result.exePath = findGameExe(dir, opts.gameName) || '';

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
    const preInstalled = /^steamrip$/i.test(opts.sourceId || '');
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
    // FitGirl/DODI repacks ship as setup.exe + .bin parts → always treat as an install,
    // overriding any stray tiny helper .exe (e.g. QuickSFV) that findGameExe may have grabbed.
    else if (setupExe && hasBin) { result.exePath = setupExe.full; result.needsInstall = true; }
    else if (!result.exePath && installer) { result.exePath = installer.full; result.needsInstall = true; }

    // Did we actually end up with something playable/installable?
    result.usable = !!(result.extracted || result.exePath || archives.length || installer || hasBin || bigFile);
    if (!result.usable) {
        // common failure: the host served an ad/redirect HTML page saved as "download"
        result.junk = allFiles.length === 0 || allFiles.every(f => /^download(\.|$)/i.test(f.name) || /\.(html?|php|txt)$/i.test(f.name));
        if (!result.junk && allFiles.length === 1 && allFiles[0].size < 100 * 1024) result.junk = true;
    }
    return result;
}

// Files we never want to download (online-fix bundles a generic steam-fix that
// the user handles separately). Matches on filename or URL.
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
            '--max-connection-per-server=' + conns, '--split=' + conns, '--min-split-size=1M', '--check-certificate=false',
            '--max-tries=3', '--retry-wait=3', '--connect-timeout=30', '--timeout=60',
            '--user-agent=' + DL_UA
        ];
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

        const proc = spawn(aria2, args, { windowsHide: true });
        ctl.proc = proc;
        let buf = '';
        const onData = (data) => {
            buf += data.toString();
            const lines = buf.split(/\r|\n/);
            buf = lines.pop();
            for (const line of lines) {
                const mm = line.match(/\[#\w+\s+([\d.]+\s*[KMGT]?i?B)\/([\d.]+\s*[KMGT]?i?B)\((\d+)%\).*?DL:\s*([\d.]+\s*[KMGT]?i?B)(?:.*?ETA:\s*(\S+?))?\]/);
                if (mm) onProgress({
                    downloaded: mm[1].replace(/\s/g, ''), total: mm[2].replace(/\s/g, ''),
                    percent: Number(mm[3]), speed: mm[4].replace(/\s/g, ''), eta: mm[5] || ''
                });
            }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (ctl.cancelled) return reject(new Error('Cancelled'));
            // Pause = kill aria2 but keep the partial file + .aria2 control file so a later
            // resume continues from where it stopped (aria2 --continue). Don't treat as an error.
            if (ctl.paused) return reject(new Error('Paused'));
            if (code === 0) return resolve();
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

ipcMain.handle('download-game', async (e, opts) => {
    const wc = e.sender;
    const id = opts.id;
    const ctl = { proc: null, cancelled: false, paused: false };
    let slowTimer = null;
    try {
        // Normalise to a list of files. New callers pass opts.links = [{url,name}];
        // legacy single-link callers pass opts.url.
        let links = (Array.isArray(opts.links) && opts.links.length)
            ? opts.links.slice()
            : (opts.url ? [{ url: opts.url, name: opts.gameName }] : []);
        // never download the generic steam-fix bundle
        links = links.filter(l => !DL_SKIP_FILE.test((l.name || '') + ' ' + (l.url || '')));
        if (!links.length) {
            wc.send('download-error', { id, error: 'No usable download links found.', url: opts.url, needsBrowser: true });
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

        // Mirrors = the same game on other file-hosts. With a single primary link we can
        // race the resolver across [primary, ...mirrors] and take whichever host produces
        // a direct link first; multi-part sets and magnets keep the normal per-link path.
        const resolveOpts = { sourceId: opts.sourceId };
        const mirrors = (Array.isArray(opts.mirrors) ? opts.mirrors : [])
            .filter(u => u && !links.some(l => l.url === u));
        const raceMirrors = links.length === 1 && mirrors.length > 0;
        // Kick the resolution off NOW (returns a promise we await after the cheap setup).
        const resolveJob = raceMirrors
            ? resolveFirstMirror([links[0].url, ...mirrors], resolveOpts)
            : Promise.all(links.map(l => resolveDirectUrl(l.url, resolveOpts).then(resolved => ({ link: l, resolved }))));

        const aria2 = await ensureAria2(wc);

        const root = getDownloadsRoot(opts.installDir);
        const dir = path.join(root, sanitizeName(opts.gameName));
        ctl.dir = dir;   // so cancel-download can delete the folder/partials this job created
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // grab cover art for the library entry (best-effort)
        if (opts.image && /^https?:/i.test(opts.image)) {
            let ext = '.jpg';
            try { ext = path.extname(new URL(opts.image).pathname) || '.jpg'; } catch (er) {}
            dlHttpToFile(opts.image, path.join(dir, '_cover' + ext)).catch(() => {});
        }

        // Resolve every link up-front into concrete files (a single Gofile folder can
        // expand into several part files), so we know the real total before downloading.
        if (ctl.cancelled) { clearTimeout(slowTimer); throw new Error('Cancelled'); }
        const resolveResult = await resolveJob;
        clearTimeout(slowTimer);
        if (ctl.cancelled) throw new Error('Cancelled');
        let files = [];
        if (raceMirrors) {
            // Winning host's resolved file(s); origin is set to that host so a mid-download
            // retry re-resolves the same winner for a fresh token.
            if (!resolveResult || !resolveResult.files || !resolveResult.files.length) throw buildUnresolvedError(links[0].url);
            resolveResult.files.forEach((f, idx) => files.push(Object.assign({ name: f.name || links[0].name, origin: resolveResult.origin, originIndex: idx }, f)));
        } else {
            for (const { link: l, resolved } of resolveResult) {
                if (!resolved || !resolved.length) throw buildUnresolvedError(l.url);
                resolved.forEach((f, idx) => files.push(Object.assign({ name: f.name || l.name, origin: l.url, originIndex: idx }, f)));
            }
        }
        // drop the generic steam-fix / obvious non-game payloads
        const filtered = files.filter(f => !DL_SKIP_FILE.test((f.name || '') + ' ' + (f.url || '')));
        if (filtered.length) files = filtered;
        // de-dupe by url
        const seenUrl = new Set();
        files = files.filter(f => !seenUrl.has(f.url) && seenUrl.add(f.url));

        const total = files.length;
        // Download every part sequentially into the same folder; report aggregate progress.
        for (let i = 0; i < total; i++) {
            if (ctl.cancelled) throw new Error('Cancelled');
            const partLabel = total > 1 ? `Part ${i + 1}/${total}` : '';
            let file = files[i];
            let attempt = 0, ok = false, lastErr = null;
            // Retry up to 3x. Single-use token hosts (fuckingfast) expire mid-download
            // and can't resume (aria2 exit 8), so on failure we re-resolve the origin
            // link for a FRESH token and start clean.
            while (attempt < 3 && !ok) {
                attempt++;
                try {
                    await runAria2Download(aria2, file, dir, opts, ctl, (p) => {
                        const overall = Math.round(((i + (p.percent || 0) / 100) / total) * 100);
                        wc.send('download-progress', {
                            id, state: 'downloading', percent: overall, partPercent: p.percent,
                            part: i + 1, partCount: total, downloaded: p.downloaded, total: p.total,
                            speed: p.speed, eta: p.eta, label: partLabel + (attempt > 1 ? ' (retry ' + (attempt - 1) + ')' : '')
                        });
                    });
                    ok = true;
                } catch (e) {
                    lastErr = e;
                    if (ctl.cancelled || ctl.paused || /cancelled|paused/i.test(e.message)) throw e;
                    if (attempt < 3) {
                        cleanPartial(dir, file);
                        wc.send('download-progress', { id, state: 'resolving', part: i + 1, partCount: total, subLabel: '', label: (partLabel ? partLabel + ' — ' : '') + 'Connection lost, retrying with a fresh link...' });
                        if (file.origin) {
                            try {
                                const re = await resolveDirectUrl(file.origin, { sourceId: opts.sourceId });
                                if (re && re.length) {
                                    const nf = re[file.originIndex] || re.find(x => x.name === file.name) || re[0];
                                    file = Object.assign({ name: file.name, origin: file.origin, originIndex: file.originIndex }, nf);
                                }
                            } catch (re2) {}
                        }
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
            }
            if (!ok) throw lastErr || new Error('Download failed');
        }

        activeDownloads.delete(id);
        wc.send('download-progress', { id, state: 'processing', label: 'Extracting & preparing game...' });
        try {
            const res = await postProcessDownload(dir, opts);

            // Auto-install: FitGirl / DODI repacks come as setup.exe + .bin parts. If the
            // user has auto-install on, run the installer unattended into a clean folder,
            // then delete the repack source so only the playable game remains.
            if (res.needsInstall && res.exePath && opts.autoInstall !== false) {
                const installTarget = path.join(dir, '_game');
                let polling = true;
                (async function pollSize() {
                    while (polling) {
                        let gb = 0; try { gb = dirSizeBytes(installTarget, 0) / (1024 * 1024 * 1024); } catch (e) {}
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
                    await runSilentInstall(res.exePath, installTarget, ctl, opts.skipRedist !== false);
                    polling = false;
                    // A short settle catches any trailing writes (shortcuts, config) flushed in the
                    // last moment after the installer process exited.
                    await waitForDirSettle(installTarget, ctl, (sz) => {
                        const gb = sz / (1024 * 1024 * 1024);
                        wc.send('download-progress', { id, state: 'installing', percent: 100, label: 'Finishing up… ' + gb.toFixed(2) + ' GB installed' });
                    });
                    // The exe occasionally lands a beat after the final byte — retry a couple times.
                    let exe = findGameExe(installTarget, opts.gameName);
                    for (let t = 0; !exe && t < 3; t++) { await new Promise(r => setTimeout(r, 3000)); exe = findGameExe(installTarget, opts.gameName); }
                    if (exe) {
                        cleanRepackSource(dir, installTarget);   // succeeded → remove the repack files
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

            if (!res.usable) {
                wc.send('download-error', {
                    id, url: opts.url, needsBrowser: true,
                    error: res.junk
                        ? 'The host returned a web page instead of the game file. Use "Open game page" to grab it manually.'
                        : 'Download finished but no game files were found.'
                });
            } else {
                if (res.installFailed) {
                    res.warning = 'Downloaded, but auto-install didn\'t complete'
                        + (res.installError ? ' (' + res.installError + ')' : '')
                        + '. Open the folder and run setup.exe manually.';
                }
                wc.send('download-complete', Object.assign({ id }, res));
            }
        } catch (perr) {
            wc.send('download-complete', { id, gameName: opts.gameName, folder: dir, exePath: '', cover: '', usable: true, warning: 'Saved, but extraction failed: ' + perr.message });
        }
        return { success: true };
    } catch (err) {
        clearTimeout(slowTimer);
        activeDownloads.delete(id);
        // Paused = a clean, resumable stop. Tell the renderer so it shows "Paused" + a Resume
        // button instead of an error, and keep the partial files on disk.
        if (ctl.paused || /paused/i.test(err.message)) { wc.send('download-progress', { id, state: 'paused', label: 'Paused' }); return { success: false, paused: true }; }
        if (ctl.cancelled || /cancelled/i.test(err.message)) return { success: false, cancelled: true };
        // PixelDrain's Worker proxy can drop the FIRST request while it cold-starts, so the
        // initial click 4xx/5xx's but a retry succeeds against the now-warm worker. We can't
        // reliably pre-warm it, so give the user a clear, actionable nudge instead of a raw error.
        let errMsg = err.message;
        if (/pixeldrain/i.test(opts.url || '')) {
            errMsg = 'PixelDrain didn\'t respond on this attempt (its proxy worker was warming up). Just click Download again — the second try almost always works.';
        }
        wc.send('download-error', { id, error: errMsg, url: opts.url, needsBrowser: !!err.needsBrowser });
        return { success: false, error: errMsg };
    }
});

// Folder a download writes into (mirrors the path built in download-game), so cancel can
// delete a paused job's files even after it's no longer in activeDownloads.
function downloadDirFor(gameName, installDir) {
    try { return path.join(getDownloadsRoot(installDir), sanitizeName(gameName)); } catch (e) { return null; }
}

// Cancel = stop for good and (when asked) delete everything this download created — the
// folder and all partial/finished files — so cancelling leaves nothing behind.
ipcMain.handle('cancel-download', (e, id, info) => {
    info = info || {};
    const d = activeDownloads.get(id);
    if (d) { d.cancelled = true; try { d.proc && d.proc.kill(); } catch (err) {} activeDownloads.delete(id); }
    if (info.deleteFolder) {
        const dir = (d && d.dir) || (info.gameName ? downloadDirFor(info.gameName, info.installDir) : null);
        // Give aria2 a moment to release its file handles (Windows locks the .aria2 file)
        // before removing the directory tree.
        if (dir) setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {} }, 600);
    }
    return true;
});

// Pause = kill aria2 but keep the partial download + .aria2 control file so Resume can
// continue from where it stopped. Removed from activeDownloads; files stay on disk.
ipcMain.handle('pause-download', (e, id) => {
    const d = activeDownloads.get(id);
    if (d) { d.paused = true; try { d.proc && d.proc.kill(); } catch (err) {} activeDownloads.delete(id); return true; }
    return false;
});

// Clear cached data (Download settings → Clear Cache). Wipes the in-memory resolved
// debrid-link cache and the in-app browser's HTTP cache, so stale/expired links and pages
// are re-fetched fresh. Does NOT touch the user's settings, library, or downloaded games.
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
ipcMain.handle('scan-game-saves', async (e, gameName, playedSince) => {
    try {
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const target = norm(gameName);
        if (!target || target.length < 3) return null;
        const home = app.getPath('home');
        const localLow = process.env.LOCALAPPDATA ? path.join(path.dirname(process.env.LOCALAPPDATA), 'LocalLow') : '';
        const roots = [
            path.join(home, 'Saved Games'),
            path.join(home, 'Documents', 'My Games'),
            path.join(home, 'Documents'),
            process.env.APPDATA || '',
            process.env.LOCALAPPDATA || '',
            localLow
        ].filter(Boolean);
        const candidates = [];
        for (const root of roots) {
            let ents; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (er) { continue; }
            for (const en of ents) {
                if (!en.isDirectory()) continue;
                const n = norm(en.name);
                if (n.length < 3) continue;
                const exact = n === target;
                const partial = !exact && (n.includes(target) || target.includes(n)) && Math.min(n.length, target.length) >= 4;
                if (!exact && !partial) continue;
                const full = path.join(root, en.name);
                let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch (er) {}
                // skip folders that clearly weren't touched by this play session
                if (playedSince && mtime && mtime < (playedSince - 5 * 60 * 1000)) continue;
                candidates.push({ full, mtime, score: exact ? 3 : 2 });
            }
        }
        if (!candidates.length) return null;
        candidates.sort((a, b) => (b.score - a.score) || (b.mtime - a.mtime));
        return candidates[0].full;
    } catch (er) { return null; }
});

ipcMain.handle('pick-download-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
});

// In-page JS that scrapes every real file-host download link from whatever page
// it runs in (the Online-Fix "Hosters" popup/iframe, or the game page as a
// fallback). Reads href + onclick + data-* so JS-driven buttons are caught too.
const OF_EXTRACT_JS = `(function(){
    var KNOWN=/gofile\\.io|pixeldrain\\.com|datanodes|vikingfile|rootz|1fichier|mega(\\.nz|db)|mediafire|fuckingfast|hexload|qiwi|multiup|bowfile|akirabox|\\.rar|\\.zip|\\.7z|part\\d+/i;
    var SKIPHOST=/online-fix\\.me\\/?($|\\/(index|user|rules|faq|page|tags|stats|news|addnews|favorites|dle|engine))/i;
    var seen={}, out=[];
    function add(href, ctx){
        if(!href||!/^https?:/i.test(href)) return;
        if(SKIPHOST.test(href)) return;
        if(!KNOWN.test(href)) return;
        if(seen[href]) return; seen[href]=1;
        var name=(ctx||'').replace(/download|скачать|загрузить/ig,'').replace(/\\s+/g,' ').trim().slice(0,140);
        var host=''; try{host=new URL(href).hostname.replace(/^www\\./,'');}catch(e){}
        out.push({name:name||host, url:href, host:host});
    }
    var els=[].slice.call(document.querySelectorAll('a[href],[onclick],[data-url],[data-href],[data-link],[data-download]'));
    els.forEach(function(a){
        var href=(/^https?:/i.test(a.href||'')?a.href:'') || a.getAttribute('data-url') || a.getAttribute('data-href') || a.getAttribute('data-link') || a.getAttribute('data-download') || '';
        if(!/^https?:/i.test(href)){ var oc=a.getAttribute('onclick')||''; var m=oc.match(/https?:\\/\\/[^'\"\\s)]+/); if(m) href=m[0]; }
        var row=(a.closest&&a.closest('tr,li,.row,div'))||a;
        add(href, (row.textContent||a.textContent||''));
    });
    return out;
})();`;

// Open an Online-Fix game page (carrying the in-app browser's login session),
// click the "Hosters" / download trigger, capture the popup window it spawns,
// and scrape the per-file host links from it. Falls back to scraping the game
// page itself if no popup appears. Returns { files:[{name,url,host}], loggedIn }.
const OF_KNOWN_HOST = /gofile\.io|pixeldrain\.com|datanodes|vikingfile|rootz|1fichier|mega(\.nz|db)|mediafire|fuckingfast|hexload|qiwi|multiup|bowfile|akirabox/i;

// Clicks tabs + DOWNLOAD buttons inside the hosters popup so each host's link is
// triggered (we capture the resulting navigation instead of following it).
const OF_POPUP_CLICK_JS = `(function(){
    var n=0;
    var els=[].slice.call(document.querySelectorAll('a,button,li,span,div,[role="tab"],[onclick]'));
    els.forEach(function(el){
        if(el.__ofc) return;
        var t=((el.textContent||'')+' '+(el.value||'')).trim().toLowerCase();
        var href=(el.href||'').toLowerCase();
        var isHostLink=/gofile|pixeldrain|datanodes|vikingfile|rootz|1fichier|mediafire|fuckingfast|hexload|multiup|bowfile|mega/.test(href);
        var isDl=/^(download|скачать|загрузить|download now)$/.test(t)||isHostLink;
        var isTab=/^(pixeldrain|gofile|rootz|vikingfile|datanodes|mega|mega\\.nz|mediafire|1fichier|fuckingfast|hexload)$/.test(t);
        if((isDl||isTab) && el.offsetParent!==null){ el.__ofc=1; try{el.click();}catch(e){} n++; }
    });
    return n;
})();`;

// Open an Online-Fix game page (carrying the in-app browser's login session), open
// the "Hosters" popup, and collect every file-host link. Host links are captured by
// intercepting navigations/popups/downloads (and prevented, so we can keep clicking
// the rest) rather than relying on static hrefs being present. Returns
// { files:[{name,url,host}], loggedIn }.
function resolveOnlineFixHosters(gameUrl, timeoutMs = 55000) {
    return new Promise((resolve) => {
        let done = false, win = null, popup = null, poll = null, timer = null;
        let loggedIn = null;
        const collected = new Map(); // url -> name
        let lastCount = 0, stableTicks = 0;

        const capture = (url, name) => {
            if (!url || !/^https?:/i.test(url)) return;
            if (isAdHost(url) || /online-fix\.me/i.test(url)) return;
            if (!OF_KNOWN_HOST.test(url)) return;
            if (!collected.has(url)) collected.set(url, name || '');
        };
        const result = () => {
            const files = [...collected.entries()].map(([url, name]) => {
                let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) {}
                return { url, name: name || host, host };
            });
            return { files, loggedIn: loggedIn === null ? (files.length ? true : null) : loggedIn };
        };
        const finish = (val) => {
            if (done) return; done = true;
            clearTimeout(timer); if (poll) clearInterval(poll);
            try { if (popup && !popup.isDestroyed()) popup.destroy(); } catch (e) {}
            try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
            resolve(val || result());
        };
        timer = setTimeout(() => finish(), timeoutMs);
        try {
            win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false } });
        } catch (e) { return resolve({ files: [], loggedIn: null, error: e.message }); }
        try { applyAdBlock(win.webContents.session); } catch (e) {}

        // wire navigation/download/popup capture onto a webContents
        const wire = (wc, ses) => {
            wc.on('will-navigate', (e, u) => { if (OF_KNOWN_HOST.test(u)) { capture(u); try { e.preventDefault(); } catch (er) {} } else if (isAdHost(u)) { try { e.preventDefault(); } catch (er) {} } });
            wc.on('will-redirect', (e, u) => { if (OF_KNOWN_HOST.test(u)) { capture(u); try { e.preventDefault(); } catch (er) {} } else if (isAdHost(u)) { try { e.preventDefault(); } catch (er) {} } });
            try {
                ses.on('will-download', (e, item) => { const u = item.getURL(); capture(u, (() => { try { return item.getFilename(); } catch (er) { return ''; } })()); try { item.cancel(); } catch (er) {} });
            } catch (er) {}
        };

        // Game window: allow the hosters popup (hidden), capture any host links it
        // tries to open directly.
        win.webContents.setWindowOpenHandler(({ url }) => {
            if (url && OF_KNOWN_HOST.test(url)) { capture(url); return { action: 'deny' }; }
            if (url && isAdHost(url)) return { action: 'deny' };
            return { action: 'allow', overrideBrowserWindowOptions: { show: false } };
        });
        wire(win.webContents, win.webContents.session);
        win.webContents.on('did-create-window', (child) => {
            popup = child;
            try { applyAdBlock(child.webContents.session); } catch (e) {}
            child.webContents.setWindowOpenHandler(({ url }) => { if (url) capture(url); return { action: 'deny' }; });
            wire(child.webContents, child.webContents.session);
        });

        const scan = async (wc) => {
            if (!wc) return;
            const run = async (ctx) => { try { const f = await ctx.executeJavaScript(OF_EXTRACT_JS, true); (f || []).forEach(x => capture(x.url, x.name)); } catch (e) {} };
            await run(wc);
            try { const frames = wc.mainFrame ? wc.mainFrame.frames : []; for (const fr of frames) await run(fr); } catch (e) {}
        };

        const tick = async () => {
            if (done || !win || win.isDestroyed()) return;
            // game page: detect login + click the hosters trigger
            try {
                const info = await win.webContents.executeJavaScript(`(function(){
                    var loggedIn = !!document.querySelector('a[href*="logout"], a[href*="do=logout"]') || /\\bвыход\\b|do=logout/i.test(document.body.innerHTML);
                    var clicked=0, nodes=[].slice.call(document.querySelectorAll('a,button,div,span,input'));
                    nodes.forEach(function(el){
                        if(el.__ofClicked) return;
                        var t=((el.textContent||'')+' '+(el.value||'')+' '+(el.title||'')).trim().toLowerCase();
                        var href=(el.href||'').toLowerCase();
                        var isTrg = /^(скачать|download|hosters?|загрузить|скачать игру|download game)$/.test(t) || /hoster|uploads\\.online-fix|premium\\.online-fix/.test(href) || (/скачать|download/.test(t) && t.length<24);
                        if(isTrg && el.offsetParent!==null){ el.__ofClicked=1; try{el.click();}catch(e){} clicked++; }
                    });
                    return { loggedIn: loggedIn, clicked: clicked };
                })();`, true);
                if (info && info.loggedIn) loggedIn = true;
            } catch (e) {}
            // hosters popup: click every tab + DOWNLOAD button so each host link fires
            if (popup && !popup.isDestroyed()) {
                try { await popup.webContents.executeJavaScript(OF_POPUP_CLICK_JS, true); } catch (e) {}
                await scan(popup.webContents);
            }
            await scan(win.webContents);

            // settle: once we have links and a couple ticks add nothing new, return
            if (collected.size && collected.size === lastCount) { if (++stableTicks >= 2) return finish(); }
            else stableTicks = 0;
            lastCount = collected.size;
        };

        win.webContents.on('did-finish-load', () => setTimeout(tick, 1200));
        poll = setInterval(tick, 2500);
        win.loadURL(gameUrl, { userAgent: DL_UA }).catch(() => finish({ files: [], loggedIn, error: 'load failed' }));
    });
}

ipcMain.handle('resolve-onlinefix', async (e, url) => {
    try { return await resolveOnlineFixHosters(url); }
    catch (err) { return { files: [], loggedIn: null, error: err.message }; }
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();
else {
    app.setAppUserModelId("com.aseoriy.saillauncher");

    // Register custom protocol for one-click installs from Sail Hub
    if (process.defaultApp) {
        app.setAsDefaultProtocolClient('sail-launcher', process.execPath, [path.resolve(process.argv[1])]);
    } else {
        app.setAsDefaultProtocolClient('sail-launcher');
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

    ipcMain.handle('get-file-icon', async (e, filePath) => {
        try {
            const icon = await app.getFileIcon(filePath, { size: 'large' });
            return icon.toDataURL();
        } catch (err) {
            return null;
        }
    });



    ipcMain.handle('import-steam-games', async () => {
        return new Promise((resolve) => {
            exec('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', (err, stdout) => {
                if (err) return resolve([]);
                const match = stdout.match(/SteamPath\s+REG_SZ\s+(.*)/);
                if (!match) return resolve([]);
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
                                    exePath: guessedExe || "" // Save the path so the tracker works!
                                });
                            }
                        } catch (e) { }
                    });
                });
                resolve(games);
            });
        });
    });

    ipcMain.handle('import-epic-games', async () => {
        return new Promise((resolve) => {
            const manifestDir = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
            if (!fs.existsSync(manifestDir)) return resolve([]);
            
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
                            exePath: fullExePath || data.InstallLocation,
                            epicId: data.AppName
                        });
                    }
                } catch(e) {}
            });
            resolve(games);
        });
    });

    ipcMain.handle('import-gog-games', async () => {
        return new Promise((resolve) => {
            exec('reg query "HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games" /s', (err, stdout) => {
                if (err) return resolve([]);
                
                let games = [];
                const lines = stdout.split('\n');
                let currentGame = {};
                
                lines.forEach(line => {
                    const l = line.trim();
                    if (l.startsWith('HKEY_')) {
                        if (currentGame.name && currentGame.exePath) games.push({...currentGame});
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
                    games.push({...currentGame});
                }
                
                resolve(games);
            });
        });
    });

    // Handle protocol URL on first launch (Windows)
    app.on('open-url', (e, url) => { e.preventDefault(); handleProtocolUrl(url); });

    app.commandLine.appendSwitch('enable-features', 'GamepadButtonAxisEvents');

    app.whenReady().then(() => {
        try { applyAdBlock(session.defaultSession); } catch (e) {}
        createWindow();
        tray = new Tray(path.join(__dirname, 'icon.ico'));
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Open Sail Launcher', click: () => BrowserWindow.getAllWindows()[0].show() },
            { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
        ]);
        tray.setToolTip('Sail Launcher');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => BrowserWindow.getAllWindows()[0].show());

        // Handle protocol URL if app was launched via it
        const protocolArg = process.argv.find(a => a.startsWith('sail-launcher://'));
        if (protocolArg) handleProtocolUrl(protocolArg);
    });
}