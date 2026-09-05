'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('node:vm');
const DownloadSizeLogic = require('../ui/downloadSizeLogic');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(name, nextMarker) {
    const plain = source.indexOf(`function ${name}`);
    const asyncStart = source.indexOf(`async function ${name}`);
    const start = asyncStart >= 0 && (plain < 0 || asyncStart < plain) ? asyncStart : plain;
    assert.ok(start >= 0, `${name} is present`);
    const end = source.indexOf(nextMarker, start);
    assert.ok(end > start, `${name} has a bounded body`);
    return source.slice(start, end).trim();
}

function loadFunction(name, nextMarker, context = {}) {
    return vm.runInNewContext(`(${extractFunction(name, nextMarker)})`, context);
}

test('download requests carry only a full-game expected size baseline', () => {
    assert.match(source, /reportedDownloadBytes:\s*reportedDownloadSizeForSet\(/);
    assert.match(source, /set\.group === 'languages' \|\| set\.partLabel/);
    assert.match(source, /DownloadSizeLogic\.downloadSizeBytes\(source\)/);
    assert.match(source, /DownloadSizeLogic\.downloadSizeBytes\(size\)/);

    const logic = { downloadSizeBytes: value => value && Number(value.bytes) > 0 ? Number(value.bytes) : null };
    const sizes = new Map([
        ['source', { bytes: 900 }], ['small', { bytes: 200 }], ['large', { bytes: 1200 }]
    ]);
    const setSize = set => sizes.get(set.key) || null;
    const sourceSize = set => set.source ? sizes.get('source') : null;
    const full = { key: 'small' };
    const larger = { key: 'large' };
    const language = { key: 'large', group: 'languages' };
    const partial = { key: 'large', partLabel: 'Part 1' };
    const ctx = { id: 'game', item: { url: 'https://example.test/game' }, meta: {} };
    ctx.sets = [full, larger, language, partial];
    // Re-load with the selected set list used by the helper.
    const result = vm.runInNewContext(`(${extractFunction('reportedDownloadSizeForSet', '        function downloadSetSizeText')})`, {
        DownloadSizeLogic: logic,
        dlCurrent: ctx,
        downloadSetSourceSize: sourceSize,
        downloadSetSizeInfo: setSize
    })(full, 'game', ctx.item.url);
    assert.equal(result, 1200);
    assert.equal(vm.runInNewContext(`(${extractFunction('reportedDownloadSizeForSet', '        function downloadSetSizeText')})`, {
        DownloadSizeLogic: logic, dlCurrent: ctx,
        downloadSetSourceSize: sourceSize, downloadSetSizeInfo: setSize
    })(full, 'game', 'https://example.test/other-game'), null);
    assert.equal(vm.runInNewContext(`(${extractFunction('reportedDownloadSizeForSet', '        function downloadSetSizeText')})`, {
        DownloadSizeLogic: logic, dlCurrent: { id: 'other', item: ctx.item, meta: {}, sets: [larger] },
        downloadSetSourceSize: sourceSize, downloadSetSizeInfo: setSize
    })(full, 'game', ctx.item.url), null);
    assert.equal(vm.runInNewContext(`(${extractFunction('reportedDownloadSizeForSet', '        function downloadSetSizeText')})`, {
        DownloadSizeLogic: logic, dlCurrent: { id: 'game', item: ctx.item, meta: {}, sets: [language] },
        downloadSetSourceSize: sourceSize, downloadSetSizeInfo: setSize
    })(language, 'game', ctx.item.url), null);
});

test('size warning confirmation resumes only the unchanged paused download', async () => {
    assert.deepEqual(DownloadSizeLogic.downloadSizeMismatch(1000, 749), { reportedBytes: 1000, actualBytes: 749 });
    assert.equal(DownloadSizeLogic.downloadSizeMismatch(1000, 750), null, '75% is not strictly below the threshold');
    assert.equal(DownloadSizeLogic.downloadSizeMismatch(1000, 500, 500), null, 'approved actual size does not re-prompt');
    assert.match(source, /title: 'Download size warning'/);
    assert.match(source, /confirmText: 'Download anyway'/);
    assert.match(source, /cancelText: 'Keep paused'/);
    assert.match(source, /if \(p\.state === 'paused'\)\s*\{[\s\S]{0,260}d\.retrying = false/);

    const calls = [];
    const d = { id: 'dl-1', state: 'paused', resumeOpts: {} };
    const context = {
        DownloadSizeLogic: { formatBytes: value => `${value} B` },
        dlQueue: { get: id => id === d.id ? d : null },
        sailConfirm: async (message, options) => { calls.push({ message, options }); return true; },
        renderDock: () => calls.push({ rendered: true }),
        window: { resumeDownload: id => { d.state = 'resolving'; calls.push({ resumed: id }); } }
    };
    const handler = loadFunction('handleDownloadSizeWarning', '        window.startGameDownload', context);
    await handler(d, { reportedBytes: 1000, actualBytes: 500 });
    assert.equal(calls[0].options.title, 'Download size warning');
    assert.match(calls[0].message, /^This download is much smaller than the reported game size\. Are you sure you want to download it\? Be careful when downloading games from certain sources, and always double-check the links\./);
    assert.equal(d.resumeOpts.approvedDownloadSizeBytes, 500);
    assert.deepEqual(calls.at(-1), { resumed: 'dl-1' });
    d.state = 'paused';
    await handler(d, { reportedBytes: 1000, actualBytes: 400 });
    assert.equal(calls.filter(item => item.options && item.options.title === 'Download size warning').length, 2);

    const cancelled = { id: 'dl-2', state: 'paused', resumeOpts: {} };
    const cancelledContext = {
        ...context,
        dlQueue: { get: id => id === cancelled.id ? cancelled : null },
        sailConfirm: async () => { cancelled.state = 'cancellation_pending'; return true; },
        window: { resumeDownload: () => calls.push({ badResume: true }) }
    };
    const cancelledHandler = loadFunction('handleDownloadSizeWarning', '        window.startGameDownload', cancelledContext);
    await cancelledHandler(cancelled, { reportedBytes: 1000, actualBytes: 500 });
    assert.equal(cancelled.resumeOpts.approvedDownloadSizeBytes, undefined);
    assert.equal(cancelled._sizeWarningPending, null);
    assert.equal(calls.some(item => item.badResume), false);

    const noResumeOptions = { id: 'dl-3', state: 'paused', resumeOpts: null };
    await handler(noResumeOptions, { reportedBytes: 1000, actualBytes: 500 });
    assert.equal(noResumeOptions._sizeWarningPending, undefined);
});
