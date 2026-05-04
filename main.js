const { app, BrowserWindow, ipcMain, dialog, shell, screen, Tray, Menu } = require('electron');
const { exec, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const unrar = require('node-unrar-js');
const _7z = require('7zip-min');
const DiscordRPC = require('discord-rpc');

const args = process.argv;
let autoLaunchGameId = null;
const launchArg = args.find(a => a.startsWith('--launch-game-id='));
if (launchArg) autoLaunchGameId = launchArg.split('=')[1].replace(/"/g, '');

const startHidden = args.includes('--hidden');
let activeBackupProcess = null;
let backingUpZipPath = null;
let tray = null;
let isQuitting = false;

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
        webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false }
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

    win.loadFile('index.html');

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
            const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
            const savesDir = path.join(driveFolder, safeName + '_saves');
            if (!fs.existsSync(savesDir)) fs.mkdirSync(savesDir, { recursive: true });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const zipName = `${safeName}_save_${timestamp}.zip`;
            const zipPath = path.join(savesDir, zipName);

            const child = spawn('powershell.exe', ['-NoProfile', '-Command',
                `Compress-Archive -Path "${localSavePath}\\*" -DestinationPath "${zipPath}" -Force`
            ]);
            child.on('close', (code) => {
                if (code === 0 && maxVersions > 0) {
                    try {
                        const prefix = `${safeName}_save_`;
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
        const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
        const savesDir = path.join(driveFolder, safeName + '_saves');
        if (!fs.existsSync(savesDir)) return [];
        const prefix = `${safeName}_save_`;
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
            const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
            const savesDir = path.join(driveFolder, safeName + '_saves');
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
        const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
        const savesDir = path.join(driveFolder, safeName + '_saves');
        if (fs.existsSync(savesDir)) { shell.openPath(savesDir); return true; }
    } catch (err) { }
    return false;
});

ipcMain.on('window-min', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window-max', (e) => { const win = BrowserWindow.fromWebContents(e.sender); if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('window-close', (e, exitWhenClosed) => {
    if (exitWhenClosed) { isQuitting = true; app.quit(); }
    else { BrowserWindow.fromWebContents(e.sender)?.hide(); }
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

    // Handle protocol URL on first launch (Windows)
    app.on('open-url', (e, url) => { e.preventDefault(); handleProtocolUrl(url); });

    app.commandLine.appendSwitch('enable-features', 'GamepadButtonAxisEvents');

    app.whenReady().then(() => {
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