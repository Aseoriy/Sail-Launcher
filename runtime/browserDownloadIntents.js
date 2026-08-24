'use strict';

const crypto = require('node:crypto');

const INTENT_STATES = Object.freeze({
    PENDING: 'pending',
    CANCELLED: 'cancelled',
    ACCEPTED: 'accepted',
    EXPIRED: 'expired',
    COMPLETED: 'completed'
});

const DEFAULT_TOMBSTONE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_INTENTS = 256;

function webContentsKey(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid browser webContents ID is required.');
    return id;
}

class BrowserDownloadIntentRegistry {
    constructor(options = {}) {
        if (typeof options.beginJob !== 'function') throw new TypeError('Browser intents require a production job factory.');
        this.beginJob = options.beginJob;
        this.randomBytes = options.randomBytes || crypto.randomBytes;
        this.now = options.now || Date.now;
        this.tombstoneTtlMs = Math.max(1000, Number(options.tombstoneTtlMs) || DEFAULT_TOMBSTONE_TTL_MS);
        this.maxIntents = Math.max(8, Number(options.maxIntents) || DEFAULT_MAX_INTENTS);
        this.byWebContents = new Map();
        this.byJob = new Map();
    }

    opaqueId(prefix) {
        return `${prefix}_${this.randomBytes(24).toString('hex')}`;
    }

    purge() {
        const now = this.now();
        for (const [webContentsId, queue] of this.byWebContents) {
            const retained = [];
            for (const intent of queue) {
                if (intent.expiresAt > now) retained.push(intent);
                else {
                    intent.state = INTENT_STATES.EXPIRED;
                    this.byJob.delete(intent.job.id);
                }
            }
            if (retained.length) this.byWebContents.set(webContentsId, retained);
            else this.byWebContents.delete(webContentsId);
        }
        if (this.byJob.size < this.maxIntents) return;
        const terminal = [...this.byJob.values()]
            .filter(intent => intent.state !== INTENT_STATES.PENDING && intent.state !== INTENT_STATES.ACCEPTED)
            .sort((a, b) => a.updatedAt - b.updatedAt);
        while (this.byJob.size >= this.maxIntents && terminal.length) {
            const intent = terminal.shift();
            this.byJob.delete(intent.job.id);
            const queue = this.byWebContents.get(intent.webContentsId) || [];
            const retained = queue.filter(candidate => candidate !== intent);
            if (retained.length) this.byWebContents.set(intent.webContentsId, retained);
            else this.byWebContents.delete(intent.webContentsId);
        }
    }

    prepare(webContentsId, options) {
        const key = webContentsKey(webContentsId);
        this.purge();
        const queue = this.byWebContents.get(key) || [];
        const existing = queue.find(intent => intent.state === INTENT_STATES.PENDING || intent.state === INTENT_STATES.ACCEPTED);
        if (existing) {
            throw new Error('A browser download intent is already active for this view.');
        }
        if (this.byJob.size >= this.maxIntents) throw new Error('The browser download intent limit was reached.');

        const now = this.now();
        const jobId = this.opaqueId('browser');
        const job = this.beginJob(jobId, options);
        const intent = {
            id: this.opaqueId('intent'),
            webContentsId: key,
            job,
            options: Object.freeze(Object.assign({}, options, { id: jobId, browserIntentId: undefined })),
            state: INTENT_STATES.PENDING,
            createdAt: now,
            updatedAt: now,
            expiresAt: now + this.tombstoneTtlMs
        };
        queue.push(intent);
        this.byWebContents.set(key, queue);
        this.byJob.set(jobId, intent);
        return intent;
    }

    cancelJob(jobId) {
        this.purge();
        const intent = this.byJob.get(String(jobId || ''));
        if (!intent) return null;
        if (intent.state === INTENT_STATES.COMPLETED || intent.state === INTENT_STATES.EXPIRED) return intent;
        intent.state = INTENT_STATES.CANCELLED;
        intent.updatedAt = this.now();
        intent.expiresAt = intent.updatedAt + this.tombstoneTtlMs;
        return intent;
    }

    claim(webContentsId) {
        const key = webContentsKey(webContentsId);
        this.purge();
        const queue = this.byWebContents.get(key) || [];
        const intent = queue[0] || null;
        if (!intent) return { status: 'unknown', intent: null };
        intent.updatedAt = this.now();
        intent.expiresAt = intent.updatedAt + this.tombstoneTtlMs;
        if (intent.state === INTENT_STATES.CANCELLED) {
            queue.shift();
            if (!queue.length) this.byWebContents.delete(key);
            return { status: 'cancelled', intent };
        }
        if (intent.state !== INTENT_STATES.PENDING) return { status: 'stale', intent };
        intent.state = INTENT_STATES.ACCEPTED;
        return { status: 'accepted', intent };
    }

    complete(intent) {
        if (!intent || this.byJob.get(intent.job.id) !== intent) return false;
        if (intent.state === INTENT_STATES.CANCELLED || intent.state === INTENT_STATES.EXPIRED) return false;
        intent.state = INTENT_STATES.COMPLETED;
        intent.updatedAt = this.now();
        intent.expiresAt = intent.updatedAt + this.tombstoneTtlMs;
        const queue = this.byWebContents.get(intent.webContentsId) || [];
        const retained = queue.filter(candidate => candidate !== intent);
        if (retained.length) this.byWebContents.set(intent.webContentsId, retained);
        else this.byWebContents.delete(intent.webContentsId);
        return true;
    }

    getForJob(jobId) {
        this.purge();
        return this.byJob.get(String(jobId || '')) || null;
    }
}

function cancelBrowserItem(item) {
    try { item.cancel(); } catch (_) {}
}

function createBrowserWillDownloadHandler(options = {}) {
    const intents = options.intents;
    const capture = options.capture;
    const isCaptureEnabled = options.isCaptureEnabled || (() => false);
    const isRegistered = options.isRegistered || (() => false);
    const fallback = options.fallback || ((_event, item) => cancelBrowserItem(item));
    if (!intents || typeof intents.claim !== 'function' || typeof capture !== 'function') {
        throw new TypeError('Browser download handling requires the production intent registry and capture function.');
    }
    return function handleBrowserWillDownload(event, item, webContents) {
        const webContentsId = webContents && webContents.id;
        if (!isCaptureEnabled() || !webContentsId || !isRegistered(webContentsId)) {
            fallback(event, item, webContents);
            return;
        }
        try { item.pause(); } catch (_) {}
        let claim;
        try { claim = intents.claim(webContentsId); } catch (_) { claim = { status: 'unknown', intent: null }; }
        if (claim.status !== 'accepted') {
            cancelBrowserItem(item);
            return;
        }
        Promise.resolve(capture(item, webContentsId, claim.intent)).catch(() => cancelBrowserItem(item));
    };
}

function createPrepareBrowserDownloadHandler(options = {}) {
    const intents = options.intents;
    const registry = options.registry;
    const getDefaults = options.getDefaults || (() => ({}));
    const registerWebContents = options.registerWebContents || (() => {});
    const authorizeOptions = options.authorizeOptions || (async (_event, _payload, prepared) => prepared);
    if (!intents || typeof intents.prepare !== 'function' || !registry || typeof registry.setState !== 'function') {
        throw new TypeError('Browser download preparation requires the production intent and job registries.');
    }
    return async function prepareBrowserDownload(event, payload) {
        payload = payload && typeof payload === 'object' ? payload : {};
        const webContentsId = Number(payload.webContentsId);
        if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return { ok: false };
        const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
        const defaults = getDefaults() || {};
        let preparedOptions = Object.assign({}, defaults, {
            gameName: String(metadata.gameName || '').slice(0, 240),
            image: String(metadata.image || '').slice(0, 4096),
            sourceId: String(metadata.sourceId || 'browser').slice(0, 80),
            url: String(metadata.url || '').slice(0, 8192),
            browserCapture: true
        });
        preparedOptions = await authorizeOptions(event, payload, preparedOptions);
        registerWebContents(webContentsId);
        let intent = null;
        try {
            intent = intents.prepare(webContentsId, preparedOptions);
            intent.continuation = await registry.beginAttempt(intent.job);
            await registry.setState(intent.continuation, 'waiting_browser');
            return { ok: true, intentId: intent.id, jobId: intent.job.id };
        } catch (_) {
            if (intent) {
                intents.cancelJob(intent.job.id);
                try {
                    await registry.requestCancel(intent.job.id);
                    await registry.cleanup(intent.job);
                } catch (_) {}
            }
            try {
                event.sender.send('download-error', {
                    url: preparedOptions.url,
                    needsBrowser: true,
                    error: 'Sail could not prepare this browser download safely.'
                });
            } catch (_) {}
            return { ok: false };
        }
    };
}

module.exports = {
    BrowserDownloadIntentRegistry,
    DEFAULT_MAX_INTENTS,
    DEFAULT_TOMBSTONE_TTL_MS,
    INTENT_STATES,
    createBrowserWillDownloadHandler,
    createPrepareBrowserDownloadHandler
};
