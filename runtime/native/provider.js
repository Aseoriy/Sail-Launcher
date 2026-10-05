'use strict';

const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./protocol');
const { protonActivity, validateLaunchMetadata } = require('../proton/session');
const { confirmedGame, validateGameTracking } = require('../proton/tracking');
const { launchEnvironment } = require('../proton/environment');

function publicSession(session) {
    if (!session || session.provider !== 'linux-native') return session;
    const { native, ...metadata } = session;
    const activity = protonActivity(session);
    return { ...metadata, native: { phase: native.phase, error: native.error || '',
        elapsedMs: activity ? confirmedGame(session) ? native.receipt.game.elapsedMs : 0 : native.receipt ? native.receipt.elapsedMs : 0,
        ...(activity ? { activityElapsedMs: native.receipt ? native.receipt.elapsedMs : 0 } : {}),
        ...(activity === 'game' ? { gameConfirmed: confirmedGame(session), gameActiveProcesses: native.receipt?.game?.activeProcesses || 0, gameTrackingError: native.receipt?.game?.error || 0 } : {}),
        ownedChildren: native.receipt ? native.receipt.ownedChildren : 0,
        rootExited: !!(native.receipt && native.receipt.rootExited), clock: 'CLOCK_MONOTONIC',
        ...(native.launchMetadata ? { runtime: { backend: native.launchMetadata.backend, label: native.launchMetadata.label, activity } } : {}),
        ...(native.receipt && native.receipt.scriptView ? { scriptView: {
            state: native.receipt.scriptView.state, gameFinished: native.receipt.scriptView.gameFinished,
            cleanupErrno: native.receipt.scriptView.cleanupErrno } } : {}) } };
}
class NativeProvider {
    constructor({ gateway, journal, sessionRoot, fixtureRoot = null, canAccessSession = () => true, onEnded = () => {}, onChanged = () => {} }) {
        this.gateway = gateway;
        this.journal = journal;
        this.root = path.resolve(sessionRoot);
        this.logs = new (require('./launchLog').LaunchLogs)(this.root);
        this.fixtureRoot = fixtureRoot;
        this.canAccessSession = canAccessSession;
        this.onEnded = onEnded;
        this.onChanged = onChanged;
        this.queue = Promise.resolve();
        this.timer = null;
        this.disposed = false;
        this.available = false;
        this.scriptsAvailable = false;
        this.windowsTrackingAvailable = false;
        this.wineTrackingAvailable = false;
        this.reason = 'The native supervisor has not been checked.';
        this.initialization = null;
    }
    serialize(operation) {
        const result = this.queue.then(() => {
            if (this.disposed) throw protocol.nativeError('SAIL_NATIVE_CLOSED', 'Native monitoring has stopped.');
            return operation();
        });
        this.queue = result.catch(() => {});
        return result;
    }
    initialize() {
        if (!this.initialization) this.initialization = this.initializeOnce();
        return this.initialization;
    }
    async initializeOnce() {
        try {
            fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
            const stat = fs.lstatSync(this.root);
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Native session storage must be a private owned directory.');
            const probe = await this.gateway.probe();
            if (probe.protocol !== 1 || probe.arch !== 'x64' || probe.pidfd !== true || probe.subreaper !== true || probe.clock !== 'CLOCK_MONOTONIC') throw new Error('The native supervisor protocol or kernel features are unavailable.');
            this.available = true; this.reason = '';
            this.scriptsAvailable = probe.scripts === 'native-path-v1';
            this.windowsTrackingAvailable = probe.windowsTracking === 'pe-image-v1';
            this.wineTrackingAvailable = probe.wineTracking === 'pe-image-wine-v1';
        } catch (error) { this.available = false; this.reason = error.message; }
        // A failed new-helper probe does not revoke an existing supervisor or
        // its durable receipts. Reconcile them before exposing the first UI.
        if (!this.disposed) {
            try { await this.poll(); } catch (error) { this.available = false; this.reason = error.message; }
            if (!this.disposed) {
                this.timer = setInterval(() => this.poll().catch(() => {}), 500);
                this.timer.unref();
            }
        }
        return { available: this.available, reason: this.reason, scriptsAvailable: this.available && this.scriptsAvailable,
            windowsTrackingAvailable: this.available && this.windowsTrackingAvailable, wineTrackingAvailable: this.available && this.wineTrackingAvailable };
    }
    snapshot() {
        const snapshot = this.journal.snapshot();
        snapshot.activeSessions = Object.fromEntries(Object.entries(snapshot.activeSessions).map(([key, session]) => [key, publicSession(session)]));
        return snapshot;
    }
    session(id) {
        return Object.values(this.journal.snapshot().activeSessions).find(item => item.sessionId === id && item.provider === 'linux-native');
    }
    directory(session) {
        const root = fs.lstatSync(this.root);
        if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || root.mode & 0o077) {
            throw protocol.nativeError('SAIL_NATIVE_IDENTITY', 'Native session storage is no longer private.');
        }
        if (!protocol.UUID.test(session.sessionId) || session.native.directory !== path.join(this.root, session.sessionId)
            || !/^[0-9a-f]{64}$/.test(session.native.nonce)) throw protocol.nativeError('SAIL_NATIVE_IDENTITY', 'The stored native session identity is invalid.');
        const directory = session.native.directory;
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw protocol.nativeError('SAIL_NATIVE_IDENTITY', 'Native receipt storage is no longer private.');
        return directory;
    }
    receiptFromDisk(session) {
        const file = path.join(this.directory(session), 'receipt.json');
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || stat.uid !== process.getuid() || stat.mode & 0o077) throw protocol.nativeError('SAIL_NATIVE_RECEIPT', 'The native receipt file is invalid.');
        return protocol.validateReceipt(JSON.parse(fs.readFileSync(file, 'utf8')), session.sessionId, session.native.owner, session.native.receipt, session.native.executionKind || 'elf', session.native.gameTracking);
    }
    assertOwner(session) {
        this.directory(session);
        const owner = session.native.owner;
        if (!owner || !protocol.sameOwner(owner, protocol.processIdentity(owner.supervisorPid))
            || owner.pidNamespace !== fs.readlinkSync('/proc/self/ns/pid')) throw protocol.nativeError('SAIL_NATIVE_IDENTITY', 'The native supervisor identity changed. No process was signaled.');
        return owner;
    }
    async verifiedRequest(session, verb) {
        const owner = this.assertOwner(session);
        const receipt = await this.gateway.request(session.sessionId, session.native.nonce, verb);
        return protocol.validateReceipt(receipt, session.sessionId, owner, session.native.receipt, session.native.executionKind || 'elf', session.native.gameTracking);
    }
    async accept(session, receipt) {
        protocol.validateReceipt(receipt, session.sessionId, session.native.owner, session.native.receipt, session.native.executionKind || 'elf', session.native.gameTracking);
        if (!receipt.durable || receipt.receiptErrno) throw protocol.nativeError('SAIL_NATIVE_RECEIPT_WRITE', 'The native supervisor could not durably save its process receipt. Tracking is pending.');
        if (receipt.terminal) {
            const event = this.journal.finishNativeSession(session.sessionId, receipt);
            // The event is now retained by the journal; the supervisor can exit.
            // A lost reply is harmless: replay remains authoritative and pending.
            try { await this.verifiedRequest({ ...session, native: { ...session.native, receipt } }, 'ACK'); } catch (_) {}
            this.onEnded(event); this.onChanged(this.snapshot());
            return { event, session: null };
        }
        const next = this.journal.updateNativeSession(session.sessionId, { receipt, phase: receipt.phase,
            error: receipt.game?.error ? `Windows image tracking failed (errno ${receipt.game.error}). Playtime is not counted for this session.` : receipt.scriptView && receipt.scriptView.cleanupErrno
                ? `Script cleanup failed (errno ${receipt.scriptView.cleanupErrno}). Playtime is frozen; completion remains unresolved.`
                : receipt.trackingErrno ? `Native process tracking is incomplete (errno ${receipt.trackingErrno}). Stop and completion remain unresolved.` : '' });
        this.onChanged(this.snapshot());
        return { session: publicSession(next), event: null };
    }
    async inspect(session) {
        try {
            let receipt = this.receiptFromDisk(session);
            if (receipt.bootId !== fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
                || receipt.pidNamespace !== fs.readlinkSync('/proc/self/ns/pid')) throw protocol.nativeError('SAIL_NATIVE_IDENTITY', 'Native receipt boot or namespace differs from this launcher.');
            if (!session.native.owner) {
                // Starting intent contains the nonce before the helper exists.
                // Adopt only the private receipt identity, then authenticate it.
                const owner = { bootId: receipt.bootId, pidNamespace: receipt.pidNamespace,
                    supervisorPid: receipt.supervisorPid, supervisorStartTicks: receipt.supervisorStartTicks };
                session = this.journal.updateNativeSession(session.sessionId, { owner });
            }
            if (!receipt.terminal) receipt = await this.verifiedRequest(session, 'STATUS');
            if (!receipt.durable || receipt.receiptErrno) throw protocol.nativeError('SAIL_NATIVE_RECEIPT_WRITE', 'The native supervisor could not durably save its process receipt. Tracking is pending.');
            if (!this.canAccessSession(session)) {
                // Historical removals/switches may already have stranded this
                // scope. Retain the actual receipt without inventing a game,
                // credit or Stop authority; the explicit unresolved exit stays
                // reachable, including for a terminal receipt awaiting repair.
                this.journal.updateNativeSession(session.sessionId, { receipt, phase: 'tracking-lost',
                    error: 'This native session has no accessible game in the active library. Its original profile/library binding is unavailable. Leaving Sail preserves the unresolved receipt and does not stop the game.' });
                this.onChanged(this.snapshot());
                return { session: publicSession(this.session(session.sessionId)) };
            }
            return await this.accept(session, receipt);
        } catch (error) {
            const active = this.session(session.sessionId);
            if (!active) throw error;
            // Never infer terminal state or an unobserved duration from PID loss.
            this.journal.updateNativeSession(session.sessionId, { phase: 'tracking-lost', error: `Native session unresolved: ${error.message}`.slice(0, 400) });
            this.onChanged(this.snapshot());
            return { session: publicSession(this.session(session.sessionId)), error: error.message };
        }
    }
    poll() {
        return this.serialize(async () => {
            for (const session of Object.values(this.journal.snapshot().activeSessions)) {
                if (session.provider === 'linux-native') await this.inspect(session);
            }
        });
    }
    launch({ gameId, libraryKey, gameName, resolve, launchMetadata }) {
        return this.serialize(async () => {
            if (!this.available) throw protocol.nativeError('SAIL_NATIVE_UNAVAILABLE', this.reason);
            const details = resolve(); protocol.assertNativeOptions(details);
            const binding = validateLaunchMetadata(launchMetadata);
            const umuEnvironment = launchEnvironment(details);
            const gameTracking = validateGameTracking(details.gameTracking);
            const wine = binding?.backend === 'wine';
            if (gameTracking && (!(wine ? this.wineTrackingAvailable : this.windowsTrackingAvailable) || binding?.activity !== 'game'
                || (gameTracking.backend === 'wine') !== wine || gameTracking.prefix !== umuEnvironment?.prefix
                || gameTracking.protonRoot !== (wine ? umuEnvironment?.root : umuEnvironment?.proton)) || binding?.activity === 'game' && !gameTracking) throw protocol.nativeError('SAIL_PROTON_TRACKING', 'Windows game tracking is unavailable or unbound.');
            if (!!binding !== !!umuEnvironment || (binding && (binding.activity !== umuEnvironment.activity || (umuEnvironment.backend === 'wine') !== wine))) {
                throw protocol.nativeError('SAIL_PROTON_ENVIRONMENT', 'The runtime activity and UMU environment must match.');
            }
            const executable = protocol.validateNativeExecutable(details.executablePath, { fixtureRoot: this.fixtureRoot, expected: details.executableIdentity, allowScripts: this.scriptsAvailable });
            const executionKind = executable.executionKind || 'elf';
            const cwd = protocol.validateWorkingDirectory(details.workingDirectory, { fixtureRoot: this.fixtureRoot, expected: details.workingDirectoryIdentity });
            const argv = protocol.validateArgv(details.argv || []);
            const identity = protocol.newSession(); const directory = path.join(this.root, identity.sessionId);
            const config = protocol.encodeConfig({ ...identity, directory, executable, cwd, argv, gameTracking });
            let session = this.journal.startNativeSession({ ...identity, executionKind, directory, gameId, libraryKey, gameName, launchMetadata, gameTracking });
            try {
                fs.mkdirSync(directory, { mode: 0o700 });
                if (binding?.activity === 'game' || binding?.activity === 'installation') {
                    try { this.logs.bind(session); } catch (_) { /* Diagnostics cannot prevent an approved game launch. */ }
                }
                const receipt = protocol.validateReceipt(await this.gateway.start(config, umuEnvironment), identity.sessionId, null, null, executionKind, gameTracking);
                const owner = protocol.processIdentity(receipt.supervisorPid);
                if (!protocol.sameOwner(owner, receipt) || owner.pidNamespace !== fs.readlinkSync('/proc/self/ns/pid')) throw protocol.nativeError('SAIL_NATIVE_IDENTITY', 'Native supervisor readiness identity mismatch.');
                session = this.journal.updateNativeSession(identity.sessionId, { owner, receipt });
                const current = resolve(); protocol.assertNativeOptions(current);
                if (!require('node:util').isDeepStrictEqual(umuEnvironment, launchEnvironment(current))
                    || !require('node:util').isDeepStrictEqual(gameTracking, validateGameTracking(current.gameTracking))) {
                    throw protocol.nativeError('SAIL_CAPABILITY_PATH_CHANGED', 'The UMU environment changed before launch. Review its setup again.');
                }
                const selected = protocol.validateNativeExecutable(current.executablePath, { fixtureRoot: this.fixtureRoot, expected: executable, allowScripts: this.scriptsAvailable });
                if ((selected.executionKind || 'elf') !== executionKind) throw protocol.nativeError('SAIL_CAPABILITY_PATH_CHANGED', 'The native executable format changed before launch. Review local setup again.');
                protocol.validateWorkingDirectory(current.workingDirectory, { fixtureRoot: this.fixtureRoot, expected: cwd });
                if (JSON.stringify(protocol.validateArgv(current.argv || [])) !== JSON.stringify(argv)) throw protocol.nativeError('SAIL_CAPABILITY_PATH_CHANGED', 'Native arguments changed before launch. Review local setup again.');
                session = this.journal.updateNativeSession(identity.sessionId, { commitRequested: true });
                const committed = await this.verifiedRequest(session, 'COMMIT');
                if (committed.execErrno) {
                    await this.accept(session, committed);
                    throw protocol.nativeError('SAIL_NATIVE_EXEC', `The native executable could not start (kernel errno ${committed.execErrno}). No playtime was added.`);
                }
                const result = await this.accept(session, committed);
                return { provider: 'linux-native', sessionId: identity.sessionId, ...result };
            } catch (error) {
                const active = this.session(identity.sessionId);
                if (active) {
                    // An uncommitted helper expires without executing. A commit
                    // whose reply was lost is recovered, never retried as a launch.
                    try {
                        if (active.native.owner && !active.native.commitRequested) {
                            await this.accept(active, await this.verifiedRequest(active, 'STOP'));
                        } else if (!active.native.commitRequested) this.journal.cancelNativeStart(active.sessionId);
                        else await this.inspect(active);
                    } catch (_) { /* Durable intent remains for a later retry. */ }
                }
                throw error;
            }
        });
    }
    stop({ sessionId, gameId, libraryKey, authorize }) {
        return this.serialize(async () => {
            const session = this.session(sessionId);
            if (!session || session.gameId !== gameId || session.libraryKey !== libraryKey) throw protocol.nativeError('SAIL_NATIVE_SESSION', 'Stop requires this game’s exact active native session.');
            if (typeof authorize !== 'function' || !this.canAccessSession(session)) throw protocol.nativeError('SAIL_NATIVE_AUTHORITY', 'Stop requires current permission for this game in its active library.');
            this.receiptFromDisk(session);
            this.assertOwner(session);
            // Main rechecks the current sender/profile and consumes permission
            // inside this queue. Permission errors do not change ownership state.
            const authority = authorize(session);
            if (!authority || authority.operation !== 'terminate') throw protocol.nativeError('SAIL_NATIVE_AUTHORITY', 'Native termination permission was not established.');
            const receipt = await this.verifiedRequest(session, 'STOP');
            const result = await this.accept(session, receipt);
            return { requested: true, complete: !!receipt.terminal, phase: receipt.phase, replacement: authority.replacement, ...result };
        });
    }
    acknowledgeUnresolvedExit(ids) {
        return this.serialize(async () => {
            const active = Object.values(this.journal.snapshot().activeSessions).filter(session => session.provider === 'linux-native');
            if (active.length !== ids.length || active.some(session => !ids.includes(session.sessionId)
                || !['tracking-lost', 'cleanup-failed'].includes(session.native.phase))) {
                throw new Error('Native tracking changed while the exit dialog was open. Review the current session before leaving.');
            }
            for (const session of active) this.journal.updateNativeSession(session.sessionId, { disposition: 'left-unresolved' });
        });
    }
    dispose() {
        if (this.disposed) return false;
        this.disposed = true; clearInterval(this.timer); this.timer = null;
        // Session supervisors intentionally survive launcher death/restart.
        // Disposing the observer never signals a game or fabricates completion.
        return true;
    }
}
module.exports = { NativeProvider, publicSession };
