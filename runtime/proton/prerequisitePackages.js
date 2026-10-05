'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const https = require('node:https'), dns = require('node:dns');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isPublicAddress } = require('../../security/remoteData');
const { privateDirectory, scopeKey } = require('./manager');
const catalog = require('./prerequisite-catalog.json');
const { fileVersion } = require('./peVersion');
const HOSTS = new Set(['download.microsoft.com', 'download.visualstudio.microsoft.com']);
const MAX_RECIPES = 16;
if (catalog.recipes.length > MAX_RECIPES) throw Error('The prerequisite catalog exceeds the installation queue limit.');
const recipes = Object.freeze(catalog.recipes.map(item => Object.freeze({ ...item,
    ...(item.argv ? { argv: Object.freeze([...item.argv]), dllNames: Object.freeze([...item.dllNames]) } : {}),
    ...(item.dllVersions ? { dllVersions: Object.freeze({ ...item.dllVersions }) } : {}),
    payload: Object.freeze(item.payload.map(file => Object.freeze({ ...file }))) })));
function recipe(id) {
    const value = recipes.find(item => item.id === id);
    if (!value) throw Error('Choose a supported prerequisite.');
    return value;
}
function hashFile(file, size) {
    if (fs.realpathSync(file) !== file) throw Error('A prerequisite file or folder was replaced.');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.uid !== process.getuid() || before.size !== size) throw Error('A prerequisite file changed. Download it again.');
        const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(128 * 1024); let offset = 0, count;
        while ((count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size + 1 - offset), offset))) {
            offset += count; if (offset > size) throw Error('A prerequisite file grew during verification.');
            hash.update(buffer.subarray(0, count));
        }
        const after = fs.fstatSync(fd);
        if (offset !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('A prerequisite file changed during verification.');
        return hash.digest('hex');
    } finally { fs.closeSync(fd); }
}
function verifyPayload(directory, item) {
    privateDirectory(directory);
    // The shipping manifest covers every CAB and DLL, not only DXSETUP.exe.
    const names = fs.readdirSync(directory).sort();
    if (JSON.stringify(names) !== JSON.stringify(item.payload.map(file => file.name).sort())) throw Error('The prerequisite cache layout changed. Existing files were kept.');
    for (const file of item.payload) if (hashFile(path.join(directory, file.name), file.size) !== file.sha256) throw Error('The prerequisite checksum did not match. Existing files were kept.');
    return path.join(directory, item.installerName);
}
function officialUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !HOSTS.has(url.hostname)) throw Error('Prerequisites must come from Microsoft’s official download servers.');
    return url;
}
async function response(value, signal, redirects = 0) {
    signal.throwIfAborted(); const url = officialUrl(value);
    if (redirects > 5) throw Error('Too many prerequisite download redirects.');
    let timer, abort;
    const addresses = await Promise.race([dns.promises.lookup(url.hostname, { all: true, verbatim: true }), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('Prerequisite DNS lookup timed out.')), 15000);
        abort = () => reject(Error('Prerequisite download canceled.')); signal.addEventListener('abort', abort, { once: true });
    })]).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw Error('The Microsoft download host must resolve to public internet addresses.');
    const address = addresses[0];
    const stream = await new Promise((resolve, reject) => {
        const request = https.get(url, { signal, headers: { 'User-Agent': 'Sail-Launcher/5.5.4', 'Accept-Encoding': 'identity' },
            lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family) }, resolve);
        request.setTimeout(60000, () => request.destroy(Error('Prerequisite download stopped responding.'))); request.once('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(stream.statusCode)) {
        const location = stream.headers.location; stream.destroy();
        if (!location) throw Error('Incomplete prerequisite redirect.');
        return response(new URL(location, url).href, signal, redirects + 1);
    }
    if (stream.statusCode !== 200) { stream.destroy(); throw Error('Microsoft download returned HTTP ' + stream.statusCode + '. Try again later.'); }
    return stream;
}
async function download(item, destination, { signal, progress }) {
    const stream = await response(item.url, signal);
    if (stream.headers['content-length'] && Number(stream.headers['content-length']) !== item.size) {
        stream.destroy(); throw Error('The Microsoft package changed. Update Sail’s prerequisite catalog before installing.');
    }
    let size = 0; const hash = crypto.createHash('sha256');
    const meter = new Transform({ transform(bytes, _encoding, done) {
        size += bytes.length;
        if (size > item.size) { done(Error('The prerequisite package exceeds its pinned size.')); return; }
        try { hash.update(bytes); progress(size, item.size); done(null, bytes); } catch (error) { done(error); }
    } });
    await pipeline(stream, meter, fs.createWriteStream(destination, { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode: 0o600 }), { signal });
    if (size !== item.size || hash.digest('hex') !== item.sha256) throw Error('The Microsoft package checksum did not match. Nothing was installed.');
    const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readOwned(file, limit) {
    if (fs.realpathSync(file) !== file) throw Error('A Windows environment path changed.');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > limit) throw Error('The component check could not read this Windows environment.');
        const bytes = Buffer.alloc(Math.min(stat.size, limit) + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (count > limit) throw Error('The component record exceeds its limit.');
        return bytes.subarray(0, count);
    } finally { fs.closeSync(fd); }
}
function nativeDll(prefix, arch, name) {
    const file = path.join(prefix, 'drive_c', 'windows', arch === 'x86' ? 'syswow64' : 'system32', name + '.dll');
    try {
        // Wine builtin DLLs and links to the Proton distribution do not prove
        // that the Microsoft component is installed in this game environment.
        if (fs.realpathSync(file) !== file) return false;
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const stat = fs.fstatSync(fd), bytes = Buffer.alloc(4096);
            if (!stat.isFile() || stat.uid !== process.getuid()) return false;
            const count = fs.readSync(fd, bytes, 0, bytes.length, 0), head = bytes.subarray(0, count);
            if (count < 64 || head.toString('ascii', 0, 2) !== 'MZ' || /wine builtin dll/i.test(head.toString('latin1'))) return false;
            const offset = head.readUInt32LE(60), pe = Buffer.alloc(24);
            return offset >= 64 && offset < 16 * 1024 * 1024 && fs.readSync(fd, pe, 0, pe.length, offset) === pe.length
                && pe.readUInt32LE(0) === 0x4550 && pe.readUInt16LE(4) === (arch === 'x86' ? 0x14c : 0x8664) && !!(pe.readUInt16LE(22) & 0x2000);
        } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function vcVersion(registry, arch) {
    const sections = registry.split(/^\[/m).slice(1);
    for (const section of sections) {
        const key = section.split(']')[0].replace(/\\\\/g, '\\').toLowerCase();
        if (key !== `software\\${arch === 'x86' ? 'wow6432node\\' : ''}microsoft\\visualstudio\\14.0\\vc\\runtimes\\${arch}`
            && key !== `software\\microsoft\\visualstudio\\14.0\\vc\\runtimes\\${arch}`) continue;
        const body = section.slice(section.indexOf(']') + 1);
        if (!/^"Installed"=dword:0*1\s*$/mi.test(body)) continue;
        const value = /^"Version"="v?(\d+\.\d+\.\d+\.\d+)"\s*$/mi.exec(body)?.[1];
        if (value) return value;
    }
    return '';
}
function atLeast(actual, minimum) {
    const a = actual.split('.').map(Number), b = minimum.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
}
function legacyRegistryVersion(registry, item) {
    let version = '', current = false;
    for (const section of registry.split(/^\[/m).slice(1)) {
        const key = section.split(']')[0].replace(/\\\\/g, '\\').toLowerCase();
        if (!/^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\[^\\]+$/.test(key)) continue;
        const body = section.slice(section.indexOf(']') + 1), name = /^"DisplayName"="([^"\r\n]+)"\s*$/mi.exec(body)?.[1] || '';
        if (!new RegExp(`^Microsoft Visual C\\+\\+ ${item.vcYear}(?:\\s|$)`, 'i').test(name) || !new RegExp(`\\b${item.arch}\\b`, 'i').test(name)) continue;
        const value = /^"DisplayVersion"="(\d+\.\d+\.\d+(?:\.\d+)?)"\s*$/mi.exec(body)?.[1];
        if (!value || value.split('.')[0] !== item.version.split('.')[0]) throw Error('An installed legacy component version could not be read.');
        const abbreviated = value.split('.').length === 3, normalized = abbreviated ? value + '.0' : value;
        // MSI display versions may omit the fourth file-version component.
        // An equal build with absent DLLs still needs an explicit repair.
        if (atLeast(normalized, abbreviated ? item.version.split('.').slice(0, 3).join('.') + '.0' : item.version)) current = true;
        if (!version || atLeast(normalized, version)) version = normalized;
    }
    return { version, current };
}
function legacyVc(prefix, item, registry) {
    const registered = legacyRegistryVersion(registry, item);
    const versions = item.dllNames.map(name => {
        if (!nativeDll(prefix, item.arch, name)) return '';
        const file = path.join(prefix, 'drive_c', 'windows', item.arch === 'x86' ? 'syswow64' : 'system32', name + '.dll');
        const image = fileVersion(file);
        if (!image.dll || image.builtin || image.arch !== item.arch || !image.version || image.version.split('.')[0] !== item.version.split('.')[0]) throw Error('A legacy component version could not be confirmed.');
        return image.version;
    });
    const minimum = name => item.dllVersions?.[name] || item.version;
    // VC 2012 Update 4's package/MSI version differs from its unchanged CRT
    // DLL versions. Require its package record as well as those native DLLs.
    const installed = versions.every((value, i) => value && atLeast(value, minimum(item.dllNames[i])))
        && (!item.dllVersions || registered.current);
    // An incomplete equal/newer installation needs repair, not an automatic
    // downgrade or a success receipt based on a DLL filename alone.
    const unknown = !installed && (registered.current || versions.some((value, i) => value && atLeast(value, minimum(item.dllNames[i]))
        && (!item.dllVersions || value !== minimum(item.dllNames[i]))));
    const detectedVersion = installed && item.dllVersions ? registered.version : versions.filter(Boolean).sort((a, b) => atLeast(a, b) ? 1 : -1)[0] || registered.version;
    return { installed, unknown, detectedVersion };
}
const WINE_DIRECTX_NOTE = 'On standalone Wine this installer needs Wine Mono and fails without it; Wine already provides many of these DirectX libraries, so try the game first.';
function probe(manager, scope, runtimeId = '') {
    const prefix = manager.prefixPath ? manager.prefixPath(scope, runtimeId) : path.join(manager.root, 'prefixes', scopeKey(scope));
    let registry = '', present = false, error = '';
    try {
        if (fs.existsSync(prefix)) {
            privateDirectory(manager.root); privateDirectory(path.dirname(prefix)); privateDirectory(prefix); present = true;
            try { registry = readOwned(path.join(prefix, 'system.reg'), 16 * 1024 ** 2).toString('utf8'); }
            catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
        }
    } catch (_) { error = 'The Windows environment could not be checked. Close the game and try again.'; }
    let standaloneWine = false;
    try { standaloneWine = !!runtimeId && manager.runtime(runtimeId).backend === 'wine'; } catch (_) { /* Runtime changes are reported by the install path. */ }
    const results = recipes.map(item => {
        let installed = false, detectedVersion = '', reason = error;
        try {
            if (!error && present && item.vcYear) {
                const legacy = legacyVc(prefix, item, registry); installed = legacy.installed; detectedVersion = legacy.detectedVersion;
                reason = 'Checks native C and C++ runtime DLLs, their architecture and file versions. Other optional libraries may still need setup.';
                if (legacy.unknown) return { ...publicRecipe(item, 'unknown', 'Some equal or newer runtime DLLs exist, but this component is incomplete. Use a local Microsoft installer to repair it.'), detectedVersion };
            } else if (!error && present && item.kind === 'visual-cpp') {
                const arch = item.id.endsWith('x86') ? 'x86' : 'x64'; detectedVersion = vcVersion(registry, arch);
                installed = !!detectedVersion && atLeast(detectedVersion, item.version)
                    && ['vcruntime140', 'msvcp140'].every(name => nativeDll(prefix, arch, name));
                reason = detectedVersion && !installed ? 'A registry entry exists; the selected version and native DLLs were not confirmed.' : '';
                if (!installed && detectedVersion && atLeast(detectedVersion, item.version)) return {
                    ...publicRecipe(item, 'unknown', 'An equal or newer Visual C++ registry entry exists, but its native DLLs could not be confirmed. Use a local Microsoft installer to repair it.'), detectedVersion };
            } else if (!error && present) {
                installed = ['x86', 'x64'].every(arch => ['d3dx9_43', 'd3dcompiler_43', 'xinput1_3', 'xaudio2_7'].every(name => nativeDll(prefix, arch, name)));
                reason = 'Checks common native legacy DLLs in both architectures. This does not certify every DirectX component or game.';
            }
        } catch (_) { reason = 'Component detection is unavailable for this environment.'; return publicRecipe(item, 'unknown', reason); }
        return { ...publicRecipe(item, error ? 'unknown' : installed ? 'detected' : 'not-detected', reason), detectedVersion };
    });
    // The DirectX June 2010 setup program needs .NET (Wine Mono) and fails without it; Proton bundles it, standalone Wine often does not.
    return standaloneWine ? results.map(item => item.id === 'directx-june2010' && item.detection === 'not-detected'
        ? { ...item, reason: WINE_DIRECTX_NOTE + (item.reason ? ' ' + item.reason : '') } : item) : results;
}
function publicRecipe(item, detection, reason) {
    return { id: item.id, label: item.label, version: item.version, size: item.size, infoUrl: item.infoUrl, detection, reason, legacy: !!item.vcYear };
}
module.exports = { MAX_RECIPES, recipes, recipe, hashFile, verifyPayload, download, probe };
