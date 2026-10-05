'use strict';

const { parseExternalWebUrl } = require('../security/navigationPolicy');

const LOCAL_DIALOG_CHANNELS = Object.freeze([
    'dialog-select-folder', 'dialog-select-file', 'dialog-select-image', 'dialog-select-font',
    'dialog-select-icon', 'dialog-save-json', 'dialog-open-json', 'dialog-save-theme', 'dialog-open-theme'
]);

function desktopUnavailable(message) {
    const error = new Error(`SAIL_DESKTOP_UNAVAILABLE: ${message}`);
    error.code = 'SAIL_DESKTOP_UNAVAILABLE';
    return error;
}

function registerLocalDesktopIpc({ ipcMain, dialog, shell, BrowserWindow, platform = process.platform }) {
    const linux = platform === 'linux';
    async function picker(event, method, options) {
        try {
            let result;
            if (linux) {
                const parent = BrowserWindow.fromWebContents(event.sender);
                if (!parent || parent.isDestroyed()) throw new Error('Dialog parent is unavailable.');
                result = await dialog[method](parent, options);
            } else result = await dialog[method](options);
            if (result.canceled) return null;
            const selected = method === 'showSaveDialog' ? result.filePath : result.filePaths[0];
            if (typeof selected !== 'string' || !selected) throw new Error('No file was selected.');
            return selected;
        } catch (error) {
            if (!linux) throw error;
            throw desktopUnavailable('The file picker could not be opened or did not return a selection. Please try again.');
        }
    }
    function open(event, filters) {
        const options = { properties: ['openFile'] };
        if (filters) options.filters = filters;
        return picker(event, 'showOpenDialog', options);
    }
    const filter = (name, extensions) => [{ name, extensions }];
    ipcMain.handle('dialog-select-folder', (event, defaultPath) => {
        const options = { properties: ['openDirectory'] };
        if (defaultPath !== undefined && defaultPath !== null && defaultPath !== '') {
            if (typeof defaultPath !== 'string' || defaultPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(defaultPath)) {
                throw new Error('The file picker default path is invalid.');
            }
            // This is a starting-location hint, never a selection or execution grant.
            options.defaultPath = defaultPath;
        }
        return picker(event, 'showOpenDialog', options);
    });
    ipcMain.handle('dialog-select-file', event => open(event,
        linux ? undefined : filter('Executables & Shortcuts', ['exe', 'lnk', 'bat', 'cmd'])));
    ipcMain.handle('dialog-select-image', event => open(event, filter('Images', ['jpg', 'png', 'jpeg', 'webp', 'ico'])));
    ipcMain.handle('dialog-select-font', event => open(event, filter('Fonts', ['ttf', 'otf', 'woff', 'woff2'])));
    ipcMain.handle('dialog-select-icon', event => open(event, linux
        ? filter('Images', ['png', 'jpg', 'jpeg', 'webp', 'ico']) : filter('Icons & Executables', ['ico', 'exe'])));
    for (const [kind, name, defaultPath] of [['json', 'JSON', 'sail_library_backup.json'], ['theme', 'JSON Theme', 'my_theme.json']]) {
        ipcMain.handle(`dialog-save-${kind}`, event => {
            const options = { defaultPath, filters: filter(name, ['json']) };
            if (linux) options.properties = ['showOverwriteConfirmation'];
            return picker(event, 'showSaveDialog', options);
        });
        ipcMain.handle(`dialog-open-${kind}`, event => open(event, filter(name, ['json'])));
    }
    ipcMain.handle('open-url', async (_event, rawUrl) => {
        const url = parseExternalWebUrl(rawUrl);
        if (!url) throw new Error('This link cannot be opened.');
        try { await shell.openExternal(url); }
        catch (error) {
            if (!linux) throw error;
            throw desktopUnavailable('The link could not be opened in your default browser. Check your browser setting and try again.');
        }
        return true;
    });
}

module.exports = { LOCAL_DIALOG_CHANNELS, registerLocalDesktopIpc };
