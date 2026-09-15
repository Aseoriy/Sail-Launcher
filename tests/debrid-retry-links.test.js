'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
    DEBRID_RETRY_LINK_TTL_MS,
    DebridRetryLinkStore,
    debridRetryRequestKey
} = require('../runtime/debridRetryLinks');
const { JOB_STATES } = require('../runtime/downloadJobCleanup');

class FakeClock {
    constructor() {
        this.time = 1000;
        this.nextId = 1;
        this.timers = new Map();
    }

    now = () => this.time;

    setTimer = (callback, delay) => {
        const timer = { id: this.nextId++, due: this.time + delay, callback };
        this.timers.set(timer.id, timer);
        return timer;
    };

    clearTimer = timer => {
        if (timer) timer.cleared = true;
    };

    advance(milliseconds) {
        this.time += milliseconds;
        for (const timer of [...this.timers.values()]) {
            if (!timer.cleared && timer.due <= this.time) timer.callback();
        }
    }
}

function owner() {
    const value = new EventEmitter();
    value.isDestroyed = () => false;
    return value;
}

function job(id = 'download-1', overrides = {}) {
    return {
        id,
        state: JOB_STATES.RETRYABLE_ERROR,
        cancelled: false,
        cleanupFinalized: false,
        generation: 1,
        attemptGeneration: 1,
        cancellationGeneration: 1,
        ...overrides
    };
}

function continuation(value, overrides = {}) {
    const current = value || job();
    return {
        job: current,
        generation: current.generation,
        attemptGeneration: current.attemptGeneration,
        cancellationGeneration: current.cancellationGeneration,
        ...overrides
    };
}

function remember(store, currentJob, currentOwner = owner(), overrides = {}) {
    return store.remember({
        owner: currentOwner,
        continuation: continuation(currentJob),
        requestKey: 'request-key',
        sourceIndex: 0,
        sourceUrl: 'https://source.example/game.zip',
        url: 'https://host.example/game.zip',
        ...overrides
    });
}

function createStore(clock = new FakeClock()) {
    return {
        clock,
        store: new DebridRetryLinkStore({
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer
        })
    };
}

test('retained links are exact-link, one-use values', () => {
    const { store } = createStore();
    const currentJob = job();
    const currentOwner = owner();
    const token = remember(store, currentJob, currentOwner);
    assert.match(token, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(store.consume(token, {
        owner: currentOwner, job: currentJob, requestKey: 'request-key'
    }), {
        sourceIndex: 0,
        sourceUrl: 'https://source.example/game.zip',
        url: 'https://host.example/game.zip'
    });
    assert.equal(store.consume(token, {
        owner: currentOwner, job: currentJob, requestKey: 'request-key'
    }), null);
});

test('expiry removes entries proactively and rejects expired reads', () => {
    const first = createStore();
    const currentJob = job();
    const currentOwner = owner();
    const token = remember(first.store, currentJob, currentOwner);
    first.clock.advance(DEBRID_RETRY_LINK_TTL_MS);
    assert.equal(first.store.entries.size, 0);
    assert.equal(first.store.consume(token, { owner: currentOwner, job: currentJob, requestKey: 'request-key' }), null);

    const second = createStore();
    const secondJob = job('download-2');
    const secondOwner = owner();
    const expiredToken = remember(second.store, secondJob, secondOwner);
    second.store.setTimer = () => ({ });
    second.clock.time += DEBRID_RETRY_LINK_TTL_MS;
    assert.equal(second.store.consume(expiredToken, { owner: secondOwner, job: secondJob, requestKey: 'request-key' }), null);
    assert.equal(second.store.entries.size, 0);
});

test('each failed job has at most one retained link and old expiry cannot remove its replacement', () => {
    const { store, clock } = createStore();
    const currentJob = job();
    const currentOwner = owner();
    const first = remember(store, currentJob, currentOwner, { url: 'https://host.example/first.zip' });
    const oldTimer = clock.timers.get(1);
    const second = remember(store, currentJob, currentOwner, { url: 'https://host.example/second.zip' });
    assert.equal(store.entries.size, 1);
    assert.equal(store.consume(first, { owner: currentOwner, job: currentJob, requestKey: 'request-key' }), null);
    oldTimer.callback();
    assert.deepEqual(store.consume(second, {
        owner: currentOwner, job: currentJob, requestKey: 'request-key'
    }).url, 'https://host.example/second.zip');
});

test('sender, request, source, profile, attempt, and cancellation bindings refuse reuse', () => {
    const cases = ['sender', 'request', 'source', 'profile', 'job', 'generation', 'attempt', 'cancellation'];
    for (const label of cases) {
        const { store } = createStore();
        const currentJob = job(`${label}-download`);
        const currentOwner = owner();
        const token = remember(store, currentJob, currentOwner);
        if (label === 'generation') currentJob.generation++;
        if (label === 'attempt') currentJob.attemptGeneration++;
        if (label === 'cancellation') currentJob.cancellationGeneration++;
        const request = label === 'sender'
            ? { owner: owner(), job: currentJob, requestKey: 'request-key' }
            : ['request', 'source', 'profile'].includes(label)
                ? { owner: currentOwner, job: currentJob, requestKey: 'other-key' }
                : label === 'job'
                    ? { owner: currentOwner, job: job('other-download'), requestKey: 'request-key' }
                    : { owner: currentOwner, job: currentJob, requestKey: 'request-key' };
        assert.equal(store.consume(token, request), null, label);
    }
});

test('delayed failures after cancel, cleanup, or a new attempt are never retained', () => {
    const { store } = createStore();
    for (const [overrides, continuationOverrides] of [
        [{ cancelled: true }, {}],
        [{ cleanupFinalized: true }, {}],
        [{ state: JOB_STATES.DOWNLOADING }, {}],
        [{ generation: 2 }, { generation: 1 }],
        [{ attemptGeneration: 2 }, { attemptGeneration: 1 }],
        [{ cancellationGeneration: 2 }, { cancellationGeneration: 1 }]
    ]) {
        const currentJob = job(`delayed-${JSON.stringify(overrides)}`, overrides);
        assert.equal(store.remember({
            owner: owner(), continuation: continuation(currentJob, continuationOverrides),
            requestKey: 'request-key', sourceIndex: 0,
            sourceUrl: 'https://source.example/game.zip', url: 'https://host.example/game.zip'
        }), '');
    }
    assert.equal(store.entries.size, 0);
});

test('download, cancel, sender-destroy, quit, and clear cleanup remove retained links', () => {
    const { store } = createStore();
    const currentOwner = owner();
    const downloadOne = job('cleanup-1');
    const downloadTwo = job('cleanup-2');
    const first = remember(store, downloadOne, currentOwner);
    const second = remember(store, downloadTwo, currentOwner);
    store.clearDownload(downloadOne.id, currentOwner);
    assert.equal(store.entries.has(first), false);
    downloadTwo.cancelled = true;
    store.clearDownload(downloadTwo.id, currentOwner);
    assert.equal(store.entries.has(second), false);

    const destroyedOwner = owner();
    const destroyed = remember(store, job('cleanup-3'), destroyedOwner);
    destroyedOwner.emit('destroyed');
    assert.equal(store.entries.has(destroyed), false);

    const quit = remember(store, job('cleanup-4'), owner());
    assert.equal(store.entries.has(quit), true);
    store.clear();
    assert.equal(store.entries.size, 0);
});

test('unsafe source and direct URLs are rejected and the store remains bounded', () => {
    const { store } = createStore();
    const unsafe = [
        'http://source.example/game.zip',
        'https://user:pass@source.example/game.zip',
        'https://source.example:8443/game.zip',
        'https://source.example/game file.zip'
    ];
    for (const sourceUrl of unsafe) {
        assert.equal(remember(store, job(`unsafe-${sourceUrl}`), owner(), { sourceUrl }), '');
    }
    for (let index = 0; index < 65; index++) {
        const token = remember(store, job(`bounded-${index}`), owner(), {
            sourceUrl: `https://source.example/${index}.zip`,
            url: `https://host.example/${index}.zip`
        });
        assert.ok(token);
    }
    assert.equal(store.entries.size, 64);
});

test('retry request keys change for request ordering, source, profile, and referrer but ignore skipDebrid', () => {
    const base = {
        id: 'download-1', gameName: 'Game', sourceId: 'source-a',
        referer: 'https://source.example/page', url: 'https://source.example/game.zip',
        links: [{ url: 'https://host.example/a.zip', name: 'a' }, { url: 'https://host.example/b.zip', name: 'b' }]
    };
    const scope = { profileId: 'profile-a', libraryId: 'library-a' };
    const key = debridRetryRequestKey(base, scope);
    assert.equal(debridRetryRequestKey({ ...base, skipDebrid: true }, scope), key);
    assert.notEqual(debridRetryRequestKey({ ...base, links: [...base.links].reverse() }, scope), key);
    assert.notEqual(debridRetryRequestKey({ ...base, sourceId: 'source-b' }, scope), key);
    assert.notEqual(debridRetryRequestKey(base, { ...scope, profileId: 'profile-b' }), key);
    assert.notEqual(debridRetryRequestKey({ ...base, referer: 'https://source.example/other' }, scope), key);
});
