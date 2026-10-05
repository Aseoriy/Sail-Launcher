'use strict';

const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { app } = electron;
const root = path.resolve(__dirname, '..');
const name = process.env.SAIL_DEV_PROFILE || 'default';
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid development profile name.');
const { ELECTRON_VERSION } = require('./runtimeRequirements');
if (process.versions.electron !== ELECTRON_VERSION || process.platform !== 'linux') throw new Error(`This preview requires Linux Electron ${ELECTRON_VERSION}.`);
const dataRoot = require('./privateDataRoot').privateDataRoot({ root, packaged: app.isPackaged });
require('./nativeSessionPolicy').installNativeSessionPolicy(electron, { isolated: true });
const profile = path.join(dataRoot, name);
for (const target of [dataRoot, profile]) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Development data paths cannot be symbolic links.');
}
process.umask(0o077);
process.env.SAIL_DEV_ISOLATED = '1';
process.chdir(app.isPackaged ? path.dirname(root) : root);
app.setAppPath(root);
app.setVersion(require('../package.json').version);
app.setName('Sail Launcher Linux Development');
const paths = {};
for (const [key, relative] of Object.entries({ appData: 'app-data', userData: 'user-data',
    sessionData: 'chromium', logs: 'logs', crashDumps: 'crashes',
    downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', home: 'home' })) {
    const directory = path.join(profile, relative);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Linked development ${key} path is not allowed.`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    app.setPath(key, directory);
    paths[key] = directory;
}
// Chromium's singleton socket exceeds Linux's Unix-socket path limit when
// TMPDIR contains the checkout plus a long profile name. Keep only ephemeral
// IPC/temp files in a short, private directory; all persistent data stays above.
paths.temp = fs.mkdtempSync('/tmp/sail-dev-');
app.setPath('temp', paths.temp);
app.once('quit', () => { fs.rmSync(paths.temp, { recursive: true, force: true }); });
process.env.TMPDIR = paths.temp;
process.env.TEMP = paths.temp;
process.env.TMP = paths.temp;
process.env.XDG_CONFIG_HOME = paths.appData;
process.env.XDG_CACHE_HOME = path.join(profile, 'cache');
process.env.SAIL_DEV_HOME = paths.home;
require('node:os').homedir = () => paths.home;
app.commandLine.appendSwitch('user-data-dir', paths.sessionData);
require('./native/context').initializeNativeContext(app);
const offline = require('./offlineNetwork');
offline.installOfflineNodeNetwork();
offline.installOfflineElectron(electron);
const { ProfileStore } = require('../accounts/profileStore');
const store = new ProfileStore(paths.userData);
const fresh = !fs.existsSync(path.join(paths.userData, 'SailProfiles', 'state.json'));
store.initialize();
if (fresh) {
    store.registerDiscoveredGames([{ name: 'Linux Boot Sample', platform: 'custom' },
        { name: 'Second Local Sample', platform: 'custom' }]);
    const snapshot = store.loadActiveSnapshot();
    snapshot.globalSettings = { ...snapshot.globalSettings, exitWhenClosed: true };
    store.captureActiveSnapshot(snapshot);
}
fs.writeFileSync(path.join(profile, 'runtime.json'), JSON.stringify({
    profile, paths, pid: process.pid, packaged: app.isPackaged, executable: process.execPath,
    electron: process.versions.electron, node: process.versions.node,
    platform: process.platform, arch: process.arch,
    requestedBackend: app.commandLine.getSwitchValue('ozone-platform'),
    session: process.env.XDG_SESSION_TYPE,
    argv: process.argv
}, null, 2));
console.log(`Isolated offline Sail profile: ${profile}`);
require('../main');
