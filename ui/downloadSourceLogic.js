'use strict';

const FITGIRL_GAME_CATEGORY_ID = 5;
const SEARCH_STOP_WORDS = new Set([
    'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with'
]);

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

function searchWords(value) {
    return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function filterSearchResultsByTitle(results, query) {
    if (!Array.isArray(results)) return [];
    const tokens = [...new Set(searchWords(query).filter(word => !SEARCH_STOP_WORDS.has(word)))];
    if (!tokens.length) return results.slice();
    const requiredMatches = tokens.length <= 2 ? 1 : Math.ceil(tokens.length / 2);
    return results.filter(result => {
        const titleWords = new Set(searchWords(result && result.name));
        return tokens.reduce((count, token) => count + (titleWords.has(token) ? 1 : 0), 0) >= requiredMatches;
    });
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

module.exports = {
    FITGIRL_GAME_CATEGORY_ID,
    filterSearchResultsByTitle,
    firstImageFromHtml,
    fullScreenshotImageUrl,
    normalizeFitGirlPosts,
    normalizeRemoteImageUrl
};
