'use strict';
const fs = require('node:fs');
const path = require('node:path');
let context = null;
function initializeNativeContext(app) {
    if (process.type === 'renderer') throw new Error('Native execution context belongs to the main process.');
    if (context) return context;
    const isolated = process.env.SAIL_DEV_ISOLATED === '1';
    const mode = isolated ? process.env.SAIL_DEV_MODE || 'offline-preview' : 'normal';
    if (!['normal', 'offline-preview', 'local-fixture'].includes(mode) || (isolated && mode === 'normal')) throw new Error('Invalid main-process isolation mode.');
    let fixtureRoot = null;
    if (mode === 'local-fixture') {
        const requested = process.env.SAIL_NATIVE_FIXTURE_ROOT;
        if (!requested || !path.isAbsolute(requested)) throw new Error('Local-fixture mode requires an explicit private absolute fixture root.');
        fixtureRoot = fs.realpathSync(requested);
        const stat = fs.lstatSync(requested);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Native fixtures require an owned directory with mode 0700.');
        const interfaces = Object.keys(require('node:os').networkInterfaces());
        if (interfaces.some(name => name !== 'lo') || !process.env.SAIL_TEST_HOST_NET_NS
            || fs.readlinkSync('/proc/self/ns/net') === process.env.SAIL_TEST_HOST_NET_NS) {
            throw new Error('Local-fixture execution requires the verified private network namespace. No host-network fixture launch is permitted.');
        }
    }
    const eligible = process.platform === 'linux' && process.arch === 'x64' && mode !== 'offline-preview';
    const helperPath = app.isPackaged ? path.join(process.resourcesPath, 'native', 'sail-native')
        : path.join(__dirname, '../../native/linux/x64/sail-native');
    context = { mode, fixtureRoot, gateway: eligible ? require('./gateway').createNativeGateway(helperPath) : null };
    return context;
}
module.exports = { initializeNativeContext };
