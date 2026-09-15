'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const logic = require(path.join(root, 'ui', 'downloadManagerLogic'));

function loadRetryHarness(overrides = {}) {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const start = html.indexOf('        function discardDebridRetryLink(');
    const end = html.indexOf('\n        function applyDownloadCancellationOutcome(', start);
    assert.ok(start >= 0 && end > start);
    const calls = [];
    const queue = overrides.queue || new Map();
    const window = {
        resumeDownload(id, token) {
            calls.push({ type: 'resume', id, token, options: queue.get(id) && queue.get(id).resumeOpts });
        },
        pushDebridConfigToMain() { throw new Error('A direct retry must not change the global connection'); },
        ...(overrides.window || {})
    };
    const context = {
        dlQueue: queue,
        DownloadManagerLogic: logic,
        renderDock: () => calls.push({ type: 'render' }),
        window,
        sailConfirm: overrides.sailConfirm || (async () => true),
        ipcRenderer: { invoke: async (channel, payload) => { calls.push({ type: 'ipc', channel, payload }); } },
        calls
    };
    const functions = vm.runInNewContext(`(() => {\n${html.slice(start, end)}\nreturn { retryDownloadWithoutDebrid };\n})()`, context);
    return { ...functions, queue, calls, context };
}

function failedDownload(overrides = {}) {
    return {
        id: 'dl_retry',
        state: 'error',
        error: 'TorBox rejected the file.',
        debridFailure: true,
        failedDebridService: 'TorBox',
        debridRetryToken: '11223344-1234-1234-1234-112233445566',
        resumeOpts: { id: 'dl_retry', url: 'https://gofile.io/d/game', sourceId: 'steamrip' },
        ...overrides
    };
}

test('debrid retry eligibility and confirmation copy only allow web-host downloads', () => {
    assert.equal(logic.canRetryWithoutDebrid(failedDownload()), true);
    assert.equal(logic.canRetryWithoutDebrid(failedDownload({ resumeOpts: { url: 'magnet:?xt=urn:btih:ABC' } })), false);
    assert.equal(logic.canRetryWithoutDebrid(failedDownload({ resumeOpts: { url: 'https://1337x.to/torrent' } })), false);
    assert.equal(logic.canRetryWithoutDebrid(failedDownload({ resumeOpts: { url: 'https://host/game.torrent' } })), false);
    assert.equal(logic.canRetryWithoutDebrid(failedDownload({ debridFailure: false })), false);
    assert.equal(logic.canRetryWithoutDebrid(failedDownload({ state: 'downloading' })), false);
    assert.equal(logic.canRetryWithoutDebrid(failedDownload({ resumeOpts: { url: 'https://host/game.zip', skipDebrid: true } })), false);
    assert.match(logic.debridRetryMessage(failedDownload()), /TorBox/);
    assert.match(logic.debridRetryMessage(failedDownload()), /only to this download/i);
    assert.doesNotMatch(logic.debridRetryMessage(failedDownload()), /not Sail's downloader/);
    assert.match(logic.debridRetryMessage(failedDownload({ debridRejected: true })), /not Sail's downloader/);
});

test('the main request boundary accepts only an explicit boolean debrid override', () => {
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const section = (start, end) => main.slice(main.indexOf(start), main.indexOf(end, main.indexOf(start)));
    const normalizeJson = vm.runInNewContext(`(() => {
        ${section('function exactGateAPayload(', "ipcMain.handle('launch-game'")}
        ${section('function boundedDownloadText(', "ipcMain.handle('download-game'")}
        return input => normalizeDownloadRequest(JSON.parse(input));
    })()`, { URL });
    const normalize = input => normalizeJson(JSON.stringify(input));
    const input = { id: 'fixture', gameName: 'Example', url: 'https://host.example/file.zip' };
    assert.equal(normalize(input).skipDebrid, false);
    assert.equal(normalize({ ...input, skipDebrid: true }).skipDebrid, true);
    assert.equal(normalize({ ...input, skipDebrid: false }).skipDebrid, false);
    for (const skipDebrid of ['true', 1, null, {}]) assert.throws(() => normalize({ ...input, skipDebrid }), /debrid preference is invalid/);
    const token = '11223344-1234-1234-1234-112233445566';
    assert.equal(normalize({ ...input, skipDebrid: true, debridRetryToken: token }).debridRetryToken, token);
    assert.throws(() => normalize({ ...input, debridRetryToken: token }), /direct retry reference is invalid/);
    assert.throws(() => normalize({ ...input, skipDebrid: true, debridRetryToken: 'https://gofile.io/d/private' }), /direct retry reference is invalid/);
    assert.throws(() => normalize({ ...input, debridRetryUrl: 'https://gofile.io/d/private' }), /not allowed/);
});

test('accepted retry clones skipDebrid options and leaves the original request and connection unchanged', async () => {
    const original = failedDownload();
    const originalOptions = original.resumeOpts;
    const queue = new Map([[original.id, original]]);
    let resolveConfirmation;
    const harness = loadRetryHarness({
        queue,
        sailConfirm: () => new Promise(resolve => { resolveConfirmation = resolve; })
    });
    const task = harness.retryDownloadWithoutDebrid(original.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.calls.filter(call => call.type === 'resume').length, 0);
    assert.equal(original._debridRetryPending, true);
    resolveConfirmation(true);
    await task;
    const resumed = harness.calls.find(call => call.type === 'resume');
    assert.equal(resumed.id, original.id);
    assert.equal(resumed.options.skipDebrid, true);
    assert.equal(resumed.token, '11223344-1234-1234-1234-112233445566');
    assert.equal(resumed.options.debridRetryToken, undefined);
    assert.equal(original.debridRetryToken, undefined);
    assert.notEqual(resumed.options, originalOptions);
    assert.equal(originalOptions.skipDebrid, undefined);
    assert.equal(original.resumeOpts.skipDebrid, true);
    assert.equal(original._debridRetryPending, false);
});

test('cancelled confirmation preserves request settings and discards the temporary link', async () => {
    for (const sailConfirm of [async () => false, async () => undefined]) {
        const original = failedDownload();
        const before = original.resumeOpts;
        const harness = loadRetryHarness({ queue: new Map([[original.id, original]]), sailConfirm });
        await harness.retryDownloadWithoutDebrid(original.id);
        assert.equal(harness.calls.some(call => call.type === 'resume'), false);
        assert.equal(original.resumeOpts, before);
        assert.equal(original._debridRetryPending, false);
        assert.equal(original.debridRetryToken, undefined);
        const discarded = harness.calls.find(call => call.channel === 'discard-debrid-retry-link');
        assert.equal(discarded.payload.token, '11223344-1234-1234-1234-112233445566');
    }
});

test('a second click while confirmation is pending does not open or start another retry', async () => {
    const original = failedDownload();
    let confirmations = 0;
    let resolveConfirmation;
    const harness = loadRetryHarness({
        queue: new Map([[original.id, original]]),
        sailConfirm: () => {
            confirmations++;
            return new Promise(resolve => { resolveConfirmation = resolve; });
        }
    });
    const first = harness.retryDownloadWithoutDebrid(original.id);
    const second = harness.retryDownloadWithoutDebrid(original.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(confirmations, 1);
    resolveConfirmation(true);
    await Promise.all([first, second]);
    assert.equal(harness.calls.filter(call => call.type === 'resume').length, 1);
});

test('cleared or changed rows are rejected after confirmation becomes available', async () => {
    const mutations = [
        queue => queue.delete('dl_retry'),
        queue => { queue.set('dl_retry', failedDownload()); },
        (queue, download) => { download.state = 'paused'; },
        (queue, download) => { download.resumeOpts = { ...download.resumeOpts, url: 'https://host/replaced.zip' }; },
        (queue, download) => { download.error = 'A newer failure replaced this one.'; },
        (queue, download) => { download.debridRetryToken = '99887766-1234-1234-1234-998877665544'; }
    ];
    for (const mutate of mutations) {
        const original = failedDownload();
        let resolveConfirmation;
        const queue = new Map([[original.id, original]]);
        const harness = loadRetryHarness({
            queue,
            sailConfirm: () => new Promise(resolve => { resolveConfirmation = resolve; })
        });
        const pending = harness.retryDownloadWithoutDebrid(original.id);
        await new Promise(resolve => setImmediate(resolve));
        mutate(queue, original);
        resolveConfirmation(true);
        await pending;
        assert.equal(harness.calls.some(call => call.type === 'resume'), false);
        if (original.debridRetryToken) assert.equal(original.debridRetryToken, '99887766-1234-1234-1234-998877665544');
    }
});

test('a prompt opened without a retained link cannot discard a newer handoff', async () => {
    const original = failedDownload({ debridRetryToken: undefined });
    let confirm;
    const harness = loadRetryHarness({ queue: new Map([[original.id, original]]),
        sailConfirm: () => new Promise(resolve => { confirm = resolve; }) });
    const pending = harness.retryDownloadWithoutDebrid(original.id);
    original.debridRetryToken = '99887766-1234-1234-1234-998877665544';
    confirm(true);
    await pending;
    assert.equal(original.debridRetryToken, '99887766-1234-1234-1234-998877665544');
    assert.equal(harness.calls.some(call => call.type === 'resume' || call.type === 'ipc'), false);
});
