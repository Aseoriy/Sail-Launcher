'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const launcherVersion = require('../package.json').version;

const REMOTE_DATA_CHANNEL = 'remote-data';
const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
const MAX_DECODED_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 20000;
const REFERENCE_TTL_MS = 15 * 60 * 1000;
const MAX_REFERENCES = 600;
const MAX_ACTIVE_DECODE_WORKERS = 4;
const FITGIRL_GAME_CATEGORY_ID = '5';
const MAX_SOURCE_PAGE = 1000;

const STEAM_LANGUAGES = new Set([
    'arabic', 'brazilian', 'bulgarian', 'czech', 'danish', 'dutch', 'english',
    'finnish', 'french', 'german', 'greek', 'hungarian', 'indonesian', 'italian',
    'japanese', 'koreana', 'latam', 'norwegian', 'polish', 'portuguese',
    'romanian', 'russian', 'schinese', 'spanish', 'swedish', 'tchinese', 'thai',
    'turkish', 'ukrainian', 'vietnamese'
]);

const SOURCE_HOSTS = Object.freeze({
    steamgg: 'steamgg.net',
    fitgirl: 'fitgirl-repacks.site',
    steamrip: 'steamrip.com'
});

class RemoteDataError extends Error {
    constructor(code) {
        super(code);
        this.name = 'RemoteDataError';
        this.code = code;
    }
}

function fail(code) {
    throw new RemoteDataError(code);
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertExactKeys(value, required, optional = []) {
    if (!isPlainObject(value)) fail('INVALID_REQUEST');
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(value);
    if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
        || keys.some(key => !allowed.has(key))) fail('INVALID_REQUEST');
}

function boundedText(value, name, maxLength) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength) fail(`INVALID_${name}`);
    if ([...value].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    })) fail(`INVALID_${name}`);
    return value;
}

function steamAppId(value) {
    const id = boundedText(value, 'APP_ID', 12);
    if (!/^[1-9]\d{0,11}$/.test(id)) fail('INVALID_APP_ID');
    return id;
}

function steamId(value) {
    const id = boundedText(value, 'STEAM_ID', 17);
    if (!/^\d{17}$/.test(id)) fail('INVALID_STEAM_ID');
    return id;
}

function steamApiKey(value) {
    const key = boundedText(value, 'API_KEY', 32);
    if (!/^[A-Fa-f0-9]{32}$/.test(key)) fail('INVALID_API_KEY');
    return key;
}

function steamLanguage(value) {
    if (value === undefined) return 'english';
    const language = boundedText(value, 'LANGUAGE', 20).toLowerCase();
    if (!STEAM_LANGUAGES.has(language)) fail('INVALID_LANGUAGE');
    return language;
}

function sourceId(value) {
    if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(SOURCE_HOSTS, value)) fail('INVALID_SOURCE');
    return value;
}

function queryText(value) {
    const query = boundedText(value, 'QUERY', 200);
    if (hasForbiddenUrlSlash(query)) fail('INVALID_QUERY');
    return query;
}

function sourcePage(value) {
    if (value === undefined) return 1;
    if (!Number.isInteger(value) || value < 1 || value > MAX_SOURCE_PAGE) fail('INVALID_PAGE');
    return value;
}

function hexReference(value) {
    const reference = boundedText(value, 'REFERENCE', 64);
    if (!/^[a-f0-9]{48}$/.test(reference)) fail('INVALID_REFERENCE');
    return reference;
}

function urlHasSafeAuthority(url) {
    return url instanceof URL
        && url.protocol === 'https:'
        && !!url.hostname
        && !url.username
        && !url.password
        && (!url.port || url.port === '443');
}

function hasForbiddenUrlSlash(value) {
    return typeof value === 'string' && (value.includes('\\') || /%5c/i.test(value));
}

function parseStrictUrl(value, base) {
    const raw = String(value);
    if (hasForbiddenUrlSlash(raw)) fail('INVALID_URL');
    try { return base === undefined ? new URL(raw) : new URL(raw, base); } catch (_) { fail('INVALID_URL'); }
}

function createContext(operation, url, options = {}) {
    const initial = parseStrictUrl(url.href);
    const allowedPathnames = new Set(options.allowedPathnames || [initial.pathname]);
    const allowedSearches = new Set(options.allowedSearches || [initial.search]);
    return Object.freeze({
        operation,
        url: initial,
        host: initial.hostname.toLowerCase(),
        allowedPathnames,
        allowedSearches,
        expectedType: options.expectedType || 'json',
        source: options.source || null,
        page: options.page || 1
    });
}

function isOperationUrlAllowed(context, rawUrl) {
    try {
        if (!(rawUrl instanceof URL) && hasForbiddenUrlSlash(rawUrl)) return false;
        const url = rawUrl instanceof URL ? rawUrl : parseStrictUrl(rawUrl);
        return urlHasSafeAuthority(url)
            && url.hostname.toLowerCase() === context.host
            && context.allowedPathnames.has(url.pathname)
            && context.allowedSearches.has(url.search)
            && !url.hash;
    } catch (_) {
        return false;
    }
}

function buildOperationContext(payload, getReference) {
    assertExactKeys(payload, ['operation'], ['query', 'appId', 'language', 'apiKey', 'steamId', 'steamIds', 'source', 'reference', 'page']);
    const operation = boundedText(payload.operation, 'OPERATION', 40);
    let url;

    switch (operation) {
        case 'steam.searchApps': {
            assertExactKeys(payload, ['operation', 'query']);
            url = parseStrictUrl(`https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(queryText(payload.query))}`);
            return createContext(operation, url);
        }
        case 'steam.friendList': {
            assertExactKeys(payload, ['operation', 'apiKey', 'steamId']);
            url = parseStrictUrl('https://api.steampowered.com/ISteamUser/GetFriendList/v0001/');
            url.searchParams.set('key', steamApiKey(payload.apiKey));
            url.searchParams.set('steamid', steamId(payload.steamId));
            url.searchParams.set('relationship', 'friend');
            return createContext(operation, url);
        }
        case 'steam.playerSummaries': {
            assertExactKeys(payload, ['operation', 'apiKey', 'steamIds']);
            if (!Array.isArray(payload.steamIds) || !payload.steamIds.length || payload.steamIds.length > 100) fail('INVALID_STEAM_IDS');
            const ids = payload.steamIds.map(steamId);
            url = parseStrictUrl('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
            url.searchParams.set('key', steamApiKey(payload.apiKey));
            url.searchParams.set('steamids', ids.join(','));
            return createContext(operation, url);
        }
        case 'steam.appDetails': {
            assertExactKeys(payload, ['operation', 'appId'], ['language']);
            url = parseStrictUrl('https://store.steampowered.com/api/appdetails');
            url.searchParams.set('appids', steamAppId(payload.appId));
            url.searchParams.set('l', steamLanguage(payload.language));
            return createContext(operation, url);
        }
        case 'steam.storeSearch': {
            assertExactKeys(payload, ['operation', 'query']);
            url = parseStrictUrl('https://store.steampowered.com/api/storesearch/');
            url.searchParams.set('term', queryText(payload.query));
            url.searchParams.set('l', 'english');
            url.searchParams.set('cc', 'US');
            return createContext(operation, url);
        }
        case 'source.search': {
            assertExactKeys(payload, ['operation', 'source', 'query'], ['page']);
            const source = sourceId(payload.source);
            const query = queryText(payload.query);
            const page = sourcePage(payload.page);
            if (source === 'steamgg') {
                url = parseStrictUrl('https://steamgg.net/wp-json/wp/v2/posts');
                url.searchParams.set('search', query);
                url.searchParams.set('per_page', '12');
                url.searchParams.set('_embed', '1');
                if (page > 1) url.searchParams.set('page', page);
                return createContext(operation, url, { expectedType: 'json', source, page });
            }
            if (source === 'fitgirl') {
                url = parseStrictUrl('https://fitgirl-repacks.site/wp-json/wp/v2/posts');
                url.searchParams.set('search', query);
                // FitGirl posts contain long descriptions, so WordPress' default full-post
                // search turns a specific title into hundreds of weak matches and can make
                // the endpoint time out. The site's REST API supports title-only search.
                url.searchParams.append('search_columns[]', 'post_title');
                url.searchParams.set('categories', FITGIRL_GAME_CATEGORY_ID);
                url.searchParams.set('per_page', '12');
                // Keep the blocking search response lean. Full post bodies are fetched by
                // source.fitgirlCovers after cards are already usable in the renderer.
                url.searchParams.set('_fields', 'id,type,link,title,categories');
                if (page > 1) url.searchParams.set('page', page);
                return createContext(operation, url, { expectedType: 'json', source, page });
            }
            url = parseStrictUrl(`https://${SOURCE_HOSTS[source]}${page > 1 ? `/page/${page}/` : '/'}`);
            url.searchParams.set('s', query);
            return createContext(operation, url, { expectedType: 'html', source, page });
        }
        case 'source.fitgirlCovers': {
            assertExactKeys(payload, ['operation', 'query'], ['page']);
            const query = queryText(payload.query);
            const page = sourcePage(payload.page);
            url = parseStrictUrl('https://fitgirl-repacks.site/wp-json/wp/v2/posts');
            url.searchParams.set('search', query);
            url.searchParams.append('search_columns[]', 'post_title');
            url.searchParams.set('categories', FITGIRL_GAME_CATEGORY_ID);
            url.searchParams.set('per_page', '12');
            url.searchParams.set('_fields', 'id,link,content');
            if (page > 1) url.searchParams.set('page', page);
            return createContext(operation, url, { expectedType: 'json', source: 'fitgirl', page });
        }
        case 'source.detail': {
            assertExactKeys(payload, ['operation', 'reference']);
            const record = getReference(hexReference(payload.reference));
            if (!record) fail('INVALID_REFERENCE');
            url = parseStrictUrl(record.url);
            return createContext(operation, url, { expectedType: 'html', source: record.source });
        }
        default:
            fail('INVALID_OPERATION');
    }
}

function ipv4Number(address) {
    const pieces = address.split('.');
    if (pieces.length !== 4) return null;
    let result = 0;
    for (const piece of pieces) {
        if (!/^\d{1,3}$/.test(piece)) return null;
        const value = Number(piece);
        if (value > 255) return null;
        result = (result * 256) + value;
    }
    return result >>> 0;
}

function inV4Range(value, base, bits) {
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
}

function isPublicIpv4(address) {
    const value = ipv4Number(address);
    if (value === null) return false;
    const blocked = [
        ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
        ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
        ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
        ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !blocked.some(([base, bits]) => inV4Range(value, ipv4Number(base), bits));
}

function expandIpv6(address) {
    if (typeof address !== 'string' || address.includes('%')) return null;
    let input = address.toLowerCase();
    const embeddedV4 = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
    if (embeddedV4) {
        const value = ipv4Number(embeddedV4[1]);
        if (value === null) return null;
        input = input.slice(0, -embeddedV4[1].length) + `${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
    }
    const sides = input.split('::');
    if (sides.length > 2) return null;
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
    if ([...left, ...right].some(piece => !/^[a-f0-9]{1,4}$/.test(piece))) return null;
    const missing = 8 - left.length - right.length;
    if ((sides.length === 1 && missing !== 0) || (sides.length === 2 && missing < 1)) return null;
    const pieces = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
    if (pieces.length !== 8) return null;
    return pieces.reduce((value, piece) => (value << 16n) | BigInt(parseInt(piece, 16)), 0n);
}

function inV6Range(value, base, bits) {
    const shift = 128n - BigInt(bits);
    return (value >> shift) === (base >> shift);
}

function isPublicIpv6(address) {
    const value = expandIpv6(address);
    if (value === null) return false;
    const mappedBase = expandIpv6('::ffff:0:0');
    if (inV6Range(value, mappedBase, 96)) {
        const v4 = Number(value & 0xffffffffn) >>> 0;
        return isPublicIpv4(`${v4 >>> 24}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`);
    }
    const nat64Base = expandIpv6('64:ff9b::');
    if (inV6Range(value, nat64Base, 96)) {
        const v4 = Number(value & 0xffffffffn) >>> 0;
        return isPublicIpv4(`${v4 >>> 24}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`);
    }
    return inV6Range(value, expandIpv6('2000::'), 3)
        && !inV6Range(value, expandIpv6('2001::'), 23)
        && !inV6Range(value, expandIpv6('2001:db8::'), 32)
        && !inV6Range(value, expandIpv6('2002::'), 16)
        && !inV6Range(value, expandIpv6('3ffe::'), 16)
        && !inV6Range(value, expandIpv6('3fff::'), 20);
}

function isPublicAddress(address) {
    const family = net.isIP(address);
    return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
}

function normalizeAddress(address) {
    if (typeof address !== 'string') return '';
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return mapped[1];
    if (net.isIP(address) === 6) {
        const expanded = expandIpv6(address);
        return expanded === null ? '' : expanded.toString(16);
    }
    return address.toLowerCase();
}

async function resolvePinnedAddress(hostname, lookupImpl) {
    let records;
    try {
        records = await lookupImpl(hostname, { all: true, verbatim: true });
    } catch (_) {
        fail('DNS_FAILED');
    }
    if (!Array.isArray(records) || !records.length) fail('DNS_FAILED');
    const normalized = records.map(record => ({ address: String(record.address || ''), family: Number(record.family) }));
    if (normalized.some(record => ![4, 6].includes(record.family) || net.isIP(record.address) !== record.family || !isPublicAddress(record.address))) {
        fail('NON_PUBLIC_DESTINATION');
    }
    return normalized[0];
}

function expectedContentType(headers, expectedType) {
    const value = String((headers && headers['content-type']) || '').split(';', 1)[0].trim().toLowerCase();
    if (expectedType === 'json') return value === 'application/json' || value.endsWith('+json');
    return value === 'text/html' || value === 'application/xhtml+xml';
}

function defaultHeaders(expectedType) {
    return Object.freeze({
        'User-Agent': `Sail-Launcher/${launcherVersion}`,
        'Accept': expectedType === 'json' ? 'application/json' : 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'gzip, deflate, br'
    });
}

function requestOnce(url, context, address, options) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let totalTimer;
        let connectTimer;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(totalTimer);
            clearTimeout(connectTimer);
            if (error) reject(error); else resolve(result);
        };
        const abort = (request, code) => {
            const error = new RemoteDataError(code);
            try { request.destroy(error); } catch (_) {}
            finish(error);
        };
        let request;
        try {
            request = options.requestImpl({
                protocol: 'https:',
                hostname: url.hostname,
                port: 443,
                method: 'GET',
                path: `${url.pathname}${url.search}`,
                servername: url.hostname,
                agent: false,
                headers: defaultHeaders(context.expectedType),
                lookup(_hostname, lookupOptions, callback) {
                    if (lookupOptions && lookupOptions.all) callback(null, [address]);
                    else callback(null, address.address, address.family);
                }
            }, response => {
                const status = Number(response.statusCode) || 0;
                const headers = response.headers || {};
                if (status >= 300 && status < 400) {
                    const location = headers.location;
                    try { response.resume(); } catch (_) {}
                    return finish(null, { status, headers, redirect: location });
                }
                const declaredLength = Number(headers['content-length']);
                if (Number.isFinite(declaredLength) && declaredLength > options.maxCompressedBytes) {
                    return abort(request, 'RESPONSE_TOO_LARGE');
                }
                if (!expectedContentType(headers, context.expectedType)) return abort(request, 'UNEXPECTED_CONTENT_TYPE');
                const chunks = [];
                let compressedBytes = 0;
                response.on('data', chunk => {
                    if (settled) return;
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    compressedBytes += buffer.length;
                    if (compressedBytes > options.maxCompressedBytes) return abort(request, 'RESPONSE_TOO_LARGE');
                    chunks.push(buffer);
                });
                response.on('error', () => finish(new RemoteDataError('NETWORK_FAILED')));
                response.on('end', () => {
                    if (settled) return;
                    finish(null, {
                        status,
                        headers,
                        compressed: Buffer.concat(chunks, compressedBytes),
                        encoding: headers['content-encoding']
                    });
                });
            });
        } catch (_) {
            return finish(new RemoteDataError('NETWORK_FAILED'));
        }

        totalTimer = setTimeout(() => abort(request, 'TIMEOUT'), options.totalTimeoutMs);
        // The socket timer below is connection-only and is cleared after TLS. Do not also
        // use request.setTimeout here: Node keeps that as a post-connect inactivity timer,
        // which used to kill a valid but temporarily quiet response after eight seconds even
        // though the operation still had time left on its absolute deadline.
        request.on('socket', socket => {
            connectTimer = setTimeout(() => abort(request, 'TIMEOUT'), options.connectTimeoutMs);
            const verifyPeer = () => {
                clearTimeout(connectTimer);
                if (normalizeAddress(socket.remoteAddress) !== normalizeAddress(address.address)) abort(request, 'ADDRESS_SUBSTITUTION');
            };
            if (socket.connecting === false && socket.remoteAddress) verifyPeer();
            else socket.once('secureConnect', verifyPeer);
        });
        request.on('error', error => finish(error instanceof RemoteDataError ? error : new RemoteDataError('NETWORK_FAILED')));
        request.end();
    });
}

function withTimeout(promise, milliseconds, code) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new RemoteDataError(code));
        }, Math.max(1, milliseconds));
        Promise.resolve(promise).then(value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function fetchOperation(context, options, deadline) {
    let current = parseStrictUrl(context.url.href);
    for (let redirects = 0; ; redirects++) {
        if (!isOperationUrlAllowed(context, current)) fail('DESTINATION_NOT_ALLOWED');
        let remaining = deadline - Date.now();
        if (remaining <= 0) fail('TIMEOUT');
        const address = await withTimeout(resolvePinnedAddress(current.hostname, options.lookupImpl), remaining, 'TIMEOUT');
        remaining = deadline - Date.now();
        if (remaining <= 0) fail('TIMEOUT');
        const response = await requestOnce(current, context, address, Object.assign({}, options, { totalTimeoutMs: remaining }));
        if (response.redirect !== undefined) {
            if (redirects >= options.maxRedirects) fail('TOO_MANY_REDIRECTS');
            const rawLocation = String(response.redirect);
            if (hasForbiddenUrlSlash(rawLocation)) fail('INVALID_REDIRECT');
            let next;
            try { next = parseStrictUrl(rawLocation, current); } catch (_) { fail('INVALID_REDIRECT'); }
            if (!isOperationUrlAllowed(context, next)) fail('REDIRECT_NOT_ALLOWED');
            current = next;
            continue;
        }
        if (response.status < 200 || response.status >= 300) fail('REMOTE_HTTP_ERROR');
        return response;
    }
}

function decodeAndValidateResponse(response, context, options, deadline, activeWorkers) {
    if (Date.now() >= deadline) return Promise.reject(new RemoteDataError('TIMEOUT'));
    if (activeWorkers.size >= options.maxActiveDecodeWorkers) return Promise.reject(new RemoteDataError('SERVICE_BUSY'));
    const exact = response.compressed.buffer.slice(
        response.compressed.byteOffset,
        response.compressed.byteOffset + response.compressed.byteLength
    );
    let worker;
    try {
        worker = new Worker(path.join(__dirname, 'remoteDataWorker.js'), {
            workerData: {
                compressed: exact,
                encoding: response.encoding,
                expectedType: context.expectedType,
                maxDecodedBytes: options.maxDecodedBytes,
                deadline,
                stageDelays: options.workerStageDelays
            },
            transferList: [exact]
        });
    } catch (_) {
        return Promise.reject(new RemoteDataError('INVALID_RESPONSE_ENCODING'));
    }
    activeWorkers.add(worker);

    return new Promise((resolve, reject) => {
        let settled = false;
        const remaining = Math.max(1, deadline - Date.now());
        const timer = setTimeout(() => finish(new RemoteDataError('TIMEOUT')), remaining);

        async function finish(error, result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            activeWorkers.delete(worker);
            try { await worker.terminate(); } catch (_) {}
            if (error) reject(error); else resolve(result);
        }

        worker.once('message', message => {
            if (!message || message.ok !== true) return finish(new RemoteDataError(message && message.code ? message.code : 'INVALID_RESPONSE_ENCODING'));
            if (Date.now() >= deadline) return finish(new RemoteDataError('TIMEOUT'));
            finish(null, message.result);
        });
        worker.once('error', () => finish(new RemoteDataError('INVALID_RESPONSE_ENCODING')));
        worker.once('exit', () => {
            if (!settled) finish(new RemoteDataError('INVALID_RESPONSE_ENCODING'));
        });
    });
}

function decodeHtmlEntityUrl(value) {
    return String(value || '').replace(/&amp;/gi, '&').replace(/&#x2f;/gi, '/').replace(/&#47;/g, '/');
}

function sourceUrl(source, rawUrl, baseUrl) {
    const decoded = decodeHtmlEntityUrl(rawUrl);
    if (hasForbiddenUrlSlash(String(rawUrl || '')) || hasForbiddenUrlSlash(decoded)) return null;
    let url;
    try { url = parseStrictUrl(decoded, baseUrl); } catch (_) { return null; }
    if (!urlHasSafeAuthority(url) || url.hostname.toLowerCase() !== SOURCE_HOSTS[source] || url.hash) return null;
    return url;
}

function publicError(error) {
    const code = error && error.code;
    switch (code) {
        case 'TIMEOUT': return 'The remote request timed out.';
        case 'RESPONSE_TOO_LARGE': return 'The remote response was too large.';
        case 'TOO_MANY_REDIRECTS': return 'The remote service redirected too many times.';
        case 'UNEXPECTED_CONTENT_TYPE':
        case 'INVALID_JSON': return 'The remote service returned an invalid response.';
        case 'INVALID_REQUEST':
        case 'INVALID_OPERATION':
        case 'INVALID_QUERY':
        case 'INVALID_APP_ID':
        case 'INVALID_STEAM_ID':
        case 'INVALID_STEAM_IDS':
        case 'INVALID_API_KEY':
        case 'INVALID_LANGUAGE':
        case 'INVALID_SOURCE':
        case 'INVALID_PAGE':
        case 'INVALID_REFERENCE': return 'This remote-data request is not allowed.';
        default: return 'The remote data request failed.';
    }
}

function createRemoteDataService(options = {}) {
    const lookupImpl = options.lookup || dns.promises.lookup.bind(dns.promises);
    const requestImpl = options.request || https.request;
    const randomBytes = options.randomBytes || crypto.randomBytes;
    const now = options.now || Date.now;
    const limits = {
        lookupImpl,
        requestImpl,
        now,
        maxCompressedBytes: options.maxCompressedBytes || MAX_COMPRESSED_BYTES,
        maxDecodedBytes: options.maxDecodedBytes || MAX_DECODED_BYTES,
        maxRedirects: Number.isInteger(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS,
        connectTimeoutMs: options.connectTimeoutMs || CONNECT_TIMEOUT_MS,
        totalTimeoutMs: options.totalTimeoutMs || TOTAL_TIMEOUT_MS,
        maxActiveDecodeWorkers: options.maxActiveDecodeWorkers || MAX_ACTIVE_DECODE_WORKERS,
        workerStageDelays: options.workerStageDelays || null
    };
    const references = new Map();
    const activeWorkers = new Set();

    function pruneReferences() {
        const cutoff = now() - REFERENCE_TTL_MS;
        for (const [token, record] of references) {
            if (record.createdAt < cutoff || references.size > MAX_REFERENCES) references.delete(token);
        }
    }

    function getReference(token) {
        pruneReferences();
        return references.get(token) || null;
    }

    function issueReference(source, rawUrl, baseUrl) {
        const url = sourceUrl(source, rawUrl, baseUrl);
        if (!url || url.pathname === '/') return null;
        const token = randomBytes(24).toString('hex');
        references.set(token, { source, url: url.href, createdAt: now() });
        return { url: url.href, reference: token };
    }

    function referencesFromHtml(context, html) {
        const found = [];
        const seen = new Set();
        const expression = /\bhref\s*=\s*(["'])(.*?)\1/gi;
        let match;
        while ((match = expression.exec(html)) && found.length < 200) {
            const item = issueReference(context.source, match[2], context.url);
            if (item && !seen.has(item.url)) {
                seen.add(item.url);
                found.push(item);
            }
        }
        return found;
    }

    function responsePagination(context, response) {
        const headerNumber = name => {
            const raw = response && response.headers && response.headers[name];
            const value = Array.isArray(raw) ? raw[0] : raw;
            const parsed = Number.parseInt(String(value || ''), 10);
            return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
        };
        const totalPages = Math.min(MAX_SOURCE_PAGE, headerNumber('x-wp-totalpages'));
        const totalItems = headerNumber('x-wp-total');
        return {
            page: context.page || 1,
            totalPages: Math.max(context.page || 1, totalPages || 1),
            totalItems
        };
    }

    async function execute(payload) {
        const deadline = Date.now() + limits.totalTimeoutMs;
        const context = buildOperationContext(payload, getReference);
        if (Date.now() >= deadline) fail('TIMEOUT');
        const fetched = await fetchOperation(context, limits, deadline);
        const decoded = await decodeAndValidateResponse(fetched, context, limits, deadline, activeWorkers);
        if (Date.now() >= deadline) fail('TIMEOUT');
        if (context.expectedType === 'json') {
            const data = decoded.data;
            const response = { data, pagination: responsePagination(context, fetched) };
            if (context.operation === 'source.search'
                && ['steamgg', 'fitgirl'].includes(context.source) && Array.isArray(data)) {
                response.references = [];
                for (const post of data) {
                    if (Date.now() >= deadline) fail('TIMEOUT');
                    if (!isPlainObject(post)) continue;
                    const item = issueReference(context.source, post.link, context.url);
                    if (item) {
                        post.sailReference = item.reference;
                        post.link = item.url;
                        response.references.push(item);
                    }
                }
            }
            if (Date.now() >= deadline) fail('TIMEOUT');
            return response;
        }
        const response = {
            html: decoded.html,
            // Search cards need opaque references so the renderer can open their detail
            // pages. Detail HTML does not: issuing another ~200 references for every
            // opened game quickly evicted the still-visible search-card references from
            // the bounded store, making subsequent cards fail until the launcher reloaded.
            references: context.operation === 'source.search'
                ? referencesFromHtml(context, decoded.html)
                : [],
            pagination: responsePagination(context, fetched)
        };
        if (Date.now() >= deadline) fail('TIMEOUT');
        return response;
    }

    return Object.freeze({ execute });
}

function registerRemoteDataIpc(ipcMain, service) {
    if (!ipcMain || typeof ipcMain.handle !== 'function' || !service || typeof service.execute !== 'function') {
        throw new TypeError('Remote-data IPC requires an IPC registrar and service.');
    }
    ipcMain.handle(REMOTE_DATA_CHANNEL, async (_event, payload) => {
        try {
            const result = await service.execute(payload);
            return Object.assign({ ok: true }, result);
        } catch (error) {
            return { ok: false, error: publicError(error) };
        }
    });
}

module.exports = {
    CONNECT_TIMEOUT_MS,
    MAX_COMPRESSED_BYTES,
    MAX_DECODED_BYTES,
    MAX_REDIRECTS,
    REMOTE_DATA_CHANNEL,
    RemoteDataError,
    buildOperationContext,
    createRemoteDataService,
    isOperationUrlAllowed,
    isPublicAddress,
    publicError,
    registerRemoteDataIpc
};
