'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const native = require('../native/protocol');
const { discoverSteamInstallations } = require('../steamDiscovery');
const { validateProtonInstallation } = require('./installation');
const MAX_ENTRIES = 512, MAX_RUNTIMES = 64;
const safeLabel = text => String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
function smallText(file, limit = 4096) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > limit) throw Error('Oversized runtime metadata.');
        const bytes = Buffer.alloc(limit + 1), size = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (size > limit) throw Error('Oversized runtime metadata.');
        return bytes.subarray(0, size).toString('utf8');
    } finally { fs.closeSync(fd); }
}
function versionLabel(root, fallback) {
    for (const name of ['version', 'VERSION']) {
        try { const value = safeLabel(smallText(path.join(root, name))).slice(0, 96); if (value) return value; }
        catch (_) {}
    }
    return safeLabel(fallback);
}
function installationId(value) {
    const p = value.protonIdentity;
    return crypto.createHash('sha256').update(JSON.stringify([value.root, p.dev, p.ino, p.size, p.mtimeMs])).digest('hex');
}
async function discoverInstalledRuntimes({ home = os.homedir(), env = process.env, fixtureRoot = null,
    steamRoots, protonRoots, wineRoots, umuPaths, knownUmuPaths = [], packageStatus = '/var/lib/dpkg/status' } = {}) {
    const proton = [], wine = [], umu = [], issues = [];
    let issueCount = 0;
    const issue = text => { issueCount++; if (issues.length < 16) issues.push(text); };
    const inBoundary = file => { native.assertFixturePath(file, fixtureRoot); return file; };
    const seen = new Set();
    async function folders(parent, visit) {
        let dir;
        try { inBoundary(fs.realpathSync(parent)); dir = await fs.promises.opendir(parent); }
        catch (error) { if (error.code !== 'ENOENT') issue('A runtime search folder is unavailable.'); return; }
        let count = 0;
        for await (const entry of dir) {
            if (++count > MAX_ENTRIES) { issue('Runtime folder scan limit reached.'); break; }
            if (entry.isDirectory() || entry.isSymbolicLink()) await visit(path.join(parent, entry.name));
        }
    }
    async function addProton(candidate) {
        if (proton.length >= MAX_RUNTIMES) return;
        let root;
        try { root = inBoundary(fs.realpathSync(candidate)); if (seen.has('p:' + root)) return; }
        catch (_) { return; }
        // Other Steam applications are not compatibility tools.
        if (!/proton/i.test(path.basename(root)) && !fs.existsSync(path.join(root, 'proton'))) return;
        seen.add('p:' + root);
        try {
            const validated = validateProtonInstallation(root, { fixtureRoot });
            proton.push({ id: installationId(validated), path: root, label: safeLabel(path.basename(root)),
                version: versionLabel(root, path.basename(root)), available: true, reason: '' });
        } catch (error) {
            proton.push({ id: crypto.createHash('sha256').update(root).digest('hex'), path: root,
                label: safeLabel(path.basename(root)), version: '', available: false, reason: safeLabel(error.message) });
        }
    }
    // Reuse bounded, read-only Steam libraryfolders metadata, including aliases
    // and secondary/Flatpak libraries. Never walk games or execute discovered tools.
    // An explicit fixture boundary must not read the real user's Steam metadata.
    let roots = steamRoots;
    if (fixtureRoot && !roots && !native.withinRoot(path.resolve(home), fixtureRoot)) roots = [];
    if (fixtureRoot && roots) roots = roots.filter(root => { try { inBoundary(fs.realpathSync(root)); return true; } catch (_) { return false; } });
    const steam = await discoverSteamInstallations({ home, roots });
    for (const message of steam.issues) issue(message);
    for (const library of steam.libraries) {
        try { inBoundary(library); } catch (_) { continue; }
        await folders(path.join(library, 'steamapps', 'common'), addProton);
        await folders(path.join(library, 'compatibilitytools.d'), addProton);
    }
    const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local/share');
    for (const parent of (protonRoots || [path.join(data, 'Steam/compatibilitytools.d'), path.join(data, 'lutris/runners/proton'),
        path.join(home, '.var/app/com.heroicgameslauncher.hgl/config/heroic/tools/proton'),
        path.join(home, '.config/heroic/tools/proton')]).slice(0, 32)) await folders(parent, addProton);
    let systemWineVersion = '';
    try {
        inBoundary(packageStatus);
        const status = smallText(packageStatus, 8 * 1024 * 1024);
        const block = status.split(/\n\n/).find(value => /^Package: wine(?:-stable)?$/m.test(value) && /^Status: install ok installed$/m.test(value));
        systemWineVersion = safeLabel(block?.match(/^Version: (.+)$/m)?.[1] || '');
    } catch (_) {}
    function addWine(candidate, label, version) {
        if (wine.length >= MAX_RUNTIMES) return;
        try {
            const identity = native.validateNativeExecutable(candidate, { allowScripts: true, fixtureRoot });
            if (seen.has('w:' + identity.realPath)) return;
            seen.add('w:' + identity.realPath);
            try {
                const installation = require('./wine').validateWineInstallation(identity.realPath, { fixtureRoot });
                wine.push({ id: require('./wine').installationId(installation), path: identity.realPath, label: safeLabel(label), version,
                    available: true, reason: require('./wine').WINE_LIFECYCLE_VERIFIED ? '' : require('./wine').WINE_PENDING_REASON });
            } catch (error) {
                wine.push({ id: crypto.createHash('sha256').update(identity.realPath).digest('hex'), path: identity.realPath, label: safeLabel(label), version,
                    available: false, reason: safeLabel(error.message) });
            }
        } catch (_) {}
    }
    const searchPath = (env.PATH || '').split(path.delimiter).filter(p => path.isAbsolute(p)).slice(0, 32);
    for (const directory of searchPath) addWine(path.join(directory, 'wine'), 'System Wine', systemWineVersion);
    if (!fixtureRoot) for (const root of ['/opt/wine-stable', '/opt/wine-devel', '/opt/wine-staging']) addWine(path.join(root, 'bin/wine'), path.basename(root), versionLabel(root, ''));
    for (const parent of (wineRoots || [path.join(data, 'lutris/runners/wine'), path.join(data, 'bottles/runners'),
        path.join(home, '.var/app/com.usebottles.bottles/data/bottles/runners'),
        path.join(home, '.config/heroic/tools/wine'), path.join(home, '.var/app/com.heroicgameslauncher.hgl/config/heroic/tools/wine')]).slice(0, 32)) {
        await folders(parent, async root => {
            try { root = inBoundary(fs.realpathSync(root)); } catch (_) { return; }
            const label = path.basename(root), version = versionLabel(root, label);
            for (const name of ['wine', 'wine64']) addWine(path.join(root, 'bin', name), label, version);
        });
    }
    const runners = [...knownUmuPaths, ...(umuPaths || [path.join(home, '.local/bin/umu-run'),
        ...searchPath.map(directory => path.join(directory, 'umu-run')),
        path.join(data, 'pipx/venvs/umu-launcher/bin/umu-run')])];
    for (const candidate of runners.slice(0, 96)) {
        try {
            // Only paths named umu-run are discovery candidates, never proton/wine.
            if (typeof candidate !== 'string' || path.basename(candidate) !== 'umu-run') continue;
            const identity = native.validateNativeExecutable(candidate, { allowScripts: true, fixtureRoot });
            if (seen.has('u:' + identity.realPath)) continue;
            seen.add('u:' + identity.realPath); umu.push({ path: identity.realPath });
        } catch (_) {}
    }
    return { proton, wine, umu, issues, issueCount };
}
module.exports = { discoverInstalledRuntimes, installationId, validateProtonInstallation };
