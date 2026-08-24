'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electronPath = require('electron');
const runs = [
    {
        script: 'electron-security-runtime.js',
        prefix: 'sail-electron-security-',
        environmentKey: 'SAIL_SECURITY_TEST_ROOT'
    }
];

function runElectronProbe(probe) {
    return new Promise(resolve => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), probe.prefix));
        const child = spawn(electronPath, [path.join(__dirname, probe.script)], {
            cwd: path.join(__dirname, '..'),
            env: Object.assign({}, process.env, { [probe.environmentKey]: tempRoot }),
            stdio: 'inherit',
            windowsHide: true
        });
        let launchFailed = false;
        const timeout = setTimeout(() => {
            try { child.kill(); } catch (_) {}
        }, 60000);
        child.once('error', error => {
            launchFailed = true;
            console.error(`SAIL_SECURITY_RUNTIME_LAUNCH_FAILED ${probe.script}: ${error.message}`);
        });
        child.once('exit', code => {
            clearTimeout(timeout);
            let cleanupFailed = false;
            try {
                fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch (error) {
                cleanupFailed = true;
                console.error(`SAIL_SECURITY_RUNTIME_CLEANUP_FAILED ${probe.script}: ${error.code || error.message}`);
            }
            resolve(!launchFailed && code === 0 && !cleanupFailed);
        });
    });
}

(async () => {
    for (const probe of runs) {
        if (!await runElectronProbe(probe)) {
            process.exitCode = 1;
            return;
        }
    }
    process.exitCode = 0;
})().catch(error => {
    console.error(`SAIL_SECURITY_RUNTIME_LAUNCH_FAILED ${error.message}`);
    process.exitCode = 1;
});
