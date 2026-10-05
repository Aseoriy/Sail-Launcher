'use strict';

const { LOCAL_DIALOG_CHANNELS } = require('./localDesktop');

const NATIVE_SCRIPT_UNAVAILABLE_REASON = 'Native script launchers are unavailable until the installed supervisor supports script-relative execution. Choose a native ELF executable if the game provides one. Existing local setup has not been changed.';

const LOCAL_HANDLES = new Set([
    'platform-get-support', 'get-user-data', 'get-common-paths', 'get-displays',
    'get-system-specs', 'get-auto-launch', 'desktop-protocol-ready', 'desktop-protocol-ack', 'account-get-state',
    'profiles-bootstrap', 'profiles-get-state', 'profiles-load-active',
    'profiles-capture-active', 'profiles-remove-game', 'profiles-create',
    'profiles-update', 'profiles-delete', 'profiles-unlock', 'profiles-switch',
    'profiles-create-library', 'profiles-switch-library', 'profiles-create-preset',
    'profiles-switch-preset', 'authority-get-game-status',
    'downloaded-game-uninstall-status', 'authority-get-device-root-status'
]);
const LOCAL_EVENTS = new Set([
    'set-exit-behavior', 'set-devtools-setting', 'window-min',
    'window-fullscreen-toggle', 'window-set-fullscreen', 'window-close',
    'move-to-display-fullscreen', 'exit-sync-completed', 'exit-sync-failed',
    'show-game-context', 'restart-app'
]);

function createPlatformSupport({ platform = process.platform, arch = process.arch,
    isolated = process.env.SAIL_DEV_ISOLATED === '1', mode = isolated ? process.env.SAIL_DEV_MODE || 'offline-preview' : 'normal',
    packaged = false, nativeReadiness = { available: false, reason: 'The native supervisor has not been checked.' } } = {}) {
    const preview = mode === 'offline-preview';
    const restricted = isolated || platform === 'linux';
    const features = {};
    features.nativeScripts = { available: false, reason: NATIVE_SCRIPT_UNAVAILABLE_REASON };
    features.protonSetup = { available: false, reason: 'Proton setup is unavailable without the Linux x64 native supervisor.' };
    features.standaloneProton = { available: false, reason: require('./proton/manager').LAUNCH_PENDING_REASON };
    features.localProfiles = { available: true, reason: '' };
    const localDesktop = !restricted || (platform === 'linux' && arch === 'x64' && mode === 'normal' && !isolated);
    features.localDialogs = { available: localDesktop, reason: localDesktop ? '' : 'Local file pickers are unavailable in this platform mode.' };
    features.externalLinks = { available: localDesktop, reason: localDesktop ? '' : 'Opening links in the default browser is unavailable in this platform mode.' };
    features.autostart = { available: localDesktop, reason: localDesktop ? '' : 'Start at login is unavailable in this platform mode.' };
    const steamDiscovery = platform === 'linux' && arch === 'x64' && mode === 'normal' && !isolated;
    features.steamMetadata = { available: steamDiscovery, reason: steamDiscovery ? '' : 'Online Steam metadata is unavailable in this platform mode.' };
    features.steamDiscovery = { available: steamDiscovery, reason: steamDiscovery ? '' : 'Local Steam library discovery is unavailable in this platform mode.' };
    features.desktopShortcuts = { available: !restricted, reason: restricted
        ? 'Desktop shortcuts are unavailable until a native Linux game is ready in normal mode.' : '' };
    const nativeRecovery = platform === 'linux' && arch === 'x64' && mode !== 'offline-preview';
    features.nativeRecovery = { available: nativeRecovery, reason: nativeRecovery ? '' : 'Native session recovery is unavailable in this platform mode.' };
    features.spellcheck = { available: !restricted, reason: restricted
        ? 'Optional spellchecking is unavailable on Linux and in isolated profiles to prevent native dictionary downloads.' : '' };
    for (const [key, label] of Object.entries({
        nativeGames: 'Native Linux ELF game launching', steamProton: 'Steam-managed Proton',
        standaloneWine: 'Standalone Windows games through Wine', downloads: 'Downloads and installation',
        accounts: 'Accounts and protected credentials', cloudSync: 'Cloud synchronization',
        saveDiscovery: 'Save discovery and backup', achievements: 'Achievement discovery',
        plugins: 'Plugin execution', desktopIntegration: 'Protocol registration',
        remoteContent: 'Remote content and browser integrations', discord: 'Discord integration'
    })) features[key] = { available: !restricted, reason: restricted ? `${label} is unavailable in this offline Linux boot milestone.` : '' };
    if (platform === 'linux') {
        features.downloads = { available: localDesktop, reason: localDesktop ? '' : 'Linux downloads and archive import are unavailable in this platform mode.' };
        const available = localDesktop && packaged;
        features.desktopIntegration = { available, reason: available ? ''
            : 'Sail link registration is unavailable in this mode. Use a packaged Linux build.' };
    }
    for (const name of ['steamProton', 'standaloneWine']) {
        features[name] = { available: false, reason: 'This compatibility path is unavailable; it is a required later Linux milestone.' };
    }
    if (platform === 'linux' && arch === 'x64' && mode !== 'offline-preview') {
        features.nativeGames = { ...nativeReadiness };
        features.protonSetup = { available: !!nativeReadiness.available, reason: nativeReadiness.available ? '' : nativeReadiness.reason };
        features.nativeScripts = { available: !!nativeReadiness.available && nativeReadiness.scriptsAvailable === true,
            reason: nativeReadiness.available && nativeReadiness.scriptsAvailable === true ? '' : NATIVE_SCRIPT_UNAVAILABLE_REASON };
        features.desktopShortcuts.available = !isolated && !!nativeReadiness.available;
        if (features.desktopShortcuts.available) features.desktopShortcuts.reason = '';
    }
    return { platform, arch, isolated, mode, preview, restricted, devProfile: isolated ? process.env.SAIL_DEV_PROFILE || 'default' : null, features };
}

function unsupportedError(channel, reason = '') {
    const error = new Error(`SAIL_PLATFORM_UNSUPPORTED: ${reason || `${channel} is unavailable in this platform mode. Local library and settings remain available.`}`);
    error.code = 'SAIL_PLATFORM_UNSUPPORTED';
    return error;
}

// Availability is an additional restriction; the existing sender and local
// execution-capability authorization still runs for supported operations.
function createSupportedIpcRegistrar(ipcMain, authorize, support) {
    if (!support.restricted) return ipcMain;
    const nativeHandles = new Set(['authority-get-native-setup', 'authority-select-executable', 'authority-select-working-directory', 'authority-configure-execution',
        'launch-game', 'proton-list-runtimes', 'proton-register-runtime', 'wine-register-runtime', 'proton-environment-status', 'proton-prepare-environment',
        'proton-save-status', 'proton-import-save', 'compatibility-status', 'compatibility-releases', 'compatibility-install',
        'compatibility-cancel', 'compatibility-remove', 'compatibility-default', 'compatibility-check', 'compatibility-setup',
        'compatibility-dismiss-setup', 'proton-launch-log', 'proton-installation-status', 'proton-prerequisites',
        'proton-run-installer', 'proton-installation-cancel', 'proton-check-online-prerequisites',
        'proton-install-online-prerequisites', 'proton-cancel-online-prerequisites', 'proton-first-launch-plan', 'proton-first-launch-begin']);
    const downloadHandles = new Set(['download-game', 'cancel-download', 'pick-download-folder', 'linux-download-import', 'linux-download-list', 'linux-download-adopt', 'linux-download-status', 'linux-download-configure', 'linux-download-open', 'get-download-quarantine-summary', 'clear-download-quarantine', 'open-download-quarantine', 'pause-download', 'open-folder-capability']);
    const recoveryHandles = new Set(['kill-game-process', 'runtime-recovery-state', 'runtime-session-pending', 'runtime-session-acknowledge']);
    const discoveryHandles = new Set(['import-steam-games']);
    const shortcutHandles = new Set(['create-shortcut']);
    const protocolHandles = new Set(['desktop-protocol-status', 'desktop-register-protocol']);
    const autostartHandles = new Set(['get-autostart', 'set-autostart']);
    const dialogHandles = new Set(LOCAL_DIALOG_CHANNELS);
    const allowed = channel => (support.features.downloads.available && downloadHandles.has(channel)) || LOCAL_HANDLES.has(channel) || (support.features.nativeGames.available && nativeHandles.has(channel))
        || (support.features.nativeRecovery.available && recoveryHandles.has(channel))
        || (support.features.steamDiscovery.available && discoveryHandles.has(channel))
        || (support.features.desktopShortcuts.available && shortcutHandles.has(channel))
        || (support.features.desktopIntegration.available && protocolHandles.has(channel))
        || (support.features.autostart.available && autostartHandles.has(channel))
        || (support.features.localDialogs.available && dialogHandles.has(channel))
        || (support.features.externalLinks.available && channel === 'open-url');
    const reason = channel => nativeHandles.has(channel) ? support.features.nativeGames.reason :
        discoveryHandles.has(channel) ? support.features.steamDiscovery.reason :
        shortcutHandles.has(channel) ? support.features.desktopShortcuts.reason :
        protocolHandles.has(channel) ? support.features.desktopIntegration.reason :
        autostartHandles.has(channel) ? support.features.autostart.reason :
        dialogHandles.has(channel) ? support.features.localDialogs.reason :
        channel === 'open-url' ? support.features.externalLinks.reason :
        /steam|import/.test(channel) ? support.features.steamProton.reason : '';
    return {
        handle(channel, handler) {
            ipcMain.handle(channel, (event, ...args) => {
                authorize(event, channel);
                const steamMetadata = channel === 'remote-data' && support.features.steamMetadata?.available
                    && ['steam.searchApps', 'steam.storeSearch', 'steam.appDetails'].includes(args[0]?.operation);
                const sourceMetadata = channel === 'remote-data' && support.features.downloads.available
                    && ['source.search', 'source.detail', 'source.fitgirlCovers'].includes(args[0]?.operation);
                if (!allowed(channel) && !steamMetadata && !sourceMetadata) throw unsupportedError(channel, reason(channel));
                return handler(event, ...args);
            });
        },
        on(channel, handler) {
            ipcMain.on(channel, (event, ...args) => {
                try { authorize(event, channel); } catch (_) { return; }
                if (!LOCAL_EVENTS.has(channel)) {
                    event.sender.send('platform-operation-unavailable', unsupportedError(channel).message);
                    return;
                }
                handler(event, ...args);
            });
        }
    };
}

module.exports = { NATIVE_SCRIPT_UNAVAILABLE_REASON, createPlatformSupport, createSupportedIpcRegistrar, unsupportedError };
