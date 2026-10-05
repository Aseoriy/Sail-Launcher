'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const releases = require('./releases');
const native = require('../native/protocol');
const { privateDirectory, privateRead, save } = require('./manager');

const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
function publicRelease(release) {
    const { id, kind, tag, size, publishedAt } = release;
    return { id, kind, tag, size, publishedAt };
}
function safeError(error) {
    if (error.name === 'AbortError') return 'Download canceled.';
    if (error.code === 'ENOSPC') return 'Not enough disk space. Free some space and try again.';
    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) return 'Could not reach the compatibility download server. Check your connection and try again.';
    return String(error.message || 'Compatibility installation failed.').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
}
function runtimeUsesDownload(entry, record) {
    if (require('./wine').runtimeBackend(entry) === 'wine') return [entry.wineRoot, entry.winePath, entry.serverPath, entry.loaderPath,
        ...(entry.loaders || []).map(item => item.realPath)].some(file => typeof file === 'string' && native.withinRoot(file, record.directory));
    return native.withinRoot(record.kind === 'proton' ? entry.protonRoot : entry.umuPath, record.directory);
}
class RuntimeDownloads {
    constructor({ manager, enabled = false, usage = () => new Map(), transport = releases }) {
        this.manager = manager; this.enabled = enabled; this.usage = usage; this.transport = transport;
        this.requirements = new (require('./requirements').HostRequirements)({ root: manager.root, enabled });
        this.root = path.join(manager.root, 'managed'); this.staging = path.join(manager.root, 'downloads');
        this.releases = new Map(); this.catalogAt = 0; this.catalogPromise = null;
        this.job = null; this.controller = null; this.child = null; this.operation = null; this.lastJobWrite = 0;
        const jobFile = path.join(manager.root, 'download-job.json');
        try { if (fs.existsSync(jobFile)) {
            privateDirectory(manager.root);
            const saved = JSON.parse(privateRead(jobFile, 16384));
            if (!saved || !native.UUID.test(saved.id) || !['umu', 'proton'].includes(saved.kind) || !TAG.test(saved.tag)
                || !['checking', 'starting', 'downloading', 'extracting', 'installing', 'completed', 'canceled', 'failed'].includes(saved.phase)) throw Error('Invalid compatibility download record.');
            this.job = saved;
            if (!['completed', 'canceled', 'failed'].includes(saved.phase)) {
                this.job = { ...saved, phase: 'failed', error: 'The previous compatibility installation was interrupted. Installed versions were kept. Retry the download to continue.' };
                // A full disk may prevent recording recovery. Keep the launcher
                // usable so the user can remove unused versions and retry.
                try { this.updateJob({}); } catch (_) {}
            }
        } } catch (_) { this.recordError = 'Compatibility download history could not be read. Existing game setups were kept. Repair the local download record before installing another version.'; }
    }
    updateJob(changes, persist = true) {
        this.job = { ...this.job, ...changes };
        if (!persist && Date.now() - this.lastJobWrite < 1000) return;
        privateDirectory(this.manager.root, true);
        save(path.join(this.manager.root, 'download-job.json'), JSON.stringify(this.job) + '\n'); this.lastJobWrite = Date.now();
    }
    cleanStaging() {
        if (!fs.existsSync(this.staging)) return;
        privateDirectory(this.staging);
        const entries = fs.readdirSync(this.staging); if (entries.length > 128) throw Error('Too many interrupted runtime downloads.');
        for (const name of entries) {
            if (!native.UUID.test(name)) throw Error('Invalid runtime download staging folder.');
            const directory = path.join(this.staging, name); privateDirectory(directory);
            // An extractor orphaned by a forced app exit has a three-minute
            // deadline. Do not race it while recovering after an immediate restart.
            if (Date.now() - fs.statSync(directory).mtimeMs > 10 * 60 * 1000) fs.rmSync(directory, { recursive: true });
        }
    }
    inventory() {
        if (!fs.existsSync(this.root)) return [];
        privateDirectory(this.manager.root); privateDirectory(this.root);
        const records = [];
        for (const kind of ['umu', 'proton']) {
            const parent = path.join(this.root, kind); if (!fs.existsSync(parent)) continue;
            privateDirectory(parent);
            const directories = fs.readdirSync(parent); if (directories.length > 64) throw Error('Too many managed compatibility versions.');
            for (const tag of directories) {
                if (!TAG.test(tag)) throw Error('Invalid managed runtime folder.');
                const directory = path.join(parent, tag); privateDirectory(directory);
                const value = JSON.parse(privateRead(path.join(directory, '.sail-install.json'), 16384));
                if (value.protocol !== 1 || value.kind !== kind || value.tag !== tag || !/^sha256:[a-f0-9]{64}$/.test(value.digest)
                    || typeof value.relativePath !== 'string' || !Number.isSafeInteger(value.installedAt)
                    || !value.relativePath || path.isAbsolute(value.relativePath) || value.relativePath.split('/').includes('..')
                    || /[\u0000-\u001f\u007f\\]/.test(value.relativePath)) throw Error('Invalid managed runtime record.');
                const selected = path.resolve(directory, value.relativePath);
                if (!native.withinRoot(selected, directory)) throw Error('Invalid managed runtime path.');
                records.push({ ...value, id: `${kind}:${tag}`, directory, selected });
            }
        }
        return records;
    }
    umuPaths() { return this.inventory().filter(record => record.kind === 'umu').sort((a, b) => b.installedAt - a.installedAt).map(record => record.selected); }
    status() {
        const catalog = this.manager.readCatalog(), usage = this.usage(), defaultId = this.manager.defaultRuntimeId();
        const installed = this.inventory().map(record => {
            const bound = catalog.filter(entry => runtimeUsesDownload(entry, record));
            const gameCount = bound.reduce((sum, entry) => sum + (usage.get(entry.id) || 0), 0);
            const defaultVersion = bound.some(entry => entry.id === defaultId);
            return { id: record.id, kind: record.kind, tag: record.tag, size: record.size, installedAt: record.installedAt,
                runtimeId: record.kind === 'proton' ? bound.find(entry => require('./wine').runtimeBackend(entry) === 'proton-umu')?.id || '' : '', gameCount,
                removable: !gameCount && !defaultVersion, reason: gameCount ? 'Used by a game setup or active session.'
                    : defaultVersion ? 'Choose another default before removing this version.' : '' };
        });
        return { available: this.enabled && !this.recordError, reason: this.recordError || (this.enabled ? '' : 'Runtime downloads are unavailable in this platform mode.'),
            installed, job: this.job ? { ...this.job } : null, releases: [...this.releases.values()].map(publicRelease),
            catalogAt: this.catalogAt };
    }
    async refresh(signal) {
        if (!this.enabled) throw Error('Runtime downloads are unavailable in this platform mode.');
        if (this.catalogPromise) return this.catalogPromise;
        this.catalogPromise = (async () => {
            const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 45000);
            const cancel = () => controller.abort();
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) cancel();
            try {
                const list = await Promise.all(['umu', 'proton'].map(kind => this.transport.listOfficialReleases(kind, controller.signal)));
                const values = list.flat(); if (!list.every(items => items.length)) throw Error('No verifiable compatible releases were found.');
                this.releases = new Map(values.map(item => [item.id, item])); this.catalogAt = Date.now();
                return this.status();
            } finally { clearTimeout(timeout); controller.abort(); signal?.removeEventListener('abort', cancel); this.catalogPromise = null; }
        })();
        return this.catalogPromise;
    }
    extract(archive, directory, kind, signal) {
        return new Promise((resolve, reject) => {
            // Electron can read this bundled source inside app.asar; system
            // Python cannot open an ASAR path. The program is fixed app code.
            const program = fs.readFileSync(path.join(__dirname, 'extract-runtime.py'), 'utf8');
            const child = spawn('/usr/bin/python3', ['-I', '-c', program, archive, directory, kind],
                { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
            this.child = child; let output = '', errors = '', settled = false;
            const cancel = () => child.kill('SIGKILL'); signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
            const timer = setTimeout(cancel, 180000);
            const finish = (error, value) => {
                if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
                if (this.child === child) this.child = null; error ? reject(error) : resolve(value);
            };
            child.stdout.on('data', bytes => { output += bytes; if (output.length > 4096) cancel(); });
            child.stderr.on('data', bytes => { if (errors.length < 8192) errors += bytes.toString().slice(0, 8192 - errors.length); });
            child.on('error', error => finish(error.code === 'ENOENT' ? Error('Install Python 3 to use the UMU launcher and runtime installer.') : error));
            child.on('close', code => {
                if (signal.aborted) { const error = Error('Download canceled.'); error.name = 'AbortError'; finish(error); return; }
                if (code !== 0) { finish(Error('Runtime extraction failed: ' + (errors.trim().split('\n').at(-1) || 'extraction was interrupted'))); return; }
                try { finish(null, JSON.parse(output)); } catch (_) { finish(Error('Invalid runtime extraction result.')); }
            });
        });
    }
    async installOne(release, controller) {
        const existing = this.inventory().find(record => record.id === `${release.kind}:${release.tag}`);
        if (existing) {
            if (existing.digest !== 'sha256:' + release.sha256) throw Error('The installed release digest differs. Choose another version or remove this unused installation first.');
            if (release.kind === 'umu') native.validateNativeExecutable(existing.selected, { allowScripts: true, fixtureRoot: this.manager.fixtureRoot });
            else require('./installation').validateProtonInstallation(existing.selected, { fixtureRoot: this.manager.fixtureRoot });
            return existing;
        }
        if (this.inventory().filter(record => record.kind === release.kind).length >= 32) throw Error('Remove an unused compatibility version before installing another.');
        privateDirectory(this.manager.root, true); privateDirectory(this.root, true); privateDirectory(this.staging, true);
        const parent = path.join(this.root, release.kind); privateDirectory(parent, true);
        const stage = path.join(this.staging, crypto.randomUUID()); privateDirectory(stage, true);
        const archive = path.join(stage, 'runtime.archive'), unpacked = path.join(stage, 'unpacked'); privateDirectory(unpacked, true);
        try {
            if (fs.statfsSync(stage).bavail * fs.statfsSync(stage).bsize < release.size + 128 * 1024 ** 2) throw Error('Not enough disk space for this runtime download.');
            this.updateJob({ phase: 'downloading', currentTag: release.tag, received: 0, total: release.size });
            await this.transport.downloadOfficial(release, archive, { signal: controller.signal, onProgress: (received, total) => {
                this.updateJob({ received, total }, false);
            } });
            controller.signal.throwIfAborted(); this.updateJob({ phase: 'extracting' });
            const extracted = await this.extract(archive, unpacked, release.kind, controller.signal);
            if (!extracted || typeof extracted.relativePath !== 'string' || path.isAbsolute(extracted.relativePath)
                || extracted.relativePath.split('/').includes('..')) throw Error('Invalid extracted runtime layout.');
            const selected = path.resolve(unpacked, extracted.relativePath);
            if (!native.withinRoot(selected, unpacked)) throw Error('Invalid extracted runtime path.');
            if (release.kind === 'umu') native.validateNativeExecutable(selected, { allowScripts: true, fixtureRoot: this.manager.fixtureRoot });
            else require('./installation').validateProtonInstallation(selected, { fixtureRoot: this.manager.fixtureRoot });
            const record = { protocol: 1, kind: release.kind, tag: release.tag, relativePath: extracted.relativePath,
                digest: 'sha256:' + release.sha256, size: release.size, installedAt: Date.now() };
            save(path.join(unpacked, '.sail-install.json'), JSON.stringify(record, null, 2) + '\n');
            controller.signal.throwIfAborted(); this.updateJob({ phase: 'installing' });
            const destination = path.join(parent, release.tag);
            // Never replace an installation whose executable identities are pinned.
            if (fs.existsSync(destination)) throw Error('This runtime version already exists. Refresh installed versions.');
            fs.renameSync(unpacked, destination);
            const fd = fs.openSync(parent, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            return { ...record, id: `${release.kind}:${release.tag}`, directory: destination, selected: path.join(destination, extracted.relativePath) };
        } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
    start(releaseId) {
        this.assertCanStart();
        const release = this.releases.get(releaseId);
        if (!release || Date.now() - this.catalogAt > 60 * 60 * 1000) throw Error('Refresh available compatibility versions before installing.');
        return this.begin(release);
    }
    startSetup() { return this.begin(null); }
    assertCanStart() {
        if (!this.enabled) throw Error('Runtime downloads are unavailable in this platform mode.');
        if (this.recordError) throw Error(this.recordError);
        if (this.operation) throw Error('A compatibility installation is already in progress.');
    }
    begin(release) {
        this.assertCanStart();
        this.cleanStaging();
        const controller = new AbortController();
        this.job = { id: crypto.randomUUID(), releaseId: release?.id || '', tag: release?.tag || 'Windows-tools',
            kind: release?.kind || 'proton', task: release ? 'install' : 'setup', phase: 'checking', received: 0, total: release?.size || 0, error: '' };
        this.updateJob({}); this.controller = controller;
        this.operation = (async () => {
            try {
                // Check before acquiring archives. A missing interpreter must
                // not waste a large Proton download or produce a ready state.
                const selectedDefault = this.manager.readCatalog().find(item => item.id === this.manager.defaultRuntimeId());
                const selectedBackend = !release && selectedDefault ? require('./wine').runtimeBackend(selectedDefault) : 'proton-umu';
                if (selectedBackend === 'wine') this.manager.assertLaunchReady('wine');
                await this.requirements.assertInstallable(selectedBackend); controller.signal.throwIfAborted();
                if (!release) {
                    const status = this.manager.status();
                    const existingDefault = status.defaultRuntimeId;
                    if (existingDefault && !status.runtimes.some(item => item.id === existingDefault && item.ready)) {
                        throw Error('Your selected default is unavailable. Choose another installed default, or restore that installation before retrying setup.');
                    }
                    const ready = status.runtimes.filter(item => item.ready && (item.backend !== 'wine' || this.manager.wineLaunchReadiness().available));
                    const existing = ready.find(item => item.id === existingDefault) || ready.at(-1);
                    if (existing) {
                        if (!existingDefault) this.manager.setDefaultRuntime(existing.id);
                        this.updateJob({ phase: 'completed', tag: 'Windows-tools', currentTag: existing.label,
                            runtimeId: existing.id, reused: true, error: '' });
                        return;
                    }
                    this.updateJob({ phase: 'checking', currentTag: 'official releases' });
                    await this.refresh(controller.signal); controller.signal.throwIfAborted();
                    release = [...this.releases.values()].find(item => item.kind === 'proton');
                    if (!release) throw Error('No verifiable GE-Proton version is available. Try checking releases again.');
                    this.updateJob({ releaseId: release.id, tag: release.tag, kind: release.kind, currentTag: release.tag });
                }
                let umu;
                if (release.kind === 'proton') {
                    umu = this.umuPaths()[0] || (await this.manager.installedStatus()).discovery.umu[0]?.path;
                    if (!umu) {
                        const latest = [...this.releases.values()].find(item => item.kind === 'umu');
                        if (!latest) throw Error('Refresh available versions to install UMU first.');
                        umu = (await this.installOne(latest, controller)).selected;
                    }
                }
                controller.signal.throwIfAborted(); const installed = await this.installOne(release, controller);
                controller.signal.throwIfAborted();
                if (release.kind === 'proton') {
                    const registered = this.manager.registerRuntime(umu, installed.selected);
                    if (!this.manager.defaultRuntimeId()) this.manager.setDefaultRuntime(registered.registeredRuntimeId);
                    this.updateJob({ runtimeId: registered.registeredRuntimeId });
                }
                this.updateJob({ phase: 'completed', received: release.size, total: release.size, error: '' });
            } catch (error) {
                const message = controller.signal.aborted ? 'Download canceled. Installed versions were kept.' : safeError(error);
                try { this.updateJob({ phase: controller.signal.aborted ? 'canceled' : 'failed', error: message }); }
                catch (_) { this.job = { ...this.job, phase: 'failed', error: safeError(error) }; }
            } finally { this.operation = null; this.controller = null; }
        })();
        return this.status();
    }
    cancel(id) {
        if (!this.job || this.job.id !== id || !this.controller) throw Error('This compatibility download is no longer active.');
        this.controller.abort(); return { canceled: true };
    }
    remove(id) {
        if (this.operation) throw Error('Wait for the compatibility installation to finish.');
        const record = this.inventory().find(item => item.id === id);
        if (!record) throw Error('This Sail-managed version is no longer installed.');
        const status = this.status().installed.find(item => item.id === id);
        if (!status.removable) throw Error(status.reason);
        const ids = this.manager.readCatalog().filter(entry => runtimeUsesDownload(entry, record)).map(entry => entry.id);
        this.manager.unregisterRuntimes(ids);
        privateDirectory(record.directory);
        fs.rmSync(record.directory, { recursive: true });
        return this.status();
    }
    dispose() { this.controller?.abort(); this.child?.kill('SIGKILL'); this.requirements.dispose(); }
}
module.exports = { RuntimeDownloads, safeError };
