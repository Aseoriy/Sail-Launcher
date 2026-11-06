'use strict';

// Runs in a worker thread (ownedWorker.js). main.js checks the paths; this only does the
// RAR extraction so a big RAR doesn't freeze the main process.
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
