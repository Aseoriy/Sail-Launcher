'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { QUARANTINE_DIRECTORY_NAME } = require('./downloadQuarantine');

// Installer payloads can contain extremely deep asset paths and legacy unpackers still
// enforce MAX_PATH. Keep new staging names compact while retaining strong local opacity.
const STAGING_DIRECTORY_NAME = '.s';
const JOB_DIRECTORY_BYTES = 10;
const JOB_STATES = Object.freeze({
    CREATED: 'created',
    WAITING_BROWSER: 'waiting_browser',
    PREPARING: 'preparing',
    DOWNLOADING: 'downloading',
    PAUSED: 'paused',
    POST_PROCESSING: 'post_processing',
    READY_TO_INSTALL: 'ready_to_install',
    LAUNCHING_INSTALLER: 'launching_installer',
    INSTALLER_RUNNING: 'installer_running',
    RETRYABLE_ERROR: 'retryable_error',
    PUBLISHING: 'publishing',
    CANCEL_REQUESTED: 'cancel_requested',
    CANCELLATION_PENDING: 'cancellation_pending',
    CANCELLATION_REFUSED_INSTALLER_RUNNING: 'cancellation_refused_installer_running',
    CANCELLED_CLEAN: 'cancelled_clean',
    CANCELLED_QUARANTINED: 'cancelled_quarantined',
    CANCELLATION_REFUSED: 'cancellation_refused',
    COMPLETED: 'completed',
    FAILED_TERMINAL: 'failed_terminal'
});
const NONTERMINAL_STATES = new Set([
    JOB_STATES.CREATED, JOB_STATES.WAITING_BROWSER, JOB_STATES.PREPARING,
    JOB_STATES.DOWNLOADING, JOB_STATES.PAUSED, JOB_STATES.POST_PROCESSING,
    JOB_STATES.READY_TO_INSTALL, JOB_STATES.LAUNCHING_INSTALLER,
    JOB_STATES.INSTALLER_RUNNING, JOB_STATES.RETRYABLE_ERROR, JOB_STATES.PUBLISHING
]);
const CANCELLATION_STATES = new Set([
    JOB_STATES.CANCEL_REQUESTED,
    JOB_STATES.CANCELLATION_PENDING,
    JOB_STATES.CANCELLATION_REFUSED_INSTALLER_RUNNING
]);
const CANCELLABLE_STATES = new Set([...NONTERMINAL_STATES, ...CANCELLATION_STATES]);
const TERMINAL_STATES = new Set([
    JOB_STATES.CANCELLED_CLEAN, JOB_STATES.CANCELLED_QUARANTINED,
    JOB_STATES.CANCELLATION_REFUSED, JOB_STATES.COMPLETED, JOB_STATES.FAILED_TERMINAL
]);
const STATE_ALIASES = Object.freeze({
    'waiting-browser': JOB_STATES.WAITING_BROWSER,
    resolving: JOB_STATES.PREPARING,
    processing: JOB_STATES.POST_PROCESSING,
    installing: JOB_STATES.READY_TO_INSTALL,
    published: JOB_STATES.COMPLETED,
    complete: JOB_STATES.COMPLETED,
    error: JOB_STATES.RETRYABLE_ERROR,
    cancelled: JOB_STATES.CANCEL_REQUESTED,
    'cancelled-clean': JOB_STATES.CANCELLED_CLEAN,
    'cancelled-quarantined': JOB_STATES.CANCELLED_QUARANTINED,
    'cleanup-refused': JOB_STATES.CANCELLATION_REFUSED
});

function canonicalState(value) {
    const state = text(value);
    return STATE_ALIASES[state] || state;
}

function text(value) {
    return String(value === undefined || value === null ? '' : value);
}

function jobKey(value) {
    const key = text(value).trim();
    if (!key || key.length > 240) throw new Error('A valid download job ID is required.');
    return key;
}

function normalizedInstallDir(value) {
    return text(value).trim();
}

function realpath(fsImpl, target) {
    const resolver = fsImpl.realpathSync.native || fsImpl.realpathSync;
    return resolver(path.resolve(target));
}

function sameCanonicalPath(first, second) {
    const normalize = value => {
        const normalized = path.normalize(String(value)).replace(/[\\/]+$/, '');
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    };
    return normalize(first) === normalize(second);
}

function isStrictChildPath(root, target) {
    const relative = path.relative(root, target);
    return !!relative
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function sanitizeDownloadDirectoryName(name) {
    let sanitized = text(name)
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '')
        .slice(0, 80)
        .replace(/[. ]+$/g, '');
    if (!sanitized || /^\.+$/.test(sanitized)) {
        throw new Error('The download name cannot resolve to an empty or dot directory.');
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized)) sanitized = `_${sanitized}`;
    return sanitized;
}

function directoryStats(fsImpl, target) {
    const stats = fsImpl.lstatSync(target, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
    return stats;
}

function directoryIdentity(fsImpl, target) {
    const stats = directoryStats(fsImpl, target);
    if (!stats) return null;
    return Object.freeze({
        dev: String(stats.dev),
        ino: String(stats.ino),
        birthtimeNs: String(stats.birthtimeNs === undefined ? BigInt(Math.trunc(Number(stats.birthtimeMs) * 1000000)) : stats.birthtimeNs)
    });
}

function sameDirectoryIdentity(first, second) {
    return !!first && !!second
        && first.dev === second.dev
        && first.ino === second.ino
        && first.birthtimeNs === second.birthtimeNs;
}

function resolveSafeDirectory(root, directory, fsImpl = fs) {
    try {
        const recordedRoot = path.resolve(root);
        const recordedDirectory = path.resolve(directory);
        if (!directoryStats(fsImpl, recordedRoot) || !directoryStats(fsImpl, recordedDirectory)) return null;
        const canonicalRoot = realpath(fsImpl, recordedRoot);
        const canonicalDirectory = realpath(fsImpl, recordedDirectory);
        if (!sameCanonicalPath(recordedRoot, canonicalRoot)
            || !sameCanonicalPath(recordedDirectory, canonicalDirectory)
            || !isStrictChildPath(canonicalRoot, canonicalDirectory)) return null;
        return canonicalDirectory;
    } catch (_) {
        return null;
    }
}

function resolveSafeDeletionTarget(root, directory, fsImpl = fs) {
    return resolveSafeDirectory(root, directory, fsImpl);
}

function remapOwnedPath(value, fromDirectory, toDirectory) {
    if (typeof value !== 'string' || !value) return value;
    const resolved = path.resolve(value);
    const relative = path.relative(fromDirectory, resolved);
    if (relative === '') return toDirectory;
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return value;
    return path.join(toDirectory, relative);
}

function retryableCleanupError(error) {
    return !!error && ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code);
}

class DownloadJobDirectoryRegistry {
    constructor(options = {}) {
        this.fs = options.fs || fs;
        this.randomBytes = options.randomBytes || crypto.randomBytes;
        this.hooks = options.hooks || {};
        this.quarantineCatalog = options.quarantineCatalog || null;
        this.jobs = new Map();
    }

    opaqueName(prefix) {
        return `${prefix}-${this.randomBytes(24).toString('hex')}`;
    }

    jobDirectoryName() {
        const random = Buffer.from(this.randomBytes(JOB_DIRECTORY_BYTES));
        if (random.length < JOB_DIRECTORY_BYTES) throw new Error('The staging identity source returned too few bytes.');
        return random.subarray(0, JOB_DIRECTORY_BYTES).toString('hex');
    }

    begin(id, input = {}) {
        const key = jobKey(id);
        const gameName = text(input.gameName);
        const installDir = normalizedInstallDir(input.installDir);
        const existing = this.jobs.get(key);
        if (existing) {
            if (existing.gameName !== gameName || existing.installDir !== installDir || existing.cancelled || TERMINAL_STATES.has(existing.state)) {
                throw new Error('Download job metadata does not match the recorded job.');
            }
            return existing;
        }

        const finalName = sanitizeDownloadDirectoryName(gameName);
        const requestedRoot = installDir || normalizedInstallDir(input.defaultRoot);
        if (!requestedRoot) throw new Error('A download root is required.');
        this.fs.mkdirSync(requestedRoot, { recursive: true });
        const root = realpath(this.fs, requestedRoot);
        if (!directoryStats(this.fs, root)) throw new Error('The download root is not a usable directory.');

        const stagingRequested = path.join(root, STAGING_DIRECTORY_NAME);
        this.fs.mkdirSync(stagingRequested, { recursive: true, mode: 0o700 });
        const stagingRoot = realpath(this.fs, stagingRequested);
        if (!directoryStats(this.fs, stagingRoot)
            || !sameCanonicalPath(stagingRequested, stagingRoot)
            || !isStrictChildPath(root, stagingRoot)) {
            throw new Error('The staging root is not a safe child of the selected download root.');
        }

        const quarantineRequested = path.join(stagingRoot, QUARANTINE_DIRECTORY_NAME);
        this.fs.mkdirSync(quarantineRequested, { recursive: true, mode: 0o700 });
        const quarantineRoot = realpath(this.fs, quarantineRequested);
        if (!directoryStats(this.fs, quarantineRoot)
            || !sameCanonicalPath(quarantineRequested, quarantineRoot)
            || !isStrictChildPath(stagingRoot, quarantineRoot)) {
            throw new Error('The quarantine root is not a safe child of the Sail staging root.');
        }
        if (this.quarantineCatalog) this.quarantineCatalog.recordRoot(quarantineRoot);

        const finalDirectory = path.join(root, finalName);
        if (!isStrictChildPath(root, finalDirectory)) throw new Error('The final download directory must be a strict child of its root.');
        if (this.fs.existsSync(finalDirectory)) throw new Error('The selected game directory already exists and will not be adopted.');

        const directory = path.join(stagingRoot, this.jobDirectoryName());
        if (!isStrictChildPath(stagingRoot, directory)) throw new Error('The staging directory is invalid.');
        const job = {
            id: key,
            generation: this.randomBytes(16).toString('hex'),
            gameName,
            installDir,
            root,
            stagingRoot,
            quarantineRoot,
            directory,
            finalDirectory,
            directoryIdentity: null,
            quarantinePath: '',
            createdDirectory: false,
            cleanupComplete: false,
            cleanupFinalized: false,
            cleanupScheduled: false,
            cleanupAttempts: 0,
            cleanupError: '',
            cancellationOutcome: null,
            state: JOB_STATES.CREATED,
            cancelled: false,
            control: null,
            activeOperation: null,
            attemptGeneration: 0,
            cancellationGeneration: 0,
            operationTail: Promise.resolve()
        };
        this.jobs.set(key, job);
        return job;
    }

    continuation(job) {
        this.assertRecorded(job);
        return Object.freeze({
            id: job.id,
            generation: job.generation,
            cancellationGeneration: job.cancellationGeneration,
            attemptGeneration: job.attemptGeneration,
            job
        });
    }

    async beginAttempt(job) {
        return this.runExclusive(job, () => {
            const recorded = this.assertContinuation(job);
            if (recorded.activeOperation) throw new Error('The previous download attempt is still quiescing.');
            recorded.attemptGeneration += 1;
            return this.continuation(recorded);
        });
    }

    async runExclusive(job, operation) {
        if (!job || typeof operation !== 'function') throw new Error('Unknown download job.');
        const run = job.operationTail.then(async () => {
            this.assertRecorded(job);
            return operation();
        });
        job.operationTail = run.catch(() => {});
        return run;
    }

    async invokeHook(name, job) {
        const hook = this.hooks[name];
        if (typeof hook === 'function') await hook(job);
    }

    assertRecorded(job) {
        if (!job || this.jobs.get(job.id) !== job || typeof job.generation !== 'string') {
            throw new Error('Unknown or stale download job.');
        }
    }

    assertContinuation(continuation, options = {}) {
        const job = continuation && continuation.job ? continuation.job : continuation;
        this.assertRecorded(job);
        if (continuation && continuation.job
            && (continuation.id !== job.id || continuation.generation !== job.generation)) {
            throw new Error('The download continuation is stale.');
        }
        if (!options.allowTerminal && continuation && continuation.job
            && continuation.cancellationGeneration !== undefined
            && continuation.cancellationGeneration !== job.cancellationGeneration) {
            throw new Error('The download continuation was invalidated by cancellation.');
        }
        if (!options.allowTerminal && continuation && continuation.job
            && continuation.attemptGeneration !== undefined
            && continuation.attemptGeneration !== job.attemptGeneration) {
            throw new Error('The download continuation belongs to an older attempt.');
        }
        if (!options.allowTerminal && (job.cancelled || TERMINAL_STATES.has(job.state) || job.cleanupFinalized)) {
            throw new Error('The download job is terminal.');
        }
        return job;
    }

    async assertActive(continuation) {
        const job = continuation && continuation.job ? continuation.job : continuation;
        return this.runExclusive(job, () => this.assertContinuation(continuation));
    }

    async ensureDirectory(continuation) {
        const candidate = continuation && continuation.job ? continuation.job : continuation;
        return this.runExclusive(candidate, async () => {
            await this.invokeHook('beforeTerminalCheck', candidate);
            const job = this.assertContinuation(continuation);
            if (job.createdDirectory) {
                const safe = resolveSafeDirectory(job.stagingRoot, job.directory, this.fs);
                const identity = safe && directoryIdentity(this.fs, safe);
                if (!safe || !sameDirectoryIdentity(identity, job.directoryIdentity)) {
                    throw new Error('The owned staging directory identity changed.');
                }
                return safe;
            }

            await this.invokeHook('afterTerminalCheckBeforeCreate', job);
            this.assertContinuation(continuation);
            this.fs.mkdirSync(job.directory, { mode: 0o700 });
            const safe = resolveSafeDirectory(job.stagingRoot, job.directory, this.fs);
            const identity = safe && directoryIdentity(this.fs, safe);
            if (!safe || !identity) {
                job.state = JOB_STATES.FAILED_TERMINAL;
                throw new Error('The exclusively created staging directory is not safe.');
            }
            job.directory = safe;
            job.directoryIdentity = identity;
            job.createdDirectory = true;
            await this.invokeHook('afterDirectoryCreate', job);
            this.assertContinuation(continuation);
            return safe;
        });
    }

    async attachControl(continuation, control, state) {
        const candidate = continuation && continuation.job ? continuation.job : continuation;
        return this.runExclusive(candidate, () => {
            const job = this.assertContinuation(continuation);
            job.control = control || null;
            if (state) this.transitionLocked(job, state);
            return job;
        });
    }

    transitionLocked(job, state) {
        const next = canonicalState(state);
        if (!NONTERMINAL_STATES.has(next)) throw new Error('The download job state is invalid.');
        if (job.cancelled || TERMINAL_STATES.has(job.state) || job.cleanupFinalized) {
            throw new Error('The download job is already terminal.');
        }
        job.state = next;
    }

    async setState(continuation, state) {
        const candidate = continuation && continuation.job ? continuation.job : continuation;
        return this.runExclusive(candidate, () => {
            const job = this.assertContinuation(continuation);
            this.transitionLocked(job, state);
            return job;
        });
    }

    async beginOperation(continuation, options = {}) {
        const candidate = continuation && continuation.job ? continuation.job : continuation;
        return this.runExclusive(candidate, () => {
            const job = this.assertContinuation(continuation);
            if (job.activeOperation) throw new Error('The download job already has active owned work.');
            const state = canonicalState(options.state);
            if (state) this.transitionLocked(job, state);
            let settleOperation;
            const settledPromise = new Promise(resolve => { settleOperation = resolve; });
            const operation = {
                token: this.randomBytes(16).toString('hex'),
                id: job.id,
                job,
                generation: job.generation,
                cancellationGeneration: job.cancellationGeneration,
                attemptGeneration: job.attemptGeneration,
                type: text(options.type) || 'owned-work',
                stop: typeof options.stop === 'function' ? options.stop : null,
                externalInstaller: false,
                settled: false,
                settledPromise,
                settleOperation
            };
            job.activeOperation = operation;
            return operation;
        });
    }

    async setOperationStop(operation, stop) {
        if (!operation || !operation.job) throw new Error('Unknown owned operation.');
        return this.runExclusive(operation.job, () => {
            const job = this.assertContinuation(operation, { allowTerminal: true });
            if (job.activeOperation !== operation || operation.settled) throw new Error('The owned operation is stale.');
            operation.stop = typeof stop === 'function' ? stop : null;
            return operation;
        });
    }

    async markInstallerRunning(operation) {
        if (!operation || !operation.job) throw new Error('Unknown installer operation.');
        return this.runExclusive(operation.job, () => {
            const job = this.assertContinuation(operation);
            if (job.activeOperation !== operation || operation.settled) throw new Error('The installer operation is stale.');
            operation.externalInstaller = true;
            this.transitionLocked(job, JOB_STATES.INSTALLER_RUNNING);
            return operation;
        });
    }

    async markInstallerExited(operation) {
        if (!operation || !operation.job) throw new Error('Unknown installer operation.');
        return this.runExclusive(operation.job, () => {
            const job = this.assertContinuation(operation, { allowTerminal: true });
            if (job.activeOperation !== operation || operation.settled) throw new Error('The installer operation is stale.');
            operation.externalInstaller = false;
            if (!job.cancelled) this.transitionLocked(job, JOB_STATES.READY_TO_INSTALL);
            else {
                job.state = JOB_STATES.CANCELLATION_PENDING;
                this.recordCancellationOutcomeLocked(job, {
                    status: 'cancellation_pending',
                    retryable: true,
                    reason: 'installer-exited-awaiting-quarantine',
                    retained: !!job.createdDirectory
                });
            }
            return operation;
        });
    }

    async endOperation(operation) {
        if (!operation || !operation.job) return null;
        return this.runExclusive(operation.job, () => {
            const job = this.assertContinuation(operation, { allowTerminal: true });
            if (job.activeOperation !== operation || operation.settled) return job;
            operation.settled = true;
            job.activeOperation = null;
            if (job.cancelled && CANCELLATION_STATES.has(job.state)) job.state = JOB_STATES.CANCEL_REQUESTED;
            operation.settleOperation();
            return job;
        });
    }

    waitForOperation(operation) {
        return operation && operation.settledPromise ? operation.settledPromise : Promise.resolve();
    }

    recordCancellationOutcomeLocked(job, result) {
        const status = text(result && result.status).trim();
        if (!status) throw new Error('A cancellation outcome is required.');
        const outcome = {
            status,
            retryable: !!(result && result.retryable),
            retained: result && typeof result.retained === 'boolean' ? result.retained : null
        };
        const reason = text(result && result.reason).trim();
        if (reason) outcome.reason = reason;
        job.cancellationOutcome = Object.freeze(outcome);
        return { ...outcome };
    }

    cancellationOutcome(job) {
        this.assertRecorded(job);
        return job.cancellationOutcome ? { ...job.cancellationOutcome } : null;
    }

    async requestCancel(id, info) {
        let key;
        try { key = jobKey(id); } catch (_) { return null; }
        const candidate = this.jobs.get(key);
        if (!candidate || !this.matchesMetadata(candidate, info)) return null;
        return this.runExclusive(candidate, async () => {
            const job = this.jobs.get(key);
            if (job !== candidate || !this.matchesMetadata(job, info)) return null;
            if (job.cancelled && (CANCELLATION_STATES.has(job.state) || TERMINAL_STATES.has(job.state))) {
                return { job, repeated: true, outcome: this.cancellationOutcome(job) };
            }
            if (!CANCELLABLE_STATES.has(job.state) || TERMINAL_STATES.has(job.state)) return null;
            await this.invokeHook('beforeCancelTransition', job);
            job.cancelled = true;
            job.cancellationGeneration += 1;
            const operation = job.activeOperation;
            if (operation && operation.externalInstaller) {
                job.state = JOB_STATES.CANCELLATION_REFUSED_INSTALLER_RUNNING;
                const outcome = this.recordCancellationOutcomeLocked(job, {
                    status: 'cancellation_refused_installer_running',
                    retryable: true,
                    reason: 'installer-running',
                    retained: true
                });
                return { job, repeated: false, pending: true, installerRunning: true, stop: null, outcome };
            }
            if (operation) {
                job.state = JOB_STATES.CANCELLATION_PENDING;
                const outcome = this.recordCancellationOutcomeLocked(job, {
                    status: 'cancellation_pending',
                    retryable: true,
                    reason: 'owned-work-active',
                    retained: !!job.createdDirectory
                });
                return { job, repeated: false, pending: true, installerRunning: false, stop: operation.stop, outcome };
            }
            job.state = JOB_STATES.CANCEL_REQUESTED;
            const outcome = this.recordCancellationOutcomeLocked(job, {
                status: 'cancellation_pending',
                retryable: true,
                reason: 'cleanup-in-progress',
                retained: !!job.createdDirectory
            });
            return { job, repeated: false, pending: false, installerRunning: false, stop: null, outcome };
        });
    }

    async cleanup(continuation) {
        const candidate = continuation && continuation.job ? continuation.job : continuation;
        return this.runExclusive(candidate, async () => {
            let job;
            try { job = this.assertContinuation(continuation, { allowTerminal: true }); } catch (_) {
                return { status: 'cleanup_refused', retryable: false, reason: 'unknown-job', retained: null };
            }
            if (!job.cancelled) return { status: 'cleanup_refused', retryable: false, reason: 'unknown-job', retained: null };
            if (job.activeOperation) {
                if (job.activeOperation.externalInstaller) {
                    job.state = JOB_STATES.CANCELLATION_REFUSED_INSTALLER_RUNNING;
                    return this.recordCancellationOutcomeLocked(job, { status: 'cancellation_refused_installer_running', retryable: true, reason: 'installer-running', retained: true });
                }
                job.state = JOB_STATES.CANCELLATION_PENDING;
                return this.recordCancellationOutcomeLocked(job, { status: 'cancellation_pending', retryable: true, reason: 'owned-work-active', retained: true });
            }
            if (job.cleanupFinalized) {
                if (job.cancellationOutcome) return { ...job.cancellationOutcome };
                if (job.state === JOB_STATES.CANCELLED_CLEAN) return { status: 'cancelled_clean', retryable: false, retained: false };
                if (job.state === JOB_STATES.CANCELLED_QUARANTINED) return { status: 'cancelled_quarantined', retryable: false, retained: true };
                return { status: 'cleanup_refused', retryable: false, reason: job.cleanupError || 'cleanup-refused', retained: true };
            }
            if (!job.createdDirectory) {
                job.cleanupComplete = true;
                job.cleanupFinalized = true;
                job.state = JOB_STATES.CANCELLED_CLEAN;
                return this.recordCancellationOutcomeLocked(job, { status: 'cancelled_clean', retryable: false, reason: 'nothing-created', retained: false });
            }

            let target = job.quarantinePath;
            if (!target) {
                const safe = resolveSafeDirectory(job.stagingRoot, job.directory, this.fs);
                const beforeIdentity = safe && directoryIdentity(this.fs, safe);
                if (!safe || !sameDirectoryIdentity(beforeIdentity, job.directoryIdentity)) return this.refuse(job, 'identity-mismatch');
                await this.invokeHook('afterInitialIdentityCheck', job);

                const quarantinePath = path.join(job.quarantineRoot, this.opaqueName('quarantine'));
                if (!isStrictChildPath(job.quarantineRoot, quarantinePath) || this.fs.existsSync(quarantinePath)) {
                    return this.refuse(job, 'unsafe-quarantine');
                }
                try {
                    this.fs.renameSync(safe, quarantinePath);
                } catch (error) {
                    if (!retryableCleanupError(error)) return this.refuse(job, 'quarantine-failed');
                    return this.recordCancellationOutcomeLocked(job, { status: 'cancellation_pending', retryable: true, reason: 'quarantine-failed', retained: true });
                }

                await this.invokeHook('afterQuarantineRename', job);
                const quarantined = resolveSafeDirectory(job.quarantineRoot, quarantinePath, this.fs);
                const afterIdentity = quarantined && directoryIdentity(this.fs, quarantined);
                if (!quarantined || !sameDirectoryIdentity(afterIdentity, job.directoryIdentity)) {
                    try {
                        if (quarantined && !this.fs.existsSync(job.directory)) this.fs.renameSync(quarantined, job.directory);
                    } catch (_) {}
                    return this.refuse(job, 'post-quarantine-identity-mismatch');
                }
                job.quarantinePath = quarantined;
                target = quarantined;
            }

            await this.invokeHook('beforeRetentionDecision', job);
            const retained = resolveSafeDirectory(job.quarantineRoot, target, this.fs);
            const retainedIdentity = retained && directoryIdentity(this.fs, retained);
            if (!retained || !sameDirectoryIdentity(retainedIdentity, job.directoryIdentity)) {
                return this.refuse(job, 'retained-identity-mismatch');
            }

            // Node does not expose a Windows handle-bound recursive delete primitive. Keep the
            // verified quarantine instead of returning to a replaceable pathname for deletion.
            job.cleanupComplete = false;
            job.cleanupFinalized = true;
            job.cleanupError = 'quarantine-retained';
            job.state = JOB_STATES.CANCELLED_QUARANTINED;
            return this.recordCancellationOutcomeLocked(job, { status: 'cancelled_quarantined', retryable: false, reason: 'quarantine-retained', retained: true });
        });
    }

    async publish(continuation) {
        const candidate = continuation && continuation.job ? continuation.job : continuation;
        await this.runExclusive(candidate, () => {
            const job = this.assertContinuation(continuation);
            if (!job.createdDirectory) throw new Error('The download job cannot be published.');
            const safe = resolveSafeDirectory(job.stagingRoot, job.directory, this.fs);
            const beforeIdentity = safe && directoryIdentity(this.fs, safe);
            if (!safe || !sameDirectoryIdentity(beforeIdentity, job.directoryIdentity)) {
                throw new Error('The staging directory identity changed before completion.');
            }
            if (this.fs.existsSync(job.finalDirectory)) throw new Error('The final game directory already exists.');
            this.transitionLocked(job, JOB_STATES.PUBLISHING);
        });
        await this.invokeHook('beforePublishRename', candidate);
        return this.runExclusive(candidate, () => {
            const job = this.assertContinuation(continuation);
            if (job.state !== JOB_STATES.PUBLISHING) throw new Error('The download job is not authorized to publish.');
            const safe = resolveSafeDirectory(job.stagingRoot, job.directory, this.fs);
            const beforeIdentity = safe && directoryIdentity(this.fs, safe);
            if (!safe || !sameDirectoryIdentity(beforeIdentity, job.directoryIdentity)) {
                throw new Error('The staging directory identity changed before publication.');
            }
            if (this.fs.existsSync(job.finalDirectory)) throw new Error('The final game directory already exists.');
            this.assertContinuation(continuation);
            this.fs.renameSync(safe, job.finalDirectory);
            const published = resolveSafeDirectory(job.root, job.finalDirectory, this.fs);
            const afterIdentity = published && directoryIdentity(this.fs, published);
            if (!published || !sameDirectoryIdentity(afterIdentity, job.directoryIdentity)) {
                job.state = JOB_STATES.FAILED_TERMINAL;
                throw new Error('The published game directory identity changed.');
            }
            const fromDirectory = job.directory;
            job.directory = published;
            job.createdDirectory = false;
            job.state = JOB_STATES.COMPLETED;
            return { fromDirectory, toDirectory: published };
        });
    }

    mapPublishedResult(result, publication) {
        const mapped = Object.assign({}, result);
        for (const key of ['folder', 'exePath', 'cover']) {
            mapped[key] = remapOwnedPath(mapped[key], publication.fromDirectory, publication.toDirectory);
        }
        return mapped;
    }

    refuse(job, reason) {
        job.cleanupComplete = false;
        job.cleanupFinalized = true;
        job.cleanupError = reason;
        job.state = JOB_STATES.CANCELLATION_REFUSED;
        return this.recordCancellationOutcomeLocked(job, { status: 'cleanup_refused', retryable: false, reason, retained: true });
    }

    async finalizeCleanupRefusal(continuation, reason = 'cleanup-retries-exhausted') {
        const candidate = continuation && continuation.job ? continuation.job : continuation;
        return this.runExclusive(candidate, () => {
            const job = this.assertContinuation(continuation, { allowTerminal: true });
            if (job.cleanupFinalized) {
                if (job.cancellationOutcome) return { ...job.cancellationOutcome };
                if (job.state === JOB_STATES.CANCELLED_CLEAN) return { status: 'cancelled_clean', retryable: false, retained: false };
                if (job.state === JOB_STATES.CANCELLED_QUARANTINED) return { status: 'cancelled_quarantined', retryable: false, retained: true };
                return { status: 'cleanup_refused', retryable: false, reason: job.cleanupError || reason, retained: true };
            }
            return this.refuse(job, reason);
        });
    }

    forget(job) {
        if (job && this.jobs.get(job.id) === job && job.state === JOB_STATES.COMPLETED) this.jobs.delete(job.id);
    }

    get(id) {
        try { return this.jobs.get(jobKey(id)) || null; } catch (_) { return null; }
    }

    matchesMetadata(job, info) {
        if (!info || typeof info !== 'object') return true;
        if (Object.prototype.hasOwnProperty.call(info, 'gameName') && text(info.gameName) !== job.gameName) return false;
        if (Object.prototype.hasOwnProperty.call(info, 'installDir') && normalizedInstallDir(info.installDir) !== job.installDir) return false;
        return true;
    }
}

module.exports = {
    CANCELLABLE_STATES,
    CANCELLATION_STATES,
    DownloadJobDirectoryRegistry,
    JOB_STATES,
    NONTERMINAL_STATES,
    STAGING_DIRECTORY_NAME,
    TERMINAL_STATES,
    directoryIdentity,
    isStrictChildPath,
    resolveSafeDeletionTarget,
    sameDirectoryIdentity,
    sanitizeDownloadDirectoryName
};
