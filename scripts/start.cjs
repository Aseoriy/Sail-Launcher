'use strict';

const { spawn } = require('node:child_process');
const { installedElectron } = require('../runtime/installedElectron');

if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    throw new Error('ELECTRON_OVERRIDE_DIST_PATH is not supported. Use the locked Electron installation.');
}
const electron = installedElectron();
// Match Electron's CLI contract without importing its auto-installing entry.
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: false });
let childClosed = false;
let spawnFailed = false;
child.on('error', error => {
    spawnFailed = true;
    console.error(error.message);
});
child.on('close', (code, signal) => {
    childClosed = true;
    if (code === null) console.error(electron, 'exited with signal', signal);
    process.exit(spawnFailed || code === null ? 1 : code);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
    process.on(signal, () => { if (!childClosed) child.kill(signal); });
}
