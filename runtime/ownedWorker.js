'use strict';

const { Worker } = require('node:worker_threads');

function workerError(payload) {
    const info = payload && payload.error || {};
    const error = new Error(String(info.message || 'Owned worker failed.'));
    if (info.name) error.name = String(info.name);
    if (info.code !== undefined) error.code = info.code;
    return error;
}

// Run a worker as an owned download operation.  The stop callback is registered
// before the worker can mutate its target, so cancellation terminates the worker
// and leaves the existing job registry/quarantine flow in charge of cleanup.
async function runOwnedWorker(filename, workerData, work, options = {}) {
    const WorkerImpl = options.Worker || Worker;
    let worker;
    let stopping = false;
    const clearStop = () => Promise.resolve(
        work && typeof work.setStop === 'function' ? work.setStop(null) : undefined
    ).catch(() => {});
    const stop = () => {
        stopping = true;
        if (!worker || typeof worker.terminate !== 'function') return undefined;
        return worker.terminate();
    };

    // Cancellation must own the stop hook before the worker is allowed to start
    // touching the staging directory. Propagate registration failure instead of
    // launching untracked work for a stale or already-cancelled operation.
    if (work && typeof work.setStop === 'function') await work.setStop(stop);
    if (stopping) {
        await clearStop();
        throw new Error('Cancelled');
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearStop().finally(() => callback(value));
        };
        try {
            worker = new WorkerImpl(filename, { workerData });
        } catch (error) {
            finish(reject, error);
            return;
        }
        worker.once('message', message => {
            if (message && message.ok === true) finish(resolve, message.result);
            else finish(reject, workerError(message));
        });
        worker.once('error', error => finish(reject, error));
        worker.once('exit', code => {
            if (settled) return;
            if (stopping) finish(reject, new Error('Cancelled'));
            else if (code !== 0) finish(reject, new Error(`Owned worker exited with code ${code}.`));
            else finish(reject, new Error('Owned worker exited before completing.'));
        });
    });
}

module.exports = { runOwnedWorker };
