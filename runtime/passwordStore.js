'use strict';

// Chromium picks the safeStorage backend from the desktop name and only knows GNOME-ish desktops
// and KDE. Everywhere else (sway, Hyprland, i3, LXQt...) it falls back to a store that protects
// nothing, even with a keyring running, and Sail refuses that. So outside KDE ask for libsecret.
// No Secret Service running = same weak fallback as before, and Sail says it needs a keyring.
function choosePasswordStore({ platform = process.platform, desktop = '', argv = [] } = {}) {
    if (platform !== 'linux') return '';
    if (argv.some(argument => typeof argument === 'string' && argument.startsWith('--password-store'))) return '';
    const names = String(desktop).toLowerCase().split(':');
    if (names.some(name => name === 'kde' || name === 'plasma')) return '';
    return 'gnome-libsecret';
}

module.exports = { choosePasswordStore };
