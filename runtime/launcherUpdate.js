'use strict';

// Launcher self-update helpers. Windows downloads the NSIS installer and runs it
// silently. Linux replaces a running AppImage in place (no password), or hands
// a .deb/.rpm to the system package manager behind one pkexec prompt.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { launcherExecutablePath } = require('./linuxDesktopEntry');

const PACKAGE_NAME = 'sail-launcher';
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/Aseoriy/Sail-Launcher/releases/download/';
const SYSTEM_BIN_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const LINUX_ASSET_PATTERNS = { appimage: /-x86_64\.AppImage$/i, deb: /-amd64\.deb$/i, rpm: /-x86_64\.rpm$/i };

// pkexec runs with a reset PATH, so every privileged command is an absolute path.
function systemCommand(name, exists = fs.existsSync) {
    for (const dir of SYSTEM_BIN_DIRS) {
        const candidate = path.join(dir, name);
        if (exists(candidate)) return candidate;
    }
    return null;
}

// Pick the release asset for this install kind. GitHub publishes a sha256 digest
// for every asset; an asset without one is never installed.
function linuxUpdateAsset(assets, kind) {
    const pattern = LINUX_ASSET_PATTERNS[kind];
    if (!pattern || !Array.isArray(assets)) return null;
    const asset = assets.find(item => item && pattern.test(item.name || '') && typeof item.browser_download_url === 'string');
    const sha256 = asset && /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
    if (!sha256 || !asset.browser_download_url.startsWith(RELEASE_DOWNLOAD_PREFIX)) return null;
    return { name: asset.name, url: asset.browser_download_url, sha256: sha256[1].toLowerCase(), size: Number(asset.size) || 0 };
}

function queryCommand(file, args) {
    return new Promise(resolve => {
        execFile(file, args, { timeout: 10000, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : String(stdout || '').trim()));
    });
}

async function detectLinuxInstall({ packaged, env = process.env, execPath = process.execPath, runQuery = queryCommand, exists = fs.existsSync } = {}) {
    if (!packaged) return { kind: null, reason: 'Development builds update from source, not from releases.' };
    const appImage = env.APPIMAGE;
    if (appImage) {
        let stat = null;
        try { stat = path.isAbsolute(appImage) ? fs.statSync(appImage) : null; } catch (_) {}
        if (!stat || !stat.isFile()) return { kind: null, reason: 'Sail could not find its own AppImage file.' };
        try {
            fs.accessSync(path.dirname(appImage), fs.constants.W_OK);
            fs.accessSync(appImage, fs.constants.W_OK);
        } catch (_) {
            return { kind: null, reason: `Sail can't write to ${path.dirname(appImage)}, so it can't replace its AppImage. Move the AppImage to a folder you own, or download the update by hand.` };
        }
        return { kind: 'appimage', path: appImage };
    }
    let executable = execPath;
    try { executable = fs.realpathSync(execPath); } catch (_) {}
    const dpkgQuery = systemCommand('dpkg-query', exists);
    const rpm = systemCommand('rpm', exists);
    let kind = null;
    if (dpkgQuery && (await runQuery(dpkgQuery, ['-S', executable]) || '').startsWith(`${PACKAGE_NAME}:`)) kind = 'deb';
    else if (rpm && await runQuery(rpm, ['-qf', '--queryformat', '%{NAME}', executable]) === PACKAGE_NAME) kind = 'rpm';
    if (!kind) return { kind: null, reason: 'This copy of Sail was not installed from the AppImage, .deb or .rpm, so it can\'t update itself.' };
    if (!systemCommand('pkexec', exists)) return { kind: null, reason: `Installing the .${kind} update needs pkexec (polkit), which isn't installed.` };
    return { kind };
}

// The privileged command for a downloaded package. Forced installs (reinstall or
// downgrade from Feature Testing) go through tools that accept same/older versions.
function linuxInstallCommand(kind, file, { force = false, exists = fs.existsSync } = {}) {
    if (kind === 'deb') {
        const apt = systemCommand('apt-get', exists);
        if (apt) return [apt, 'install', '-y', '--allow-downgrades', ...(force ? ['--reinstall'] : []), file];
        const dpkg = systemCommand('dpkg', exists);
        return dpkg ? [dpkg, '-i', file] : null;
    }
    if (kind === 'rpm') {
        const rpm = systemCommand('rpm', exists);
        if (force) return rpm ? [rpm, '-U', '--oldpackage', '--replacepkgs', file] : null;
        const dnf = systemCommand('dnf', exists);
        if (dnf) return [dnf, 'install', '-y', file];
        const zypper = systemCommand('zypper', exists);
        if (zypper) return [zypper, '--non-interactive', 'install', '--allow-unsigned-rpm', file];
        return rpm ? [rpm, '-U', file] : null;
    }
    return null;
}

function runPrivileged(command, { spawnProcess = spawn, exists = fs.existsSync } = {}) {
    const pkexec = systemCommand('pkexec', exists);
    if (!pkexec) return Promise.reject(new Error('pkexec (polkit) is not installed.'));
    return new Promise((resolve, reject) => {
        let output = '';
        const child = spawnProcess(pkexec, command, { stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = chunk => { output = (output + chunk).slice(-4000); };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.once('error', reject);
        child.once('close', code => {
            if (code === 0) return resolve();
            // pkexec: 126 = the password prompt was dismissed, 127 = not authorized or no agent.
            if (code === 126) return reject(new Error('The password prompt was cancelled. Sail was not updated.'));
            if (code === 127) return reject(new Error('Sail could not get permission to install the update (no password prompt is available, or the password was refused).'));
            const lastLine = output.trim().split(/\r?\n/).filter(Boolean).pop();
            reject(new Error(`The package manager could not install the update${lastLine ? `: ${lastLine}` : ` (exit code ${code}).`}`));
        });
    });
}

// Download `url`, following GitHub's redirect chain, reporting progress and
// checking the sha256 when one is given. A failed or mismatched file is removed.
function downloadReleaseFile(url, destination, { onProgress = () => {}, sha256 = null, mode } = {}) {
    return new Promise((resolve, reject) => {
        let hops = 0;
        const fail = error => { try { fs.rmSync(destination, { force: true }); } catch (_) {} reject(error); };
        const get = target => {
            if (++hops > 8) return reject(new Error('Too many redirects'));
            const lib = target.startsWith('http:') ? http : https;
            lib.get(target, { headers: { 'User-Agent': 'Sail-Launcher' } }, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return get(new URL(res.headers.location, target).toString());
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
                const total = Number(res.headers['content-length']) || 0;
                const hash = crypto.createHash('sha256');
                let received = 0;
                const out = fs.createWriteStream(destination, mode ? { mode } : undefined);
                res.on('data', chunk => {
                    received += chunk.length;
                    hash.update(chunk);
                    try { onProgress({ received, total, percent: total ? Math.round(received / total * 100) : 0 }); } catch (_) {}
                });
                res.on('error', fail);
                res.pipe(out);
                out.on('finish', () => out.close(() => {
                    if (sha256 && hash.digest('hex') !== sha256) return fail(new Error('The downloaded update did not match its published checksum, so it was discarded.'));
                    resolve(destination);
                }));
                out.on('error', fail);
            }).on('error', reject);
        };
        get(url);
    });
}

// An AppImage's process.execPath is inside a temporary mount that disappears on
// exit, so a restart has to start the AppImage file itself.
function launcherRelaunchOptions(env = process.env, argv = process.argv) {
    const execPath = launcherExecutablePath(env, null);
    return execPath ? { execPath, args: argv.slice(1) } : undefined;
}

function appImageUpdatePath(appImage) {
    return path.join(path.dirname(appImage), `.${path.basename(appImage)}.sail-update`);
}

module.exports = {
    PACKAGE_NAME,
    RELEASE_DOWNLOAD_PREFIX,
    appImageUpdatePath,
    detectLinuxInstall,
    downloadReleaseFile,
    launcherRelaunchOptions,
    linuxInstallCommand,
    linuxUpdateAsset,
    runPrivileged
};
