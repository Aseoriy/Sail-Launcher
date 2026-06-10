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
const DL_HOST_ALLOW = /(gofile|pixeldrain|datanodes|buzzheavier|fuckingfast|1fichier|mediafire|mega\.nz|megadb|qiwi|multiup|bowfile|hexload|vikingfile|akirabox|filekeeper|filecrypt|online-fix|steamrip|fitgirl|dodi)/i;
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
    const m = rawUrl.match(/\/(?:u|api\/file)\/([a-zA-Z0-9_-]+)/i);
    if (!m) return null;
    // The /api/file/{id}?download endpoint serves the file directly. Pixeldrain's
    // hotlink protection rejects a FOREIGN Referer (e.g. steamgg.net) → 403 → aria2
    // exit 22. Sending pixeldrain's OWN domain as the Referer always passes the check,
    // so we use that regardless of the embedding site. A 403 here usually means the
    // file hit its free bandwidth limit (unbypassable) — surfaced as a clear message.
    const headers = ['Referer: https://pixeldrain.com/', 'User-Agent: ' + CHROME_UA];
    return [{ url: `https://pixeldrain.com/api/file/${m[1]}?download`, kind: 'http', headers }];
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

// Resolve a (possibly indirect) link into one or more concrete files aria2 can
// fetch. ALWAYS returns an array of { url, kind, headers?, name? } or null.
// Host-specific HTTP scrapers run first (no browser → no ads); a single Gofile
// folder can expand into several part files. Browser intercept is the last resort.
// Hosts that have a dedicated scraper. If one of these fails we must NOT fall
// through to the "direct archive" check (their page URLs often end in .bin/.rar
// and would otherwise download the HTML landing page) nor to the browser (which
// hangs on their JS/captcha). We just report failure so the user can pick another host.
const DL_KNOWN_HOST = /gofile|pixeldrain\.(com|net|in|nl|biz|tech|dev)|datanodes|buzzheavier\.com|bzzhr\.(co|to)|fuckingfast\.(co|net)|mediafire|megadb|filekeeper/i;

// Per-source Referer to spoof when a host applies hotlink protection.
const SOURCE_REFERER = { steamgg: 'https://steamgg.net/' };

async function resolveDirectUrl(rawUrl, opts) {
    opts = opts || {};
    const referer = opts.referer || SOURCE_REFERER[opts.sourceId] || '';
    if (!rawUrl) return null;
    // CF-interactive hosts that can never be auto-resolved — return null immediately
    // instead of spending 30+ s in the browser interceptor before failing.
    if (/akirabox\.(com|to)/i.test(rawUrl)) return null;
    if (rawUrl.startsWith('magnet:') || /\.torrent(\?|#|$)/i.test(rawUrl)) return [{ url: rawUrl, kind: rawUrl.startsWith('magnet:') ? 'magnet' : 'http' }];
    if (DL_KNOWN_HOST.test(rawUrl)) {
        let r = null;
        try {
            if (/gofile/i.test(rawUrl)) r = await scrapeGofile(rawUrl);
            else if (/pixeldrain/i.test(rawUrl)) r = await scrapePixeldrain(rawUrl, referer);
            else if (/datanodes/i.test(rawUrl)) r = await scrapeDatanodes(rawUrl);
            else if (/buzzheavier\.com|bzzhr\.(co|to)/i.test(rawUrl)) r = await scrapeBuzzheavier(rawUrl);
            else if (/fuckingfast\.(co|net)/i.test(rawUrl)) r = await scrapeFuckingfast(rawUrl);
            else if (/mediafire/i.test(rawUrl)) r = await scrapeMediafire(rawUrl);
            else if (/filekeeper/i.test(rawUrl)) r = await scrapeFilekeeper(rawUrl);
            else if (/megadb/i.test(rawUrl)) r = await scrapeXFS(rawUrl);
        } catch (e) { /* report failure below */ }
        return (r && r.length) ? r : null; // never fall through for a known host
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

// Click script: find the real download control while skipping ad links. Prefers
// anchors that point at an actual file/known host; only then falls back to
// buttons/elements whose visible text is a download verb. Returns true if it
// clicked something plausible.
const INTERCEPT_CLICK_JS = `(function(){
    var FILE=/\\.(zip|rar|7z|bin|iso|exe|torrent|part\\d+)(\\?|#|$)/i;
    var HOST=/gofile|pixeldrain|datanodes|buzzheavier|fuckingfast|1fichier|mediafire|mega(\\.nz|db)|qiwi|multiup|bowfile|hexload|vikingfile|akirabox|store\\d+\\.gofile/i;
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
function findGameExe(dir) {
    const skip = /(unins|setup|vc_?redist|vcredist|dxsetup|directx|dotnet|dotnetfx|oalinst|redist|crashreport|crashhandler|uninstall|launcher_settings|notification_helper|quicksfv|sfv|installer)/i;
    let best = null, bestSize = -1;
    const walk = (d, depth) => {
        if (depth > 6) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) { walk(full, depth + 1); continue; }
            if (!ent.name.toLowerCase().endsWith('.exe')) continue;
            if (skip.test(ent.name)) continue;
            // ignore repack helper exes tucked in an MD5/checksum folder
            if (/[\\/]md5[\\/]/i.test(full)) continue;
            let size = 0;
            try { size = fs.statSync(full).size; } catch (e) {}
            if (size > bestSize) { bestSize = size; best = full; }
        }
    };
    walk(dir, 0);
    return best;
}

function findArchives(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
    const files = entries.filter(en => en.isFile()).map(en => en.name);
    const primaries = [];
    for (const f of files) {
        const low = f.toLowerCase();
        // skip non-first split parts
        if (/\.part(?!0*1\.)\d+\.rar$/i.test(f)) continue;          // part2.rar, part3.rar...
        if (/\.(r\d{2}|z\d{2})$/i.test(f)) continue;                 // .r00/.z01 split volumes
        if (/\.\d{3}$/.test(f) && !/\.001$/.test(f)) continue;       // .002, .003 ... keep .001
        if (/\.(zip|rar|7z)$/i.test(low) || /\.7z\.001$/i.test(low) || /\.zip\.001$/i.test(low)) {
            primaries.push(path.join(dir, f));
        }
    }
    return primaries;
}

function extractArchive(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        // 7-Zip (bundled via 7zip-min) handles zip / 7z / rar / split archives
        _7z.unpack(archivePath, destDir, (err) => err ? reject(err) : resolve(destDir));
    });
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
        // We mute the default audio endpoint before launching (saving the prior mute
        // state) and restore it afterwards via the IAudioEndpointVolume COM API.
        const extras = skipExtras ? ' /NOICONS /TASKS=""' : '';
        const innoArgs = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL /SP-' + extras + ' "/DIR=' + targetDir + '"';
        const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

        // Build a self-contained PS1 that handles mute + elevated run in one shot.
        // Written to a temp file to avoid command-line escaping of the here-string.
        const psLines = [
            'try {',
            '    Add-Type -TypeDefinition @"',
            'using System;',
            'using System.Runtime.InteropServices;',
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
            '[Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]',
            '[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
            '[ComImport]',
            'interface IAudioEndpointVolume {',
            '    void RegisterControlChangeNotify(IntPtr p);',
            '    void UnregisterControlChangeNotify(IntPtr p);',
            '    void GetChannelCount(out uint n);',
            '    void SetMasterVolumeLevel(float f, ref Guid g);',
            '    void SetMasterVolumeLevelScalar(float f, ref Guid g);',
            '    void GetMasterVolumeLevel(out float f);',
            '    void GetMasterVolumeLevelScalar(out float f);',
            '    void SetChannelVolumeLevel(uint n, float f, ref Guid g);',
            '    void SetChannelVolumeLevelScalar(uint n, float f, ref Guid g);',
            '    void GetChannelVolumeLevel(uint n, out float f);',
            '    void GetChannelVolumeLevelScalar(uint n, out float f);',
            '    void SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g);',
            '    void GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);',
            '    void GetVolumeStepInfo(out uint s, out uint c);',
            '    void VolumeStepUp(ref Guid g);',
            '    void VolumeStepDown(ref Guid g);',
            '    void QueryHardwareSupport(out uint m);',
            '    void GetVolumeRange(out float a, out float b, out float c);',
            '}',
            '[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]',
            'class MDE {}',
            'public class AudioMuter {',
            '    static IAudioEndpointVolume Get() {',
            '        var e = (IMMDeviceEnumerator)(new MDE());',
            '        IMMDevice d; e.GetDefaultAudioEndpoint(0, 1, out d);',
            '        var iid = typeof(IAudioEndpointVolume).GUID;',
            '        object o; d.Activate(ref iid, 23, IntPtr.Zero, out o);',
            '        return (IAudioEndpointVolume)o;',
            '    }',
            '    public static bool GetMuted() { bool m; Get().GetMute(out m); return m; }',
            '    public static void SetMuted(bool m) { var v = Get(); var g = Guid.Empty; v.SetMute(m, ref g); }',
            '}',
            '"@',
            '} catch {}',
            '$wasMuted = $false',
            'try { $wasMuted = [AudioMuter]::GetMuted(); [AudioMuter]::SetMuted($true) } catch {}',
            '$ec = 0',
            'try {',
            '    $p = Start-Process -FilePath ' + q(installerPath) + ' -ArgumentList ' + q(innoArgs) + ' -Verb RunAs -Wait -PassThru -ErrorAction Stop',
            '    $ec = $p.ExitCode',
            '} catch { $ec = 1223 }',
            'try { [AudioMuter]::SetMuted($wasMuted) } catch {}',
            'exit $ec'
        ];
        const psScript = psLines.join('\r\n');
        const tmpFile = path.join(process.env.TEMP || process.env.TMP || path.dirname(installerPath), 'sail_inst_' + Date.now() + '.ps1');
        try { fs.writeFileSync(tmpFile, psScript, 'utf8'); }
        catch (e) { return reject(e); }

        let proc;
        try { proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], { windowsHide: true }); }
        catch (e) { try { fs.unlinkSync(tmpFile); } catch (er) {} return reject(e); }
        ctl.proc = proc;
        proc.on('error', (e) => { try { fs.unlinkSync(tmpFile); } catch (er) {} reject(e); });
        proc.on('close', (code) => {
            try { fs.unlinkSync(tmpFile); } catch (er) {}
            if (ctl.cancelled) return reject(new Error('Cancelled'));
            if (code === 1223) return reject(new Error('Windows permission prompt was declined'));   // UAC cancelled
            resolve(code);
        });
    });
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
        for (const arc of archives) {
            try { await extractArchive(arc, extractTo); result.extracted = true; }
            catch (e) { /* leave archive in place if extraction fails */ }
        }
        if (result.extracted) result.exePath = findGameExe(extractTo) || findGameExe(dir) || '';
    }
    if (!result.exePath) result.exePath = findGameExe(dir) || '';

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
    // FitGirl/DODI repacks ship as setup.exe + .bin parts → always treat as an install,
    // overriding any stray tiny helper .exe (e.g. QuickSFV) that findGameExe may have grabbed.
    if (setupExe && hasBin) { result.exePath = setupExe.full; result.needsInstall = true; }
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
    return (name || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
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
    const ctl = { proc: null, cancelled: false };
    try {
        const aria2 = await ensureAria2(wc);

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

        const root = getDownloadsRoot(opts.installDir);
        const dir = path.join(root, sanitizeName(opts.gameName));
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // grab cover art for the library entry (best-effort)
        if (opts.image && /^https?:/i.test(opts.image)) {
            let ext = '.jpg';
            try { ext = path.extname(new URL(opts.image).pathname) || '.jpg'; } catch (er) {}
            dlHttpToFile(opts.image, path.join(dir, '_cover' + ext)).catch(() => {});
        }

        activeDownloads.set(id, ctl);

        // Resolve every link up-front into concrete files (a single Gofile folder can
        // expand into several part files), so we know the real total before downloading.
        wc.send('download-progress', { id, state: 'resolving', label: 'Resolving download links...' });
        let files = [];
        for (const l of links) {
            if (ctl.cancelled) throw new Error('Cancelled');
            const resolved = await resolveDirectUrl(l.url, { sourceId: opts.sourceId });
            if (!resolved || !resolved.length) {
                let host = 'this host'; try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch (er) {}
                let msg = 'Could not auto-resolve a direct link for ' + host + '. Use "Open game page" to download it manually.';
                if (/megadb/i.test(host)) msg = 'MegaDB requires a captcha that can\'t be bypassed automatically. Click "Open game page" and download it from the site.';
                else if (/gofile/i.test(host)) msg = 'Gofile\'s API is temporarily unavailable (their servers, not the launcher). Try again in a minute, or pick another host.';
                else if (/datanodes/i.test(host)) msg = 'DataNodes is now behind a Cloudflare "verify you are human" check, so it can\'t download automatically. Pick another host (Pixeldrain / FileKeeper / FuckingFast), or use "Open game page".';
                else if (/akirabox/i.test(host)) msg = 'AkiraBox is behind a Cloudflare "verify you are human" check (a checkbox you have to click), so it can\'t download automatically. Pick another host (Pixeldrain / FileKeeper / FuckingFast), or use "Open game page".';
                else if (/buzzheavier|bzzhr/i.test(host)) msg = 'Buzzheavier is behind a Cloudflare "verify you are human" check (a checkbox you have to click), so it can\'t download automatically. Pick another host (Pixeldrain / FileKeeper / FuckingFast), or use "Open game page".';
                throw Object.assign(new Error(msg), { needsBrowser: true });
            }
            resolved.forEach((f, idx) => files.push(Object.assign({ name: f.name || l.name, origin: l.url, originIndex: idx }, f)));
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
                    if (ctl.cancelled || /cancelled/i.test(e.message)) throw e;
                    if (attempt < 3) {
                        cleanPartial(dir, file);
                        wc.send('download-progress', { id, state: 'resolving', part: i + 1, partCount: total, label: (partLabel ? partLabel + ' — ' : '') + 'Connection lost, retrying with a fresh link...' });
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
                            label: 'Installing… ' + gb.toFixed(2) + ' GB written (this is CPU-heavy, please wait)'
                        });
                        await new Promise(r => setTimeout(r, 2500));
                    }
                })();
                try {
                    wc.send('download-progress', { id, state: 'installing', percent: 100, label: 'Starting installer… (approve the Windows prompt if it appears)' });
                    await runSilentInstall(res.exePath, installTarget, ctl, opts.skipRedist !== false);
                    polling = false;
                    const exe = findGameExe(installTarget);
                    if (exe) {
                        cleanRepackSource(dir, installTarget);   // succeeded → remove the repack files
                        res.exePath = exe;
                        res.folder = installTarget;
                        res.needsInstall = false;
                        res.installed = true;
                    } else {
                        // Installer ran but we couldn't find a game exe — keep the repack so
                        // the user can install it manually; report it instead of faking success.
                        res.installFailed = true;
                    }
                } catch (instErr) {
                    polling = false;
                    if (ctl.cancelled || /cancelled/i.test(instErr.message)) throw instErr;
                    res.installFailed = true;
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
        activeDownloads.delete(id);
        if (ctl.cancelled || /cancelled/i.test(err.message)) return { success: false, cancelled: true };
        wc.send('download-error', { id, error: err.message, url: opts.url, needsBrowser: !!err.needsBrowser });
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cancel-download', (e, id) => {
    const d = activeDownloads.get(id);
    if (d) { d.cancelled = true; try { d.proc && d.proc.kill(); } catch (err) {} activeDownloads.delete(id); return true; }
    return false;
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
    var KNOWN=/gofile\\.io|pixeldrain\\.com|datanodes|vikingfile|rootz|1fichier|mega(\\.nz|db)|mediafire|buzzheavier|fuckingfast|hexload|qiwi|multiup|bowfile|akirabox|\\.rar|\\.zip|\\.7z|part\\d+/i;
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
const OF_KNOWN_HOST = /gofile\.io|pixeldrain\.com|datanodes|vikingfile|rootz|1fichier|mega(\.nz|db)|mediafire|buzzheavier|fuckingfast|hexload|qiwi|multiup|bowfile|akirabox/i;

// Clicks tabs + DOWNLOAD buttons inside the hosters popup so each host's link is
// triggered (we capture the resulting navigation instead of following it).
const OF_POPUP_CLICK_JS = `(function(){
    var n=0;
    var els=[].slice.call(document.querySelectorAll('a,button,li,span,div,[role="tab"],[onclick]'));
    els.forEach(function(el){
        if(el.__ofc) return;
        var t=((el.textContent||'')+' '+(el.value||'')).trim().toLowerCase();
        var href=(el.href||'').toLowerCase();
        var isHostLink=/gofile|pixeldrain|datanodes|vikingfile|rootz|1fichier|mediafire|buzzheavier|fuckingfast|hexload|multiup|bowfile|mega/.test(href);
        var isDl=/^(download|скачать|загрузить|download now)$/.test(t)||isHostLink;
        var isTab=/^(pixeldrain|gofile|rootz|vikingfile|datanodes|mega|mega\\.nz|mediafire|1fichier|buzzheavier|fuckingfast|hexload)$/.test(t);
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