'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');

const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';
const SYSTEM_STEAMCMD = ['/usr/games/steamcmd', '/usr/bin/steamcmd'];

function download(url, target, { get = https.get, hops = 0 } = {}) {
    return new Promise((resolve, reject) => {
        if (hops > 5) return reject(new Error('Too many redirects while downloading SteamCMD.'));
        const request = get(url, { headers: { 'User-Agent': 'Sail-Launcher' } }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                response.resume();
                const next = new URL(response.headers.location, url);
                if (next.protocol !== 'https:') return reject(new Error('SteamCMD download redirected to an insecure address.'));
                return resolve(download(next.href, target, { get, hops: hops + 1 }));
            }
            if (response.statusCode !== 200) { response.resume(); return reject(new Error('SteamCMD download returned HTTP ' + response.statusCode + '.')); }
            const out = fs.createWriteStream(target, { mode: 0o600 });
            response.pipe(out);
            out.once('finish', () => out.close(resolve));
            out.once('error', reject);
        });
        request.setTimeout(60000, () => request.destroy(new Error('SteamCMD download timed out.')));
        request.once('error', reject);
    });
}

function run(command, args, options = {}) {
    return new Promise(resolve => {
        const child = (options.spawn || spawn)(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        if (child.stdout) child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); });
        child.once('error', error => resolve({ code: -1, error: error.message, output }));
        child.once('close', code => resolve({ code, output }));
    });
}

// Prefer a SteamCMD that is already installed; otherwise fetch Valve's own Linux installer into Sail's data folder.
async function ensureSteamCmd(directory, options = {}) {
    const exists = options.exists || fs.existsSync;
    const system = SYSTEM_STEAMCMD.find(candidate => exists(candidate));
    if (system) return { command: system, cwd: directory };
    const script = path.join(directory, 'steamcmd.sh');
    if (exists(script)) return { command: script, cwd: directory };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const archive = path.join(directory, 'steamcmd_linux.tar.gz');
    try {
        await (options.download || download)(STEAMCMD_URL, archive);
        const result = await run('tar', ['-xzf', archive, '-C', directory], options);
        if (result.code !== 0 || !exists(script)) throw new Error('Could not unpack SteamCMD.');
    } finally { fs.rmSync(archive, { force: true }); }
    return { command: script, cwd: directory };
}

function contentFolders(directory, appId, itemId, home) {
    const tail = path.join('steamapps', 'workshop', 'content', appId, itemId);
    return [path.join(directory, tail), home && path.join(home, '.local', 'share', 'Steam', tail), home && path.join(home, '.steam', 'steamcmd', tail)].filter(Boolean);
}

async function downloadWorkshopItem({ directory, appId, itemId, home = '', options = {} }) {
    if (!/^\d{1,12}$/.test(appId) || !/^\d{1,20}$/.test(itemId)) throw new Error('Invalid Steam Workshop item.');
    const tool = await ensureSteamCmd(directory, options);
    // Keep Workshop files in Sail's own folder instead of the Steam client's library.
    const dataDirectory = path.join(directory, 'data');
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const result = await run(tool.command, ['+force_install_dir', dataDirectory, '+login', 'anonymous', '+workshop_download_item', appId, itemId, '+quit'], { ...options, cwd: tool.cwd });
    // Exit code 7 is SteamCMD finishing after a self-update.
    if (result.error) throw new Error(/ENOENT/.test(result.error) ? 'SteamCMD could not start. On 64-bit systems it needs the 32-bit C library (for Ubuntu: lib32gcc-s1).' : result.error);
    if (result.code !== 0 && result.code !== 7) throw new Error(`SteamCMD exited with code ${result.code}`);
    const exists = options.exists || fs.existsSync;
    const folder = contentFolders(dataDirectory, appId, itemId, home).find(candidate => exists(candidate));
    if (!folder) throw new Error('SteamCMD finished but the item was not downloaded. Some Workshop items need a Steam account that owns the game.');
    return folder;
}

module.exports = { downloadWorkshopItem, ensureSteamCmd, contentFolders, STEAMCMD_URL };
