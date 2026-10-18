'use strict';
const fs = require('node:fs'), path = require('node:path'), https = require('node:https'), dns = require('node:dns'), net = require('node:net');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { isPublicAddress } = require('../security/remoteData');
// File hosts commonly refuse unusual user agents, so use an ordinary desktop browser identity.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
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
        const request = https.request(url, { signal, method: options.method || 'GET', headers: { 'User-Agent': BROWSER_UA, ...options.headers, 'Accept-Encoding': 'identity' },
            lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family) }, resolve);
        request.setTimeout(60000, () => request.destroy(Error('The download stopped responding.'))); request.once('error', reject); request.end(options.body);
    });
    if (options.follow !== false && [301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location; response.destroy();
        if (!location) throw Error('The download redirect is incomplete.');
        const target = new URL(location, url);
        const method = options.method || 'GET';
        const rewrite = response.statusCode === 303 && method !== 'HEAD' || [301, 302].includes(response.statusCode) && method === 'POST';
        // A Range request stays a range request on the file host's CDN; it carries no credential.
        const range = Object.entries(options.headers || {}).find(([key]) => /^range$/i.test(key));
        const headers = { ...(target.origin === url.origin ? options.headers : {}), ...(range ? { Range: range[1] } : {}) };
        if (rewrite) for (const key of Object.keys(headers)) if (/^content-(?:length|type|encoding)$/i.test(key)) delete headers[key];
        if (!rewrite && target.origin !== url.origin && options.body) throw Error('File-host redirect would forward form data to another host. Download separately and import the archive.');
        // Resolver-generated cookies/tokens are confined to the selected host.
        return responseFor(target.href, signal, redirects + 1, { ...options, headers,
            ...(rewrite ? { method: 'GET', body: undefined } : {}) });
    }
    if (options.requireFile !== false && response.statusCode !== 200 && !(options.allowPartial && [206, 416].includes(response.statusCode))) { response.destroy(); throw Error('Download returned HTTP ' + response.statusCode + '.'); }
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
// `partial` names a file a paused download left in `directory`; the transfer continues it when the host
// honours a byte range and starts that file over when it does not. `onTarget` learns the file name
// before any byte is written, so a pause can record it.
async function transfer({ url, fallback, headers = {}, directory, work, progress, maxSpeed = 0, partial = '', onTarget = () => {} }) {
    const controller = new AbortController();
    await work.setStop(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), 12 * 60 * 60 * 1000);
    try {
        // Pixeldrain's share URL has a fixed public file endpoint.
        const parsed = downloadUrl(url);
        if (/^(?:www\.)?pixeldrain\.com$/i.test(parsed.hostname) && /^\/u\/[A-Za-z0-9]+$/.test(parsed.pathname)) url = `https://pixeldrain.com/api/file/${parsed.pathname.split('/').at(-1)}?download`;
        let offset = 0, partialPath = '';
        if (partial) {
            if (path.basename(partial) !== partial || partial.startsWith('.')) throw Error('The paused download part is invalid.');
            partialPath = path.join(directory, partial);
            try { const stat = fs.lstatSync(partialPath); if (stat.isFile()) offset = stat.size; else throw Error('The paused download part is not a file.'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const fetched = await responseFor(url, controller.signal, 0, { headers: offset ? { ...headers, Range: `bytes=${offset}-` } : headers, allowPartial: offset > 0 }), response = fetched.response;
        if (response.statusCode === 416) {
            // The part was already whole when the download paused.
            const whole = /^bytes \*\/(\d+)$/.exec(String(response.headers['content-range'] || '')); response.destroy();
            if (!whole || Number(whole[1]) !== offset) throw Error('The file host refused to resume this part. Start the download again.');
            await onTarget(partial); await work.checkpoint(); return partialPath;
        }
        if (/text\/html|application\/xhtml|application\/json/i.test(String(response.headers['content-type'] || ''))) {
            response.destroy(); throw Error('This link requires a file-host page or browser verification. Download it in your browser, then use Import archive in Sail.');
        }
        let start = 0, total = Number(response.headers['content-length']) || 0;
        if (response.statusCode === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(response.headers['content-range'] || ''));
            if (!range || Number(range[1]) !== offset) { response.destroy(); throw Error('The file host resumed at the wrong position. Start the download again.'); }
            start = offset; total = range[3] === '*' ? 0 : Number(range[3]);
        }
        const free = fs.statfsSync(directory);
        if (total > LIMIT || total && free.bavail * free.bsize < total - start + 128 * 1024 ** 2) { response.destroy(); throw Error('Not enough free space for this download.'); }
        const target = partialPath || path.join(directory, fileName(response, fetched.url, fallback));
        if (!partialPath && fs.existsSync(target)) { response.destroy(); throw Error('Two download parts have the same filename. Existing files were kept.'); }
        await onTarget(path.basename(target));
        // New part: exclusive create. Resumed part: append. Range ignored by the host: that part starts over.
        const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | (start ? fs.constants.O_APPEND
            : partialPath ? fs.constants.O_CREAT | fs.constants.O_TRUNC : fs.constants.O_CREAT | fs.constants.O_EXCL);
        let bytes = start, last = 0; const started = Date.now();
        const meter = new Transform({ transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > LIMIT || total && bytes > total) { callback(Error('The download exceeds its declared size.')); return; }
            if (Date.now() - last > 300) { last = Date.now(); progress({ downloaded: bytes, total, speed: (bytes - start) / Math.max(1, (last - started) / 1000), percent: total ? bytes / total * 100 : 0 }); }
            const delay = maxSpeed ? Math.min(1000, Math.max(0, (bytes - start) / maxSpeed * 1000 - (Date.now() - started))) : 0;
            if (delay) setTimeout(() => callback(null, chunk), delay); else callback(null, chunk);
        } });
        await pipeline(response, meter, fs.createWriteStream(target, { flags, mode: 0o600 }), { signal: controller.signal });
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
module.exports = { transfer, downloadUrl, resolverRequest, BROWSER_UA };
