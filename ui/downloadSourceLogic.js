'use strict';

const FITGIRL_GAME_CATEGORY_ID = 5;
const STEAMRIP_DOWNLOAD_HOST_RE = /(^|\.)(?:megadb\.net|gofile\.io|datanodes\.(?:to|net)|1fichier\.com|pixeldrain\.(?:com|net|in|nl|biz|tech|dev)|mediafire\.com|rapidgator\.net|nitroflare\.com|turbobit\.net|katfile\.com|hexload\.com|filekeeper\.(?:net|me|org|io)|vikingfile\.com|vik1ngfile\.site|rootz\.so|akirabox\.(?:com|to)|buzzheavier\.com|bzzhr\.(?:to|co)|fileditch(?:files)?\.(?:com|net|me)|fuckingfast\.(?:co|com|net)|multiup\.(?:io|org|eu|to)|mega\.nz|qiwi\.gg|bowfile\.com|1337x\.(?:to|st|gd|is|tw|ws)|(?:d\.)?rutor\.info)$/i;
const DOWNLOAD_SKIP_FILE_RE = /fix[_\s.-]*repair[_\s.-]*steam[_\s.-]*(v\d+[_\s.-]*)?generic|repair[_\s.-]*steam[_\s.-]*generic/i;

function decodeUrlEntities(value) {
    return String(value || '')
        .replace(/&amp;|&#0*38;|&#x0*26;/gi, '&')
        .replace(/&#0*47;|&#x0*2f;/gi, '/');
}

function normalizeRemoteImageUrl(value, baseUrl) {
    const source = decodeUrlEntities(value).trim();
    if (!source || source.includes('\\')) return '';
    let parsed;
    try { parsed = new URL(source, baseUrl); } catch (_) { return ''; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    if (parsed.port && !['80', '443'].includes(parsed.port)) return '';
    if (parsed.protocol === 'http:') {
        parsed.protocol = 'https:';
        if (parsed.port === '80') parsed.port = '';
    }
    return parsed.href;
}

function attributeValue(tag, name) {
    const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag);
    return match ? match[2] : '';
}

function firstImageFromHtml(html, baseUrl) {
    const tag = /<img\b[^>]*>/i.exec(String(html || ''));
    if (!tag) return '';
    for (const name of ['data-src', 'data-lazy-src', 'data-orig-file', 'src']) {
        const image = normalizeRemoteImageUrl(attributeValue(tag[0], name), baseUrl);
        if (image) return image;
    }
    return '';
}

function normalizeFitGirlPosts(posts) {
    if (!Array.isArray(posts)) return [];
    const results = [];
    for (const post of posts) {
        if (!post || typeof post !== 'object' || post.type && post.type !== 'post') continue;
        const categories = Array.isArray(post.categories) ? post.categories.map(Number) : [];
        if (!categories.includes(FITGIRL_GAME_CATEGORY_ID)) continue;
        let link;
        try { link = new URL(String(post.link || '')); } catch (_) { continue; }
        if (link.protocol !== 'https:' || link.hostname !== 'fitgirl-repacks.site' || link.pathname === '/') continue;
        const title = post.title && typeof post.title.rendered === 'string' ? post.title.rendered : '';
        if (!title.trim()) continue;
        results.push({
            name: title,
            url: link.href,
            image: firstImageFromHtml(post.content && post.content.rendered, link.href),
            reference: typeof post.sailReference === 'string' ? post.sailReference : ''
        });
    }
    return results;
}

function normalizeFitGirlPostCovers(posts) {
    if (!Array.isArray(posts)) return [];
    const results = [];
    const seen = new Set();
    for (const post of posts) {
        if (!post || typeof post !== 'object') continue;
        let link;
        try { link = new URL(String(post.link || '')); } catch (_) { continue; }
        if (link.protocol !== 'https:' || link.hostname !== 'fitgirl-repacks.site'
            || link.pathname === '/' || seen.has(link.href)) continue;
        const image = firstImageFromHtml(post.content && post.content.rendered, link.href);
        if (!image) continue;
        seen.add(link.href);
        results.push({ url: link.href, image });
    }
    return results;
}

function normalizeSteamRipResultUrl(value, baseUrl = 'https://steamrip.com/') {
    const source = decodeUrlEntities(value).trim();
    if (!source || source.includes('\\')) return '';
    let parsed;
    try { parsed = new URL(source, baseUrl); } catch (_) { return ''; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'steamrip.com'
        || parsed.username || parsed.password || parsed.port || parsed.hash || parsed.pathname === '/') return '';
    return parsed.href;
}

function parseSteamRipResults(doc, options = {}) {
    const grid = doc && typeof doc.querySelector === 'function'
        ? doc.querySelector('.main-content #masonry-grid')
        : null;
    if (!grid) return [];
    const baseUrl = options.baseUrl || 'https://steamrip.com/';
    const cleanText = typeof options.cleanText === 'function'
        ? options.cleanText
        : value => String(value || '').replace(/\s+/g, ' ').trim();
    const imageForCard = typeof options.imageForCard === 'function' ? options.imageForCard : () => '';
    const results = [];
    const seen = new Set();
    Array.from(grid.children || []).filter(card => card.classList && card.classList.contains('post-element')).forEach(card => {
        const link = card.querySelector('h2.thumb-title a[href], a.all-over-thumb-link[href]');
        if (!link) return;
        const href = normalizeSteamRipResultUrl(link.getAttribute('href') || '', baseUrl);
        if (!href || seen.has(href)) return;
        const title = card.querySelector('h2.thumb-title a[href], h2.the-post-title, .screen-reader-text');
        let name = title ? cleanText(title.textContent) : '';
        if (!name || name.length < 2) return;
        seen.add(href);
        name = name.replace(/\s*free\s*download.*/i, '').trim() || name;
        results.push({ name, url: href, image: imageForCard(card, baseUrl) });
    });
    return results;
}

function normalizeSteamRipDownloadUrl(value, baseUrl = 'https://steamrip.com/') {
    const source = decodeUrlEntities(value).trim();
    if (!source || source.includes('\\')) return '';
    let parsed;
    try { parsed = new URL(source, baseUrl); } catch (_) { return ''; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    if (parsed.port && !['80', '443'].includes(parsed.port)) return '';
    if (!STEAMRIP_DOWNLOAD_HOST_RE.test(parsed.hostname)) return '';
    if (parsed.protocol === 'http:') {
        parsed.protocol = 'https:';
        if (parsed.port === '80') parsed.port = '';
    }
    return parsed.href;
}

function normalizeSteamRipGofileContainerUrl(value, baseUrl = 'https://steamrip.com/') {
    const source = decodeUrlEntities(value).trim();
    if (!source || source.includes('\\')) return '';
    let parsed;
    try { parsed = new URL(source, baseUrl); } catch (_) { return ''; }
    if (parsed.protocol !== 'https:' || !/^(?:www\.)?filecrypt\.cc$/i.test(parsed.hostname)
        || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
        || !/^\/Container\/[A-Fa-f0-9]{10,64}\.html$/.test(parsed.pathname)) return '';
    return parsed.href;
}

function steamRipDownloadHostLabel(value) {
    let hostname = '';
    try { hostname = new URL(String(value || '')).hostname.replace(/^www\./, ''); } catch (_) { return 'Download link'; }
    if (/(^|\.)bzzhr\.to$|(^|\.)buzzheavier\./i.test(hostname)) return 'BuzzHeavier';
    if (/(^|\.)fileditch(files)?\./i.test(hostname)) return 'FileDitch';
    return hostname;
}

function parseSteamRipDownloadLinks(doc, options = {}) {
    if (!doc || typeof doc.querySelector !== 'function') return [];
    const scope = doc.querySelector('.entry-content, .post-content, .article-content, article, main') || doc;
    if (!scope || typeof scope.querySelectorAll !== 'function') return [];
    const baseUrl = options.baseUrl || 'https://steamrip.com/';
    const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
    const markers = Array.from(scope.querySelectorAll('strong, h1, h2, h3, h4, h5, h6'));
    const languageMarker = markers
        .find(node => /^languages?$/i.test(cleanText(node && node.textContent)));
    const elementHostUrl = typeof options.elementHostUrl === 'function'
        ? options.elementHostUrl
        : element => {
            for (const attr of ['href', 'data-url', 'data-href', 'data-link', 'data-download', 'data-target']) {
                const url = normalizeSteamRipDownloadUrl(element && element.getAttribute && element.getAttribute(attr), baseUrl);
                if (url) return url;
            }
            return '';
        };
    const links = [];
    const seen = new Set();
    scope.querySelectorAll('a, button, [data-url], [data-href], [data-link], [data-download], [onclick]').forEach(element => {
        let href = normalizeSteamRipDownloadUrl(elementHostUrl(element, baseUrl, STEAMRIP_DOWNLOAD_HOST_RE), baseUrl);
        let resolverHost = '';
        if (!href) {
            let containerUrl = '';
            for (const attr of ['href', 'data-url', 'data-href', 'data-link', 'data-download', 'data-target']) {
                containerUrl = normalizeSteamRipGofileContainerUrl(
                    element && element.getAttribute && element.getAttribute(attr),
                    baseUrl
                );
                if (containerUrl) break;
            }
            const precedingMarker = markers.filter(marker => marker
                && typeof marker.compareDocumentPosition === 'function'
                && (marker.compareDocumentPosition(element) & 4)).pop();
            if (containerUrl && precedingMarker && /^gofile$/i.test(cleanText(precedingMarker.textContent))) {
                href = containerUrl;
                resolverHost = 'gofile.io';
            }
        }
        if (!href || seen.has(href)) return;
        seen.add(href);
        const followsLanguages = !!(languageMarker
            && typeof languageMarker.compareDocumentPosition === 'function'
            && (languageMarker.compareDocumentPosition(element) & 4));
        const link = {
            label: resolverHost ? 'GoFile' : steamRipDownloadHostLabel(href),
            group: followsLanguages ? 'languages' : 'game',
            type: 'web',
            url: href
        };
        if (resolverHost) link.resolverHost = resolverHost;
        links.push(link);
    });
    return links;
}

function normalizeDownloadSetHost(value) {
    const source = String(value || '').trim();
    if (!source) return '';
    if (/^magnet:/i.test(source)) return 'magnet';
    // Source pages sometimes contain Telegram/support links whose query text names
    // a file host. They must never become downloadable sets or reach the OS shell.
    if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^https:/i.test(source)) return '';
    let host = '';
    try {
        const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(source) ? source : `https://${source}`);
        host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
        host = source.toLowerCase().replace(/^[a-z][a-z\d+.-]*:\/\//, '').split(/[/?#]/, 1)[0].replace(/^www\./, '');
    }
    // FitGirl links have used several public hostnames for the same FuckingFast
    // provider. Keep other mirrors distinct; only these exact aliases collapse.
    if (/^fuckingfast\.(?:co|com|net)$/i.test(host)) return 'fuckingfast';
    return host;
}

function downloadPartNumber(value) {
    const text = String(value || '');
    const match = text.match(/\bpart\D*0*(\d+)/i) || text.match(/\.(\d{3})(?:\.[a-z0-9]+)?$/i) || text.match(/\.r(\d{2})$/i);
    return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Group source links into host/file sets for the detail download modal.
 * `shouldSplitRestrictedMultipart` preserves the renderer's browser-only
 * fallback for restricted hosts, while FitGirl's FuckingFast parts stay as
 * one complete set so the modal can expose one Download all action.
 */
function groupDownloadSets(links, sourceId, options = {}) {
    const scoreHost = typeof options.scoreHost === 'function' ? options.scoreHost : () => 0;
    const shouldSplitRestrictedMultipart = typeof options.shouldSplitRestrictedMultipart === 'function'
        ? options.shouldSplitRestrictedMultipart
        : () => false;
    const source = String(sourceId || '').trim().toLowerCase();
    const magnets = [];
    const bySet = new Map();

    (links || []).forEach(link => {
        if (!link || link.type === 'page') return;
        const group = link.group === 'languages' ? 'languages' : 'game';
        if (link.type === 'magnet') {
            if (/^magnet:\?xt=urn:btih:[A-Za-z0-9]{32,64}(?:&|$)/i.test(String(link.url || ''))) {
                magnets.push({ ...link, group });
            }
            return;
        }
        let parsed;
        try { parsed = new URL(String(link.url || '')); } catch (_) { return; }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password
            || parsed.port && parsed.port !== '443') return;
        const resolverHost = normalizeDownloadSetHost(link.resolverHost);
        const approvedContainer = /^(?:www\.)?filecrypt\.cc$/i.test(parsed.hostname)
            && resolverHost === 'gofile.io';
        if (!STEAMRIP_DOWNLOAD_HOST_RE.test(parsed.hostname) && !approvedContainer) return;
        if (DOWNLOAD_SKIP_FILE_RE.test(`${link.label || ''} ${link.url || ''}`)) return;
        const host = resolverHost || normalizeDownloadSetHost(link.url);
        if (!host) return;
        const key = `${group}\n${host}`;
        if (!bySet.has(key)) bySet.set(key, { host, group, links: [] });
        bySet.get(key).links.push(link);
    });

    const sets = [];
    bySet.forEach(entry => {
        const seen = new Set();
        const parts = entry.links
            .filter(part => {
                const url = String(part.url || '');
                if (!url || seen.has(url)) return false;
                seen.add(url);
                return true;
            })
            .sort((a, b) => downloadPartNumber(a.label || a.url) - downloadPartNumber(b.label || b.url));
        const preserveFitGirlFuckingFast = source === 'fitgirl' && entry.host === 'fuckingfast';
        if (shouldSplitRestrictedMultipart(entry.host) && !preserveFitGirlFuckingFast && parts.length > 1) {
            parts.forEach((part, index) => sets.push({
                host: entry.host,
                group: entry.group,
                kind: 'http',
                parts: [part],
                score: scoreHost(entry.host),
                partLabel: `Part ${downloadPartNumber(part.label || part.url) || index + 1}`
            }));
        } else {
            sets.push({
                host: entry.host,
                group: entry.group,
                kind: 'http',
                parts,
                score: scoreHost(entry.host)
            });
        }
    });
    if (magnets.length) {
        sets.push({
            host: 'Magnet / Torrent',
            group: magnets[0].group,
            kind: 'magnet',
            parts: [magnets[0]],
            score: scoreHost('magnet')
        });
    }

    const repack = source === 'fitgirl';
    const rank = set => set.score + (set.parts.length > 1 ? 8 : 0)
        + (repack && set.kind === 'magnet' ? 1000 : 0)
        - (set.group === 'languages' ? 500 : 0);
    sets.sort((a, b) => rank(b) - rank(a));
    return sets;
}

function paginationWindow(currentPage, totalPages) {
    const total = Math.max(1, Math.min(1000, Math.trunc(Number(totalPages) || 1)));
    const current = Math.max(1, Math.min(total, Math.trunc(Number(currentPage) || 1)));
    if (total <= 7) return Array.from({ length: total }, (_item, index) => index + 1);
    if (current <= 4) return [1, 2, 3, 4, 5, null, total];
    if (current >= total - 3) return [1, null, total - 4, total - 3, total - 2, total - 1, total];
    return [1, null, current - 1, current, current + 1, null, total];
}

function fullScreenshotImageUrl(value, baseUrl) {
    const normalized = normalizeRemoteImageUrl(value, baseUrl);
    if (!normalized) return '';
    const parsed = new URL(normalized);
    if (/(^|\.)riotpixels\.net$/i.test(parsed.hostname)) {
        parsed.pathname = parsed.pathname.replace(
            /(\.(?:jpe?g|png|webp))\.(?:\d{2,4}p)\.(?:jpe?g|png|webp)$/i,
            '$1'
        );
    }
    return parsed.href;
}

function cleanDownloadedGameName(name) {
    let result = String(name || '').trim();
    result = result.replace(/\s*[-–—]\s*v\.?\s*\d[\d.]*.*$/i, '');
    result = result.replace(/\s*[-–—]\s*\d+(\.\d+)+.*$/i, '');
    result = result.replace(/\s*[-–—]\s*(version|build|update|hotfix|patch|repack|gog|fitgirl)\b.*$/i, '');
    result = result.replace(/\s*[\(\[]\s*(v\.?\s*)?\d[\d.]*[^)\]]*[\)\]]\s*$/i, '');
    return result.trim() || String(name || '').trim();
}

function normalizedSteamTitle(value) {
    return cleanDownloadedGameName(value)
        .replace(/[™®©]/g, '')
        .normalize('NFKD')
        .toLocaleLowerCase('en-US')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function isSteamCatalogDownloadSource(sourceId) {
    return /^(steamrip|steamgg|fitgirl)$/i.test(String(sourceId || '').trim());
}

function steamStoreMetadataForDownloadedGame(name, payload) {
    const items = payload && Array.isArray(payload.items)
        ? payload.items.filter(item => item && /^[1-9]\d{0,9}$/.test(String(item.id || '')))
        : [];
    if (!items.length) return null;
    const normalizedName = normalizedSteamTitle(name);
    const selected = items.find(item => normalizedSteamTitle(item.name) === normalizedName) || items[0];
    const steamAppId = String(selected.id);
    return {
        steamAppId,
        steamImageUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`,
        steamHeroUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_hero.jpg`
    };
}

function applySteamMetadataToDownloadedGame(game, metadata) {
    if (!game || typeof game !== 'object' || !metadata || typeof metadata !== 'object') return false;
    const steamAppId = String(metadata.steamAppId || '').trim();
    if (!/^[1-9]\d{0,9}$/.test(steamAppId)) return false;
    game.platform = 'steam';
    game.steamAppId = steamAppId;
    game.sourceIdentifier = steamAppId;
    game.steamImageUrl = String(metadata.steamImageUrl || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`);
    game.steamHeroUrl = String(metadata.steamHeroUrl || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_hero.jpg`);
    return true;
}

function repairDownloadedSteamGameMetadata(game) {
    if (!game || game.source !== 'sail-download' || game.platform !== 'custom') return false;
    return applySteamMetadataToDownloadedGame(game, game);
}

module.exports = {
    DOWNLOAD_SKIP_FILE_RE,
    FITGIRL_GAME_CATEGORY_ID,
    STEAMRIP_DOWNLOAD_HOST_RE,
    applySteamMetadataToDownloadedGame,
    cleanDownloadedGameName,
    firstImageFromHtml,
    fullScreenshotImageUrl,
    normalizeFitGirlPostCovers,
    normalizeFitGirlPosts,
    normalizeRemoteImageUrl,
    normalizeSteamRipGofileContainerUrl,
    normalizeSteamRipDownloadUrl,
    normalizeSteamRipResultUrl,
    normalizeDownloadSetHost,
    downloadPartNumber,
    groupDownloadSets,
    parseSteamRipDownloadLinks,
    parseSteamRipResults,
    paginationWindow,
    isSteamCatalogDownloadSource,
    repairDownloadedSteamGameMetadata,
    steamStoreMetadataForDownloadedGame,
    steamRipDownloadHostLabel
};
