'use strict';

// The Linux preview permits public Steam artwork, without enabling its browser,
// account integrations, or arbitrary remote subresources. Offline stays offline.
function allowsSteamArtwork(details, support) {
    if (support.isolated || !support.features.steamMetadata?.available || details.resourceType !== 'image') return false;
    let url;
    try { url = new URL(details.url); } catch (_) { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return false;
    if (!/^(?:shared\.(?:akamai|fastly)|cdn\.(?:akamai|fastly)|community\.(?:akamai|cloudflare|fastly))\.steamstatic\.com$/.test(url.hostname)
        && url.hostname !== 'steamcdn-a.akamaihd.net') return false;
    return /^\/community_assets\/images\/apps\/[1-9]\d{0,11}\/[a-f0-9]+\.(?:jpg|jpeg|png)$/i.test(url.pathname)
        || /^\/(?:store_item_assets\/steam\/)?apps\/[1-9]\d{0,11}\/[A-Za-z0-9_.\/-]+\.(?:jpg|jpeg|png|webp)$/i.test(url.pathname)
        || /^\/steam\/apps\/[1-9]\d{0,11}\/[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/i.test(url.pathname)
        || /^\/public\/images\/apps\/[1-9]\d{0,11}\/[a-f0-9]+\.(?:jpg|jpeg|png)$/i.test(url.pathname);
}

module.exports = { allowsSteamArtwork };
