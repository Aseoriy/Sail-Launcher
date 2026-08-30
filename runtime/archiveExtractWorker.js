'use strict';

// This file is executed in a worker thread by ownedWorker.js.  Keep the worker
// boundary deliberately small: main.js remains responsible for validating the
// staging/extraction paths and the worker only performs the RAR operation it is
// given.  node-unrar-js consumes the archive synchronously, so doing that work
// here prevents a large RAR from blocking Electron's main event loop.
const { parentPort, workerData } = require('node:worker_threads');
const unrar = require('node-unrar-js');

(async () => {
    try {
        const archivePath = String(workerData && workerData.archivePath || '');
        const targetPath = String(workerData && workerData.targetPath || '');
        if (!archivePath || !targetPath) throw new Error('RAR worker received an incomplete extraction request.');

        const extractor = await unrar.createExtractorFromFile({ filepath: archivePath, targetPath });
        const result = extractor.extract();
        let count = 0;
        // The iterator performs the actual extraction as it is consumed.
        for (const _file of result.files) count += 1;
        if (!count) throw new Error('node-unrar-js extracted 0 files (archive empty or split-volume missing parts)');
        parentPort.postMessage({ ok: true, result: { count } });
    } catch (error) {
        parentPort.postMessage({
            ok: false,
            error: {
                name: error && error.name || 'Error',
                message: error && error.message || String(error),
                code: error && error.code
            }
        });
    }
})();
