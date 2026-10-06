'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const resolver = require('./systemBrowserResolver');

// Some hosts (FileDitch) run an interactive Cloudflare check that never passes while a debugger is attached
// to the page. This path opens the installed browser, points it at the page once, detaches, and lets the
// person finish the check and the download exactly as in an ordinary browser. The browser saves the file
// into a folder Sail owns, which is then watched until the file is complete.

const POLL_MS = 1000;
const STALL_MS = 5 * 60 * 1000;
const DEFAULT_WAIT_MS = 20 * 60 * 1000;

const safeFileName = value => {
    const name = String(value || '').trim().replace(/[\\/:<>|?*\u0000-\u001f\u007f]/g, '_').slice(0, 180);
    return !name || /^\.+$/.test(name) || name.startsWith('.') ? 'download.bin' : name;
};

// Hosts become "MAP host ~NOTFOUND" rules so the ad blocker works without a debugger.
function adBlockResolverRules(hosts = [], allowedHosts = []) {
    const allowed = new Set(allowedHosts.map(host => String(host).toLowerCase()));
    const rules = [];
    for (const raw of new Set(hosts)) {
        const host = String(raw || '').trim().toLowerCase();
        if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || allowed.has(host)) continue;
        rules.push(`MAP ${host} ~NOTFOUND`, `MAP *.${host} ~NOTFOUND`);
    }
    return rules.join(', ');
}

// The browser writes "<name>.crdownload" (or "Unconfirmed N.crdownload") while a transfer runs, then renames it.
function inspectDownloadFolder(directory) {
    const state = { partial: 0, partialFiles: 0, complete: [] };
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return state; }
    for (const entry of entries) {
        if (entry.name.startsWith('.') && !/\.crdownload$/i.test(entry.name)) continue;
        if (!entry.isFile()) continue;
        let size = 0;
        try { size = fs.lstatSync(path.join(directory, entry.name)).size; } catch (_) { continue; }
        if (/\.crdownload$/i.test(entry.name) || /\.tmp$/i.test(entry.name)) { state.partial += size; state.partialFiles++; }
        else state.complete.push({ name: entry.name, size });
    }
    return state;
}

async function downloadInSystemBrowser(options = {}) {
    const signal = options.signal || null;
    resolver.throwIfAborted(signal);
    const parsed = new URL(String(options.url || ''));
    const loopbackTest = options.allowLoopbackHttp === true && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
    if (!loopbackTest && (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port && parsed.port !== '443')) {
        throw new Error('Browser downloads require a credential-free HTTPS URL.');
    }
    if (typeof options.isAllowedUrl === 'function' && !options.isAllowedUrl(parsed)) throw new Error('Browser download refused this host.');
    let referrer = '';
    if (options.referer) {
        try {
            const candidate = new URL(String(options.referer));
            if (candidate.protocol === 'https:' && !candidate.username && !candidate.password) { candidate.hash = ''; referrer = candidate.href; }
        } catch (_) { /* A malformed referrer is simply not sent. */ }
    }
    const executablePath = options.executablePath || resolver.findSystemChromiumExecutable(options);
    if (!executablePath) return null;
    const directory = path.resolve(String(options.directory || ''));
    if (!options.directory || !fs.statSync(directory).isDirectory()) throw new Error('The download folder is missing.');

    const tempRoot = path.resolve(options.tempRoot || path.join(directory, '.sail-browser'));
    fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    const profileDirectory = fs.mkdtempSync(path.join(tempRoot, 'profile-'));
    const stagingDirectory = fs.mkdtempSync(path.join(directory, '.browser-download-'));
    fs.mkdirSync(path.join(profileDirectory, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profileDirectory, 'Default', 'Preferences'), JSON.stringify({
        download: { default_directory: stagingDirectory, prompt_for_download: false, directory_upgrade: true },
        savefile: { default_directory: stagingDirectory },
        profile: { default_content_setting_values: { automatic_downloads: 1 } }
    }), { mode: 0o600 });

    const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const waitMs = Math.max(5000, Number(options.waitMs) || DEFAULT_WAIT_MS);
    const spawnImpl = options.spawn || spawn;
    let child = null, debugPort = 0;
    const closeWindow = async () => {
        try {
            if (debugPort && child && child.exitCode === null) {
                const version = await resolver.requestJson(debugPort, '/json/version');
                if (version && resolver.isLoopbackDebuggerUrl(version.webSocketDebuggerUrl, debugPort, 'browser')) {
                    const browser = await resolver.connectCdp(version.webSocketDebuggerUrl, { timeoutMs: 2000 });
                    await browser.send('Browser.close', {}, 1500).catch(() => {});
                    browser.close();
                }
            }
        } catch (_) { /* The process is stopped below. */ }
        const stopAt = Date.now() + 1800;
        while (child && child.exitCode === null && Date.now() < stopAt) await new Promise(resolve => setTimeout(resolve, 60));
        try { if (child && child.exitCode === null) child.kill(); } catch (_) {}
    };
    const minimizeWindow = async () => {
        try {
            const pageUrl = await resolver.waitForPageTarget(debugPort, Date.now() + 3000, signal);
            const page = await resolver.connectCdp(pageUrl, { timeoutMs: 2000 });
            try { await resolver.minimizeBrowserWindow(page); } finally { page.close(); }
        } catch (_) { /* The window just stays where it is. */ }
    };
    const onAbort = () => { try { if (child && child.exitCode === null) child.kill(); } catch (_) {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
        debugPort = await resolver.reserveLoopbackPort();
        resolver.throwIfAborted(signal);
        const args = resolver.systemChromiumLaunchArgs(debugPort, profileDirectory, {
            visible: options.headless !== true, appMode: options.headless !== true, parentBounds: options.parentBounds, platform: options.platform || 'linux'
        });
        const extra = ['--block-new-web-contents', '--disable-session-crashed-bubble'];
        const rules = adBlockResolverRules(options.blockedHosts, options.allowedResourceHosts);
        if (rules) extra.push('--host-resolver-rules=' + rules);
        // Extra switches must come before the final start-page argument.
        args.splice(args.length - 1, 0, ...extra);
        child = spawnImpl(executablePath, args, { stdio: 'ignore' });
        const pageDebuggerUrl = await resolver.waitForPageTarget(debugPort, Date.now() + 30000, signal);
        const page = await resolver.connectCdp(pageDebuggerUrl, { timeoutMs: 3000 });
        try {
            await page.send('Page.navigate', { url: parsed.href, ...(referrer ? { referrer, referrerPolicy: 'strictOriginWhenCrossOrigin' } : {}) }, 10000);
        } finally { page.close(); }   // Nothing stays attached while the host decides whether this is a person.
        if (typeof options.onWindowOpened === 'function') { try { options.onWindowOpened(); } catch (_) {} }
        report({ label: 'Complete the check in the browser window — Sail picks the file up when the download starts…' });

        const startedAt = Date.now(), speedStart = { at: 0, bytes: 0 };
        let begun = false, lastBytes = 0, lastGrowth = Date.now(), stable = null, minimized = false, offSite = 0;
        for (;;) {
            resolver.throwIfAborted(signal);
            await resolver.delayWithSignal(POLL_MS, signal);
            // The browser's plain HTTP target list (no debugger session) shows where the tab is. Hosts send the tab
            // back to the site that linked them when a file is gone, so leaving the host means the link is dead.
            if (!begun && typeof options.isAllowedUrl === 'function') {
                const tabs = await resolver.requestJson(debugPort, '/json/list', 800).catch(() => null);
                const tab = Array.isArray(tabs) && tabs.find(item => item && item.type === 'page');
                let location = null;
                try { location = tab && /^https?:/i.test(tab.url) ? new URL(tab.url) : null; } catch (_) {}
                offSite = location && !options.isAllowedUrl(location) ? offSite + 1 : 0;
                if (offSite >= 2) throw Object.assign(new Error('The host sent the browser to ' + location.hostname + ' instead of the file.'), { redirectedAway: true, destination: location.hostname });
            }
            const state = inspectDownloadFolder(stagingDirectory);
            const bytes = state.partial + state.complete.reduce((sum, file) => sum + file.size, 0);
            if (!begun && (state.partialFiles || state.complete.length)) {
                begun = true; speedStart.at = Date.now(); speedStart.bytes = bytes;
                report({ label: 'Download started in the browser…' });
                if (!minimized) { minimized = true; minimizeWindow(); }
            }
            if (begun) {
                if (bytes > lastBytes) { lastBytes = bytes; lastGrowth = Date.now(); }
                else if (Date.now() - lastGrowth > STALL_MS) throw new Error('The browser download stopped making progress.');
                report({ downloaded: bytes, speed: bytes / Math.max(1, (Date.now() - speedStart.at) / 1000) });
            } else if (Date.now() - startedAt > waitMs) {
                throw new Error('No download started. Complete the verification in the window, or choose another mirror.');
            }
            if (begun && !state.partialFiles && state.complete.length) {
                const file = state.complete.slice().sort((a, b) => b.size - a.size)[0];
                // A finished file is stable across two checks before it is moved.
                if (stable && stable.name === file.name && stable.size === file.size) {
                    const name = safeFileName(options.fallbackName && /^(?:download|Unconfirmed)/i.test(file.name) ? options.fallbackName : file.name);
                    const target = path.join(directory, name);
                    if (fs.existsSync(target)) throw new Error('Two download parts have the same filename. Existing files were kept.');
                    fs.renameSync(path.join(stagingDirectory, file.name), target);
                    return { path: target, name, size: file.size };
                }
                stable = file;
            } else stable = null;
            if (child.exitCode !== null && !state.complete.length) {
                throw new Error(begun ? 'The browser closed before the download finished.' : 'The verification window was closed before a download started.');
            }
        }
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        await closeWindow();
        try { fs.rmSync(stagingDirectory, { recursive: true, force: true }); } catch (_) {}
        try {
            const relative = path.relative(tempRoot, profileDirectory);
            if (relative && !relative.startsWith('..')) fs.rmSync(profileDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (_) {}
    }
}

module.exports = { adBlockResolverRules, downloadInSystemBrowser, inspectDownloadFolder, safeFileName };
