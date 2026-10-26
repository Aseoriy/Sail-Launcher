'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');

// KDE Plasma ends a session (log out, restart, shut down) by closing every window and waiting
// for them to go away. Sail's close-to-tray would keep Plasma waiting until it gives up, about
// two minutes later. Plasma's shutdown service only runs once the user has confirmed, so while
// it is on the session bus, a window close means the session is ending. Other desktops end the
// session with SIGTERM, which Sail already handles.
const SHUTDOWN_SERVICE = 'org.kde.Shutdown';
const DBUS_SEND = ['/usr/bin/dbus-send', '/bin/dbus-send'];

function plasmaSessionEnding({ execFileImpl = execFile, exists = fs.existsSync, timeout = 1500 } = {}) {
    const tool = DBUS_SEND.find(file => exists(file));
    if (!tool) return Promise.resolve(false);
    return new Promise(resolve => {
        execFileImpl(tool, ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus.NameHasOwner', `string:${SHUTDOWN_SERVICE}`], { timeout, encoding: 'utf8' },
        (error, stdout) => resolve(!error && /\bboolean true\b/.test(String(stdout || ''))));
    });
}

module.exports = { SHUTDOWN_SERVICE, plasmaSessionEnding };
