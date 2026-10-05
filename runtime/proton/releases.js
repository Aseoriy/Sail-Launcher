'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const REPOSITORIES = Object.freeze({ umu: 'Open-Wine-Components/umu-launcher', proton: 'GloriousEggroll/proton-ge-custom' });
const MAX_ARCHIVE = 2 * 1024 ** 3;
function officialUrl(value, kind, api = false) {
    const url = new URL(value), repo = REPOSITORIES[kind];
    if (!repo || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw Error('Invalid compatibility download source.');
    const allowed = api ? url.hostname === 'api.github.com' && url.pathname === `/repos/${repo}/releases`
        : url.hostname === 'github.com' && url.pathname.startsWith(`/${repo}/releases/download/`)
            || url.hostname === 'release-assets.githubusercontent.com';
    if (!allowed) throw Error('Compatibility downloads must come from their official GitHub release.');
    return url;
}
async function response(value, { kind, api = false, signal, redirects = 0 }) {
    const url = officialUrl(value, kind, api);
    if (redirects > 5) throw Error('Too many compatibility download redirects.');
    const stream = await new Promise((resolve, reject) => {
        const request = https.get(url, { signal, headers: { 'User-Agent': 'Sail-Launcher-Linux',
            Accept: api ? 'application/vnd.github+json' : 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' } }, resolve);
        request.setTimeout(30000, () => request.destroy(Error('Compatibility download timed out. Try again.')));
        request.on('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(stream.statusCode)) {
        stream.resume();
        if (api || !stream.headers.location) throw Error('Unexpected compatibility release redirect.');
        return response(new URL(stream.headers.location, url).href, { kind, signal, redirects: redirects + 1 });
    }
    if (stream.statusCode !== 200) {
        stream.resume();
        throw Error(stream.statusCode === 403 || stream.statusCode === 429
            ? 'GitHub temporarily limited release requests. Try again later.' : `Compatibility download failed (HTTP ${stream.statusCode}).`);
    }
    return stream;
}
async function listOfficialReleases(kind, signal) {
    const repo = REPOSITORIES[kind]; if (!repo) throw Error('Unknown compatibility tool.');
    const stream = await response(`https://api.github.com/repos/${repo}/releases?per_page=12`, { kind, api: true, signal });
    let size = 0; const chunks = [];
    for await (const chunk of stream) {
        size += chunk.length;
        if (size > 3 * 1024 ** 2) { stream.destroy(); throw Error('Compatibility release metadata is too large.'); }
        chunks.push(chunk);
    }
    return parseReleases(JSON.parse(Buffer.concat(chunks).toString('utf8')), kind);
}
function parseReleases(input, kind) {
    if (!Array.isArray(input) || input.length > 100 || !REPOSITORIES[kind]) throw Error('Invalid compatibility release metadata.');
    const releases = [];
    for (const release of input) {
        if (release.draft || release.prerelease || typeof release.tag_name !== 'string'
            || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(release.tag_name) || !Array.isArray(release.assets)) continue;
        const assets = release.assets.filter(asset => kind === 'umu'
            ? /^umu-launcher-[A-Za-z0-9._-]+-zipapp\.tar$/.test(asset.name)
            : /^GE-Proton[A-Za-z0-9._-]+\.tar\.gz$/.test(asset.name) && !/aarch64|arm64/.test(asset.name));
        // Prefer explicitly named x86_64 builds; older releases used no suffix.
        assets.sort((a, b) => Number(/x86_64/.test(b.name)) - Number(/x86_64/.test(a.name)));
        const asset = assets[0];
        if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size)
            || asset.size < 1 || asset.size > MAX_ARCHIVE || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) continue;
        try { officialUrl(asset.browser_download_url, kind); } catch (_) { continue; }
        if (new URL(asset.browser_download_url).pathname !== `/${REPOSITORIES[kind]}/releases/download/${release.tag_name}/${asset.name}`) continue;
        releases.push({ id: `${kind}:${asset.id}`, kind, tag: release.tag_name, name: asset.name, size: asset.size,
            sha256: asset.digest.slice(7), url: asset.browser_download_url,
            publishedAt: typeof release.published_at === 'string' ? release.published_at.slice(0, 40) : '' });
    }
    return releases.slice(0, 12);
}
async function downloadOfficial(release, destination, { signal, onProgress = () => {} } = {}) {
    const stream = await response(release.url, { kind: release.kind, signal });
    if (stream.headers['content-length'] && Number(stream.headers['content-length']) !== release.size) {
        stream.destroy(); throw Error('The release size changed. Refresh available versions.');
    }
    const hash = crypto.createHash('sha256'); let size = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > release.size || size > MAX_ARCHIVE) { callback(Error('The runtime download exceeded its expected size.')); return; }
        try { hash.update(chunk); onProgress(size, release.size); callback(null, chunk); }
        catch (error) { callback(error); }
    } });
    const target = fs.createWriteStream(destination, { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode: 0o600 });
    await pipeline(stream, meter, target, { signal });
    if (size !== release.size || hash.digest('hex') !== release.sha256) throw Error('The runtime checksum did not match. No version was installed.');
    const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
module.exports = { REPOSITORIES, officialUrl, parseReleases, listOfficialReleases, downloadOfficial };
