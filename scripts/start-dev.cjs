'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
if (process.platform !== 'linux') throw new Error('dev:linux requires Linux. Windows product startup remains npm start.');
if (process.version !== 'v22.23.2') throw new Error('Use the pinned Node 22.23.2 toolchain for dev:linux.');
const args = process.argv.slice(2);
for (const arg of args) {
    if (!/^--profile=[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(arg)
        && !/^--ozone-platform=(wayland|x11)$/.test(arg)
        && !/^--mode=(offline-preview|local-fixture)$/.test(arg)
        && !/^--fixture-root=\/.+/.test(arg)
        && arg !== '--without-tray') throw new Error(`Unsupported development option: ${arg}`);
}
const profile = (args.find(arg => arg.startsWith('--profile=')) || '--profile=default').slice(10);
const backend = (args.find(arg => arg.startsWith('--ozone-platform=')) || '--ozone-platform=wayland');
const mode = (args.find(arg => arg.startsWith('--mode=')) || '--mode=offline-preview').slice(7);
const fixtureRoot = (args.find(arg => arg.startsWith('--fixture-root=')) || '').slice(15);
if (mode === 'local-fixture' && !fixtureRoot) throw new Error('Provide --fixture-root inside the verified private runtime boundary.');
if (mode !== 'local-fixture' && fixtureRoot) throw new Error('--fixture-root requires --mode=local-fixture.');
const electron = require('../runtime/installedElectron').installedElectron();
const root = path.resolve(__dirname, '..');
const child = spawn(electron, [path.join(root, 'runtime', 'devBootstrap.cjs'), backend], {
    cwd: root,
    env: { ...process.env, SAIL_DEV_ISOLATED: '1', SAIL_DEV_PROFILE: profile, SAIL_DEV_MODE: mode, SAIL_NATIVE_FIXTURE_ROOT: fixtureRoot,
        SAIL_DEV_WITHOUT_TRAY: args.includes('--without-tray') ? '1' : '0' },
    stdio: 'inherit'
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code === null ? 1 : code; if (signal) console.error(`Electron exited with ${signal}`); });
