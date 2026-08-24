'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f<>"']/;
const CSS_COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\(\s*[0-9.%+\-,\s]+\)|[a-z]{1,24})$/i;
const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const STEAM_IMAGE_HOSTS = new Set([
    'shared.akamai.steamstatic.com',
    'shared.fastly.steamstatic.com',
    'cdn.akamai.steamstatic.com',
    'steamcdn-a.akamaihd.net',
    'avatars.akamai.steamstatic.com',
    'avatars.cloudflare.steamstatic.com',
    'community.cloudflare.steamstatic.com',
    'steamuserimages-a.akamaihd.net',
    'images.steamusercontent.com'
]);
const STEAM_IMAGE_SUFFIXES = new Set([
    'steamstatic.com',
    'steamusercontent.com',
    'steampowered.com',
    'steamcommunity.com'
]);
const DISCORD_IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const SAIL_IMAGE_HOSTS = new Set([
    'sail-launcher.sailhub.fyi',
    'sailhub.fyi',
    'vglpzpffejwgttlqrums.supabase.co'
]);
const SAFE_FONT_FAMILIES = new Set(['Segoe UI', 'Arial', 'Courier New', 'Georgia', 'Impact']);
const SAFE_THEME_ANIMATIONS = new Set(['none', 'aurora', 'pulse', 'wave', 'grid', 'ripple', 'frost']);
const SAFE_UI_ANIMATIONS = new Set(['none', 'pulse', 'float', 'glow', 'spin', 'gradshift', 'shimmer']);
const UI_OVERRIDE_KEYS = new Set([
    'x', 'y', 'rot', 'w', 'h', 'color', 'solid', 'bg', 'gradStops', 'gradAngle',
    'textGrad', 'textGradStore', 'radius', 'pad', 'opacity', 'fontSize',
    'anim', 'text'
]);
const CUSTOM_THEME_KEYS = new Set([
    'id', 'name', 'dropdownAccentStyle', 'animation', 'accent', 'bg', 'card',
    'text', 'border', 'radius', 'tileWidth', 'tileHeight', 'glassCardColor',
    'glassCardOpacity', 'glassBorderColor', 'glassBorderOpacity', 'glassBlur',
    'uiCustom', 'uiAppBg', 'uiAppBgStore', 'uiAccent'
]);

function stringValue(value, maxLength = 8192) {
    if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) return '';
    return value;
}

function normalizeHosts(values) {
    return new Set(Array.from(values || [], value => String(value).toLowerCase()));
}

function hostAllowed(hostname, exactHosts, suffixes) {
    const host = String(hostname || '').toLowerCase();
    if (exactHosts.has(host)) return true;
    return suffixes.some(suffix => host.length > suffix.length && host.endsWith(`.${suffix}`));
}

function safeHttpsUrl(value, options = {}) {
    const source = stringValue(value, options.maxLength || 4096).trim();
    if (!source || CONTROL_OR_MARKUP.test(source) || source.includes('\\')) return '';
    let parsed;
    try { parsed = new URL(source); } catch (_) { return ''; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return '';
    const exactHosts = normalizeHosts(options.hosts);
    const suffixes = Array.from(options.hostSuffixes || [], value => String(value).toLowerCase());
    if (exactHosts.size || suffixes.length) {
        if (!hostAllowed(parsed.hostname, exactHosts, suffixes)) return '';
    } else if (options.allowAnyHost !== true) {
        return '';
    }
    if (options.pathPrefixes && !Array.from(options.pathPrefixes).some(prefix => parsed.pathname.startsWith(prefix))) return '';
    return parsed.href;
}

function safeExternalUrl(value, options = {}) {
    const source = stringValue(value, options.maxLength || 4096).trim();
    if (!source || CONTROL_OR_MARKUP.test(source) || source.includes('\\')) return '';
    let parsed;
    try { parsed = new URL(source); } catch (_) { return ''; }
    if (!['https:', ...(options.allowHttp ? ['http:'] : [])].includes(parsed.protocol)) return '';
    if (parsed.username || parsed.password || parsed.port && !['80', '443'].includes(parsed.port)) return '';
    const exactHosts = normalizeHosts(options.hosts);
    const suffixes = Array.from(options.hostSuffixes || [], value => String(value).toLowerCase());
    if ((exactHosts.size || suffixes.length) && !hostAllowed(parsed.hostname, exactHosts, suffixes)) return '';
    if (!exactHosts.size && !suffixes.length && options.allowAnyHost !== true) return '';
    return parsed.href;
}

function safeFileUrl(value) {
    const source = stringValue(value, 32767).trim();
    if (!source) return '';
    try {
        if (/^file:/i.test(source)) {
            const parsed = new URL(source);
            if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.host) return '';
            return parsed.href;
        }
        if (!path.isAbsolute(source)) return '';
        return pathToFileURL(path.normalize(source)).href;
    } catch (_) {
        return '';
    }
}

function safeDataImage(value, maxLength = 2 * 1024 * 1024) {
    const source = typeof value === 'string' && value.length <= maxLength ? value : '';
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
    if (!match || !SAFE_IMAGE_MIME.has(match[1].toLowerCase())) return '';
    return source;
}

function safeImageUrl(value, options = {}) {
    const source = typeof value === 'string' ? value.trim() : '';
    if (!source) return '';
    if (options.allowFile) {
        const local = safeFileUrl(source);
        if (local) return local;
    }
    if (options.allowData) {
        const data = safeDataImage(source, options.maxDataLength);
        if (data) return data;
    }
    const hosts = new Set(options.hosts || []);
    const hostSuffixes = new Set(options.hostSuffixes || []);
    if (options.allowAnyHost !== true) {
        if (options.allowSteam !== false) {
            STEAM_IMAGE_HOSTS.forEach(host => hosts.add(host));
            STEAM_IMAGE_SUFFIXES.forEach(suffix => hostSuffixes.add(suffix));
        }
        if (options.allowDiscord) DISCORD_IMAGE_HOSTS.forEach(host => hosts.add(host));
        if (options.allowSail) SAIL_IMAGE_HOSTS.forEach(host => hosts.add(host));
    }
    return safeHttpsUrl(source, {
        hosts,
        hostSuffixes,
        pathPrefixes: options.pathPrefixes,
        maxLength: options.maxLength || 4096,
        allowAnyHost: options.allowAnyHost === true
    });
}

function safeCssColor(value, fallback = '') {
    const source = stringValue(value, 64).trim();
    if (!source || !CSS_COLOR.test(source) || /(?:url|var|expression|@|;|\\)/i.test(source)) return fallback;
    return source;
}

function safeCssLength(value, options = {}) {
    const number = Number(value);
    const min = Number.isFinite(options.min) ? options.min : 0;
    const max = Number.isFinite(options.max) ? options.max : 10000;
    if (!Number.isFinite(number) || number < min || number > max) return options.fallback || '';
    return `${number}${options.unit || 'px'}`;
}

function safeEnum(value, allowed, fallback = '') {
    const source = String(value || '');
    return allowed.includes(source) ? source : fallback;
}

function boundedNumber(value, min, max, fallback = null, integer = false) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) return fallback;
    return integer ? Math.round(number) : number;
}

function safeGradientStore(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.some(key => !['gradAngle', 'gradStops'].includes(key))) return null;
    if (!Array.isArray(value.gradStops) || value.gradStops.length < 2 || value.gradStops.length > 8) return null;
    const gradAngle = boundedNumber(value.gradAngle === undefined ? 135 : value.gradAngle, 0, 360, null);
    if (gradAngle === null) return null;
    const gradStops = [];
    for (const stop of value.gradStops) {
        if (!stop || typeof stop !== 'object' || Array.isArray(stop) || Object.keys(stop).some(key => !['c', 'p'].includes(key))) return null;
        const c = safeCssColor(stop.c);
        const p = boundedNumber(stop.p, 0, 100, null);
        if (!c || p === null) return null;
        gradStops.push({ c, p });
    }
    return { gradAngle, gradStops };
}

function safeCssGradient(value) {
    const store = safeGradientStore(value);
    if (!store) return '';
    return `linear-gradient(${store.gradAngle}deg, ${store.gradStops.map(stop => `${stop.c} ${stop.p}%`).join(', ')})`;
}

function safeCssSelector(value) {
    const source = stringValue(value, 512).trim();
    if (!source) return '';
    const identifier = '[A-Za-z_][A-Za-z0-9_-]{0,127}';
    const simple = new RegExp(`^(?:#${identifier}|\\.${identifier}|[a-z][a-z0-9-]{0,31}(?::nth-of-type\\([1-9][0-9]{0,3}\\))?)$`);
    const parts = source.split(' > ');
    if (!parts.length || parts.length > 16 || parts.some(part => !simple.test(part))) return '';
    return parts.join(' > ');
}

function safeUiCustom(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value);
    if (entries.length > 256) return {};
    const result = {};
    for (const [rawSelector, rawOverride] of entries) {
        const selector = safeCssSelector(rawSelector);
        if (!selector || !rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) continue;
        if (Object.keys(rawOverride).some(key => !UI_OVERRIDE_KEYS.has(key))) continue;
        const override = {};
        for (const [key, min, max] of [
            ['x', -10000, 10000], ['y', -10000, 10000], ['rot', -360, 360],
            ['w', 1, 10000], ['h', 1, 10000], ['radius', 0, 500],
            ['pad', 0, 500], ['opacity', 0, 100], ['fontSize', 6, 300]
        ]) {
            if (rawOverride[key] === undefined || rawOverride[key] === null) continue;
            const number = boundedNumber(rawOverride[key], min, max, null);
            if (number !== null) override[key] = number;
        }
        const color = safeCssColor(rawOverride.color);
        if (color) override.color = color;
        const backgroundStore = safeGradientStore({ gradAngle: rawOverride.gradAngle, gradStops: rawOverride.gradStops });
        const backgroundGradient = safeCssGradient(backgroundStore);
        const backgroundColor = safeCssColor(rawOverride.bg);
        const solid = safeCssColor(rawOverride.solid);
        if (solid) override.solid = solid;
        if (backgroundGradient) {
            override.gradAngle = backgroundStore.gradAngle;
            override.gradStops = backgroundStore.gradStops;
            override.bg = backgroundGradient;
        } else if (backgroundColor) override.bg = backgroundColor;
        const textGradientStore = safeGradientStore(rawOverride.textGradStore);
        if (textGradientStore) {
            override.textGradStore = textGradientStore;
            override.textGrad = safeCssGradient(textGradientStore);
        }
        const anim = safeEnum(rawOverride.anim, [...SAFE_UI_ANIMATIONS]);
        if (anim) override.anim = anim;
        if (typeof rawOverride.text === 'string' && rawOverride.text.length <= 512 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(rawOverride.text)) {
            override.text = rawOverride.text;
        }
        result[selector] = override;
    }
    return result;
}

function safeThemeId(value, fallback = 'theme-midnight') {
    const source = stringValue(value, 160).trim();
    if (/^theme-[a-z0-9-]{1,64}$/.test(source) || /^theme-custom-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source)) return source;
    return fallback;
}

function safeFontFamily(value, fallback = 'Segoe UI') {
    return SAFE_FONT_FAMILIES.has(value) ? value : fallback;
}

function safeUserSources(value) {
    if (!Array.isArray(value) || value.length > 64) return [];
    const result = [];
    for (const source of value) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
        if (Object.keys(source).some(key => !['name', 'url', 'coverPhoto', 'openInSystemBrowser'].includes(key))) continue;
        const name = stringValue(source.name, 128).trim();
        const url = safeExternalUrl(source.url, { allowAnyHost: true });
        const coverPhoto = source.coverPhoto ? safeFileUrl(source.coverPhoto) : '';
        if (!name || !url || source.coverPhoto && !coverPhoto) continue;
        result.push({ name, url, coverPhoto: coverPhoto || null, openInSystemBrowser: source.openInSystemBrowser === true });
    }
    return result;
}

function safeCustomTheme(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.keys(value).some(key => !CUSTOM_THEME_KEYS.has(key))) return null;
    const id = stringValue(String(value.id || ''), 128).trim();
    const name = stringValue(String(value.name || ''), 80).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || !name) return null;
    const theme = { id, name };
    for (const key of ['accent', 'bg', 'card', 'text', 'border', 'glassCardColor', 'glassBorderColor']) {
        const color = safeCssColor(value[key]);
        if (!color && ['accent', 'bg', 'card', 'text', 'border'].includes(key)) return null;
        if (color) theme[key] = color;
    }
    theme.dropdownAccentStyle = safeEnum(value.dropdownAccentStyle, ['filled', 'outline'], 'filled');
    theme.animation = safeEnum(value.animation, [...SAFE_THEME_ANIMATIONS], 'none');
    theme.radius = boundedNumber(value.radius, 0, 100, 12);
    theme.tileWidth = boundedNumber(value.tileWidth, 120, 1000, 230);
    theme.tileHeight = boundedNumber(value.tileHeight, 60, 800, 130);
    theme.glassCardOpacity = boundedNumber(value.glassCardOpacity, 0, 100, 5);
    theme.glassBorderOpacity = boundedNumber(value.glassBorderOpacity, 0, 100, 8);
    theme.glassBlur = boundedNumber(value.glassBlur, 0, 100, 24);
    theme.uiCustom = safeUiCustom(value.uiCustom);
    const appBackground = safeGradientStore(value.uiAppBgStore);
    if (appBackground) {
        theme.uiAppBgStore = appBackground;
        theme.uiAppBg = safeCssGradient(appBackground);
    }
    const uiAccent = safeCssColor(value.uiAccent);
    if (uiAccent) theme.uiAccent = uiAccent;
    return theme;
}

function clearNode(node) {
    if (node) node.replaceChildren();
    return node;
}

function element(document, tagName, options = {}, children = []) {
    const node = document.createElement(tagName);
    if (options.className) node.className = String(options.className);
    if (options.text !== undefined) node.textContent = String(options.text);
    if (options.title !== undefined) node.title = String(options.title).slice(0, 2048);
    if (options.id) node.id = String(options.id);
    if (options.type) node.type = String(options.type);
    if (options.value !== undefined) node.value = String(options.value);
    if (options.checked !== undefined) node.checked = !!options.checked;
    if (options.disabled !== undefined) node.disabled = !!options.disabled;
    if (options.ariaLabel !== undefined) node.setAttribute('aria-label', String(options.ariaLabel).slice(0, 2048));
    for (const child of Array.isArray(children) ? children : [children]) {
        if (child === null || child === undefined) continue;
        node.append(child && child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
}

function setImageSource(image, value, options = {}) {
    const source = safeImageUrl(value, options);
    if (!source) {
        image.removeAttribute('src');
        image.hidden = options.hideInvalid !== false;
        return false;
    }
    image.src = source;
    image.hidden = false;
    return true;
}

const STEAM_INLINE_TAGS = new Set(['STRONG', 'B', 'EM', 'I', 'CODE', 'S']);
const STEAM_BLOCK_TAGS = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'H3', 'H4', 'BLOCKQUOTE', 'PRE']);
const STEAM_DROP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'SVG', 'MATH', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
    'BUTTON', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'CANVAS',
    'TEMPLATE', 'NOSCRIPT', 'META', 'LINK', 'BASE', 'FRAME', 'FRAMESET', 'PORTAL'
]);

function rebuildSteamRichText(document, html, options = {}) {
    const source = typeof html === 'string' ? html.slice(0, options.maxLength || 128 * 1024) : '';
    const parser = new document.defaultView.DOMParser();
    const parsed = parser.parseFromString(source, 'text/html');
    const fragment = document.createDocumentFragment();
    let nodes = 0;
    const maxNodes = options.maxNodes || 4000;

    const appendChildren = (sourceNode, target) => {
        for (const child of Array.from(sourceNode.childNodes || [])) {
            if (nodes >= maxNodes) break;
            if (child.nodeType === 3) {
                nodes += 1;
                target.append(document.createTextNode(String(child.nodeValue || '').slice(0, 32768)));
                continue;
            }
            if (child.nodeType !== 1) continue;
            const tag = String(child.tagName || '').toUpperCase();
            if (STEAM_DROP_TAGS.has(tag)) continue;
            if (tag === 'BR') {
                nodes += 1;
                target.append(document.createElement('br'));
                continue;
            }
            if (tag === 'A') {
                const href = safeHttpsUrl(child.getAttribute('href') || '', {
                    hosts: ['store.steampowered.com', 'steamcommunity.com', 'help.steampowered.com'],
                    allowAnyHost: false
                });
                if (!href) {
                    appendChildren(child, target);
                    continue;
                }
                nodes += 1;
                const anchor = document.createElement('a');
                anchor.href = href;
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
                const title = stringValue(child.getAttribute('title') || '', 512);
                if (title) anchor.title = title;
                appendChildren(child, anchor);
                target.append(anchor);
                continue;
            }
            if (STEAM_INLINE_TAGS.has(tag) || STEAM_BLOCK_TAGS.has(tag)) {
                nodes += 1;
                const rebuilt = document.createElement(tag.toLowerCase());
                appendChildren(child, rebuilt);
                target.append(rebuilt);
                continue;
            }
            appendChildren(child, target);
        }
    };

    appendChildren(parsed.body, fragment);
    return fragment;
}

module.exports = {
    DISCORD_IMAGE_HOSTS,
    SAIL_IMAGE_HOSTS,
    STEAM_IMAGE_HOSTS,
    STEAM_IMAGE_SUFFIXES,
    clearNode,
    element,
    rebuildSteamRichText,
    safeCssGradient,
    safeCssColor,
    safeCssLength,
    safeCssSelector,
    safeCustomTheme,
    safeDataImage,
    safeEnum,
    safeExternalUrl,
    safeFileUrl,
    safeFontFamily,
    safeHttpsUrl,
    safeImageUrl,
    safeGradientStore,
    safeThemeId,
    safeUiCustom,
    safeUserSources,
    setImageSource
};
