'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const native = require('../native/protocol');
const { fileIdentity, identityMatches } = require('../../security/capabilityStore');
const { validateWindowsExecutable } = require('./executable');
const wine = require('./wine');

const LAUNCH_PENDING_REASON = 'Windows game launching is unavailable without compatible UMU, Proton and Windows image tracking.';
// Experimental direct-game path: validated owned PE image activity, not
// graphics or compatibility certification. The installed helper must opt in.
const UMU_LIFECYCLE_VERIFIED = true;
const UMU_PREPARATION_VERIFIED = false;
const PREPARATION_PENDING_REASON = 'Windows environment preparation is awaiting UMU lifecycle verification.';
function privateDirectory(directory, create = false) {
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
        || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('Proton storage must be a private owned directory.');
}
function privateRead(file, limit) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit) throw Error('Invalid private Proton record.');
        const bytes = Buffer.alloc(limit + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (count > limit) throw Error('Oversized Proton record.');
        return bytes.subarray(0, count).toString('utf8');
    } finally { fs.closeSync(fd); }
}
function save(file, value) {
    const temp = path.join(path.dirname(file), '.' + crypto.randomUUID() + '.tmp');
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temp, file); const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
    finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function tomlString(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw Error('Invalid Proton configuration string.');
    return JSON.stringify(value);
}
function scopeKey(scope) {
    for (const key of ['profileId', 'libraryId', 'gameId']) {
        if (typeof scope[key] !== 'string' || !scope[key] || scope[key].length > 160) throw Error('A scoped game is required for its Windows environment.');
    }
    return crypto.createHash('sha256').update(JSON.stringify([scope.profileId, scope.libraryId, scope.gameId])).digest('hex');
}
function exists(file) {
    try { fs.lstatSync(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
class ProtonManager {
    constructor({ root, fixtureRoot = null, discoveryOptions = {} }) {
        this.root = path.resolve(root); this.fixtureRoot = fixtureRoot; this.discoveryOptions = discoveryOptions;
        this.catalogFile = path.join(this.root, 'runtimes.json');
    }
    readCatalog() {
        if (!exists(this.root)) return [];
        privateDirectory(this.root);
        if (!exists(this.catalogFile)) return [];
        const value = JSON.parse(privateRead(this.catalogFile, 128 * 1024));
        if (value.protocol !== 1 || !Array.isArray(value.runtimes) || value.runtimes.length > 32) throw Error('Invalid Proton runtime catalog.');
        const ids = new Set();
        for (const entry of value.runtimes) {
            if (!native.UUID.test(entry.id) || ids.has(entry.id) || typeof entry.label !== 'string' || entry.label.length > 160
                || !wine.windowsBackend(wine.runtimeBackend(entry))) throw Error('Invalid compatibility runtime entry.');
            if (wine.runtimeBackend(entry) === 'wine') {
                if (['winePath', 'wineRoot', 'serverPath', 'loaderPath'].some(key => typeof entry[key] !== 'string' || !path.isAbsolute(entry[key]))
                    || !entry.wineIdentity || !entry.serverIdentity || !entry.rootIdentity || !Array.isArray(entry.loaders)
                    || !entry.loaders.length || entry.loaders.length > 24) throw Error('Invalid Wine runtime entry.');
            } else if (typeof entry.umuPath !== 'string' || !path.isAbsolute(entry.umuPath)
                || typeof entry.protonRoot !== 'string' || !path.isAbsolute(entry.protonRoot)
                || !entry.umuIdentity || !entry.protonIdentity || !entry.rootIdentity) throw Error('Invalid Proton runtime entry.');
            ids.add(entry.id);
        }
        return value.runtimes;
    }
    verifyRuntime(entry) {
        if (wine.runtimeBackend(entry) === 'wine') return wine.verifyWineRuntime(entry, { fixtureRoot: this.fixtureRoot });
        native.validateNativeExecutable(entry.umuPath, { allowScripts: true, expected: entry.umuIdentity, fixtureRoot: this.fixtureRoot });
        native.validateNativeExecutable(path.join(entry.protonRoot, 'proton'), { allowScripts: true, expected: entry.protonIdentity, fixtureRoot: this.fixtureRoot });
        const root = fileIdentity(entry.protonRoot, 'directory');
        if (!identityMatches(entry.rootIdentity, root) || root.realPath !== entry.protonRoot) throw Error('The selected Proton directory changed. Add its new version explicitly.');
        return entry;
    }
    status() {
        return { ...this.launchReadiness(), preparation: this.preparationReadiness(), defaultRuntimeId: this.defaultRuntimeId(),
            runtimes: this.readCatalog().map(entry => {
                try { this.verifyRuntime(entry); return { id: entry.id, backend: wine.runtimeBackend(entry), label: entry.label, ready: true, reason: '' }; }
                catch (error) { return { id: entry.id, backend: wine.runtimeBackend(entry), label: entry.label, ready: false, reason: error.message }; }
            }) };
    }
    async installedStatus() {
        const status = this.status();
        const entries = this.readCatalog();
        const discovery = await require('./discovery').discoverInstalledRuntimes({ ...this.discoveryOptions,
            fixtureRoot: this.fixtureRoot, knownUmuPaths: [...(this.downloads?.umuPaths() || []), ...entries.filter(entry => {
                if (wine.runtimeBackend(entry) !== 'proton-umu') return false;
                try { native.validateNativeExecutable(entry.umuPath, { allowScripts: true, expected: entry.umuIdentity, fixtureRoot: this.fixtureRoot }); return true; }
                catch (_) { return false; }
            }).map(entry => entry.umuPath)] });
        for (const candidate of discovery.proton) {
            candidate.registeredRuntimeId = entries.find(entry => entry.protonRoot === candidate.path && status.runtimes.some(r => r.id === entry.id && r.ready))?.id || '';
        }
        for (const candidate of discovery.wine) {
            candidate.registeredRuntimeId = entries.find(entry => wine.runtimeBackend(entry) === 'wine' && entry.winePath === candidate.path
                && status.runtimes.some(runtime => runtime.id === entry.id && runtime.ready))?.id || '';
        }
        // A crash after atomic publication can leave a complete download before
        // catalog registration. Offer it through the existing explicit approval
        // flow rather than silently replacing any pinned runtime identities.
        for (const installed of this.downloads?.inventory() || []) {
            if (installed.kind !== 'proton' || discovery.proton.some(candidate => candidate.path === installed.selected)) continue;
            try {
                const validated = require('./installation').validateProtonInstallation(installed.selected, { fixtureRoot: this.fixtureRoot });
                discovery.proton.push({ id: require('./discovery').installationId(validated), path: installed.selected, label: installed.tag,
                    available: true, reason: '', registeredRuntimeId: entries.find(entry => entry.protonRoot === installed.selected
                        && status.runtimes.some(runtime => runtime.id === entry.id && runtime.ready))?.id || '' });
            } catch (_) { /* Broken downloads stay removable in the managed list. */ }
        }
        return { ...status, discovery, wineLaunch: this.wineLaunchReadiness() };
    }
    launchReadiness() { return { available: UMU_LIFECYCLE_VERIFIED, reason: UMU_LIFECYCLE_VERIFIED ? '' : LAUNCH_PENDING_REASON }; }
    wineLaunchReadiness() { return { available: wine.WINE_LIFECYCLE_VERIFIED, reason: wine.WINE_LIFECYCLE_VERIFIED ? '' : wine.WINE_PENDING_REASON }; }
    readPreferences() {
        const file = path.join(this.root, 'preferences.json');
        if (!exists(file)) return { protocol: 1, defaultRuntimeId: '' };
        privateDirectory(this.root);
        const value = JSON.parse(privateRead(file, 16384));
        if (value.protocol !== 1 || value.defaultRuntimeId !== '' && !native.UUID.test(value.defaultRuntimeId)) throw Error('Invalid compatibility preferences.');
        return value;
    }
    defaultRuntimeId() { return this.readPreferences().defaultRuntimeId; }
    setupNoticeDismissed() { return this.readPreferences().setupNoticeDismissed === true; }
    dismissSetupNotice() {
        const value = this.readPreferences(); privateDirectory(this.root, true);
        save(path.join(this.root, 'preferences.json'), JSON.stringify({ ...value, setupNoticeDismissed: true }, null, 2) + '\n');
        return { dismissed: true };
    }
    setDefaultRuntime(id) {
        if (id !== '') this.runtime(id);
        privateDirectory(this.root, true);
        const file = path.join(this.root, 'preferences.json');
        const previous = exists(file) ? JSON.parse(privateRead(file, 16384)) : {};
        save(file, JSON.stringify({ ...previous, protocol: 1, defaultRuntimeId: id }, null, 2) + '\n');
        return { defaultRuntimeId: id };
    }
    unregisterRuntimes(ids) {
        const runtimes = this.readCatalog().filter(entry => !ids.includes(entry.id));
        save(this.catalogFile, JSON.stringify({ protocol: 1, runtimes }, null, 2) + '\n');
    }
    registerRuntime(umuPath, protonRoot) {
        if (typeof umuPath !== 'string' || path.basename(umuPath) !== 'umu-run') throw Error('Choose the separate umu-run launcher, not the proton or wine executable.');
        const umu = native.validateNativeExecutable(umuPath, { allowScripts: true, fixtureRoot: this.fixtureRoot });
        const installation = require('./installation').validateProtonInstallation(protonRoot, { fixtureRoot: this.fixtureRoot });
        const { root, rootIdentity, protonIdentity: proton } = installation;
        const runtimes = this.readCatalog();
        const same = runtimes.find(entry => entry.umuPath === umu.realPath && entry.protonRoot === root
            && identityMatches(entry.umuIdentity, umu) && identityMatches(entry.protonIdentity, proton));
        if (same) return { ...this.status(), registeredRuntimeId: same.id };
        if (runtimes.length >= 32) throw Error('The installed runtime catalog is full.');
        const entry = { id: crypto.randomUUID(), label: path.basename(root).slice(0, 160), umuPath: umu.realPath,
            protonRoot: root, umuIdentity: umu, protonIdentity: proton, rootIdentity };
        this.verifyRuntime(entry);
        privateDirectory(this.root, true); runtimes.push(entry);
        save(this.catalogFile, JSON.stringify({ protocol: 1, runtimes }, null, 2) + '\n');
        return { ...this.status(), registeredRuntimeId: entry.id };
    }
    registerWineRuntime(selected, label = '') {
        const installation = wine.validateWineInstallation(selected, { fixtureRoot: this.fixtureRoot }), runtimes = this.readCatalog();
        const same = runtimes.find(entry => wine.runtimeBackend(entry) === 'wine' && entry.winePath === installation.winePath
            && wine.installationId(entry) === wine.installationId(installation));
        if (same) return { ...this.status(), registeredRuntimeId: same.id };
        if (runtimes.length >= 32) throw Error('The installed runtime catalog is full.');
        const entry = { id: crypto.randomUUID(), backend: 'wine', label: ('Wine · ' + (label || (installation.root === '/usr' ? 'System Wine' : path.basename(installation.root)))).slice(0, 160),
            wineRoot: installation.root, ...installation };
        this.verifyRuntime(entry); privateDirectory(this.root, true); runtimes.push(entry);
        save(this.catalogFile, JSON.stringify({ protocol: 1, runtimes }, null, 2) + '\n');
        return { ...this.status(), registeredRuntimeId: entry.id };
    }
    runtime(id) {
        const entry = this.readCatalog().find(item => item.id === id);
        if (!entry) throw native.nativeError('SAIL_PROTON_RUNTIME', 'Choose an installed Proton or Wine version for this game.');
        return this.verifyRuntime(entry);
    }
    prefixPath(scope, runtimeId = '') {
        const backend = runtimeId ? wine.runtimeBackend(this.runtime(runtimeId)) : 'proton-umu';
        return path.join(this.root, backend === 'wine' ? 'wine-prefixes' : 'prefixes', scopeKey(scope));
    }
    preparationReadiness() { return { available: UMU_PREPARATION_VERIFIED, reason: UMU_PREPARATION_VERIFIED ? '' : PREPARATION_PENDING_REASON }; }
    environmentStatus({ scope, runtimeId, snapshot = { activeSessions: {}, completedSessions: [] } }) {
        const key = scopeKey(scope);
        if (!runtimeId) return { phase: 'runtime-required', reason: 'Choose a Proton or Wine version for this game’s Windows environment.' };
        const runtime = this.runtime(runtimeId), prefix = this.prefixPath(scope, runtimeId);
        const active = Object.values(snapshot.activeSessions || {}).find(session => session.provider === 'linux-native'
            && session.gameId === scope.gameId && session.libraryKey === `${scope.profileId}:${scope.libraryId}`
            && session.native?.launchMetadata?.prefixKey === key && session.native.launchMetadata.runtimeId === runtimeId);
        if (active && require('./tracking').confirmedGame(active)) return { phase: 'game-running', preparation: { available: false, reason: 'This game has an active compatibility session.' }, reason: active.native.receipt.game.activeProcesses ? 'The Windows game process is running.' : 'Windows game processes ended; compatibility cleanup is pending.' };
        if (active?.native.launchMetadata.activity === 'installation') return { phase: active.native.phase === 'tracking-lost' ? 'tracking-lost' : 'installing',
            preparation: { available: false, reason: 'A Windows installer is using this environment.' },
            reason: active.native.error || 'A Windows installer is running in this environment. Installation time is not counted as playtime.' };
        if (active) return { phase: active.native.phase === 'tracking-lost' ? 'tracking-lost'
            : active.native.launchMetadata.activity === 'preparation' ? 'preparing' : 'awaiting-game-confirmation',
            preparation: { available: false, reason: 'This game already has an active or unresolved compatibility session.' },
            reason: active.native.error || (active.native.launchMetadata.activity === 'preparation'
                ? 'Preparing this game’s Windows environment; no playtime is being counted.'
                : 'The compatibility runner is active; Windows game startup has not been confirmed.') };
        if (exists(prefix)) privateDirectory(prefix);
        // A directory (or registry file) can come from a failed or interrupted
        // initialization. Only accepted lifecycle evidence can make it ready.
        return { phase: exists(prefix) ? 'initialization-unverified' : 'not-prepared',
            preparation: this.preparationReadiness(), reason: wine.runtimeBackend(runtime) === 'wine' && !this.wineLaunchReadiness().available ? wine.WINE_PENDING_REASON : exists(prefix)
                ? 'The Windows environment exists. Play initializes it as needed; separate preparation remains unavailable.'
                : 'Play will create and initialize this game’s Windows environment.' };
    }
    preparationExecutable(runtime, expected = null) {
        // This is a runtime-owned initializer, not a guessed game executable.
        // Unsupported runtime layouts remain explicit preparation errors.
        const selected = path.join(runtime.protonRoot, 'files', 'lib', 'wine', 'x86_64-windows', 'wineboot.exe');
        const executable = validateWindowsExecutable(selected, { expected, fixtureRoot: this.fixtureRoot });
        if (!native.withinRoot(executable.realPath, runtime.protonRoot)) throw Error('The runtime initializer must belong to the selected Proton version.');
        return executable;
    }
    savePrefix(scope, runtimeId = '') {
        const prefix = this.prefixPath(scope, runtimeId);
        privateDirectory(this.root); privateDirectory(path.dirname(prefix)); privateDirectory(prefix);
        return prefix;
    }
    plan({ scope, details, activity, installation = null }) {
        if (!['preparation', 'game', 'installation'].includes(activity)) throw Error('Invalid Proton activity.');
        native.assertNativeOptions(details);
        if (!wine.windowsBackend(details.linuxRuntime?.backend)) throw Error('An approved Windows game setup is required.');
        const target = validateWindowsExecutable(details.executablePath, { expected: details.executableIdentity, fixtureRoot: this.fixtureRoot });
        const cwd = native.validateWorkingDirectory(details.workingDirectory, { expected: details.workingDirectoryIdentity, fixtureRoot: this.fixtureRoot });
        const argv = native.validateArgv(details.argv || []), runtime = this.runtime(details.linuxRuntime?.runtimeId);
        const backend = wine.runtimeBackend(runtime);
        if (backend !== details.linuxRuntime.backend) throw Error('The approved compatibility backend does not match this version.');
        const dllOverrides = require('./environment').validateDllOverrides(details.linuxRuntime.dllOverrides);
        if (backend === 'wine' && argv.length > 127) throw native.nativeError('SAIL_NATIVE_ARGUMENTS', 'Wine accepts at most 127 literal game arguments alongside the executable.');
        if (backend === 'wine' && activity === 'preparation') throw Error('Separate Wine environment preparation remains unavailable.');
        const initializer = activity === 'preparation' ? this.preparationExecutable(runtime) : null;
        const step = activity === 'installation' ? require('./prerequisites').validateStep(installation.step, this) : null;
        const key = scopeKey(scope), prefixRoot = path.join(this.root, backend === 'wine' ? 'wine-prefixes' : 'prefixes'), launches = path.join(this.root, 'launches');
        privateDirectory(this.root, true); privateDirectory(prefixRoot, true); privateDirectory(launches, true);
        const prefix = path.join(prefixRoot, key); privateDirectory(prefix, true);
        require('./saves').recoverSaveImport(prefix, details.executablePath, backend);
        const prefixIdentity = fileIdentity(prefix, 'directory');
        if (backend === 'proton-umu' && !initializer && fs.readdirSync(launches).length >= 256) throw Error('Proton launch records need cleanup before another launch.');
        const config = path.join(launches, crypto.randomUUID() + '.toml');
        // Absolute version paths pin the selected runner; codenames that download
        // or remove versions automatically are never emitted here.
        const text = backend === 'proton-umu' ? '[umu]\n' + ['prefix = ' + tomlString(prefix), 'proton = ' + tomlString(runtime.protonRoot),
            'game_id = "umu-default"', 'store = "none"', 'exe = ' + tomlString(step ? step.executable.realPath : target.realPath),
            'launch_args = [' + (step ? step.argv : argv).map(tomlString).join(', ') + ']'].join('\n') + '\n' : '';
        if (text && !initializer) save(config, text);
        const configIdentity = text && !initializer ? fileIdentity(config, 'file') : null;
        const resolve = current => {
            if (current.linuxRuntime?.backend !== backend || current.linuxRuntime.runtimeId !== runtime.id
                || require('./environment').validateDllOverrides(current.linuxRuntime.dllOverrides) !== dllOverrides
                || JSON.stringify(native.validateArgv(current.argv || [])) !== JSON.stringify(argv)) throw native.nativeError('SAIL_CAPABILITY_PATH_CHANGED', 'Proton setup changed before launch. Review it again.');
            native.assertNativeOptions(current);
            validateWindowsExecutable(current.executablePath, { expected: target, fixtureRoot: this.fixtureRoot });
            native.validateWorkingDirectory(current.workingDirectory, { expected: cwd, fixtureRoot: this.fixtureRoot });
            this.verifyRuntime(runtime); privateDirectory(prefix);
            if (initializer) this.preparationExecutable(runtime, initializer);
            if (step) require('./prerequisites').validateStep(step, this);
            if (!identityMatches(prefixIdentity, fileIdentity(prefix, 'directory'))) throw Error('The game Windows environment changed before launch.');
            if (configIdentity && !identityMatches(configIdentity, fileIdentity(config, 'file'))) throw Error('The private Proton launch configuration changed.');
            if (backend === 'wine') return {
                executablePath: runtime.winePath, executableIdentity: runtime.wineIdentity,
                workingDirectory: step ? step.cwd.realPath : cwd.realPath, workingDirectoryIdentity: step ? step.cwd : cwd,
                wineEnvironment: { activity, prefix, root: runtime.wineRoot, loader: runtime.loaderPath, server: runtime.serverPath,
                    ...(dllOverrides && !step ? { dllOverrides } : {}) },
                ...(activity === 'game' ? { gameTracking: require('./tracking').validateGameTracking({ backend: 'wine', target, prefix,
                    protonRoot: runtime.wineRoot, loaders: runtime.loaders }) } : {}),
                argv: [step ? step.executable.realPath : target.realPath, ...(step ? step.argv : argv)]
            };
            return { executablePath: runtime.umuPath, executableIdentity: runtime.umuIdentity,
                workingDirectory: step ? step.cwd.realPath : cwd.realPath, workingDirectoryIdentity: step ? step.cwd : cwd,
                umuEnvironment: { activity, prefix, proton: runtime.protonRoot, ...(dllOverrides && !step ? { dllOverrides } : {}) },
                ...(activity === 'game' ? { gameTracking: require('./tracking').validateGameTracking({ target, prefix, protonRoot: runtime.protonRoot }) } : {}),
                argv: initializer ? [initializer.realPath, '--init'] : ['--config', config] };
        };
        return { resolve, metadata: { backend, runtimeId: runtime.id, label: runtime.label, prefixKey: key, activity,
            ...(step ? { installationId: installation.id, installationStep: installation.index } : {}) } };
    }
    prepare(input) { return this.plan({ ...input, activity: 'game' }); }
    prepareEnvironment(input) { return this.plan({ ...input, activity: 'preparation' }); }
    prepareInstallation(input) { return this.plan({ ...input, activity: 'installation' }); }
    assertPreparationReady() {
        if (!UMU_PREPARATION_VERIFIED) throw native.nativeError('SAIL_PROTON_PREPARATION_PENDING', PREPARATION_PENDING_REASON);
    }
    assertLaunchReady(backend = 'proton-umu') {
        if (backend === 'wine') {
            if (!wine.WINE_LIFECYCLE_VERIFIED) throw native.nativeError('SAIL_WINE_VALIDATION_PENDING', wine.WINE_PENDING_REASON);
            return;
        }
        if (backend !== 'proton-umu') throw native.nativeError('SAIL_PROTON_RUNTIME', 'Choose an approved Proton or Wine version.');
        if (!UMU_LIFECYCLE_VERIFIED) throw native.nativeError('SAIL_PROTON_VALIDATION_PENDING', LAUNCH_PENDING_REASON);
    }
}
module.exports = { ProtonManager, LAUNCH_PENDING_REASON, PREPARATION_PENDING_REASON, scopeKey, privateDirectory, privateRead, save };
