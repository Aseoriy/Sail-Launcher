'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const zlib = require('node:zlib');
const { createRemoteDataClient } = require('../ui/remoteJson');
const {
    buildOperationContext,
    createRemoteDataService,
    isPublicAddress,
    registerRemoteDataIpc
} = require('../security/remoteData');

function fakeNetwork(routes, options = {}) {
    const calls = [];
    const timeoutCalls = [];
    let routeIndex = 0;
    const lookup = options.lookup || (async () => [{ address: '93.184.216.34', family: 4 }]);
    function request(requestOptions, onResponse) {
        calls.push(requestOptions);
        const requestEmitter = new EventEmitter();
        requestEmitter.setTimeout = milliseconds => { timeoutCalls.push(milliseconds); };
        requestEmitter.destroy = error => {
            requestEmitter.destroyed = true;
            if (error) queueMicrotask(() => requestEmitter.emit('error', error));
        };
        requestEmitter.end = () => {
            requestOptions.lookup(requestOptions.hostname, { all: true }, (_error, resolved, family) => {
                const selected = Array.isArray(resolved) ? resolved[0] : { address: resolved, family };
                const route = routes[Math.min(routeIndex++, routes.length - 1)] || {};
                const socket = new EventEmitter();
                socket.connecting = true;
                socket.remoteAddress = route.remoteAddress || selected.address;
                requestEmitter.emit('socket', socket);
                queueMicrotask(() => {
                    if (route.connectHang || requestEmitter.destroyed) return;
                    socket.connecting = false;
                    socket.emit('secureConnect');
                    if (route.hang || requestEmitter.destroyed) return;
                    const respond = () => {
                        if (requestEmitter.destroyed) return;
                        const response = new EventEmitter();
                        response.statusCode = route.status === undefined ? 200 : route.status;
                        response.headers = route.headers || { 'content-type': 'application/json' };
                        response.resume = () => {};
                        onResponse(response);
                        for (const chunk of route.chunks || [route.body === undefined ? '{"ok":true}' : route.body]) {
                            if (requestEmitter.destroyed) break;
                            response.emit('data', chunk);
                        }
                        if (!requestEmitter.destroyed) response.emit('end');
                    };
                    if (route.responseDelayMs) setTimeout(respond, route.responseDelayMs);
                    else respond();
                });
            });
        };
        return requestEmitter;
    }
    return { calls, lookup, request, timeoutCalls };
}

async function executeWith(routes, payload, options = {}) {
    const network = fakeNetwork(routes, options);
    const service = createRemoteDataService({
        lookup: network.lookup,
        request: network.request,
        maxCompressedBytes: options.maxCompressedBytes,
        maxDecodedBytes: options.maxDecodedBytes,
        maxRedirects: options.maxRedirects,
        connectTimeoutMs: options.connectTimeoutMs,
        totalTimeoutMs: options.totalTimeoutMs,
        workerStageDelays: options.workerStageDelays
    });
    return { result: await service.execute(payload), calls: network.calls };
}

test('typed operations construct only the intended HTTPS destinations', () => {
    const key = 'a'.repeat(32);
    const cases = [
        [{ operation: 'steam.searchApps', query: 'Portal 2' }, 'https://steamcommunity.com/actions/SearchApps/Portal%202'],
        [{ operation: 'steam.friendList', apiKey: key, steamId: '76561198000000000' }, 'https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=' + key + '&steamid=76561198000000000&relationship=friend'],
        [{ operation: 'steam.playerSummaries', apiKey: key, steamIds: ['76561198000000000'] }, 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=' + key + '&steamids=76561198000000000'],
        [{ operation: 'steam.appDetails', appId: '620', language: 'english' }, 'https://store.steampowered.com/api/appdetails?appids=620&l=english'],
        [{ operation: 'steam.storeSearch', query: 'Portal 2' }, 'https://store.steampowered.com/api/storesearch/?term=Portal+2&l=english&cc=US'],
        [{ operation: 'source.search', source: 'fitgirl', query: 'Portal 2' }, 'https://fitgirl-repacks.site/wp-json/wp/v2/posts?search=Portal+2&search_columns%5B%5D=post_title&categories=5&per_page=12&_fields=id%2Ctype%2Clink%2Ctitle%2Ccategories'],
        [{ operation: 'source.search', source: 'fitgirl', query: 'Portal 2', page: 3 }, 'https://fitgirl-repacks.site/wp-json/wp/v2/posts?search=Portal+2&search_columns%5B%5D=post_title&categories=5&per_page=12&_fields=id%2Ctype%2Clink%2Ctitle%2Ccategories&page=3'],
        [{ operation: 'source.fitgirlCovers', query: 'Portal 2', page: 3 }, 'https://fitgirl-repacks.site/wp-json/wp/v2/posts?search=Portal+2&search_columns%5B%5D=post_title&categories=5&per_page=12&_fields=id%2Clink%2Ccontent&page=3'],
        [{ operation: 'source.search', source: 'steamgg', query: 'Portal 2' }, 'https://steamgg.net/wp-json/wp/v2/posts?search=Portal+2&per_page=12&_embed=1'],
        [{ operation: 'source.search', source: 'steamgg', query: 'Portal 2', page: 2 }, 'https://steamgg.net/wp-json/wp/v2/posts?search=Portal+2&per_page=12&_embed=1&page=2'],
        [{ operation: 'source.search', source: 'steamrip', query: 'Portal 2' }, 'https://steamrip.com/?s=Portal+2'],
        [{ operation: 'source.search', source: 'steamrip', query: 'Portal 2', page: 17 }, 'https://steamrip.com/page/17/?s=Portal+2']
    ];
    for (const [payload, expected] of cases) {
        assert.equal(buildOperationContext(payload, () => null).url.href, expected);
    }
});

test('renderer client has no raw URL form and sends only typed operation objects', async () => {
    const calls = [];
    const client = createRemoteDataClient({
        async invoke(channel, payload) {
            calls.push({ channel, payload });
            return { ok: true, data: { items: [] } };
        }
    });
    assert.deepEqual(Object.keys(client).sort(), [
        'getDownloadSourceDetail', 'getFitGirlSearchCovers', 'getSteamAppDetails', 'getSteamFriendList',
        'getSteamPlayerSummaries', 'searchDownloadSource', 'searchSteamApps', 'searchSteamStore'
    ]);
    await client.searchSteamApps('Portal');
    await client.searchDownloadSource('steamrip', 'Escape', 3);
    assert.deepEqual(calls, [
        { channel: 'remote-data', payload: { operation: 'steam.searchApps', query: 'Portal' } },
        { channel: 'remote-data', payload: { operation: 'source.search', source: 'steamrip', query: 'Escape', page: 3 } }
    ]);
    assert.equal(Object.values(client).some(value => typeof value === 'function' && /url/i.test(value.name)), false);
});

test('renderer client coalesces duplicate source searches and cover enrichment', async () => {
    const calls = [];
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const client = createRemoteDataClient({
        invoke(channel, payload) {
            calls.push({ channel, payload });
            return pending;
        }
    });
    const searches = [
        client.searchDownloadSource('fitgirl', 'Portal', 1),
        client.searchDownloadSource('fitgirl', 'Portal', 1)
    ];
    const covers = [
        client.getFitGirlSearchCovers('Portal', 1),
        client.getFitGirlSearchCovers('Portal', 1)
    ];
    assert.equal(calls.length, 2);
    release({ ok: true, data: [] });
    await Promise.all([...searches, ...covers]);
    assert.deepEqual(calls.map(call => call.payload.operation).sort(), ['source.fitgirlCovers', 'source.search']);
});

test('raw URLs, extra keys, malformed IDs, and arbitrary source values fail before DNS or network', async () => {
    let lookups = 0;
    const network = fakeNetwork([], { lookup: async () => { lookups += 1; return [{ address: '93.184.216.34', family: 4 }]; } });
    const service = createRemoteDataService({ lookup: network.lookup, request: network.request });
    const rejected = [
        { operation: 'steam.searchApps', query: 'Portal', url: 'https://evil.example/' },
        { operation: 'steam.searchApps', query: 'Portal', host: 'evil.example' },
        { operation: 'source.search', source: 'localhost', query: 'Portal' },
        { operation: 'source.search', source: 'steamrip', query: 'Portal', page: 0 },
        { operation: 'source.search', source: 'steamrip', query: 'Portal', page: 1001 },
        { operation: 'source.search', source: 'steamrip', query: 'Portal', page: '2' },
        { operation: 'steam.appDetails', appId: '../etc/passwd' },
        { operation: 'source.detail', reference: 'https://fitgirl-repacks.site/game' },
        { operation: 'https://store.steampowered.com/api/appdetails', appId: '620' }
    ];
    for (const payload of rejected) await assert.rejects(service.execute(payload));
    assert.equal(lookups, 0);
    assert.equal(network.calls.length, 0);
});

test('source detail requests require an opaque main-process reference', async () => {
    const network = fakeNetwork([
        {
            body: JSON.stringify([{
                id: 620,
                type: 'post',
                link: 'https://fitgirl-repacks.site/portal-repack/',
                categories: [5],
                title: { rendered: 'Portal' },
                content: { rendered: '<img src="https://images.example/portal.jpg">' }
            }]),
            headers: { 'content-type': 'application/json', 'x-wp-total': '23', 'x-wp-totalpages': '2' }
        },
        {
            body: '<!doctype html><article>Approved detail</article>',
            headers: { 'content-type': 'text/html; charset=utf-8' }
        }
    ]);
    const service = createRemoteDataService({ lookup: network.lookup, request: network.request });
    const search = await service.execute({ operation: 'source.search', source: 'fitgirl', query: 'Portal' });
    assert.deepEqual(search.pagination, { page: 1, totalPages: 2, totalItems: 23 });
    assert.equal(search.references.length, 1);
    assert.match(search.references[0].reference, /^[a-f0-9]{48}$/);
    assert.equal(search.references[0].url, 'https://fitgirl-repacks.site/portal-repack/');
    const detail = await service.execute({ operation: 'source.detail', reference: search.references[0].reference });
    assert.match(detail.html, /Approved detail/);
    assert.equal(network.calls[1].hostname, 'fitgirl-repacks.site');
    assert.equal(network.calls[1].path, '/portal-repack/');
    await assert.rejects(service.execute({ operation: 'source.detail', reference: 'https://fitgirl-repacks.site/admin' }));
    assert.equal(network.calls.length, 2);
});

test('opening several detail pages does not evict the remaining search-card references', async () => {
    const searchHtml = Array.from({ length: 4 }, (_, index) =>
        '<a href="/game-' + index + '/">Game ' + index + '</a>'
    ).join('');
    const detailHtml = seed => Array.from({ length: 200 }, (_, index) =>
        '<a href="/unused-' + seed + '-' + index + '/">Unused ' + index + '</a>'
    ).join('');
    const network = fakeNetwork([
        { body: searchHtml, headers: { 'content-type': 'text/html; charset=utf-8' } },
        ...Array.from({ length: 4 }, (_, index) => ({
            body: detailHtml(index),
            headers: { 'content-type': 'text/html; charset=utf-8' }
        }))
    ]);
    const service = createRemoteDataService({ lookup: network.lookup, request: network.request });
    const search = await service.execute({ operation: 'source.search', source: 'steamrip', query: 'Game' });

    assert.equal(search.references.length, 4);
    for (const item of search.references) {
        const detail = await service.execute({ operation: 'source.detail', reference: item.reference });
        assert.match(detail.html, /Unused/);
        assert.deepEqual(detail.references, []);
    }
    assert.equal(network.calls.length, 5);
});

test('non-public IPv4 and IPv6 address classes fail closed', () => {
    const blocked = [
        '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
        '172.16.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '224.0.0.1',
        '::', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', 'fc00::1',
        'fe80::1', 'ff02::1', '2001::1', '2001:2::1', '2001:db8::1',
        '2002:0808:0808::1', '3ffe::', '3ffe::1', '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '3fff::1'
    ];
    blocked.forEach(address => assert.equal(isPublicAddress(address), false, address));
    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(isPublicAddress('3ffd:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), true);
    assert.equal(isPublicAddress('3fff:1000::1'), true);
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('raw and encoded backslashes fail before URL normalization or network access', async () => {
    const context = buildOperationContext({ operation: 'steam.searchApps', query: 'Portal' }, () => null);
    assert.equal(require('../security/remoteData').isOperationUrlAllowed(
        context,
        'https:/\\steamcommunity.com/actions/SearchApps/Portal'
    ), false);

    let lookups = 0;
    const service = createRemoteDataService({
        lookup: async () => { lookups += 1; return [{ address: '93.184.216.34', family: 4 }]; },
        request: fakeNetwork([]).request
    });
    for (const query of ['Portal\\Two', 'Portal%5cTwo']) {
        await assert.rejects(service.execute({ operation: 'steam.searchApps', query }), /INVALID_QUERY/);
    }
    assert.equal(lookups, 0);
});

test('DNS answers containing private addresses are rejected before a connection', async () => {
    const network = fakeNetwork([], {
        lookup: async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 }
        ]
    });
    const service = createRemoteDataService({ lookup: network.lookup, request: network.request });
    await assert.rejects(service.execute({ operation: 'steam.searchApps', query: 'Portal' }), /NON_PUBLIC_DESTINATION/);
    assert.equal(network.calls.length, 0);
});

test('the connected peer must equal the pinned public DNS resolution', async () => {
    const network = fakeNetwork([{ remoteAddress: '8.8.8.8' }]);
    const service = createRemoteDataService({ lookup: network.lookup, request: network.request });
    await assert.rejects(service.execute({ operation: 'steam.searchApps', query: 'Portal' }), /ADDRESS_SUBSTITUTION/);
    assert.equal(network.calls.length, 1);
});

test('every redirect is revalidated and approved same-operation redirects can complete', async () => {
    const same = '/actions/SearchApps/Portal';
    const success = await executeWith([
        { status: 302, headers: { location: same } },
        { body: '[{"name":"Portal","appid":400}]' }
    ], { operation: 'steam.searchApps', query: 'Portal' });
    assert.equal(success.calls.length, 2);
    assert.equal(success.result.data[0].appid, 400);

    for (const location of [
        'http://steamcommunity.com/actions/SearchApps/Portal',
        'https://user:pass@steamcommunity.com/actions/SearchApps/Portal',
        'https://steamcommunity.com:444/actions/SearchApps/Portal',
        'https://127.0.0.1/actions/SearchApps/Portal',
        'https://evil.example/actions/SearchApps/Portal',
        'https://steamcommunity.com/admin'
    ]) {
        await assert.rejects(
            executeWith([{ status: 302, headers: { location } }], { operation: 'steam.searchApps', query: 'Portal' }),
            /REDIRECT_NOT_ALLOWED/
        );
    }

    for (const location of [
        'https:/\\steamcommunity.com/actions/SearchApps/Portal',
        'https:\\steamcommunity.com/actions/SearchApps/Portal',
        '/actions\\SearchApps/Portal',
        '/actions/%5cSearchApps/Portal'
    ]) {
        await assert.rejects(
            executeWith([{ status: 302, headers: { location } }], { operation: 'steam.searchApps', query: 'Portal' }),
            /INVALID_REDIRECT/
        );
    }
});

test('excessive redirects and total-operation timeout fail cleanly', async () => {
    await assert.rejects(
        executeWith(Array(5).fill({ status: 302, headers: { location: '/actions/SearchApps/Portal' } }),
            { operation: 'steam.searchApps', query: 'Portal' }, { maxRedirects: 2 }),
        /TOO_MANY_REDIRECTS/
    );
    await assert.rejects(
        executeWith([{ hang: true }], { operation: 'steam.searchApps', query: 'Portal' }, { connectTimeoutMs: 10, totalTimeoutMs: 20 }),
        /TIMEOUT/
    );

    let requests = 0;
    const dnsHung = createRemoteDataService({
        lookup: () => new Promise(() => {}),
        request: () => { requests += 1; },
        totalTimeoutMs: 20
    });
    await assert.rejects(dnsHung.execute({ operation: 'steam.searchApps', query: 'Portal' }), /TIMEOUT/);
    assert.equal(requests, 0);
});

test('connection timeout ends before TLS while post-TLS silence uses the total deadline', async () => {
    const delayed = fakeNetwork([{ responseDelayMs: 30, body: '[{"name":"Portal","appid":400}]' }]);
    const service = createRemoteDataService({
        lookup: delayed.lookup,
        request: delayed.request,
        connectTimeoutMs: 5,
        totalTimeoutMs: 100
    });
    const response = await service.execute({ operation: 'steam.searchApps', query: 'Portal' });
    assert.equal(response.data[0].appid, 400);
    assert.deepEqual(delayed.timeoutCalls, []);

    const preTls = fakeNetwork([{ connectHang: true }]);
    const blocked = createRemoteDataService({
        lookup: preTls.lookup,
        request: preTls.request,
        connectTimeoutMs: 5,
        totalTimeoutMs: 100
    });
    await assert.rejects(blocked.execute({ operation: 'steam.searchApps', query: 'Portal' }), /TIMEOUT/);
});

test('compressed and decoded response limits abort before JSON parsing', async () => {
    await assert.rejects(
        executeWith([{ chunks: [Buffer.alloc(65)], headers: { 'content-type': 'application/json' } }],
            { operation: 'steam.searchApps', query: 'Portal' }, { maxCompressedBytes: 64, maxDecodedBytes: 256 }),
        /RESPONSE_TOO_LARGE/
    );
    const expanded = Buffer.from(JSON.stringify({ data: 'x'.repeat(1024) }));
    const compressed = zlib.gzipSync(expanded);
    await assert.rejects(
        executeWith([{ chunks: [compressed], headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }],
            { operation: 'steam.searchApps', query: 'Portal' }, { maxCompressedBytes: 512, maxDecodedBytes: 128 }),
        /RESPONSE_TOO_LARGE/
    );
});

test('one absolute deadline terminates decode and JSON parsing workers', async () => {
    await assert.rejects(
        executeWith([{ body: '[{"appid":620}]' }],
            { operation: 'steam.searchApps', query: 'Portal' },
            { totalTimeoutMs: 200, workerStageDelays: { decode: 500 } }),
        /TIMEOUT/
    );
    await assert.rejects(
        executeWith([{ body: '[{"appid":620}]' }],
            { operation: 'steam.searchApps', query: 'Portal' },
            { totalTimeoutMs: 200, workerStageDelays: { json: 500 } }),
        /TIMEOUT/
    );
});

test('malformed JSON and unexpected content types return sanitized production-handler errors', async () => {
    const handlers = new Map();
    const network = fakeNetwork([{ body: '<html>nope</html>', headers: { 'content-type': 'application/json' } }]);
    registerRemoteDataIpc({ handle: (channel, handler) => handlers.set(channel, handler) },
        createRemoteDataService({ lookup: network.lookup, request: network.request }));
    const malformed = await handlers.get('remote-data')({}, { operation: 'steam.searchApps', query: 'Portal' });
    assert.deepEqual(malformed, { ok: false, error: 'The remote service returned an invalid response.' });
    assert.doesNotMatch(JSON.stringify(malformed), /<html>|93\.184|steamcommunity/i);

    const htmlNetwork = fakeNetwork([{ body: '{}', headers: { 'content-type': 'text/html' } }]);
    const htmlService = createRemoteDataService({ lookup: htmlNetwork.lookup, request: htmlNetwork.request });
    await assert.rejects(htmlService.execute({ operation: 'steam.searchApps', query: 'Portal' }), /UNEXPECTED_CONTENT_TYPE/);
});

test('legitimate Steam JSON reaches the real production handler and existing client behavior', async () => {
    const handlers = new Map();
    const network = fakeNetwork([{ body: '[{"name":"Portal 2","appid":620}]' }]);
    registerRemoteDataIpc({ handle: (channel, handler) => handlers.set(channel, handler) },
        createRemoteDataService({ lookup: network.lookup, request: network.request }));
    const client = createRemoteDataClient({ invoke: (channel, payload) => handlers.get(channel)({ trusted: true }, payload) });
    assert.deepEqual(await client.searchSteamApps('Portal 2'), [{ name: 'Portal 2', appid: 620 }]);
    assert.equal(network.calls[0].hostname, 'steamcommunity.com');
    assert.equal(network.calls[0].method, 'GET');
    assert.deepEqual(Object.keys(network.calls[0].headers).sort(), ['Accept', 'Accept-Encoding', 'User-Agent']);
});
