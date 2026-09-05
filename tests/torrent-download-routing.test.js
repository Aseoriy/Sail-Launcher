'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { isTorrentDownload } = require('../runtime/debridTorrents');
const { torrentDownloadTarget } = require('../runtime/debridTorrentFiles');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function section(startMarker, endMarker) {
    const start = main.indexOf(startMarker);
    const end = main.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    return main.slice(start, end);
}

function resolver(overrides = {}) {
    return vm.runInNewContext(`(() => {
        ${section('async function resolveTorrentDownloads(', 'function buildUnresolvedError(')}
        return resolveDirectUrl;
    })()`, {
        isTorrentDownload,
        SOURCE_REFERER: {},
        normalizeFileCryptContainerUrl: () => '',
        DL_KNOWN_HOST: /1337x/i,
        debridActive: () => true,
        debridService: 'torbox',
        debridKey: 'test-key',
        debridServiceName: () => 'TorBox',
        debridUnrestrict: async () => { throw new Error('Torrent used the file-host API'); },
        resolveDebridTorrent: async () => [{ url: 'https://cdn.example/torrent.zip', kind: 'http', name: 'torrent.zip' }],
        ...overrides
    });
}

const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

test('magnets, torrent URLs and extensionless torrent filenames resolve through the selected debrid', async () => {
    const calls = [];
    const resolve = resolver({ resolveDebridTorrent: async (...args) => {
        calls.push(args);
        return [{ url: 'https://cdn.example/game.bin', kind: 'http', name: 'game.bin', relativePath: 'Game/data/game.bin', sizeBytes: 123 }];
    } });
    const controller = new AbortController();
    for (const url of [magnet, 'https://example.test/game.torrent', 'https://d.rutor.info/download/123', 'https://example.test/download?id=1']) {
        const files = await resolve(url, { name: 'game.torrent', signal: controller.signal });
        assert.equal(files[0].debridServiceId, 'torbox');
        assert.equal(files[0].debridService, 'TorBox');
        assert.equal(files[0].relativePath, 'Game/data/game.bin');
        assert.equal(files[0].sizeBytes, 123);
        assert.equal(calls.at(-1)[2], url);
        assert.equal(calls.at(-1)[3].signal, controller.signal);
    }
});

test('disconnected torrent downloads keep their direct route', async () => {
    const resolve = resolver({ debridActive: () => false });
    const result = await resolve(magnet);
    assert.equal(result[0].kind, 'magnet');
    assert.equal(result[0].url, magnet);
    assert.equal(result[0].debridService, undefined);
});

test('torrent pages are scraped before torrent submission instead of sent to web download APIs', async () => {
    for (const [url, extra] of [
        ['https://1337x.to/torrent/123/game', { scrape1337x: async () => [{ url: magnet, kind: 'magnet' }] }],
        ['https://rutor.info/torrent/123/game', { scrapeRutor: async () => [{ url: magnet, kind: 'magnet' }] }]
    ]) {
        const result = await resolver(extra)(url);
        assert.equal(result[0].url, 'https://cdn.example/torrent.zip');
        assert.equal(result[0].debridService, 'TorBox');
    }
});

test('visible torrent handoff and intercepted torrent filenames also use debrid', async () => {
    const visible = await resolver({
        scrape1337x: async () => null,
        resolve1337xWithSystemBrowser: async () => null,
        resolveWithManagedHostBrowser: async () => [{ url: magnet, kind: 'magnet' }]
    })('https://1337x.to/torrent/123/game');
    assert.equal(visible[0].debridService, 'TorBox');
    const intercepted = await resolver({
        debridUnrestrict: async () => null,
        interceptDownload: async () => ({ url: 'https://example.test/download/123', name: 'game.torrent', headers: { Cookie: 'test-cookie' } }),
        resolveDebridTorrent: async (_service, _key, _url, options) => {
            assert.deepEqual(Array.from(options.torrentHeaders), ['Cookie: test-cookie']);
            return [{ url: 'https://cdn.example/game.zip', kind: 'http' }];
        }
    })('https://example.test/page');
    assert.equal(intercepted[0].debridService, 'TorBox');
});

test('provider rejection and cancellation do not fall back to local torrent peers', async () => {
    for (const url of [magnet, 'https://rutor.info/torrent/123/game']) {
        const error = Object.assign(new Error('Provider rejected this torrent'), { debridResolutionFatal: true });
        const resolve = resolver({
            scrapeRutor: async () => [{ url: magnet }],
            resolveDebridTorrent: async () => { throw error; },
            interceptDownload: async () => { throw new Error('Unexpected fallback'); }
        });
        await assert.rejects(resolve(url), value => value === error);
    }
    await assert.rejects(resolver()(magnet, { signal: AbortSignal.abort() }), { name: 'AbortError' });
    await assert.rejects(resolver({ resolveDebridTorrent: async () => [] })(magnet), /did not return any torrent files/);
});

function temporaryRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-torrent-files-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('torrent output preserves nested names and rejects unsafe Windows destinations', t => {
    const root = temporaryRoot(t);
    const target = torrentDownloadTarget(root, 'Game/data/texture.dat', { createDirectories: true });
    assert.equal(target.path, path.join(root, 'Game', 'data', 'texture.dat'));
    assert.equal(fs.statSync(target.directory).isDirectory(), true);
    for (const invalid of ['../outside.bin', '/absolute.bin', 'C:\\outside.bin', 'Game/../file', 'Game/NUL.txt', 'data/file:stream', 'Game/a.', 'Game//file']) {
        assert.throws(() => torrentDownloadTarget(root, invalid));
    }
    fs.mkdirSync(path.join(root, 'collision.bin'));
    assert.throws(() => torrentDownloadTarget(root, 'collision.bin'), /unexpected file/);
    fs.symlinkSync(path.join(root, 'Game'), path.join(root, 'redirect'), 'junction');
    assert.throws(() => torrentDownloadTarget(root, 'redirect/data/file.bin'), /contains a link/);
});

test('aria2 saves torrent files with their exact relative paths including nonarchive extensions', async t => {
    const root = temporaryRoot(t);
    let args;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    const run = vm.runInNewContext(`(() => {
        ${section('function safeOutName(', 'function pauseForDownloadSize(')}
        ${section('function runAria2Download(', 'function browserBytes(')}
        return runAria2Download;
    })()`, {
        torrentDownloadTarget, DL_UA: 'test', nodeNet: require('node:net'), setTimeout, clearTimeout,
        spawn: (_exe, values) => { args = values; queueMicrotask(() => proc.emit('close', 0)); return proc; }
    });
    await run('unused-aria2', { url: 'https://cdn.example/file', kind: 'http', name: 'texture.dat', relativePath: 'Game/data/texture.dat' }, root, {}, {}, () => {});
    assert.ok(args.includes('--dir=' + path.join(root, 'Game', 'data')));
    assert.ok(args.includes('--out=texture.dat'));
    assert.ok(!args.some(arg => arg.startsWith('--bt-')));
});
