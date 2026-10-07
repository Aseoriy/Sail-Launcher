'use strict';

// First-run setup for the Linux launcher. Every choice is applied by driving the matching control in
// Settings, so validation, saving and live updates behave exactly as if the person had used Settings.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Calm themes first. Colours are read from the stylesheet at run time; these are only a fallback.
const THEMES = [
    { id: 'theme-midnight', name: 'Midnight', bg: '#09090b', card: '#18181b', accent: '#a855f7', text: '#fafafa' },
    { id: 'theme-monochrome', name: 'Mono', bg: '#000000', card: '#111111', accent: '#888888', text: '#ffffff' },
    { id: 'theme-frost', name: 'Frost', bg: '#f3f4f6', card: '#ffffff', accent: '#3b82f6', text: '#111827' },
    { id: 'theme-deepsea', name: 'Deep Sea', bg: '#011627', card: '#032b43', accent: '#069e8a', text: '#fbfbff' },
    { id: 'theme-ocean', name: 'Ocean', bg: '#041421', card: '#072136', accent: '#38bdf8', text: '#e0f2fe' },
    { id: 'theme-forest', name: 'Forest', bg: '#0f1c13', card: '#182b1b', accent: '#4ade80', text: '#e2f0d9' },
    { id: 'theme-sunset', name: 'Sunset', bg: '#1a0b1c', card: '#2d142c', accent: '#fb923c', text: '#ffe4e6' },
    { id: 'theme-cherry', name: 'Cherry', bg: '#1a0110', card: '#330325', accent: '#ff66d9', text: '#ffccf2' },
    { id: 'theme-neon', name: 'Neon', bg: '#0d0221', card: '#261447', accent: '#ff007f', text: '#00ffcc' },
    { id: 'theme-cyberpunk', name: 'Cyberpunk', bg: '#0d0d0d', card: '#1a1a1a', accent: '#00f0ff', text: '#fce205' }
];

// Setting -> the Settings control that owns it.
const CONTROLS = {
    theme: { id: 'themeSelect' },
    glass: { id: 'legacyUiToggle', invert: true },
    translucent: { id: 'disableTranslucencyToggle', invert: true },
    glassOpacity: { id: 'glassOpacitySlider', range: true },
    emojiIcons: { id: 'emojiIconsToggle' },
    tileSize: { id: 'tileSizeSelect' },
    tileShape: { id: 'tileShapeSelect' },
    verticalCards: { id: 'verticalCardsToggle' },
    fullTileImage: { id: 'fullTileImageToggle' },
    continuePlaying: { id: 'showContinuePlayingToggle' },
    favoritesFirst: { id: 'favoritesFirstToggle' },
    pageMods: { id: 'showModsPageToggle' },
    pageWorkshop: { id: 'showWorkshopPageToggle' },
    pageDownloads: { id: 'showGameDownloadsPageToggle' },
    pageManager: { id: 'showDownloadManagerPageToggle' },
    friends: { id: 'showSocialSidebarToggle' },
    lessAnimations: { id: 'lessAnimationsToggle' },
    animationSpeed: { id: 'animationSpeedSlider', range: true },
    discord: { id: 'disableDiscordRpcToggle', invert: true },
    achievementPopups: { id: 'achievementNotificationsToggle' },
    autostart: { id: 'autoStartToggle' }
};

const SIDEBAR_PAGES = [
    { key: 'pageMods', label: 'Mods' },
    { key: 'pageWorkshop', label: 'Workshop' },
    { key: 'pageDownloads', label: 'Game Downloads' },
    { key: 'pageManager', label: 'Downloads' },
    { key: 'friends', label: 'Friends panel' }
];

const SETUP_STEPS = [
    { id: 'look', tab: 'Look', eyebrow: 'Look', title: 'Pick a theme', lede: 'These are the colours Sail uses. You can build your own theme later.' },
    { id: 'library', tab: 'Library', eyebrow: 'Library', title: 'Set up your library', lede: 'How games are shown. The preview updates as you choose.' },
    { id: 'feel', tab: 'Motion', eyebrow: 'Motion and extras', title: 'How should it move?', lede: 'Animations are part of the look, but they are optional.' },
    { id: 'games', tab: 'Games', eyebrow: 'Games', title: 'Get your games in', lede: 'Sail can run Windows games on Linux and pick up games you already have.' }
];

// The last one is a favorite, so "Favorites first" has something to move.
const SAMPLE_GAMES = [
    ['Hollow Pines', 'Survival', 148], ['Neon Quarter', 'Action', 318], ['Paper Kingdom', 'Strategy', 42],
    ['Rally Dust', 'Racing', 24], ['Starfall', 'Adventure', 262], ['Tidebreak', 'Puzzle', 196]
];
const FAVORITE_GAME = 'Tidebreak';

// Short notices the preview can act out for settings that have no visible control of their own.
const DEMOS = {
    achievement: { icon: 'trophy', title: 'Achievement unlocked', sub: 'First Blood' },
    discord: { icon: 'gamepad', title: 'Playing Starfall', sub: 'Shown on your Discord profile' },
    autostart: { icon: 'rocket', title: 'Sail is running', sub: 'Opened when you logged in' }
};

function h(document, tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
}

function svg(document, tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    for (const child of children) node.append(child);
    return node;
}

function iconSvg(document, paths) {
    return svg(document, 'svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        paths.map(d => svg(document, 'path', { d })));
}

const ICON_PATHS = {
    windows: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
    library: ['M4 5h4v14H4z', 'M10 5h4v14h-4z', 'M16.2 6.4l3.8.9-2.7 11.6-3.8-.9z']
};

// ---- Settings access -----------------------------------------------------------------

function control(document, key) {
    const entry = CONTROLS[key];
    return entry ? document.getElementById(entry.id) : null;
}

function readSetting(document, key) {
    const entry = CONTROLS[key], element = control(document, key);
    if (!element) return undefined;
    if (element.type === 'checkbox') return entry.invert ? !element.checked : !!element.checked;
    if (entry.range) return Number(element.value);
    return element.value;
}

function writeSetting(document, key, value) {
    const entry = CONTROLS[key], element = control(document, key);
    if (!element) return false;
    if (element.type === 'checkbox') {
        const wanted = entry.invert ? !value : !!value;
        if (!!element.checked === wanted) return true;
        element.checked = wanted;
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    if (String(element.value) === String(value)) return true;
    element.value = String(value);
    if (entry.range) element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

// Wide, poster and full-cover cards are stored as two separate switches in Settings.
function cardStyleOf(document) {
    if (readSetting(document, 'fullTileImage')) return 'cover';
    return readSetting(document, 'verticalCards') ? 'poster' : 'wide';
}

function applyCardStyle(document, style) {
    writeSetting(document, 'verticalCards', style === 'poster');
    writeSetting(document, 'fullTileImage', style === 'cover');
}

function readModel(document) {
    const pages = {};
    for (const page of SIDEBAR_PAGES) pages[page.key] = readSetting(document, page.key) !== false;
    return {
        theme: readSetting(document, 'theme') || 'theme-midnight',
        glass: readSetting(document, 'glass') !== false,
        translucent: readSetting(document, 'translucent') !== false,
        glassOpacity: Math.max(5, Math.min(90, Number(readSetting(document, 'glassOpacity')) || 40)),
        emojiIcons: readSetting(document, 'emojiIcons') === true,
        tileSize: readSetting(document, 'tileSize') || 'medium',
        tileShape: ['square', 'squircle'].includes(readSetting(document, 'tileShape')) ? readSetting(document, 'tileShape') : 'default',
        cardStyle: cardStyleOf(document),
        continuePlaying: readSetting(document, 'continuePlaying') !== false,
        favoritesFirst: readSetting(document, 'favoritesFirst') !== false,
        pages,
        lessAnimations: readSetting(document, 'lessAnimations') === true,
        animationSpeed: Number(readSetting(document, 'animationSpeed')) || 1
    };
}

// ---- Colour helpers --------------------------------------------------------------------

function parseHex(value) {
    const text = String(value || '').trim();
    const full = /^#([0-9a-f]{6})$/i.exec(text) || /^#([0-9a-f]{3})$/i.exec(text);
    if (!full) return null;
    const digits = full[1].length === 3 ? full[1].split('').map(c => c + c).join('') : full[1];
    return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16));
}

// White or black text, whichever reads better on this accent colour.
function onAccentColor(accent) {
    const rgb = parseHex(accent);
    if (!rgb) return '#ffffff';
    const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.42 ? '#111111' : '#ffffff';
}

function readThemePalette(document, theme) {
    const selector = `body.${theme.id}`;
    try {
        for (const sheet of Array.from(document.styleSheets || [])) {
            let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
            for (const rule of Array.from(rules || [])) {
                if (rule.selectorText !== selector) continue;
                const style = rule.style, pick = (name, fallback) => (style.getPropertyValue(name) || '').trim() || fallback;
                return { bg: pick('--bg-color', theme.bg), card: pick('--card-bg', theme.card), accent: pick('--accent', theme.accent), text: pick('--text-color', theme.text) };
            }
        }
    } catch (_) { /* The fallback palette is used. */ }
    return { bg: theme.bg, card: theme.card, accent: theme.accent, text: theme.text };
}

// ---- Summary text ----------------------------------------------------------------------

function describeChoices(model, extras = {}) {
    const theme = THEMES.find(item => item.id === model.theme);
    const cards = { wide: 'Wide cards', poster: 'Poster cards', cover: 'Full-cover cards' }[model.cardStyle] || 'Wide cards';
    const corners = { square: 'square corners', squircle: 'squircle corners', default: 'rounded corners' }[model.tileShape] || 'rounded corners';
    const hidden = SIDEBAR_PAGES.filter(page => model.pages[page.key] === false).map(page => page.label);
    const items = [
        theme ? theme.name : 'Custom theme',
        model.glass ? 'Glass effects' : 'Flat surfaces',
        model.glass ? (model.translucent ? `${100 - model.glassOpacity}% transparent window` : 'Solid window') : null,
        model.emojiIcons ? 'Emoji icons' : 'Line icons',
        `${cards}, ${model.tileSize}, ${corners}`,
        model.lessAnimations ? 'Calm motion' : 'Full motion'
    ];
    if (Math.abs(model.animationSpeed - 1) > 0.04) items.push(`${model.animationSpeed.toFixed(1)}× speed`);
    if (!model.continuePlaying) items.push('No Continue Playing banner');
    if (hidden.length) items.push(`Hidden: ${hidden.join(', ')}`);
    if (extras.windowsGames === 'ready') items.push('Windows games ready');
    if (extras.steamAdded > 0) items.push(`${extras.steamAdded} Steam game${extras.steamAdded === 1 ? '' : 's'} added`);
    return items.filter(Boolean);
}

// ---- Reusable controls -----------------------------------------------------------------

function radioGroup(document, container, { orientation = 'horizontal' } = {}) {
    // Roving focus with arrow keys for a set of role="radio" buttons.
    container.addEventListener('keydown', event => {
        const keys = orientation === 'grid' ? ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
        if (!keys.includes(event.key)) return;
        const items = Array.from(container.querySelectorAll('[role="radio"]'));
        const index = items.indexOf(document.activeElement);
        if (index < 0) return;
        const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        const next = items[(index + step + items.length) % items.length];
        event.preventDefault();
        next.focus();
        next.click();
    });
}

function setRadioState(items, value, getValue) {
    for (const item of items) {
        const selected = getValue(item) === value;
        item.setAttribute('aria-checked', selected ? 'true' : 'false');
        item.tabIndex = selected ? 0 : -1;
    }
}

function segmented(document, { label, options, value, onChange }) {
    const group = h(document, 'div', { class: 'ob-seg', role: 'radiogroup', 'aria-label': label });
    const pill = h(document, 'span', { class: 'ob-seg-pill', 'aria-hidden': 'true' });
    group.append(pill);
    const buttons = options.map(option => {
        const button = h(document, 'button', { type: 'button', role: 'radio', 'data-value': option.value, text: option.label });
        button.addEventListener('click', () => { onChange(option.value); select(option.value); });
        group.append(button);
        return button;
    });
    function select(next) {
        setRadioState(buttons, next, button => button.dataset.value);
        const index = Math.max(0, options.findIndex(option => option.value === next));
        pill.style.width = `calc((100% - 8px - ${(options.length - 1) * 4}px) / ${options.length})`;
        pill.style.transform = `translateX(calc(${index} * (100% + 4px)))`;
    }
    radioGroup(document, group);
    select(value);
    return { element: group, select };
}

function switchRow(document, { title, sub, checked, disabled = false, onChange }) {
    const button = h(document, 'button', { type: 'button', class: 'ob-switch', role: 'switch', 'aria-checked': checked ? 'true' : 'false', 'aria-label': title, disabled });
    button.addEventListener('click', () => {
        const next = button.getAttribute('aria-checked') !== 'true';
        button.setAttribute('aria-checked', next ? 'true' : 'false');
        onChange(next);
    });
    const row = h(document, 'div', { class: 'ob-row' }, [
        h(document, 'div', { class: 'ob-row-text' }, [h(document, 'div', { class: 'ob-row-title', text: title }), sub ? h(document, 'div', { class: 'ob-row-sub', text: sub }) : null]),
        button
    ]);
    return { element: row, button, set(next) { button.setAttribute('aria-checked', next ? 'true' : 'false'); } };
}

function pickGroup(document, { label, options, value, onChange }) {
    const group = h(document, 'div', { class: 'ob-picks', role: 'radiogroup', 'aria-label': label });
    const buttons = options.map(option => {
        const art = h(document, 'span', { class: 'ob-pick-art', 'aria-hidden': 'true' }, (option.art || []).map(([w, hgt]) => {
            const bar = h(document, 'i'); bar.style.width = `${w}px`; bar.style.height = `${hgt}px`; return bar;
        }));
        const button = h(document, 'button', { type: 'button', class: 'ob-pick', role: 'radio', 'data-value': option.value }, [
            art, h(document, 'div', { class: 'ob-pick-name', text: option.label }), option.sub ? h(document, 'div', { class: 'ob-pick-sub', text: option.sub }) : null
        ]);
        button.addEventListener('click', () => { onChange(option.value); select(option.value); });
        group.append(button);
        return button;
    });
    function select(next) { setRadioState(buttons, next, button => button.dataset.value); }
    radioGroup(document, group);
    select(value);
    return { element: group, select };
}

// ---- Live preview --------------------------------------------------------------------------

function buildPreview(document, window, logoUrl) {
    // Icons are the launcher's own, so they follow the Line icons / Emoji switch exactly as the real app does.
    const icon = name => {
        const node = h(document, 'span', { class: 'app-ic', 'data-ic': name, 'aria-hidden': 'true' });
        if (typeof window.paintIcons === 'function') window.paintIcons(node);
        return node;
    };
    const nav = [['library', 'Library', 'book'], ['pageMods', 'Mods', 'puzzle'], ['pageWorkshop', 'Workshop', 'wrench'], ['pageDownloads', 'Game Downloads', 'download'], ['pageManager', 'Downloads', 'inbox'], ['achievements', 'Achievements', 'trophy']];
    const navItems = nav.map(([key, label, name], index) => h(document, 'div', { class: `ob-mock-nav${index === 0 ? ' is-active' : ''}`, 'data-page': key }, [icon(name), label]));
    const hero = h(document, 'div', { class: 'ob-mock-hero' }, [h(document, 'small', { text: 'Continue playing' }), h(document, 'b', { text: 'Starfall' }), h(document, 'span', {}, [icon('play'), ' Play'])]);
    const games = SAMPLE_GAMES.map(([name, genre, hue], index) => {
        const favorite = name === FAVORITE_GAME;
        const card = h(document, 'div', { class: `ob-game${favorite ? ' is-fav' : ''}` }, [
            h(document, 'span', { class: 'ob-cover' }),
            favorite ? h(document, 'span', { class: 'ob-star', text: '★' }) : null,
            h(document, 'span', { class: 'ob-game-name' }, [name, h(document, 'small', { text: genre })])
        ]);
        card.style.setProperty('--h', String(hue));
        card.style.setProperty('--n', String(index));
        return card;
    });
    const grid = h(document, 'div', { class: 'ob-mock-grid is-replay' }, games);
    const friends = h(document, 'div', { class: 'ob-mock-friends' }, [h(document, 'b', { text: 'Friends' }), h(document, 'span', { text: 'No one online' })]);
    const calloutIcon = h(document, 'span', { class: 'ob-callout-icon' });
    const calloutTitle = h(document, 'b'), calloutSub = h(document, 'span');
    const callout = h(document, 'div', { class: 'ob-mock-callout', 'aria-hidden': 'true' }, [calloutIcon, h(document, 'div', {}, [calloutTitle, calloutSub])]);
    const mock = h(document, 'div', { class: 'ob-mock', 'aria-hidden': 'true' }, [
        h(document, 'div', { class: 'ob-mock-bar' }, [h(document, 'img', { src: logoUrl, alt: '' }), 'Sail Launcher', h(document, 'span', { class: 'grow' }), h(document, 'span', { class: 'win' }, [h(document, 'i'), h(document, 'i'), h(document, 'i')])]),
        h(document, 'div', { class: 'ob-mock-body' }, [
            h(document, 'div', { class: 'ob-mock-side' }, navItems),
            h(document, 'div', { class: 'ob-mock-main' }, [h(document, 'div', { class: 'ob-mock-title', text: 'Library' }), hero, grid]),
            friends
        ]),
        callout
    ]);
    // A stand-in wallpaper, so a see-through window has something to show.
    const desktop = h(document, 'div', { class: 'ob-desktop', 'aria-hidden': 'true' });
    const tilt = h(document, 'div', { class: 'ob-tilt' }, [desktop, mock]);
    const scale = h(document, 'div', { class: 'ob-scale' }, [tilt]);
    const fit = h(document, 'div', { class: 'ob-fit' }, [scale]);

    let favoriteOrder = null;
    function update(model) {
        mock.dataset.style = model.cardStyle;
        mock.dataset.size = model.tileSize;
        mock.dataset.shape = model.tileShape;
        mock.dataset.window = model.glass && model.translucent ? 'see-through' : 'solid';
        mock.style.setProperty('--ob-opacity', `${model.glassOpacity}%`);
        mock.classList.toggle('is-glass', model.glass);
        hero.classList.toggle('is-off', !model.continuePlaying);
        friends.classList.toggle('is-off', !model.pages.friends);
        for (const item of navItems) if (item.dataset.page in model.pages) item.classList.toggle('is-off', !model.pages[item.dataset.page]);
        const order = model.favoritesFirst ? 'first' : 'off';
        if (favoriteOrder !== null && favoriteOrder !== order) {
            // Slide the cards to their new places instead of snapping.
            const before = games.map(card => [card.offsetLeft, card.offsetTop]);
            mock.dataset.fav = order;
            games.forEach((card, i) => {
                const dx = before[i][0] - card.offsetLeft, dy = before[i][1] - card.offsetTop;
                if ((dx || dy) && typeof card.animate === 'function') card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.16, 1, .3, 1)' });
            });
        } else mock.dataset.fav = order;
        favoriteOrder = order;
    }
    // Plays the cards' entrance again, so Full or Calm, and the speed, can be seen rather than imagined.
    function replay() {
        grid.classList.remove('is-replay');
        void grid.offsetWidth;
        grid.classList.add('is-replay');
    }
    let demoTimer = 0;
    // Acts out a notice (achievement, Discord status, start at login) for a moment.
    function demo(kind) {
        const spec = DEMOS[kind];
        if (!spec) return;
        calloutIcon.replaceChildren(icon(spec.icon));
        calloutTitle.textContent = spec.title;
        calloutSub.textContent = spec.sub;
        callout.classList.remove('is-on');
        void callout.offsetWidth;
        callout.classList.add('is-on');
        clearTimeout(demoTimer);
        demoTimer = setTimeout(() => callout.classList.remove('is-on'), 3200);
    }
    return { element: fit, tilt, update, replay, demo };
}

// ---- The setup screen ----------------------------------------------------------------

function installOnboarding({ document, window = document.defaultView, ipc, invoke = null, hooks = {}, logoUrl = 'icon.png' }) {
    // `invoke` unwraps the launcher's { success, data } replies; plain `ipc.invoke` returns values as they are.
    const call = invoke || ((channel, payload) => ipc.invoke(channel, payload));
    let root = null, state = null;

    function isOpen() { return !!root; }

    async function maybeOpen() {
        let status;
        try { status = await ipc.invoke('onboarding-state'); } catch (_) { return false; }
        if (!status || !status.available || !status.shouldShow) return false;
        await open({ rerun: false });
        return true;
    }

    async function open({ rerun = false } = {}) {
        if (root) return;
        let support = null;
        try { support = await ipc.invoke('platform-get-support'); } catch (_) { /* Optional rows stay hidden. */ }
        const features = support && support.features || {};
        const bodyClasses = document.body.classList;
        bodyClasses.add('onboarding-open');
        const appContainer = document.querySelector('.app-container');
        if (appContainer) appContainer.inert = true;
        const returnFocus = document.activeElement;

        const palettes = Object.fromEntries(THEMES.map(theme => [theme.id, readThemePalette(document, theme)]));
        state = { index: -1, mode: 'welcome', cleanup: [], current: null, windowsGames: '', steamAdded: 0, rerun };

        const logo = h(document, 'img', { src: logoUrl, alt: '' });
        const wave = (cls, d) => svg(document, 'svg', { class: `ob-wave ${cls}`, viewBox: '0 0 2880 170', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, [svg(document, 'path', { d })]);
        const waves = h(document, 'div', { class: 'ob-waves', 'aria-hidden': 'true' }, [
            wave('w3', 'M0 90 C 240 40 480 40 720 90 S 1200 140 1440 90 S 1920 40 2160 90 S 2640 140 2880 90 V170 H0Z'),
            wave('w2', 'M0 100 C 180 60 360 60 540 100 S 900 140 1080 100 S 1440 60 1620 100 S 1980 140 2160 100 S 2520 60 2700 100 S 2880 100 2880 100 V170 H0Z'),
            wave('w1', 'M0 110 C 240 70 480 70 720 110 S 1200 150 1440 110 S 1920 70 2160 110 S 2640 150 2880 110 V170 H0Z')
        ]);
        const preview = buildPreview(document, window, logoUrl);
        const stage = h(document, 'div', { class: 'ob-stage' });
        const nav = h(document, 'div', { class: 'ob-nav' });
        const tabs = h(document, 'div', { class: 'ob-tabs', role: 'tablist', 'aria-label': 'Setup steps' });
        const live = h(document, 'div', { class: 'ob-live', 'aria-live': 'polite', style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);' });
        const skip = h(document, 'button', { type: 'button', class: 'ob-ghost', text: rerun ? 'Close' : 'Skip setup' });
        const panel = h(document, 'div', { class: 'ob-panel' }, [stage, tabs, nav, live]);
        const previewColumn = h(document, 'div', { class: 'ob-preview' }, [preview.element]);
        root = h(document, 'div', { class: 'ob-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sail setup', 'data-mode': 'welcome' }, [
            h(document, 'div', { class: 'ob-backdrop' }),
            waves,
            h(document, 'div', { class: 'ob-top' }, [h(document, 'div', { class: 'ob-brand' }, [logo, 'Sail setup']), skip]),
            h(document, 'div', { class: 'ob-shell' }, [panel, previewColumn])
        ]);
        document.body.append(root);

        function syncAccent() {
            const accent = window.getComputedStyle(document.body).getPropertyValue('--accent');
            root.style.setProperty('--ob-on-accent', onAccentColor(accent));
        }
        function refresh() {
            preview.update(readModel(document));
            window.requestAnimationFrame(syncAccent);
        }
        function change(key, value) { writeSetting(document, key, value); refresh(); }

        // Fit the preview to the space it has.
        const fit = () => {
            const box = previewColumn.getBoundingClientRect();
            const scale = Math.max(0.42, Math.min(1, (box.width - 72) / 760, (box.height - 40) / 470));
            preview.element.style.setProperty('--ob-scale', scale.toFixed(3));
        };
        let observer = null;
        if (typeof window.ResizeObserver === 'function') { observer = new window.ResizeObserver(fit); observer.observe(previewColumn); }
        fit();

        // Gentle parallax on the preview. Skipped when motion is reduced.
        let tiltFrame = 0;
        const onPointer = event => {
            if (bodyClasses.contains('less-animations') || bodyClasses.contains('reduce-motion')) return;
            const box = previewColumn.getBoundingClientRect();
            const x = ((event.clientX - box.left) / box.width - 0.5) * 2, y = ((event.clientY - box.top) / box.height - 0.5) * 2;
            if (tiltFrame) return;
            tiltFrame = window.requestAnimationFrame(() => {
                tiltFrame = 0;
                preview.tilt.style.setProperty('--ry', `${(x * 4).toFixed(2)}deg`);
                preview.tilt.style.setProperty('--rx', `${(-y * 3).toFixed(2)}deg`);
            });
        };
        const onLeave = () => { preview.tilt.style.setProperty('--ry', '0deg'); preview.tilt.style.setProperty('--rx', '0deg'); };
        previewColumn.addEventListener('pointermove', onPointer);
        previewColumn.addEventListener('pointerleave', onLeave);

        // ---- Steps ----
        const steps = {};

        steps.welcome = () => {
            const words = 'Welcome to Sail'.split(' ').flatMap((word, i, all) => { const span = h(document, 'span', { class: 'w', text: word }); span.style.setProperty('--w', String(i)); return i < all.length - 1 ? [span, ' '] : [span]; });
            const primary = h(document, 'button', { type: 'button', class: 'ob-btn is-primary is-large', text: rerun ? 'Start setup' : 'Set up Sail' });
            const later = h(document, 'button', { type: 'button', class: 'ob-btn is-quiet is-large', text: rerun ? 'Never mind' : 'Skip for now' });
            primary.addEventListener('click', () => go(0));
            later.addEventListener('click', () => finish(!rerun));
            const el = h(document, 'section', { class: 'ob-step', 'aria-labelledby': 'obHeading' }, [
                h(document, 'div', { class: 'ob-hero-mark', 'aria-hidden': 'true' }, [h(document, 'img', { src: logoUrl, alt: '' })]),
                h(document, 'h1', { class: 'ob-hero-title', id: 'obHeading' }, words),
                h(document, 'p', { class: 'ob-hero-lede', text: 'Pick a theme and a few defaults, or skip this and start playing. Nothing here is permanent.' }),
                h(document, 'div', { class: 'ob-hero-actions' }, [primary, later]),
                h(document, 'p', { class: 'ob-fine', text: 'Takes about a minute. Everything lives in Settings afterwards.' })
            ]);
            return { el, focus: primary };
        };

        function stepFrame(meta, parts) {
            const children = [
                h(document, 'div', { class: 'ob-eyebrow ob-rise', text: meta.eyebrow }),
                h(document, 'h2', { class: 'ob-title ob-rise', id: 'obHeading', text: meta.title }),
                h(document, 'p', { class: 'ob-lede ob-rise', text: meta.lede }),
                ...parts
            ];
            children.forEach((child, i) => { if (child.classList && !child.classList.contains('ob-rise')) child.classList.add('ob-rise'); child.style.setProperty('--i', String(i)); });
            return h(document, 'section', { class: 'ob-step', 'aria-labelledby': 'obHeading' }, children);
        }
        const block = (label, content, hint) => h(document, 'div', { class: 'ob-block' }, [label ? h(document, 'span', { class: 'ob-label', text: label }) : null, content, hint ? h(document, 'p', { class: 'ob-hint', text: hint }) : null]);

        steps.look = () => {
            const model = readModel(document);
            const grid = h(document, 'div', { class: 'ob-themes', role: 'radiogroup', 'aria-label': 'Theme' });
            const buttons = THEMES.map(theme => {
                const p = palettes[theme.id];
                const swatch = h(document, 'span', { class: 'ob-theme-swatch' }, [h(document, 'i', { class: 'sb' }), h(document, 'i', { class: 'dot' }), h(document, 'i', { class: 'c1' }), h(document, 'i', { class: 'c2' }), h(document, 'i', { class: 'hero' })]);
                swatch.style.setProperty('--sw-bg', p.bg); swatch.style.setProperty('--sw-card', p.card); swatch.style.setProperty('--sw-accent', p.accent); swatch.style.setProperty('--sw-text', p.text);
                const button = h(document, 'button', { type: 'button', class: 'ob-theme', role: 'radio', 'data-value': theme.id, 'aria-label': theme.name }, [swatch, theme.name]);
                button.addEventListener('click', () => { change('theme', theme.id); setRadioState(buttons, theme.id, b => b.dataset.value); });
                grid.append(button);
                return button;
            });
            radioGroup(document, grid, { orientation: 'grid' });
            const known = THEMES.some(theme => theme.id === model.theme);
            setRadioState(buttons, model.theme, b => b.dataset.value);
            if (!known) buttons.forEach(b => { b.tabIndex = 0; });
            // Window transparency only applies while glass effects are on.
            const transparency = h(document, 'div', { class: 'ob-collapse', 'data-open': model.glass ? 'true' : 'false' });
            const glass = switchRow(document, { title: 'Glass effects', sub: 'Frosted panels. Turn this off for flat surfaces that are a little lighter on your GPU.', checked: model.glass, onChange: value => { transparency.dataset.open = value ? 'true' : 'false'; change('glass', value); } });
            const seeThrough = switchRow(document, { title: 'See-through window', sub: 'Lets your desktop show through the launcher. Off gives a solid window.', checked: model.translucent, onChange: value => { slider.disabled = !value; slider.parentElement.dataset.off = value ? 'false' : 'true'; change('translucent', value); } });
            const readout = h(document, 'output', { text: `${100 - model.glassOpacity}%` });
            const slider = h(document, 'input', { type: 'range', class: 'ob-range', min: '10', max: '95', step: '5', value: String(100 - model.glassOpacity), 'aria-label': 'Window transparency', disabled: !model.translucent });
            // Settings stores how opaque the window is; this shows how transparent it is.
            slider.addEventListener('input', () => { readout.textContent = `${slider.value}%`; writeSetting(document, 'glassOpacity', 100 - Number(slider.value)); preview.update(readModel(document)); });
            const sliderRow = h(document, 'div', { class: 'ob-speed', 'data-off': model.translucent ? 'false' : 'true' }, [slider, readout]);
            transparency.append(h(document, 'div', {}, [seeThrough.element, h(document, 'div', { class: 'ob-row' }, [h(document, 'div', { class: 'ob-row-text' }, [h(document, 'div', { class: 'ob-row-title', text: 'Transparency' }), h(document, 'div', { class: 'ob-row-sub', text: 'Lower is more solid. Higher shows more of your desktop.' }), sliderRow])])]));
            const icons = segmented(document, { label: 'Icon style', options: [{ value: 'line', label: 'Line icons' }, { value: 'emoji', label: 'Emoji' }], value: model.emojiIcons ? 'emoji' : 'line', onChange: value => change('emojiIcons', value === 'emoji') });
            const el = stepFrame(SETUP_STEPS[0], [block('Theme', grid), block('', h(document, 'div', {}, [glass.element, transparency])), block('Icons', icons.element, 'Line icons follow the theme colours. Emoji is the classic look.')]);
            return { el, focus: buttons.find(b => b.tabIndex === 0) || buttons[0] };
        };

        steps.library = () => {
            const model = readModel(document);
            const style = pickGroup(document, {
                label: 'Card layout', value: model.cardStyle, onChange: value => { applyCardStyle(document, value); refresh(); },
                options: [
                    { value: 'wide', label: 'Wide', sub: 'Cover and title', art: [[26, 15], [26, 15]] },
                    { value: 'poster', label: 'Poster', sub: 'Tall covers', art: [[15, 28], [15, 28], [15, 28]] },
                    { value: 'cover', label: 'Full cover', sub: 'Art behind the title', art: [[24, 22], [24, 22]] }
                ]
            });
            const size = segmented(document, { label: 'Card size', options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }], value: model.tileSize, onChange: value => change('tileSize', value) });
            const corners = segmented(document, { label: 'Corners', options: [{ value: 'default', label: 'Rounded' }, { value: 'square', label: 'Square' }, { value: 'squircle', label: 'Squircle' }], value: model.tileShape, onChange: value => change('tileShape', value) });
            const chips = h(document, 'div', { class: 'ob-chips', role: 'group', 'aria-label': 'Sidebar pages' }, SIDEBAR_PAGES.map(page => {
                const chip = h(document, 'button', { type: 'button', class: 'ob-chip', role: 'checkbox', 'aria-checked': model.pages[page.key] ? 'true' : 'false', text: page.label });
                chip.addEventListener('click', () => { const next = chip.getAttribute('aria-checked') !== 'true'; chip.setAttribute('aria-checked', next ? 'true' : 'false'); change(page.key, next); });
                return chip;
            }));
            const banner = switchRow(document, { title: 'Continue Playing banner', sub: 'A large shortcut to what you played last.', checked: model.continuePlaying, onChange: value => change('continuePlaying', value) });
            const favorites = switchRow(document, { title: 'Favorites first', sub: 'Starred games stay at the top of the library.', checked: model.favoritesFirst, onChange: value => change('favoritesFirst', value) });
            const el = stepFrame(SETUP_STEPS[1], [block('Card layout', style.element), block('Size', size.element), block('Corners', corners.element), block('Pages in the sidebar', chips, 'Hide what you will not use. Each one can come back in Settings.'), h(document, 'div', { class: 'ob-block' }, [banner.element, favorites.element])]);
            return { el, focus: el.querySelector('.ob-pick[aria-checked="true"]') || el.querySelector('.ob-pick') };
        };

        steps.feel = () => {
            const model = readModel(document);
            const card = (mode, title, sub) => {
                const dot = h(document, 'span', { class: 'ob-motion-dot' });
                const button = h(document, 'button', { type: 'button', class: 'ob-motion-card', role: 'radio', 'data-mode': mode, 'data-value': mode }, [h(document, 'span', { class: 'ob-motion-stage', 'aria-hidden': 'true' }, [dot]), h(document, 'div', { class: 'ob-pick-name', text: title }), h(document, 'div', { class: 'ob-pick-sub', text: sub })]);
                return button;
            };
            const full = card('full', 'Full', 'Page slides, hover lifts and background motion.');
            const calm = card('calm', 'Calm', 'Short transitions only.');
            const group = h(document, 'div', { class: 'ob-motion', role: 'radiogroup', 'aria-label': 'Motion' }, [full, calm]);
            const cards = [full, calm];
            const sync = () => setRadioState(cards, readSetting(document, 'lessAnimations') ? 'calm' : 'full', b => b.dataset.value);
            full.addEventListener('click', () => { change('lessAnimations', false); sync(); preview.replay(); });
            calm.addEventListener('click', () => { change('lessAnimations', true); sync(); preview.replay(); });
            radioGroup(document, group);
            sync();
            const slider = h(document, 'input', { type: 'range', class: 'ob-range', min: '0.5', max: '2', step: '0.1', value: String(model.animationSpeed), 'aria-label': 'Animation speed' });
            const readout = h(document, 'output', { text: `${model.animationSpeed.toFixed(1)}×` });
            slider.addEventListener('input', () => { readout.textContent = `${Number(slider.value).toFixed(1)}×`; writeSetting(document, 'animationSpeed', slider.value); });
            slider.addEventListener('change', () => { refresh(); preview.replay(); });
            const speed = h(document, 'div', { class: 'ob-speed' }, [slider, readout]);
            const rows = h(document, 'div', { class: 'ob-block' });
            if (features.autostart && features.autostart.available && control(document, 'autostart')) {
                rows.append(switchRow(document, { title: 'Start Sail when I log in', sub: 'Opens the launcher with your desktop.', checked: !!readSetting(document, 'autostart'), onChange: value => { change('autostart', value); if (value) preview.demo('autostart'); } }).element);
            }
            if (features.discord && features.discord.available) {
                rows.append(switchRow(document, { title: 'Show what I am playing on Discord', sub: 'Needs the Discord app to be running.', checked: readSetting(document, 'discord') !== false, onChange: value => { change('discord', value); if (value) preview.demo('discord'); } }).element);
            }
            rows.append(switchRow(document, { title: 'Achievement popups', sub: 'A small notice when you unlock something.', checked: readSetting(document, 'achievementPopups') !== false, onChange: value => { change('achievementPopups', value); if (value) preview.demo('achievement'); } }).element);
            const el = stepFrame(SETUP_STEPS[2], [block('Animations', group), block('Speed', speed, 'Slower is 0.5×, faster is 2×. Settings has the same slider.'), rows]);
            return { el, focus: full.getAttribute('aria-checked') === 'true' ? full : calm };
        };

        steps.games = () => {
            const el = stepFrame(SETUP_STEPS[3], []);
            const cleanup = [];
            const note = text => el.append(h(document, 'p', { class: 'ob-hint ob-rise', text }));

            // Windows games
            const canSetup = features.protonSetup && features.protonSetup.available;
            const winState = h(document, 'div', { class: 'ob-card-state', text: canSetup ? 'Checking…' : (features.protonSetup && features.protonSetup.reason) || 'Not available on this system.' });
            const winButton = h(document, 'button', { type: 'button', class: 'ob-btn is-primary', text: 'Set up Windows games', hidden: true });
            const winBar = h(document, 'div', { class: 'ob-bar', hidden: true }, [h(document, 'i')]);
            const winCard = h(document, 'div', { class: 'ob-card ob-rise' }, [
                h(document, 'div', { class: 'ob-card-head' }, [h(document, 'span', { class: 'ob-card-icon' }, [iconSvg(document, ICON_PATHS.windows)]), h(document, 'div', {}, [h(document, 'div', { class: 'ob-card-title', text: 'Windows games' }), winState])]),
                winBar,
                h(document, 'div', { class: 'ob-card-actions' }, [winButton])
            ]);
            let polling = null, alive = true;
            cleanup.push(() => { alive = false; clearTimeout(polling); });
            const phases = { checking: 'Checking', starting: 'Starting', downloading: 'Downloading', extracting: 'Extracting', installing: 'Installing' };
            const mb = value => `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
            async function refreshWindows() {
                if (!canSetup || !alive) return;
                let data;
                try { data = await call('compatibility-status', {}); } catch (error) { winState.textContent = String(error && error.message || 'Could not check the setup.'); winState.dataset.tone = 'bad'; return; }
                if (!alive) return;
                const job = data.job, active = !!job && !['completed', 'failed', 'canceled'].includes(job.phase), setup = data.setup;
                winBar.hidden = !active;
                if (active) {
                    const determinate = job.phase === 'downloading' && job.total > 0;
                    winBar.classList.toggle('is-indeterminate', !determinate);
                    winBar.firstChild.style.setProperty('--p', determinate ? String(Math.min(1, job.received / job.total)) : '1');
                    winState.textContent = `${phases[job.phase] || job.phase} ${job.currentTag || job.tag || ''}${determinate ? ` · ${mb(job.received)} of ${mb(job.total)}` : '…'}`.trim();
                    winState.dataset.tone = '';
                    winButton.hidden = true;
                    polling = setTimeout(refreshWindows, 1000);
                    return;
                }
                if (setup && setup.toolsReady) {
                    state.windowsGames = 'ready';
                    winState.textContent = 'Ready. Sail can run Windows games.'; winState.dataset.tone = 'good'; winButton.hidden = true;
                } else if (job && job.phase === 'failed') {
                    winState.textContent = job.error || 'Setup did not finish.'; winState.dataset.tone = 'bad';
                    winButton.hidden = false; winButton.disabled = false; winButton.textContent = 'Try again';
                } else {
                    winState.textContent = (setup && setup.summary) || data.reason || 'Not set up yet.'; winState.dataset.tone = '';
                    winButton.hidden = false; winButton.disabled = !(data.available && setup && setup.canSetUp); winButton.textContent = 'Set up Windows games';
                }
            }
            winButton.addEventListener('click', async () => {
                winButton.disabled = true; winState.textContent = 'Starting…'; winState.dataset.tone = '';
                try { await call('compatibility-setup', {}); } catch (error) { winState.textContent = String(error && error.message || 'Setup could not start.'); winState.dataset.tone = 'bad'; winButton.disabled = false; return; }
                refreshWindows();
            });
            el.append(winCard);
            refreshWindows();

            // Steam library
            if (features.steamDiscovery && features.steamDiscovery.available) {
                const steamState = h(document, 'div', { class: 'ob-card-state', text: 'Finds installed games in your Steam libraries and adds them here.' });
                const steamButton = h(document, 'button', { type: 'button', class: 'ob-btn is-quiet', text: 'Look for Steam games' });
                steamButton.addEventListener('click', async () => {
                    steamButton.disabled = true; steamState.textContent = 'Looking…'; steamState.dataset.tone = '';
                    try {
                        const result = await ipc.invoke('import-steam-games');
                        const added = Number(result && result.importedCount) || 0;
                        if (added && typeof hooks.libraryChanged === 'function') hooks.libraryChanged(result);
                        state.steamAdded += added;
                        if (!result || !result.dataRootsFound) { steamState.textContent = 'Steam was not found on this computer.'; }
                        else if (!result.scannedCount) { steamState.textContent = 'No installed Steam games were found.'; }
                        else if (!added) { steamState.textContent = 'Your Steam games are already in the library.'; steamState.dataset.tone = 'good'; }
                        else { steamState.textContent = `Added ${added} game${added === 1 ? '' : 's'} from Steam.`; steamState.dataset.tone = 'good'; }
                    } catch (error) { steamState.textContent = 'The scan did not finish. You can try again from the Library page.'; steamState.dataset.tone = 'bad'; }
                    steamButton.disabled = false;
                });
                el.append(h(document, 'div', { class: 'ob-card ob-rise' }, [
                    h(document, 'div', { class: 'ob-card-head' }, [h(document, 'span', { class: 'ob-card-icon' }, [iconSvg(document, ICON_PATHS.library)]), h(document, 'div', {}, [h(document, 'div', { class: 'ob-card-title', text: 'Steam library' }), steamState])]),
                    h(document, 'div', { class: 'ob-card-actions' }, [steamButton])
                ]));
            }
            note('You can skip both. Windows games can be set up later from Settings, and games can be added from the Library page.');
            Array.from(el.children).forEach((child, i) => child.style.setProperty('--i', String(i)));
            return { el, focus: winButton.hidden ? el.querySelector('button') : winButton, cleanup: () => cleanup.forEach(fn => fn()) };
        };

        steps.done = () => {
            const check = svg(document, 'svg', { class: 'ob-check', viewBox: '0 0 84 84', 'aria-hidden': 'true' }, [svg(document, 'circle', { cx: 42, cy: 42, r: 40 }), svg(document, 'path', { d: 'M26 43l12 12 21-24' })]);
            const sparks = h(document, 'div', { class: 'ob-sparks', 'aria-hidden': 'true' });
            for (let i = 0; i < 16; i += 1) {
                const angle = (i / 16) * Math.PI * 2 + (i % 2 ? 0.2 : 0), distance = 90 + (i % 4) * 26;
                const spark = h(document, 'i'); spark.style.setProperty('--x', `${Math.round(Math.cos(angle) * distance)}px`); spark.style.setProperty('--y', `${Math.round(Math.sin(angle) * distance)}px`);
                spark.style.setProperty('--r', `${(i * 47) % 360}deg`); spark.style.setProperty('--d', String(i * 18)); sparks.append(spark);
            }
            const chips = describeChoices(readModel(document), { windowsGames: state.windowsGames, steamAdded: state.steamAdded }).map((text, i) => { const chip = h(document, 'span', { text }); chip.style.setProperty('--i', String(i)); return chip; });
            const open = h(document, 'button', { type: 'button', class: 'ob-btn is-primary is-large', text: rerun ? 'Done' : 'Open Sail' });
            const add = h(document, 'button', { type: 'button', class: 'ob-btn is-quiet is-large', text: 'Add a game' });
            open.addEventListener('click', () => finish(false));
            add.addEventListener('click', () => finish(false, () => { if (typeof hooks.addGame === 'function') hooks.addGame(); }));
            const el = h(document, 'section', { class: 'ob-step', 'aria-labelledby': 'obHeading' }, [
                sparks, check,
                h(document, 'h1', { class: 'ob-hero-title', id: 'obHeading', text: 'You are all set' }),
                h(document, 'p', { class: 'ob-hero-lede', text: 'This is what you picked. All of it can be changed in Settings, and you can run this setup again from Settings, under Appearance.' }),
                h(document, 'div', { class: 'ob-summary' }, chips),
                h(document, 'div', { class: 'ob-hero-actions' }, [open, add])
            ]);
            return { el, focus: open };
        };

        // ---- Navigation ----
        const order = ['welcome', 'look', 'library', 'feel', 'games', 'done'];
        function renderChrome(stepId) {
            const setupIndex = SETUP_STEPS.findIndex(step => step.id === stepId);
            const mode = stepId === 'welcome' ? 'welcome' : stepId === 'done' ? 'done' : 'split';
            root.dataset.mode = mode;
            tabs.replaceChildren(); nav.replaceChildren();
            tabs.hidden = mode !== 'split'; nav.hidden = mode !== 'split';
            if (mode !== 'split') return;
            SETUP_STEPS.forEach((step, i) => {
                const tab = h(document, 'button', { type: 'button', class: `ob-tab${i < setupIndex ? ' is-done' : ''}${i === setupIndex ? ' is-current' : ''}`, role: 'tab', 'aria-selected': i === setupIndex ? 'true' : 'false', text: step.tab });
                tab.addEventListener('click', () => go(i));
                tabs.append(tab);
            });
            const back = h(document, 'button', { type: 'button', class: 'ob-btn is-quiet', text: setupIndex === 0 ? 'Welcome' : 'Back' });
            const next = h(document, 'button', { type: 'button', class: 'ob-btn is-primary', text: setupIndex === SETUP_STEPS.length - 1 ? 'Finish' : 'Next' });
            back.addEventListener('click', () => (setupIndex === 0 ? goStep('welcome', -1) : go(setupIndex - 1)));
            next.addEventListener('click', () => (setupIndex === SETUP_STEPS.length - 1 ? goStep('done', 1) : go(setupIndex + 1)));
            nav.append(back, h(document, 'span', { class: 'ob-spacer' }), h(document, 'span', { class: 'ob-hint', style: 'margin:0 8px 0 0;', text: 'Esc goes back' }), next);
        }
        function goStep(stepId, direction) {
            const nextIndex = order.indexOf(stepId);
            if (nextIndex < 0 || !root || root.classList.contains('is-leaving') || nextIndex === state.index) return;
            const incoming = steps[stepId]();
            const previous = state.current;
            incoming.el.classList.add('ob-step', 'is-in');
            incoming.el.dataset.dir = direction < 0 ? 'back' : 'fwd';
            stage.append(incoming.el);
            if (previous) {
                previous.el.classList.remove('is-in'); previous.el.classList.add('is-out');
                previous.el.dataset.dir = direction < 0 ? 'back' : 'fwd';
                previous.el.setAttribute('aria-hidden', 'true');
                if (previous.cleanup) previous.cleanup();
                setTimeout(() => previous.el.remove(), 360);
            }
            state.current = incoming; state.index = nextIndex;
            renderChrome(stepId);
            refresh();
            const meta = SETUP_STEPS.find(step => step.id === stepId);
            live.textContent = meta ? `Step ${SETUP_STEPS.indexOf(meta) + 1} of ${SETUP_STEPS.length}: ${meta.title}` : '';
            window.requestAnimationFrame(() => { if (incoming.focus && typeof incoming.focus.focus === 'function') incoming.focus.focus({ preventScroll: true }); });
        }
        const go = setupIndex => goStep(SETUP_STEPS[Math.max(0, Math.min(SETUP_STEPS.length - 1, setupIndex))].id, setupIndex >= Math.max(0, state.index - 1) ? 1 : -1);

        async function finish(skipped, after) {
            if (!root || root.classList.contains('is-leaving')) return;
            const closing = root;
            if (!state.rerun) { try { await ipc.invoke('onboarding-finish', { skipped }); } catch (_) { /* It will simply be offered again next time. */ } }
            if (state.current && state.current.cleanup) state.current.cleanup();
            closing.classList.add('is-leaving');
            document.removeEventListener('keydown', onKey, true);
            if (observer) observer.disconnect();
            window.cancelAnimationFrame(tiltFrame);
            setTimeout(() => {
                closing.remove();
                root = null; state = null;
                bodyClasses.remove('onboarding-open');
                if (appContainer) appContainer.inert = false;
                if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
                if (typeof hooks.closed === 'function') hooks.closed();
                if (typeof after === 'function') after();
            }, 400);
        }

        function onKey(event) {
            if (!root) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                const id = order[state.index];
                if (id === 'welcome') finish(!state.rerun);
                else if (id === 'done') goStep('games', -1);
                else if (id === 'look') goStep('welcome', -1);
                else go(SETUP_STEPS.findIndex(step => step.id === id) - 1);
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(root.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), [tabindex="0"]'))
                .filter(node => !node.closest('[aria-hidden="true"]') && node.offsetParent !== null);
            if (!focusable.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (!root.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
            else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
        document.addEventListener('keydown', onKey, true);
        skip.addEventListener('click', () => finish(!state.rerun));

        goStep('welcome', 1);
    }

    return { open, maybeOpen, isOpen };
}

module.exports = {
    CONTROLS, SETUP_STEPS, SIDEBAR_PAGES, THEMES,
    applyCardStyle, cardStyleOf, describeChoices, installOnboarding, onAccentColor, parseHex, readModel, readSetting, readThemePalette, writeSetting
};
