'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const IPC_FORBIDDEN_CODE = 'SAIL_IPC_FORBIDDEN';

function forbiddenIpcError() {
    const error = new Error('This request is not allowed from the current page.');
    error.code = IPC_FORBIDDEN_CODE;
    return error;
}

function isTrustedLocalDocument(rawUrl, trustedEntryPath) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.host) return false;
        const actualPath = path.resolve(fileURLToPath(parsed));
        const expectedPath = path.resolve(trustedEntryPath);
        return process.platform === 'win32'
            ? actualPath.toLowerCase() === expectedPath.toLowerCase()
            : actualPath === expectedPath;
    } catch (error) {
        return false;
    }
}

function createTrustedFrameAuthorizer({ getMainWindow, trustedEntryPath }) {
    if (typeof getMainWindow !== 'function' || !trustedEntryPath) {
        throw new TypeError('Trusted renderer authorization requires a main window and entry path.');
    }

    return function authorizeIpcEvent(event) {
        const win = getMainWindow();
        const sender = event && event.sender;
        const senderFrame = event && event.senderFrame;
        const mainContents = win && !win.isDestroyed() ? win.webContents : null;
        const mainFrame = mainContents && mainContents.mainFrame;

        if (!mainContents || !sender || !senderFrame) throw forbiddenIpcError();
        if (sender !== mainContents || senderFrame !== mainFrame) throw forbiddenIpcError();
        if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) throw forbiddenIpcError();
        if (typeof senderFrame.isDestroyed === 'function' && senderFrame.isDestroyed()) throw forbiddenIpcError();
        if (senderFrame.top && senderFrame.top !== senderFrame) throw forbiddenIpcError();
        if (sender.session !== mainContents.session) throw forbiddenIpcError();
        if (!isTrustedLocalDocument(senderFrame.url, trustedEntryPath)) throw forbiddenIpcError();
        if (!isTrustedLocalDocument(mainContents.getURL(), trustedEntryPath)) throw forbiddenIpcError();
        return true;
    };
}

function createAuthorizedIpcRegistrar(electronIpcMain, authorizeIpcEvent) {
    if (!electronIpcMain || typeof authorizeIpcEvent !== 'function') {
        throw new TypeError('Authorized IPC registration requires ipcMain and an authorizer.');
    }

    return {
        handle(channel, handler) {
            electronIpcMain.handle(channel, (event, ...args) => {
                authorizeIpcEvent(event, channel);
                return handler(event, ...args);
            });
        },
        on(channel, handler) {
            electronIpcMain.on(channel, (event, ...args) => {
                try {
                    authorizeIpcEvent(event, channel);
                } catch (error) {
                    if (!error || error.code !== IPC_FORBIDDEN_CODE) {
                        console.warn('Sail IPC request denied.');
                    }
                    return;
                }
                handler(event, ...args);
            });
        }
    };
}

module.exports = {
    IPC_FORBIDDEN_CODE,
    createAuthorizedIpcRegistrar,
    createTrustedFrameAuthorizer,
    forbiddenIpcError,
    isTrustedLocalDocument
};
