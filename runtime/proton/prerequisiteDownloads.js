'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const packages = require('./prerequisitePackages');
const { scopeKey, privateDirectory, privateRead, save } = require('./manager');
const { installer, officialRecipe } = require('./prerequisites');
const native = require('../native/protocol');
const ACTIVE = new Set(['checking', 'downloading', 'extracting', 'queuing']);
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'interrupted']);
const safeError = error => String(error.message || error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);

class PrerequisiteDownloads {
    constructor({ manager, installations, enabled = false, transport = packages }) {
        this.manager = manager; this.installations = installations; this.enabled = enabled; this.transport = transport;
        this.root = path.join(manager.root, 'prerequisites'); this.records = path.join(this.root, 'jobs');
        this.cache = path.join(this.root, 'cache'); this.staging = path.join(this.root, 'staging');
        this.operation = null; this.disposed = false;
    }
    read(scope) {
        const file = path.join(this.records, scopeKey(scope) + '.json');
        if (!fs.existsSync(this.records)) return null;
        privateDirectory(this.manager.root); privateDirectory(this.root); privateDirectory(this.records);
        if (!fs.existsSync(file)) return null;
        const job = JSON.parse(privateRead(file, 32768));
        if (job.protocol !== 1 || !native.UUID.test(job.id) || !native.UUID.test(job.runtimeId) || scopeKey(job.scope) !== scopeKey(scope)
            || ![...ACTIVE, ...TERMINAL, 'installing'].includes(job.phase) || !Array.isArray(job.recipeIds) || !job.recipeIds.length || job.recipeIds.length > packages.MAX_RECIPES
            || new Set(job.recipeIds).size !== job.recipeIds.length || !Number.isSafeInteger(job.createdAt)
            || !Number.isSafeInteger(job.received) || job.received < 0 || !Number.isSafeInteger(job.total) || job.total < 0
            || typeof job.cancelRequested !== 'boolean' || job.installationId && !native.UUID.test(job.installationId)) throw Error('The prerequisite download record needs repair. Existing files were kept.');
        for (const id of job.recipeIds) packages.recipe(id);
        if (job.backend !== undefined && !require('./wine').windowsBackend(job.backend)) throw Error('Invalid prerequisite backend. Existing files were kept.');
        return job;
    }
    write(job, progress = false) {
        if (progress && Date.now() - (this.lastWrite || 0) < 1000) return;
        privateDirectory(this.manager.root, true); privateDirectory(this.root, true); privateDirectory(this.records, true);
        const file = path.join(this.records, scopeKey(job.scope) + '.json');
        if (fs.readdirSync(this.records).length >= 256 && !fs.existsSync(file)) throw Error('Too many prerequisite download records.');
        job.updatedAt = Date.now(); save(file, JSON.stringify(job) + '\n'); this.lastWrite = Date.now();
    }
    assertCanStart(scope) {
        if (!this.enabled || this.disposed) throw Error('Prerequisite downloads are unavailable in this platform mode.');
        if (this.operation) throw Error('A prerequisite download is already in progress.');
        this.installations.assertIdle(scope);
    }
    assertIdle(scope, acquisitionId = null) {
        if (this.operation && scopeKey(this.operation.job.scope) === scopeKey(scope) && acquisitionId !== this.operation.job.id) throw Error('Wait for this game’s prerequisite download, or cancel it first.');
    }
    pendingBindings() {
        const job = this.operation?.job;
        return job ? [{ provider: 'linux-native', gameId: job.scope.gameId, libraryKey: `${job.scope.profileId}:${job.scope.libraryId}` }] : [];
    }
    status(scope) {
        let job = this.operation && scopeKey(this.operation.job.scope) === scopeKey(scope) ? this.operation.job : this.read(scope);
        if (job?.phase === 'installing') {
            const installation = this.installations.status(scope);
            if (!installation || installation.id !== job.installationId) {
                job = { ...job, phase: 'interrupted', error: 'The installation record changed. Check components and explicitly retry.' };
            } else if (TERMINAL.has(installation.phase)) {
                job = { ...job, phase: installation.phase, error: installation.error };
            }
            if (job.phase !== 'installing') this.write(job);
        } else if (job && ACTIVE.has(job.phase) && this.operation?.job.id !== job.id) {
            job = { ...job, phase: job.cancelRequested ? 'canceled' : 'interrupted',
                error: 'The prerequisite download was interrupted. Verified packages were kept. Check components and retry.' };
            this.write(job);
        }
        return { available: this.enabled && !this.disposed, job: job ? this.public(job) : null };
    }
    check(scope, runtimeId = '') { return { ...this.status(scope), components: packages.probe(this.manager, scope, runtimeId) }; }
    public(job) {
        return { id: job.id, phase: job.phase, recipeIds: job.recipeIds, currentId: job.currentId || '',
            received: job.received, total: job.total, cancelRequested: job.cancelRequested, installationId: job.installationId || '',
            error: job.error || '', label: job.currentId ? packages.recipe(job.currentId).label : '',
            detail: job.error || (job.phase === 'completed' ? 'Installer steps finished. Check components and test the game.'
                : job.phase === 'installing' ? 'Using this game’s Windows installation queue. No installation time counts as playtime.'
                : 'Downloads pinned packages from Microsoft for this game’s separate Windows environment.') };
    }
    cleanStaging() {
        if (!fs.existsSync(this.staging)) return;
        privateDirectory(this.staging); const entries = fs.readdirSync(this.staging);
        if (entries.length > 128) throw Error('Too many interrupted prerequisite downloads.');
        for (const name of entries) {
            if (!native.UUID.test(name)) throw Error('Invalid prerequisite staging folder.');
            const directory = path.join(this.staging, name); privateDirectory(directory);
            // Leave a crashed extractor time to observe EOF or its deadline.
            if (Date.now() - fs.statSync(directory).mtimeMs > 10 * 60 * 1000) fs.rmSync(directory, { recursive: true });
        }
    }
    async acquire(item, operation) {
        privateDirectory(this.manager.root, true); privateDirectory(this.root, true);
        privateDirectory(this.cache, true); privateDirectory(this.staging, true);
        const destination = path.join(this.cache, item.id + '-' + item.sha256);
        if (fs.existsSync(destination)) {
            try { return packages.verifyPayload(destination, item); }
            catch (_) {
                // Keep an invalid cache for inspection and fetch a fresh copy.
                privateDirectory(destination);
                fs.renameSync(destination, path.join(this.staging, crypto.randomUUID()));
            }
        }
        const stage = path.join(this.staging, crypto.randomUUID()); privateDirectory(stage, true);
        const free = fs.statfsSync(stage), expanded = item.payload.reduce((sum, file) => sum + file.size, 0);
        if (free.bavail * free.bsize < item.size + expanded + 128 * 1024 ** 2) throw Error('Not enough space to download and prepare this prerequisite.');
        const archive = path.join(stage, item.filename), job = operation.job;
        job.phase = 'downloading'; job.currentId = item.id; job.received = 0; job.total = item.size; this.write(job);
        await this.transport.download(item, archive, { signal: operation.controller.signal, progress: (received, total) => {
            job.received = received; job.total = total; this.write(job, true);
        } });
        await operation.work.checkpoint();
        // Validate the exact shipping pin independently of the transport.
        if (packages.hashFile(archive, item.size) !== item.sha256) throw Error('The prerequisite download failed checksum verification.');
        const payload = path.join(stage, 'payload');
        if (item.kind === 'directx') {
            job.phase = 'extracting'; this.write(job);
            await require('../linuxGameDiscovery').extractMicrosoftRedist(archive, payload, operation.work);
        } else { privateDirectory(payload, true); fs.renameSync(archive, path.join(payload, item.filename)); }
        await operation.work.checkpoint(); packages.verifyPayload(payload, item);
        if (fs.existsSync(destination)) throw Error('The prerequisite cache changed while downloading. Retry explicitly.');
        fs.renameSync(payload, destination);
        const fd = fs.openSync(this.cache, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.rmSync(stage, { recursive: true });
        return packages.verifyPayload(destination, item);
    }
    start({ scope, gameName, resolve, recipeIds }) {
        this.assertCanStart(scope);
        if (!Array.isArray(recipeIds) || !recipeIds.length || recipeIds.length > packages.MAX_RECIPES || new Set(recipeIds).size !== recipeIds.length) throw Error('Choose a bounded set of supported prerequisites.');
        const selected = recipeIds.map(packages.recipe), details = resolve(); this.manager.runtime(details.linuxRuntime?.runtimeId);
        this.manager.assertLaunchReady(details.linuxRuntime?.backend);
        // Refuse a known newer installed VC runtime rather than downgrading it.
        const detected = packages.probe(this.manager, scope, details.linuxRuntime.runtimeId);
        if (selected.some(item => detected.find(value => value.id === item.id)?.detection === 'unknown')) throw Error('The selected component could not be checked. Close the game and repair its Windows environment before retrying.');
        const missing = selected.filter(item => detected.find(value => value.id === item.id)?.detection !== 'detected');
        if (!missing.length) throw Error('These components are already detected. No installation is needed.');
        this.cleanStaging();
        const job = { protocol: 1, id: crypto.randomUUID(), runtimeId: details.linuxRuntime.runtimeId, backend: details.linuxRuntime.backend, scope: { ...scope },
            recipeIds: missing.map(item => item.id), phase: 'checking', createdAt: Date.now(), received: 0, total: 0, cancelRequested: false, error: '' };
        this.write(job);
        const operation = { job, controller: new AbortController(), stop: null };
        operation.work = {
            checkpoint: async () => { operation.controller.signal.throwIfAborted(); if (this.disposed) throw Error('Prerequisite monitoring stopped.');
                const current = resolve();
                if (current.linuxRuntime?.runtimeId !== job.runtimeId || current.linuxRuntime?.backend !== job.backend) throw Error('The component runtime changed. Review setup again.'); },
            setStop: async stop => { operation.stop = stop; if (stop && operation.controller.signal.aborted) stop(); }
        };
        this.operation = operation;
        operation.done = this.run(operation, { scope, gameName, resolve, missing }).finally(() => { if (this.operation === operation) this.operation = null; });
        operation.done.catch(() => {});
        return this.public(job);
    }
    async run(operation, { scope, gameName, resolve, missing }) {
        const job = operation.job, timer = setTimeout(() => { operation.timedOut = true; operation.controller.abort(); operation.stop?.(); }, 20 * 60 * 1000);
        try {
            await this.manager.downloads.requirements.assertInstallable(operation.job.backend || 'proton-umu', { archive: operation.job.recipeIds.includes('directx-june2010') }); await operation.work.checkpoint();
            const steps = [];
            for (const item of missing) {
                const file = await this.acquire(item, operation); await operation.work.checkpoint();
                steps.push({ ...installer(file, { ...officialRecipe(item), fixtureRoot: this.manager.fixtureRoot }), officialRecipeId: item.id });
            }
            job.phase = 'queuing'; this.write(job); await operation.work.checkpoint();
            const installation = this.installations.start({ scope, gameName, resolve, steps, acquisitionId: job.id });
            job.installationId = installation.id; job.phase = 'installing'; this.write(job);
        } catch (error) {
            job.phase = job.cancelRequested ? 'canceled' : this.disposed ? 'interrupted' : 'failed';
            job.error = operation.timedOut ? 'Prerequisite download timed out. Verified packages were kept; retry explicitly.' : safeError(error);
            try { this.write(job); } catch (_) { /* Keep the in-memory failure; never start an installer after a write failure. */ }
        } finally { clearTimeout(timer); }
    }
    cancel(scope, id) {
        const operation = this.operation;
        if (!operation || operation.job.id !== id || scopeKey(operation.job.scope) !== scopeKey(scope) || !ACTIVE.has(operation.job.phase)) throw Error('This prerequisite download is no longer active. Use Cancel installation after it enters the installation queue.');
        operation.job.cancelRequested = true; this.write(operation.job);
        operation.controller.abort(); operation.stop?.(); return this.public(operation.job);
    }
    dispose() { this.disposed = true; this.operation?.controller.abort(); this.operation?.stop?.(); }
}
module.exports = { PrerequisiteDownloads };
