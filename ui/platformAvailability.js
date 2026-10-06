'use strict';

function installPlatformAvailability(document, ipc) {
    let support = null;
    function notice(message) {
        let element = document.getElementById('platformOperationNotice');
        if (!element) {
            element = document.createElement('div');
            element.id = 'platformOperationNotice';
            element.setAttribute('role', 'alert');
            element.style.cssText = 'position:fixed;bottom:16px;left:16px;max-width:520px;padding:12px 16px;background:var(--bg-color,#20232a);color:var(--text-color,#fff);border:1px solid var(--accent,#829ab1);border-radius:8px;z-index:100000;cursor:pointer;';
            element.tabIndex = 0;
            element.title = 'Click or press Escape to dismiss';
            element.style.cursor = 'pointer';
            element.addEventListener('click', () => element.remove());
            element.addEventListener('keydown', event => { if (event.key === 'Escape') element.remove(); });
            document.body.append(element);
        }
        // The close mark makes it obvious the notice can be dismissed; it also leaves on its own.
        element.textContent = `${message}   ✕`;
        if (typeof setTimeout === 'function') {
            clearTimeout(element.dismissTimer);
            element.dismissTimer = setTimeout(() => element.remove(), 10000);
        }
    }
    ipc.on('platform-operation-unavailable', (_event, message) => notice(message));
    window.addEventListener('unhandledrejection', event => {
        const message = String(event.reason && event.reason.message || event.reason || '');
        if (/SAIL_PLATFORM_UNSUPPORTED|SAIL_OFFLINE|SAIL_DESKTOP_UNAVAILABLE/.test(message)) {
            notice(message);
            event.preventDefault();
        }
    });
    const ready = ipc.invoke('platform-get-support').then(value => {
        support = value;
        if (!support.restricted) return support;
        const label = document.createElement('span');
        label.id = 'platformAvailability';
        label.textContent = ` · Linux ${support.mode === 'offline-preview' ? 'offline preview' : support.mode === 'local-fixture' ? 'private native fixtures' : 'native preview'}${support.devProfile ? ` · ${support.devProfile}` : ''}`;
        label.style.cssText = 'font-size:11px;opacity:.8;white-space:nowrap;min-width:0;flex:0 1 360px;max-width:360px;overflow:hidden;text-overflow:ellipsis;';
        label.title = support.features.nativeGames.available
            ? `Native ELF game sessions${support.features.nativeScripts && support.features.nativeScripts.available ? ' and executable script launchers' : ''}, library and settings are available. ${support.features.steamDiscovery && support.features.steamDiscovery.available ? 'Steam library metadata discovery is available; Steam launching remains unavailable.' : 'Steam remains unavailable.'} ${support.features.nativeScripts && support.features.nativeScripts.available ? '' : 'Script launchers, '}Wine, accounts and cloud remain unavailable.${support.features.downloads.available ? ' Direct HTTPS downloads and game archive import are available.' : ' Downloads remain unavailable.'}`
            : `Local library and settings are available. ${support.features.nativeGames.reason}`;
        if (support.features.localDialogs && support.features.localDialogs.available) label.title += ' Local file pickers and browser links are available.';
        if (support.features.desktopIntegration.available) label.title += ' Sail link registration is available in Settings.';
        if (support.features.autostart.available) label.title += ' Start at login is available.';
        if (support.platform === 'linux') {
            const iconPath = document.getElementById('shortcutIconPath');
            if (iconPath) iconPath.placeholder = 'Icon image (.png, .jpg, .webp, .ico) (Optional)';
            const shortcut = document.getElementById('createShortcutBtn');
            if (shortcut && !support.features.desktopShortcuts.available) {
                shortcut.disabled = true;
                shortcut.title = support.features.desktopShortcuts.reason;
            }
        }
        if (support.features.spellcheck && !support.features.spellcheck.available) label.title += ` ${support.features.spellcheck.reason}`;
        label.setAttribute('role', 'status');
        const title = document.querySelector('.titlebar-title');
        // The status label only helps in development modes; the normal app keeps the header clean.
        if (title && support.mode !== 'normal') { title.style.minWidth = '0'; title.style.flex = '1 1 auto'; title.append(label); }
        const controls = document.querySelector('.titlebar-controls');
        if (controls) controls.style.flexShrink = '0';
        const features = support.features;
        // Controls stay disabled only while the feature behind them is unavailable.
        const groups = [
            ['#autoStartToggle', features.autostart],
            ['#steamApiKeyInput, #steamIdInput, #discordTokenInput', features.accounts],
            ['[id^="custom-google-"], [id^="custom-onedrive-"], [id^="custom-dropbox-"]', features.cloudSync],
            ['#browseExeBtn', features.nativeGames],
            ['#browseSaveBtn, #browseDriveBtn, #browseEmulatorBtn, #browseRomBtn', features.saveDiscovery]
        ];
        for (const [selector, feature] of groups) {
            if (feature && feature.available) continue;
            document.querySelectorAll(selector).forEach(element => {
                element.disabled = true;
                element.title = (feature && feature.reason) || 'Unavailable on this platform.';
            });
        }
        document.addEventListener('click', event => {
            const button = event.target.closest('#pluginsBtn, #syncNowButton, .cloud-card button');
            if (!button) return;
            const feature = button.id === 'pluginsBtn' ? features.plugins : features.cloudSync;
            if (feature.available) return;
            event.preventDefault(); event.stopImmediatePropagation();
            notice(feature.reason);
        }, true);
        if (!support.trayAvailable) notice('Tray unavailable. Closing the window exits Sail for this session. Your saved close preference is unchanged.');
        return support;
    });
    return { ready, notice, get support() { return support; } };
}
module.exports = { installPlatformAvailability };
