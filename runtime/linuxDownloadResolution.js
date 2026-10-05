'use strict';
const hosts = require('./downloadHostResolvers');
const { downloadUrl, resolverRequest } = require('./linuxDownloadTransfer');
function headersFor(file) {
    const output = {};
    for (const header of file.headers || []) {
        const split = String(header).indexOf(':'), name = header.slice(0, split).trim(), value = header.slice(split + 1).trim();
        if (split <= 0 || !/^(?:User-Agent|Referer|Cookie|Authorization|Accept|Origin)$/i.test(name) || value.length > 8192 || /[\r\n\u0000]/.test(value)) throw Error('Invalid resolved download header.');
        output[name] = value;
    }
    return output;
}
async function resolve(link, options, work) {
    const url = downloadUrl(link.url), controller = new AbortController();
    await work.setStop(() => controller.abort()); const timer = setTimeout(() => controller.abort(), 120000);
    const dependencies = { userAgent: 'Mozilla/5.0 Sail-Launcher/5.5.4', sourceName: link.name || options.gameName,
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
module.exports = { resolve };
