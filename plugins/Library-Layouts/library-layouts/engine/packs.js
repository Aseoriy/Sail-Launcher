'use strict';

// Layout packs: a plugin.json with a "layout" section, CSS, images and fonts. No code. This file checks a pack
// and turns its manifest into the block configuration the engine builds. Nothing here touches the page.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const CONTRACT = 1;
const FILE_TYPES = new Set(['.json', '.css', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.woff', '.woff2', '.md', '.txt']);
const LIMITS = { files: 200, depth: 4, fileBytes: 5 * 1024 * 1024, packBytes: 20 * 1024 * 1024, cssBytes: 512 * 1024, styles: 8, tokens: 120 };

// Sail's page tabs, by the names packs use.
const TABS = { library: 'tabLibrary', downloads: 'tabDownloads', mods: 'tabStore', workshop: 'tabWorkshop', downloadsmgr: 'tabDownloadsMgr', achievements: 'tabAchievements', maintenance: 'tabMaintenance' };
const STATS = ['lastPlayed', 'playtime', 'achievements'];
const BOTTOM = ['addGame', 'downloads', 'friends'];

const slug = id => String(id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'pack';

// Every file in a pack must be data. Links are refused, so a pack can't point at files elsewhere on the PC.
function checkFiles(folder) {
    const problems = [];
    let count = 0, total = 0;
    (function walk(directory, depth) {
        if (depth > LIMITS.depth) { problems.push('The pack has folders nested too deeply.'); return; }
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name), relative = path.relative(folder, file);
            if (entry.isSymbolicLink()) { problems.push(`${relative} is a link.`); continue; }
            if (entry.isDirectory()) { walk(file, depth + 1); continue; }
            if (!entry.isFile()) { problems.push(`${relative} is not a regular file.`); continue; }
            if (++count > LIMITS.files) { problems.push(`The pack has more than ${LIMITS.files} files.`); return; }
            if (!FILE_TYPES.has(path.extname(entry.name).toLowerCase())) problems.push(`${relative} is not allowed in a layout pack (only CSS, JSON, images, fonts and text).`);
            const size = fs.statSync(file).size;
            total += size;
            if (size > LIMITS.fileBytes) problems.push(`${relative} is larger than 5 MB.`);
        }
    })(folder, 0);
    if (total > LIMITS.packBytes) problems.push('The pack is larger than 20 MB.');
    return problems;
}

// A block option can follow one of the pack's settings: { "setting": "tallCovers", "values": { "true": "portrait", "false": "wide" } }.
// Without "values" the setting's own value is used.
function param(value, settings) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.setting !== 'string') return value;
    const current = settings[value.setting];
    if (!value.values || typeof value.values !== 'object') return current;
    const key = String(current);
    return Object.prototype.hasOwnProperty.call(value.values, key) ? value.values[key] : value.values.default;
}

const oneOf = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const listOf = (value, allowed) => Array.isArray(value) ? [...new Set(value.filter(item => allowed.includes(item)))] : [];

// The manifest's "blocks", with every setting switch resolved, checked against contract 1. A block that is left out,
// switched off with "when"/"unless", or set to false is not built, so Sail's own interface stays in that spot.
function resolveBlocks(blocks, settings = {}) {
    const warnings = [];
    const config = {};
    const source = blocks && typeof blocks === 'object' && !Array.isArray(blocks) ? blocks : {};
    const known = ['titleBar', 'tabs', 'gameList', 'home', 'gamePage', 'manageGame', 'profilePage', 'bottomBar', 'friendsPanel'];
    for (const name of Object.keys(source)) if (!known.includes(name)) warnings.push(`Unknown block "${name}" was ignored.`);
    const read = name => {
        let block = param(source[name], settings);
        if (block && typeof block === 'object' && !Array.isArray(block)) {
            if (typeof block.when === 'string' && !settings[block.when]) return null;
            if (typeof block.unless === 'string' && settings[block.unless]) return null;
            block = Object.fromEntries(Object.entries(block).map(([key, value]) => [key, param(value, settings)]));
        }
        return block === undefined || block === false || block === null ? null : block;
    };
    const titleBar = read('titleBar');
    if (titleBar) config.titleBar = { rows: titleBar.rows === 1 ? 1 : 2, menu: oneOf(titleBar.menu, ['full', 'none'], 'full'), sailButtons: oneOf(titleBar.sailButtons, ['hidden', 'shown'], 'hidden') };
    const tabs = read('tabs');
    if (tabs) {
        const names = {};
        if (tabs.names && typeof tabs.names === 'object' && !Array.isArray(tabs.names)) {
            for (const [key, label] of Object.entries(tabs.names)) if (TABS[key] && typeof label === 'string' && label.trim()) names[key] = label.trim().slice(0, 40);
        }
        config.tabs = { position: oneOf(tabs.position, ['titleBar'], 'titleBar'), names, order: listOf(tabs.order, Object.keys(TABS)), hidden: listOf(tabs.hidden, Object.keys(TABS)) };
    }
    const gameList = read('gameList');
    if (gameList) config.gameList = { position: 'left', filter: gameList.filter !== false, search: gameList.search !== false };
    const home = read('home');
    if (home) config.home = { covers: oneOf(home.covers, ['wide', 'portrait'], 'wide'), shelf: oneOf(home.shelf, ['none', 'recent'], 'none'), header: oneOf(home.header, ['none', 'count'], 'none') };
    const gamePage = read('gamePage');
    if (gamePage) config.gamePage = { layout: oneOf(gamePage.layout, ['sail', 'hero'], 'sail'), stats: listOf(gamePage.stats, STATS) };
    const manageGame = read('manageGame');
    if (manageGame === 'properties' || manageGame && manageGame.style === 'properties') config.manageGame = 'properties';
    if (read('profilePage') === true) config.profilePage = true;
    const bottomBar = read('bottomBar');
    const bottomItems = listOf(Array.isArray(bottomBar) ? bottomBar : bottomBar && bottomBar.items, BOTTOM);
    if (bottomItems.length) config.bottomBar = bottomItems;
    const friendsPanel = read('friendsPanel');
    if (friendsPanel) config.friendsPanel = oneOf(friendsPanel, ['shown', 'hidden'], 'shown');
    return { config, warnings };
}

// Tokens are CSS custom properties the pack sets while it is shown: plain values only.
function tokens(raw) {
    const result = {}, warnings = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { result, warnings };
    for (const [name, value] of Object.entries(raw).slice(0, LIMITS.tokens)) {
        if (!/^--sl-[a-z0-9-]{1,40}$/.test(name)) { warnings.push(`Token ${String(name).slice(0, 50)} must start with --sl-.`); continue; }
        const text = String(value);
        if (text.length > 200 || /[;{}<>]|url\s*\(|expression\s*\(|\\/i.test(text)) { warnings.push(`Token ${name} has a value that isn't allowed.`); continue; }
        result[name] = text;
    }
    return { result, warnings };
}

// The pack's settings, as classes on the page: a toggle that is on becomes sl-opt-<id>, a choice becomes
// sl-opt-<id>-<value>. Numbers and other text become --sl-opt-<id>.
function optionClasses(values = {}) {
    const classes = [], variables = {};
    for (const [id, value] of Object.entries(values)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) continue;
        if (value === true) classes.push(`sl-opt-${id}`);
        else if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value)) classes.push(`sl-opt-${id}-${value}`);
        if (typeof value === 'number' && Number.isFinite(value)) variables[`--sl-opt-${id}`] = String(value);
    }
    return { classes, variables };
}

const folderUrl = folder => pathToFileURL(folder.endsWith(path.sep) ? folder : folder + path.sep).href;

// URLs the pack's CSS may use: its own files, and inline images and fonts. Nothing on the internet, so a pack
// can't see who uses it or change what it loads later.
function allowedUrl(url, folder) {
    const value = String(url || '').trim();
    if (/^data:(?:image\/(?:png|jpeg|gif|webp|svg\+xml)|font\/[a-z0-9.+-]+)[;,]/i.test(value)) return true;
    const base = folderUrl(folder);
    return value.startsWith(base) && !value.slice(base.length).split(/[/\\]/).includes('..');
}

const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

// Checks a pack stylesheet as text and points its relative url()s at the pack's folder. The engine then has the
// browser parse it inside the pack's scope and checks the result again.
function prepareCss(css, folder) {
    const problems = [];
    const text = String(css || '');
    if (Buffer.byteLength(text) > LIMITS.cssBytes) return { css: '', problems: ['A stylesheet is larger than 512 KB.'] };
    const plain = text.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/@import/i.test(plain)) problems.push('@import is not allowed; put everything in the pack\'s own stylesheets.');
    if (/expression\s*\(|-moz-binding|behavior\s*:|javascript:/i.test(plain)) problems.push('The stylesheet uses something that could run code.');
    // Every block must close inside the pack's scope: a stray "}" would end the scope and style all of Sail.
    let depth = 0;
    for (const character of plain.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')) {
        if (character === '{') depth++;
        else if (character === '}' && --depth < 0) break;
    }
    if (depth !== 0) problems.push('The stylesheet\'s braces don\'t match, so it would reach outside the pack.');
    const rewritten = plain.replace(CSS_URL, (match, quote, raw) => {
        const target = raw.trim();
        if (/^data:/i.test(target)) { if (!allowedUrl(target, folder)) problems.push('Only inline images and fonts may use data: URLs.'); return match; }
        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target) || path.isAbsolute(target)) { problems.push(`${target.slice(0, 80)} is outside the pack. Use files inside the pack.`); return match; }
        const file = path.resolve(folder, target);
        if (!file.startsWith(folder + path.sep)) { problems.push(`${target.slice(0, 80)} is outside the pack.`); return match; }
        return `url("${pathToFileURL(file).href}")`;
    });
    return { css: problems.length ? '' : rewritten, problems };
}

// Reads a pack from its folder (an installed one, or the built-in Steam pack) and checks all of it.
function loadPack(folder, manifest) {
    const problems = [], warnings = [];
    const layout = manifest && manifest.layout;
    if (manifest && manifest.main) problems.push('Layout packs cannot contain code.');
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) problems.push('plugin.json has no "layout" section.');
    if (layout && layout.contract !== undefined && layout.contract !== CONTRACT) {
        problems.push(layout.contract > CONTRACT ? 'This pack needs a newer Library Layouts.' : 'This pack was made for an older Library Layouts.');
    }
    problems.push(...checkFiles(folder));
    const styles = [];
    if (!problems.length) {
        const names = Array.isArray(layout.styles) ? layout.styles.slice(0, LIMITS.styles) : [];
        for (const name of names) {
            const file = path.resolve(folder, String(name));
            if (!file.startsWith(folder + path.sep) || path.extname(file).toLowerCase() !== '.css' || !fs.existsSync(file)) { problems.push(`The stylesheet ${String(name).slice(0, 80)} is missing.`); continue; }
            const prepared = prepareCss(fs.readFileSync(file, 'utf8'), folder);
            problems.push(...prepared.problems.map(problem => `${name}: ${problem}`));
            styles.push(prepared.css);
        }
    }
    const tokenResult = tokens(layout && layout.tokens);
    warnings.push(...tokenResult.warnings);
    const preview = layout && typeof layout.preview === 'string' ? path.resolve(folder, layout.preview) : '';
    return {
        ok: !problems.length,
        problems,
        warnings,
        folder,
        styles: problems.length ? [] : styles,
        tokens: tokenResult.result,
        blocks: layout && layout.blocks,
        preview: preview && preview.startsWith(folder + path.sep) && fs.existsSync(preview) ? pathToFileURL(preview).href : ''
    };
}

module.exports = { CONTRACT, TABS, STATS, BOTTOM, allowedUrl, checkFiles, folderUrl, loadPack, optionClasses, param, prepareCss, resolveBlocks, slug, tokens };
