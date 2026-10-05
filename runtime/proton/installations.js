'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { scopeKey, privateDirectory, privateRead, save } = require('./manager');
const { UUID } = require('../native/protocol');
const { validateStep } = require('./prerequisites');
const ACTIVE = new Set(['checking', 'starting', 'running', 'waiting', 'tracking-lost']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeError = error => String(error.message || error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);

class WindowsInstallations {
    constructor({ manager, provider, snapshot }) {
        this.manager = manager; this.provider = provider; this.snapshot = snapshot;
        this.root = path.join(manager.root, 'installations'); this.operations = new Map(); this.disposed = false;
    }
    read(scope) {
        const key = scopeKey(scope), file = path.join(this.root, key + '.json');
        if (!fs.existsSync(this.root)) return null;
        privateDirectory(this.manager.root); privateDirectory(this.root);
        if (!fs.existsSync(file)) return null;
        const job = JSON.parse(privateRead(file, 256 * 1024));
        if (job.protocol !== 1 || !UUID.test(job.id) || !UUID.test(job.runtimeId) || scopeKey(job.scope) !== key
            || !['checking', 'starting', 'running', 'waiting', 'tracking-lost', 'completed', 'failed', 'canceled', 'interrupted'].includes(job.phase)
            || !Array.isArray(job.steps) || !job.steps.length || job.steps.length > 16 || !Array.isArray(job.results) || job.results.length > 16
            || !Number.isSafeInteger(job.index) || job.index < 0 || job.index >= job.steps.length
            || !Number.isSafeInteger(job.createdAt) || typeof job.cancelRequested !== 'boolean') throw Error('The local installation record needs repair. Existing game files were kept.');
        if (job.backend !== undefined && !require('./wine').windowsBackend(job.backend)) throw Error('Invalid installation backend. Existing game files were kept.');
        return job;
    }
    write(job) {
        privateDirectory(this.manager.root, true); privateDirectory(this.root, true);
        if (fs.readdirSync(this.root).length >= 256 && !fs.existsSync(path.join(this.root, scopeKey(job.scope) + '.json'))) throw Error('Too many Windows installation records.');
        job.updatedAt = Date.now(); save(path.join(this.root, scopeKey(job.scope) + '.json'), JSON.stringify(job) + '\n');
    }
    activeSession(job) {
        return Object.values(this.snapshot().activeSessions || {}).find(item => item.gameId === job.scope.gameId
            && item.libraryKey === `${job.scope.profileId}:${job.scope.libraryId}`
            && item.native?.launchMetadata?.activity === 'installation'
            && item.native.launchMetadata.installationId === job.id && item.native.launchMetadata.runtimeId === job.runtimeId
            && item.native.launchMetadata.prefixKey === scopeKey(job.scope));
    }
    assertIdle(scope, acquisitionId = null) {
        this.manager.prerequisites?.assertIdle(scope, acquisitionId);
        if (this.operations.has(scopeKey(scope))) throw Error('This game already has an installation in progress.');
        const state = this.snapshot();
        if ([...Object.values(state.activeSessions || {}), ...(state.completedSessions || [])].some(item => item.gameId === scope.gameId
            && item.libraryKey === `${scope.profileId}:${scope.libraryId}`)) throw Error('Stop the game and finish saving its current session before installing.');
    }
    pendingBindings() {
        return [...(this.manager.prerequisites?.pendingBindings() || []), ...[...this.operations.values()].map(item => ({ provider: 'linux-native', gameId: item.job.scope.gameId,
            libraryKey: `${item.job.scope.profileId}:${item.job.scope.libraryId}` }))];
    }
    status(scope) {
        let job = this.read(scope); if (!job) return null;
        const active = this.activeSession(job);
        if (active) return this.public({ ...job, sessionId: active.sessionId, phase: active.native.phase === 'tracking-lost' ? 'tracking-lost' : 'running' });
        if (!this.operations.has(scopeKey(scope)) && ACTIVE.has(job.phase)) {
            // A reopened observer never automatically resumes a queue using an
            // old execution permission. Native recovery still owns a live step.
            job = { ...job, phase: job.cancelRequested ? 'canceled'
                : job.results.length === job.steps.length && job.results.every(item => item.outcome === 'installation-finished') ? 'completed' : 'interrupted',
                error: 'Installation was interrupted. Existing files were kept. Run the installer or prerequisites again to retry.' };
            if (job.phase !== 'interrupted') job.error = '';
            this.write(job);
        }
        return this.public(job);
    }
    public(job) {
        return { id: job.id, phase: job.phase, index: job.index, total: job.steps.length,
            label: job.steps[job.index].label, sessionId: job.sessionId || '', cancelRequested: job.cancelRequested,
            completedSteps: job.results.length, error: job.error || '',
            detail: job.phase === 'completed' ? 'Installer steps finished. Test the game; setup exit does not confirm that every dependency works.'
                : job.phase === 'interrupted' || job.phase === 'failed' ? job.error
                : job.cancelRequested || job.phase === 'canceled' ? 'Installation stopped. Partially installed files were kept.'
                : `Step ${job.index + 1} of ${job.steps.length}: ${job.steps[job.index].label}` };
    }
    accept(event) {
        if (event.activity !== 'installation' || !UUID.test(event.installationId)) return;
        // Library IDs are opaque; find the exact scope from active operations
        // or retained records rather than guessing how to split its key.
        const live = [...this.operations.values()].find(item => item.job.id === event.installationId);
        let job = live?.job;
        if (!job && fs.existsSync(this.root)) {
            privateDirectory(this.root); const files = fs.readdirSync(this.root);
            if (files.length > 256) throw Error('Too many Windows installation records.');
            for (const name of files) {
                if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
                const value = JSON.parse(privateRead(path.join(this.root, name), 256 * 1024));
                if (value.id === event.installationId) { job = this.read(value.scope); break; }
            }
        }
        if (!job || event.gameId !== job.scope.gameId || event.libraryKey !== `${job.scope.profileId}:${job.scope.libraryId}`
            || !Number.isSafeInteger(event.installationStep) || event.installationStep !== job.index
            || event.creditPlaytime !== false || event.durationSeconds !== 0) return;
        if (!job.results.some(item => item.index === event.installationStep)) {
            job.results.push({ index: event.installationStep, sessionId: event.sessionId, outcome: event.outcome, endedAt: event.endedAt });
            job.sessionId = event.sessionId; job.phase = 'waiting'; this.write(job);
        }
    }
    start({ scope, gameName, resolve, steps, acquisitionId = null }) {
        if (this.disposed) throw Error('Installation monitoring has stopped.');
        this.assertIdle(scope, acquisitionId);
        if (!Array.isArray(steps) || !steps.length || steps.length > 16) throw Error('Choose between one and sixteen installation steps.');
        for (const step of steps) validateStep(step, this.manager);
        const details = resolve(); this.manager.runtime(details.linuxRuntime?.runtimeId);
        this.manager.assertLaunchReady(details.linuxRuntime?.backend);
        const job = { protocol: 1, id: crypto.randomUUID(), scope: { ...scope }, runtimeId: details.linuxRuntime.runtimeId,
            backend: details.linuxRuntime.backend, createdAt: Date.now(), phase: 'checking', index: 0, steps, results: [], sessionId: '', cancelRequested: false, error: '' };
        this.write(job);
        const operation = { job, done: null }; this.operations.set(scopeKey(scope), operation);
        operation.done = this.run({ operation, scope, gameName, resolve }).finally(() => this.operations.delete(scopeKey(scope)));
        // The durable record carries expected failures; avoid an unhandled
        // promise if recording the failure itself is prevented by a full disk.
        operation.done.catch(() => {});
        return this.public(job);
    }
    async run({ operation, scope, gameName, resolve }) {
        const job = operation.job;
        try {
            await this.manager.downloads.requirements.assertInstallable(job.backend || 'proton-umu');
            for (let index = 0; index < job.steps.length; index++) {
                if (this.disposed || job.cancelRequested) break;
                resolve(); job.index = index; job.phase = 'starting'; job.sessionId = ''; this.write(job);
                const result = await this.provider.install({ scope, gameName, resolve: () => {
                    if (this.disposed || job.cancelRequested) throw Error('Installation was canceled before execution.');
                    const current = resolve();
                    if (current.linuxRuntime?.runtimeId !== job.runtimeId || current.linuxRuntime?.backend !== (job.backend || 'proton-umu')) throw Error('The installation runtime changed. Review setup again.');
                    return current;
                }, step: job.steps[index], installationId: job.id, installationStep: index });
                job.sessionId = result.sessionId;
                if (!job.results.some(item => item.index === index)) { job.phase = 'running'; this.write(job); }
                if (result.event) this.accept(result.event);
                while (!job.results.some(item => item.index === index)) {
                    if (this.disposed) return;
                    const active = this.activeSession(job);
                    if (!active) {
                        const event = (this.snapshot().completedSessions || []).find(item => item.installationId === job.id && item.installationStep === index);
                        if (event) this.accept(event);
                        else throw Error('Installation tracking is unresolved. Existing files were kept; reopen its settings before retrying.');
                    }
                    await delay(250);
                }
                const receipt = job.results.find(item => item.index === index);
                if (job.cancelRequested || receipt.outcome === 'installation-stopped') { job.cancelRequested = true; break; }
                if (receipt.outcome !== 'installation-finished') throw Error('The installer did not finish successfully. View its launch log and retry.');
                // The existing durable completion path must acknowledge this
                // zero-credit event before starting another step in the prefix.
                while ((this.snapshot().completedSessions || []).some(item => item.sessionId === job.sessionId)) {
                    if (this.disposed) return;
                    if (job.cancelRequested) break;
                    await delay(250);
                }
            }
            job.phase = job.cancelRequested ? 'canceled' : 'completed'; this.write(job);
        } catch (error) { job.phase = job.cancelRequested ? 'canceled' : 'failed'; job.error = safeError(error); this.write(job); }
    }
    async cancel({ scope, jobId, authorize }) {
        const live = this.operations.get(scopeKey(scope)), job = live?.job || this.read(scope);
        if (!job || job.id !== jobId || !ACTIVE.has(job.phase)) throw Error('This installation is no longer active.');
        const session = this.activeSession(job);
        if (session) await this.provider.native.stop({ sessionId: session.sessionId, gameId: scope.gameId,
            libraryKey: `${scope.profileId}:${scope.libraryId}`, authorize: current => {
                const permission = authorize(current);
                job.cancelRequested = true; this.write(job);
                return permission;
            } });
        else { job.cancelRequested = true; if (!live) job.phase = 'canceled'; this.write(job); }
        return this.public(job);
    }
    dispose() { this.disposed = true; }
}
module.exports = { WindowsInstallations };
