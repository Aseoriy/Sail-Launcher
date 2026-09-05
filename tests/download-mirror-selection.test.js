'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { downloadSetAvailability, preferredDownloadSet, groupDownloadSets } = require('../ui/downloadSourceLogic');

const mirror = (host, extra = {}) => ({ host, kind: 'http', group: 'game', parts: [{ url: `https://${host}/file` }], ...extra });

test('FitGirl always selects its magnet immediately regardless of mirror health or previous choice', () => {
    const magnet = mirror('Magnet / Torrent', { kind: 'magnet' });
    const http = mirror('filekeeper.net');
    const torrent = mirror('rutor.info', { parts: [{ url: 'https://rutor.info/torrent/123/game' }] });
    for (const status of ['checking', 'available', 'down', 'verification-required', 'unknown']) {
        const choice = preferredDownloadSet([http, torrent, magnet], () => status, http, () => true, { sourceId: 'fitgirl' });
        assert.equal(choice.set, magnet);
        assert.equal(choice.status, 'unconfirmed');
    }
});

test('FitGirl uses one torrent alternative when no magnet exists and never makes HTTP mirrors the primary', () => {
    const sets = groupDownloadSets([
        { type: 'web', url: 'https://source.example/game.torrent' },
        { type: 'web', url: 'https://rutor.info/torrent/123/game' },
        { type: 'web', url: 'https://1337x.to/torrent/123/game' },
        { type: 'web', url: 'https://filekeeper.net/123/game.rar' }
    ], 'fitgirl');
    const choice = preferredDownloadSet(sets, () => 'available', null, () => true, { sourceId: 'fitgirl' });
    assert.equal(choice.set.kind, 'torrent');
    assert.equal(choice.set.parts.length, 1);
    assert.equal(sets.length, 2);
    assert.equal(choice.set.parts[0].url, 'https://source.example/game.torrent');
    assert.deepEqual(preferredDownloadSet([mirror('filekeeper.net')], () => 'available', null, () => true, { sourceId: 'fitgirl' }), { set: null, status: 'no-torrent' });
});

test('one-click immediately promotes an available mirror over an offline or unconfirmed default', () => {
    const gofile = mirror('gofile.io');
    const buzz = mirror('buzzheavier.com');
    for (const status of ['down', 'unknown', 'verification-required', 'checking']) {
        assert.equal(preferredDownloadSet([gofile, buzz], set => set === gofile ? status : 'available', gofile).set, buzz);
    }
});

test('one-click waits for initial checks without marking unresolved providers down', () => {
    const gofile = mirror('gofile.io');
    const buzz = mirror('buzzheavier.com');
    assert.deepEqual(preferredDownloadSet([gofile, buzz], () => 'checking'), { set: null, status: 'checking' });
    assert.deepEqual(preferredDownloadSet([gofile, buzz], () => 'down'), { set: null, status: 'down' });
    assert.deepEqual(preferredDownloadSet([gofile, buzz], set => set === gofile ? 'unknown' : 'down'), { set: gofile, status: 'unconfirmed' });
});

test('a working primary stays stable but switches again if it later goes offline', () => {
    const gofile = mirror('gofile.io');
    const buzz = mirror('buzzheavier.com');
    assert.equal(preferredDownloadSet([gofile, buzz], () => 'available', buzz).set, buzz);
    assert.equal(preferredDownloadSet([gofile, buzz], set => set === buzz ? 'down' : 'available', buzz).set, gofile);
});

test('automatic selection excludes language packs, isolated parts and browser-only choices when direct mirrors exist', () => {
    const language = mirror('language.test', { group: 'languages' });
    const part = mirror('part.test', { partLabel: 'Part 1' });
    const browser = mirror('mediafire.com');
    const buzz = mirror('buzzheavier.com');
    const result = preferredDownloadSet([language, part, browser, buzz], () => 'available', null, set => set !== browser);
    assert.equal(result.set, buzz);
    assert.equal(preferredDownloadSet([browser, buzz], set => set === buzz ? 'down' : 'available', null, set => set !== browser).set, browser);
    assert.deepEqual(preferredDownloadSet([language, part], () => 'available'), { set: null, status: 'none' });
});

test('AkiraBox is never the primary choice, including available, current and only-mirror fallbacks', () => {
    for (const host of ['akirabox.com', 'akirabox.to', 'www.akirabox.com', 'WWW.AKIRABOX.TO', 'files.akirabox.com']) {
        const akira = mirror(host);
        const datanodes = mirror('datanodes.to');
        for (const canAutoStart of [() => true, set => set !== akira]) {
            assert.deepEqual(preferredDownloadSet([akira], () => 'available', akira, canAutoStart), { set: null, status: 'none' });
            for (const status of ['available', 'unknown', 'verification-required']) {
                const choice = preferredDownloadSet([akira, datanodes], set => set === akira ? 'available' : status, akira, canAutoStart);
                assert.equal(choice.set, datanodes);
                assert.equal(choice.status, status === 'available' ? 'available' : 'unconfirmed');
            }
            assert.deepEqual(preferredDownloadSet([akira, datanodes], set => set === akira ? 'available' : 'checking', akira, canAutoStart), { set: null, status: 'checking' });
            assert.deepEqual(preferredDownloadSet([akira, datanodes], set => set === akira ? 'available' : 'down', akira, canAutoStart), { set: null, status: 'down' });
        }
    }
});

test('multipart availability requires all files and detects a missing part before remaining checks finish', () => {
    const set = mirror('parts.test', { parts: [1, 2, 3, 4, 5].map(n => ({ url: String(n) })) });
    const values = new Map([['1', { status: 'available' }], ['2', { status: 'available' }]]);
    const get = url => values.get(url);
    assert.equal(downloadSetAvailability(set, get), 'checking');
    values.set('5', { status: 'down' });
    assert.equal(downloadSetAvailability(set, get), 'down');
    ['3', '4', '5'].forEach(url => values.set(url, { status: 'available' }));
    assert.equal(downloadSetAvailability(set, get), 'available');
    values.set('3', { status: 'verification-required' });
    assert.equal(downloadSetAvailability(set, get), 'verification-required');
    assert.equal(downloadSetAvailability(mirror('magnet', { kind: 'magnet' }), get), 'unknown');
});
