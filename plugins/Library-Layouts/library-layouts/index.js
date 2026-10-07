// Library Layouts for Sail Launcher
// Re-arranges the launcher like other popular clients. Everything it changes is put back when it is switched off.

module.exports = function (SailAPI) {
    const fs = require('fs');
    const path = require('path');
    const { ipcRenderer } = require('electron');

    if (!SailAPI || !(SailAPI.apiVersion >= 2)) {
        console.warn('[Library Layouts] This version of Sail is too old for layout plugins. Update Sail to use it.');
        return { dispose() {} };
    }

    const STORAGE_KEY = 'sail-library-layouts';
    const DEFAULTS = { layout: 'steam', colors: true, portrait: true, friends: false };
    const LAYOUTS = [{ id: 'steam', label: 'Steam-style' }, { id: 'off', label: 'Off (Sail default)' }];
    const settings = (() => {
        try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; } catch (_) { return { ...DEFAULTS }; }
    })();
    const saveSettings = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) { /* Settings simply do not persist. */ } };

    const html = document.documentElement;
    const body = document.body;
    let entryHandle = null;
    const entryRef = () => entryHandle;

    function el(tag, props = {}, children = []) {
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
    const svg = (paths, size = 16) => {
        const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('width', size); node.setAttribute('height', size);
        node.setAttribute('fill', 'none'); node.setAttribute('stroke', 'currentColor'); node.setAttribute('stroke-width', '2');
        node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round'); node.setAttribute('aria-hidden', 'true');
        for (const d of paths) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); node.append(p); }
        return node;
    };
    const frame = fn => { let queued = 0; return () => { if (queued) return; queued = requestAnimationFrame(() => { queued = 0; fn(); }); }; };

    // ---- The Steam-style layout -------------------------------------------------------------
    function steamLayout() {
        const undo = [];
        const classes = () => ['sl-steam', settings.colors && 'sl-colors', settings.portrait && 'sl-portrait', settings.friends && 'sl-friends'].filter(Boolean);
        const everyClass = ['sl-steam', 'sl-colors', 'sl-portrait', 'sl-friends'];

        // The launcher rebuilds the body's class list when the theme changes, so keep ours on, and keep glass off.
        let hadGlass = body.classList.contains('glassmorphic-mode');
        const guard = new MutationObserver(() => ensureClasses());
        function ensureClasses() {
            const wanted = classes();
            let changed = false;
            for (const name of everyClass) {
                const want = wanted.includes(name);
                if (body.classList.contains(name) !== want) { body.classList.toggle(name, want); changed = true; }
            }
            if (body.classList.contains('glassmorphic-mode')) { hadGlass = true; body.classList.remove('glassmorphic-mode'); changed = true; }
            return changed;
        }

        function mount() {
            // Stylesheet
            const css = fs.readFileSync(path.join(__dirname, 'layouts', 'steam.css'), 'utf8');
            const style = el('style', { id: 'sl-steam-style' });
            style.textContent = css;
            document.head.append(style);
            undo.push(() => style.remove());

            ensureClasses();
            guard.observe(body, { attributes: true, attributeFilter: ['class'] });
            undo.push(() => {
                guard.disconnect();
                for (const name of everyClass) body.classList.remove(name);
                const glassSwitch = document.getElementById('legacyUiToggle');
                const glassOn = glassSwitch ? !glassSwitch.checked : hadGlass;
                if (glassOn) body.classList.add('glassmorphic-mode');
            });

            // The brand becomes a menu holding every Sail button, like the first menu in Steam.
            const menu = buildMenu();
            undo.push(() => menu.destroy());

            // Page tabs move up into the title bar, and fold into a "..." menu when there is not room.
            const nav = document.getElementById('sidebarNavHeader');
            const titleBar = document.querySelector('.titlebar-title');
            const brand = titleBar && titleBar.querySelector('.tb-brand');
            let tabs = null;
            if (nav && titleBar && brand) {
                const marker = document.createComment('sl-nav-home');
                nav.parentNode.insertBefore(marker, nav);
                brand.after(nav);
                nav.classList.add('sl-top-nav');
                undo.push(() => { nav.classList.remove('sl-top-nav'); if (marker.parentNode) { marker.parentNode.insertBefore(nav, marker); marker.remove(); } });
                tabs = buildTabFit(nav, titleBar);
                undo.push(() => tabs.destroy());
            }

            // Game list in the left panel.
            const sidebar = document.getElementById('mainSidebar');
            const panel = buildGameList();
            sidebar.append(panel.element);
            undo.push(() => { panel.destroy(); panel.element.remove(); });

            // Game page extras.
            const stats = buildStats();
            undo.push(() => stats.destroy());

            // Bottom bar and the home page's shelf and header.
            const bottom = buildBottomBar();
            undo.push(() => bottom.destroy());
            const home = buildHome();
            undo.push(() => home.destroy());

            // Tall covers on the home grid.
            const covers = coverSwapper();
            undo.push(() => covers.destroy());

            const refresh = frame(() => { panel.render(); stats.update(); covers.apply(); home.update(); bottom.update(); if (tabs) tabs.fit(); });
            // The launcher swaps views a moment after it announces a move, so look again once that has finished.
            let settle = 0;
            const afterNavigate = () => { refresh(); clearTimeout(settle); settle = setTimeout(refresh, 220); };
            undo.push(() => clearTimeout(settle));
            undo.push(SailAPI.onLibraryChange(refresh));
            undo.push(SailAPI.onNavigate(afterNavigate));
            refresh();
        }
        function unmount() { while (undo.length) { try { undo.pop()(); } catch (e) { console.error('[Library Layouts]', e); } } }
        return { mount, unmount, ensureClasses };
    }

    function buildGameList() {
        const search = el('input', { class: 'sl-search', type: 'text', placeholder: 'Search', 'aria-label': 'Search games', spellcheck: 'false' });
        const home = el('button', { type: 'button', class: 'sl-home' }, [svg(['M3 11l9-8 9 8', 'M5 10v10h5v-6h4v6h5V10'], 15), 'Home']);
        home.addEventListener('click', () => SailAPI.showTab('library'));
        const view = el('button', { type: 'button', class: 'sl-viewtoggle', title: 'Switch between cover grid and list', 'aria-label': 'Switch between cover grid and list' }, [svg(['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'], 14)]);
        view.addEventListener('click', () => { const toggle = document.getElementById('viewToggleBtn'); if (toggle) toggle.click(); });
        const filter = el('select', { class: 'sl-filter', 'aria-label': 'Show in the list' }, [['all', 'All games'], ['favorites', 'Favorites'], ['recent', 'Recently played'], ['never', 'Never played']].map(([value, label]) => el('option', { value, text: label })));
        filter.addEventListener('change', () => render());
        const list = el('div', { class: 'sl-list', role: 'list' });
        const collapsed = new Set();
        const element = el('div', { class: 'sl-panel' }, [el('div', { class: 'sl-panel-top' }, [el('div', { class: 'sl-home-row' }, [home, view]), filter, el('div', { class: 'sl-search-wrap' }, [svg(['M21 21l-4.3-4.3', 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z'], 13), search])]), list]);
        // Typing here also narrows the cover grid on the home page, as in Steam.
        search.addEventListener('input', () => {
            const grid = document.getElementById('searchInput');
            if (grid && grid.value !== search.value) { grid.value = search.value; grid.dispatchEvent(new Event('input', { bubbles: true })); }
            render();
        });

        function row(game, activeId) {
            const cover = SailAPI.getCover(game.id, 'header');
            const letter = () => el('span', { class: 'sl-thumb sl-thumb-letter', text: (game.name || '?').trim().charAt(0).toUpperCase() });
            const thumb = cover ? el('img', { class: 'sl-thumb', src: cover, alt: '', loading: 'lazy' }) : letter();
            if (cover) thumb.addEventListener('error', () => thumb.replaceWith(letter()), { once: true });
            const item = el('button', { type: 'button', class: `sl-row${game.id === activeId ? ' is-active' : ''}${game.isRunning ? ' is-running' : ''}`, role: 'listitem', 'data-id': game.id, title: game.name }, [thumb, el('span', { class: 'sl-name', text: game.name }), game.isRunning ? el('span', { class: 'sl-state', text: 'Running' }) : null]);
            item.addEventListener('click', () => SailAPI.openGame(game.id));
            item.addEventListener('contextmenu', event => { event.preventDefault(); ipcRenderer.send('show-game-context', game.index); });
            return item;
        }
        function group(title, games, activeId) {
            if (!games.length) return [];
            const key = title.toLowerCase();
            const closed = collapsed.has(key);
            const head = el('button', { type: 'button', class: `sl-group${closed ? ' is-closed' : ''}`, 'aria-expanded': closed ? 'false' : 'true' }, [el('span', { class: 'sl-dash', text: closed ? '+' : '—' }), el('span', { text: title.toUpperCase() }), el('span', { class: 'sl-count', text: `(${games.length})` })]);
            head.addEventListener('click', () => { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); render(); });
            return [head, ...(closed ? [] : games.map(game => row(game, activeId)))];
        }
        function render() {
            const query = search.value.trim().toLowerCase();
            const activeId = SailAPI.getActiveGameId();
            const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            const all = SailAPI.getGames().filter(game => !query || game.name.toLowerCase().includes(query)).sort(byName);
            let nodes;
            if (filter.value === 'favorites') nodes = group('Favorites', all.filter(game => game.isFavorite), activeId);
            else if (filter.value === 'recent') nodes = group('Recently played', all.filter(game => game.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed), activeId);
            else if (filter.value === 'never') nodes = group('Never played', all.filter(game => !game.playtime && !game.lastPlayed), activeId);
            else nodes = [...group('Favorites', all.filter(game => game.isFavorite), activeId), ...group('Games', all.filter(game => !game.isFavorite), activeId)];
            const scroll = list.scrollTop;
            list.replaceChildren(...(nodes.length ? nodes : [el('div', { class: 'sl-empty', text: query ? 'No games match.' : 'Nothing here yet.' })]));
            list.scrollTop = scroll;
            const library = document.getElementById('libraryView');
            home.classList.toggle('is-active', !activeId && !!library && library.getClientRects().length > 0);
            // Follow the grid's own search box when something else clears it.
            const grid = document.getElementById('searchInput');
            if (grid && document.activeElement !== search && grid.value !== search.value) search.value = grid.value;
        }
        return { element, render, destroy() {} };
    }

    // The brand becomes the first menu: every Sail button in one place, grouped the way Steam groups its menus.
    function buildMenu() {
        const brand = document.querySelector('.tb-brand');
        const button = el('button', { type: 'button', class: 'sl-menu-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, ['Sail', svg(['M6 9l6 6 6-6'], 11)]);
        brand.append(button);
        const menu = el('div', { class: 'sl-menu', role: 'menu', hidden: true });
        document.body.append(menu);
        const GROUPS = [
            [['settings', 'Settings'], ['plugins', 'Plugins'], ['layouts', 'Library Layouts…']],
            [['addGame', 'Add a Game…'], ['selectMode', 'Select Games'], ['surpriseMe', 'Surprise Me']],
            [['bigPicture', 'Big Picture Mode'], ['stats', 'Statistics'], ['systemSpecs', 'System Specs'], ['sailHub', 'Sail Hub']],
            [['exit', 'Exit']]
        ];
        const findButton = id => id === 'exit' ? document.getElementById('closeBtn') : Array.from(document.querySelectorAll(`[data-btn-id="${id}"]`)).find(node => !node.closest('.sl-menu'));
        function close() { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); }
        function open() {
            const items = [];
            GROUPS.forEach((group, index) => {
                const rows = group.filter(([id]) => id === 'layouts' || findButton(id));
                if (!rows.length) return;
                if (items.length) items.push(el('div', { class: 'sl-menu-sep', role: 'separator' }));
                for (const [id, label] of rows) {
                    const item = el('button', { type: 'button', class: 'sl-menu-item', role: 'menuitem', text: label });
                    item.addEventListener('click', () => {
                        close();
                        if (id === 'layouts') { const current = entryRef(); if (current) current.open(); return; }
                        const target = findButton(id);
                        if (target) target.click();
                    });
                    items.push(item);
                }
            });
            menu.replaceChildren(...items);
            const box = button.getBoundingClientRect();
            menu.style.left = `${Math.max(4, box.left)}px`;
            menu.style.top = `${box.bottom + 2}px`;
            menu.hidden = false;
            button.setAttribute('aria-expanded', 'true');
        }
        button.addEventListener('click', event => { event.stopPropagation(); if (menu.hidden) open(); else close(); });
        const onDocument = event => { if (!menu.hidden && !menu.contains(event.target)) close(); };
        const onKey = event => {
            if (menu.hidden) return;
            if (event.key === 'Escape') { close(); button.focus(); return; }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const rows = Array.from(menu.querySelectorAll('.sl-menu-item'));
            const at = rows.indexOf(document.activeElement);
            event.preventDefault();
            rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
        };
        document.addEventListener('click', onDocument);
        document.addEventListener('keydown', onKey, true);
        return { destroy() { document.removeEventListener('click', onDocument); document.removeEventListener('keydown', onKey, true); menu.remove(); button.remove(); } };
    }

    // Keeps the page tabs on one line: the ones that do not fit move into a "..." menu.
    function buildTabFit(nav, titleBar) {
        const more = el('button', { type: 'button', class: 'sl-more', title: 'More', 'aria-label': 'More pages', 'aria-haspopup': 'menu', hidden: true }, [svg(['M5 12h.01', 'M12 12h.01', 'M19 12h.01'], 16)]);
        const menu = el('div', { class: 'sl-menu', role: 'menu', hidden: true });
        nav.append(more);
        document.body.append(menu);
        let hidden = [];
        function fit() {
            menu.hidden = true;
            const tabs = Array.from(nav.querySelectorAll('.sidebar-page-link'));
            tabs.forEach(tab => tab.classList.remove('sl-tab-off'));
            more.hidden = true;
            hidden = [];
            const shown = tabs.filter(tab => getComputedStyle(tab).display !== 'none');
            const over = () => nav.scrollWidth > nav.clientWidth + 1;
            if (!over()) return;
            more.hidden = false;
            for (let i = shown.length - 1; i >= 0 && over(); i--) {
                if (shown[i].classList.contains('active-tab')) continue;
                shown[i].classList.add('sl-tab-off');
                hidden.unshift(shown[i]);
            }
        }
        more.addEventListener('click', event => {
            event.stopPropagation();
            if (!menu.hidden) { menu.hidden = true; return; }
            menu.replaceChildren(...hidden.map(tab => {
                const item = el('button', { type: 'button', class: 'sl-menu-item', role: 'menuitem', text: (tab.querySelector('.sidebar-page-label') || tab).textContent.trim() });
                item.addEventListener('click', () => { menu.hidden = true; tab.click(); });
                return item;
            }));
            const box = more.getBoundingClientRect();
            menu.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - 220))}px`;
            menu.style.top = `${box.bottom + 2}px`;
            menu.hidden = false;
        });
        const onDocument = event => { if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true; };
        document.addEventListener('click', onDocument);
        const refit = frame(fit);
        const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null;
        if (resize) resize.observe(titleBar);
        // Other plugins add widgets to the title bar; make room again when they do.
        const watch = new MutationObserver(refit);
        watch.observe(titleBar, { childList: true });
        window.addEventListener('resize', refit);
        refit();
        return { fit: refit, destroy() { document.removeEventListener('click', onDocument); window.removeEventListener('resize', refit); watch.disconnect(); if (resize) resize.disconnect(); nav.querySelectorAll('.sl-tab-off').forEach(tab => tab.classList.remove('sl-tab-off')); more.remove(); menu.remove(); } };
    }

    // The strip along the bottom: add a game, downloads, friends.
    function buildBottomBar() {
        const add = el('button', { type: 'button', class: 'sl-bottom-btn' }, [svg(['M12 5v14', 'M5 12h14'], 14), 'Add a Game']);
        add.addEventListener('click', () => { const target = document.getElementById('addGameBtn'); if (target) target.click(); });
        const downloadText = el('span', { text: 'Downloads' });
        const downloads = el('button', { type: 'button', class: 'sl-bottom-btn' }, [svg(['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'], 14), downloadText]);
        downloads.addEventListener('click', () => SailAPI.showTab('downloadmanager'));
        const friends = el('button', { type: 'button', class: 'sl-bottom-btn' }, ['Friends & Chat', svg(['M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'], 14)]);
        friends.addEventListener('click', () => {
            settings.friends = !settings.friends;
            saveSettings();
            const current = controller.current();
            if (current) current.ensureClasses();
            const box = document.getElementById('sl-opt-friends');
            if (box) box.checked = settings.friends;
        });
        const bar = el('div', { class: 'sl-bottom' }, [add, el('span', { class: 'sl-spacer' }), downloads, el('span', { class: 'sl-spacer' }), friends]);
        document.querySelector('.app-container').after(bar);
        function update() {
            const { active, total } = SailAPI.getDownloadSummary ? SailAPI.getDownloadSummary() : { active: 0, total: 0 };
            downloadText.textContent = !total ? 'Downloads' : active ? `Downloads - ${active} of ${total} item${total === 1 ? '' : 's'} active` : `Downloads - ${total} of ${total} item${total === 1 ? '' : 's'} complete`;
        }
        update();
        const timer = setInterval(update, 1500);
        return { update, destroy() { clearInterval(timer); bar.remove(); } };
    }

    // Recent games shelf and the "All Games" header on the home page.
    function buildHome() {
        const view = document.getElementById('libraryView');
        const grid = document.getElementById('gameGrid');
        const toolbar = view && view.querySelector('.toolbar');
        if (!view || !grid) return { update() {}, destroy() {} };
        const shelf = el('section', { class: 'sl-shelf', hidden: true, 'aria-label': 'Recent games' });
        grid.before(shelf);
        const title = el('h2', { class: 'sl-all-title' });
        if (toolbar) toolbar.prepend(title);
        const when = ms => {
            const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86400000);
            return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : days < 31 ? 'This month' : 'Earlier';
        };
        function update() {
            const games = SailAPI.getGames();
            title.textContent = `All Games (${games.length})`;
            const recent = games.filter(game => game.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 6);
            shelf.hidden = !recent.length;
            if (!recent.length) return;
            const cards = recent.map(game => {
                const cover = SailAPI.getCover(game.id, 'hero') || SailAPI.getCover(game.id, 'header');
                const art = cover ? el('img', { src: cover, alt: '', loading: 'lazy' }) : el('span', { class: 'sl-shelf-letter', text: (game.name || '?').charAt(0).toUpperCase() });
                const card = el('button', { type: 'button', class: 'sl-shelf-card', title: game.name }, [el('small', { class: 'sl-shelf-when', text: when(game.lastPlayed) }), el('span', { class: 'sl-shelf-art' }, [art]), el('b', { text: game.name })]);
                card.addEventListener('click', () => SailAPI.openGame(game.id));
                return card;
            });
            shelf.replaceChildren(el('h2', { class: 'sl-shelf-title', text: 'Recent Games' }), el('div', { class: 'sl-shelf-row' }, cards));
        }
        return { update, destroy() { shelf.remove(); title.remove(); } };
    }

    // The gear and its panel stay available whichever layout is on, including Off, so there is always a way back.
    function buildEntry() {
        const gear = el('button', { type: 'button', class: 'sl-gear', title: 'Library Layouts', 'aria-label': 'Library Layouts settings' }, [svg(['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'], 15)]);
        const panel = buildSettingsPanel();
        gear.addEventListener('click', event => { event.stopPropagation(); panel.toggle(); });
        const element = el('div', { class: 'sl-foot' }, [el('span', { text: 'Layouts' }), gear, panel.element]);
        document.getElementById('mainSidebar').append(element);
        const style = el('style', { id: 'sl-base-style' });
        style.textContent = fs.readFileSync(path.join(__dirname, 'layouts', 'base.css'), 'utf8');
        document.head.append(style);
        const handle = { element, open() { panel.show(); }, destroy() { panel.destroy(); element.remove(); style.remove(); } };
        entryHandle = handle;
        return handle;
    }

    function buildSettingsPanel() {
        const toggles = [
            ['colors', 'Steam colours', 'Dark blue-grey instead of your Sail theme.'],
            ['portrait', 'Tall covers', 'Poster art on the home page when a game has it.'],
            ['friends', 'Friends panel', 'Show the panel on the right.']
        ];
        const layout = el('select', { class: 'sl-select', 'aria-label': 'Layout' }, LAYOUTS.map(item => el('option', { value: item.id, text: item.label })));
        layout.value = settings.layout;
        layout.addEventListener('change', () => { settings.layout = layout.value; saveSettings(); applyLayout(); });
        const rows = toggles.map(([key, label, hint]) => {
            const box = el('input', { type: 'checkbox', id: `sl-opt-${key}` });
            box.checked = !!settings[key];
            box.addEventListener('change', () => { settings[key] = box.checked; saveSettings(); const active = controller.current(); if (active) active.ensureClasses(); document.dispatchEvent(new Event('sl-settings')); });
            return el('label', { class: 'sl-opt', for: `sl-opt-${key}` }, [box, el('span', {}, [el('b', { text: label }), el('small', { text: hint })])]);
        });
        const element = el('div', { class: 'sl-settings', hidden: true, role: 'dialog', 'aria-label': 'Library Layouts settings' }, [el('div', { class: 'sl-settings-title', text: 'Library Layouts' }), layout, ...rows]);
        const close = event => { if (!element.hidden && !element.contains(event.target)) element.hidden = true; };
        document.addEventListener('click', close);
        return { element, toggle() { element.hidden = !element.hidden; }, show() { element.hidden = false; }, destroy() { document.removeEventListener('click', close); } };
    }

    // Last played, play time and achievements next to the Play button.
    function buildStats() {
        const bar = document.querySelector('.gp-action-bar');
        const make = label => { const value = el('b', { text: '-' }); return { value, node: el('div', { class: 'sl-stat' }, [el('small', { text: label }), value]) }; };
        const last = make('Last played'), time = make('Play time'), trophies = make('Achievements');
        const wrap = el('div', { class: 'sl-stats' }, [last.node, time.node, trophies.node]);
        const anchor = bar && (bar.querySelector('#gpStopBtn') || bar.querySelector('#gpPlayBtn'));
        if (bar && anchor) anchor.after(wrap);
        function day(ms) {
            if (!ms) return 'Never';
            const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86400000);
            if (days <= 0) return 'Today';
            if (days === 1) return 'Yesterday';
            return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        }
        function hours(seconds) {
            if (!seconds) return '0 minutes';
            if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} minutes`;
            return `${(seconds / 3600).toFixed(1)} hours`;
        }
        function update() {
            const id = SailAPI.getActiveGameId();
            const game = id ? SailAPI.getGame(id) : null;
            wrap.hidden = !game;
            if (!game) return;
            last.value.textContent = day(game.lastPlayed);
            time.value.textContent = hours(game.playtime);
            trophies.node.hidden = !game.achievements.total;
            trophies.value.textContent = `${game.achievements.unlocked} / ${game.achievements.total}`;
        }
        return { update, destroy() { wrap.remove(); } };
    }

    // Swaps the home grid's wide banners for tall covers where Steam art exists. Puts them back afterwards.
    function coverSwapper() {
        function apply() {
            const games = SailAPI.getGames();
            for (const card of document.querySelectorAll('#gameGrid .game-card')) {
                const image = card.querySelector('img.card-banner');
                const game = games[Number(card.dataset.masterIndex)];
                if (!image || !game || image.dataset.slOriginal !== undefined) continue;
                const url = settings.portrait ? SailAPI.getCover(game.id, 'portrait') : '';
                if (!url) continue;
                image.dataset.slOriginal = image.getAttribute('src') || '';
                image.addEventListener('error', () => { if (image.dataset.slOriginal) image.src = image.dataset.slOriginal; }, { once: true });
                image.src = url;
            }
        }
        function restore() {
            for (const image of document.querySelectorAll('#gameGrid img.card-banner[data-sl-original]')) {
                if (image.dataset.slOriginal) image.src = image.dataset.slOriginal;
                delete image.dataset.slOriginal;
            }
        }
        const onSettings = () => { restore(); apply(); };
        document.addEventListener('sl-settings', onSettings);
        return { apply, destroy() { document.removeEventListener('sl-settings', onSettings); restore(); } };
    }

    // ---- Controller -------------------------------------------------------------------------
    const controller = (() => {
        let active = null;
        return { set(next) { active = next; }, current() { return active; } };
    })();
    function applyLayout() {
        const previous = controller.current();
        if (previous) { previous.unmount(); controller.set(null); }
        if (settings.layout === 'steam') {
            const next = steamLayout();
            try { next.mount(); controller.set(next); } catch (error) { console.error('[Library Layouts] Could not start the layout:', error); try { next.unmount(); } catch (_) { /* Already undone as far as it went. */ } }
        }
    }
    const entry = buildEntry();
    applyLayout();

    return {
        dispose() {
            const current = controller.current();
            if (current) current.unmount();
            controller.set(null);
            entry.destroy();
        }
    };
};
