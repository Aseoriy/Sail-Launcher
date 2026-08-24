'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { BrowserDownloadIntentRegistry, INTENT_STATES, createBrowserWillDownloadHandler, createPrepareBrowserDownloadHandler } = require('../runtime/browserDownloadIntents');
const { DownloadJobDirectoryRegistry, JOB_STATES } = require('../runtime/downloadJobCleanup');
const { CANCELLATION_STATUSES, createDownloadCancellationHandler, registerDownloadCancellationIpc } = require('../runtime/downloadIpc');
const { createDownloadWorkCoordinator } = require('../runtime/downloadWorkCoordinator');
const { runOwnedChildProcess } = require('../runtime/ownedChildProcess');
const { cancellationPresentation } = require('../ui/downloadQuarantine');

function rendererFunctionSource(source, marker) {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `Missing production renderer function: ${marker}`);
    const brace = source.indexOf('{', start);
    let depth = 0;
    for (let index = brace; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    assert.fail(`Unterminated production renderer function: ${marker}`);
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-cancel-lifecycle-'));
    const downloadRoot = path.join(root, 'downloads');
    const registry = new DownloadJobDirectoryRegistry();
    const activeDownloads = new Map();
    const pendingBrowserDownloads = new Map();
    const outcomes = [];
    const intents = new BrowserDownloadIntentRegistry({
        beginJob: (id, options) => registry.begin(id, Object.assign({ defaultRoot: downloadRoot }, options)),
        tombstoneTtlMs: 60_000,
        maxIntents: 16
    });
    const ipcHandlers = new Map();
    registerDownloadCancellationIpc({ handle: (channel, handler) => ipcHandlers.set(channel, handler) }, {
        registry,
        activeDownloads,
        pendingBrowserDownloads,
        browserIntents: intents,
        retryDelays: [0, 0],
        setTimeout: callback => { queueMicrotask(callback); return 1; },
        onCleanupOutcome: (job, outcome) => outcomes.push({ id: job.id, ...outcome })
    });
    const cancel = ipcHandlers.get('cancel-download');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, downloadRoot, registry, activeDownloads, intents, cancel, outcomes };
}

function browserItem() {
    return {
        paused: 0,
        cancelled: 0,
        pause() { this.paused += 1; },
        cancel() { this.cancelled += 1; }
    };
}

async function waitUntil(predicate, label) {
    const expires = Date.now() + 3000;
    while (Date.now() < expires) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out waiting for ${label}.`);
}

test('cancelled waiting-browser intent remains a tombstone and rejects its late real browser event', async t => {
    const env = fixture(t);
    const intent = env.intents.prepare(91, { gameName: 'Late Browser Game' });
    await env.registry.setState(intent.job, JOB_STATES.WAITING_BROWSER);
    const stagingPath = intent.job.directory;

    const result = await env.cancel({}, intent.job.id);
    assert.equal(result.status, CANCELLATION_STATUSES.CLEAN);
    assert.equal(intent.state, INTENT_STATES.CANCELLED);
    assert.equal(fs.existsSync(stagingPath), false);

    let captures = 0;
    const handler = createBrowserWillDownloadHandler({
        intents: env.intents,
        isCaptureEnabled: () => true,
        isRegistered: () => true,
        capture: () => { captures += 1; }
    });
    const lateItem = browserItem();
    handler({}, lateItem, { id: 91 });
    assert.equal(lateItem.paused, 1);
    assert.equal(lateItem.cancelled, 1);
    assert.equal(captures, 0);
    assert.equal(fs.existsSync(stagingPath), false);
});

test('production browser preparation issues opaque identities and ignores renderer IDs and paths', async t => {
    const env = fixture(t);
    const registered = [];
    const prepare = createPrepareBrowserDownloadHandler({
        intents: env.intents,
        registry: env.registry,
        getDefaults: () => ({ installDir: env.downloadRoot, autoExtract: true }),
        registerWebContents: id => registered.push(id)
    });
    const forgedPath = path.join(env.root, 'renderer-chosen');
    const result = await prepare({ sender: { send() {} } }, {
        webContentsId: 44,
        id: 'renderer-id',
        installDir: forgedPath,
        metadata: {
            id: 'renderer-id',
            installDir: forgedPath,
            path: forgedPath,
            gameName: 'Prepared Game',
            sourceId: 'steamrip',
            url: 'https://example.invalid/game'
        }
    });
    assert.equal(result.ok, true);
    assert.match(result.intentId, /^intent_[a-f0-9]{48}$/);
    assert.match(result.jobId, /^browser_[a-f0-9]{48}$/);
    assert.notEqual(result.jobId, 'renderer-id');
    const intent = env.intents.getForJob(result.jobId);
    assert.equal(intent.job.installDir, env.downloadRoot);
    assert.equal(intent.options.installDir, env.downloadRoot);
    assert.equal(intent.options.path, undefined);
    assert.deepEqual(registered, [44]);
});

test('failed browser preparation leaves a cancellation tombstone instead of an accepted orphan', async t => {
    const env = fixture(t);
    const realSetState = env.registry.setState.bind(env.registry);
    env.registry.setState = async () => { throw new Error('deterministic preparation failure'); };
    const prepare = createPrepareBrowserDownloadHandler({
        intents: env.intents,
        registry: env.registry,
        getDefaults: () => ({ installDir: env.downloadRoot })
    });
    const result = await prepare({ sender: { send() {} } }, {
        webContentsId: 52,
        metadata: { gameName: 'Failed Preparation' }
    });
    env.registry.setState = realSetState;
    assert.equal(result.ok, false);
    const item = browserItem();
    let captures = 0;
    createBrowserWillDownloadHandler({
        intents: env.intents,
        isCaptureEnabled: () => true,
        isRegistered: () => true,
        capture: () => { captures += 1; }
    })({}, item, { id: 52 });
    assert.equal(item.cancelled, 1);
    assert.equal(captures, 0);
});

test('unknown browser events fail closed and a stale tombstone cannot bind to a newer intent', async t => {
    const env = fixture(t);
    let capturedJob = '';
    const handler = createBrowserWillDownloadHandler({
        intents: env.intents,
        isCaptureEnabled: () => true,
        isRegistered: () => true,
        capture: (_item, _webContentsId, intent) => { capturedJob = intent.job.id; }
    });

    const unknown = browserItem();
    handler({}, unknown, { id: 17 });
    assert.equal(unknown.cancelled, 1);

    const oldIntent = env.intents.prepare(17, { gameName: 'Old Intent' });
    await env.registry.setState(oldIntent.job, JOB_STATES.WAITING_BROWSER);
    await env.cancel({}, oldIntent.job.id);
    const newIntent = env.intents.prepare(17, { gameName: 'New Intent' });
    await env.registry.setState(newIntent.job, JOB_STATES.WAITING_BROWSER);

    const staleEvent = browserItem();
    handler({}, staleEvent, { id: 17 });
    assert.equal(staleEvent.cancelled, 1);
    assert.equal(capturedJob, '');

    const newEvent = browserItem();
    handler({}, newEvent, { id: 17 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(newEvent.cancelled, 0);
    assert.equal(capturedJob, newIntent.job.id);
});

test('browser intent tombstones are bounded and expire without resurrecting jobs', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-browser-tombstones-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const registry = new DownloadJobDirectoryRegistry();
    let now = 1000;
    const intents = new BrowserDownloadIntentRegistry({
        beginJob: (id, options) => registry.begin(id, Object.assign({ defaultRoot: path.join(root, 'downloads') }, options)),
        tombstoneTtlMs: 1000,
        maxIntents: 8,
        now: () => now
    });
    const first = intents.prepare(1, { gameName: 'First' });
    intents.cancelJob(first.job.id);
    for (let id = 2; id <= 8; id++) {
        const intent = intents.prepare(id, { gameName: `Intent ${id}` });
        intents.cancelJob(intent.job.id);
    }
    assert.ok(intents.byJob.size <= 8);
    const ninth = intents.prepare(9, { gameName: 'Ninth' });
    assert.ok(intents.byJob.size <= 8);
    assert.equal(intents.getForJob(first.job.id), null);
    now += 1001;
    assert.equal(intents.getForJob(ninth.job.id), null);
    const late = browserItem();
    createBrowserWillDownloadHandler({
        intents,
        isCaptureEnabled: () => true,
        isRegistered: () => true,
        capture: () => assert.fail('Expired browser intent was resurrected.')
    })({}, late, { id: 9 });
    assert.equal(late.cancelled, 1);
});

test('cancellation waits for the exact production-owned child process before quarantine', async t => {
    const env = fixture(t);
    const job = env.registry.begin('controlled-child', { gameName: 'Controlled Child', defaultRoot: env.downloadRoot });
    await env.registry.ensureDirectory(job);
    fs.writeFileSync(path.join(job.directory, 'sentinel.bin'), 'owned');
    const coordinator = createDownloadWorkCoordinator(env.registry);
    let started;
    const startedPromise = new Promise(resolve => { started = resolve; });

    const workPromise = coordinator.run(job, { type: 'post-processing', state: JOB_STATES.POST_PROCESSING }, async work => {
        started();
        await runOwnedChildProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], work);
    }).catch(error => error);
    await startedPromise;
    await waitUntil(() => !!job.activeOperation, 'owned child registration');

    const result = await env.cancel({}, job.id);
    assert.equal(result.status, CANCELLATION_STATUSES.PENDING);
    assert.equal(job.state, JOB_STATES.CANCELLATION_PENDING);
    assert.equal(fs.existsSync(job.directory), true);
    assert.equal(job.quarantinePath, '');

    await workPromise;
    await waitUntil(() => job.state === JOB_STATES.CANCELLED_QUARANTINED, 'quarantine after child exit');
    await waitUntil(() => env.outcomes.length > 0, 'cancellation outcome notification');
    assert.equal(fs.existsSync(job.directory), false);
    assert.equal(fs.readFileSync(path.join(job.quarantinePath, 'sentinel.bin'), 'utf8'), 'owned');
    assert.equal(env.outcomes.at(-1).status, CANCELLATION_STATUSES.QUARANTINED);
});

test('a delayed owned stop remains cancellation_pending and cannot quarantine early', async t => {
    const env = fixture(t);
    const job = env.registry.begin('delayed-stop', { gameName: 'Delayed Stop', defaultRoot: env.downloadRoot });
    await env.registry.ensureDirectory(job);
    const coordinator = createDownloadWorkCoordinator(env.registry);
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let stopRequested = false;
    const work = coordinator.run(job, {
        type: 'post-processing',
        state: JOB_STATES.POST_PROCESSING,
        stop: () => { stopRequested = true; }
    }, async context => {
        await barrier;
        await context.checkpoint();
    }).catch(error => error);
    await waitUntil(() => !!job.activeOperation, 'delayed owned work');
    const pending = await env.cancel({}, job.id);
    assert.equal(pending.status, CANCELLATION_STATUSES.PENDING);
    const repeatedPending = await env.cancel({}, job.id);
    assert.equal(repeatedPending.status, CANCELLATION_STATUSES.PENDING);
    assert.equal(repeatedPending.reason, pending.reason);
    assert.equal(cancellationPresentation(repeatedPending).completed, false);
    assert.equal(stopRequested, true);
    assert.equal(job.quarantinePath, '');
    assert.equal(fs.existsSync(job.directory), true);
    release();
    await work;
    await waitUntil(() => job.state === JOB_STATES.CANCELLED_QUARANTINED, 'delayed stop reconciliation');
});

test('installer launch gate prevents stale launch and running external installer is truthfully refused', async t => {
    const env = fixture(t);
    const coordinator = createDownloadWorkCoordinator(env.registry);

    const preLaunch = env.registry.begin('pre-launch', { gameName: 'Pre Launch', defaultRoot: env.downloadRoot });
    await env.registry.ensureDirectory(preLaunch);
    let releasePreLaunch;
    const preLaunchBarrier = new Promise(resolve => { releasePreLaunch = resolve; });
    let launched = false;
    const preLaunchWork = coordinator.run(preLaunch, { type: 'installer', state: JOB_STATES.LAUNCHING_INSTALLER }, async work => {
        await work.setStop(releasePreLaunch);
        await preLaunchBarrier;
        await work.checkpoint();
        launched = true;
        await work.markInstallerRunning();
    }).catch(error => error);
    await waitUntil(() => !!preLaunch.activeOperation, 'pre-launch operation');
    assert.equal((await env.cancel({}, preLaunch.id)).status, CANCELLATION_STATUSES.PENDING);
    await preLaunchWork;
    assert.equal(launched, false);
    await waitUntil(() => preLaunch.state === JOB_STATES.CANCELLED_QUARANTINED, 'pre-launch cancellation');

    const running = env.registry.begin('installer-running', { gameName: 'Installer Running', defaultRoot: env.downloadRoot });
    await env.registry.ensureDirectory(running);
    let installerExit;
    const installerBarrier = new Promise(resolve => { installerExit = resolve; });
    let runningReady;
    const runningReadyPromise = new Promise(resolve => { runningReady = resolve; });
    const runningWork = coordinator.run(running, { type: 'installer', state: JOB_STATES.LAUNCHING_INSTALLER }, async work => {
        await work.markInstallerRunning();
        runningReady();
        await installerBarrier;
        await work.markInstallerExited();
        await work.checkpoint();
    }).catch(error => error);
    await runningReadyPromise;
    const refused = await env.cancel({}, running.id);
    assert.equal(refused.status, CANCELLATION_STATUSES.REFUSED_INSTALLER_RUNNING);
    const repeatedRefusal = await env.cancel({}, running.id);
    assert.equal(repeatedRefusal.status, CANCELLATION_STATUSES.REFUSED_INSTALLER_RUNNING);
    assert.equal(repeatedRefusal.reason, refused.reason);
    assert.match(cancellationPresentation(refused).message, /external installer is already running/i);
    assert.equal(cancellationPresentation(repeatedRefusal).completed, false);
    assert.equal(fs.existsSync(running.directory), true);
    installerExit();
    await runningWork;
    await waitUntil(() => running.state === JOB_STATES.CANCELLED_QUARANTINED, 'installer exit reconciliation');
});

test('unknown and stale production cancellations never present as successful', async t => {
    const env = fixture(t);
    const unknownResult = await env.cancel({}, 'unknown-job');
    assert.equal(unknownResult.status, CANCELLATION_STATUSES.REFUSED_UNKNOWN_JOB);
    const unknown = cancellationPresentation(unknownResult);
    assert.equal(unknown.title, 'Cancellation not completed');
    assert.equal(unknown.completed, false);
    assert.doesNotMatch(unknown.message, /^Download cancelled/i);

    const staleJob = env.registry.begin('completed-job', { gameName: 'Completed Job', defaultRoot: env.downloadRoot });
    const continuation = await env.registry.beginAttempt(staleJob);
    await env.registry.ensureDirectory(continuation);
    await env.registry.publish(continuation);
    const staleResult = await env.cancel({}, staleJob.id);
    assert.equal(staleResult.status, CANCELLATION_STATUSES.REFUSED_UNKNOWN_JOB);
    assert.equal(cancellationPresentation(staleResult).completed, false);

    const pending = cancellationPresentation({ status: CANCELLATION_STATUSES.PENDING });
    assert.equal(pending.title, 'Cancellation pending');
    assert.equal(pending.completed, false);
    assert.match(pending.message, /waiting for active download work to stop safely/i);
});

test('cleanup refusal remains sticky through the real IPC handler and presenter', async t => {
    const env = fixture(t);
    const job = env.registry.begin('sticky-refusal', { gameName: 'Sticky Refusal', defaultRoot: env.downloadRoot });
    await env.registry.ensureDirectory(job);
    await env.registry.setState(job, JOB_STATES.DOWNLOADING);
    fs.rmSync(job.directory, { recursive: true, force: true });
    fs.mkdirSync(job.directory);
    const replacementSentinel = path.join(job.directory, 'replacement.txt');
    fs.writeFileSync(replacementSentinel, 'keep');

    const first = await env.cancel({}, job.id);
    const second = await env.cancel({}, job.id);
    assert.equal(first.status, CANCELLATION_STATUSES.REFUSED);
    assert.equal(second.status, CANCELLATION_STATUSES.REFUSED);
    assert.equal(first.reason, 'identity-mismatch');
    assert.equal(second.reason, first.reason);
    assert.deepEqual(job.cancellationOutcome, {
        status: CANCELLATION_STATUSES.REFUSED,
        retryable: false,
        retained: true,
        reason: 'identity-mismatch'
    });
    assert.equal(cancellationPresentation(first).completed, false);
    assert.equal(cancellationPresentation(second).completed, false);
    assert.equal(fs.readFileSync(replacementSentinel, 'utf8'), 'keep');
});

test('only completed clean or quarantined cancellation becomes already_cancelled on repeat', async t => {
    const env = fixture(t);
    const cleanJob = env.registry.begin('repeat-clean', { gameName: 'Repeat Clean', defaultRoot: env.downloadRoot });
    assert.equal((await env.cancel({}, cleanJob.id)).status, CANCELLATION_STATUSES.CLEAN);
    const repeatedClean = await env.cancel({}, cleanJob.id);
    assert.equal(repeatedClean.status, CANCELLATION_STATUSES.ALREADY_CANCELLED);
    assert.equal(cancellationPresentation(repeatedClean).completed, true);

    const retainedJob = env.registry.begin('repeat-retained', { gameName: 'Repeat Retained', defaultRoot: env.downloadRoot });
    await env.registry.ensureDirectory(retainedJob);
    fs.writeFileSync(path.join(retainedJob.directory, 'partial.bin'), 'owned');
    assert.equal((await env.cancel({}, retainedJob.id)).status, CANCELLATION_STATUSES.QUARANTINED);
    const repeatedRetained = await env.cancel({}, retainedJob.id);
    assert.equal(repeatedRetained.status, CANCELLATION_STATUSES.ALREADY_CANCELLED);
    assert.equal(repeatedRetained.retained, true);
    assert.equal(cancellationPresentation(repeatedRetained).completed, true);
});

test('Downloads Manager cancel button keeps incomplete rows and removes only presenter-completed rows', async () => {
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const cancelSource = rendererFunctionSource(renderer, 'window.cancelDownload = function (id)');
    const reducerSource = rendererFunctionSource(renderer, 'function applyDownloadCancellationOutcome(id, result)');
    const actionsSource = rendererFunctionSource(renderer, 'function buildDownloadActions(download, page = false)');

    const id = 'manager-cancel';
    const row = {
        removed: false,
        remove() { this.removed = true; }
    };
    const dlQueue = new Map();
    const responses = [];
    const alerts = [];
    let invokeCount = 0;
    const context = {
        dlQueue,
        dlBulkRetryQueue: [],
        document: {},
        SafeDom: {
            element(_document, tagName, options = {}) {
                return {
                    tagName,
                    textContent: options.text || '',
                    children: [],
                    listeners: {},
                    append(...children) { this.children.push(...children); },
                    addEventListener(type, listener) { this.listeners[type] = listener; }
                };
            }
        },
        DownloadQuarantineUi: require('../ui/downloadQuarantine'),
        ipcRenderer: {
            invoke: async () => {
                invokeCount += 1;
                const next = responses.shift();
                if (next instanceof Error) throw next;
                return next;
            }
        },
        pumpBulkDownloadRetry() {},
        refreshDownloadQuarantine: async () => null,
        renderDock() {
            if (!dlQueue.has(id)) row.remove();
        },
        sailAlert: async (message, options) => { alerts.push({ message, options }); }
    };
    context.window = context;
    vm.runInNewContext(`${reducerSource}\n${cancelSource}\n${actionsSource}`, context, {
        filename: 'index.html:downloads-manager-cancel'
    });
    const actions = context.buildDownloadActions({ id, state: 'downloading' }, false);
    const button = actions.children.find(child => child.textContent === 'Cancel');
    assert.ok(button, 'Missing production Downloads Manager cancel button.');
    assert.equal(typeof button.listeners.click, 'function', 'Missing production Downloads Manager cancel-button binding.');

    function reset(state = 'downloading') {
        row.removed = false;
        dlQueue.set(id, { id, state, label: 'Downloading' });
    }

    reset();
    responses.push(
        { status: 'cleanup_refused', retained: true, reason: 'identity-mismatch' },
        { status: 'cleanup_refused', retained: true, reason: 'identity-mismatch' }
    );
    await button.listeners.click();
    assert.equal(row.removed, false);
    assert.equal(dlQueue.get(id).state, 'cancellation_refused');
    await button.listeners.click();
    assert.equal(row.removed, false);

    reset();
    responses.push({ status: 'cancellation_pending', retained: true, reason: 'owned-work-active' });
    await button.listeners.click();
    assert.equal(row.removed, false);
    assert.equal(dlQueue.get(id).state, 'cancellation_pending');

    reset();
    responses.push({ status: 'cancellation_refused_installer_running', retained: true, reason: 'installer-running' });
    await button.listeners.click();
    assert.equal(row.removed, false);
    assert.equal(dlQueue.get(id).state, 'installer_running');

    reset();
    responses.push({ status: 'cancellation_refused_unknown_job', retained: null, reason: 'unknown-job' });
    await button.listeners.click();
    assert.equal(row.removed, false);
    assert.equal(dlQueue.get(id).state, 'downloading');

    reset();
    responses.push(new Error('IPC unavailable'));
    await button.listeners.click();
    assert.equal(row.removed, false);
    assert.equal(dlQueue.get(id).state, 'downloading');
    assert.equal(typeof button.listeners.click, 'function');
    assert.equal(alerts.at(-1).options.title, 'Cancellation status unavailable');
    assert.doesNotMatch(alerts.at(-1).message, /^Download cancelled/i);

    reset();
    responses.push({ status: 'cancelled_clean', retained: false });
    await button.listeners.click();
    assert.equal(row.removed, true);
    assert.equal(dlQueue.has(id), false);

    reset();
    responses.push({ status: 'cancelled_quarantined', retained: true });
    await button.listeners.click();
    assert.equal(row.removed, true);
    assert.equal(dlQueue.has(id), false);

    responses.push({ status: 'already_cancelled', retained: true });
    await button.listeners.click();
    assert.equal(row.removed, true);
    assert.equal(dlQueue.has(id), false);
    assert.equal(invokeCount, 9);
});

test('new attempts invalidate every stale callback from the older generation', async t => {
    const env = fixture(t);
    const job = env.registry.begin('attempt-generation', { gameName: 'Attempt Generation', defaultRoot: env.downloadRoot });
    const first = await env.registry.beginAttempt(job);
    await env.registry.setState(first, JOB_STATES.PREPARING);
    const second = await env.registry.beginAttempt(job);
    await assert.rejects(env.registry.setState(first, JOB_STATES.DOWNLOADING), /older attempt/i);
    await env.registry.setState(second, JOB_STATES.DOWNLOADING);
    await env.cancel({}, job.id);
    await assert.rejects(env.registry.publish(second), /invalidated|terminal/i);
});

test('committed cancellation wins the real publish barrier and final destination is never created', async t => {
    let releasePublish;
    let publishReached;
    const publishBarrier = new Promise(resolve => { releasePublish = resolve; });
    const publishReachedPromise = new Promise(resolve => { publishReached = resolve; });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-publish-race-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const registry = new DownloadJobDirectoryRegistry({
        hooks: {
            beforePublishRename: async () => {
                publishReached();
                await publishBarrier;
            }
        }
    });
    const activeDownloads = new Map();
    const cancel = createDownloadCancellationHandler({
        registry,
        activeDownloads,
        pendingBrowserDownloads: new Map(),
        retryDelays: []
    });
    const job = registry.begin('publish-race', { gameName: 'Publish Race', defaultRoot: path.join(root, 'downloads') });
    const continuation = await registry.beginAttempt(job);
    await registry.ensureDirectory(continuation);
    fs.writeFileSync(path.join(job.directory, 'payload.bin'), 'owned');

    const publishing = registry.publish(continuation);
    await publishReachedPromise;
    const cancelled = await cancel({}, job.id);
    assert.equal(cancelled.status, CANCELLATION_STATUSES.QUARANTINED);
    releasePublish();
    await assert.rejects(publishing, /invalidated|terminal/i);
    assert.equal(fs.existsSync(job.finalDirectory), false);
    assert.equal(fs.readFileSync(path.join(job.quarantinePath, 'payload.bin'), 'utf8'), 'owned');
});
