'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DownloadSourceLogic = require('../ui/downloadSourceLogic');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function source(start, end) {
    const from = html.indexOf(start);
    const to = html.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return html.slice(from, to);
}

function healthHarness(extra = {}) {
    return vm.runInNewContext(`(() => {
        ${source('const downloadLinkHealthRequests = new Map()', 'function configurePrimaryDownloadButton(')}
        return { targets: downloadSetHealthTargets, presentation: downloadHealthPresentation,
            request: requestDownloadLinkHealth, check: checkDownloadHealthTarget,
            pending: downloadLinkHealthRequests,
            setUpdate(callback) { updateDownloadLinkHealth = callback; },
            navigate() { dlDetailToken++; } };
    })()`, {
        DownloadSourceLogic, downloadLinkHealthState: new Map(), dlDetailToken: 1,
        queueMicrotask, setTimeout, clearTimeout, ...extra
    });
}

test('multipart checks show progress and never label a partially checked mirror available', () => {
    const states = new Map();
    const harness = healthHarness({ downloadLinkHealthState: states });
    const keys = Array.from({ length: 259 }, (_, n) => String(n));
    const indicator = { _downloadHealthKeys: keys };
    assert.match(harness.presentation(indicator).text, /0\/259 checked/);
    keys.slice(0, 100).forEach(key => states.set(key, { status: 'available' }));
    assert.equal(harness.presentation(indicator).status, 'checking');
    assert.match(harness.presentation(indicator).text, /100\/259 checked/);
    keys.slice(100).forEach(key => states.set(key, { status: 'available' }));
    assert.equal(harness.presentation(indicator).status, 'available');
    states.set('258', { status: 'unknown', reason: 'health-check-timeout' });
    assert.equal(harness.presentation(indicator).status, 'unknown');
    assert.match(harness.presentation(indicator).text, /259\/259 checked · 1 unconfirmed/);
    states.delete('0');
    states.set('258', { status: 'down' });
    assert.equal(harness.presentation(indicator).status, 'down');
});

test('all 777 FitGirl mirror links finish with four concurrent checks and per-mirror priority', async () => {
    const calls = [];
    const states = new Map();
    let active = 0, peak = 0, completed;
    const finished = new Promise(resolve => { completed = resolve; });
    const harness = healthHarness({
        downloadLinkHealthState: states,
        ipcRenderer: { invoke: async (_channel, target) => {
            calls.push(target.url);
            peak = Math.max(peak, ++active);
            await new Promise(resolve => setImmediate(resolve));
            active--;
            return { status: 'available' };
        } }
    });
    harness.setUpdate((url, sourceId, value) => {
        states.set(sourceId + '\n' + url, { ...value, checkedAt: Date.now() });
        if (states.size === 777) setImmediate(completed);
    });
    for (const host of ['filekeeper.net', 'fuckingfast.co', 'datanodes.to']) {
        const set = { kind: 'http', parts: Array.from({ length: 259 }, (_, n) => ({ url: `https://${host}/part${n}` })) };
        harness.targets(set, 'fitgirl').forEach(harness.request);
    }
    await finished;
    assert.equal(calls.length, 777);
    assert.equal(peak, 4);
    assert.equal(harness.pending.size, 0);
    assert.deepEqual(calls.slice(0, 3), ['https://filekeeper.net/part0', 'https://fuckingfast.co/part0', 'https://datanodes.to/part0']);
});

test('navigation drops queued checks from the old game', async () => {
    let calls = 0;
    const harness = healthHarness({ ipcRenderer: { invoke: async () => { calls++; return {}; } } });
    harness.targets({ kind: 'http', parts: [{ url: 'https://filekeeper.net/file' }] }, 'fitgirl').forEach(harness.request);
    harness.navigate();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.equal(harness.pending.size, 0);
});

test('a stalled IPC check settles as unknown and ignores its late answer', async () => {
    let expire, answer, cleared = false;
    const harness = healthHarness({
        ipcRenderer: { invoke: () => new Promise(resolve => { answer = resolve; }) },
        setTimeout(callback, ms) { assert.equal(ms, 20000); expire = callback; return 1; },
        clearTimeout() { cleared = true; }
    });
    const pending = harness.check({ url: 'https://filekeeper.net/file', sourceId: 'fitgirl' });
    expire();
    const value = await pending;
    assert.equal(value.status, 'unknown');
    assert.equal(value.reason, 'health-check-timeout');
    assert.equal(cleared, true);
    answer({ status: 'available' });
    assert.equal(value.status, 'unknown');
});

test('FitGirl primary button uses the torrent immediately and is stable through mirror updates', () => {
    const magnet = { kind: 'magnet', host: 'Magnet / Torrent', group: 'game', parts: [{ url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' }] };
    const direct = { kind: 'http', host: 'filekeeper.net', group: 'game', parts: [{ url: 'https://filekeeper.net/file' }] };
    const element = () => ({ dataset: {}, removeAttribute() {} });
    const primaryUi = { button: element(), health: element(), size: element(), heading: element(), rows: [{ _downloadSet: magnet }, { _downloadSet: direct }] };
    const state = { id: 'fitgirl', item: { url: 'https://fitgirl-repacks.site/example/' }, sets: [direct, magnet], primaryUi };
    const values = new Map();
    let selected;
    const refresh = vm.runInNewContext(`(() => {
        ${source('function configurePrimaryDownloadButton(', 'function offlineDownloadTarget(')}
        return refreshPrimaryDownloadChoice;
    })()`, {
        dlCurrent: state, DownloadSourceLogic, downloadLinkHealthState: values,
        downloadLinkHealthKey: url => url,
        downloadSetHealthTargets: set => set.kind === 'magnet' ? [] : [{ key: set.parts[0].url }],
        dlSetHostLabel: set => set.host,
        isCFBlockedHost: () => false, restrictedDownloadsEnabled: () => false,
        renderDownloadSetSize() {}, renderDownloadHealthIndicator() {},
        startGameDownloadSet: (_item, set) => { selected = set; }
    });
    for (const status of [null, 'checking', 'available', 'down']) {
        if (status) values.set(direct.parts[0].url, { status });
        refresh();
        assert.equal(primaryUi.button.disabled, false);
        assert.match(primaryUi.button.textContent, /1-Click.*Magnet \/ Torrent/);
        primaryUi.button.onclick();
        assert.equal(selected, magnet);
        assert.equal(primaryUi.rows[0].hidden, true);
        assert.equal(primaryUi.rows[1].hidden, false);
    }
    state.sets = [direct];
    refresh();
    assert.equal(primaryUi.button.disabled, true);
    assert.match(primaryUi.button.textContent, /No magnet \/ torrent found/);
});
