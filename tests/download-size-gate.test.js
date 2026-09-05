'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const DownloadSizeLogic = require('../ui/downloadSizeLogic');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
    const start = main.indexOf(startMarker);
    const end = main.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, `Missing production source: ${startMarker}`);
    assert.ok(end > start, `Missing production source boundary: ${endMarker}`);
    return main.slice(start, end).trim();
}

function loadDownloadFunctions() {
    const pause = sourceBetween('function pauseForDownloadSize(', '// Remove a partial file');
    const safeName = sourceBetween('function safeOutName(', 'function pauseForDownloadSize(');
    const runner = sourceBetween('function runAria2Download(', 'function browserBytes(');
    const context = vm.createContext({
        DownloadSizeLogic,
        fs,
        path,
        nodeNet: require('node:net'),
        DL_UA: 'Sail-Test',
        safeOutName: vm.runInContext(`(() => { ${safeName}; return safeOutName; })()`, vm.createContext()),
        console: { warn() {} },
        setTimeout,
        clearTimeout,
        Buffer
    });
    return vm.runInContext(`(() => { ${pause}; ${runner}; return { pauseForDownloadSize, runAria2Download }; })()`, context);
}

class FakeProcess extends EventEmitter {
    constructor() {
        super();
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.killed = false;
    }

    kill() {
        this.killed = true;
    }
}

function startAriaDownload(options = {}) {
    const proc = new FakeProcess();
    const spawn = () => proc;
    const runnerContext = vm.createContext({
        DownloadSizeLogic,
        fs,
        path,
        nodeNet: require('node:net'),
        DL_UA: 'Sail-Test',
        console: { warn() {} },
        setTimeout,
        clearTimeout,
        Buffer,
        spawn
    });
    // Re-evaluate the production runner with the injected process creator. This keeps the
    // production body intact while ensuring no child process or network activity is possible.
    const runner = vm.runInContext(`(() => {
        ${sourceBetween('function safeOutName(', 'function pauseForDownloadSize(')}
        ${sourceBetween('function pauseForDownloadSize(', '// Remove a partial file')}
        ${sourceBetween('function runAria2Download(', 'function browserBytes(')}
        return runAria2Download;
    })()`, runnerContext);
    const ctl = {};
    const promise = runner('aria2-test', { url: 'https://example.invalid/payload.zip', kind: 'http' }, options.dir || path.join(root, 'tests'), options.opts || {}, ctl, options.onProgress || (() => {}));
    return { proc, ctl, promise };
}

const mib = 1024 * 1024;

function progress(total, downloaded = 1, percent = 1) {
    return `[#test ${downloaded}MiB/${total}MiB(${percent}%) DL: ${downloaded}MiB]\n`;
}

test('whole-file transfer below 75 percent is paused before successful completion', async () => {
    const { proc, ctl, promise } = startAriaDownload({
        opts: { checkWholeDownloadSize: true, reportedDownloadBytes: 100 * mib }
    });
    proc.stdout.emit('data', progress(60, 30, 50));
    assert.equal(ctl.paused, true);
    assert.equal(proc.killed, true);
    proc.emit('close', 1);
    await assert.rejects(promise, /Paused/);
    assert.ok(ctl.sizeWarning && ctl.sizeWarning.reportedBytes === 100 * mib);
});

test('exactly 75 percent of the reported whole-file size is allowed', async () => {
    const events = [];
    const { proc, ctl, promise } = startAriaDownload({
        opts: { checkWholeDownloadSize: true, reportedDownloadBytes: 100 * mib },
        onProgress: event => events.push(event)
    });
    proc.stdout.emit('data', progress(75, 75, 100));
    assert.equal(ctl.paused, undefined);
    proc.emit('close', 0);
    await promise;
    assert.equal(events.at(-1).percent, 100);
});

test('approved size accepts the same rounded total but a materially smaller retry warns again', () => {
    const { pauseForDownloadSize } = loadDownloadFunctions();
    const opts = { reportedDownloadBytes: 100 * mib, approvedDownloadSizeBytes: 74 * mib };
    const firstCtl = {};
    assert.equal(pauseForDownloadSize(firstCtl, opts, 74 * mib), false);
    const retryCtl = {};
    assert.equal(pauseForDownloadSize(retryCtl, opts, 60 * mib), true);
    assert.equal(retryCtl.paused, true);
});

test('multipart piece progress does not compare when whole-download checking is disabled', async () => {
    const { proc, ctl, promise } = startAriaDownload({
        opts: { checkWholeDownloadSize: false, reportedDownloadBytes: 100 * mib }
    });
    proc.stdout.emit('data', progress(40, 20, 50));
    assert.equal(ctl.paused, undefined);
    proc.emit('close', 0);
    await promise;
});

test('the production completed-payload check sums all scanned files before post-processing', async () => {
    const handler = sourceBetween("ipcMain.handle('download-game'", "ipcMain.handle('pause-download'");
    const completedCheck = handler.indexOf('if (opts.reportedDownloadBytes)');
    const completedEnd = handler.indexOf('\n\n        if (coverDownload)', completedCheck);
    const postProcess = handler.indexOf('postProcessDownload(continuation, dir, opts)', completedEnd);
    assert.ok(completedCheck >= 0 && completedEnd > completedCheck && postProcess > completedEnd,
        'completed size check must precede preparation');
    const snippet = handler.slice(completedCheck, completedEnd).trim();
    assert.match(snippet, /scanDownloadedPayload\(dir, opts\.gameName, work\)/);
    assert.match(snippet, /pauseForDownloadSize\(ctl, opts, actualBytes\)/);
    const executableSnippet = snippet.replace('const actualBytes =', 'actualBytes =');

    const functions = loadDownloadFunctions();
    const context = vm.createContext({
        DownloadSizeLogic,
        downloadWork: { run: async (_job, _meta, callback) => callback({}) },
        scanDownloadedPayload: async () => context.scanResult,
        pauseForDownloadSize: functions.pauseForDownloadSize,
        Error
    });
    const check = vm.runInContext(`(async function (continuation, opts, ctl, dir) {
        let actualBytes;
        ${executableSnippet}
        return actualBytes;
    })`, context);
    context.scanResult = { files: [{ size: 40 * mib }, { size: 35 * mib }] };
    assert.equal(await check('job', { gameName: 'Example', reportedDownloadBytes: 100 * mib }, {}, 'fixture'), 75 * mib);
    context.scanResult = { files: [{ size: 40 * mib }] };
    const ctl = { proc: { kill() { this.killed = true; } } };
    await assert.rejects(check('job', { gameName: 'Example', reportedDownloadBytes: 100 * mib }, ctl, 'fixture'), /Paused/);
    assert.equal(ctl.paused, true);
    assert.equal(ctl.proc.killed, true);
});

test('normalized requests preserve typed size references and reject invalid values', () => {
    const exact = sourceBetween('function exactGateAPayload(', "ipcMain.handle('launch-game'");
    const bounded = sourceBetween('function boundedDownloadText(', 'function typedDownloadUrl(');
    const typedUrl = sourceBetween('function typedDownloadUrl(', 'function normalizeDownloadRequest(');
    const normalized = sourceBetween('function normalizeDownloadRequest(', "ipcMain.handle('download-game'");
    const context = vm.createContext({
        URL,
        gateAProfileStore: () => { throw new Error('root capability should not be resolved'); }
    });
    vm.runInContext(`(() => {
        ${exact}; ${bounded}; ${typedUrl}; ${normalized};
        globalThis.normalizeDownloadRequest = normalizeDownloadRequest;
    })()`, context);
    const result = vm.runInContext(`normalizeDownloadRequest({
        id: 'size-gate', gameName: 'Example', url: 'https://example.invalid/game.zip',
        reportedDownloadBytes: 1000, approvedDownloadSizeBytes: 800
    })`, context);
    assert.equal(result.reportedDownloadBytes, 1000);
    assert.equal(result.approvedDownloadSizeBytes, 800);
    assert.throws(() => vm.runInContext(`normalizeDownloadRequest({
        id: 'size-gate', gameName: 'Example', url: 'https://example.invalid/game.zip', reportedDownloadBytes: '1000'
    })`, context), /size warning reference is invalid/i);
});
