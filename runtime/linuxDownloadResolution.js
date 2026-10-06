'use strict';
const hosts = require('./downloadHostResolvers');
const { downloadUrl, resolverRequest, BROWSER_UA } = require('./linuxDownloadTransfer');
function headersFor(file) {
    const output = {};
    for (const header of file.headers || []) {
        const split = String(header).indexOf(':'), name = header.slice(0, split).trim(), value = header.slice(split + 1).trim();
        if (split <= 0 || !/^(?:User-Agent|Referer|Cookie|Authorization|Accept|Origin)$/i.test(name) || value.length > 8192 || /[\r\n\u0000]/.test(value)) throw Error('Invalid resolved download header.');
        output[name] = value;
    }
    return output;
}
// services.browserResolve lets BuzzHeavier-style hosts fall back to the user's installed Chromium browser.
async function resolve(link, options, work, services = {}) {
    const url = downloadUrl(link.url), controller = new AbortController();
    await work.setStop(() => controller.abort()); const timer = setTimeout(() => controller.abort(), 120000);
    const dependencies = { userAgent: BROWSER_UA, sourceName: link.name || options.gameName,
        ...(typeof services.browserResolve === 'function' ? { browserResolve: services.browserResolve } : {}),
        referer: options.referer || url.href, signal: controller.signal,
        request: (method, target, settings = {}) => resolverRequest(method, target, settings, controller.signal) };
    const handlers = [
        [hosts.PIXELDRAIN_HOST_RE, hosts.resolvePixeldrainUrl], [hosts.BUZZHEAVIER_HOST_RE, hosts.resolveBuzzHeavierUrl],
        [hosts.AKIRABOX_HOST_RE, hosts.resolveAkiraBoxUrl], [hosts.ROOTZ_HOST_RE, hosts.resolveRootzUrl],
        [hosts.VIKINGFILE_HOST_RE, hosts.resolveVikingFileUrl], [hosts.FILEDITCH_HOST_RE, hosts.resolveFileDitchUrl],
        [hosts.FILEKEEPER_HOST_RE, hosts.resolveFileKeeperUrl], [hosts.DATANODES_HOST_RE, hosts.resolveDataNodesUrl],
        [/^(?:www\.)?gofile\.io$/i, hosts.resolveGofileUrl], [/^(?:www\.)?megadb\.net$/i, hosts.resolveMegaDbUrl]
    ];
    try {
        const handler = handlers.find(([match]) => match.test(url.hostname))?.[1];
        const files = handler ? await handler(url.href, dependencies) : [{ url: url.href, name: link.name || '' }];
        controller.signal.throwIfAborted(); await work.checkpoint();
        if (!files?.length) throw Error('This host needs browser verification or an unsupported transfer. Download it separately, then use Import archive in Sail.');
        if (files.length > 32) throw Error('This host returned more than 32 files. Download the archive parts separately and import them.');
        return files.map(file => ({ url: downloadUrl(file.url).href, name: file.name || link.name, headers: headersFor(file) }));
    } finally { clearTimeout(timer); await work.setStop(null); }
}
// Files from Sail's full link resolver (FileCrypt containers, Cloudflare-protected hosts through a browser) become plain HTTPS transfers.
function normalizeManagedFiles(files) {
    if (!Array.isArray(files) || !files.length) throw Error('This host did not return a download. Try another mirror, or download it in your browser and use "Choose archive".');
    if (files.length > 32) throw Error('This host returned more than 32 files. Download the archive parts separately and import them.');
    return files.map(file => {
        if (!file || file.kind === 'magnet' || /^magnet:/i.test(String(file.url || '')) || /\.torrent(?:[?#]|$)/i.test(String(file.url || ''))) {
            throw Error('Torrent downloads are not supported on Linux yet. Download the game with a torrent app, then use "Choose archive".');
        }
        // The page is opened in the installed browser, which saves the file itself (see runtime/systemBrowserDownload.js).
        if (file.assisted) {
            const referer = file.assisted.referer ? downloadUrl(file.assisted.referer).href : '';
            return { assisted: { url: downloadUrl(file.assisted.url).href, referer, provider: /^[a-z0-9]{2,24}$/.test(String(file.assisted.provider || '')) ? file.assisted.provider : '' }, name: file.name || '' };
        }
        return { url: downloadUrl(file.url).href, name: file.name || '', headers: headersFor({ headers: Array.isArray(file.headers) ? file.headers : [] }) };
    });
}
module.exports = { resolve, normalizeManagedFiles };
