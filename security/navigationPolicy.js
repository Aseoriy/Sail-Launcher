'use strict';

const { isTrustedLocalDocument } = require('./ipcAuthorization');

const STORE_PARTITION = 'persist:sailhub-mods';
const SOURCES_PARTITION = 'persist:sail-sources';
const ALLOWED_GUEST_PARTITIONS = Object.freeze([STORE_PARTITION, SOURCES_PARTITION]);

function parseExternalWebUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl || rawUrl !== rawUrl.trim()) return null;
    const hasUnsafeCharacter = [...rawUrl].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 || character === '\\';
    });
    if (hasUnsafeCharacter || !/^https?:\/\//i.test(rawUrl)) return null;
    try {
        const parsed = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        if (!parsed.hostname || parsed.username || parsed.password) return null;
        return parsed.href;
    } catch (error) {
        return null;
    }
}

function openExternalWebUrl(shell, rawUrl) {
    const safeUrl = parseExternalWebUrl(rawUrl);
    if (!safeUrl) return false;
    try {
        const result = shell.openExternal(safeUrl);
        if (result && typeof result.catch === 'function') result.catch(() => {});
        return true;
    } catch (error) {
        return false;
    }
}

function installMainNavigationPolicy(webContents, { shell, trustedEntryPath }) {
    const handleTopLevelNavigation = (event, rawUrl) => {
        if (isTrustedLocalDocument(rawUrl, trustedEntryPath)) return;
        event.preventDefault();
        openExternalWebUrl(shell, rawUrl);
    };

    webContents.on('will-navigate', (event, rawUrl) => handleTopLevelNavigation(event, rawUrl));
    webContents.on('will-redirect', (event, rawUrl) => handleTopLevelNavigation(event, rawUrl));
    webContents.on('will-frame-navigate', event => {
        if (event.isMainFrame) return;
        event.preventDefault();
    });
    webContents.setWindowOpenHandler(({ url }) => {
        openExternalWebUrl(shell, url);
        return { action: 'deny' };
    });
}

function hardenGuestPreferences(webPreferences) {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.enableRemoteModule = false;
    webPreferences.webviewTag = false;
}

function isAllowedGuestNavigation(rawUrl) {
    return rawUrl === 'about:blank' || parseExternalWebUrl(rawUrl) !== null;
}

function isSailLauncherInstallUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl || rawUrl !== rawUrl.trim()) return false;
    let parsed;
    try { parsed = new URL(rawUrl); } catch (_) { return false; }
    if (parsed.protocol !== 'sail-launcher:' || !['install-theme', 'install-plugin'].includes(parsed.hostname)
        || parsed.username || parsed.password || parsed.port || parsed.hash
        || (parsed.pathname && parsed.pathname !== '/')) return false;
    const keys = [...parsed.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'url') return false;
    return parseExternalWebUrl(parsed.searchParams.get('url')) !== null;
}

function installGuestNavigationPolicy(guestContents, { shell, onSailLauncherProtocol }) {
    guestContents.setWindowOpenHandler(({ url }) => {
        openExternalWebUrl(shell, url);
        return { action: 'deny' };
    });
    const handleNavigation = (event, rawUrl) => {
        if (isSailLauncherInstallUrl(rawUrl)) {
            event.preventDefault();
            if (typeof onSailLauncherProtocol === 'function') onSailLauncherProtocol(rawUrl);
            return;
        }
        if (!isAllowedGuestNavigation(rawUrl)) event.preventDefault();
    };
    guestContents.on('will-navigate', handleNavigation);
    guestContents.on('will-redirect', handleNavigation);
}

function installWebviewAttachmentPolicy(hostContents, { shell, session, onSailLauncherProtocol }) {
    const allowedSessions = new Set(ALLOWED_GUEST_PARTITIONS.map(partition => session.fromPartition(partition)));

    hostContents.on('will-attach-webview', (event, webPreferences, params) => {
        const partition = String((params && params.partition) || webPreferences.partition || '');
        const initialUrl = String((params && params.src) || 'about:blank');
        if (!ALLOWED_GUEST_PARTITIONS.includes(partition) || !isAllowedGuestNavigation(initialUrl)) {
            event.preventDefault();
            return;
        }
        hardenGuestPreferences(webPreferences);
    });

    hostContents.on('did-attach-webview', (_event, guestContents) => {
        if (!allowedSessions.has(guestContents.session)) {
            guestContents.destroy();
            return;
        }
        const preferences = typeof guestContents.getLastWebPreferences === 'function'
            ? guestContents.getLastWebPreferences()
            : {};
        const unsafe = preferences.nodeIntegration
            || preferences.nodeIntegrationInSubFrames
            || preferences.contextIsolation !== true
            || preferences.sandbox !== true
            || preferences.webSecurity === false
            || !!preferences.preload;
        if (unsafe) {
            guestContents.destroy();
            return;
        }
        installGuestNavigationPolicy(guestContents, { shell, onSailLauncherProtocol });
    });
}

function installIsolatedRemoteNavigationPolicy(webContents, { shell }) {
    webContents.on('will-navigate', (event, rawUrl) => {
        if (!isAllowedGuestNavigation(rawUrl)) event.preventDefault();
    });
    webContents.on('will-redirect', (event, rawUrl) => {
        if (!isAllowedGuestNavigation(rawUrl)) event.preventDefault();
    });
    webContents.setWindowOpenHandler(({ url }) => {
        openExternalWebUrl(shell, url);
        return { action: 'deny' };
    });
}

module.exports = {
    ALLOWED_GUEST_PARTITIONS,
    SOURCES_PARTITION,
    STORE_PARTITION,
    hardenGuestPreferences,
    installGuestNavigationPolicy,
    installIsolatedRemoteNavigationPolicy,
    installMainNavigationPolicy,
    installWebviewAttachmentPolicy,
    isSailLauncherInstallUrl,
    isAllowedGuestNavigation,
    openExternalWebUrl,
    parseExternalWebUrl
};
