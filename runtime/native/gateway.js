'use strict';

// Construct only in main, before the isolated API barrier. The retained methods
// can start one fixed helper and contact only its versioned private endpoint.
const net = require('node:net');
const { UUID, nativeError } = require('./protocol');
function createNativeGateway(helperPath) {
    const spawn = require('node:child_process').spawn;
    const connect = net.Socket.prototype.connect;
    function start(args, umuEnvironment) {
        const umuVariables = require('../proton/environment').umuEnvironmentVariables(umuEnvironment);
        return spawn(helperPath, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'],
            env: { PATH: '/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8',
                HOME: process.env.SAIL_DEV_HOME || require('node:os').homedir(),
                ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
                ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
                ...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}),
                ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}), ...umuVariables } });
    }
    async function initial(args, config, umuEnvironment) {
        const child = start(args, umuEnvironment); child.unref();
        return new Promise((resolve, reject) => {
            let data = ''; let settled = false;
            const timer = setTimeout(() => finish(nativeError('SAIL_NATIVE_START_TIMEOUT', 'The native supervisor did not become ready. No launch was committed.')), 5000);
            const finish = (error, result) => {
                if (settled) return; settled = true; clearTimeout(timer);
                child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
                error ? reject(error) : resolve(result);
            };
            child.once('error', error => finish(error));
            child.once('close', code => { if (!settled) finish(nativeError('SAIL_NATIVE_START', `The native supervisor exited before readiness (${code}).`)); });
            child.stdout.on('data', chunk => {
                data += chunk.toString('utf8');
                if (data.length > 4096) return finish(nativeError('SAIL_NATIVE_PROTOCOL', 'The supervisor returned an oversized readiness reply.'));
                if (data.includes('\n')) { try { finish(null, JSON.parse(data.slice(0, data.indexOf('\n')))); } catch (error) { finish(error); } }
            });
            // Read and discard diagnostics: argv, paths and game output are never logged here.
            child.stderr.resume(); child.stdin.on('error', error => finish(error)); child.stdin.end(config);
        });
    }
    function request(sessionId, nonce, verb) {
        if (!UUID.test(sessionId) || !/^[0-9a-f]{64}$/.test(nonce) || !['COMMIT', 'STATUS', 'STOP', 'ACK'].includes(verb)) {
            return Promise.reject(nativeError('SAIL_NATIVE_PROTOCOL', 'Invalid native control request.'));
        }
        return new Promise((resolve, reject) => {
            const socket = new net.Socket(); let data = ''; let settled = false;
            const timer = setTimeout(() => finish(nativeError('SAIL_NATIVE_CHANNEL', 'The native supervisor did not answer. Completion is unknown.')), 4500);
            const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
            socket.on('error', error => finish(error));
            socket.on('end', () => { if (!settled) finish(nativeError('SAIL_NATIVE_CHANNEL', 'The native control reply ended before completion.')); });
            socket.on('data', chunk => {
                data += chunk.toString('utf8');
                if (data.length > 4096) return finish(nativeError('SAIL_NATIVE_PROTOCOL', 'The supervisor reply is too large.'));
                if (data.includes('\n')) { try { finish(null, JSON.parse(data.slice(0, data.indexOf('\n')))); } catch (error) { finish(error); } }
            });
            socket.once('connect', () => socket.write(`${verb} ${nonce}\n`));
            try { connect.call(socket, `\0sail-native-v1-${sessionId}`); } catch (error) { finish(error); }
        });
    }
    return Object.freeze({ probe: () => initial(['--probe']), start: (config, umuEnvironment) => initial(['--session'], config, umuEnvironment), request });
}
module.exports = { createNativeGateway };
