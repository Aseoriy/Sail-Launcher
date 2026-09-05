'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDebridTorrentResolver, isTorrentDownload } = require('../runtime/debridTorrents');

const magnet = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=Example';
const ok = body => ({ status: 200, body: JSON.stringify(body), headers: {} });
const tor = data => ok({ success: true, data });
const ad = data => ok({ status: 'success', data });
const dl = value => ok({ success: true, value });
function mock(steps) {
    const calls = [];
    const resolve = createDebridTorrentResolver({
        pollIntervalMs: 0, retryDelayMs: 0, maxWaitMs: 500,
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            assert.ok(steps.length, 'unexpected request: ' + method + ' ' + new URL(url).pathname);
            const step = steps.shift();
            return typeof step === 'function' ? step({ method, url, options }) : step;
        }
    });
    return { resolve, calls, done: () => assert.equal(steps.length, 0) };
}
const readyTor = (extra = {}) => ({ id: 9, name: 'Example', download_finished: true, download_present: true, progress: 1, files: [{ id: 1, name: 'Example/setup.exe', size: 50 }], ...extra });

test('recognizes magnets, torrent paths, filenames, and Rutor download routes', () => {
    for (const link of [magnet, 'https://example.org/file.TORRENT?key=abc', 'https://example.org/file%2Etorrent', 'https://d.rutor.info/download/123']) assert.equal(isTorrentDownload(link), true);
    assert.equal(isTorrentDownload('https://example.org/get?id=1', 'file.torrent'), true);
    for (const link of ['https://example.org/torrent/123', 'https://example.org/download/123', 'https://rutor.info.evil.example/download/123', 'file:///tmp/file.torrent']) assert.equal(isTorrentDownload(link), false);
});

test('TorBox waits for available finished files and requests a whole multi-file zip', async () => {
    const progress = [];
    const m = mock([
        ({ method, url, options }) => { assert.equal(method, 'POST'); assert.match(url, /torrents\/createtorrent$/); assert.match(options.body.toString(), /name="magnet"/); return tor({ torrent_id: 9 }); },
        tor([readyTor({ download_present: false })]),
        tor([readyTor({ files: [{ id: 1 }, { id: 2 }] })]),
        ({ url }) => { const u = new URL(url); assert.equal(u.searchParams.get('zip_link'), 'true'); assert.equal(u.searchParams.has('file_id'), false); return tor('https://cdn.example/Example.zip'); }
    ]);
    const files = await m.resolve('torbox', 'fake-key', magnet, { onProgress: text => progress.push(text) });
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'Example.zip');
    assert.equal(files[0].kind, 'http');
    assert.ok(progress.every(value => typeof value === 'string'));
    m.done();
});

test('TorBox single-file output retains its path and size', async () => {
    const m = mock([tor({ torrent_id: 9 }), tor(readyTor({ files: [] })), tor(readyTor()), tor('https://cdn.example/setup')]);
    const [file] = await m.resolve('torbox', 'fake-key', magnet);
    assert.equal(file.relativePath, 'Example/setup.exe');
    assert.equal(file.sizeBytes, 50);
    m.done();
});

test('HTTP torrent uploads preserve binary bytes and isolate source request headers', async () => {
    const bytes = Buffer.from([100, 49, 58, 120, 49, 58, 255, 101]);
    const m = mock([
        ({ options }) => { assert.equal(options.responseType, 'buffer'); assert.equal(options.maxBodyBytes, 16 * 1024 * 1024); assert.deepEqual(options.headers, { Referer: 'https://source.example/' }); return { status: 200, body: bytes }; },
        ({ options }) => { assert.ok(options.body.includes(bytes)); assert.match(options.headers['Content-Type'], /multipart\/form-data/); assert.equal(options.headers.Referer, undefined); assert.equal(options.headers.Authorization, 'Bearer fake-key'); return tor({ torrent_id: 9 }); },
        tor(readyTor()), tor('https://cdn.example/setup.exe')
    ]);
    await m.resolve('torbox', 'fake-key', 'https://source.example/file.torrent', { torrentHeaders: ['Referer: https://source.example/'] });
    m.done();
});

test('invalid torrent responses never reach authenticated upload endpoints', async () => {
    const m = mock([{ status: 200, body: Buffer.from('<html>login</html>') }]);
    await assert.rejects(m.resolve('torbox', 'fake-key', 'https://source.example/file.torrent'), error => error.debridResolutionFatal && /valid torrent/.test(error.message));
    assert.equal(m.calls.length, 1);
});

test('Real-Debrid selects every file, waits, and unrestricts every link with hierarchy intact', async () => {
    const m = mock([
        ok({ id: 'rd1' }), ok({ status: 'waiting_files_selection' }),
        ({ options }) => { assert.equal(options.body, 'files=all'); return { status: 204, body: '' }; },
        ok({ status: 'downloaded', files: [{ path: '/Example/setup.exe', selected: 1 }, { path: '/Example/data/a.bin', selected: 1 }], links: ['https://rd.example/a', 'https://rd.example/b'] }),
        ok({ download: 'https://cdn.example/a', filesize: 10 }), ok({ download: 'https://cdn.example/b', filesize: 20 })
    ]);
    const files = await m.resolve('realdebrid', 'fake-key', magnet);
    assert.deepEqual(files.map(file => file.relativePath), ['Example/setup.exe', 'Example/data/a.bin']);
    m.done();
});

test('Real-Debrid uploads torrent bytes with PUT instead of unrestricting a torrent URL', async () => {
    const bytes = Buffer.from('d1:x1:ye');
    const m = mock([
        { status: 200, body: bytes },
        ({ method, options }) => { assert.equal(method, 'PUT'); assert.deepEqual(options.body, bytes); return ok({ id: 'rd1' }); },
        ok({ status: 'downloaded', files: [{ path: '/setup.exe', selected: 1 }], links: ['https://rd.example/a'] }),
        ok({ download: 'https://cdn.example/setup.exe', filesize: 10 })
    ]);
    await m.resolve('realdebrid', 'fake-key', 'https://source.example/file.torrent');
    m.done();
});

test('Real-Debrid rejects partially selected torrents', async () => {
    const m = mock([ok({ id: 'rd1' }), ok({ status: 'downloaded', files: [{ path: '/a.bin', selected: 1 }, { path: '/b.bin', selected: 0 }], links: ['https://rd.example/a'] })]);
    await assert.rejects(m.resolve('realdebrid', 'fake-key', magnet), /every torrent file/);
    m.done();
});

test('Real-Debrid packaged torrents download every archive', async () => {
    const m = mock([
        ok({ id: 'rd1' }), ok({ status: 'downloaded', files: [{ selected: 1 }, { selected: 1 }, { selected: 1 }], links: ['https://rd.example/a', 'https://rd.example/b'] }),
        ok({ download: 'https://cdn.example/a', filename: 'Example.part1.rar' }), ok({ download: 'https://cdn.example/b', filename: 'Example.part2.rar' })
    ]);
    const files = await m.resolve('realdebrid', 'fake-key', magnet);
    assert.equal(files.length, 2);
    m.done();
});

test('AllDebrid walks every nested file and unlocks links only when ready', async () => {
    const m = mock([
        ad({ magnets: [{ id: 9 }] }), ad({ magnets: [{ id: 9, statusCode: 1 }] }), ad({ magnets: [{ id: 9, statusCode: 4 }] }),
        ad({ magnets: [{ id: 9, files: [{ n: 'Example', e: [{ n: 'setup.exe', s: 10, l: 'https://ad.example/a' }, { n: 'data', e: [{ n: 'a.bin', s: 20, l: 'https://ad.example/b' }] }] }] }] }),
        ad({ link: 'https://cdn.example/a' }), ad({ link: 'https://cdn.example/b' })
    ]);
    const files = await m.resolve('alldebrid', 'fake-key', magnet);
    assert.deepEqual(files.map(file => file.relativePath), ['Example/setup.exe', 'Example/data/a.bin']);
    assert.equal(new URL(m.calls[1].url).pathname, '/v4.1/magnet/status');
    m.done();
});

test('Premiumize waits for a torrent and packages only its folder with one connection', async () => {
    const m = mock([
        ok({ status: 'success', id: 'pm1' }),
        ok({ status: 'success', transfers: [{ id: 'pm1', status: 'running', progress: 0.5 }] }),
        ok({ status: 'success', transfers: [{ id: 'pm1', status: 'seeding', name: 'Example', folder_id: 'folder1' }] }),
        ({ options }) => { assert.equal(options.body, 'folders%5B%5D=folder1'); return ok({ status: 'success', location: 'https://cdn.example/Example.zip' }); }
    ]);
    const [file] = await m.resolve('premiumize', 'fake-key', magnet);
    assert.equal(file.maxConn, 1);
    assert.equal(file.name, 'Example.zip');
    m.done();
});

test('Debrid-Link waits for every file instead of downloading a completed subset', async () => {
    const m = mock([
        dl({ id: 'dl1' }),
        dl([{ id: 'dl1', downloadPercent: 100, files: [{ downloadPercent: 40 }] }]),
        dl([{ id: 'dl1', downloadPercent: 100, files: [{ name: 'Example/setup.exe', size: 10, downloadPercent: 100, downloadUrl: 'https://cdn.example/a' }, { name: 'Example/data/a.bin', size: 20, downloadPercent: 100, downloadUrl: 'https://cdn.example/b' }] }])
    ]);
    const files = await m.resolve('debridlink', 'fake-key', magnet);
    assert.deepEqual(files.map(file => file.relativePath), ['Example/setup.exe', 'Example/data/a.bin']);
    assert.match(m.calls[1].url, /seedbox\/list\?ids=dl1/);
    m.done();
});

test('cancellation interrupts polling and retry resumes the same remote job', async () => {
    const controller = new AbortController();
    const m = mock([
        tor({ torrent_id: 9 }),
        () => { controller.abort(); return tor([readyTor({ download_finished: false })]); },
        tor([readyTor()]), tor('https://cdn.example/setup.exe')
    ]);
    await assert.rejects(m.resolve('torbox', 'fake-key', magnet, { signal: controller.signal }), error => error.name === 'AbortError' && error.debridResolutionFatal);
    await m.resolve('torbox', 'fake-key', magnet);
    assert.equal(m.calls.filter(call => call.method === 'POST').length, 1);
    m.done();
});

test('resume records are scoped to account and provider', async () => {
    const m = mock([
        tor({ torrent_id: 9 }), tor([readyTor()]), tor('https://cdn.example/a'),
        tor({ torrent_id: 9 }), tor([readyTor()]), tor('https://cdn.example/b'),
        dl({ id: 'dl1' }), dl([{ id: 'dl1', downloadPercent: 100, files: [{ name: 'a.bin', downloadPercent: 100, downloadUrl: 'https://cdn.example/c' }] }])
    ]);
    await m.resolve('torbox', 'account-a', magnet);
    await m.resolve('torbox', 'account-b', magnet);
    await m.resolve('debridlink', 'account-a', magnet);
    assert.equal(m.calls.filter(call => call.method === 'POST').length, 3);
    m.done();
});

test('transient reads retry within a bound; torrent submissions never automatically repeat', async () => {
    const m = mock([tor({ torrent_id: 9 }), { status: 503 }, { status: 429 }, tor([readyTor()]), tor('https://cdn.example/a')]);
    await m.resolve('torbox', 'fake-key', magnet);
    assert.equal(m.calls.length, 5);
    const failing = mock([{ status: 503, body: 'private-key-provider-message' }]);
    await assert.rejects(failing.resolve('torbox', 'private-key', magnet), error => error.debridResolutionFatal && !error.message.includes('private-key'));
    failing.done();
});

test('unsafe output paths, non-HTTP links and duplicate names fail as a whole', async () => {
    for (const data of [
        [{ name: '../outside.exe', downloadUrl: 'https://cdn.example/a', downloadPercent: 100 }],
        [{ name: 'safe.exe', downloadUrl: 'magnet:?xt=test', downloadPercent: 100 }],
        [{ name: 'a.bin', downloadUrl: 'https://cdn.example/a', downloadPercent: 100 }, { name: 'A.bin', downloadUrl: 'https://cdn.example/b', downloadPercent: 100 }]
    ]) {
        const m = mock([dl({ id: 'dl1' }), dl([{ id: 'dl1', downloadPercent: 100, files: data }])]);
        await assert.rejects(m.resolve('debridlink', 'fake-key', magnet), error => error.debridResolutionFatal);
        m.done();
    }
});

test('authentication and provider errors never expose raw response details', async () => {
    for (const response of [{ status: 403, body: 'fake-key email@example.test' }, tor({}) , ok({ success: false, error: 'fake-key email@example.test' })]) {
        const m = mock([response]);
        await assert.rejects(m.resolve('torbox', 'fake-key', magnet), error => error.debridResolutionFatal && !/fake-key|email@/.test(error.message));
    }
});
