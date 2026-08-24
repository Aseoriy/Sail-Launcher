'use strict';

function exactLaunchStatus(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const prototype = Object.getPrototypeOf(payload);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.keys(payload).length !== 2 || payload.phase !== 'launching' || typeof payload.name !== 'string') return null;
    return { phase: 'launching', name: payload.name.slice(0, 256) };
}

function renderLaunchStatus(document, payload) {
    const status = exactLaunchStatus(payload);
    const container = document && document.getElementById('launchStatus');
    const message = document && document.getElementById('launchStatusMessage');
    if (!status || !container || !message) return false;
    message.textContent = `🚀 Launching ${status.name || 'Game'}...`;
    container.hidden = false;
    return true;
}

function bindLaunchStatus(document, ipcRenderer, options = {}) {
    if (!ipcRenderer || typeof ipcRenderer.on !== 'function') return () => {};
    const durationMs = Number.isInteger(options.durationMs) && options.durationMs >= 0
        ? Math.min(options.durationMs, 10000)
        : 2500;
    let hideTimer = null;
    const listener = (_event, payload) => {
        if (!renderLaunchStatus(document, payload)) return;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            const container = document && document.getElementById('launchStatus');
            if (container) container.hidden = true;
        }, durationMs);
    };
    ipcRenderer.on('launch-status', listener);
    return () => {
        clearTimeout(hideTimer);
        if (typeof ipcRenderer.removeListener === 'function') ipcRenderer.removeListener('launch-status', listener);
    };
}

module.exports = {
    bindLaunchStatus,
    exactLaunchStatus,
    renderLaunchStatus
};
