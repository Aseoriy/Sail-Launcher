'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { DebridRetryLinkStore, debridRetryRequestKey } = require('../runtime/debridRetryLinks');
const { DownloadJobDirectoryRegistry } = require('../runtime/downloadJobCleanup');
const { createDownloadWorkCoordinator } = require('../runtime/downloadWorkCoordinator');
const { createDownloadCancellationHandler } = require('../runtime/downloadIpc');
const { normalizeFileCryptContainerUrl } = require('../runtime/fileCryptResolver');
const { isTorrentDownload } = require('../runtime/debridTorrents');
const { gofileDirectDownloadUrl, validateGofileTransfer } = require('../runtime/downloadHostResolvers');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) {
    const from = main.indexOf(start);
    const to = main.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return main.slice(from, to);
}
const container = 'https://www.filecrypt.cc/Container/C9D9F3E419.html';
const revealed = 'https://gofile.io/d/private-revealed-share';

function pipeline(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-debrid-retry-'));
    const store = new DebridRetryLinkStore();
    t.after(() => {
        store.clear();
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('sail-debrid-retry-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const registry = new DownloadJobDirectoryRegistry();
    const handlers = new Map();
    const events = [], direct = [], provider = [], transfers = [];
    let verificationCount = 0;
    const owner = Object.assign(new EventEmitter(), {
        id: 1, isDestroyed: () => false,
        send: (channel, payload) => events.push({ channel, payload: JSON.parse(JSON.stringify(payload)) })
    });
    const context = {
        URL, AbortController, setTimeout, clearTimeout, path, fs,
        normalizeFileCryptContainerUrl, isTorrentDownload, gofileDirectDownloadUrl, validateGofileTransfer,
        resolveTorrentDownloads: async files => files,
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        normalizeDownloadRequest: input => ({ links: [], sourceId: 'steamrip', autoInstall: false, ...input }),
        exactGateAPayload: input => input,
        gateAProfileStore: () => ({ activeScope: () => ({ profileId: 'profile', libraryId: 'library' }) }),
        debridRetryLinks: store, debridRetryRequestKey,
        beginDownloadJob: (id, input) => registry.begin(id, { gameName: input.gameName, defaultRoot: root }),
        downloadJobDirectories: registry, downloadWork: createDownloadWorkCoordinator(registry),
        activeDownloads: new Map(),
        resolveSteamMetadataForDownload: async () => null,
        ensureAria2: async () => 'inert-test-engine',
        SOURCE_REFERER: { steamrip: 'https://steamrip.com/' },
        HEALTH_STATES: { DOWN: 'down' },
        inspectDownloadLinkHealth: async () => ({ status: 'unknown' }),
        DL_SKIP_FILE: /steam-fix/i, DL_KNOWN_HOST: /gofile/i, DL_MANAGED_RETRY_HOST: /datanodes/i,
        buildLinkDownError: url => Object.assign(new Error('This mirror is offline.'), { downloadUrl: url, linkHealth: 'down' }),
        buildUnresolvedError: () => new Error('No usable host file.'),
        scrapeSteamRipGofileContainer: async (_url, _referer, onShare) => { verificationCount++; return onShare(revealed); },
        scrapeGofile: async url => {
            direct.push(url);
            if (options.directOffline && url === revealed) throw Object.assign(new Error('Offline'), { gofileStatus: 'error-notFound' });
            return [{ url: 'https://cdn.example/' + url.split('/').pop() + '.zip', name: 'fixture.zip', kind: 'http' }];
        },
        runAria2Download: async (_engine, file) => { transfers.push(file); },
        pauseForDownloadSize: () => false,
        postProcessDownload: async () => ({ usable: true, installFailed: true, exePath: '' }),
        applyInstallerCompletionPolicy() {},
        finishDownloadJob: async continuation => { await registry.setState(continuation, 'done'); return { gameName: 'Fixture' }; },
        services: { torbox: { name: 'TorBox', unrestrict: async (_key, link) => {
            provider.push(link);
            if (link === revealed) throw Object.assign(new Error('TorBox rejected this file.'), { debridResolutionFatal: true, debridRejected: true });
            return { url: 'https://cdn.example/provider-first.zip', name: 'fixture.zip' };
        } } },
        ...options.context
    };
    vm.runInNewContext(`
        const DEBRID = services;
        ${section("let debridService = ''", "ipcMain.on('set-debrid-cache-enabled'")}
        debridService = 'torbox'; debridKey = 'test-only-key';
        ${section('async function prepareGofileDownload(', 'function mergeDownloadCookies(')}
        ${section('async function resolveDirectUrl(', 'function buildUnresolvedError(')}
        ${section('async function retainDownloadJobError(', '// --- Host scrapers')}
        ${section("ipcMain.handle('download-game'", '// Cancellation is registered')}
    `, context);
    const request = { id: 'fixture', gameName: 'Fixture', url: container, sourceId: 'steamrip' };
    return { store, registry, events, direct, provider, transfers, owner, request,
        get verificationCount() { return verificationCount; },
        download: input => handlers.get('download-game')({ sender: owner }, input),
        discard: token => handlers.get('discard-debrid-retry-link')({ sender: owner }, { token }),
        lastError: () => events.filter(event => event.channel === 'download-error').at(-1).payload };
}

test('FileCrypt rejection retains only an opaque retry token and direct retry skips its verification', async t => {
    const env = pipeline(t);
    const failure = await env.download(env.request);
    assert.equal(failure.success, false);
    assert.equal(env.verificationCount, 1);
    assert.deepEqual(env.provider, [revealed]);
    const token = env.lastError().debridRetryToken;
    assert.match(token, /^[0-9a-f-]{36}$/);
    assert.equal(env.store.entries.size, 1);
    assert.equal(JSON.stringify({ events: env.events, failure }).includes(revealed), false);
    const result = await env.download({ ...env.request, skipDebrid: true, debridRetryToken: token });
    assert.equal(result.success, true, result.error);
    assert.equal(env.verificationCount, 1);
    assert.deepEqual(env.direct, [revealed]);
    assert.deepEqual(env.provider, [revealed]);
    assert.equal(env.store.entries.size, 0);
    assert.equal(env.request.url, container);
    assert.equal(env.request.debridRetryToken, undefined);
});

test('a failed direct retry reports only the original source and cannot use its retained link again', async t => {
    const env = pipeline(t, { directOffline: true });
    await env.download(env.request);
    const token = env.lastError().debridRetryToken;
    const retry = { ...env.request, skipDebrid: true, debridRetryToken: token };
    const result = await env.download(retry);
    assert.equal(result.success, false);
    assert.equal(env.verificationCount, 1);
    assert.equal(env.lastError().url, container);
    assert.equal(env.lastError().debridRetryToken, '');
    assert.equal(env.store.entries.size, 0);
    assert.equal(JSON.stringify({ events: env.events, result }).includes(revealed), false);
    await env.download(retry);
    assert.equal(env.verificationCount, 2, 'the consumed handoff cannot skip another verification');
});

test('multipart retry replaces only the rejected source and preserves the other selected links', async t => {
    const env = pipeline(t);
    const first = 'https://gofile.io/d/first-part';
    const last = 'https://gofile.io/d/last-part';
    const request = { ...env.request, url: undefined, links: [
        { url: first, name: 'first.zip' }, { url: container, name: 'middle.zip' }, { url: last, name: 'last.zip' }
    ] };
    const before = JSON.stringify(request);
    await env.download(request);
    const token = env.lastError().debridRetryToken;
    assert.ok(token);
    const result = await env.download({ ...request, skipDebrid: true, debridRetryToken: token });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(env.direct, [first, revealed, last]);
    assert.equal(env.verificationCount, 1);
    assert.equal(JSON.stringify(request), before);
    assert.equal(env.store.entries.size, 0);
});

test('ordinary retry and explicit dismissal discard the previous handoff', async t => {
    const env = pipeline(t);
    await env.download(env.request);
    const firstToken = env.lastError().debridRetryToken;
    await env.download(env.request);
    const secondToken = env.lastError().debridRetryToken;
    assert.equal(env.verificationCount, 2);
    assert.notEqual(secondToken, firstToken);
    assert.equal(env.store.entries.has(firstToken), false);
    assert.equal(env.store.entries.size, 1);
    await env.discard(secondToken);
    assert.equal(env.store.entries.size, 0);
});

test('cancellation discards a handoff immediately, before cleanup settles', async () => {
    let discarded = false, finishCancel;
    const pending = new Promise(resolve => { finishCancel = resolve; });
    const handler = createDownloadCancellationHandler({
        registry: { requestCancel: () => pending }, activeDownloads: new Map(), pendingBrowserDownloads: new Map(),
        onCancelRequested: (_event, id) => { assert.equal(id, 'fixture'); discarded = true; }
    });
    const canceled = handler({}, 'fixture');
    assert.equal(discarded, true);
    finishCancel(null);
    await canceled;
});

function gofileResponses({ alwaysHtml = false, wrongFile = false } = {}) {
    const requests = [], probes = [];
    const fileId = 'ActualFile123';
    const oldUrl = 'https://store1.gofile.io/download/web/ActualFile123/Game.rar';
    const freshUrl = 'https://store2.gofile.io/download/web/ActualFile123/Game.rar';
    return {
        requests, probes, oldUrl, freshUrl,
        context: {
            scrapeGofile: async (url, options = {}) => {
                requests.push({ url, options });
                const refreshed = options.refreshAccount === true;
                if (refreshed) assert.equal(url, 'https://gofile.io/contents/' + fileId);
                return [{ url: refreshed ? freshUrl : oldUrl, name: 'Game.rar', kind: 'http',
                    gofileContentId: refreshed && wrongFile ? 'DifferentFile456' : fileId,
                    sizeBytes: 96001666435,
                    headers: ['Cookie: accountToken=' + (refreshed ? 'fresh' : 'old'), 'User-Agent: Gofile fixture', 'Referer: https://gofile.io/'] }];
            },
            dlRequest: async (method, url, options) => {
                assert.equal(method, 'GET');
                assert.equal(options.headersOnly, true);
                assert.equal(options.follow, false);
                assert.equal(options.headers.Range, 'bytes=0-0');
                probes.push({ url, options });
                if (url === oldUrl || alwaysHtml) return {
                    status: 200, headers: { 'content-type': 'text/html', 'content-length': '3358' },
                    body: '<!doctype html><title>Gofile</title>Gofile needs JavaScript to run.'
                };
                assert.equal(url, freshUrl);
                assert.equal(options.headers.Cookie, 'accountToken=fresh');
                return { status: 206, headers: {
                    'content-type': 'application/vnd.rar', 'content-disposition': 'attachment; filename="Game.rar"',
                    'content-range': 'bytes 0-0/96001666435', 'content-length': '1'
                }, body: '' };
            }
        }
    };
}

test('retained GoFile retry refreshes a webpage response into the same archive without re-verifying FileCrypt', async t => {
    const responses = gofileResponses();
    const env = pipeline(t, responses);
    await env.download(env.request);
    const result = await env.download({ ...env.request, skipDebrid: true, debridRetryToken: env.lastError().debridRetryToken });
    assert.equal(result.success, true, result.error);
    assert.equal(env.verificationCount, 1);
    assert.equal(responses.requests[0].url, revealed, 'the first lookup must be the post-verification share');
    assert.equal(responses.requests.length, 2, 'refreshes authorization and the same file once');
    assert.equal(responses.probes.length, 2);
    assert.equal(env.transfers.length, 1);
    assert.equal(env.transfers[0].url, responses.freshUrl);
    assert.ok(env.transfers[0].headers.includes('Cookie: accountToken=fresh'));
    assert.equal(env.transfers[0].sizeBytes, 96001666435);
    assert.equal(env.store.entries.size, 0);
});

test('persistent GoFile HTML is rejected before the downloader and cannot reopen FileCrypt in a retry loop', async t => {
    const responses = gofileResponses({ alwaysHtml: true });
    const env = pipeline(t, responses);
    await env.download(env.request);
    const result = await env.download({ ...env.request, skipDebrid: true, debridRetryToken: env.lastError().debridRetryToken });
    assert.equal(result.success, false);
    assert.equal(env.verificationCount, 1);
    assert.equal(responses.requests.length, 2);
    assert.equal(responses.probes.length, 2);
    assert.equal(env.transfers.length, 0, 'the 3358-byte HTML page must never reach aria2');
    assert.equal(env.lastError().url, container);
    assert.equal(env.lastError().debridRetryToken, '');
    assert.equal(env.events.some(event => event.payload.sizeWarning), false);
    assert.equal(JSON.stringify(env.events).includes(revealed), false);
});

test('a GoFile refresh cannot select a different file from the share', async t => {
    const responses = gofileResponses({ wrongFile: true });
    const env = pipeline(t, responses);
    await env.download(env.request);
    const result = await env.download({ ...env.request, skipDebrid: true, debridRetryToken: env.lastError().debridRetryToken });
    assert.equal(result.success, false);
    assert.equal(responses.probes.length, 1, 'the replacement must match before any transfer request');
    assert.equal(env.transfers.length, 0);
    assert.equal(env.verificationCount, 1);
});
