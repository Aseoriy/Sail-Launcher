'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CANCELLATION_STATUSES, createDownloadCancellationHandler, registerDownloadCancellationIpc } = require('../runtime/downloadIpc');
const {
    DownloadJobDirectoryRegistry,
    STAGING_DIRECTORY_NAME,
    resolveSafeDeletionTarget,
    sanitizeDownloadDirectoryName
} = require('../runtime/downloadJobCleanup');
const { DownloadQuarantineCatalog } = require('../runtime/downloadQuarantine');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function waitUntil(predicate, label = 'condition') {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-download-cleanup-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const quarantineCatalog = new DownloadQuarantineCatalog({
        catalogPath: path.join(root, 'userData', 'download-quarantine-roots.json'),
        fs: options.fs || fs
    });
    return {
        root,
        defaultRoot: path.join(root, 'default-downloads'),
        customRoot: path.join(root, 'custom-downloads'),
        quarantineCatalog,
        registry: new DownloadJobDirectoryRegistry({ ...options, quarantineCatalog })
    };
}

async function beginOwned(env, id = 'job', gameName = 'Pookie Quest', state = 'downloading') {
    const job = env.registry.begin(id, { gameName, installDir: env.customRoot, defaultRoot: env.defaultRoot });
    await env.registry.ensureDirectory(job);
    await env.registry.setState(job, state);
    return job;
}

function immediateHandler(env, options = {}) {
    return createDownloadCancellationHandler({
        registry: env.registry,
        activeDownloads: options.activeDownloads || new Map(),
        pendingBrowserDownloads: options.pendingBrowserDownloads || new Map(),
        retryDelays: options.retryDelays || [0, 0, 0],
        setTimeout: callback => { queueMicrotask(callback); return 1; },
        onCleanupOutcome: options.onCleanupOutcome
    });
}

async function cancelAndWait(handler, job) {
    const result = await handler({}, job.id);
    assert.ok(Object.values(CANCELLATION_STATUSES).includes(result.status));
    await waitUntil(() => job.cleanupFinalized, `${job.id} quarantine decision`);
    return result;
}

test('cancellation before staging creation is terminal and prevents every later creation or transition', async t => {
    const env = fixture(t);
    const job = env.registry.begin('before-create', { gameName: 'Before Create', defaultRoot: env.defaultRoot });
    const continuation = env.registry.continuation(job);
    const result = await cancelAndWait(immediateHandler(env), job);
    assert.equal(result.status, CANCELLATION_STATUSES.CLEAN);

    assert.equal(job.state, 'cancelled_clean');
    assert.equal(job.cleanupComplete, true);
    assert.equal(fs.existsSync(job.directory), false);
    await assert.rejects(env.registry.ensureDirectory(continuation), /terminal|invalidated/i);
    await assert.rejects(env.registry.setState(continuation, 'downloading'), /terminal|invalidated/i);
    await assert.rejects(env.registry.publish(continuation), /terminal|invalidated/i);
    assert.equal(fs.existsSync(job.directory), false);
});

for (const hookName of ['beforeTerminalCheck', 'afterTerminalCheckBeforeCreate', 'afterDirectoryCreate']) {
    test(`cancellation racing at ${hookName} serializes behind creation and owns the retained quarantine`, async t => {
        const entered = deferred();
        const release = deferred();
        const env = fixture(t, { hooks: { [hookName]: async () => { entered.resolve(); await release.promise; } } });
        const job = env.registry.begin(`race-${hookName}`, { gameName: 'Race Game', defaultRoot: env.defaultRoot });
        const ensure = env.registry.ensureDirectory(job);
        await entered.promise;
        const cancel = immediateHandler(env)({}, job.id);
        release.resolve();
        await ensure;
        assert.equal((await cancel).status, CANCELLATION_STATUSES.QUARANTINED);
        await waitUntil(() => job.cleanupFinalized, 'serialized cleanup');

        assert.equal(job.state, 'cancelled_quarantined');
        assert.equal(fs.existsSync(job.directory), false);
        assert.equal(fs.existsSync(job.quarantinePath), true);
        await assert.rejects(env.registry.setState(job, 'downloading'), /terminal/i);
    });
}

test('stale resolving continuation after cancellation cannot create or publish staging', async t => {
    const env = fixture(t);
    const resolving = deferred();
    const job = env.registry.begin('resolving-race', { gameName: 'Resolving Race', defaultRoot: env.defaultRoot });
    const continuation = env.registry.continuation(job);
    await env.registry.setState(continuation, 'resolving');
    const staleSetup = (async () => {
        await resolving.promise;
        return env.registry.ensureDirectory(continuation);
    })();
    const result = await cancelAndWait(immediateHandler(env), job);
    assert.equal(result.status, CANCELLATION_STATUSES.CLEAN);
    resolving.resolve();
    await assert.rejects(staleSetup, /terminal|invalidated/i);
    assert.equal(fs.existsSync(job.directory), false);
});

test('stale continuation cannot act on a newer generation using the same external job ID', async t => {
    const env = fixture(t);
    const oldJob = await beginOwned(env, 'reused-id', 'Old Game', 'processing');
    const oldContinuation = env.registry.continuation(oldJob);
    await env.registry.publish(oldContinuation);
    env.registry.forget(oldJob);
    const newJob = env.registry.begin('reused-id', { gameName: 'New Game', defaultRoot: env.defaultRoot });
    assert.notEqual(newJob.generation, oldJob.generation);
    await assert.rejects(env.registry.ensureDirectory(oldContinuation), /stale|unknown/i);
    assert.equal(fs.existsSync(newJob.directory), false);
});

test('normal cancellation quarantines the exact owned object and never invokes pathname recursive deletion', async t => {
    const wrappedFs = Object.create(fs);
    let recursiveDeletes = 0;
    wrappedFs.rmSync = () => { recursiveDeletes += 1; throw new Error('production cleanup must not call rmSync'); };
    const env = fixture(t, { fs: wrappedFs });
    fs.mkdirSync(env.customRoot, { recursive: true });
    const neighbor = path.join(env.customRoot, 'neighbor.txt');
    fs.writeFileSync(neighbor, 'keep');
    const job = await beginOwned(env);
    fs.writeFileSync(path.join(job.directory, 'partial.bin'), 'partial');

    const result = await cancelAndWait(immediateHandler(env), job);
    assert.equal(result.status, CANCELLATION_STATUSES.QUARANTINED);
    assert.equal(job.state, 'cancelled_quarantined');
    assert.equal(job.cleanupComplete, false);
    assert.equal(recursiveDeletes, 0);
    assert.equal(fs.existsSync(job.directory), false);
    assert.equal(fs.readFileSync(path.join(job.quarantinePath, 'partial.bin'), 'utf8'), 'partial');
    assert.equal(fs.readFileSync(neighbor, 'utf8'), 'keep');
    assert.equal(fs.existsSync(env.customRoot), true);
});

test('ordinary same-path replacement before cleanup remains untouched', async t => {
    const env = fixture(t);
    const job = await beginOwned(env, 'replacement');
    fs.rmSync(job.directory, { recursive: true, force: true });
    fs.mkdirSync(job.directory);
    const sentinel = path.join(job.directory, 'replacement.txt');
    fs.writeFileSync(sentinel, 'keep');
    const result = await cancelAndWait(immediateHandler(env), job);
    assert.equal(result.status, CANCELLATION_STATUSES.REFUSED);
    assert.equal(job.state, 'cancellation_refused');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

test('same-path junction replacement remains untouched', async t => {
    const env = fixture(t);
    const job = await beginOwned(env, 'junction');
    const outside = path.join(env.root, 'outside');
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, 'must-survive.txt');
    fs.writeFileSync(sentinel, 'keep');
    fs.rmSync(job.directory, { recursive: true, force: true });
    try { fs.symlinkSync(outside, job.directory, 'junction'); } catch (error) {
        t.skip(`junction creation is unavailable: ${error.code || error.message}`);
        return;
    }
    await cancelAndWait(immediateHandler(env), job);
    assert.equal(job.state, 'cancellation_refused');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

for (const hookName of ['afterInitialIdentityCheck', 'afterQuarantineRename', 'beforeRetentionDecision']) {
    test(`replacement at production cleanup boundary ${hookName} survives`, async t => {
        let swapped = false;
        let replacementPath = '';
        const env = fixture(t, { hooks: { [hookName]: async job => {
            if (swapped) return;
            swapped = true;
            replacementPath = hookName === 'afterInitialIdentityCheck'
                ? job.directory
                : (hookName === 'afterQuarantineRename'
                    ? fs.readdirSync(job.quarantineRoot).map(name => path.join(job.quarantineRoot, name)).find(candidate => path.basename(candidate).startsWith('quarantine-'))
                    : job.quarantinePath);
            fs.rmSync(replacementPath, { recursive: true, force: true });
            fs.mkdirSync(replacementPath);
            fs.writeFileSync(path.join(replacementPath, 'replacement.txt'), 'keep');
        } } });
        const job = await beginOwned(env, `boundary-${hookName}`);
        await cancelAndWait(immediateHandler(env), job);
        const survivingPath = fs.existsSync(replacementPath) ? replacementPath : job.directory;
        assert.equal(fs.readFileSync(path.join(survivingPath, 'replacement.txt'), 'utf8'), 'keep');
        assert.equal(job.state, 'cancellation_refused');
    });
}

test('pre-existing final and opaque staging targets are rejected rather than adopted', async t => {
    const env = fixture(t);
    const existing = path.join(env.customRoot, 'Existing Game');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'user-file.txt'), 'keep');
    assert.throws(() => env.registry.begin('existing', {
        gameName: 'Existing Game', installDir: env.customRoot, defaultRoot: env.defaultRoot
    }), /already exists/i);

    const deterministic = new DownloadJobDirectoryRegistry({ randomBytes: () => Buffer.alloc(24, 0xaa) });
    const otherRoot = path.join(env.root, 'deterministic');
    const occupied = path.join(otherRoot, STAGING_DIRECTORY_NAME, `job-${'aa'.repeat(24)}`);
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, 'sentinel.txt'), 'keep');
    const job = deterministic.begin('occupied', { gameName: 'New Game', installDir: otherRoot, defaultRoot: env.defaultRoot });
    await assert.rejects(deterministic.ensureDirectory(job), error => error && error.code === 'EEXIST');
    assert.equal(fs.readFileSync(path.join(occupied, 'sentinel.txt'), 'utf8'), 'keep');
});

test('provider names cannot influence opaque staging identity', async t => {
    const env = fixture(t);
    const names = ['Pookie/Quest', 'Pookie\\Quest', 'CON', 'name...', 'bad<>:"|?*chars', 'dot . name'];
    const stagingNames = [];
    for (let index = 0; index < names.length; index++) {
        const job = env.registry.begin(`name-${index}`, { gameName: names[index], defaultRoot: env.defaultRoot });
        await env.registry.ensureDirectory(job);
        stagingNames.push(path.basename(job.directory));
        assert.match(path.basename(job.directory), /^job-[a-f0-9]{48}$/);
        assert.equal(path.dirname(job.directory), fs.realpathSync.native(path.join(env.defaultRoot, STAGING_DIRECTORY_NAME)));
    }
    assert.equal(new Set(stagingNames).size, names.length);
    for (const name of ['.', '..', '...', '<.>', '<..>']) {
        assert.throws(() => env.registry.begin(`dot-${name}`, { gameName: name, defaultRoot: env.defaultRoot }), /empty or dot/i);
    }
    assert.equal(sanitizeDownloadDirectoryName('CON'), '_CON');
});

test('unknown mismatched completed and restart-stale jobs fail before sensitive side effects', async t => {
    const env = fixture(t);
    const job = await beginOwned(env, 'known');
    let kills = 0;
    const activeDownloads = new Map([[job.id, { proc: { kill: () => { kills += 1; } }, job }]]);
    const handler = immediateHandler(env, { activeDownloads });
    assert.equal((await handler({}, 'missing')).status, CANCELLATION_STATUSES.REFUSED_UNKNOWN_JOB);
    assert.equal(await env.registry.requestCancel(job.id, { gameName: 'Wrong Game' }), null);
    assert.equal(await env.registry.requestCancel(job.id, { installDir: path.join(env.root, 'forged') }), null);
    assert.equal(kills, 0);

    const completed = await beginOwned(env, 'completed', 'Completed Game');
    await env.registry.publish(completed);
    assert.equal((await handler({}, completed.id)).status, CANCELLATION_STATUSES.REFUSED_UNKNOWN_JOB);

    const restarted = new DownloadJobDirectoryRegistry();
    assert.equal(await restarted.requestCancel(job.id, {}), null);
    assert.equal(fs.existsSync(job.directory), true);
});

test('all supported cancellation states use the same ownership proof and repeated cancellation is idempotent', async t => {
    const env = fixture(t);
    for (const state of ['resolving', 'downloading', 'paused', 'processing', 'installing']) {
        const job = await beginOwned(env, `${state}-job`, `${state} Game`, state);
        fs.writeFileSync(path.join(job.directory, 'partial.bin'), state);
        const handler = immediateHandler(env);
        await cancelAndWait(handler, job);
        const attempts = job.cleanupAttempts;
        const repeated = await handler({}, job.id);
        assert.equal(repeated.status, CANCELLATION_STATUSES.ALREADY_CANCELLED, state);
        assert.equal(repeated.retained, true, state);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(job.cleanupAttempts, attempts, state);
        assert.equal(job.state, 'cancelled_quarantined', state);
        assert.equal(fs.readFileSync(path.join(job.quarantinePath, 'partial.bin'), 'utf8'), state);
    }
});

test('bounded quarantine retries never broaden deletion authority', async t => {
    const wrappedFs = Object.create(fs);
    let failures = 2;
    let recursiveDeletes = 0;
    wrappedFs.renameSync = (from, to) => {
        if (path.basename(to).startsWith('quarantine-') && failures-- > 0) {
            const error = new Error('locked'); error.code = 'EBUSY'; throw error;
        }
        return fs.renameSync(from, to);
    };
    wrappedFs.rmSync = () => { recursiveDeletes += 1; throw new Error('not authorized'); };
    const env = fixture(t, { fs: wrappedFs });
    const job = await beginOwned(env, 'locked');
    const result = await cancelAndWait(immediateHandler(env, { retryDelays: [0, 0, 0] }), job);
    assert.equal(result.status, CANCELLATION_STATUSES.PENDING);
    assert.equal(job.cleanupAttempts, 3);
    assert.equal(job.state, 'cancelled_quarantined');
    assert.equal(recursiveDeletes, 0);
});

test('publishing preserves a legitimate custom root while remapping result paths', async t => {
    const env = fixture(t);
    const job = await beginOwned(env, 'publish', 'Published Game', 'processing');
    const exe = path.join(job.directory, '_game', 'Published.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'exe');
    const publication = await env.registry.publish(job);
    const result = env.registry.mapPublishedResult({ folder: path.dirname(exe), exePath: exe, cover: '' }, publication);
    assert.equal(result.exePath, path.join(env.customRoot, 'Published Game', '_game', 'Published.exe'));
    assert.equal(fs.existsSync(result.exePath), true);
    assert.equal(fs.existsSync(path.join(env.customRoot, STAGING_DIRECTORY_NAME)), true);
});

test('real IPC registration executes the production cancellation handler and fail-closed quarantine', async t => {
    const env = fixture(t);
    const handlers = new Map();
    const job = await beginOwned(env, 'registered');
    fs.writeFileSync(path.join(job.directory, 'partial.bin'), 'partial');
    registerDownloadCancellationIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
        registry: env.registry,
        activeDownloads: new Map(),
        pendingBrowserDownloads: new Map(),
        retryDelays: [0],
        setTimeout: callback => { queueMicrotask(callback); return 1; }
    });
    await cancelAndWait(handlers.get('cancel-download'), job);
    assert.equal(job.state, 'cancelled_quarantined');
    assert.equal(fs.readFileSync(path.join(job.quarantinePath, 'partial.bin'), 'utf8'), 'partial');
});

test('root equality and parent escape are never cleanup targets', t => {
    const env = fixture(t);
    const child = path.join(env.defaultRoot, 'child');
    const outside = path.join(env.root, 'outside');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const root = fs.realpathSync.native(env.defaultRoot);
    assert.equal(resolveSafeDeletionTarget(root, root), null);
    assert.equal(resolveSafeDeletionTarget(root, outside), null);
    assert.equal(resolveSafeDeletionTarget(root, child), fs.realpathSync.native(child));
});
