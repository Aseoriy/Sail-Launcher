'use strict';

// Chromium decides which password store backs Electron's safeStorage from the desktop's name. It knows GNOME and the
// desktops built on it, and KDE, and anything else (sway, Hyprland, i3, LXQt, a bare window manager) falls back to a
// store that protects nothing, even when a working keyring such as GNOME Keyring or KeePassXC is running. Sail refuses
// that weak store, so on those desktops accounts would look unavailable for no good reason.
//
// Outside KDE, ask for the libsecret store (the standard Secret Service). If no Secret Service is running Chromium
// falls back to the weak store exactly as before, and Sail still reports that accounts need a keyring.
function choosePasswordStore({ platform = process.platform, desktop = '', argv = [] } = {}) {
    if (platform !== 'linux') return '';
    if (argv.some(argument => typeof argument === 'string' && argument.startsWith('--password-store'))) return '';
    const names = String(desktop).toLowerCase().split(':');
    if (names.some(name => name === 'kde' || name === 'plasma')) return '';
    return 'gnome-libsecret';
}

module.exports = { choosePasswordStore };
