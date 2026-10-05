'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const native = require('../native/protocol');
const { fileIdentity, identityMatches } = require('../../security/capabilityStore');
const WINE_PENDING_REASON = 'Standalone Wine launching is awaiting process ownership, timing and recovery verification.';
const WINE_LIFECYCLE_VERIFIED = false;
const BACKENDS = new Set(['proton-umu', 'wine']);
const windowsBackend = value => BACKENDS.has(value);
const runtimeBackend = runtime => runtime.backend || 'proton-umu';

function loaderIdentity(selected, options = {}) {
    const file = fs.realpathSync(selected); native.assertFixturePath(file, options.fixtureRoot);
    const identity = fileIdentity(file, 'file');
    if (options.expected && (file !== selected || !identityMatches(options.expected, identity))) throw Error('A Wine loader changed. Add this version again.');
    fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const sameFile = () => {
            const stat = fs.fstatSync(fd);
            return stat.isFile() && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino
                && stat.size === identity.size && Math.round(stat.mtimeMs || 0) === identity.mtimeMs
                && Math.round(stat.birthtimeMs || 0) === identity.birthtimeMs;
        };
        if (!sameFile()) throw Error('A Wine loader changed before inspection.');
        const head = Buffer.alloc(20);
        if (fs.readSync(fd, head, 0, head.length, 0) !== head.length || !head.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
            || head[5] !== 1 || !((head[4] === 2 && head.readUInt16LE(18) === 62) || (head[4] === 1 && head.readUInt16LE(18) === 3))) throw native.nativeError('SAIL_WINE_LOADER_FORMAT', 'Choose a Wine installation with native x86/x64 loaders.');
        if (!sameFile() || !identityMatches(identity, fileIdentity(file, 'file'))) throw Error('A Wine loader changed during selection.');
        return { ...identity, arch: head[4] === 2 ? 'x64' : 'x86' };
    } finally { fs.closeSync(fd); }
}
function installationId(value) {
    return crypto.createHash('sha256').update(JSON.stringify([value.wineIdentity, value.serverIdentity, value.loaders, value.rootIdentity])).digest('hex');
}
function validateWineInstallation(selected, options = {}) {
    if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw Error('Choose an installed Wine executable.');
    const wineIdentity = native.validateNativeExecutable(selected, { ...options, allowScripts: true });
    if (!/^wine(?:64)?(?:-(?:stable|devel|staging))?$/.test(path.basename(wineIdentity.realPath))) throw Error('Choose wine or wine64 from the installed Wine version.');
    // Distribution wrappers and standalone bundles have different loader
    // layouts. Inspect fixed paths only; never run a discovered executable.
    const system = ['/usr/bin', '/usr/lib/wine', '/usr/lib64/wine', '/usr/lib/x86_64-linux-gnu/wine', '/usr/lib/i386-linux-gnu/wine'];
    const directory = path.dirname(wineIdentity.realPath);
    const systemLayout = system.some(root => directory === root || root !== '/usr/bin' && native.withinRoot(directory, root)) && !options.fixtureRoot;
    const root = systemLayout ? '/usr' : path.basename(directory) === 'bin' ? path.dirname(directory)
        : /\/lib(?:64)?\/wine(?:\/(?:x86_64|i386)-unix)?$/.test(directory) ? directory.replace(/\/lib(?:64)?\/wine(?:\/(?:x86_64|i386)-unix)?$/, '') : directory;
    native.assertFixturePath(root, options.fixtureRoot);
    const rootIdentity = fileIdentity(root, 'directory'), files = systemLayout
        ? ['/usr/lib/x86_64-linux-gnu/wine/wine', '/usr/lib/i386-linux-gnu/wine/wine',
            '/usr/lib/x86_64-linux-gnu/wine/wine-preloader', '/usr/lib/i386-linux-gnu/wine/wine-preloader', '/usr/lib/wine/wine64', '/usr/lib/wine/wine',
            '/usr/bin/wine', '/usr/bin/wine64', '/usr/lib64/wine/wine', '/usr/lib64/wine/wine64',
            ...['/usr/lib/wine', '/usr/lib64/wine'].flatMap(root => ['x86_64-unix', 'i386-unix'].flatMap(arch =>
                ['wine', 'wine64', 'wine-preloader', 'wine64-preloader'].map(name => `${root}/${arch}/${name}`))),
            '/usr/lib/wine/wine64-preloader', '/usr/lib/wine/wine-preloader', '/usr/bin/wine64-preloader', '/usr/bin/wine-preloader']
        : ['wine', 'wine64', 'wine-preloader', 'wine64-preloader',
            'bin/wine', 'bin/wine64', 'bin/wine-preloader', 'bin/wine64-preloader',
            'lib/wine/wine', 'lib/wine/wine64', 'lib/wine/wine-preloader', 'lib/wine/wine64-preloader',
            'lib64/wine/wine', 'lib64/wine/wine64', 'lib64/wine/wine-preloader', 'lib64/wine/wine64-preloader',
            ...['lib', 'lib64'].flatMap(lib => ['x86_64-unix', 'i386-unix'].flatMap(arch =>
                ['wine', 'wine64', 'wine-preloader', 'wine64-preloader'].map(name => `${lib}/wine/${arch}/${name}`)))].map(name => path.join(root, name));
    // options.expected is the launcher's identity; loaders and the server are compared through installationId().
    const { expected: _launcherIdentity, ...loaderOptions } = options;
    const loaders = [], seen = new Set();
    for (const candidate of files) {
        try {
            const identity = loaderIdentity(candidate, loaderOptions);
            if (!native.withinRoot(identity.realPath, root) || seen.has(identity.realPath)) continue;
            seen.add(identity.realPath); loaders.push(identity);
        } catch (error) {
            // Fixed paths may hold wrappers or a loader for another architecture.
            // The selected launcher is approved separately; a native x64 loader
            // and server remain required. Identity changes are never ignored.
            if (!['ENOENT', 'ENOTDIR', 'SAIL_WINE_LOADER_FORMAT'].includes(error.code)) throw error;
        }
    }
    if (!loaders.length || loaders.length > 24 || !loaders.some(item => item.arch === 'x64')) throw Error('The selected Wine installation has no supported 64-bit loader.');
    const servers = systemLayout ? ['/usr/lib/x86_64-linux-gnu/wine/wineserver', '/usr/lib/wine/wineserver64', '/usr/lib/wine/wineserver', '/usr/lib64/wine/wineserver', '/usr/bin/wineserver']
        : ['wineserver', 'wineserver64', 'bin/wineserver', 'bin/wineserver64', 'lib/wine/wineserver', 'lib64/wine/wineserver',
            'lib/wine/x86_64-unix/wineserver', 'lib64/wine/x86_64-unix/wineserver'].map(name => path.join(root, name));
    let serverIdentity;
    for (const candidate of servers) {
        try { const item = loaderIdentity(candidate, loaderOptions); if (item.arch === 'x64' && native.withinRoot(item.realPath, root)) { serverIdentity = item; break; } }
        catch (_) {}
    }
    if (!serverIdentity) throw Error('The selected Wine installation needs its own native 64-bit wineserver.');
    const loader = loaders.find(item => item.arch === 'x64' && !item.realPath.endsWith('-preloader'));
    if (!loader) throw Error('The Wine installation has no supported loader.');
    return { root, rootIdentity, winePath: wineIdentity.realPath, wineIdentity, serverPath: serverIdentity.realPath, serverIdentity, loaderPath: loader.realPath, loaders };
}
function verifyWineRuntime(entry, options = {}) {
    const current = validateWineInstallation(entry.winePath, { ...options, expected: entry.wineIdentity });
    if (current.root !== entry.wineRoot || !identityMatches(entry.rootIdentity, current.rootIdentity)
        || !identityMatches(entry.serverIdentity, current.serverIdentity) || current.serverPath !== entry.serverPath
        || current.loaderPath !== entry.loaderPath || installationId(current) !== installationId({ ...entry, rootIdentity: entry.rootIdentity })) throw Error('The selected Wine installation changed. Add its new version explicitly.');
    return entry;
}
module.exports = { windowsBackend, runtimeBackend, validateWineInstallation, verifyWineRuntime, loaderIdentity, installationId, WINE_PENDING_REASON, WINE_LIFECYCLE_VERIFIED };
