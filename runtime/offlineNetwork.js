'use strict';

// Test/development-only egress barrier, installed before application imports
// in both Node contexts. No network failure is converted into a success.
let installed = false;
const attempts = [];
function blocked(kind) {
    attempts.push(kind);
    if (attempts.length > 200) attempts.shift();
    const error = new Error(`SAIL_OFFLINE: ${kind} is unavailable in the isolated development profile.`);
    error.code = 'SAIL_OFFLINE';
    return error;
}
function installOfflineNodeNetwork() {
    if (installed) return;
    installed = true;
    for (const name of ['http', 'https']) {
        const client = require(`node:${name}`);
        for (const method of ['request', 'get']) client[method] = () => { throw blocked(`${name}.${method}`); };
    }
    require('node:net').Socket.prototype.connect = () => { throw blocked('socket.connect'); };
    require('node:tls').connect = () => { throw blocked('tls.connect'); };
    const dns = require('node:dns');
    for (const key of Object.keys(dns)) {
        if (key === 'lookup' || key.startsWith('resolve')) dns[key] = () => { throw blocked(`dns.${key}`); };
    }
    for (const key of Object.keys(dns.promises)) {
        if (key === 'lookup' || key.startsWith('resolve')) dns.promises[key] = async () => { throw blocked(`dns.${key}`); };
    }
    globalThis.fetch = async () => { throw blocked('fetch'); };
    globalThis.WebSocket = class { constructor() { throw blocked('WebSocket'); } };
    // Optional integrations must never escape isolation by spawning a helper.
    const childProcess = require('node:child_process');
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        childProcess[key] = () => { throw blocked(`child_process.${key}`); };
    }
}
function blockElectronRequest(details, callback) {
    if (/^(?:https?|wss?|ftp):/i.test(details.url || '')) {
        blocked('chromium-request');
        callback({ cancel: true });
    } else callback({});
}
function installOfflineElectron(electron) {
    require('./nativeSessionPolicy').installNativeSessionPolicy(electron, { isolated: true });
    const configure = session => {
        session.webRequest.onBeforeRequest(blockElectronRequest);
    };
    electron.app.on('session-created', configure);
    for (const method of ['request', 'fetch', 'resolveHost']) {
        electron.net[method] = () => { throw blocked(`electron.net.${method}`); };
    }
    for (const method of ['openExternal', 'openPath', 'showItemInFolder', 'writeShortcutLink']) {
        electron.shell[method] = () => { throw blocked(`shell.${method}`); };
    }
}
module.exports = { installOfflineNodeNetwork, installOfflineElectron, blockElectronRequest, attempts,
    isInstalled: () => installed };
