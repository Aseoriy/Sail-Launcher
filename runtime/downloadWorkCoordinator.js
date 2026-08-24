'use strict';

function createDownloadWorkCoordinator(registry) {
    if (!registry || typeof registry.beginOperation !== 'function') {
        throw new TypeError('Download work coordination requires the production job registry.');
    }

    async function run(continuation, options, work) {
        if (typeof work !== 'function') throw new TypeError('Owned download work requires an implementation.');
        const operation = await registry.beginOperation(continuation, options || {});
        const context = Object.freeze({
            operation,
            checkpoint: () => registry.assertActive(continuation),
            setStop: stop => registry.setOperationStop(operation, stop),
            markInstallerRunning: () => registry.markInstallerRunning(operation),
            markInstallerExited: () => registry.markInstallerExited(operation)
        });
        try {
            await context.checkpoint();
            const result = await work(context);
            await context.checkpoint();
            return result;
        } finally {
            await registry.endOperation(operation);
        }
    }

    return Object.freeze({ run });
}

module.exports = { createDownloadWorkCoordinator };
