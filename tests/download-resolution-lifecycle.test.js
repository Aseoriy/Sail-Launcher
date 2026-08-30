'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ManagedVerificationCoordinator,
    mergeRefreshedDownload,
    shouldPreservePartialForRetry,
    resolveSelectedLinksSequentially
} = require('../runtime/downloadResolutionLifecycle');

test('selected multipart links resolve strictly in order', async () => {
    const events = [];
    let active = 0;
    let maxActive = 0;
    const links = [{ url: 'https://files.example/part1' }, { url: 'https://files.example/part2' }];
    const result = await resolveSelectedLinksSequentially(links, async (link, index) => {
        active++;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${index}`);
        await new Promise(resolve => setTimeout(resolve, index ? 2 : 8));
        events.push(`end:${index}`);
        active--;
        return [{ url: link.url + '/direct' }];
    });
    assert.equal(maxActive, 1);
    assert.deepEqual(events, ['start:0', 'end:0', 'start:1', 'end:1']);
    assert.equal(result[1].resolved[0].url, 'https://files.example/part2/direct');
});

test('managed verification has one global owner and releases it after failure', async () => {
    const coordinator = new ManagedVerificationCoordinator();
    const events = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const first = coordinator.run('datanodes:first', async () => {
        events.push('first:start');
        await firstGate;
        events.push('first:end');
        return null;
    });
    const second = coordinator.run('akirabox:second', async () => {
        events.push('second:start');
        throw new Error('verification failed');
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.activeOwner, 'datanodes:first');
    assert.deepEqual(events, ['first:start']);
    releaseFirst();
    assert.equal(await first, null);
    await assert.rejects(second, /verification failed/);
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
    assert.equal(coordinator.activeOwner, '');
    assert.equal(await coordinator.run('fuckingfast:third', async () => 'resolved'), 'resolved');
});

test('cancelling a queued verification releases its caller and never opens later', async () => {
    const coordinator = new ManagedVerificationCoordinator();
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const first = coordinator.run('buzzheavier:first', async () => {
        await firstGate;
        return 'first-complete';
    });
    await new Promise(resolve => setImmediate(resolve));

    const controller = new AbortController();
    let queuedStarted = false;
    const queued = coordinator.run('fileditch:queued', async () => {
        queuedStarted = true;
        return 'should-not-run';
    }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, error => error && error.name === 'AbortError');
    assert.equal(queuedStarted, false);

    releaseFirst();
    assert.equal(await first, 'first-complete');
    await coordinator.tail;
    assert.equal(queuedStarted, false);
    assert.equal(coordinator.activeOwner, '');
});

test('cancelling an active verification is owned until its browser task closes', async () => {
    const coordinator = new ManagedVerificationCoordinator();
    const controller = new AbortController();
    const events = [];
    const active = coordinator.run('datanodes:active', async signal => {
        events.push('opened');
        await new Promise(resolve => signal.addEventListener('abort', () => {
            events.push('closing');
            setImmediate(() => {
                events.push('closed');
                resolve();
            });
        }, { once: true }));
        const error = new Error('Cancelled');
        error.name = 'AbortError';
        throw error;
    }, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.activeOwner, 'datanodes:active');
    controller.abort();
    assert.deepEqual(events, ['opened', 'closing']);
    await assert.rejects(active, error => error && error.name === 'AbortError');
    assert.deepEqual(events, ['opened', 'closing', 'closed']);
    assert.equal(coordinator.activeOwner, '');
});

test('fresh BuzzHeavier links keep the partial payload and stable output identity', () => {
    const current = {
        url: 'https://cdn.buzzheavier.com/files/game.rar?signature=old',
        name: 'Cyberpunk.part1.rar',
        origin: 'https://bzzhr.to/u33dxmmaozb6',
        originIndex: 0,
        resumeAcrossFreshUrl: true
    };
    const refreshed = {
        url: 'https://cdn.buzzheavier.com/files/game.rar?signature=new',
        name: 'temporary-host-name.rar',
        maxConn: 1,
        resumeAcrossFreshUrl: true
    };

    assert.equal(shouldPreservePartialForRetry(current, { aria2Code: 8 }), true);
    assert.equal(shouldPreservePartialForRetry(current, { aria2Code: 22 }), true);
    assert.equal(shouldPreservePartialForRetry(current, { aria2Code: 3 }), false);
    assert.equal(shouldPreservePartialForRetry({ resumeAcrossFreshUrl: false }, { aria2Code: 8 }), false);
    assert.deepEqual(mergeRefreshedDownload(current, refreshed), {
        url: refreshed.url,
        name: 'Cyberpunk.part1.rar',
        origin: current.origin,
        originIndex: 0,
        maxConn: 1,
        resumeAcrossFreshUrl: true
    });
});
