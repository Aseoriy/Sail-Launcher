'use strict';

const { createHash, randomBytes } = require('node:crypto');

const SERVICES = { torbox: 'TorBox', realdebrid: 'Real-Debrid', alldebrid: 'AllDebrid', premiumize: 'Premiumize', debridlink: 'Debrid-Link' };
const MAX_TORRENT_BYTES = 16 * 1024 * 1024;

function isTorrentDownload(link, name = '') {
    if (/^magnet:\?/i.test(String(link || '').trim())) return true;
    try {
        const url = new URL(link);
        if (!/^https?:$/.test(url.protocol)) return false;
        return /\.torrent$/i.test(decodeURIComponent(url.pathname)) || /\.torrent$/i.test(String(name).trim())
            || /(?:^|\.)rutor\.(?:info|is|org)$/i.test(url.hostname) && /^\/download\/\d+\/?$/i.test(url.pathname);
    } catch (_) { return false; }
}

function fatal(message) {
    return Object.assign(new Error(message), { debridResolutionFatal: true });
}

function aborted(signal) {
    if (signal && signal.aborted) throw Object.assign(fatal('Torrent resolution cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function pause(ms, signal) {
    aborted(signal);
    return new Promise((resolve, reject) => {
        const finish = () => { if (signal) signal.removeEventListener('abort', cancel); resolve(); };
        const timer = setTimeout(finish, ms);
        const cancel = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            try { aborted(signal); } catch (error) { reject(error); }
        };
        if (signal) signal.addEventListener('abort', cancel, { once: true });
    });
}

function relativePath(value) {
    const result = String(value || '').replace(/\\/g, '/');
    if (!result || result.length > 3000 || /^[\/]/.test(result)
        || result.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f<>:"|?*]/.test(part)
            || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw fatal('The debrid service returned an unsafe torrent file path.');
    }
    return result;
}

function fileResult(url, path, size) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw fatal('The debrid service did not return a download link.'); }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw fatal('The debrid service returned an invalid download link.');
    const safePath = relativePath(path);
    const result = { url: parsed.href, kind: 'http', name: safePath.split('/').pop(), relativePath: safePath };
    if (Number.isSafeInteger(Number(size)) && Number(size) >= 0 && size != null) result.sizeBytes = Number(size);
    return result;
}

function multipart(fields, fileField, buffer) {
    const boundary = 'SailTorrent' + randomBytes(18).toString('hex');
    const chunks = [];
    for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    if (buffer) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="download.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`), buffer, Buffer.from('\r\n'));
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary } };
}

// API contracts: api.real-debrid.com, docs.alldebrid.com, premiumize.me/api,
// TorBox-App/torbox-sdk-js, debrid-link.com/api/v2/api_doc/infos.
function createDebridTorrentResolver({ request, pollIntervalMs = 5000, retryDelayMs = 1500, maxWaitMs = 24 * 60 * 60 * 1000 } = {}) {
    if (typeof request !== 'function') throw new TypeError('request is required');
    const jobs = new Map();

    return async function resolve(serviceId, key, source, options = {}) {
        const label = SERVICES[serviceId];
        if (!label || !key) throw fatal('Connect a supported debrid service before downloading this torrent.');
        const { signal, onProgress } = options;
        aborted(signal);
        source = String(source || '').trim();
        const magnet = /^magnet:\?/i.test(source);
        if (!magnet) {
            try { if (!/^https?:$/.test(new URL(source).protocol)) throw new Error(); }
            catch (_) { throw fatal('A magnet link or HTTP torrent file is required.'); }
        }
        const jobKey = createHash('sha256').update(JSON.stringify([serviceId, key, source])).digest('hex');
        let job = jobs.get(jobKey);
        if (!job) {
            // Bound retained resume records. Only IDs are retained, never keys or CDN links.
            if (jobs.size >= 256) jobs.delete(jobs.keys().next().value);
            job = {};
            jobs.set(jobKey, job);
        }
        const auth = { Authorization: 'Bearer ' + key };
        const report = progress => {
            if (typeof onProgress === 'function') onProgress(`${label} is preparing the torrent… ${Math.round(Math.max(0, Math.min(100, Number(progress) || 0)))}%`);
        };
        const api = async (method, url, extra = {}, retry = method === 'GET') => {
            for (let attempt = 0; ; attempt++) {
                aborted(signal);
                let response;
                try {
                    response = await request(method, url, { timeoutMs: 120000, maxBodyBytes: 16 * 1024 * 1024, ...extra, headers: { ...auth, ...extra.headers }, signal, follow: false });
                } catch (_) {
                    aborted(signal);
                    if (retry && attempt < 2) { await pause(retryDelayMs * (attempt + 1), signal); continue; }
                    throw fatal(`${label} could not be reached. Retry the download to resume preparation.`);
                }
                if (retry && attempt < 2 && (response.status === 429 || response.status >= 500)) {
                    await pause(retryDelayMs * (attempt + 1), signal); continue;
                }
                if (response.status === 401 || response.status === 403) throw fatal(`${label} rejected access. Check your connection and account subscription.`);
                if (response.status < 200 || response.status >= 300) throw fatal(`${label} could not prepare this torrent (HTTP ${Number(response.status) || 0}).`);
                if ((response.status === 204 || response.status === 202) && !response.body) return {};
                let json;
                try { json = JSON.parse(response.body); } catch (_) { throw fatal(`${label} returned an invalid response.`); }
                if (!json || json.error || json.success === false || json.status === 'error') throw fatal(`${label} could not prepare this torrent. Check its dashboard for account limits or torrent errors.`);
                return json;
            }
        };
        const post = (url, fields, retry = false) => api('POST', url, { body: new URLSearchParams(fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, retry);
        const getTorrent = async () => {
            let response;
            let headers = options.torrentHeaders;
            if (Array.isArray(headers)) {
                headers = Object.fromEntries(headers.map(value => {
                    const text = String(value || '');
                    const split = text.indexOf(':');
                    return split > 0 && !/[\r\n]/.test(text) ? [text.slice(0, split).trim(), text.slice(split + 1).trim()] : null;
                }).filter(Boolean));
            }
            try { response = await request('GET', source, { headers, responseType: 'buffer', maxBodyBytes: MAX_TORRENT_BYTES, timeoutMs: 60000, signal }); }
            catch (_) { aborted(signal); throw fatal('The torrent file could not be fetched.'); }
            const buffer = response.body;
            if (response.status !== 200 || !Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > MAX_TORRENT_BYTES || buffer[0] !== 100 || buffer[buffer.length - 1] !== 101) {
                throw fatal('The torrent link did not return a valid torrent file.');
            }
            return buffer;
        };
        const remember = id => {
            if (id == null || !/^[a-zA-Z0-9_-]+$/.test(String(id))) throw fatal(`${label} did not return a torrent job ID.`);
            job.id = String(id);
        };
        const poll = async check => {
            const deadline = Date.now() + maxWaitMs;
            while (true) {
                aborted(signal);
                const value = await check();
                if (value) return value;
                if (Date.now() >= deadline) throw fatal(`${label} is still preparing this torrent. Retry the download to continue waiting.`);
                await pause(pollIntervalMs, signal);
            }
        };
        const selectJob = rows => Array.isArray(rows) ? rows.find(row => String(row.id) === job.id) : rows && String(rows.id) === job.id ? rows : null;
        const failedJob = () => { jobs.delete(jobKey); throw fatal(`${label} could not finish the torrent. Check its dashboard for details.`); };

        try {
            report(0);
            let files;
            if (serviceId === 'torbox') {
                const base = 'https://api.torbox.app/v1/api/torrents/';
                if (!job.id) {
                    const body = multipart(magnet ? { magnet: source, allow_zip: 'true' } : { allow_zip: 'true' }, 'file', magnet ? null : await getTorrent());
                    const created = await api('POST', base + 'createtorrent', body);
                    remember(created.data && (created.data.torrent_id ?? created.data.id));
                }
                const torrent = await poll(async () => {
                    const response = await api('GET', base + 'mylist?id=' + job.id + '&bypass_cache=true');
                    const row = selectJob(response.data);
                    if (!row) { report(0); return null; }
                    if (/^(?:error|failed|missingFiles)$/i.test(String(row.download_state))) failedJob();
                    report(Number(row.progress) * 100);
                    return row.download_finished === true && row.download_present === true && Array.isArray(row.files) && row.files.length ? row : null;
                });
                const rows = Array.isArray(torrent.files) ? torrent.files : [];
                if (!rows.length) throw fatal('TorBox returned no torrent files.');
                const zip = rows.length > 1;
                const query = new URLSearchParams({ token: key, torrent_id: job.id, redirect: 'false', ...(zip ? { zip_link: 'true' } : { file_id: String(rows[0].id) }) });
                const dl = await api('GET', base + 'requestdl?' + query);
                const name = zip ? String(torrent.name || 'torrent').replace(/[\\/]/g, '_') + '.zip' : rows[0].name || rows[0].short_name;
                files = [fileResult(dl.data, name, zip ? undefined : rows[0].size)];
            } else if (serviceId === 'realdebrid') {
                const base = 'https://api.real-debrid.com/rest/1.0/';
                if (!job.id) {
                    const created = magnet ? await post(base + 'torrents/addMagnet', { magnet: source })
                        : await api('PUT', base + 'torrents/addTorrent', { body: await getTorrent(), headers: { 'Content-Type': 'application/x-bittorrent' } });
                    remember(created.id);
                }
                const torrent = await poll(async () => {
                    const row = await api('GET', base + 'torrents/info/' + job.id);
                    if (['error', 'magnet_error', 'virus', 'dead'].includes(row.status)) failedJob();
                    report(row.progress);
                    if (row.status === 'waiting_files_selection') { await post(base + 'torrents/selectFiles/' + job.id, { files: 'all' }, true); return null; }
                    return row.status === 'downloaded' ? row : null;
                });
                const rows = Array.isArray(torrent.files) ? torrent.files : [];
                const links = Array.isArray(torrent.links) ? torrent.links : [];
                if (!rows.length || rows.some(file => Number(file.selected) !== 1) || !links.length) throw fatal('Real-Debrid did not make every torrent file available. Select all files in its dashboard and retry.');
                files = [];
                for (let index = 0; index < links.length; index++) {
                    const dl = await post(base + 'unrestrict/link', { link: links[index] }, true);
                    // RD can package selected files into one or several archives.
                    const packaged = links.length !== rows.length;
                    if (packaged && !/\.(?:zip|rar|7z|r\d\d|\d{3})$/i.test(String(dl.filename || ''))) throw fatal('Real-Debrid returned an incomplete torrent file list.');
                    const path = packaged ? dl.filename : String(rows[index].path || '').replace(/^\//, '');
                    files.push(fileResult(dl.download, path, dl.filesize));
                }
            } else if (serviceId === 'alldebrid') {
                const base = 'https://api.alldebrid.com/';
                if (!job.id) {
                    const created = magnet ? await post(base + 'v4/magnet/upload', { 'magnets[]': source })
                        : await api('POST', base + 'v4/magnet/upload/file', multipart({}, 'files[]', await getTorrent()));
                    const rows = created.data && (created.data.magnets || created.data.files);
                    if (!rows || !rows[0] || rows[0].error) throw fatal('AllDebrid could not add this torrent.');
                    remember(rows[0].id);
                }
                let torrent = await poll(async () => {
                    const response = await post(base + 'v4.1/magnet/status', { id: job.id }, true);
                    const row = selectJob(response.data && response.data.magnets);
                    if (!row) return null;
                    if (Number(row.statusCode) > 4) failedJob();
                    report(row.size ? Number(row.downloaded) / Number(row.size) * 100 : 0);
                    return Number(row.statusCode) === 4 ? row : null;
                });
                if (!Array.isArray(torrent.files)) {
                    const response = await post(base + 'v4/magnet/files', { 'id[]': job.id }, true);
                    torrent = selectJob(response.data && response.data.magnets);
                }
                const rows = [];
                const walk = (nodes, prefix = '', depth = 0) => {
                    if (!Array.isArray(nodes) || depth > 64) throw fatal('AllDebrid returned an invalid torrent file tree.');
                    for (const node of nodes) {
                        const path = relativePath(prefix + node.n);
                        if (Array.isArray(node.e)) walk(node.e, path + '/', depth + 1);
                        else rows.push({ path, link: node.l, size: node.s });
                    }
                };
                walk(torrent && torrent.files);
                files = [];
                for (const row of rows) {
                    if (!row.link) throw fatal('AllDebrid did not make every torrent file available.');
                    const dl = await post(base + 'v4/link/unlock', { link: row.link }, true);
                    files.push(fileResult(dl.data && dl.data.link, row.path, row.size));
                }
            } else if (serviceId === 'premiumize') {
                const base = 'https://www.premiumize.me/api/';
                if (!job.id) {
                    const created = magnet ? await post(base + 'transfer/create', { src: source })
                        : await api('POST', base + 'transfer/create', multipart({}, 'src', await getTorrent()));
                    remember(created.id);
                }
                const torrent = await poll(async () => {
                    const response = await api('GET', base + 'transfer/list');
                    const row = selectJob(response.transfers);
                    if (!row) return null;
                    if (row.status === 'error') failedJob();
                    report(Number(row.progress) * 100);
                    return ['finished', 'seeding'].includes(row.status) ? row : null;
                });
                if (!torrent.file_id && !torrent.folder_id) throw fatal('Premiumize did not return the completed torrent location.');
                const dl = await post(base + 'zip/generate', torrent.file_id ? { 'files[]': torrent.file_id } : { 'folders[]': torrent.folder_id }, true);
                files = [{ ...fileResult(dl.location, String(torrent.name || 'torrent').replace(/[\\/]/g, '_') + '.zip'), maxConn: 1 }];
            } else {
                const base = 'https://debrid-link.com/api/v2/';
                if (!job.id) {
                    const created = magnet ? await post(base + 'seedbox/add', { url: source, wait: 'false' })
                        : await api('POST', base + 'seedbox/add', multipart({ wait: 'false' }, 'file', await getTorrent()));
                    remember(created.value && created.value.id);
                }
                const torrent = await poll(async () => {
                    const response = await api('GET', base + 'seedbox/list?ids=' + job.id + '&structureType=list');
                    const row = selectJob(response.value);
                    if (!row) return null;
                    if (row.error) failedJob();
                    report(row.downloadPercent);
                    return Number(row.downloadPercent) === 100 && Array.isArray(row.files) && row.files.length && row.files.every(file => Number(file.downloadPercent) === 100) ? row : null;
                });
                files = torrent.files.map(file => fileResult(file.downloadUrl, file.name, file.size));
            }
            if (!files.length) throw fatal(`${label} returned no torrent files.`);
            const paths = new Set();
            for (const file of files) {
                const path = file.relativePath.toLowerCase();
                if (paths.has(path)) throw fatal(`${label} returned conflicting torrent file names.`);
                paths.add(path);
            }
            aborted(signal);
            return files;
        } catch (error) {
            aborted(signal);
            if (error && error.debridResolutionFatal) throw error;
            throw fatal(`${label} could not resolve this torrent. Retry the download or check its dashboard.`);
        }
    };
}

module.exports = { createDebridTorrentResolver, isTorrentDownload };
