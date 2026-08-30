'use strict';

const VERIFICATION_STATES = Object.freeze({
    QUEUED: 'queued',
    VERIFYING: 'verifying',
    RESOLVED: 'resolved',
    FAILED: 'failed'
});

class ManagedVerificationCoordinator {
    constructor() {
        this.tail = Promise.resolve();
        this.activeOwner = '';
    }

    run(owner, task, options = {}) {
        const ownerId = String(owner || '').trim();
        if (!ownerId) throw new Error('Managed verification requires an owner.');
        if (typeof task !== 'function') throw new TypeError('Managed verification requires a task.');
        const signal = options && options.signal;
        const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        const throwIfAborted = () => {
            if (signal && signal.aborted) throw abortError();
        };

        const entry = { owner: ownerId, state: VERIFICATION_STATES.QUEUED, started: false };
        const execute = async () => {
            throwIfAborted();
            if (this.activeOwner) throw new Error('Managed verification ownership overlapped.');
            entry.started = true;
            this.activeOwner = ownerId;
            entry.state = VERIFICATION_STATES.VERIFYING;
            try {
                const result = await task(signal);
                entry.state = result ? VERIFICATION_STATES.RESOLVED : VERIFICATION_STATES.FAILED;
                return result;
            } catch (error) {
                entry.state = VERIFICATION_STATES.FAILED;
                throw error;
            } finally {
                this.activeOwner = '';
            }
        };
        const scheduled = this.tail.then(execute, execute);
        this.tail = scheduled.catch(() => null);
        if (!signal) return scheduled;

        // A cancelled item that is still waiting behind another verification must
        // release its download job immediately. Once a browser owns the task, the
        // task itself observes the signal and does not settle until that browser is
        // closed, preserving cancellation/quarantine ordering.
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                callback(value);
            };
            const onAbort = () => {
                if (!entry.started) finish(reject, abortError());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
            scheduled.then(value => finish(resolve, value), error => finish(reject, error));
        });
    }
}

async function resolveSelectedLinksSequentially(links, resolveLink) {
    if (!Array.isArray(links)) throw new TypeError('Selected download links must be an array.');
    if (typeof resolveLink !== 'function') throw new TypeError('Selected download resolution requires a resolver.');
    const resolved = [];
    for (let index = 0; index < links.length; index++) {
        const link = links[index];
        resolved.push({ link, resolved: await resolveLink(link, index) });
    }
    return resolved;
}

function shouldPreservePartialForRetry(file, error) {
    return !!(file && file.resumeAcrossFreshUrl === true)
        && !(error && error.aria2Code === 3);
}

function mergeRefreshedDownload(current, refreshed) {
    const previous = current && typeof current === 'object' ? current : {};
    const next = refreshed && typeof refreshed === 'object' ? refreshed : {};
    const merged = Object.assign({}, previous, next);
    merged.name = previous.name || next.name || '';
    merged.origin = previous.origin || next.origin || '';
    if (Number.isInteger(previous.originIndex)) merged.originIndex = previous.originIndex;
    return merged;
}

module.exports = {
    ManagedVerificationCoordinator,
    VERIFICATION_STATES,
    mergeRefreshedDownload,
    shouldPreservePartialForRetry,
    resolveSelectedLinksSequentially
};
