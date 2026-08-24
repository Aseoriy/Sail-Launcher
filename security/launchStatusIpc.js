'use strict';

function exactLaunchStatusRequest(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const prototype = Object.getPrototypeOf(payload);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'gameId')) return null;
    const gameId = typeof payload.gameId === 'string' ? payload.gameId.trim() : '';
    if (!gameId || gameId.length > 128 || /[\u0000-\u001f\u007f]/.test(gameId)) return null;
    return { gameId };
}

function registerLaunchStatusIpc(ipcMain, { resolveGameMetadata }) {
    if (!ipcMain || typeof ipcMain.on !== 'function' || typeof resolveGameMetadata !== 'function') {
        throw new TypeError('Launch status IPC requires an authorized registrar and metadata resolver.');
    }
    ipcMain.on('show-launch-splash', (event, payload) => {
        const request = exactLaunchStatusRequest(payload);
        if (!request) return;
        let metadata;
        try { metadata = resolveGameMetadata(request.gameId); } catch (_) { return; }
        const name = metadata && typeof metadata.name === 'string'
            ? metadata.name.slice(0, 256)
            : 'Game';
        if (!event.sender || typeof event.sender.send !== 'function'
            || (typeof event.sender.isDestroyed === 'function' && event.sender.isDestroyed())) return;
        event.sender.send('launch-status', { phase: 'launching', name });
    });
}

module.exports = {
    exactLaunchStatusRequest,
    registerLaunchStatusIpc
};
