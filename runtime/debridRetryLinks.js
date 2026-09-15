'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { JOB_STATES } = require('./downloadJobCleanup');

const DEBRID_RETRY_LINK_TTL_MS = 5 * 60 * 1000;

function debridRetryRequestKey(options, scope) {
    return createHash('sha256').update(JSON.stringify([
        scope && scope.profileId || '', scope && scope.libraryId || '',
        options.id, options.gameName, options.sourceId, options.referer || '', options.url || '',
        (options.links || []).map(link => [link.url, link.name || ''])
    ])).digest('hex');
}

function reusableHostLink(value) {
    if (typeof value !== 'string' || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port;
    } catch (_) { return false; }
}

class DebridRetryLinkStore {
    constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.entries = new Map();
        this.owners = new WeakSet();
    }

    remember({ owner, continuation, requestKey, sourceIndex, sourceUrl, url }) {
        const job = continuation && continuation.job;
        if (!owner || owner.isDestroyed && owner.isDestroyed() || !job || job.cancelled || job.cleanupFinalized
            || job.state !== JOB_STATES.RETRYABLE_ERROR || !Number.isSafeInteger(sourceIndex) || sourceIndex < 0
            || continuation.generation !== job.generation || continuation.attemptGeneration !== job.attemptGeneration
            || continuation.cancellationGeneration !== job.cancellationGeneration
            || !reusableHostLink(sourceUrl) || !reusableHostLink(url)) return '';
        this.clearDownload(job.id, owner);
        while (this.entries.size >= 64) this.remove(this.entries.keys().next().value);
        const token = randomUUID();
        const entry = { owner, job, generation: job.generation, attemptGeneration: job.attemptGeneration,
            cancellationGeneration: job.cancellationGeneration, requestKey, sourceIndex, sourceUrl, url,
            expiresAt: this.now() + DEBRID_RETRY_LINK_TTL_MS };
        this.entries.set(token, entry);
        entry.timer = this.setTimer(() => this.remove(token), DEBRID_RETRY_LINK_TTL_MS);
        if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
        if (typeof owner.once === 'function' && !this.owners.has(owner)) {
            this.owners.add(owner);
            owner.once('destroyed', () => this.clearOwner(owner));
        }
        return token;
    }

    consume(token, { owner, job, requestKey }) {
        const entry = this.entries.get(token);
        if (!entry || entry.owner !== owner) return null;
        this.remove(token);
        if (entry.expiresAt <= this.now() || !job || entry.job !== job || job.cancelled || job.cleanupFinalized
            || job.state !== JOB_STATES.RETRYABLE_ERROR || entry.generation !== job.generation
            || entry.attemptGeneration !== job.attemptGeneration || entry.cancellationGeneration !== job.cancellationGeneration
            || entry.requestKey !== requestKey) return null;
        return { sourceIndex: entry.sourceIndex, sourceUrl: entry.sourceUrl, url: entry.url };
    }

    discard(token, owner) {
        const entry = this.entries.get(token);
        if (entry && entry.owner === owner) this.remove(token);
    }

    remove(token) {
        const entry = this.entries.get(token);
        if (!entry) return;
        this.entries.delete(token);
        this.clearTimer(entry.timer);
    }

    clearDownload(id, owner) {
        for (const [token, entry] of this.entries) {
            if (entry.job.id === id && entry.owner === owner) this.remove(token);
        }
    }

    clearOwner(owner) {
        for (const [token, entry] of this.entries) if (entry.owner === owner) this.remove(token);
    }

    clear() {
        for (const token of this.entries.keys()) this.remove(token);
    }
}

module.exports = { DEBRID_RETRY_LINK_TTL_MS, DebridRetryLinkStore, debridRetryRequestKey };
