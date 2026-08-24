'use strict';

const { spawn } = require('node:child_process');

function runOwnedChildProcess(command, args, work, options = {}) {
    const spawnImpl = options.spawn || spawn;
    return new Promise((resolve, reject) => {
        let child;
        try { child = spawnImpl(command, args, Object.assign({ windowsHide: true }, options.spawnOptions || {})); }
        catch (error) { reject(error); return; }
        let errBuf = '';
        if (child.stderr) child.stderr.on('data', chunk => { errBuf += chunk.toString(); });
        Promise.resolve(work && work.setStop(() => { try { child.kill(); } catch (_) {} })).catch(() => {});
        child.once('error', reject);
        child.once('close', code => {
            Promise.resolve(work && work.setStop(null)).catch(() => {}).finally(() => {
                if (code === 0) resolve({ code, stderr: errBuf });
                else reject(Object.assign(new Error(errBuf.trim().split(/\r?\n/)[0] || `Owned process exited with code ${code}.`), { code }));
            });
        });
    });
}

module.exports = { runOwnedChildProcess };
