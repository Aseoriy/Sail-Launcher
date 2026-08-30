'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const vm = require('node:vm');

const BUZZHEAVIER_HOST_RE = /(^|\.)(?:bzzhr\.to|bzzhr\.co|buzzheavier\.com|fuckingfast\.net)$/i;
const FUCKINGFAST_HOST_RE = /(^|\.)fuckingfast\.(?:co|com|net)$/i;
const FILEDITCH_HOST_RE = /(^|\.)fileditch(?:files)?\.(?:com|net|me)$/i;
const MEGADB_HOST_RE = /(^|\.)megadb\.(?:net|xyz)$/i;
const PIXELDRAIN_HOST_RE = /(^|\.)pixeldrain\.(?:com|net|in|nl|biz|tech|dev)$/i;
const FILEKEEPER_HOST_RE = /(^|\.)filekeeper\.(?:net|me|org|io)$/i;
const FILEKEEPER_CDN_HOST_RE = /(^|\.)dlproxy\.uk$/i;
const FILEKEEPER_ALT_PORT_HOST_RE = /^fs\d{1,3}\.filekeeper\.net$/i;
const DATANODES_HOST_RE = /(^|\.)datanodes\.(?:to|net)$/i;
const AKIRABOX_HOST_RE = /(^|\.)akirabox\.(?:com|to)$/i;
const X1337_HOST_RE = /(^|\.)1337x\.(?:to|st|gd|is|tw|ws)$/i;
const ROOTZ_HOST_RE = /^(?:www\.)?rootz\.so$/i;
const VIKINGFILE_HOST_RE = /^(?:www\.)?(?:vikingfile\.com|vik1ngfile\.site)$/i;
const DATANODES_BROWSER_TRANSFER_AUTHORITY = 'datanodes-download-response-v1';
const GOFILE_LANGUAGE = 'en-US';
const GOFILE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0';
const GOFILE_WEBSITE_URL = 'https://gofile.io/';
const GOFILE_API_URL = 'https://api.gofile.io';
const GOFILE_WT_FALLBACK_SECRET = '12af056dacea0b';
const GOFILE_MAX_SCRIPT_BYTES = 256 * 1024;
const GOFILE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const GOFILE_TOKEN_AUTH_STATUS_RE = /^error-(?:wrongToken|notAuthenticated|badToken|notPremium)$/i;
const BUZZHEAVIER_MIRRORS = Object.freeze([
    'https://bzzhr.to',
    'https://buzzheavier.com',
    'https://bzzhr.co',
    'https://fuckingfast.net'
]);

function credentialFreeHttpsUrl(value, baseUrl = undefined) {
    const source = String(value || '').trim();
    if (!source || source.length > 8192 || /[\u0000-\u001f\u007f\\]/.test(source)) return '';
    let parsed;
    try { parsed = new URL(source, baseUrl); } catch (_) { return ''; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.port && parsed.port !== '443') return '';
    parsed.hash = '';
    return parsed.href;
}

function gofileDirectDownloadUrl(value) {
    const secure = credentialFreeHttpsUrl(value);
    if (!secure) return '';
    const parsed = new URL(secure);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'gofile.io' && !host.endsWith('.gofile.io')) return '';
    if (!/^\/download\//i.test(parsed.pathname)) return '';
    return parsed.href;
}

function gofileShareDetails(value) {
    const secure = credentialFreeHttpsUrl(value);
    if (!secure) return null;
    const directUrl = gofileDirectDownloadUrl(secure);
    if (directUrl) return { directUrl, contentId: '' };
    const parsed = new URL(secure);
    if (!/^(?:www\.)?gofile\.io$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/(?:d|contents)\/([A-Za-z0-9_-]{4,128})\/?$/i);
    return match ? { directUrl: '', contentId: match[1] } : null;
}

function extractGofileWebsiteTokenSecret(scriptSource) {
    const script = String(scriptSource || '');
    if (!script || Buffer.byteLength(script, 'utf8') > GOFILE_MAX_SCRIPT_BYTES
        || script.trimStart().startsWith('<')) {
        throw new Error('Gofile website-token script is invalid.');
    }
    let rawHashInput = '';
    const probeUserAgent = 'SailGofileUserAgent';
    const probeLanguage = 'SailGofileLanguage';
    const probeToken = 'SailGofileToken';
    const navigator = { userAgent: probeUserAgent, language: probeLanguage };
    const context = vm.createContext({
        appdata: {},
        crypto: crypto.webcrypto,
        console: { error() {}, log() {}, warn() {} },
        Date,
        Math,
        navigator,
        URLSearchParams,
        window: {
            crypto: crypto.webcrypto,
            location: { hostname: 'gofile.io', search: '' },
            navigator
        }
    }, { name: 'sail-gofile-website-token' });
    vm.runInContext(script, context, { timeout: 1000 });
    if (typeof context.generateWT !== 'function') throw new Error('Gofile website-token generator was not found.');
    context._sha256 = input => {
        rawHashInput = String(input || '');
        return '0'.repeat(64);
    };
    vm.runInContext(`generateWT(${JSON.stringify(probeToken)})`, context, { timeout: 1000 });
    const prefix = `${probeUserAgent}::${probeLanguage}::${probeToken}::`;
    if (!rawHashInput.startsWith(prefix)) throw new Error('Gofile website-token format is unsupported.');
    const [, ...secretParts] = rawHashInput.slice(prefix.length).split('::');
    const secret = secretParts.join('::').trim();
    if (!secret || secret.length > 256 || /[\u0000-\u001f\u007f]/.test(secret)) {
        throw new Error('Gofile website-token secret is invalid.');
    }
    return secret;
}

function gofileWebsiteToken(secret, accountToken = '', options = {}) {
    const userAgent = String(options.userAgent || GOFILE_USER_AGENT);
    const language = String(options.language || GOFILE_LANGUAGE);
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const timeSlot = Math.floor(now / 1000 / 14400);
    return crypto.createHash('sha256')
        .update(`${userAgent}::${language}::${String(accountToken || '')}::${timeSlot}::${String(secret || '')}`)
        .digest('hex');
}

function boundedJsonResponse(response, label) {
    const body = String(response && response.body || '');
    if (Buffer.byteLength(body, 'utf8') > GOFILE_MAX_RESPONSE_BYTES) {
        throw new Error(`${label} response was too large.`);
    }
    try { return JSON.parse(body); } catch (_) { throw new Error(`${label} returned invalid JSON.`); }
}

function createGofileResolver(defaultDependencies = {}) {
    let accountToken = '';
    let accountPromise = null;
    let websiteTokenSecret = '';
    let websiteTokenSecretPromise = null;

    const dependenciesFor = overrides => Object.assign({}, defaultDependencies, overrides || {});
    const requestFor = dependencies => {
        if (typeof dependencies.request !== 'function') {
            throw new TypeError('Gofile resolution requires a request function.');
        }
        return dependencies.request;
    };
    const waitFor = dependencies => typeof dependencies.wait === 'function'
        ? dependencies.wait
        : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const baseHeaders = (dependencies, token = '') => {
        const headers = {
            'User-Agent': String(dependencies.userAgent || GOFILE_USER_AGENT),
            'Accept': 'application/json',
            'Origin': 'https://gofile.io',
            'Referer': GOFILE_WEBSITE_URL
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    };

    function resetWebsiteTokenSecret() {
        websiteTokenSecret = '';
        websiteTokenSecretPromise = null;
    }

    async function loadWebsiteTokenSecret(dependencies) {
        if (websiteTokenSecret) return websiteTokenSecret;
        if (websiteTokenSecretPromise) return websiteTokenSecretPromise;
        websiteTokenSecretPromise = (async () => {
            const request = requestFor(dependencies);
            const scriptUrls = [];
            try {
                const home = await request('GET', GOFILE_WEBSITE_URL, {
                    headers: {
                        'User-Agent': String(dependencies.userAgent || GOFILE_USER_AGENT),
                        'Accept': 'text/html,application/xhtml+xml'
                    },
                    follow: false,
                    timeoutMs: 10000
                });
                if (home && home.status >= 200 && home.status < 300
                    && Buffer.byteLength(String(home.body || ''), 'utf8') <= GOFILE_MAX_SCRIPT_BYTES) {
                    const match = String(home.body || '').match(/<script[^>]+src=["']([^"']*wt[^"'/]*\.js)["']/i);
                    if (match) {
                        const discovered = new URL(match[1], GOFILE_WEBSITE_URL);
                        if (discovered.origin === 'https://gofile.io') scriptUrls.push(discovered.href);
                    }
                }
            } catch (_) {}
            scriptUrls.push('https://gofile.io/js/wt.obf.js');
            let lastError = null;
            for (const scriptUrl of [...new Set(scriptUrls)]) {
                try {
                    const script = await request('GET', scriptUrl, {
                        headers: {
                            'User-Agent': String(dependencies.userAgent || GOFILE_USER_AGENT),
                            'Accept': 'application/javascript,text/javascript,*/*;q=0.8',
                            'Referer': GOFILE_WEBSITE_URL
                        },
                        follow: false,
                        timeoutMs: 10000
                    });
                    if (!script || script.status < 200 || script.status >= 300) {
                        throw new Error(`Gofile website-token script returned HTTP ${script && script.status}.`);
                    }
                    return extractGofileWebsiteTokenSecret(script.body);
                } catch (error) { lastError = error; }
            }
            if (dependencies.allowWebsiteTokenFallback !== false) return GOFILE_WT_FALLBACK_SECRET;
            throw lastError || new Error('Gofile website-token script could not be loaded.');
        })().then(secret => {
            websiteTokenSecret = secret;
            return secret;
        }).finally(() => { websiteTokenSecretPromise = null; });
        return websiteTokenSecretPromise;
    }

    async function websiteToken(dependencies, token = '') {
        return gofileWebsiteToken(await loadWebsiteTokenSecret(dependencies), token, {
            userAgent: dependencies.userAgent || GOFILE_USER_AGENT,
            language: GOFILE_LANGUAGE,
            now: typeof dependencies.now === 'function' ? dependencies.now() : dependencies.now
        });
    }

    async function createAccount(dependencies) {
        const request = requestFor(dependencies);
        for (let attempt = 0; attempt < 3; attempt++) {
            const response = await request('POST', `${GOFILE_API_URL}/accounts`, {
                headers: Object.assign(baseHeaders(dependencies), {
                    'Content-Length': '0',
                    'X-BL': GOFILE_LANGUAGE,
                    'X-Website-Token': await websiteToken(dependencies)
                }),
                follow: false,
                timeoutMs: 15000
            });
            const payload = boundedJsonResponse(response, 'Gofile account API');
            const token = payload && payload.status === 'ok' && payload.data && String(payload.data.token || '').trim();
            if (token && token.length <= 8192 && !/[\u0000\r\n]/.test(token)) return token;
            const status = String(payload && payload.status || '');
            if (attempt < 2 && GOFILE_TOKEN_AUTH_STATUS_RE.test(status)) {
                // A website-token secret can rotate while the launcher remains open. Do
                // not keep retrying the cached generator after the API rejects it.
                resetWebsiteTokenSecret();
                continue;
            }
            if (attempt < 2 && (response && response.status === 429 || status === 'error-rateLimit')) {
                await waitFor(dependencies)(2 ** attempt * 1000);
                continue;
            }
            throw new Error(`Gofile account creation failed (${status || response && response.status || 'unknown'}).`);
        }
        throw new Error('Gofile account creation failed.');
    }

    async function authorize(dependencies, forceRefresh = false) {
        if (forceRefresh) accountToken = '';
        if (accountToken) return accountToken;
        if (!accountPromise) {
            accountPromise = createAccount(dependencies).then(token => {
                accountToken = token;
                return token;
            }).finally(() => { accountPromise = null; });
        }
        return accountPromise;
    }

    async function getContentPage(contentId, token, page, dependencies) {
        const params = new URLSearchParams({
            page: String(page),
            pageSize: '1000',
            sortField: 'createTime',
            sortDirection: '-1'
        });
        const response = await requestFor(dependencies)('GET', `${GOFILE_API_URL}/contents/${encodeURIComponent(contentId)}?${params}`, {
            headers: Object.assign(baseHeaders(dependencies, token), {
                'X-BL': GOFILE_LANGUAGE,
                'X-Website-Token': await websiteToken(dependencies, token)
            }),
            follow: false,
            timeoutMs: 15000
        });
        const payload = boundedJsonResponse(response, 'Gofile content API');
        if (response && response.status === 429 || payload && payload.status === 'error-rateLimit') {
            throw new Error('Gofile rate limit reached.');
        }
        if (!payload || payload.status !== 'ok' || !payload.data) {
            const error = new Error(`Gofile content could not be read (${payload && payload.status || response && response.status || 'unknown'}).`);
            error.gofileStatus = payload && payload.status || '';
            throw error;
        }
        if (payload.data.canAccess === false) throw new Error('Gofile content is not accessible.');
        return payload;
    }

    async function collectContent(contentId, token, dependencies, output, visited) {
        if (!/^[A-Za-z0-9_-]{4,128}$/.test(contentId) || visited.has(contentId) || visited.size >= 128) return;
        visited.add(contentId);
        const first = await getContentPage(contentId, token, 1, dependencies);
        const totalPages = Math.max(1, Math.min(100, Math.trunc(Number(first.metadata && first.metadata.totalPages) || 1)));
        const pages = [first];
        for (let page = 2; page <= totalPages; page++) pages.push(await getContentPage(contentId, token, page, dependencies));
        for (const payload of pages) {
            if (output.length >= 512) return;
            const data = payload.data;
            if (data.type === 'file') {
                const url = gofileDirectDownloadUrl(data.link);
                if (url) output.push({ url, name: cleanDownloadName(data.name), kind: 'http' });
                continue;
            }
            if (data.type !== 'folder') continue;
            for (const child of Object.values(data.children || {})) {
                if (!child || child.canAccess === false || output.length >= 512) continue;
                if (child.type === 'file') {
                    const url = gofileDirectDownloadUrl(child.link);
                    if (url) output.push({ url, name: cleanDownloadName(child.name), kind: 'http' });
                } else if (child.type === 'folder' && child.id) {
                    await collectContent(String(child.id), token, dependencies, output, visited);
                }
            }
        }
    }

    return async function resolveGofileUrl(rawUrl, overrides = {}) {
        const details = gofileShareDetails(rawUrl);
        if (!details) return null;
        const dependencies = dependenciesFor(overrides);
        const userAgent = String(dependencies.userAgent || GOFILE_USER_AGENT);
        if (details.directUrl) {
            const token = await authorize(dependencies);
            return [{
                url: details.directUrl,
                name: fileNameFromUrl(details.directUrl),
                kind: 'http',
                headers: [
                    `Cookie: accountToken=${token}`,
                    `User-Agent: ${userAgent}`,
                    'Accept: */*',
                    `Referer: ${GOFILE_WEBSITE_URL}`,
                    'Origin: https://gofile.io'
                ]
            }];
        }
        let token = await authorize(dependencies);
        let files = [];
        try {
            await collectContent(details.contentId, token, dependencies, files, new Set());
        } catch (error) {
            if (!GOFILE_TOKEN_AUTH_STATUS_RE.test(String(error && error.gofileStatus || ''))) throw error;
            token = await authorize(dependencies, true);
            files = [];
            await collectContent(details.contentId, token, dependencies, files, new Set());
        }
        const headers = [
            `Cookie: accountToken=${token}`,
            `User-Agent: ${userAgent}`,
            'Accept: */*',
            `Referer: ${GOFILE_WEBSITE_URL}`,
            'Origin: https://gofile.io'
        ];
        const seen = new Set();
        files = files.filter(file => !seen.has(file.url) && seen.add(file.url));
        files.forEach(file => { file.headers = headers.slice(); });
        return files.length ? files : null;
    };
}

const resolveGofileUrl = createGofileResolver();

function headerValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return String(headers.get(name) || '');
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    const value = key ? headers[key] : '';
    return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function cleanDownloadName(value) {
    let name = String(value || '');
    try { name = decodeURIComponent(name); } catch (_) {}
    name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return name.slice(0, 240);
}

function fileNameFromDisposition(value) {
    const source = String(value || '');
    const utf8 = source.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf8) return cleanDownloadName(utf8[1]);
    const plain = source.match(/filename\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/i);
    return cleanDownloadName(plain && (plain[1] || plain[2] || plain[3]) || '');
}

function fileNameFromUrl(value) {
    try { return cleanDownloadName(new URL(value).pathname); } catch (_) { return ''; }
}

function isBuzzHeavierHost(hostname) {
    return BUZZHEAVIER_HOST_RE.test(String(hostname || '').toLowerCase());
}

function isFileDitchHost(hostname) {
    return FILEDITCH_HOST_RE.test(String(hostname || '').toLowerCase());
}

function isTrustedSubdomain(hostname, rootPattern, originHostname) {
    const host = String(hostname || '').toLowerCase();
    const origin = String(originHostname || '').toLowerCase();
    return host === origin || rootPattern.test(host);
}

function pixeldrainUrlInfo(rawUrl) {
    const source = credentialFreeHttpsUrl(rawUrl);
    if (!source) return null;
    const parsed = new URL(source);
    if (!PIXELDRAIN_HOST_RE.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'l' && /^[A-Za-z0-9]{4,64}$/.test(parts[1] || '')) {
        return { source, origin: parsed.origin, kind: 'list', id: parts[1] };
    }
    if ((parts[0] === 'u' || parts[0] === 'd') && /^[A-Za-z0-9]{4,128}$/.test(parts[1] || '')) {
        return { source, origin: parsed.origin, kind: 'file', id: parts[1] };
    }
    const apiFile = parsed.pathname.match(/^\/api\/file\/([A-Za-z0-9]{4,128})$/i);
    if (apiFile) return { source, origin: parsed.origin, kind: 'file', id: apiFile[1] };
    const apiList = parsed.pathname.match(/^\/api\/list\/([A-Za-z0-9]{4,64})$/i);
    if (apiList) return { source, origin: parsed.origin, kind: 'list', id: apiList[1] };
    return null;
}

function pixeldrainDirectUrl(origin, id) {
    return credentialFreeHttpsUrl(`${origin}/api/file/${encodeURIComponent(id)}?download`);
}

function pixeldrainProxyCandidates(directUrl, dependencies = {}) {
    const candidates = [];
    const addBase = value => {
        const secure = credentialFreeHttpsUrl(value);
        if (!secure) return;
        const parsed = new URL(secure);
        if (parsed.protocol !== 'https:' || parsed.searchParams.has('url')) return;
        const wrapped = credentialFreeHttpsUrl(`${parsed.origin}${parsed.pathname.replace(/\/$/, '')}/?url=${encodeURIComponent(directUrl)}`);
        if (wrapped && !candidates.includes(wrapped)) candidates.push(wrapped);
    };
    if (Array.isArray(dependencies.proxyUrls)) dependencies.proxyUrls.forEach(addBase);
    if (typeof dependencies.proxyUrl === 'function') {
        const generated = credentialFreeHttpsUrl(dependencies.proxyUrl(directUrl));
        if (generated && new URL(generated).searchParams.has('url')) candidates.push(generated);
        else addBase(generated);
    }
    return candidates;
}

function extractPixeldrainFiles(payload) {
    const files = payload && payload.files;
    if (!Array.isArray(files)) return [];
    return files.filter(file => file && typeof file === 'object' && /^[A-Za-z0-9]{4,128}$/.test(String(file.id || '')))
        .map(file => ({ id: String(file.id), name: cleanDownloadName(file.name) }));
}

async function resolvePixeldrainUrl(rawUrl, dependencies = {}) {
    const request = dependencies.request;
    const info = pixeldrainUrlInfo(rawUrl);
    if (!info) return null;
    const userAgent = String(dependencies.userAgent || 'Mozilla/5.0');
    const unavailableProxyOrigins = new Set();
    let directRateLimited = false;
    const makeResult = async (id, name) => {
        const direct = pixeldrainDirectUrl(info.origin, id);
        if (!direct) return null;
        if (typeof request !== 'function') return resolvedDownload(direct, info.source, userAgent, name, { maxConn: 16 });
        const probe = async url => {
            try {
                const response = await request('GET', url, {
                    headers: { 'User-Agent': userAgent, Accept: '*/*', Referer: info.source, Range: 'bytes=0-0' },
                    follow: false,
                    timeoutMs: 8000
                });
                const status = Number(response && response.status) || 0;
                const type = headerValue(response && response.headers, 'content-type');
                const body = String(response && response.body || '').trimStart();
                if ([404, 410].includes(status) || /"value"\s*:\s*"(?:not_found|file_not_found)"/i.test(body)) {
                    return { state: 'down', status };
                }
                if (status === 429 || /(?:rate[_ -]?limit|too many requests)/i.test(body)) {
                    return { state: 'rate-limited', status };
                }
                if (status === 403 && /hotlink_detected/i.test(body)) return { state: 'hotlink-blocked', status };
                if (status >= 200 && status < 300
                    && !/text\/html|application\/json/i.test(type)
                    && !/^(?:<|\{)/.test(body)) return { state: 'available', status };
                return { state: 'unavailable', status };
            } catch (_) { return { state: 'unavailable', status: 0 }; }
        };

        // PixelDrain's own API is normally the fastest and most reliable route.
        // Only spend time on user-configured Workers if the direct route is limited
        // or unavailable; a failed Worker is skipped for the remainder of a list.
        let directOutcome = { state: 'rate-limited', status: 429 };
        if (!directRateLimited) {
            directOutcome = await probe(direct);
            if (directOutcome.state === 'available') {
                return resolvedDownload(direct, info.source, userAgent, name, { maxConn: 16 });
            }
            if (directOutcome.state === 'down') {
                throw resolverDownError('PixelDrain reports that this file was deleted or no longer exists.', 'pixeldrain-not-found');
            }
            if (directOutcome.state === 'rate-limited') directRateLimited = true;
        }

        const proxyCandidates = pixeldrainProxyCandidates(direct, dependencies);
        for (const candidate of proxyCandidates) {
            const proxyOrigin = new URL(candidate).origin;
            if (unavailableProxyOrigins.has(proxyOrigin)) continue;
            const outcome = await probe(candidate);
            if (outcome.state === 'available') {
                return resolvedDownload(candidate, info.source, userAgent, name, { maxConn: 16 });
            }
            if (['hotlink-blocked', 'rate-limited', 'unavailable'].includes(outcome.state)) {
                unavailableProxyOrigins.add(proxyOrigin);
            }
        }

        if (directRateLimited || directOutcome.state === 'rate-limited') {
            throw Object.assign(new Error('PixelDrain has rate-limited this connection. Wait for its quota window to reset or choose another mirror.'), {
                providerRateLimited: true,
                needsBrowser: false
            });
        }
        return null;
    };
    if (info.kind === 'file') return makeResult(info.id, '');
    if (typeof request !== 'function') throw new TypeError('PixelDrain list resolution requires a request function.');
    try {
        const response = await request('GET', `${info.origin}/api/list/${encodeURIComponent(info.id)}`, {
            headers: { 'User-Agent': userAgent, Accept: 'application/json', Referer: info.source },
            follow: false,
            timeoutMs: 10000
        });
        const status = Number(response && response.status) || 0;
        const responseBody = String(response && response.body || '');
        if ([404, 410].includes(status) || /"value"\s*:\s*"(?:not_found|list_not_found)"/i.test(responseBody)) {
            throw resolverDownError('PixelDrain reports that this file list was deleted or no longer exists.', 'pixeldrain-list-not-found');
        }
        if (status === 429 || /(?:rate[_ -]?limit|too many requests)/i.test(responseBody)) {
            throw Object.assign(new Error('PixelDrain has rate-limited this connection. Wait for its quota window to reset or choose another mirror.'), {
                providerRateLimited: true,
                needsBrowser: false
            });
        }
        if (!response || status < 200 || status >= 300) return null;
        const payload = boundedJsonResponse(response, 'PixelDrain list API');
        const files = extractPixeldrainFiles(payload);
        const output = [];
        for (const file of files.slice(0, 512)) {
            const result = await makeResult(file.id, file.name);
            if (result) output.push(result[0]);
        }
        return output.length ? output : null;
    } catch (error) {
        if (error && (error.linkHealth === 'down' || error.providerRateLimited)) throw error;
        return null;
    }
}

function fileKeeperHost(hostname, sourceHostname) {
    return isTrustedSubdomain(hostname, FILEKEEPER_HOST_RE, sourceHostname)
        || FILEKEEPER_CDN_HOST_RE.test(String(hostname || '').toLowerCase());
}

function fileKeeperDownloadUrl(value, baseUrl, sourceHostname) {
    const source = String(value || '').trim();
    if (!source || source.length > 8192 || /[\u0000-\u001f\u007f\\]/.test(source)) return '';
    let parsed;
    try { parsed = new URL(source, baseUrl); } catch (_) { return ''; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || !fileKeeperHost(parsed.hostname, sourceHostname)) return '';
    if (parsed.port && parsed.port !== '443') {
        if (parsed.port !== '8443' || !FILEKEEPER_ALT_PORT_HOST_RE.test(parsed.hostname)
            || !/^\/d\/[A-Za-z0-9_-]{16,512}\/[^/?#]{1,1024}$/i.test(parsed.pathname)) return '';
    }
    parsed.hash = '';
    return parsed.href;
}

async function resolveFileKeeperUrl(rawUrl, dependencies = {}) {
    const request = dependencies.request;
    if (typeof request !== 'function') throw new TypeError('FileKeeper resolution requires a request function.');
    const source = credentialFreeHttpsUrl(rawUrl);
    if (!source) return null;
    const parsed = new URL(source);
    if (!fileKeeperHost(parsed.hostname, parsed.hostname)) return null;
    const userAgent = String(dependencies.userAgent || 'Mozilla/5.0');
    const parts = parsed.pathname.split('/').filter(Boolean);
    const sourceName = cleanDownloadName(parts[parts.length - 1] || '');
    const code = cleanDownloadName(parsed.searchParams.get('f')
        || (parts[0] && /^file(?:\.php)?$/i.test(parts[0]) ? parts[1] : parts[0]));
    if (!code || code.length > 256) return null;
    const form = new URLSearchParams({ op: 'download2', id: code, rand: '', referer: source, method_free: '', down_direct: '1' });
    try {
        const response = await request('POST', source, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': userAgent,
                Referer: source,
                Accept: 'text/html,application/xhtml+xml,application/json'
            },
            body: form.toString(),
            follow: false,
            timeoutMs: 10000
        });
        const location = headerValue(response && response.headers, 'location');
        const body = String(response && response.body || '');
        const candidates = [location];
        for (const match of body.matchAll(/(?:href|data-(?:url|href|link|download))\s*=\s*(["'])((?:https?:)?\/\/.*?)\1/gi)) {
            candidates.push(String(match[2] || '').replace(/&amp;/gi, '&'));
        }
        for (const candidate of candidates) {
            const direct = fileKeeperDownloadUrl(candidate, source, parsed.hostname);
            if (!direct || samePageUrl(direct, source)) continue;
            const directName = fileNameFromUrl(direct);
            const dispositionName = fileNameFromDisposition(headerValue(response && response.headers, 'content-disposition'));
            const directHost = new URL(direct).hostname;
            const payloadName = /\.(?:zip|rar|7z|bin|iso|exe|msi|cab|pkg|torrent|\d{3}|part\d+|r\d{2}|z\d{2})$/i.test(directName);
            if (!FILEKEEPER_CDN_HOST_RE.test(directHost) && !dispositionName
                && !payloadName) continue;
            const name = dispositionName
                || (payloadName ? directName : '') || sourceName;
            return resolvedDownload(direct, source, userAgent, name);
        }
    } catch (_) {}
    return null;
}

function dataNodesHost(hostname, sourceHostname) {
    return isTrustedSubdomain(hostname, DATANODES_HOST_RE, sourceHostname);
}

function fuckingFastShareId(value) {
    const source = credentialFreeHttpsUrl(value);
    if (!source) return '';
    const parsed = new URL(source);
    if (!FUCKINGFAST_HOST_RE.test(parsed.hostname)) return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    const candidate = parts[0] && parts[0].toLowerCase() === 'f' ? parts[1] : parts[0];
    return /^[A-Za-z0-9_-]{4,128}$/.test(candidate || '') ? candidate : '';
}

function extractFuckingFastBrowserDownload(response, rawUrl) {
    const source = credentialFreeHttpsUrl(rawUrl);
    const sourceId = fuckingFastShareId(rawUrl);
    if (!source || !sourceId) return null;
    const status = Number(response && response.status) || 0;
    if (status < 200 || status >= 400) return null;
    const responseUrl = credentialFreeHttpsUrl(response && response.url, source);
    if (!responseUrl) return null;
    const responseParsed = new URL(responseUrl);
    const responseMatch = responseParsed.pathname.match(/^\/f\/([A-Za-z0-9_-]{4,128})\/go\/?$/i);
    if (!FUCKINGFAST_HOST_RE.test(responseParsed.hostname)
        || !responseMatch || responseMatch[1] !== sourceId) return null;
    const candidate = headerValue(response && response.headers, 'hx-redirect')
        || headerValue(response && response.headers, 'location');
    const direct = acceptedDirectUrl(candidate, responseUrl, value => {
        try {
            const parsed = new URL(value);
            return FUCKINGFAST_HOST_RE.test(parsed.hostname) && /^\/dl\//i.test(parsed.pathname);
        } catch (_) { return false; }
    });
    if (!direct || samePageUrl(direct, source) || samePageUrl(direct, responseUrl)) return null;
    let sourceName = '';
    try { sourceName = cleanDownloadName(new URL(String(rawUrl || '')).hash.slice(1)); } catch (_) {}
    const directName = fileNameFromUrl(direct);
    const payloadName = /\.(?:zip|rar|7z|bin|iso|exe|msi|cab|torrent|\d{3}|part\d+|r\d{2}|z\d{2})$/i.test(directName);
    return {
        url: direct,
        name: sourceName || (payloadName ? directName : ''),
        pageUrl: responseUrl
    };
}

function managedHostTransferRequest(provider, value, rawUrl) {
    const candidate = credentialFreeHttpsUrl(value);
    const source = credentialFreeHttpsUrl(rawUrl);
    if (!candidate || !source) return false;
    const parsed = new URL(candidate);
    if (provider === 'fuckingfast') {
        return FUCKINGFAST_HOST_RE.test(parsed.hostname) && /^\/dl\//i.test(parsed.pathname);
    }
    if (provider !== 'datanodes' || !DATANODES_HOST_RE.test(parsed.hostname)
        || samePageUrl(candidate, source) || /^\/download\/?$/i.test(parsed.pathname)) return false;
    return /^\/(?:d|dl|files?|download-file)\//i.test(parsed.pathname)
        || /\.(?:zip|rar|7z|bin|iso|exe|msi|cab|torrent|\d{3}|part\d+|r\d{2}|z\d{2})(?:$|[?#])/i.test(candidate);
}

function extractDataNodesBrowserDownload(response, rawUrl) {
    const source = credentialFreeHttpsUrl(rawUrl);
    if (!source || !dataNodesHost(new URL(source).hostname, new URL(source).hostname)) return null;
    const status = Number(response && response.status) || 0;
    if (status < 200 || status >= 300) return null;
    const pageUrl = credentialFreeHttpsUrl(response && response.url, source);
    if (!pageUrl) return null;
    const page = new URL(pageUrl);
    if (!dataNodesHost(page.hostname, new URL(source).hostname) || !/^\/download\/?$/i.test(page.pathname)) return null;
    let payload;
    try { payload = boundedJsonResponse(response, 'DataNodes browser response'); } catch (_) { return null; }
    let candidate = payload && (payload.downloadUrl || payload.download_url || payload.url)
        || payload && payload.data && (payload.data.downloadUrl || payload.data.download_url || payload.data.url);
    if (!candidate) return null;
    try { candidate = decodeURIComponent(String(candidate)); } catch (_) { candidate = String(candidate); }
    const direct = credentialFreeHttpsUrl(candidate, pageUrl);
    if (!direct || direct === pageUrl || direct === source) return null;
    return {
        url: direct,
        name: fileNameFromUrl(direct),
        pageUrl,
        transferAuthority: DATANODES_BROWSER_TRANSFER_AUTHORITY
    };
}

function publicTransferHostname(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!host || net.isIP(host) || host === 'localhost' || host.endsWith('.localhost')
        || host.endsWith('.local') || host.endsWith('.internal')) return false;
    return host.includes('.');
}

function dataNodesFileResponse(response, currentUrl, fallbackName = '') {
    const status = Number(response && response.status) || 0;
    if (![200, 206].includes(status)) return null;
    const contentType = headerValue(response && response.headers, 'content-type').split(';', 1)[0].trim().toLowerCase();
    if (/^(?:text\/|image\/|font\/)|(?:json|xml|javascript|xhtml|html|css)/i.test(contentType)) return null;
    const disposition = headerValue(response && response.headers, 'content-disposition');
    const dispositionName = fileNameFromDisposition(disposition);
    const urlName = fileNameFromUrl(currentUrl);
    const name = dispositionName || urlName || cleanDownloadName(fallbackName);
    const archiveName = /\.(?:zip|rar|7z|bin|iso|exe|msi|cab|torrent|\d{3}|part\d+|r\d{2}|z\d{2})$/i.test(name);
    const binaryType = /^(?:application\/(?:octet-stream|zip|x-7z-compressed|x-rar-compressed|vnd\.rar|x-compressed|x-msdownload)|binary\/octet-stream)$/i.test(contentType);
    const archiveApplicationType = archiveName && /^application\//i.test(contentType);
    if (!/\battachment\b/i.test(disposition) && !dispositionName && !binaryType && !archiveApplicationType) return null;
    return name;
}

async function validateDataNodesBrowserTransfer(captured, dependencies = {}) {
    if (!captured || captured.transferAuthority !== DATANODES_BROWSER_TRANSFER_AUTHORITY) return null;
    const request = dependencies.request;
    if (typeof request !== 'function') throw new TypeError('DataNodes transfer validation requires a request function.');
    const pageUrl = credentialFreeHttpsUrl(captured.pageUrl);
    if (!pageUrl) return null;
    const page = new URL(pageUrl);
    if (!dataNodesHost(page.hostname, page.hostname) || !/^\/download\/?$/i.test(page.pathname)) return null;
    let current = credentialFreeHttpsUrl(captured.url, pageUrl);
    if (!current || samePageUrl(current, pageUrl)) return null;
    const userAgent = String(captured.userAgent || dependencies.userAgent || 'Mozilla/5.0')
        .replace(/[\r\n]/g, '').slice(0, 512);
    const acceptUrl = typeof dependencies.acceptUrl === 'function' ? dependencies.acceptUrl : () => true;
    const browserCookieHeader = Array.isArray(captured.cookies)
        ? captured.cookies.map(cookie => `${String(cookie && cookie.name || '')}=${String(cookie && cookie.value || '')}`)
            .filter(value => !value.startsWith('=')).join('; ')
        : '';
    const cookieHeader = String(dependencies.cookie || captured.cookieHeader
        || captured.headers && captured.headers.Cookie || browserCookieHeader || '').replace(/[\r\n]/g, '');
    let cookieOrigin = '';
    try { cookieOrigin = new URL(String(captured.cookieOrigin || '')).origin; } catch (_) {}

    for (let hop = 0; hop < 3; hop++) {
        const parsed = new URL(current);
        if (!publicTransferHostname(parsed.hostname) || !acceptUrl(current)) return null;
        const headers = {
            'User-Agent': userAgent,
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            Referer: pageUrl,
            Range: 'bytes=0-0'
        };
        if (cookieHeader && cookieOrigin && parsed.origin === cookieOrigin) headers.Cookie = cookieHeader;
        let response;
        try {
            response = await request('GET', current, {
                headers,
                follow: false,
                headersOnly: true,
                timeoutMs: 10000
            });
        } catch (_) { return null; }
        const location = credentialFreeHttpsUrl(headerValue(response && response.headers, 'location'), current);
        if (response && response.status >= 300 && response.status < 400 && location) {
            if (samePageUrl(location, current)) return null;
            current = location;
            continue;
        }
        const name = dataNodesFileResponse(response, current, captured.name);
        if (!name) return null;
        return Object.assign({}, captured, {
            url: current,
            name,
            pageUrl,
            userAgent,
            cookies: cookieOrigin && new URL(current).origin === cookieOrigin && Array.isArray(captured.cookies)
                ? captured.cookies
                : [],
            headers: cookieOrigin && new URL(current).origin === cookieOrigin && cookieHeader
                ? { Cookie: cookieHeader }
                : null,
            validatedTransfer: true
        });
    }
    return null;
}

async function resolveDataNodesUrl(rawUrl, dependencies = {}) {
    const request = dependencies.request;
    if (typeof request !== 'function') throw new TypeError('DataNodes resolution requires a request function.');
    const source = credentialFreeHttpsUrl(rawUrl);
    if (!source) return null;
    const parsed = new URL(source);
    if (!dataNodesHost(parsed.hostname, parsed.hostname)) return null;
    const id = (parsed.pathname.split('/').filter(Boolean)[0] || '').match(/^[A-Za-z0-9_-]{4,128}$/);
    if (!id) return null;
    const userAgent = String(dependencies.userAgent || 'Mozilla/5.0');
    try {
        const pageHeaders = {
            'User-Agent': userAgent,
            Accept: 'text/html,application/xhtml+xml',
            Referer: credentialFreeHttpsUrl(dependencies.referer) || source
        };
        let pageUrl = source;
        let page = await request('GET', source, {
            headers: pageHeaders,
            follow: false,
            timeoutMs: 10000
        });
        if (page && [404, 410].includes(page.status)) {
            throw resolverDownError('DataNodes reports that this file was deleted or no longer exists.', 'datanodes-not-found');
        }
        let cookie = responseCookies(page && page.headers);
        const location = credentialFreeHttpsUrl(headerValue(page && page.headers, 'location'), source);
        if (location) {
            if (!dataNodesHost(new URL(location).hostname, parsed.hostname)) return null;
            pageUrl = location;
            page = await request('GET', pageUrl, {
                headers: Object.assign({}, pageHeaders, cookie ? { Cookie: cookie } : {}, { Referer: source }),
                follow: false,
                timeoutMs: 10000
            });
            cookie = mergeCookieHeaders(cookie, responseCookies(page && page.headers));
        }
        if (!page || page.status < 200 || page.status >= 300) return null;
        const body = String(page.body || '');
        const component = body.match(/<download-countdown\b([^>]*)>/i);
        if (!component) return null;
        const attribute = name => {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const match = component[1].match(new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`, 'i'));
            return decodeHtmlAttribute(match && (match[1] ?? match[2]) || '');
        };
        const hasCaptcha = /^true$/i.test(attribute(':has-captcha') || attribute('has-captcha'));
        const code = attribute('code') || id[0];
        const rand = attribute('rand');
        const dlToken = attribute('dl-token');
        const formReferer = attribute('referer') || source;
        // A real challenge must be completed by the user in the managed browser.
        // Never submit a forged/blank token: it only creates a verification loop.
        if (hasCaptcha || !rand || !dlToken || !/^[A-Za-z0-9_-]{4,128}$/.test(code)) return null;
        const form = new URLSearchParams({
            op: 'download2',
            id: code,
            rand,
            referer: formReferer,
            method_free: '',
            method_premium: '',
            g_captch__a: '1',
            dl_token: dlToken
        });
        const response = await request('POST', pageUrl, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': userAgent,
                Accept: 'application/json,text/html,*/*',
                Referer: pageUrl,
                'X-Dn-Dl': '1',
                ...(cookie ? { Cookie: cookie } : {})
            },
            body: form.toString(),
            follow: false,
            timeoutMs: 10000
        });
        const responseBody = String(response && response.body || '');
        let payload = null;
        try { payload = JSON.parse(responseBody); } catch (_) {}
        const candidates = [
            headerValue(response && response.headers, 'location'),
            payload && (payload.downloadUrl || payload.download_url || payload.url),
            payload && payload.data && (payload.data.downloadUrl || payload.data.download_url || payload.data.url)
        ];
        for (const candidate of candidates) {
            let decodedCandidate = candidate;
            try { decodedCandidate = decodeURIComponent(String(candidate || '')); } catch (_) {}
            const direct = credentialFreeHttpsUrl(decodedCandidate, pageUrl);
            if (!direct || samePageUrl(direct, source)) continue;
            const downloadCookie = mergeCookieHeaders(cookie, responseCookies(response && response.headers));
            const validated = await validateDataNodesBrowserTransfer({
                url: direct,
                pageUrl,
                name: fileNameFromUrl(direct),
                userAgent,
                cookieOrigin: new URL(pageUrl).origin,
                headers: downloadCookie ? { Cookie: downloadCookie } : null,
                transferAuthority: DATANODES_BROWSER_TRANSFER_AUTHORITY
            }, {
                request,
                userAgent,
                acceptUrl: dependencies.acceptDirectUrl
            });
            if (!validated) continue;
            const validatedCookie = validated.headers && validated.headers.Cookie;
            return resolvedDownload(validated.url, pageUrl, userAgent, validated.name, {
                maxConn: 1,
                headers: [
                    `Referer: ${pageUrl}`,
                    `User-Agent: ${userAgent}`,
                    ...(validatedCookie ? [`Cookie: ${validatedCookie}`] : [])
                ]
            });
        }
    } catch (error) {
        if (error && error.linkHealth === 'down') throw error;
    }
    return null;
}

function akiraBoxHost(hostname) {
    return AKIRABOX_HOST_RE.test(String(hostname || '').toLowerCase());
}

function akiraBoxId(rawUrl) {
    const source = credentialFreeHttpsUrl(rawUrl);
    if (!source) return null;
    const parsed = new URL(source);
    if (!akiraBoxHost(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const id = parts[0] || '';
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) return null;
    const canonical = new URL(source);
    canonical.hostname = 'akirabox.to';
    canonical.pathname = `/${encodeURIComponent(id)}/file`;
    canonical.search = '';
    canonical.hash = '';
    return { source, parsed, id, canonicalSource: canonical.href };
}

async function resolveAkiraBoxUrl(rawUrl, dependencies = {}) {
    const request = dependencies.request;
    if (typeof request !== 'function') throw new TypeError('AkiraBox resolution requires a request function.');
    const info = akiraBoxId(rawUrl);
    if (!info) return null;
    const userAgent = String(dependencies.userAgent || 'Mozilla/5.0');
    const apiOrigins = ['https://akirabox.to', info.parsed.origin, 'https://akirabox.com'];
    let canonicalDown = false;
    for (const origin of [...new Set(apiOrigins)]) {
        try {
            const response = await request('GET', `${origin}/api/files?url=${encodeURIComponent(info.canonicalSource)}`, {
                headers: { 'User-Agent': userAgent, Accept: 'application/json', Referer: info.source },
                follow: false,
                timeoutMs: 10000
            });
            if (response && [404, 410].includes(response.status)) {
                if (origin === 'https://akirabox.to') canonicalDown = true;
                continue;
            }
            if (!response || response.status < 200 || response.status >= 300) continue;
            const payload = boundedJsonResponse(response, 'AkiraBox API');
            const payloadStatus = Number(payload && payload.status);
            const payloadMessage = String(payload && (payload.message || payload.error) || '');
            if ([404, 410].includes(payloadStatus) || /\b(?:not\s+found|deleted|removed|expired)\b/i.test(payloadMessage)) {
                if (origin === 'https://akirabox.to') canonicalDown = true;
                continue;
            }
            const candidates = [];
            const visit = value => {
                if (!value || typeof value !== 'object') return;
                for (const [key, child] of Object.entries(value)) {
                    if (typeof child === 'string' && /(?:direct|download|link)/i.test(key)) candidates.push(child);
                    else if (child && typeof child === 'object') visit(child);
                }
            };
            visit(payload);
            for (const candidate of candidates) {
                const direct = acceptedDirectUrl(candidate, origin, url => akiraBoxHost(new URL(url).hostname));
                if (!direct || samePageUrl(direct, info.source)) continue;
                const directPath = new URL(direct).pathname.split('/').filter(Boolean);
                if (directPath[0] === info.id && directPath[1] === 'file') continue;
                return resolvedDownload(direct, info.source, userAgent, fileNameFromUrl(direct));
            }
        } catch (error) {
            if (error && error.linkHealth === 'down' && origin === 'https://akirabox.to') canonicalDown = true;
        }
    }
    if (canonicalDown) throw resolverDownError('AkiraBox reports that this file is offline or expired.', 'akirabox-api-not-found');
    return null;
}

function x1337Host(hostname) {
    return X1337_HOST_RE.test(String(hostname || '').toLowerCase());
}

function extract1337xLinks(pageHtml, pageUrl) {
    const source = credentialFreeHttpsUrl(pageUrl);
    if (!source || !x1337Host(new URL(source).hostname)) return [];
    const links = [];
    const html = String(pageHtml || '');
    for (const match of html.matchAll(/href\s*=\s*(["'])(.*?)\1/gi)) {
        const href = String(match[2] || '').replace(/&amp;/gi, '&').trim();
        if (/^magnet:\?xt=urn:btih:[A-Za-z0-9]{32,64}(?:&|$)/i.test(href)) {
            let name = '';
            try { name = cleanDownloadName(new URL(href).searchParams.get('dn')); } catch (_) {}
            links.push({ url: href, kind: 'magnet', name });
            continue;
        }
        const secure = credentialFreeHttpsUrl(href, source);
        if (!secure) continue;
        const parsed = new URL(secure);
        if (parsed.origin === new URL(source).origin && /\.torrent$/i.test(parsed.pathname)) links.push({ url: parsed.href, kind: 'http' });
    }
    return links.filter((item, index, all) => all.findIndex(candidate => candidate.url === item.url) === index).slice(0, 8);
}

async function resolve1337xUrl(rawUrl, dependencies = {}) {
    const request = dependencies.request;
    const source = credentialFreeHttpsUrl(rawUrl);
    if (!source || typeof request !== 'function') return null;
    const parsed = new URL(source);
    if (!x1337Host(parsed.hostname)) return null;
    const userAgent = String(dependencies.userAgent || 'Mozilla/5.0');
    try {
        const response = await request('GET', source, {
            headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' },
            follow: false,
            timeoutMs: 10000
        });
        if (!response || response.status < 200 || response.status >= 300) return null;
        const links = extract1337xLinks(response.body, source);
        if (!links.length) return null;
        // Magnet and .torrent controls are alternate representations of the same
        // payload, not multipart files. Prefer the magnet and keep a provider-hosted
        // .torrent as the fallback so the download job never queues both.
        const selected = links.find(link => link.kind === 'magnet') || links[0];
        if (selected.kind === 'magnet') {
            return [{ url: selected.url, name: selected.name || 'Torrent download', kind: 'magnet', maxConn: 1 }];
        }
        return resolvedDownload(selected.url, source, userAgent, fileNameFromUrl(selected.url), { maxConn: 1 });
    } catch (_) { return null; }
}

function buzzHeavierPathInfo(parsed) {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'd' && /^\d{6,32}$/.test(parts[1] || '') && parts.length >= 3) {
        return { path: parsed.pathname.replace(/\/$/, ''), legacyDirect: true };
    }
    const id = parts[0] || '';
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) return null;
    return { path: `/${id}`, legacyDirect: false };
}

function buzzHeavierDirectTransferUrl(rawUrl) {
    const secure = credentialFreeHttpsUrl(rawUrl);
    if (!secure) return '';
    const parsed = new URL(secure);
    if (!isBuzzHeavierHost(parsed.hostname)) return '';
    // Share pages live on the bare provider hosts. Signed payloads use dedicated
    // dl/cdn subdomains; those are already direct and must never reopen a browser.
    return /^(?:cdn|dl)\d*\./i.test(parsed.hostname) && parsed.pathname !== '/' ? parsed.href : '';
}

function buzzHeavierPageCandidates(rawUrl) {
    const secure = credentialFreeHttpsUrl(rawUrl);
    if (!secure) return [];
    const parsed = new URL(secure);
    if (!isBuzzHeavierHost(parsed.hostname)) return [];
    const pathInfo = buzzHeavierPathInfo(parsed);
    if (!pathInfo) return [];
    const origins = [parsed.origin, ...BUZZHEAVIER_MIRRORS];
    return [...new Set(origins)].map(origin => origin + pathInfo.path);
}

function decodeHtmlAttribute(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&#x3d;/gi, '=')
        .replace(/&#61;/g, '=');
}

function extractBuzzHeavierEndpoint(pageHtml, pageUrl) {
    const candidates = buzzHeavierPageCandidates(pageUrl);
    if (!candidates.length) return '';
    const page = new URL(candidates[0]);
    const pathInfo = buzzHeavierPathInfo(page);
    if (!pathInfo || pathInfo.legacyDirect) return '';
    const id = pathInfo.path.slice(1);
    const html = String(pageHtml || '');
    const endpoints = [];
    for (const match of html.matchAll(/hx-get\s*=\s*(["'])(.*?)\1/gi)) endpoints.push(decodeHtmlAttribute(match[2]));
    const inline = html.match(new RegExp(`\\/${id}\\/download\\?t=[^\\s"'<>]+`, 'i'));
    if (inline) endpoints.push(decodeHtmlAttribute(inline[0]));
    const tokenOnly = html.match(/download\?t=([A-Za-z0-9._~%-]{4,1024})/i);
    if (tokenOnly) endpoints.push(`/${id}/download?t=${tokenOnly[1]}`);

    for (const value of endpoints) {
        const secure = credentialFreeHttpsUrl(value, page.href);
        if (!secure) continue;
        const endpoint = new URL(secure);
        if (endpoint.hostname !== page.hostname || endpoint.pathname.replace(/\/$/, '') !== `/${id}/download`
            || !endpoint.searchParams.get('t')) continue;
        endpoint.searchParams.delete('alt');
        return endpoint.href;
    }
    return '';
}

function acceptedDirectUrl(value, baseUrl, acceptDirectUrl) {
    const secure = credentialFreeHttpsUrl(value, baseUrl);
    if (!secure) return '';
    if (typeof acceptDirectUrl === 'function' && !acceptDirectUrl(secure)) return '';
    return secure;
}

function samePageUrl(left, right) {
    try {
        const a = new URL(left);
        const b = new URL(right);
        return a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
    } catch (_) { return false; }
}

function resolvedDownload(directUrl, pageUrl, userAgent, name = '', options = {}) {
    const suppliedHeaders = Array.isArray(options.headers)
        ? options.headers.filter(value => typeof value === 'string' && value.length <= 8192 && /^[A-Za-z0-9-]+:\s*[^\r\n]+$/.test(value))
        : [];
    const maxConn = Number.isSafeInteger(options.maxConn)
        ? Math.max(1, Math.min(16, options.maxConn))
        : 1;
    const resolved = {
        url: directUrl,
        name: cleanDownloadName(name) || fileNameFromUrl(directUrl),
        kind: 'http',
        maxConn,
        headers: suppliedHeaders.length ? suppliedHeaders : [`Referer: ${pageUrl}`, `User-Agent: ${userAgent}`]
    };
    if (options.resumeAcrossFreshUrl === true) resolved.resumeAcrossFreshUrl = true;
    return [resolved];
}

function resolverDownError(message, reason) {
    return Object.assign(new Error(message), {
        linkHealth: 'down',
        healthReason: String(reason || 'provider-reports-down').slice(0, 160)
    });
}

function rootzPageDetails(pageHtml, pageUrl) {
    const secure = credentialFreeHttpsUrl(pageUrl);
    if (!secure) return null;
    const parsed = new URL(secure);
    if (!ROOTZ_HOST_RE.test(parsed.hostname)) return null;
    const shortMatch = parsed.pathname.match(/^\/d\/([A-Za-z0-9_-]{4,128})\/?$/);
    if (!shortMatch) return null;
    const html = String(pageHtml || '');
    const tokenMatch = html.match(/pageToken(?:\\?"|&quot;)?\s*:\s*(?:\\?"|&quot;)([A-Za-z0-9._~-]{16,512})/i);
    return {
        shortId: shortMatch[1],
        pageToken: tokenMatch ? tokenMatch[1] : ''
    };
}

async function resolveRootzUrl(rawUrl, dependencies = {}) {
    const request = dependencies.request;
    if (typeof request !== 'function') throw new TypeError('Rootz resolution requires a request function.');
    const source = credentialFreeHttpsUrl(rawUrl);
    if (!source || !ROOTZ_HOST_RE.test(new URL(source).hostname)) return null;
    const userAgent = String(dependencies.userAgent || 'Mozilla/5.0');
    const page = await request('GET', source, {
        headers: { 'User-Agent': userAgent, 'Accept': 'text/html,application/xhtml+xml' },
        follow: false,
        timeoutMs: 10000
    });
    if (page && [404, 410].includes(page.status)) {
        throw resolverDownError('Rootz reports that this file was deleted or no longer exists.', 'rootz-page-not-found');
    }
    if (!page || page.status < 200 || page.status >= 300) return null;
    const details = rootzPageDetails(page.body, source);
    if (!details || !details.pageToken) return null;
    const apiUrl = `${new URL(source).origin}/api/files/download-by-short?shortId=${encodeURIComponent(details.shortId)}`;
    const metadata = await request('GET', apiUrl, {
        headers: {
            'User-Agent': userAgent,
            'Accept': 'application/json',
            'Referer': source,
            'X-Page-Token': details.pageToken
        },
        follow: false,
        timeoutMs: 10000
    });
    if (metadata && [404, 410].includes(metadata.status)) {
        throw resolverDownError('Rootz reports that this file was deleted or no longer exists.', 'rootz-metadata-not-found');
    }
    if (!metadata || metadata.status < 200 || metadata.status >= 300) return null;
    let payload;
    try { payload = JSON.parse(String(metadata.body || '')); } catch (_) { return null; }
    const data = payload && payload.data;
    const status = String(data && data.status || '').toLowerCase();
    if (!payload.success || ['deleted', 'removed', 'expired', 'not-found', 'not_found'].includes(status)) {
        throw resolverDownError('Rootz reports that this file was deleted or no longer exists.', `rootz-${status || 'not-found'}`);
    }
    const fileId = String(data && data.fileId || '');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(fileId) || data.downloadAllowed === false) return null;
    const direct = credentialFreeHttpsUrl(`/api/files/proxy-download/${encodeURIComponent(fileId)}`, source);
    if (!direct || !ROOTZ_HOST_RE.test(new URL(direct).hostname)) return null;
    return resolvedDownload(direct, source, userAgent, data.fileName, {
        maxConn: 1,
        headers: [
            `Referer: ${source}`,
            `User-Agent: ${userAgent}`,
            `X-Page-Token: ${details.pageToken}`
        ]
    });
}

async function resolveVikingFileUrl(rawUrl, dependencies = {}) {
    const request = dependencies.request;
    if (typeof request !== 'function') throw new TypeError('VikingFile resolution requires a request function.');
    let source = credentialFreeHttpsUrl(rawUrl);
    if (!source || !VIKINGFILE_HOST_RE.test(new URL(source).hostname)) return null;
    const userAgent = String(dependencies.userAgent || 'Mozilla/5.0');
    const sourceHashMatch = new URL(source).pathname.match(/^\/f\/([A-Za-z0-9_-]{4,128})\/?$/);
    let apiConfirmedAvailable = false;
    let apiFileName = '';
    if (sourceHashMatch) {
        try {
            const statusResponse = await request('POST', 'https://vikingfile.com/api/check-file', {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': userAgent,
                    'Accept': 'application/json',
                    'Referer': 'https://vikingfile.com/'
                },
                body: new URLSearchParams({ hash: sourceHashMatch[1] }).toString(),
                follow: false,
                timeoutMs: 10000
            });
            if (statusResponse && statusResponse.status >= 200 && statusResponse.status < 300) {
                const payload = boundedJsonResponse(statusResponse, 'VikingFile status API');
                const status = Array.isArray(payload) ? payload[0]
                    : payload && payload[sourceHashMatch[1]] || payload;
                if (status && status.exist === false) {
                    throw resolverDownError('VikingFile reports that this file was deleted or no longer exists.', 'vikingfile-api-not-found');
                }
                if (status && status.exist === true) {
                    apiConfirmedAvailable = true;
                    apiFileName = cleanDownloadName(status.name);
                }
            }
        } catch (error) {
            if (error && error.linkHealth === 'down') throw error;
        }
    }
    let page = null;
    for (let redirect = 0; redirect < 3; redirect++) {
        page = await request('GET', source, {
            headers: { 'User-Agent': userAgent, 'Accept': 'text/html,application/xhtml+xml', 'Referer': new URL(source).origin + '/' },
            follow: false,
            timeoutMs: 10000
        });
        if (page && [404, 410].includes(page.status)) {
            if (apiConfirmedAvailable) return null;
            throw resolverDownError('VikingFile reports that this file was deleted or no longer exists.', 'vikingfile-not-found');
        }
        const location = credentialFreeHttpsUrl(headerValue(page && page.headers, 'location'), source);
        if (!location) break;
        if (!VIKINGFILE_HOST_RE.test(new URL(location).hostname)) return null;
        source = location;
    }
    if (!page || page.status < 200 || page.status >= 300) return null;
    const body = String(page.body || '');
    if (/\b(?:file\s+(?:was\s+)?(?:deleted|removed|not\s+found)|404\s+not\s+found)\b/i.test(body)) {
        throw resolverDownError('VikingFile reports that this file was deleted or no longer exists.', 'vikingfile-page-reports-down');
    }
    const directMatch = body.match(/https?:\\?\/\\?\/[^"'\s<>\\]+\/download\/[^"'\s<>\\]+/i);
    const direct = credentialFreeHttpsUrl(directMatch && directMatch[0] && directMatch[0].replace(/\\\//g, '/'), source);
    if (direct && VIKINGFILE_HOST_RE.test(new URL(direct).hostname)) {
        return resolvedDownload(direct, source, userAgent, fileNameFromUrl(direct) || apiFileName);
    }
    return null;
}

async function resolveBuzzHeavierUrl(rawUrl, dependencies = {}) {
    const request = dependencies.request;
    if (typeof request !== 'function') throw new TypeError('BuzzHeavier resolution requires a request function.');
    const userAgent = String(dependencies.userAgent || 'Mozilla/5.0');
    const sourceReferer = credentialFreeHttpsUrl(dependencies.referer);
    const existingDirect = buzzHeavierDirectTransferUrl(rawUrl);
    if (existingDirect) {
        return resolvedDownload(existingDirect, sourceReferer || new URL(existingDirect).origin + '/', userAgent, fileNameFromUrl(existingDirect), {
            maxConn: 1,
            resumeAcrossFreshUrl: true
        });
    }
    const candidates = buzzHeavierPageCandidates(rawUrl);
    if (!candidates.length) return null;
    const pathInfo = buzzHeavierPathInfo(new URL(candidates[0]));
    const acceptBuzzDirect = value => {
        let host = '';
        try { host = new URL(value).hostname; } catch (_) { return false; }
        return isBuzzHeavierHost(host)
            && (typeof dependencies.acceptDirectUrl !== 'function' || dependencies.acceptDirectUrl(value));
    };

    const resolveCandidate = async pageUrl => {
        try {
            const pageHeaders = { 'User-Agent': userAgent, 'Accept': 'text/html,application/xhtml+xml' };
            if (sourceReferer) pageHeaders.Referer = sourceReferer;
            const page = await request('GET', pageUrl, {
                headers: pageHeaders,
                follow: false,
                timeoutMs: 8000
            });
            if (!page || page.status < 200 || page.status >= 400) return null;
            const pageCookie = responseCookies(page.headers);
            const endpoint = extractBuzzHeavierEndpoint(page.body, pageUrl);
            if (!endpoint) return null;
            const response = await request('GET', endpoint, {
                headers: {
                    'HX-Current-URL': pageUrl,
                    'HX-Request': 'true',
                    'Referer': pageUrl,
                    'User-Agent': userAgent,
                    ...(pageCookie ? { Cookie: pageCookie } : {})
                },
                follow: false,
                timeoutMs: 10000
            });
            const rawDirect = headerValue(response && response.headers, 'hx-redirect')
                || headerValue(response && response.headers, 'location');
            const direct = acceptedDirectUrl(rawDirect, pageUrl, acceptBuzzDirect);
            if (!direct || samePageUrl(direct, pageUrl)) return null;
            const name = fileNameFromDisposition(headerValue(response && response.headers, 'content-disposition'));
            const cookie = mergeCookieHeaders(pageCookie, responseCookies(response && response.headers));
            return resolvedDownload(direct, pageUrl, userAgent, name, {
                headers: [
                    `Referer: ${pageUrl}`,
                    `User-Agent: ${userAgent}`,
                    ...(cookie ? [`Cookie: ${cookie}`] : [])
                ],
                maxConn: 1,
                resumeAcrossFreshUrl: true
            });
        } catch (_) { return null; }
    };

    let resolved = null;
    if (pathInfo.legacyDirect) {
        try {
            const legacyUrl = candidates[0];
            const response = await request('GET', legacyUrl, {
                headers: {
                    'User-Agent': userAgent,
                    Accept: '*/*',
                    Range: 'bytes=0-0',
                    ...(sourceReferer ? { Referer: sourceReferer } : {})
                },
                follow: false,
                timeoutMs: 10000
            });
            if (response && [404, 410].includes(response.status)) {
                throw resolverDownError('BuzzHeavier reports that this file was deleted or no longer exists.', 'buzzheavier-not-found');
            }
            const type = headerValue(response && response.headers, 'content-type');
            const disposition = headerValue(response && response.headers, 'content-disposition');
            const body = String(response && response.body || '').trimStart();
            const location = acceptedDirectUrl(headerValue(response && response.headers, 'location'), legacyUrl, acceptBuzzDirect);
            const transferUrl = location && !samePageUrl(location, legacyUrl) ? location : legacyUrl;
            if (response && response.status >= 200 && response.status < 400
                && !/text\/html|application\/json/i.test(type)
                && !/^(?:<|\{)/.test(body)) {
                const cookie = responseCookies(response.headers);
                resolved = resolvedDownload(transferUrl, legacyUrl, userAgent,
                    fileNameFromDisposition(disposition) || fileNameFromUrl(legacyUrl), {
                        headers: [
                            `Referer: ${legacyUrl}`,
                            `User-Agent: ${userAgent}`,
                            ...(cookie ? [`Cookie: ${cookie}`] : [])
                        ],
                        maxConn: 1,
                        resumeAcrossFreshUrl: true
                    });
            }
        } catch (error) {
            if (error && error.linkHealth === 'down') throw error;
        }
    } else {
        resolved = await resolveCandidate(candidates[0]);
    }
    if (!resolved && !pathInfo.legacyDirect && candidates.length > 1) {
        try {
            resolved = await Promise.any(candidates.slice(1).map(async pageUrl => {
                const result = await resolveCandidate(pageUrl);
                if (!result) throw new Error('unresolved');
                return result;
            }));
        } catch (_) { resolved = null; }
    }
    if (resolved) return resolved;

    if (typeof dependencies.browserResolve !== 'function') return null;
    try {
        const browserResult = await dependencies.browserResolve(candidates[0], sourceReferer);
        const rawDirect = typeof browserResult === 'string' ? browserResult : browserResult && browserResult.url;
        const pageUrl = browserResult && browserResult.pageUrl || candidates[0];
        const direct = acceptedDirectUrl(rawDirect, pageUrl, acceptBuzzDirect);
        const capturedDownload = !!(browserResult && browserResult.capturedDownload);
        if (!direct || samePageUrl(direct, pageUrl) && !capturedDownload) return null;
        return resolvedDownload(direct, pageUrl, userAgent, browserResult && browserResult.name, {
            headers: browserResult && browserResult.headers,
            maxConn: 1,
            resumeAcrossFreshUrl: true
        });
    } catch (_) { return null; }
}

function megadbTokenDetails(pageHtml, pageUrl) {
    const html = String(pageHtml || '');
    const match = html.match(/\bvar\s+finalDownloadUrl\s*=\s*(["'])(.*?)\1\s*;/i);
    const tokenUrl = credentialFreeHttpsUrl(match && match[2], pageUrl);
    if (!tokenUrl) return null;
    const page = new URL(pageUrl);
    const token = new URL(tokenUrl);
    if (!MEGADB_HOST_RE.test(page.hostname) || token.hostname !== page.hostname
        || token.pathname !== page.pathname || !token.searchParams.get('pt')) return null;
    const secondsMatch = html.match(/\bvar\s+seconds\s*=\s*(\d{1,2})\s*;/i);
    const seconds = Math.max(0, Math.min(30, Number(secondsMatch && secondsMatch[1]) || 0));
    return { url: token.href, waitMs: (seconds + 1) * 1000 };
}

function responseCookies(headers) {
    const key = headers && Object.keys(headers).find(candidate => candidate.toLowerCase() === 'set-cookie');
    const value = key ? headers[key] : '';
    const rows = Array.isArray(value) ? value : (value ? [value] : []);
    return rows.map(row => String(row || '').split(';')[0].trim()).filter(Boolean).join('; ');
}

function mergeCookieHeaders(...headers) {
    const cookies = new Map();
    for (const header of headers) {
        for (const part of String(header || '').split(';')) {
            const separator = part.indexOf('=');
            if (separator <= 0) continue;
            const name = part.slice(0, separator).trim();
            const value = part.slice(separator + 1).trim();
            if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/[\r\n]/.test(value)) cookies.set(name, value);
        }
    }
    return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function resolveMegaDbUrl(rawUrl, dependencies = {}) {
    const request = dependencies.request;
    if (typeof request !== 'function') throw new TypeError('MegaDB resolution requires a request function.');
    const source = credentialFreeHttpsUrl(rawUrl);
    const sourceReferer = credentialFreeHttpsUrl(dependencies.referer);
    if (!source || !sourceReferer) return null;
    const parsed = new URL(source);
    if (!MEGADB_HOST_RE.test(parsed.hostname)) return null;
    const userAgent = String(dependencies.userAgent || 'Mozilla/5.0');

    try {
        const page = await request('GET', source, {
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml',
                'Referer': sourceReferer
            },
            follow: false,
            timeoutMs: 10000
        });
        if (!page || page.status < 200 || page.status >= 300) return null;
        const token = megadbTokenDetails(page.body, source);
        if (!token) return null;
        const wait = typeof dependencies.wait === 'function'
            ? dependencies.wait
            : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
        await wait(token.waitMs);

        const cookie = responseCookies(page.headers);
        const tokenHeaders = {
            'User-Agent': userAgent,
            'Accept': '*/*',
            'Referer': source,
            'Range': 'bytes=0-0'
        };
        if (cookie) tokenHeaders.Cookie = cookie;
        const response = await request('GET', token.url, {
            headers: tokenHeaders,
            follow: false,
            timeoutMs: 10000
        });
        const direct = credentialFreeHttpsUrl(headerValue(response && response.headers, 'location'), source);
        if (!direct || !MEGADB_HOST_RE.test(new URL(direct).hostname) || samePageUrl(direct, source)) return null;
        const name = fileNameFromDisposition(headerValue(response.headers, 'content-disposition')) || fileNameFromUrl(direct);
        // MegaDB's signed CDN URLs support byte ranges. Let aria2 split the
        // archive across its full connection pool, matching dedicated download
        // managers instead of forcing this host through one slow stream.
        return resolvedDownload(direct, source, userAgent, name, { maxConn: 16 });
    } catch (_) { return null; }
}

async function resolveFileDitchUrl(rawUrl, dependencies = {}) {
    const request = dependencies.request;
    if (typeof request !== 'function') throw new TypeError('FileDitch resolution requires a request function.');
    const source = credentialFreeHttpsUrl(rawUrl);
    if (!source) return null;
    const parsed = new URL(source);
    if (!isFileDitchHost(parsed.hostname)) return null;
    const userAgent = String(dependencies.userAgent || 'Mozilla/5.0');
    const sourceName = cleanDownloadName(parsed.searchParams.get('f')) || fileNameFromUrl(source);

    const referer = `${parsed.origin}/`;
    let current = source;
    for (let hop = 0; hop < 3; hop++) {
        try {
            const response = await request('GET', current, {
                headers: { 'User-Agent': userAgent, 'Referer': referer, Range: 'bytes=0-0' },
                follow: false,
                timeoutMs: 10000,
                headersOnly: true
            });
            if (response && [404, 410].includes(response.status)) {
                throw resolverDownError('FileDitch reports that this file is offline or expired.', 'fileditch-not-found');
            }
            if (response && response.status >= 500) {
                throw resolverDownError('FileDitch is unavailable right now. Choose another mirror.', `fileditch-http-${response.status}`);
            }
            const location = headerValue(response && response.headers, 'location');
            if (location) {
                const redirect = credentialFreeHttpsUrl(location, current);
                if (!redirect || !isFileDitchHost(new URL(redirect).hostname)
                    || typeof dependencies.acceptDirectUrl === 'function' && !dependencies.acceptDirectUrl(redirect)) {
                    throw resolverDownError('FileDitch reports that this file is offline or expired.', 'fileditch-redirected-away');
                }
                if (samePageUrl(redirect, current)) {
                    throw resolverDownError('FileDitch is redirecting this file in a loop.', 'fileditch-redirect-loop');
                }
                current = redirect;
                continue;
            }
            const contentType = headerValue(response && response.headers, 'content-type');
            if (response && [200, 206].includes(response.status) && !/text\/html|application\/xhtml/i.test(contentType)) {
                const name = fileNameFromDisposition(headerValue(response.headers, 'content-disposition'))
                    || fileNameFromUrl(current) || sourceName;
                return [{ url: current, name, kind: 'http', headers: [`Referer: ${referer}`, `User-Agent: ${userAgent}`] }];
            }
            return null;
        } catch (error) {
            if (error && error.linkHealth === 'down') throw error;
            return null;
        }
    }
    throw resolverDownError('FileDitch is redirecting this file too many times.', 'fileditch-redirect-loop');
}

module.exports = {
    BUZZHEAVIER_HOST_RE,
    AKIRABOX_HOST_RE,
    DATANODES_HOST_RE,
    DATANODES_BROWSER_TRANSFER_AUTHORITY,
    FILEDITCH_HOST_RE,
    FILEKEEPER_HOST_RE,
    FUCKINGFAST_HOST_RE,
    PIXELDRAIN_HOST_RE,
    ROOTZ_HOST_RE,
    VIKINGFILE_HOST_RE,
    X1337_HOST_RE,
    buzzHeavierPageCandidates,
    createGofileResolver,
    credentialFreeHttpsUrl,
    extractGofileWebsiteTokenSecret,
    extractBuzzHeavierEndpoint,
    extractDataNodesBrowserDownload,
    extractFuckingFastBrowserDownload,
    fileKeeperDownloadUrl,
    gofileDirectDownloadUrl,
    gofileShareDetails,
    gofileWebsiteToken,
    managedHostTransferRequest,
    rootzPageDetails,
    megadbTokenDetails,
    extract1337xLinks,
    resolve1337xUrl,
    resolveAkiraBoxUrl,
    resolveBuzzHeavierUrl,
    resolveDataNodesUrl,
    resolveFileDitchUrl,
    resolveFileKeeperUrl,
    resolveGofileUrl,
    resolveMegaDbUrl,
    resolvePixeldrainUrl,
    resolveRootzUrl,
    resolveVikingFileUrl,
    validateDataNodesBrowserTransfer
};
