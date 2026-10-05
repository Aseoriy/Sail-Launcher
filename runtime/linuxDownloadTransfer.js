'use strict';
const fs = require('node:fs'), path = require('node:path'), https = require('node:https'), dns = require('node:dns'), net = require('node:net');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { isPublicAddress } = require('../security/remoteData');
const LIMIT = 512 * 1024 ** 3;
function downloadUrl(value) {
    const raw = String(value), url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
        || /[\\\u0000-\u0020\u007f]/.test(raw) || net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw Error('Downloads require a credential-free public HTTPS URL.');
    return url;
}
async function responseFor(value, signal, redirects = 0, options = {}) {
    if (redirects > 6) throw Error('Too many download redirects.');
    signal.throwIfAborted(); const url = downloadUrl(value);
    let timer, abort;
    const addresses = await Promise.race([dns.promises.lookup(url.hostname, { all: true, verbatim: true }), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('Download DNS lookup timed out.')), 15000);
        abort = () => reject(Error('Cancelled')); signal.addEventListener('abort', abort, { once: true });
    })]).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw Error('The download host must resolve to public internet addresses.');
    const address = addresses[0];
    const response = await new Promise((resolve, reject) => {
        const request = https.request(url, { signal, method: options.method || 'GET', headers: { 'User-Agent': 'Sail-Launcher/5.5.4', ...options.headers, 'Accept-Encoding': 'identity' },
            lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family) }, resolve);
        request.setTimeout(60000, () => request.destroy(Error('The download stopped responding.'))); request.once('error', reject); request.end(options.body);
    });
    if (options.follow !== false && [301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location; response.destroy();
        if (!location) throw Error('The download redirect is incomplete.');
        const target = new URL(location, url);
        const method = options.method || 'GET';
        const rewrite = response.statusCode === 303 && method !== 'HEAD' || [301, 302].includes(response.statusCode) && method === 'POST';
        const headers = { ...(target.origin === url.origin ? options.headers : {}) };
        if (rewrite) for (const key of Object.keys(headers)) if (/^content-(?:length|type|encoding)$/i.test(key)) delete headers[key];
        if (!rewrite && target.origin !== url.origin && options.body) throw Error('File-host redirect would forward form data to another host. Download separately and import the archive.');
        // Resolver-generated cookies/tokens are confined to the selected host.
        return responseFor(target.href, signal, redirects + 1, { ...options, headers,
            ...(rewrite ? { method: 'GET', body: undefined } : {}) });
    }
    if (options.requireFile !== false && response.statusCode !== 200) { response.destroy(); throw Error('Download returned HTTP ' + response.statusCode + '.'); }
    return { response, url };
}
function fileName(response, url, fallback) {
    const disposition = String(response.headers['content-disposition'] || '');
    let value = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] || /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition)?.slice(1).find(Boolean) || path.posix.basename(url.pathname) || fallback;
    try { value = decodeURIComponent(value); } catch (_) {}
    value = value.trim().replace(/[\\/:<>|?*\u0000-\u001f\u007f]/g, '_').slice(0, 180);
    if (!value || /^\.+$/.test(value) || value.startsWith('.')) value = 'download.bin';
    return value;
}
async function transfer({ url, fallback, headers = {}, directory, work, progress, maxSpeed = 0 }) {
    const controller = new AbortController();
    await work.setStop(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), 12 * 60 * 60 * 1000);
    try {
        // Pixeldrain's share URL has a fixed public file endpoint.
        const parsed = downloadUrl(url);
        if (/^(?:www\.)?pixeldrain\.com$/i.test(parsed.hostname) && /^\/u\/[A-Za-z0-9]+$/.test(parsed.pathname)) url = `https://pixeldrain.com/api/file/${parsed.pathname.split('/').at(-1)}?download`;
        const fetched = await responseFor(url, controller.signal, 0, { headers }), response = fetched.response;
        if (/text\/html|application\/xhtml|application\/json/i.test(String(response.headers['content-type'] || ''))) {
            response.destroy(); throw Error('This link requires a file-host page or browser verification. Download it in your browser, then use Import archive in Sail.');
        }
        const total = Number(response.headers['content-length']) || 0;
        const free = fs.statfsSync(directory);
        if (total > LIMIT || total && free.bavail * free.bsize < total + 128 * 1024 ** 2) { response.destroy(); throw Error('Not enough free space for this download.'); }
        const target = path.join(directory, fileName(response, fetched.url, fallback));
        if (fs.existsSync(target)) { response.destroy(); throw Error('Two download parts have the same filename. Existing files were kept.'); }
        let bytes = 0, last = 0; const started = Date.now();
        const meter = new Transform({ transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > LIMIT || total && bytes > total) { callback(Error('The download exceeds its declared size.')); return; }
            if (Date.now() - last > 300) { last = Date.now(); progress({ downloaded: bytes, total, speed: bytes / Math.max(1, (last - started) / 1000), percent: total ? bytes / total * 100 : 0 }); }
            const delay = maxSpeed ? Math.min(1000, Math.max(0, bytes / maxSpeed * 1000 - (Date.now() - started))) : 0;
            if (delay) setTimeout(() => callback(null, chunk), delay); else callback(null, chunk);
        } });
        await pipeline(response, meter, fs.createWriteStream(target, { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode: 0o600 }), { signal: controller.signal });
        if (!bytes || total && bytes !== total) throw Error('The downloaded file is incomplete.');
        await work.checkpoint();
        return target;
    } finally { clearTimeout(timer); await work.setStop(null); }
}
async function resolverRequest(method, url, options, signal) {
    if (!['GET', 'POST', 'HEAD'].includes(method) || Buffer.byteLength(options.body || '') > 64 * 1024) throw Error('Invalid file-host request.');
    const fetched = await responseFor(url, signal, 0, { ...options, method, requireFile: false }), response = fetched.response;
    const chunks = []; let bytes = 0;
    try {
        for await (const chunk of response) {
            bytes += chunk.length; if (bytes > 4 * 1024 ** 2) throw Error('File-host response exceeds its limit.'); chunks.push(chunk);
        }
        return { url: fetched.url.href, status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') };
    } finally { response.destroy(); }
}
module.exports = { transfer, downloadUrl, resolverRequest };
