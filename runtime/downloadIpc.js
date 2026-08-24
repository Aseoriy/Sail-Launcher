'use strict';

const DEFAULT_CLEANUP_RETRY_DELAYS = Object.freeze([600, 1200, 2400, 4800]);
const CANCELLATION_STATUSES = Object.freeze({
    CLEAN: 'cancelled_clean',
    QUARANTINED: 'cancelled_quarantined',
    ALREADY_CANCELLED: 'already_cancelled',
    REFUSED: 'cleanup_refused',
    PENDING: 'cancellation_pending',
    REFUSED_UNKNOWN_JOB: 'cancellation_refused_unknown_job',
    REFUSED_INSTALLER_RUNNING: 'cancellation_refused_installer_running'
});

function publicOutcome(result) {
    const status = result && Object.values(CANCELLATION_STATUSES).includes(result.status)
        ? result.status
        : CANCELLATION_STATUSES.REFUSED;
    const outcome = {
        status,
        retained: result && typeof result.retained === 'boolean' ? result.retained : null
    };
    const reason = result && typeof result.reason === 'string' ? result.reason.trim() : '';
    if (![
        CANCELLATION_STATUSES.CLEAN,
        CANCELLATION_STATUSES.QUARANTINED,
        CANCELLATION_STATUSES.ALREADY_CANCELLED
    ].includes(status) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reason) && reason.length <= 80) {
        outcome.reason = reason;
    }
    return outcome;
}

function createDownloadCancellationHandler(options) {
    const registry = options && options.registry;
    const activeDownloads = options && options.activeDownloads;
    const pendingBrowserDownloads = options && options.pendingBrowserDownloads;
    const browserIntents = options && options.browserIntents;
    const setTimer = (options && options.setTimeout) || setTimeout;
    const retryDelays = (options && options.retryDelays) || DEFAULT_CLEANUP_RETRY_DELAYS;
    const onCleanupOutcome = (options && options.onCleanupOutcome) || (() => {});
    if (!registry || !activeDownloads || !pendingBrowserDownloads) {
        throw new TypeError('Download cancellation requires the production registry and job maps.');
    }

    async function finalizeRefusal(job, reason) {
        try {
            return await registry.finalizeCleanupRefusal(job, reason);
        } catch (_) {
            return { status: CANCELLATION_STATUSES.REFUSED, retryable: false, reason, retained: true };
        }
    }

    function scheduleRetry(job, index) {
        if (!job || job.cleanupScheduled || job.cleanupFinalized || index >= retryDelays.length) return;
        job.cleanupScheduled = true;
        setTimer(async () => {
            job.cleanupScheduled = false;
            job.cleanupAttempts += 1;
            let result;
            try {
                result = await registry.cleanup(job);
            } catch (_) {
                result = await finalizeRefusal(job, 'cleanup-error');
            }
            if (result.status === CANCELLATION_STATUSES.PENDING && result.retryable && index + 1 < retryDelays.length) {
                scheduleRetry(job, index + 1);
                return;
            }
            if (result.status === CANCELLATION_STATUSES.PENDING) {
                try {
                    result = await registry.finalizeCleanupRefusal(job);
                } catch (_) {
                    result = await finalizeRefusal(job, 'cleanup-error');
                }
            }
            onCleanupOutcome(job, publicOutcome(result));
        }, retryDelays[index]);
    }

    function settleAfterOwnedWork(job, operation) {
        if (!job || !operation || job.cancellationWatcher) return;
        job.cancellationWatcher = Promise.resolve(registry.waitForOperation(operation)).then(async () => {
            let result;
            try {
                job.cleanupAttempts += 1;
                result = await registry.cleanup(job);
            } catch (_) {
                result = await finalizeRefusal(job, 'cleanup-error');
            }
            if (result.status === CANCELLATION_STATUSES.PENDING && result.retryable && retryDelays.length) scheduleRetry(job, 0);
            onCleanupOutcome(job, publicOutcome(result));
        }).finally(() => { job.cancellationWatcher = null; });
    }

    return async function cancelDownload(_event, id) {
        const cancellation = await registry.requestCancel(id);
        if (!cancellation) return publicOutcome({ status: CANCELLATION_STATUSES.REFUSED_UNKNOWN_JOB, reason: 'unknown-job', retained: null });
        const { job, repeated } = cancellation;
        if (repeated) {
            const prior = cancellation.outcome;
            if (prior && (prior.status === CANCELLATION_STATUSES.CLEAN || prior.status === CANCELLATION_STATUSES.QUARANTINED)) {
                return publicOutcome({ status: CANCELLATION_STATUSES.ALREADY_CANCELLED, retained: prior.retained });
            }
            return publicOutcome(prior || { status: CANCELLATION_STATUSES.PENDING, reason: 'cleanup-in-progress', retained: !!job.createdDirectory });
        }

        const active = activeDownloads.get(id);
        const control = active || job.control;
        if (control) {
            control.cancelled = true;
        }
        if (active) activeDownloads.delete(id);
        if (browserIntents && typeof browserIntents.cancelJob === 'function') browserIntents.cancelJob(job.id);
        if (typeof cancellation.stop === 'function') {
            try { cancellation.stop(); } catch (_) {}
        }
        if (cancellation.pending && job.activeOperation) {
            const operation = job.activeOperation;
            settleAfterOwnedWork(job, operation);
            return publicOutcome(cancellation.outcome);
        }

        job.cleanupAttempts += 1;
        let result;
        try {
            result = await registry.cleanup(job);
        } catch (_) {
            result = await finalizeRefusal(job, 'cleanup-error');
        }
        if (result.status === CANCELLATION_STATUSES.PENDING && result.retryable && retryDelays.length) scheduleRetry(job, 0);
        return publicOutcome(result);
    };
}

function registerDownloadCancellationIpc(ipcMain, options) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('An IPC registrar is required.');
    const handler = createDownloadCancellationHandler(options);
    ipcMain.handle('cancel-download', handler);
    return handler;
}

module.exports = {
    CANCELLATION_STATUSES,
    DEFAULT_CLEANUP_RETRY_DELAYS,
    createDownloadCancellationHandler,
    publicOutcome,
    registerDownloadCancellationIpc
};
