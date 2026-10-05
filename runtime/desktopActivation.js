'use strict';

function launchIdFromArguments(args) {
    const prefix = '--launch-game-id=';
    const argument = args.find(value => typeof value === 'string' && value.startsWith(prefix));
    if (!argument) return null;
    let id = argument.slice(prefix.length);
    if (id.startsWith('"') && id.endsWith('"')) id = id.slice(1, -1);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : null;
}

function createDesktopActivation({ initialArguments, getWindow }) {
    let pending = launchIdFromArguments(initialArguments);
    let ready = false;
    function focus() {
        const window = getWindow();
        if (!window || window.isDestroyed()) return false;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        return true;
    }
    return {
        focus,
        resetRenderer() { ready = false; },
        rendererReady() {
            ready = true;
            const id = pending;
            pending = null;
            return id;
        },
        receiveArguments(args) {
            focus();
            const id = launchIdFromArguments(args);
            if (!id) return;
            const window = getWindow();
            if (ready && window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
                window.webContents.send('shortcut-triggered', id);
            } else {
                // Only the latest shortcut requested while loading is launched.
                pending = id;
            }
        }
    };
}

module.exports = { createDesktopActivation };
