const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const mainPath = path.join(__dirname, '..', 'main.js');
const indexPath = path.join(__dirname, '..', 'index.html');

function readMain() {
    return fs.readFileSync(mainPath, 'utf8');
}

function loadDlRequest(context) {
    const main = readMain();
    const start = main.indexOf('function dlRequest(');
    const end = main.indexOf('async function dlElectronRequest(', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(`(${main.slice(start, end).trim()}\n)`, {
        URL,
        Buffer,
        DL_UA: 'Sail test',
        ...context
    });
}

test('HTTP requests retain the normal timeout and allow TorBox its longer extraction timeout', async () => {
    const timeouts = [];
    const client = {
        request(url, options, onResponse) {
            const request = new EventEmitter();
            request.setTimeout = value => timeouts.push(value);
            request.end = () => {
                const response = new EventEmitter();
                response.statusCode = 200;
                response.headers = {};
                response.setEncoding = () => {};
                onResponse(response);
                response.emit('end');
            };
            return request;
        }
    };
    const dlRequest = loadDlRequest({ http: client, https: client });
    await dlRequest('GET', 'https://example.invalid/test');
    await dlRequest('GET', 'https://example.invalid/test', { timeoutMs: 180000 });
    await dlRequest('GET', 'https://example.invalid/test', { timeoutMs: 999999 });
    assert.deepEqual(timeouts, [25000, 180000, 180000]);
});

test('metadata requests read bounded JSON and never buffer file downloads, including after redirects', async t => {
    const server = http.createServer((request, response) => {
        if (request.url === '/redirect') {
            response.writeHead(302, { Location: '/large' });
            response.end();
        } else if (request.url === '/file') {
            response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(120 * 1024 ** 3) });
            response.flushHeaders();
        } else {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(request.url === '/large' ? JSON.stringify({ data: 'x'.repeat(2048) }) : JSON.stringify({ size: 1234 }));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
    }));
    const request = loadDlRequest({ http });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const valid = await request('GET', origin + '/info', { metadataOnly: true, maxBodyBytes: 1024 });
    assert.equal(JSON.parse(valid.body).size, 1234);
    await assert.rejects(request('GET', origin + '/redirect', { metadataOnly: true, maxBodyBytes: 1024 }), /size limit/);
    const file = await request('GET', origin + '/file', { metadataOnly: true });
    assert.equal(file.body, '');
    assert.equal(Number(file.headers['content-length']), 120 * 1024 ** 3);
});

test('torrent metadata requests preserve binary bytes across redirects and enforce the body limit', async t => {
    const bytes = Buffer.from([100, 52, 58, 105, 110, 102, 111, 0xff, 0x80, 0, 101]);
    const seenCookies = [];
    const server = http.createServer((request, response) => {
        if (request.url === '/start') {
            response.writeHead(302, { Location: `http://localhost:${server.address().port}/torrent` });
            response.end();
        } else {
            seenCookies.push(request.headers.cookie);
            response.writeHead(200, { 'Content-Type': 'application/x-bittorrent' });
            response.end(bytes);
        }
    });
    await new Promise(resolve => server.listen(0, resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const request = loadDlRequest({ http });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await request('GET', origin + '/start', {
        responseType: 'buffer', maxBodyBytes: 32, headers: { Cookie: 'test-only' }
    });
    assert.equal(Buffer.isBuffer(result.body), true);
    assert.deepEqual(result.body, bytes);
    assert.deepEqual(seenCookies, [undefined]);
    await assert.rejects(request('GET', origin + '/torrent', { responseType: 'buffer', maxBodyBytes: 4 }), /size limit/);
});

test('HTTP cancellation aborts an in-flight request after a redirect', { timeout: 10000 }, async t => {
    let received;
    const waiting = new Promise(resolve => { received = resolve; });
    const server = http.createServer((request, response) => {
        if (request.url === '/start') {
            response.writeHead(302, { Location: '/pending' });
            response.end();
        } else {
            received();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
    }));
    const controller = new AbortController();
    const dlRequest = loadDlRequest({ http });
    const attempt = dlRequest('GET', `http://127.0.0.1:${server.address().port}/start`, {
        signal: controller.signal,
        timeoutMs: 180000
    });
    const rejected = assert.rejects(attempt, error => error.name === 'AbortError');
    await waiting;
    controller.abort();
    await rejected;
});

function loadResolveDirectUrl(context) {
    const main = readMain();
    const start = main.indexOf('async function resolveDirectUrl(');
    const end = main.indexOf('function buildUnresolvedError(', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(`(${main.slice(start, end).trim()}\n)`, {
        isTorrentDownload: require('../runtime/debridTorrents').isTorrentDownload,
        resolveTorrentDownloads: async files => files,
        ...context
    });
}

function loadDebridServices(context) {
    const main = readMain();
    const assignment = 'const DEBRID = ';
    const start = main.indexOf(assignment);
    const end = main.indexOf('\nlet debridService', start);
    assert.ok(start >= 0 && end > start);
    const expression = main.slice(start + assignment.length, end).trim().replace(/;$/, '');
    return vm.runInNewContext(`(${expression})`, context);
}

function loadDebridCacheHarness(services) {
    const main = readMain();
    const start = main.indexOf("let debridService = ''");
    const end = main.indexOf("ipcMain.on('set-debrid-cache-enabled'", start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(`(() => {
        const DEBRID = services;
        ${main.slice(start, end)}
        return {
            configure(service, key) { debridService = service; debridKey = key; },
            unrestrict: debridUnrestrict,
            has: debridCacheHas
        };
    })()`, { services });
}

function loadDownloadStateFormatter() {
    const html = fs.readFileSync(indexPath, 'utf8');
    const start = html.indexOf('function cachedBadge(');
    const end = html.indexOf('// ---- Pause / Resume / Cancel', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(`(() => {
        ${html.slice(start, end)}
        return { cachedBadge, fmtState };
    })()`, {
        DownloadSizeLogic: require('../ui/downloadSizeLogic'),
        DownloadManagerLogic: {
            safeDownloadErrorMessage: () => '',
            downloadErrorNextStep: () => ''
        }
    });
}

function loadInvokeDownloadWithCurrentRoot(context) {
    const html = fs.readFileSync(indexPath, 'utf8');
    const start = html.indexOf('async function invokeDownloadWithCurrentRoot(');
    const end = html.indexOf('\n        let dlAdBlockSynced', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(`(${html.slice(start, end).trim()}\n)`, context);
}

function loadDebridValidateService(context) {
    const html = fs.readFileSync(indexPath, 'utf8');
    const start = html.indexOf('async function debridValidateService(');
    const end = html.indexOf('\n        function debridClearService(', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(`(${html.slice(start, end).trim()}\n)`, context);
}

test('each download attempt restores the connected debrid service before main starts it', async () => {
    const calls = [];
    let debridSynced = false;
    let service = 'TorBox';
    const download = { id: 'dl_restart_retry', state: 'resolving', debridService: 'TorBox' };
    const invokeDownloadWithCurrentRoot = loadInvokeDownloadWithCurrentRoot({
        window: {
            pushDebridConfigToMain() {
                debridSynced = true;
                calls.push('debrid-config');
            }
        },
        dlQueue: new Map([['dl_restart_retry', download]]),
        activeDebridName: () => service,
        refreshDownloadSizeWarnings: () => calls.push('refresh-size-warning'),
        currentDownloadRootReference: async () => {
            assert.equal(debridSynced, true);
            calls.push('download-root');
            return { rootCapabilityId: 'download-root-capability', rootExpectedRevision: 4 };
        },
        ipcRenderer: {
            async invoke(channel, payload) {
                assert.equal(debridSynced, true);
                calls.push(channel);
                assert.equal(payload.id, 'dl_restart_retry');
                assert.equal(payload.rootCapabilityId, 'download-root-capability');
                assert.equal(payload.rootExpectedRevision, 4);
                return { success: true };
            }
        }
    });

    const result = await invokeDownloadWithCurrentRoot({ id: 'dl_restart_retry' });

    assert.equal(result.success, true);
    assert.deepEqual(calls, ['debrid-config', 'refresh-size-warning', 'download-root', 'download-game']);
    assert.equal(download.requestedDebridService, 'TorBox');
    assert.equal(download.debridService, '');
    service = '';
    calls.length = 0;
    await invokeDownloadWithCurrentRoot({ id: 'dl_restart_retry' });
    assert.equal(download.requestedDebridService, '');
    assert.equal(download.debridService, '');
    assert.ok(calls.includes('refresh-size-warning'));
    assert.ok(calls.includes('download-game'));
});

test('successfully connecting TorBox selects it over a previously active provider', async () => {
    const state = {
        keys: { realdebrid: 'existing-key' },
        status: { realdebrid: { ok: true } },
        active: 'realdebrid'
    };
    const wrap = {
        querySelector(selector) {
            if (selector.startsWith('.debrid-key')) return { value: 'torbox-test-key' };
            return {};
        }
    };
    const debridValidateService = loadDebridValidateService({
        document: { getElementById: () => wrap },
        getDebridState: () => state,
        renderDebridBadge: () => {},
        renderDebridServices: () => {},
        afterDebridChange: () => {},
        ipcRenderer: {
            invoke: async () => ({ ok: true, user: 'paid-user' })
        },
        window: { debridConnected: () => true }
    });

    await debridValidateService('torbox');

    assert.equal(state.active, 'torbox');
    assert.equal(state.keys.torbox, 'torbox-test-key');
    assert.equal(state.status.torbox.ok, true);
});

test('connected debrid resolves PixelDrain before the direct host fallback', async () => {
    const sourceUrl = 'https://pixeldrain.com/u/example-file';
    const torBoxUrl = 'https://cdn.torbox.app/example-file';
    const debridCalls = [];
    let pixelDrainCalls = 0;
    const resolveDirectUrl = loadResolveDirectUrl({
        SOURCE_REFERER: { steamrip: 'https://steamrip.com/' },
        normalizeFileCryptContainerUrl: () => '',
        debridActive: () => true,
        debridUnrestrict: async url => {
            debridCalls.push(url);
            return { url: torBoxUrl, name: 'game.zip', sizeBytes: 240000000, debridService: 'TorBox', cached: true };
        },
        DL_KNOWN_HOST: /pixeldrain/i,
        scrapePixeldrain: async () => {
            pixelDrainCalls += 1;
            return [{ url: 'https://pixeldrain.com/api/file/example-file?download', kind: 'http' }];
        }
    });

    const result = await resolveDirectUrl(sourceUrl, { sourceId: 'steamrip' });

    assert.deepEqual(debridCalls, [sourceUrl]);
    assert.equal(result[0].url, torBoxUrl);
    assert.equal(result[0].name, 'game.zip');
    assert.equal(result[0].debridService, 'TorBox');
    assert.equal(result[0].debridCached, true);
    assert.equal(result[0].sizeBytes, 240000000);
    assert.equal(pixelDrainCalls, 0);
});

test('the FileCrypt-labeled GoFile route sends its revealed share through TorBox', async () => {
    const containerUrl = 'https://www.filecrypt.cc/Container/ABCDEF1234.html';
    const gofileUrl = 'https://gofile.io/d/RealShare123';
    const debridCalls = [];
    let directGofileCalls = 0;
    const resolveDirectUrl = loadResolveDirectUrl({
        SOURCE_REFERER: { steamrip: 'https://steamrip.com/' },
        normalizeFileCryptContainerUrl: value => value === containerUrl ? containerUrl : '',
        inspectDownloadLinkHealth: async () => ({ status: 'available' }),
        HEALTH_STATES: { DOWN: 'down' },
        buildLinkDownError: () => new Error('Link is down'),
        scrapeSteamRipGofileContainer: async (value, referer, onGofileShare) => {
            assert.equal(value, containerUrl);
            assert.equal(referer, 'https://steamrip.com/');
            return onGofileShare(gofileUrl);
        },
        debridActive: () => true,
        debridUnrestrict: async value => {
            debridCalls.push(value);
            return {
                url: 'https://cdn.torbox.app/real-share',
                name: 'game.zip',
                sizeBytes: 240000000,
                debridService: 'TorBox',
                debridServiceId: 'torbox',
                cached: false
            };
        },
        scrapeGofile: async () => {
            directGofileCalls += 1;
            return [{ url: 'https://store.gofile.io/direct-fallback', kind: 'http' }];
        }
    });

    const result = await resolveDirectUrl(containerUrl, { sourceId: 'steamrip' });

    assert.deepEqual(debridCalls, [gofileUrl]);
    assert.equal(directGofileCalls, 0);
    assert.equal(result[0].url, 'https://cdn.torbox.app/real-share');
    assert.equal(result[0].debridService, 'TorBox');
    assert.equal(result[0].debridServiceId, 'torbox');
    assert.equal(result[0].sizeBytes, 240000000);
});

test('the FileCrypt-backed GoFile route surfaces a fatal TorBox rejection instead of falling back direct', async () => {
    const containerUrl = 'https://www.filecrypt.cc/Container/ABCDEF1234.html';
    const gofileUrl = 'https://gofile.io/d/RealShare123';
    const torboxError = Object.assign(new Error('TorBox rejected this GoFile share.'), {
        debridResolutionFatal: true
    });
    let directGofileCalls = 0;
    const resolveDirectUrl = loadResolveDirectUrl({
        SOURCE_REFERER: { steamrip: 'https://steamrip.com/' },
        normalizeFileCryptContainerUrl: value => value === containerUrl ? containerUrl : '',
        inspectDownloadLinkHealth: async () => ({ status: 'available' }),
        HEALTH_STATES: { DOWN: 'down' },
        buildLinkDownError: () => new Error('Link is down'),
        scrapeSteamRipGofileContainer: async (value, referer, onGofileShare) => {
            assert.equal(value, containerUrl);
            assert.equal(referer, 'https://steamrip.com/');
            return onGofileShare(gofileUrl);
        },
        debridActive: () => true,
        debridUnrestrict: async value => {
            assert.equal(value, gofileUrl);
            throw torboxError;
        },
        scrapeGofile: async () => {
            directGofileCalls += 1;
            return [{ url: 'https://store.gofile.io/direct-fallback', kind: 'http' }];
        }
    });

    await assert.rejects(
        () => resolveDirectUrl(containerUrl, { sourceId: 'steamrip' }),
        error => error === torboxError
    );
    assert.equal(directGofileCalls, 0);
});

test('DataNodes sends its original landing URL to TorBox without local resolution', async () => {
    const landingUrl = 'https://datanodes.to/Abc12345/Game.rar';
    const debridCalls = [];
    let scraperCalls = 0;
    const resolveDirectUrl = loadResolveDirectUrl({
        SOURCE_REFERER: {},
        normalizeFileCryptContainerUrl: () => '',
        debridActive: () => true,
        scrapeDatanodes: async () => { scraperCalls += 1; return []; },
        resolveWithManagedHostBrowser: async () => { scraperCalls += 1; return null; },
        debridUnrestrict: async (url, options) => {
            debridCalls.push({ url, options });
            return {
                url: 'https://cdn.torbox.app/datanodes-game',
                name: 'Game.rar',
                debridService: 'TorBox',
                debridServiceId: 'torbox',
                cached: false
            };
        },
        HEALTH_STATES: { DOWN: 'down' }
    });

    const result = await resolveDirectUrl(landingUrl, {
        sourceId: 'steamgg'
    });

    assert.equal(scraperCalls, 0);
    assert.equal(debridCalls.length, 1);
    assert.equal(debridCalls[0].url, landingUrl);
    assert.equal(result[0].url, 'https://cdn.torbox.app/datanodes-game');
    assert.equal(result[0].debridService, 'TorBox');
});

test('DataNodes resolves directly when no debrid service is connected', async () => {
    const landingUrl = 'https://datanodes.to/Cookie123/Game.rar';
    const signedUrl = 'https://datanodes.to/files/Game.rar?token=browser-bound';
    let debridCalls = 0;
    const resolveDirectUrl = loadResolveDirectUrl({
        SOURCE_REFERER: {},
        normalizeFileCryptContainerUrl: () => '',
        debridActive: () => false,
        DL_KNOWN_HOST: /datanodes/i,
        scrapeDatanodes: async () => [{
            url: signedUrl,
            kind: 'http',
            name: 'Game.rar',
            headers: ['Cookie: file_code=private-browser-value']
        }],
        resolveWithManagedHostBrowser: async () => null,
        debridUnrestrict: async () => {
            debridCalls += 1;
            return null;
        },
        HEALTH_STATES: { DOWN: 'down' }
    });

    const result = await resolveDirectUrl(landingUrl, { sourceId: 'steamrip' });

    assert.equal(debridCalls, 0);
    assert.equal(result[0].url, signedUrl);
    assert.match(result[0].headers[0], /^Cookie:/);
});

test('DataNodes surfaces TorBox rejection without falling back to its validated file', async () => {
    const landingUrl = 'https://datanodes.to/Unsupported123/Game.rar';
    const signedFile = {
        url: 'https://storage.downloads.example/files/Game.rar?token=short-lived',
        kind: 'http',
        name: 'Game.rar',
        headers: ['Referer: https://datanodes.to/download']
    };
    const labels = [];
    const unsupported = Object.assign(
        new Error('TorBox could not accept this file: The site you are trying to download from is not supported.'),
        { debridResolutionFatal: true, torboxCode: 'DOWNLOAD_LINK_HOST_NOT_SUPPORTED' }
    );
    const resolveDirectUrl = loadResolveDirectUrl({
        SOURCE_REFERER: {},
        normalizeFileCryptContainerUrl: () => '',
        debridActive: () => true,
        scrapeDatanodes: async () => [signedFile],
        resolveWithManagedHostBrowser: async () => null,
        debridUnrestrict: async () => { throw unsupported; },
        HEALTH_STATES: { DOWN: 'down' }
    });

    await assert.rejects(
        () => resolveDirectUrl(landingUrl, { sourceId: 'steamgg', onProgress: label => labels.push(label) }),
        error => error === unsupported
    );
    assert.ok(!labels.some(label => /downloading the validated file directly/i.test(label)));
});

test('DataNodes still surfaces unrelated fatal TorBox errors', async () => {
    const fatal = Object.assign(new Error('TorBox rejected the connected API key.'), {
        debridResolutionFatal: true,
        torboxCode: 'BAD_TOKEN'
    });
    const resolveDirectUrl = loadResolveDirectUrl({
        SOURCE_REFERER: {},
        normalizeFileCryptContainerUrl: () => '',
        debridActive: () => true,
        scrapeDatanodes: async () => [{
            url: 'https://storage.downloads.example/Game.rar?token=short-lived',
            kind: 'http',
            name: 'Game.rar'
        }],
        resolveWithManagedHostBrowser: async () => null,
        debridUnrestrict: async () => { throw fatal; },
        HEALTH_STATES: { DOWN: 'down' }
    });

    await assert.rejects(
        () => resolveDirectUrl('https://datanodes.to/Fatal123/Game.rar', { sourceId: 'steamgg' }),
        error => error === fatal
    );
});

test('TorBox creates a web download and polls fresh state before requesting its CDN URL', async () => {
    const sourceUrl = 'https://pixeldrain.com/u/example-file';
    const apiKey = 'torbox-test-key';
    const calls = [];
    const dlRequest = async (method, url, options = {}) => {
        calls.push({ method, url, options });
        if (url.endsWith('/webdl/createwebdownload')) {
            return { status: 200, body: JSON.stringify({
                success: true,
                data: { webdownload_id: 42 }
            }) };
        }
        if (url.includes('/webdl/mylist?')) {
            return { status: 200, body: JSON.stringify({
                success: true,
                data: {
                    id: 42,
                    download_present: true,
                    download_finished: true,
                    files: [{ id: 7, name: 'game.zip', size: 240000000 }]
                }
            }) };
        }
        if (url.includes('/webdl/requestdl?')) {
            return { status: 200, body: JSON.stringify({
                success: true,
                data: 'https://cdn.torbox.app/example-file'
            }) };
        }
        throw new Error(`Unexpected TorBox request: ${method} ${url}`);
    };
    const debrid = loadDebridServices({ dlRequest, setTimeout });

    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    const labels = [];
    const result = await debrid.torbox.unrestrict(apiKey, sourceUrl, {
        signal,
        onProgress: label => labels.push(label)
    });

    assert.equal(result.url, 'https://cdn.torbox.app/example-file');
    assert.equal(result.name, 'game.zip');
    assert.equal(result.sizeBytes, 240000000);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].options.body, `link=${encodeURIComponent(sourceUrl)}`);
    assert.equal(calls[1].method, 'GET');
    assert.match(calls[1].url, /mylist\?id=42&bypass_cache=true$/);
    assert.equal(calls[2].method, 'GET');
    assert.match(calls[2].url, /requestdl\?token=torbox-test-key&web_id=42&file_id=7$/);
    for (const call of calls) {
        assert.equal(call.options.headers.Authorization, `Bearer ${apiKey}`);
        assert.equal(call.options.follow, false);
        assert.equal(call.options.signal, signal);
    }
    assert.equal(calls[0].options.timeoutMs, 180000);
    assert.ok(labels.some(label => /checking the source link/i.test(label)));
});

test('TorBox reports structured create errors immediately without polling', async () => {
    const calls = [];
    const dlRequest = async (method, url, options = {}) => {
        calls.push({ method, url, options });
        return { status: 500, body: JSON.stringify({
            success: false,
            error: 'DOWNLOAD_SERVER_ERROR',
            detail: 'There was an error scanning this link. The download link could not be determined.'
        }) };
    };
    const debrid = loadDebridServices({ dlRequest, setTimeout });

    await assert.rejects(
        () => debrid.torbox.unrestrict('torbox-test-key', 'https://datanodes.to/Abc12345/Game.rar'),
        error => {
            assert.match(error.message, /error scanning this link/i);
            assert.match(error.message, /download link could not be determined/i);
            assert.equal(error.torboxCode, 'DOWNLOAD_SERVER_ERROR');
            assert.equal(error.debridRejected, true);
            assert.doesNotMatch(error.message, /stopped responding|timed out/i);
            assert.doesNotMatch(error.message, /could not accept this file: TorBox could not accept/i);
            return true;
        }
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /createwebdownload$/);
});

test('TorBox does not poll or report acceptance when create succeeds without a job ID', async () => {
    const labels = [];
    let calls = 0;
    const debrid = loadDebridServices({
        dlRequest: async () => {
            calls += 1;
            return { status: 200, body: JSON.stringify({ success: true, data: null }) };
        },
        setTimeout
    });

    await assert.rejects(
        () => debrid.torbox.unrestrict('torbox-test-key', 'https://datanodes.to/Abc12345/Game.rar', {
            onProgress: label => labels.push(label)
        }),
        /did not return a web download ID/i
    );
    assert.equal(calls, 1);
    assert.ok(!labels.some(label => /accepted the file/i.test(label)));
});

test('TorBox forwards cancellation signals to create, list, and requestdl calls', async () => {
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    const calls = [];
    const dlRequest = async (method, url, options = {}) => {
        calls.push({ method, url, options });
        if (url.endsWith('/webdl/createwebdownload')) return { status: 200, body: JSON.stringify({ success: true, data: { webdownload_id: 501 } }) };
        if (url.includes('/webdl/mylist?')) return { status: 200, body: JSON.stringify({ success: true, data: { id: 501, download_present: true, download_finished: true, files: [{ id: 2, name: 'file.zip' }] } }) };
        return { status: 200, body: JSON.stringify({ success: true, data: 'https://cdn.torbox.app/file' }) };
    };
    const debrid = loadDebridServices({ dlRequest, setTimeout });
    await debrid.torbox.unrestrict('torbox-test-key', 'https://datanodes.to/Abc12345/Game.rar', { signal });
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.options.signal === signal));
});

test('TorBox uses its ID-returning create route for an original DataNodes landing URL', async () => {
    const landingUrl = 'https://datanodes.to/Abc12345/Game.rar';
    const calls = [];
    const dlRequest = async (method, url, options = {}) => {
        calls.push({ method, url, options });
        if (url.endsWith('/webdl/createwebdownload')) {
            return { status: 200, body: JSON.stringify({
                success: true,
                data: { webdownload_id: 314 }
            }) };
        }
        if (url.includes('/webdl/mylist?')) {
            return { status: 200, body: JSON.stringify({
                success: true,
                data: {
                    id: 314,
                    download_present: true,
                    download_finished: true,
                    files: [{ id: 9, name: 'Game.rar' }]
                }
            }) };
        }
        if (url.includes('/webdl/requestdl?')) {
            return { status: 200, body: JSON.stringify({
                success: true,
                data: 'https://cdn.torbox.app/datanodes-game'
            }) };
        }
        throw new Error(`Unexpected TorBox request: ${method} ${url}`);
    };
    const debrid = loadDebridServices({ dlRequest, setTimeout });

    const result = await debrid.torbox.unrestrict('torbox-test-key', landingUrl);

    assert.equal(result.url, 'https://cdn.torbox.app/datanodes-game');
    assert.equal(result.name, 'Game.rar');
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/webdl\/createwebdownload$/);
    assert.equal(calls[0].options.body, `link=${encodeURIComponent(landingUrl)}`);
    assert.match(calls[1].url, /mylist\?id=314&bypass_cache=true$/);
    assert.match(calls[2].url, /requestdl\?token=torbox-test-key&web_id=314&file_id=9$/);
});

test('TorBox waits for its source fetch to finish before requesting the CDN URL', async () => {
    const sourceUrl = 'https://pixeldrain.com/u/slow-file';
    const calls = [];
    const labels = [];
    let listPolls = 0;
    const dlRequest = async (method, url, options = {}) => {
        calls.push({ method, url, options });
        if (url.endsWith('/webdl/createwebdownload')) {
            return { status: 200, body: JSON.stringify({ success: true, data: { webdownload_id: 91 } }) };
        }
        if (url.includes('/webdl/mylist?')) {
            listPolls += 1;
            return { status: 200, body: JSON.stringify({
                success: true,
                data: {
                    id: 91,
                    download_present: true,
                    download_finished: listPolls > 1,
                    cached: true,
                    progress: listPolls > 1 ? 1 : 0.5,
                    files: [{ id: 3, name: 'slow-game.zip' }]
                }
            }) };
        }
        if (url.includes('/webdl/requestdl?')) {
            assert.equal(listPolls, 2, 'CDN URL must not be requested while TorBox is still fetching');
            return { status: 200, body: JSON.stringify({ success: true, data: 'https://cdn.torbox.app/slow-file' }) };
        }
        throw new Error(`Unexpected TorBox request: ${method} ${url}`);
    };
    const immediateTimeout = fn => { fn(); return 1; };
    const debrid = loadDebridServices({
        dlRequest,
        setTimeout: immediateTimeout,
        clearTimeout: () => {}
    });

    const result = await debrid.torbox.unrestrict('torbox-test-key', sourceUrl, {
        onProgress: label => labels.push(label)
    });

    assert.equal(result.url, 'https://cdn.torbox.app/slow-file');
    assert.equal(listPolls, 2);
    assert.equal(calls.filter(call => call.url.includes('/webdl/requestdl?')).length, 1);
    assert.ok(labels.some(label => /50%/.test(label)));
    assert.ok(labels.some(label => /TorBox is ready/.test(label)));
});

test('direct retries bypass cached debrid links without changing another download', async () => {
    const calls = [];
    const harness = loadDebridCacheHarness({ torbox: {
        name: 'TorBox',
        async unrestrict(key, link) {
            calls.push(link);
            return { url: 'https://cdn.example/file.zip', name: 'file.zip' };
        }
    } });
    harness.configure('torbox', 'fixture-key');
    const link = 'https://gofile.io/d/example';
    await harness.unrestrict(link);
    assert.equal(await harness.unrestrict(link, { skipDebrid: true }), null);
    assert.equal(await harness.unrestrict('https://gofile.io/d/uncached', { skipDebrid: true }), null);
    assert.equal(calls.length, 1);
    assert.equal((await harness.unrestrict(link)).cached, true);
    await harness.unrestrict('https://gofile.io/d/other');
    assert.equal(calls.length, 2);
});

test('provider rejections carry service identity while cancellation stays unmarked', async () => {
    const failure = Object.assign(new Error('Provider rejected the link'), { debridResolutionFatal: true, debridRejected: true });
    const harness = loadDebridCacheHarness({ torbox: {
        name: 'TorBox', async unrestrict() { throw failure; }
    } });
    harness.configure('torbox', 'fixture-key');
    await assert.rejects(harness.unrestrict('https://gofile.io/d/example'), error => {
        assert.equal(error.debridFailure, true);
        assert.equal(error.failedDebridService, 'TorBox');
        assert.equal(error.debridRejected, true);
        return true;
    });
    const abort = Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    const cancelled = loadDebridCacheHarness({ torbox: { name: 'TorBox', async unrestrict() { throw abort; } } });
    cancelled.configure('torbox', 'fixture-key');
    await assert.rejects(cancelled.unrestrict('https://gofile.io/d/example'), error => {
        assert.equal(error.debridFailure, undefined);
        return error === abort;
    });
});

test('GoFile direct retries preserve host headers and size for shares and FileCrypt containers', async () => {
    const share = 'https://gofile.io/d/example';
    const container = 'https://www.filecrypt.cc/Container/ABCDEF1234.html';
    const direct = [{ url: 'https://store.gofile.io/download/fixture/game.zip', name: 'game.zip', kind: 'http', sizeBytes: 123456,
        headers: ['Cookie: accountToken=fixture-only'] }];
    const calls = [];
    const resolve = loadResolveDirectUrl({
        SOURCE_REFERER: {},
        normalizeFileCryptContainerUrl: url => url === container ? container : '',
        inspectDownloadLinkHealth: async () => ({ status: 'available' }),
        HEALTH_STATES: { DOWN: 'down' },
        scrapeSteamRipGofileContainer: async (url, referer, callback) => callback(share),
        debridActive: () => true,
        debridUnrestrict: () => { throw new Error('Direct retry contacted debrid'); },
        DL_KNOWN_HOST: /gofile/i,
        scrapeGofile: async url => { calls.push(url); return direct; }
    });
    for (const url of [share, container]) {
        assert.equal(await resolve(url, { skipDebrid: true, sourceId: 'steamrip' }), direct);
    }
    assert.deepEqual(calls, [share, share]);
});

test('unreadable create responses do not claim the provider explicitly rejected the link', async () => {
    const services = loadDebridServices({ dlRequest: async () => ({ status: 502, body: '<html>Gateway unavailable</html>' }), setTimeout });
    await assert.rejects(services.torbox.unrestrict('fixture-key', 'https://gofile.io/d/example'), error => {
        assert.equal(error.debridRejected, false);
        assert.match(error.message, /unreadable response/);
        return true;
    });
});

test('repeat debrid resolutions keep the cached TorBox link and identify its provider', async () => {
    let providerCalls = 0;
    const harness = loadDebridCacheHarness({
        torbox: {
            name: 'TorBox',
            async unrestrict() {
                providerCalls += 1;
                return { url: 'https://cdn.torbox.app/cached-file', name: 'game.zip', sizeBytes: 240000000 };
            }
        }
    });
    harness.configure('torbox', 'torbox-test-key');

    const first = await harness.unrestrict('https://pixeldrain.com/u/cached-file');
    const second = await harness.unrestrict('https://pixeldrain.com/u/cached-file');

    assert.equal(providerCalls, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.debridService, 'TorBox');
    assert.equal(first.sizeBytes, 240000000);
    assert.equal(second.sizeBytes, 240000000);
    assert.equal(harness.has('https://pixeldrain.com/u/cached-file'), true);
});

test('DataNodes cache stays keyed to its original landing URL', async () => {
    const receivedUrls = [];
    const harness = loadDebridCacheHarness({
        torbox: {
            name: 'TorBox',
            async unrestrict(key, url) {
                receivedUrls.push(url);
                return { url: 'https://cdn.torbox.app/cached-datanodes-file', name: 'game.rar' };
            }
        }
    });
    harness.configure('torbox', 'torbox-test-key');
    const landingUrl = 'https://datanodes.to/Cache123/game.rar';

    const first = await harness.unrestrict(landingUrl);
    const second = await harness.unrestrict(landingUrl);

    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(receivedUrls, [landingUrl]);
    assert.equal(harness.has(landingUrl), true);
});

test('download status explicitly identifies a cached TorBox transfer', () => {
    const { fmtState } = loadDownloadStateFormatter();
    const state = fmtState({
        state: 'downloading',
        percent: 42,
        downloaded: '4.2 GB',
        total: '10 GB',
        speed: '25 MB',
        eta: '4m',
        cached: true,
        debridService: 'TorBox'
    });

    assert.match(state, /Cached TorBox link/);
    assert.match(state, /Downloading game via TorBox/);
});

test('TorBox selects the requested job from list responses and preserves large IDs', async () => {
    const sourceUrl = 'https://gofile.io/d/requested-file';
    const webId = '90071992547409931234';
    let requestedDownloadUrl = '';
    const dlRequest = async (method, url) => {
        if (url.endsWith('/webdl/createwebdownload')) {
            return { status: 200, body: JSON.stringify({ success: true, data: { webdownload_id: webId } }) };
        }
        if (url.includes('/webdl/mylist?')) {
            return { status: 200, body: JSON.stringify({
                success: true,
                data: [
                    {
                        id: 1,
                        download_present: true,
                        download_finished: true,
                        files: [{ id: 99, name: 'wrong-file.zip' }]
                    },
                    {
                        id: webId,
                        download_present: true,
                        download_finished: true,
                        files: [{ id: 7, name: 'requested-file.zip' }]
                    }
                ]
            }) };
        }
        if (url.includes('/webdl/requestdl?')) {
            requestedDownloadUrl = url;
            return { status: 200, body: JSON.stringify({
                success: true,
                data: 'https://cdn.torbox.app/requested-file'
            }) };
        }
        throw new Error(`Unexpected TorBox request: ${method} ${url}`);
    };
    const debrid = loadDebridServices({ dlRequest, setTimeout });

    const result = await debrid.torbox.unrestrict('torbox-test-key', sourceUrl);

    assert.equal(result.name, 'requested-file.zip');
    assert.match(requestedDownloadUrl, new RegExp(`web_id=${webId}&file_id=7$`));
    assert.doesNotMatch(requestedDownloadUrl, /file_id=99/);
});

test('TorBox treats an initially empty job list as pending instead of an API failure', async () => {
    let listPolls = 0;
    const dlRequest = async (method, url) => {
        if (url.endsWith('/webdl/createwebdownload')) {
            return { status: 200, body: JSON.stringify({ success: true, data: { webdownload_id: 77 } }) };
        }
        if (url.includes('/webdl/mylist?')) {
            listPolls += 1;
            if (listPolls <= 13) {
                return { status: 200, body: JSON.stringify({ success: true, data: [] }) };
            }
            return { status: 200, body: JSON.stringify({
                success: true,
                data: {
                    id: 77,
                    download_present: true,
                    download_finished: true,
                    files: [{ id: 5, name: 'eventual-file.zip' }]
                }
            }) };
        }
        if (url.includes('/webdl/requestdl?')) {
            return { status: 200, body: JSON.stringify({ success: true, data: 'https://cdn.torbox.app/eventual-file' }) };
        }
        throw new Error(`Unexpected TorBox request: ${method} ${url}`);
    };
    const immediateTimeout = fn => { fn(); return 1; };
    const debrid = loadDebridServices({
        dlRequest,
        setTimeout: immediateTimeout,
        clearTimeout: () => {}
    });

    const result = await debrid.torbox.unrestrict('torbox-test-key', 'https://gofile.io/d/eventual-file');

    assert.equal(result.url, 'https://cdn.torbox.app/eventual-file');
    assert.equal(listPolls, 14);
});

test('TorBox surfaces structured API errors instead of reporting a timeout', async () => {
    const dlRequest = async (method, url) => {
        if (url.endsWith('/webdl/createwebdownload')) {
            return { status: 200, body: JSON.stringify({ success: true, data: { webdownload_id: 88 } }) };
        }
        if (url.includes('/webdl/mylist?')) {
            return { status: 400, body: JSON.stringify({
                success: false,
                error: 'ACTIVE_LIMIT',
                detail: 'Your active download limit has been reached.'
            }) };
        }
        throw new Error(`Unexpected TorBox request: ${method} ${url}`);
    };
    const debrid = loadDebridServices({ dlRequest, setTimeout });

    await assert.rejects(
        () => debrid.torbox.unrestrict('torbox-test-key', 'https://gofile.io/d/over-limit'),
        error => {
            assert.match(error.message, /active download limit has been reached/i);
            assert.doesNotMatch(error.message, /stopped responding/i);
            return true;
        }
    );
});

test('TorBox waits for file metadata instead of requesting file ID zero', async () => {
    let listPolls = 0;
    const requestedFileIds = [];
    const dlRequest = async (method, url) => {
        if (url.endsWith('/webdl/createwebdownload')) {
            return { status: 200, body: JSON.stringify({ success: true, data: { webdownload_id: 66 } }) };
        }
        if (url.includes('/webdl/mylist?')) {
            listPolls += 1;
            return { status: 200, body: JSON.stringify({
                success: true,
                data: {
                    id: 66,
                    download_present: true,
                    download_finished: true,
                    files: listPolls === 1 ? [] : [{ id: 12, name: 'metadata-file.zip' }]
                }
            }) };
        }
        if (url.includes('/webdl/requestdl?')) {
            requestedFileIds.push(new URL(url).searchParams.get('file_id'));
            return { status: 200, body: JSON.stringify({ success: true, data: 'https://cdn.torbox.app/metadata-file' }) };
        }
        throw new Error(`Unexpected TorBox request: ${method} ${url}`);
    };
    const immediateTimeout = fn => { fn(); return 1; };
    const debrid = loadDebridServices({
        dlRequest,
        setTimeout: immediateTimeout,
        clearTimeout: () => {},
        URL
    });

    const result = await debrid.torbox.unrestrict('torbox-test-key', 'https://gofile.io/d/metadata-file');

    assert.equal(result.name, 'metadata-file.zip');
    assert.deepEqual(requestedFileIds, ['12']);
    assert.equal(listPolls, 2);
});

test('retry continues an accepted TorBox job without creating a duplicate', async () => {
    let createCalls = 0;
    let listPolls = 0;
    const dlRequest = async (method, url) => {
        if (url.endsWith('/webdl/createwebdownload')) {
            createCalls += 1;
            return { status: 200, body: JSON.stringify({ success: true, data: { webdownload_id: 101 } }) };
        }
        if (url.includes('/webdl/mylist?')) {
            listPolls += 1;
            if (listPolls <= 12) return { status: 502, body: '<html>temporary gateway error</html>' };
            return { status: 200, body: JSON.stringify({
                success: true,
                data: {
                    id: 101,
                    download_present: true,
                    download_finished: true,
                    files: [{ id: 4, name: 'resumed-file.zip' }]
                }
            }) };
        }
        if (url.includes('/webdl/requestdl?')) {
            return { status: 200, body: JSON.stringify({ success: true, data: 'https://cdn.torbox.app/resumed-file' }) };
        }
        throw new Error(`Unexpected TorBox request: ${method} ${url}`);
    };
    const immediateTimeout = fn => { fn(); return 1; };
    const debrid = loadDebridServices({
        dlRequest,
        setTimeout: immediateTimeout,
        clearTimeout: () => {}
    });
    const sourceUrl = 'https://gofile.io/d/resumed-file';

    await assert.rejects(
        () => debrid.torbox.unrestrict('torbox-test-key', sourceUrl),
        /continue the existing TorBox job/i
    );
    const result = await debrid.torbox.unrestrict('torbox-test-key', sourceUrl);

    assert.equal(result.url, 'https://cdn.torbox.app/resumed-file');
    assert.equal(createCalls, 1);
    assert.equal(listPolls, 13);
});

test('DataNodes retry reuses the accepted TorBox job for the original landing URL', async () => {
    const landingUrl = 'https://datanodes.to/Retry123/Game.rar';
    let createCalls = 0;
    const createBodies = [];
    let listPolls = 0;
    const dlRequest = async (method, url, options = {}) => {
        if (url.endsWith('/webdl/createwebdownload')) {
            createCalls += 1;
            createBodies.push(options.body);
            return { status: 200, body: JSON.stringify({ success: true, data: { webdownload_id: 202 } }) };
        }
        if (url.includes('/webdl/mylist?')) {
            listPolls += 1;
            if (listPolls <= 12) return { status: 502, body: '<html>temporary gateway error</html>' };
            return { status: 200, body: JSON.stringify({
                success: true,
                data: {
                    id: 202,
                    download_present: true,
                    download_finished: true,
                    files: [{ id: 8, name: 'Game.rar' }]
                }
            }) };
        }
        if (url.includes('/webdl/requestdl?')) {
            return { status: 200, body: JSON.stringify({ success: true, data: 'https://cdn.torbox.app/datanodes-resumed' }) };
        }
        throw new Error(`Unexpected TorBox request: ${method} ${url}`);
    };
    const immediateTimeout = fn => { fn(); return 1; };
    const debrid = loadDebridServices({
        dlRequest,
        setTimeout: immediateTimeout,
        clearTimeout: () => {}
    });

    await assert.rejects(
        () => debrid.torbox.unrestrict('torbox-test-key', landingUrl),
        /continue the existing TorBox job/i
    );
    const result = await debrid.torbox.unrestrict('torbox-test-key', landingUrl);

    assert.equal(result.url, 'https://cdn.torbox.app/datanodes-resumed');
    assert.equal(createCalls, 1);
    assert.deepEqual(createBodies, [`link=${encodeURIComponent(landingUrl)}`]);
    assert.equal(listPolls, 13);
});
