'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { app } = require('electron');

const root = path.join(__dirname, '..');
const asarPath = path.resolve(process.argv[2] || path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar'));
const reportPath = process.argv[3] ? path.resolve(process.argv[3]) : '';

function runWorker(relativePath, workerData) {
    return new Promise((resolve, reject) => {
        const workerPath = path.join(asarPath, relativePath);
        const worker = new Worker(workerPath, { workerData });
        const timer = setTimeout(() => {
            worker.terminate().catch(() => {});
            reject(new Error(`${relativePath} did not respond from the packaged ASAR.`));
        }, 10000);
        worker.once('message', message => {
            clearTimeout(timer);
            worker.terminate().catch(() => {});
            resolve(message);
        });
        worker.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

app.whenReady().then(async () => {
    const preparation = await runWorker('runtime/downloadPreparationWorker.js', {
        operation: 'directory-size',
        dir: path.dirname(asarPath)
    });
    assert.equal(preparation && preparation.ok, true);
    assert.equal(Number.isFinite(preparation.result && preparation.result.bytes), true);
    assert.ok(preparation.result.bytes > 0);

    const archive = await runWorker('runtime/archiveExtractWorker.js', {});
    assert.equal(archive && archive.ok, false);
    assert.match(String(archive && archive.error && archive.error.message), /incomplete extraction request/i);

    const report = {
        asarPath,
        preparationBytes: preparation.result.bytes,
        archiveWorkerLoaded: true
    };
    if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`SAIL_PACKAGED_WORKER_PROBE ${JSON.stringify(report)}`);
    app.exit(0);
}).catch(error => {
    console.error(error);
    app.exit(1);
});
