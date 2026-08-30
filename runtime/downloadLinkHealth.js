'use strict';

const { rootzPageDetails } = require('./downloadHostResolvers');

// Health checks are deliberately conservative. A host returning a challenge,
// rate-limit, redirect, or an HTML page is not the same thing as a dead file.
// Callers may use this module from the main process before starting a download;
// it never turns an untrusted renderer URL into an unrestricted HTTP request.

const HEALTH_STATES = Object.freeze({
    AVAILABLE: 'available',
    DOWN: 'down',
    VERIFICATION_REQUIRED: 'verification-required',
    UNKNOWN: 'unknown'
});

const PROVIDER_HOSTS = Object.freeze({
    filecrypt: /^(?:www\.)?filecrypt\.cc$/i,
    gofile: /^(?:www\.)?gofile\.io$/i,
    fileditch: /(^|\.)fileditch(?:files)?\.(?:com|net|me)$/i,
    buzzheavier: /(^|\.)(?:bzzhr\.to|bzzhr\.co|buzzheavier\.com|fuckingfast\.net)$/i,
    fuckingfast: /^(?:www\.)?fuckingfast\.(?:co|com|net)$/i,
    datanodes: /(^|\.)datanodes\.(?:to|net)$/i,
    akirabox: /^(?:www\.)?akirabox\.(?:com|to)$/i,
    x1337: /^(?:www\.)?1337x\.(?:to|st|gd|is|tw|ws)$/i,
    rutor: /^(?:d\.)?rutor\.info$/i,
    filekeeper: /(^|\.)filekeeper\.(?:net|me|org|io)$/i,
    pixeldrain: /(^|\.)pixeldrain\.(?:com|net|in|nl|biz|tech|dev)$/i,
    megadb: /^(?:www\.)?megadb\.net$/i,
    multiup: /^(?:www\.)?multiup\.(?:io|org|eu|to)$/i,
    rootz: /^(?:www\.)?rootz\.so$/i,
    vikingfile: /^(?:www\.)?(?:vikingfile\.com|vik1ngfile\.site)$/i
});

const PROVIDER_BY_HOST = Object.freeze(Object.keys(PROVIDER_HOSTS));
const HTML_CONTENT_TYPE = /(?:text\/html|application\/xhtml\+xml)/i;
const CHALLENGE_BODY = /(?:just a moment|checking your browser|attention required|cf-browser-verification|challenge-platform|enable javascript and cookies|verifying you are human|ddos-guard|captcha|verification failed)/i;
const EXPLICIT_DEAD_BODY = /(?:\b0\s+online\b|\b(?:offline|dead|removed|deleted|not\s+found|file\s+unavailable)\b)/i;
const EXPLICIT_ONLINE_BODY = /\b(?:online|available|active)\b/i;

function safeUrl(value) {
    let parsed;
    try { parsed = new URL(String(value || '').trim()); } catch (_) { return null; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || (parsed.port && parsed.port !== '443')) return null;
    // Several providers put the intended filename in a fragment. Fragments are
    // never sent over HTTP, so discard them instead of hiding the health state.
    parsed.hash = '';
    return parsed;
}

function providerForUrl(value) {
    const parsed = value instanceof URL ? value : safeUrl(value);
    if (!parsed) return '';
    return PROVIDER_BY_HOST.find(name => PROVIDER_HOSTS[name].test(parsed.hostname)) || '';
}

function providerHostAllowed(value, provider) {
    const parsed = value instanceof URL ? value : safeUrl(value);
    return !!parsed && !!provider && !!PROVIDER_HOSTS[provider] && PROVIDER_HOSTS[provider].test(parsed.hostname);
}

function sourceAllowed(sourceId) {
    return !sourceId || /^(?:steamrip|steamgg|fitgirl)$/i.test(String(sourceId));
}

function isHealthTargetAllowed(value, sourceId) {
    const parsed = safeUrl(value);
    return !!parsed && sourceAllowed(sourceId) && !!providerForUrl(parsed);
}

function bodyText(response) {
    return String(response && response.body || '').slice(0, 512 * 1024);
}

function header(response, name) {
    const headers = response && response.headers;
    if (!headers || typeof headers !== 'object') return '';
    const target = String(name).toLowerCase();
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === target);
    const value = key ? headers[key] : '';
    return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function result(status, reason, response, extra = {}) {
    return Object.freeze(Object.assign({
        status,
        reason: String(reason || status).slice(0, 160),
        httpStatus: Number.isInteger(response && response.status) ? response.status : 0
    }, extra));
}

function classifyFileCryptResponse(response) {
    const status = Number(response && response.status) || 0;
    if (status === 404 || status === 410) return result(HEALTH_STATES.DOWN, 'container-not-found', response);
    if (status === 401 || status === 403 || status === 429) return result(HEALTH_STATES.VERIFICATION_REQUIRED, 'container-verification-required', response);
    if (status < 200 || status >= 300) return result(HEALTH_STATES.UNKNOWN, 'container-http-' + status, response);

    const body = bodyText(response);
    // FileCrypt renders provider rows such as "0 Online" when its mirror is
    // unavailable. This is the one case safe enough to call down before any
    // resolver/browser work; generic HTML and ads remain unknown.
    if (EXPLICIT_DEAD_BODY.test(body) && /(?:online|file|download|mirror|gofile|buzzheavier|datanodes)/i.test(body)) {
        return result(HEALTH_STATES.DOWN, 'container-reports-no-online-mirror', response);
    }
    if (CHALLENGE_BODY.test(body)) return result(HEALTH_STATES.VERIFICATION_REQUIRED, 'container-challenge', response);
    if (EXPLICIT_ONLINE_BODY.test(body)) return result(HEALTH_STATES.AVAILABLE, 'container-online', response);
    return result(HEALTH_STATES.UNKNOWN, 'container-status-not-disclosed', response);
}

function classifyResponse(response, provider, options = {}) {
    if (provider === 'filecrypt') return classifyFileCryptResponse(response);
    const status = Number(response && response.status) || 0;
    if (status === 404 || status === 410) return result(HEALTH_STATES.DOWN, 'http-' + status, response);
    if (status === 401 || status === 403 || status === 429) return result(HEALTH_STATES.VERIFICATION_REQUIRED, 'http-' + status, response);
    if (status >= 500 && status <= 599) return result(HEALTH_STATES.UNKNOWN, 'http-' + status, response);
    if (status >= 300 && status < 400) return result(HEALTH_STATES.UNKNOWN, 'redirect-requires-resolution', response);
    if (status < 200 || status >= 300) return result(HEALTH_STATES.UNKNOWN, 'http-' + status, response);

    const contentType = header(response, 'content-type');
    const body = bodyText(response);
    // A successful HTML response from a file host is usually a landing page or
    // challenge, not proof that the archive can be downloaded.
    if (HTML_CONTENT_TYPE.test(contentType) || CHALLENGE_BODY.test(body)) {
        return result(CHALLENGE_BODY.test(body) ? HEALTH_STATES.VERIFICATION_REQUIRED : HEALTH_STATES.UNKNOWN,
            CHALLENGE_BODY.test(body) ? 'provider-challenge' : 'provider-page', response);
    }
    if (options.requireFile && !contentType && !body) return result(HEALTH_STATES.UNKNOWN, 'empty-response', response);
    return result(HEALTH_STATES.AVAILABLE, 'http-' + status, response);
}

function validateResponseUrl(response, target, provider) {
    const location = response && response.headers && (response.headers.location || response.headers.Location);
    if (!location) return true;
    let redirected;
    try { redirected = new URL(String(Array.isArray(location) ? location[0] : location), target); } catch (_) { return false; }
    return redirected.protocol === 'https:' && providerHostAllowed(redirected, provider);
}

function requestTimeout(options) {
    return Math.max(1000, Math.min(12000, Number(options.timeoutMs) || 8000));
}

async function checkFileDitchHealth(parsed, options) {
    const headers = Object.assign({
        Accept: '*/*',
        Range: 'bytes=0-0'
    }, options.headers || {});
    let target = new URL(parsed.href);
    for (let redirect = 0; redirect < 3; redirect++) {
        let response;
        try {
            response = await options.request('GET', target.href, {
                headers,
                follow: false,
                timeoutMs: requestTimeout(options),
                headersOnly: true
            });
        } catch (_) {
            return result(HEALTH_STATES.UNKNOWN, 'health-request-failed');
        }
        const status = Number(response && response.status) || 0;
        if (status === 404 || status === 410) return result(HEALTH_STATES.DOWN, 'fileditch-not-found', response);
        if ([401, 403, 429].includes(status)) {
            return result(HEALTH_STATES.VERIFICATION_REQUIRED, 'fileditch-verification-required', response);
        }
        if (status >= 500) return result(HEALTH_STATES.UNKNOWN, 'fileditch-http-' + status, response);
        const location = header(response, 'location');
        if (location) {
            let redirected;
            try { redirected = new URL(location, target); } catch (_) {
                return result(HEALTH_STATES.UNKNOWN, 'unsafe-provider-redirect', response);
            }
            if (redirected.protocol !== 'https:' || redirected.username || redirected.password) {
                return result(HEALTH_STATES.UNKNOWN, 'unsafe-provider-redirect', response);
            }
            if (!providerHostAllowed(redirected, 'fileditch')) {
                // FileDitch sends removed files back to the repack source homepage.
                // Treat only those known source redirects as an expired mirror; an
                // arbitrary off-provider redirect remains unknown and fail-closed.
                if (/^(?:www\.)?(?:steamrip\.com|fitgirl-repacks\.site|steamgg\.net)$/i.test(redirected.hostname)) {
                    return result(HEALTH_STATES.DOWN, 'fileditch-redirected-away', response);
                }
                return result(HEALTH_STATES.UNKNOWN, 'unsafe-provider-redirect', response);
            }
            if (redirected.href === target.href) return result(HEALTH_STATES.DOWN, 'fileditch-redirect-loop', response);
            target = redirected;
            continue;
        }
        return classifyResponse(response, 'fileditch', { requireFile: true });
    }
    return result(HEALTH_STATES.DOWN, 'fileditch-redirect-loop');
}

async function checkAkiraBoxHealth(parsed, options) {
    const id = (parsed.pathname.split('/').filter(Boolean)[0] || '').trim();
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) return result(HEALTH_STATES.UNKNOWN, 'akirabox-invalid-id');
    const target = `https://akirabox.to/${encodeURIComponent(id)}/file`;
    const apiOrigins = [...new Set(['https://akirabox.to', parsed.origin, 'https://akirabox.com'])];
    let canonicalDownResponse = null;
    for (const origin of apiOrigins) {
        let response;
        try {
            response = await options.request('GET', `${origin}/api/files?url=${encodeURIComponent(target)}`, {
                headers: Object.assign({ Accept: 'application/json', Referer: parsed.href }, options.headers || {}),
                follow: false,
                timeoutMs: requestTimeout(options)
            });
        } catch (_) {
            continue;
        }
        const status = Number(response && response.status) || 0;
        if (status === 404 || status === 410) {
            if (origin === 'https://akirabox.to') canonicalDownResponse = response;
            continue;
        }
        if ([401, 403, 429].includes(status)) {
            if (origin === 'https://akirabox.to') {
                return result(HEALTH_STATES.VERIFICATION_REQUIRED, 'akirabox-verification-required', response);
            }
            continue;
        }
        if (status < 200 || status >= 300) continue;
        let payload;
        try { payload = JSON.parse(bodyText(response)); } catch (_) {
            return result(HEALTH_STATES.UNKNOWN, 'akirabox-api-invalid', response);
        }
        const payloadStatus = Number(payload && payload.status);
        const message = String(payload && (payload.message || payload.error) || '');
        if ([404, 410].includes(payloadStatus) || /\b(?:not\s+found|deleted|removed|expired)\b/i.test(message)) {
            if (origin === 'https://akirabox.to') canonicalDownResponse = response;
            continue;
        }
        if (payloadStatus === 200 || payload && typeof payload.url === 'string') {
            return result(HEALTH_STATES.AVAILABLE, 'akirabox-api-active', response);
        }
        return result(HEALTH_STATES.UNKNOWN, 'akirabox-api-status-unavailable', response);
    }
    if (canonicalDownResponse) return result(HEALTH_STATES.DOWN, 'akirabox-api-not-found', canonicalDownResponse);
    return result(HEALTH_STATES.UNKNOWN, 'akirabox-api-unavailable');
}

async function checkRootzHealth(parsed, options) {
    const headers = Object.assign({
        Accept: 'text/html,application/xhtml+xml'
    }, options.headers || {});
    let page;
    try {
        page = await options.request('GET', parsed.href, {
            headers,
            follow: false,
            timeoutMs: requestTimeout(options)
        });
    } catch (_) {
        return result(HEALTH_STATES.UNKNOWN, 'health-request-failed');
    }
    if (!validateResponseUrl(page, parsed, 'rootz')) return result(HEALTH_STATES.UNKNOWN, 'unsafe-provider-redirect', page);
    const pageStatus = Number(page && page.status) || 0;
    if (pageStatus === 404 || pageStatus === 410) return result(HEALTH_STATES.DOWN, 'rootz-page-not-found', page);
    if ([401, 403, 429].includes(pageStatus) || CHALLENGE_BODY.test(bodyText(page))) {
        return result(HEALTH_STATES.VERIFICATION_REQUIRED, 'rootz-verification-required', page);
    }
    if (pageStatus < 200 || pageStatus >= 300) return result(HEALTH_STATES.UNKNOWN, 'rootz-http-' + pageStatus, page);
    const details = rootzPageDetails(bodyText(page), parsed.href);
    if (!details || !details.pageToken) return result(HEALTH_STATES.UNKNOWN, 'rootz-status-unavailable', page);

    const apiUrl = `${parsed.origin}/api/files/download-by-short?shortId=${encodeURIComponent(details.shortId)}`;
    let metadata;
    try {
        metadata = await options.request('GET', apiUrl, {
            headers: Object.assign({}, headers, {
                Accept: 'application/json',
                Referer: parsed.href,
                'X-Page-Token': details.pageToken
            }),
            follow: false,
            timeoutMs: requestTimeout(options)
        });
    } catch (_) {
        return result(HEALTH_STATES.UNKNOWN, 'rootz-status-request-failed', page);
    }
    const metadataStatus = Number(metadata && metadata.status) || 0;
    if (metadataStatus === 404 || metadataStatus === 410) return result(HEALTH_STATES.DOWN, 'rootz-metadata-not-found', metadata);
    if ([401, 403, 429].includes(metadataStatus)) {
        return result(HEALTH_STATES.VERIFICATION_REQUIRED, 'rootz-verification-required', metadata);
    }
    if (metadataStatus < 200 || metadataStatus >= 300) {
        return result(HEALTH_STATES.UNKNOWN, 'rootz-metadata-http-' + metadataStatus, metadata);
    }
    let payload;
    try { payload = JSON.parse(bodyText(metadata)); } catch (_) {
        return result(HEALTH_STATES.UNKNOWN, 'rootz-status-invalid', metadata);
    }
    const data = payload && payload.data;
    const status = String(data && data.status || '').toLowerCase();
    if (!payload.success || ['deleted', 'removed', 'expired', 'not-found', 'not_found'].includes(status)) {
        return result(HEALTH_STATES.DOWN, 'rootz-' + (status || 'not-found'), metadata);
    }
    if (data && data.downloadAllowed === true && /^[A-Za-z0-9_-]{8,128}$/.test(String(data.fileId || ''))) {
        return result(HEALTH_STATES.AVAILABLE, 'rootz-active', metadata);
    }
    return result(HEALTH_STATES.UNKNOWN, 'rootz-status-not-downloadable', metadata);
}

async function checkVikingFileHealth(parsed, options) {
    const hashMatch = parsed.pathname.match(/^\/f\/([A-Za-z0-9_-]{4,128})\/?$/);
    if (hashMatch) {
        try {
            const apiResponse = await options.request('POST', 'https://vikingfile.com/api/check-file', {
                headers: Object.assign({
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Referer: 'https://vikingfile.com/'
                }, options.headers || {}),
                body: new URLSearchParams({ hash: hashMatch[1] }).toString(),
                follow: false,
                timeoutMs: requestTimeout(options)
            });
            if (Number(apiResponse && apiResponse.status) >= 200 && Number(apiResponse && apiResponse.status) < 300) {
                const payload = JSON.parse(bodyText(apiResponse));
                const status = Array.isArray(payload) ? payload[0]
                    : payload && payload[hashMatch[1]] || payload;
                if (status && status.exist === false) return result(HEALTH_STATES.DOWN, 'vikingfile-api-not-found', apiResponse);
                if (status && status.exist === true) return result(HEALTH_STATES.AVAILABLE, 'vikingfile-api-active', apiResponse);
            }
        } catch (_) {}
    }
    const headers = Object.assign({ Accept: 'text/html,application/xhtml+xml' }, options.headers || {});
    let target = new URL(parsed.href);
    let response;
    for (let redirect = 0; redirect < 3; redirect++) {
        try {
            response = await options.request('GET', target.href, {
                headers,
                follow: false,
                timeoutMs: requestTimeout(options)
            });
        } catch (_) {
            return result(HEALTH_STATES.UNKNOWN, 'health-request-failed');
        }
        const status = Number(response && response.status) || 0;
        if (status === 404 || status === 410) return result(HEALTH_STATES.DOWN, 'vikingfile-not-found', response);
        if ([401, 403, 429].includes(status) || CHALLENGE_BODY.test(bodyText(response))) {
            return result(HEALTH_STATES.VERIFICATION_REQUIRED, 'vikingfile-verification-required', response);
        }
        const location = header(response, 'location');
        if (!location) break;
        let redirected;
        try { redirected = new URL(location, target); } catch (_) {
            return result(HEALTH_STATES.UNKNOWN, 'unsafe-provider-redirect', response);
        }
        if (redirected.protocol !== 'https:' || !providerHostAllowed(redirected, 'vikingfile')) {
            return result(HEALTH_STATES.UNKNOWN, 'unsafe-provider-redirect', response);
        }
        target = redirected;
    }
    const status = Number(response && response.status) || 0;
    if (status < 200 || status >= 300) return result(HEALTH_STATES.UNKNOWN, 'vikingfile-http-' + status, response);
    const contentType = header(response, 'content-type');
    const body = bodyText(response);
    if (/\b(?:file\s+(?:was\s+)?(?:deleted|removed|not\s+found)|404\s+not\s+found)\b/i.test(body)) {
        return result(HEALTH_STATES.DOWN, 'vikingfile-page-reports-down', response);
    }
    if (!HTML_CONTENT_TYPE.test(contentType)) return result(HEALTH_STATES.AVAILABLE, 'vikingfile-direct-file', response);
    return result(HEALTH_STATES.UNKNOWN, 'vikingfile-page', response);
}

async function checkDownloadLinkHealth(rawUrl, options = {}) {
    const parsed = safeUrl(rawUrl);
    const provider = providerForUrl(parsed);
    if (!parsed || !provider || !sourceAllowed(options.sourceId)) {
        return result(HEALTH_STATES.UNKNOWN, 'unsupported-health-target');
    }
    if (typeof options.request !== 'function') return result(HEALTH_STATES.UNKNOWN, 'health-request-unavailable');

    if (provider === 'rootz') return checkRootzHealth(parsed, options);
    if (provider === 'vikingfile') return checkVikingFileHealth(parsed, options);
    if (provider === 'fileditch') return checkFileDitchHealth(parsed, options);
    if (provider === 'akirabox') return checkAkiraBoxHealth(parsed, options);

    const method = provider === 'filecrypt' ? 'GET' : 'HEAD';
    const headers = Object.assign({
        Accept: provider === 'filecrypt' ? 'text/html,application/xhtml+xml' : '*/*'
    }, options.headers || {});
    let response;
    try {
        response = await options.request(method, parsed.href, {
            headers,
            follow: false,
            timeoutMs: requestTimeout(options)
        });
    } catch (_) {
        return result(HEALTH_STATES.UNKNOWN, 'health-request-failed');
    }
    if (!validateResponseUrl(response, parsed, provider)) return result(HEALTH_STATES.UNKNOWN, 'unsafe-provider-redirect', response);

    let classified = classifyResponse(response, provider, { requireFile: method === 'HEAD' });
    // Some file hosts reject HEAD while allowing a one-byte GET. Keep this
    // bounded and only retry for the provider target itself.
    if (method === 'HEAD' && Number(response && response.status) === 405) {
        try {
            const retry = await options.request('GET', parsed.href, {
                headers: Object.assign({}, headers, { Range: 'bytes=0-0' }),
                follow: false,
                timeoutMs: requestTimeout(options)
            });
            if (!validateResponseUrl(retry, parsed, provider)) return result(HEALTH_STATES.UNKNOWN, 'unsafe-provider-redirect', retry);
            classified = classifyResponse(retry, provider, { requireFile: true });
        } catch (_) {
            classified = result(HEALTH_STATES.UNKNOWN, 'health-range-request-failed', response);
        }
    }
    return classified;
}

function createDownloadLinkHealthChecker(options = {}) {
    const cache = new Map();
    const ttlMs = Math.max(1000, Math.min(10 * 60 * 1000, Number(options.ttlMs) || 60 * 1000));
    const now = typeof options.now === 'function' ? options.now : Date.now;
    return async (url, requestOptions = {}) => {
        const key = String(url || '');
        const cached = cache.get(key);
        const timestamp = now();
        if (cached && timestamp - cached.checkedAt < ttlMs) return cached.value;
        const value = await checkDownloadLinkHealth(key, Object.assign({}, options, requestOptions));
        cache.set(key, { checkedAt: timestamp, value });
        return value;
    };
}

module.exports = {
    HEALTH_STATES,
    PROVIDER_HOSTS,
    classifyFileCryptResponse,
    classifyResponse,
    checkDownloadLinkHealth,
    createDownloadLinkHealthChecker,
    isHealthTargetAllowed,
    providerForUrl,
    safeUrl
};
