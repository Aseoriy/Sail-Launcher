// Library Layouts for Sail Launcher
// Re-arranges the launcher like other popular clients. Everything it changes is put back when it is switched off.

module.exports = function (SailAPI, context) {
    const fs = require('fs');
    const path = require('path');
    const { ipcRenderer } = require('electron');

    // Settings come from Sail's plugin settings (see "settings" in plugin.json), so they are edited in Sail's own
    // dialog from the Plugin Manager, the gear below the game list or the Sail menu.
    if (!SailAPI || !(SailAPI.apiVersion >= 2) || !context || !context.settings) {
        console.warn('[Library Layouts] This version of Sail is too old for layout plugins. Update Sail to use it.');
        return { dispose() {} };
    }
    const prefs = context.settings;

    // Earlier versions kept their options in the browser's storage; carry them over once.
    (function migrateOldSettings() {
        try {
            const old = JSON.parse(localStorage.getItem('sail-library-layouts') || 'null');
            if (!old || typeof old !== 'object') return;
            const carry = { layout: 'layout', colors: 'colors', portrait: 'tallCovers', friends: 'friends' };
            for (const [from, to] of Object.entries(carry)) if (from in old && !prefs.isSet(to)) prefs.set(to, old[from]);
            localStorage.removeItem('sail-library-layouts');
        } catch (_) { /* Nothing to carry over. */ }
    })();

    // The friends panel can be switched from the settings, the menu bar and the bottom bar; they all land here.
    function setFriends(on) { prefs.set('friends', !!on); }

    const html = document.documentElement;
    const body = document.body;
    let entryHandle = null;
    const entryRef = () => entryHandle;
    let profileHandle = null;
    const profileRef = () => profileHandle;

    // Playtime is stored in seconds. These are shared by the game page stats and the profile page.
    function formatDay(ms) {
        if (!ms) return 'Never';
        const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86400000);
        if (days <= 0) return 'Today';
        if (days === 1) return 'Yesterday';
        return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }
    function formatPlaytime(seconds) {
        if (!seconds) return '0 minutes';
        if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} minutes`;
        return `${(seconds / 3600).toFixed(1)} hours`;
    }
    const formatNumber = value => Number(value || 0).toLocaleString();
    const formatBytes = bytes => bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(0)} MB` : `${Math.max(0, Math.round(bytes / 1024))} KB`;

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
        const classes = () => ['sl-steam', prefs.get('colors') && 'sl-colors', prefs.get('tallCovers') && 'sl-portrait', prefs.get('friends') && 'sl-friends',
            prefs.get('actionButtons') === 'sail' && 'sl-keep-buttons', prefs.get('tabNames') === 'sail' && 'sl-sail-names', prefs.get('downloadsTab') && 'sl-downloads-tab',
            !prefs.get('recentShelf') && 'sl-no-shelf', !prefs.get('bottomBar') && 'sl-no-bottom'].filter(Boolean);
        const everyClass = ['sl-steam', 'sl-colors', 'sl-portrait', 'sl-friends', 'sl-keep-buttons', 'sl-sail-names', 'sl-downloads-tab', 'sl-no-shelf', 'sl-no-bottom'];

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

            // The menu bar along the top, like Steam's, holds every Sail button.
            const menubar = buildMenubar();
            undo.push(() => menubar.destroy());

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
                const names = buildTabNames(nav);
                undo.push(() => names.destroy());
                tabs = buildTabFit(nav, titleBar);
                undo.push(() => tabs.destroy());
            }

            // Game list in the left panel.
            const sidebar = document.getElementById('mainSidebar');
            const panel = buildGameList();
            sidebar.append(panel.element);
            undo.push(() => { panel.destroy(); panel.element.remove(); });

            // The Manage Game dialog becomes a properties window with a page list on the left.
            const properties = buildProperties();
            undo.push(() => properties.destroy());

            // Game page extras.
            const stats = buildStats();
            undo.push(() => stats.destroy());

            // Your profile page, opened from the account menu.
            const profile = buildProfilePage();
            undo.push(() => profile.destroy());

            // Bottom bar and the home page's shelf and header.
            const bottom = buildBottomBar();
            undo.push(() => bottom.destroy());
            const home = buildHome();
            undo.push(() => home.destroy());

            // Tall covers on the home grid.
            const covers = coverSwapper();
            undo.push(() => covers.destroy());

            const refresh = frame(() => { panel.render(); properties.update(); profile.update(); stats.update(); covers.apply(); home.update(); bottom.update(); if (tabs) tabs.fit(); });
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

    // The menu bar along the very top, like Steam's: Sail, View, Friends, Games, Help, plus the account menu on the
    // profile button. Every entry presses a button or calls a function the launcher already has, so nothing here can
    // do more than the controls it replaces. Anything the screen already has a button for (the page tabs, the Downloads
    // and Add a Game buttons below, the grid toggle) is left out of the menus.
    function buildMenubar() {
        const titleBar = document.querySelector('.custom-titlebar');
        const controls = document.querySelector('.titlebar-controls');
        const pill = document.getElementById('accountPill');
        const logo = document.querySelector('.tb-logo');
        const bar = el('div', { class: 'sl-menubar', role: 'menubar' });
        const popup = el('div', { class: 'sl-menu', role: 'menu', hidden: true });
        const findButton = id => id === 'exit' ? document.getElementById('closeBtn') : Array.from(document.querySelectorAll(`[data-btn-id="${id}"]`)).find(node => !node.closest('.sl-menu'));
        const item = (label, run, extra = {}) => ({ label, run, ...extra });
        const SEP = { sep: true };
        const viaButton = (label, id) => item(label, () => { const target = findButton(id); if (target) target.click(); }, { disabled: !findButton(id) });
        const viaId = (label, id) => item(label, () => { const target = document.getElementById(id); if (target) target.click(); }, { disabled: !document.getElementById(id) });
        const call = (label, name, run, extra = {}) => item(label, run, { disabled: typeof window[name] !== 'function', ...extra });
        const text = id => { const node = document.getElementById(id); return node ? node.textContent.trim() : ''; };

        // Friends panel sorting is the launcher's own select; changing it fires the launcher's own handler.
        const sortBy = (label, value) => {
            const select = document.getElementById('friendsSortSelect');
            return item(label, () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }, { disabled: !select, checked: !!select && select.value === value });
        };
        const signedIn = () => { const node = document.getElementById('accountSignedIn'); return !!node && node.style.display !== 'none'; };
        const inAccount = then => () => { window.openAccountModal(); then(); };
        const MENUS = [
            { label: 'Sail', items: () => [
                call('Account & Profiles…', 'openAccountModal', () => window.openAccountModal()), SEP,
                viaId('Check for Sail Updates…', 'checkUpdateBtn'), SEP,
                viaButton('Settings', 'settings'), viaButton('Plugins', 'plugins'), item('Library Layouts…', () => { const handle = entryRef(); if (handle) handle.open(); }), SEP,
                viaButton('Exit', 'exit')] },
            { label: 'View', items: () => [
                viaButton('Statistics', 'stats'), SEP,
                viaButton('Big Picture Mode', 'bigPicture')] },
            { label: 'Friends', items: () => [
                item('Friends & Chat', () => setFriends(!prefs.get('friends')), { checked: prefs.get('friends') }), SEP,
                sortBy('Sort by Status', 'status'), sortBy('Sort by Name', 'name'), sortBy('Sort by Platform', 'platform')] },
            { label: 'Games', items: () => [
                viaButton('Add a Game…', 'addGame'), viaButton('Select Games', 'selectMode'), SEP,
                viaButton('Surprise Me', 'surpriseMe')] },
            { label: 'Help', items: () => [
                viaButton('System Specs', 'systemSpecs'), viaId('Supporters', 'supportersBtn'), SEP,
                { note: true, label: `Sail Launcher ${text('tbVersion')}`.trim() }] }
        ];
        // The profile button's own dropdown, laid out like Steam's account menu.
        const ACCOUNT = { align: 'right', anchor: pill, items: () => {
            const viewProfile = item('View My Profile', () => { const page = profileRef(); if (page) page.open(); }, { disabled: !profileRef() });
            if (!signedIn()) return [
                viewProfile,
                call('Log In…', 'showAccountAuthMode', inAccount(() => window.showAccountAuthMode('login'))),
                call('Create Account…', 'showAccountAuthMode', inAccount(() => window.showAccountAuthMode('signup')))];
            const section = name => call({ library: 'Library & Presets', security: 'Security' }[name], 'showAccountSection', inAccount(() => window.showAccountSection(name)));
            return [
                viewProfile,
                call('Account Details:', 'showAccountSection', inAccount(() => window.showAccountSection('overview')), { value: text('accountDisplayName') }),
                section('library'), section('security'), SEP,
                call('Manage on Sail Hub…', 'openSailHubAccountManager', () => window.openSailHubAccountManager()),
                call('Sync This PC', 'uploadLocalAccountData', () => window.uploadLocalAccountData()), SEP,
                call('Sign Out of Account…', 'accountSignOut', () => { if (confirm('Sign out of your Sail account on this PC?')) window.accountSignOut(); })];
        } };
        const entries = [...MENUS.map(menu => ({ ...menu, anchor: null })), ACCOUNT];
        let current = -1;
        MENUS.forEach(({ label }, index) => {
            const mark = index === 0 && logo ? el('img', { class: 'sl-menubar-logo', src: logo.src, alt: '' }) : null;
            const button = el('button', { type: 'button', class: 'sl-menubar-btn', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, [mark, label]);
            button.addEventListener('click', () => { if (current === index && !popup.hidden) close(); else open(index); });
            // Once one menu is open, sliding to another opens it, as in every desktop menu bar.
            button.addEventListener('mouseenter', () => { if (!popup.hidden && current !== index && current < MENUS.length) open(index); });
            bar.append(button);
            entries[index].anchor = button;
        });
        const accountIndex = entries.length - 1;
        function close() {
            popup.hidden = true;
            if (current >= 0 && entries[current].anchor) entries[current].anchor.setAttribute('aria-expanded', 'false');
            current = -1;
        }
        function open(index) {
            if (current >= 0 && entries[current].anchor) entries[current].anchor.setAttribute('aria-expanded', 'false');
            current = index;
            const entry = entries[index];
            const rows = entry.items();
            popup.classList.toggle('sl-menu-checks', rows.some(row => 'checked' in row));
            popup.replaceChildren(...rows.map(row => {
                if (row.sep) return el('div', { class: 'sl-menu-sep', role: 'separator' });
                if (row.note) return el('div', { class: 'sl-menu-note', text: row.label });
                const line = el('button', { type: 'button', class: 'sl-menu-item', role: 'menuitem', disabled: row.disabled }, [el('span', { class: 'sl-menu-check', text: row.checked ? '✓' : '' }), row.label, row.value ? el('span', { class: 'sl-menu-value', text: ` ${row.value}` }) : null]);
                line.addEventListener('click', () => { close(); row.run(); });
                return line;
            }));
            popup.hidden = false;
            const box = entry.anchor.getBoundingClientRect();
            const left = entry.align === 'right' ? box.right - popup.offsetWidth : box.left;
            popup.style.left = `${Math.max(4, Math.min(left, window.innerWidth - popup.offsetWidth - 4))}px`;
            popup.style.top = `${box.bottom}px`;
            entry.anchor.setAttribute('aria-expanded', 'true');
        }
        // The profile button opens the dropdown instead of going straight to the account window; the launcher's own
        // handler is untouched, so switching the layout off brings the old behaviour back.
        const caret = pill ? el('span', { class: 'sl-caret' }, [svg(['M6 9l6 6 6-6'], 11)]) : null;
        if (pill) { pill.append(caret); pill.setAttribute('aria-haspopup', 'menu'); pill.setAttribute('aria-expanded', 'false'); }
        const onAccountClick = event => {
            if (!pill || !event.target.closest('#accountPill')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (current === accountIndex && !popup.hidden) close(); else open(accountIndex);
        };
        if (controls) controls.addEventListener('click', onAccountClick, true);
        const onDocument = event => { if (!popup.hidden && !popup.contains(event.target) && !bar.contains(event.target) && !(pill && pill.contains(event.target))) close(); };
        const onKey = event => {
            if (popup.hidden) return;
            if (event.key === 'Escape') { const was = entries[current].anchor; close(); if (was) was.focus(); return; }
            if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && current < MENUS.length) { event.preventDefault(); open((current + (event.key === 'ArrowRight' ? 1 : -1) + MENUS.length) % MENUS.length); return; }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const rows = Array.from(popup.querySelectorAll('.sl-menu-item:not(:disabled)'));
            if (!rows.length) return;
            const at = rows.indexOf(document.activeElement);
            event.preventDefault();
            rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
        };
        document.addEventListener('click', onDocument);
        document.addEventListener('keydown', onKey, true);
        document.body.append(popup);
        titleBar.prepend(bar);
        return {
            destroy() {
                if (controls) controls.removeEventListener('click', onAccountClick, true);
                document.removeEventListener('click', onDocument);
                document.removeEventListener('keydown', onKey, true);
                if (pill) { pill.removeAttribute('aria-haspopup'); pill.removeAttribute('aria-expanded'); }
                if (caret) caret.remove();
                popup.remove();
                bar.remove();
            }
        };
    }

    // Steam's names for the pages. The words are drawn by the stylesheet from this attribute, so the launcher's own
    // labels (and its language switching) are never touched; removing the attribute brings the original names back.
    function buildTabNames(nav) {
        const NAMES = { tabLibrary: 'Library', tabDownloads: 'Store', tabStore: 'Community', tabWorkshop: 'Workshop', tabAchievements: 'Achievements', tabMaintenance: 'Maintenance' };
        const labels = [];
        for (const [id, name] of Object.entries(NAMES)) {
            const label = nav.querySelector(`#${id} .sidebar-page-label`);
            if (!label) continue;
            label.setAttribute('data-sl-name', name);
            labels.push(label);
        }
        return { destroy() { for (const label of labels) label.removeAttribute('data-sl-name'); } };
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
            // The tabs are reordered with CSS, so work from the order they are drawn in.
            const shown = tabs.filter(tab => getComputedStyle(tab).display !== 'none').sort((a, b) => Number(getComputedStyle(a).order) - Number(getComputedStyle(b).order));
            const over = () => nav.scrollWidth > nav.clientWidth + 1;
            if (!over()) return;
            more.hidden = false;
            for (let i = shown.length - 1; i >= 0 && over(); i--) {
                if (shown[i].classList.contains('active-tab')) continue;
                shown[i].classList.add('sl-tab-off');
                hidden.unshift(shown[i]);
            }
        }
        more.addEventListener('click', () => {
            if (!menu.hidden) { menu.hidden = true; return; }
            menu.replaceChildren(...hidden.map(tab => {
                const item = el('button', { type: 'button', class: 'sl-menu-item', role: 'menuitem', text: (!body.classList.contains('sl-sail-names') && (tab.querySelector('.sidebar-page-label') || tab).getAttribute('data-sl-name')) || (tab.querySelector('.sidebar-page-label') || tab).textContent.trim() });
                item.addEventListener('click', () => { menu.hidden = true; tab.click(); });
                return item;
            }));
            const box = more.getBoundingClientRect();
            menu.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - 220))}px`;
            menu.style.top = `${box.bottom + 2}px`;
            menu.hidden = false;
        });
        const onDocument = event => { if (!menu.hidden && !menu.contains(event.target) && !more.contains(event.target)) menu.hidden = true; };
        document.addEventListener('click', onDocument);
        const refit = frame(fit);
        const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null;
        if (resize) resize.observe(titleBar);
        // Other plugins add widgets to the title bar; make room again when they do.
        const watch = new MutationObserver(refit);
        watch.observe(titleBar, { childList: true });
        window.addEventListener('resize', refit);
        document.addEventListener('sl-settings', refit);
        refit();
        return { fit: refit, destroy() { document.removeEventListener('click', onDocument); window.removeEventListener('resize', refit); document.removeEventListener('sl-settings', refit); watch.disconnect(); if (resize) resize.disconnect(); nav.querySelectorAll('.sl-tab-off').forEach(tab => tab.classList.remove('sl-tab-off')); more.remove(); menu.remove(); } };
    }

    // The strip along the bottom: add a game, downloads, friends.
    function buildBottomBar() {
        const add = el('button', { type: 'button', class: 'sl-bottom-btn' }, [svg(['M12 5v14', 'M5 12h14'], 14), 'Add a Game']);
        add.addEventListener('click', () => { const target = document.getElementById('addGameBtn'); if (target) target.click(); });
        const downloadText = el('span', { text: 'Downloads' });
        const downloads = el('button', { type: 'button', class: 'sl-bottom-btn' }, [svg(['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'], 14), downloadText]);
        downloads.addEventListener('click', () => SailAPI.showTab('downloadmanager'));
        const friends = el('button', { type: 'button', class: 'sl-bottom-btn' }, ['Friends & Chat', svg(['M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'], 14)]);
        friends.addEventListener('click', () => setFriends(!prefs.get('friends')));
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
                const letter = () => el('span', { class: 'sl-shelf-letter', text: (game.name || '?').charAt(0).toUpperCase() });
                const art = cover ? el('img', { src: cover, alt: '', loading: 'lazy' }) : letter();
                if (cover) art.addEventListener('error', () => art.replaceWith(letter()), { once: true });
                const card = el('button', { type: 'button', class: 'sl-shelf-card', title: game.name }, [el('small', { class: 'sl-shelf-when', text: when(game.lastPlayed) }), el('span', { class: 'sl-shelf-art' }, [art]), el('b', { text: game.name })]);
                card.addEventListener('click', () => SailAPI.openGame(game.id));
                return card;
            });
            shelf.replaceChildren(el('h2', { class: 'sl-shelf-title', text: 'Recent Games' }), el('div', { class: 'sl-shelf-row' }, cards));
        }
        return { update, destroy() { shelf.remove(); title.remove(); } };
    }

    // Your profile page: who you are in Sail and what is in your library. It covers the app area under the title bar
    // (it is not a window), closes when you go anywhere else, and only reads what the launcher already shows.
    function buildProfilePage() {
        const host = document.querySelector('.app-container');
        if (!host || typeof SailAPI.getAccount !== 'function') return { open() {}, update() {}, destroy() {} };
        const page = el('section', { class: 'sl-profile', hidden: true, role: 'region', 'aria-label': 'Your profile' });
        host.append(page);
        let isOpen = false;
        let showEmail = false;

        const openAccount = section => {
            if (typeof window.openAccountModal !== 'function') return;
            window.openAccountModal();
            if (section && typeof window.showAccountSection === 'function') window.showAccountSection(section);
        };
        const button = (label, run, primary) => { const node = el('button', { type: 'button', class: `sl-pf-btn${primary ? ' is-primary' : ''}`, text: label }); node.addEventListener('click', run); return node; };
        const maskEmail = email => { const [name, domain] = String(email).split('@'); return domain ? `${name.charAt(0)}••••@${domain}` : '••••'; };
        const letterTile = (name, cls) => el('span', { class: cls, text: (name || '?').trim().charAt(0).toUpperCase() || '?' });
        // Tries each image in turn: a game with no tall Steam art falls back to its own banner (a custom cover, or the wide
        // Steam art, cropped to fit like the home grid), and only shows a letter when nothing loads.
        const capsule = (game, kind, cls) => {
            const order = kind === 'portrait' ? ['portrait', 'hero', 'header'] : [kind, 'hero'];
            const urls = [...new Set(order.map(each => SailAPI.getCover(game.id, each)).filter(Boolean))];
            if (!urls.length) return letterTile(game.name, `${cls} sl-pf-letter`);
            const image = el('img', { class: cls, src: urls.shift(), alt: '', loading: 'lazy' });
            image.addEventListener('error', () => {
                if (urls.length) image.src = urls.shift();
                else image.replaceWith(letterTile(game.name, `${cls} sl-pf-letter`));
            });
            return image;
        };
        const open = game => { close(); SailAPI.openGame(game.id); };
        const section = (title, ...children) => el('section', { class: 'sl-pf-section' }, [el('h2', { class: 'sl-pf-h', text: title }), ...children]);
        const card = (title, ...children) => el('section', { class: 'sl-pf-card' }, [el('h3', { class: 'sl-pf-h', text: title }), ...children]);
        const line = (label, value) => el('div', { class: 'sl-pf-line' }, [el('span', { text: label }), typeof value === 'string' ? el('b', { text: value }) : value]);
        const meter = (ratio, tone) => el('span', { class: `sl-pf-meter${tone ? ` is-${tone}` : ''}` }, [el('i', { style: `width:${Math.max(0, Math.min(100, ratio * 100)).toFixed(1)}%` })]);
        const empty = text => el('p', { class: 'sl-pf-empty', text });

        function render() {
            const account = SailAPI.getAccount();
            const games = SailAPI.getGames();
            const totalSeconds = games.reduce((sum, game) => sum + game.playtime, 0);
            const unlocked = games.reduce((sum, game) => sum + game.achievements.unlocked, 0);
            const trophies = games.reduce((sum, game) => sum + game.achievements.total, 0);
            const completed = games.filter(game => game.achievements.total > 0 && game.achievements.unlocked === game.achievements.total);
            const favorites = games.filter(game => game.isFavorite);
            const recent = games.filter(game => game.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 5);
            const topPlayed = games.filter(game => game.playtime > 0).sort((a, b) => b.playtime - a.playtime).slice(0, 5);
            const topTrophies = games.filter(game => game.achievements.total > 0).sort((a, b) => b.achievements.unlocked - a.achievements.unlocked || b.achievements.total - a.achievements.total).slice(0, 3);
            const playing = games.find(game => game.isRunning);

            // Header: avatar, name and where you stand.
            const avatar = account.avatar
                ? el('img', { class: 'sl-pf-avatar', src: account.avatar, alt: '' })
                : letterTile(account.displayName, 'sl-pf-avatar sl-pf-letter');
            if (avatar.tagName === 'IMG') avatar.addEventListener('error', () => avatar.replaceWith(letterTile(account.displayName, 'sl-pf-avatar sl-pf-letter')), { once: true });
            const since = account.memberSince ? `Member since ${new Date(account.memberSince).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}` : '';
            const subtitle = account.signedIn ? [account.username && account.username !== account.displayName ? `@${account.username}` : '', since].filter(Boolean).join(' · ') : 'Local profile · not signed in to Sail';
            const badges = [el('span', { class: `sl-pf-badge ${account.signedIn ? 'is-on' : ''}`, text: account.signedIn ? 'Signed in' : 'Local only' })];
            if (account.signedIn) badges.push(el('span', { class: `sl-pf-badge ${account.syncEnabled ? 'is-on' : 'is-off'}`, text: account.syncEnabled ? 'Sail Cloud sync on' : 'Sail Cloud sync paused' }));
            if (playing) badges.push(el('span', { class: 'sl-pf-badge is-live', text: `Playing ${playing.name}` }));
            const actions = account.signedIn
                ? [button('Edit profile', () => openAccount('profile'), true), button('Manage on Sail Hub', () => { if (typeof window.openSailHubAccountManager === 'function') window.openSailHubAccountManager(); })]
                : [button('Log in or create an account', () => openAccount(''), true)];
            const closeButton = el('button', { type: 'button', class: 'sl-pf-close', 'aria-label': 'Close profile', title: 'Close' }, [svg(['M6 6l12 12', 'M18 6L6 18'], 16)]);
            closeButton.addEventListener('click', close);
            const hero = el('header', { class: 'sl-pf-hero' }, [
                closeButton,
                avatar,
                el('div', { class: 'sl-pf-id' }, [el('h1', { text: account.displayName }), subtitle ? el('p', { class: 'sl-pf-sub', text: subtitle }) : null, el('div', { class: 'sl-pf-badges' }, badges)]),
                el('div', { class: 'sl-pf-actions' }, actions)
            ]);
            if (account.avatar) hero.style.setProperty('--sl-pf-bg', `url("${account.avatar.replace(/"/g, '%22')}")`);

            // The numbers.
            const stat = (value, label, hint) => el('div', { class: 'sl-pf-stat' }, [el('b', { text: value }), el('span', { text: label }), hint ? el('small', { text: hint }) : null]);
            const stats = el('div', { class: 'sl-pf-stats' }, [
                stat(formatNumber(games.length), 'Games'),
                stat((totalSeconds / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 }), 'Hours played'),
                stat(trophies ? `${formatNumber(unlocked)}` : '0', 'Achievements', trophies ? `of ${formatNumber(trophies)} (${Math.round(unlocked / trophies * 100)}%)` : 'none tracked yet'),
                stat(formatNumber(completed.length), 'Completed', 'every achievement'),
                stat(formatNumber(favorites.length), 'Favorites')
            ]);

            // Left column: what you have been playing.
            const recentRows = recent.map(game => {
                const row = el('button', { type: 'button', class: 'sl-pf-game' }, [capsule(game, 'header', 'sl-pf-cap'), el('span', { class: 'sl-pf-gname' }, [el('b', { text: game.name }), el('small', { text: `Last played ${formatDay(game.lastPlayed).toLowerCase()} · ${formatPlaytime(game.playtime)} on record` })])]);
                row.addEventListener('click', () => open(game));
                return row;
            });
            const mostRows = topPlayed.map(game => {
                const row = el('button', { type: 'button', class: 'sl-pf-bar' }, [el('span', { class: 'sl-pf-bname', text: game.name }), meter(game.playtime / topPlayed[0].playtime), el('span', { class: 'sl-pf-bval', text: formatPlaytime(game.playtime) })]);
                row.addEventListener('click', () => open(game));
                return row;
            });
            const showcase = favorites.slice(0, 8).map(game => {
                const tile = el('button', { type: 'button', class: 'sl-pf-fav', title: game.name }, [capsule(game, 'portrait', 'sl-pf-poster'), el('span', { text: game.name })]);
                tile.addEventListener('click', () => open(game));
                return tile;
            });
            const main = el('div', { class: 'sl-pf-main' }, [
                section('Recent activity', recentRows.length ? el('div', { class: 'sl-pf-list' }, recentRows) : empty('Nothing played yet. Launch a game and it will show up here.')),
                section('Most played', mostRows.length ? el('div', { class: 'sl-pf-list' }, mostRows) : empty('Playtime is recorded while you play.')),
                section('Favorites', showcase.length ? el('div', { class: 'sl-pf-favs' }, showcase) : empty('Star a game on its page to pin it here.'))
            ]);

            // Right column: the details behind the profile.
            const emailRow = account.email ? line('Email', el('span', { class: 'sl-pf-email' }, [el('b', { text: showEmail ? account.email : maskEmail(account.email) }), (() => { const toggle = el('button', { type: 'button', class: 'sl-pf-link', text: showEmail ? 'Hide' : 'Show' }); toggle.addEventListener('click', () => { showEmail = !showEmail; update(); }); return toggle; })()])) : null;
            const accountCard = card('Account',
                line('Display name', account.displayName),
                account.signedIn && account.username ? line('Username', account.username) : null,
                emailRow,
                account.memberSince ? line('Member since', new Date(account.memberSince).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })) : null,
                line('Status', account.signedIn ? 'Signed in' : 'Using a local profile'));
            const launcherCard = card('Launcher profile',
                line('Active profile', account.launcherProfile || 'Default'),
                account.launcherProfileCount ? line('Profiles on this PC', formatNumber(account.launcherProfileCount)) : null);
            const cards = [accountCard, launcherCard];
            if (account.signedIn) {
                const storage = account.storage;
                cards.push(card('Sail Cloud',
                    line('Sync on this PC', account.syncEnabled ? 'On' : 'Paused'),
                    storage && storage.quota ? el('div', { class: 'sl-pf-usage' }, [el('span', { text: `${formatBytes(storage.used)} of ${formatBytes(storage.quota)} used` }), meter(storage.used / storage.quota, storage.used / storage.quota > .9 ? 'warn' : '')]) : el('p', { class: 'sl-pf-empty', text: 'Storage usage is not available right now.' })));
            }
            cards.push(card('Achievements',
                trophies ? el('div', { class: 'sl-pf-usage' }, [el('span', { text: `${formatNumber(unlocked)} of ${formatNumber(trophies)} unlocked` }), meter(unlocked / trophies, 'good')]) : empty('No achievement data yet.'),
                ...topTrophies.map(game => { const row = el('button', { type: 'button', class: 'sl-pf-trophy' }, [el('span', { text: game.name }), el('b', { text: `${game.achievements.unlocked}/${game.achievements.total}` })]); row.addEventListener('click', () => open(game)); return row; })));
            const side = el('aside', { class: 'sl-pf-side' }, cards);

            const scroll = page.scrollTop;
            page.replaceChildren(hero, stats, el('div', { class: 'sl-pf-cols' }, [main, side]));
            page.scrollTop = scroll;
        }
        function update() { if (isOpen) render(); }
        function openPage() {
            isOpen = true;
            page.hidden = false;
            render();
            page.scrollTop = 0;
            const closeButton = page.querySelector('.sl-pf-close');
            if (closeButton) closeButton.focus({ preventScroll: true });
            // Fetch the latest account details; the page redraws itself when they arrive.
            try { if (typeof window.refreshAccountState === 'function') Promise.resolve(window.refreshAccountState()).catch(() => {}); } catch (_) { /* The details already on screen are used. */ }
        }
        function close() {
            if (!isOpen) return;
            isOpen = false;
            showEmail = false;
            page.hidden = true;
            page.replaceChildren();
        }
        const onKey = event => {
            if (!isOpen || event.key !== 'Escape') return;
            if (document.querySelector('.modal.show:not(.closing)') || document.querySelector('.sl-menu:not([hidden])')) return;
            close();
        };
        // Any other page is a way out: the tabs, back/forward and anything else that navigates.
        const onTab = event => { if (isOpen && event.target.closest('.sl-top-nav .sidebar-page-link, #navBackBtn, #navFwdBtn')) close(); };
        document.addEventListener('keydown', onKey);
        document.addEventListener('click', onTab, true);
        const offNavigate = SailAPI.onNavigate(close);
        const offAccount = typeof SailAPI.onAccountChange === 'function' ? SailAPI.onAccountChange(update) : () => {};
        profileHandle = { open: openPage };
        return {
            update,
            destroy() {
                document.removeEventListener('keydown', onKey);
                document.removeEventListener('click', onTab, true);
                offNavigate();
                offAccount();
                profileHandle = null;
                page.remove();
            }
        };
    }

    // Manage Game as a properties window: the same controls, grouped into pages listed on the left.
    // The launcher's own elements are moved, never copied, so everything it wires up keeps working; put back on undo.
    function buildProperties() {
        const modal = document.getElementById('gameSettingsModal');
        const content = modal && modal.querySelector('.modal-content');
        if (!content) return { update() {}, destroy() {} };
        const kids = Array.from(content.children);
        const holds = (kid, id) => kid.id === id || !!kid.querySelector(`#${id}`);
        const PAGES = [
            { id: 'general', label: 'General', parts: ['perGameAdminToggle', 'highPriorityToggle', 'launchArgsInput', 'companionAppInput', 'preLaunchInput', 'postLaunchInput'], save: true },
            { id: 'compat', label: 'Compatibility', parts: ['nativeLaunchFields', 'protonSetupPanel', 'linuxDownloadedGamePanel', 'protonInstallationPanel', 'protonLaunchLogPanel'], save: true },
            { id: 'saves', label: 'Saves', parts: ['protonSavesPanel', 'manualGameConfigSyncSection', 'saveVersionSection'] },
            { id: 'files', label: 'Installed Files', parts: ['browseLocalFilesBtn', 'backupGameBtn', 'uninstallGameSection'] },
            { id: 'library', label: 'Library', parts: ['editFromPageBtn'] }
        ];
        const footIds = ['approveLocalExecutionBtn', 'discardLocalExecutionBtn', 'localExecutionSetupStatus'];
        const chrome = kids.filter(kid => kid.classList.contains('close-x') || kid.tagName === 'H2');
        const footer = kids.filter(kid => !chrome.includes(kid) && footIds.some(id => holds(kid, id)));
        const panes = kids.filter(kid => !chrome.includes(kid) && !footer.includes(kid));
        const pageOf = pane => (PAGES.find(page => page.parts.some(id => holds(pane, id))) || PAGES[0]).id;

        const nameLine = el('span', { class: 'sl-props-name' });
        const art = el('span', { class: 'sl-props-art' });
        const nav = el('nav', { class: 'sl-props-nav', 'aria-label': 'Properties pages' }, [el('div', { class: 'sl-props-game' }, [art, nameLine])]);
        const title = el('h2', { class: 'sl-props-title' });
        const body = el('div', { class: 'sl-props-body' });
        const foot = el('div', { class: 'sl-props-foot' });
        const main = el('div', { class: 'sl-props-main' }, [title, body, foot]);
        const layout = el('div', { class: 'sl-props' }, [nav, main]);
        const tabs = new Map();
        let page = 'general';
        for (const entry of PAGES) {
            const tab = el('button', { type: 'button', class: 'sl-props-tab', 'data-page': entry.id, text: entry.label });
            tab.addEventListener('click', () => show(entry.id));
            nav.append(tab);
            tabs.set(entry.id, tab);
        }
        for (const pane of panes) { pane.setAttribute('data-sl-page', pageOf(pane)); body.append(pane); }
        for (const part of footer) foot.append(part);
        content.append(layout);

        // The launcher shows and hides its own panels with the hidden attribute or an inline display: follow that.
        const showing = pane => !pane.hidden && pane.style.display !== 'none';
        const hasContent = entry => entry.id === 'general' || panes.some(pane => pane.getAttribute('data-sl-page') === entry.id && showing(pane));
        function show(id) {
            page = id;
            const entry = PAGES.find(item => item.id === id);
            title.textContent = entry.label;
            for (const pane of panes) pane.classList.toggle('sl-pane-on', pane.getAttribute('data-sl-page') === id);
            for (const [key, tab] of tabs) tab.classList.toggle('is-active', key === id);
            foot.hidden = !entry.save;
            body.scrollTop = 0;
        }
        function update() {
            for (const entry of PAGES) {
                const tab = tabs.get(entry.id);
                const want = !hasContent(entry);
                if (tab.hidden !== want) tab.hidden = want;
            }
            if (tabs.get(page).hidden) show('general');
            const id = SailAPI.getActiveGameId();
            const game = id ? SailAPI.getGame(id) : null;
            const cover = id ? SailAPI.getCover(id, 'header') : '';
            const name = game ? game.name : 'Manage Game';
            if (nameLine.textContent !== name) nameLine.textContent = name;
            const wanted = cover || '';
            if (art.dataset.src !== wanted) { art.dataset.src = wanted; art.style.backgroundImage = wanted ? `url("${wanted.replace(/"/g, '%22')}")` : ''; }
        }
        const refresh = frame(update);
        const watch = new MutationObserver(records => { if (records.some(record => !nav.contains(record.target))) refresh(); });
        watch.observe(content, { subtree: true, attributes: true, attributeFilter: ['hidden', 'style'] });
        // A fresh start on the first page each time the dialog opens.
        let wasOpen = modal.classList.contains('show');
        const opening = new MutationObserver(() => {
            const open = modal.classList.contains('show');
            if (open && !wasOpen) { show('general'); update(); }
            wasOpen = open;
        });
        opening.observe(modal, { attributes: true, attributeFilter: ['class'] });
        show('general');
        update();

        return {
            update,
            destroy() {
                watch.disconnect();
                opening.disconnect();
                for (const pane of panes) { pane.removeAttribute('data-sl-page'); pane.classList.remove('sl-pane-on'); }
                // Back in the original order, then the page chrome goes away.
                for (const kid of kids) content.append(kid);
                layout.remove();
            }
        };
    }

    // The gear stays available whichever layout is on, including Off, so there is always a way back to the settings.
    function buildEntry() {
        const gear = el('button', { type: 'button', class: 'sl-gear', title: 'Library Layouts settings', 'aria-label': 'Library Layouts settings' }, [svg(['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'], 15)]);
        gear.addEventListener('click', () => prefs.open());
        const element = el('div', { class: 'sl-foot' }, [el('span', { text: 'Layouts' }), gear]);
        document.getElementById('mainSidebar').append(element);
        const style = el('style', { id: 'sl-base-style' });
        style.textContent = fs.readFileSync(path.join(__dirname, 'layouts', 'base.css'), 'utf8');
        document.head.append(style);
        const handle = { element, open() { prefs.open(); }, destroy() { element.remove(); style.remove(); } };
        entryHandle = handle;
        return handle;
    }

    // Last played, play time and achievements next to the Play button.
    function buildStats() {
        const bar = document.querySelector('.gp-action-bar');
        const make = label => { const value = el('b', { text: '-' }); return { value, node: el('div', { class: 'sl-stat' }, [el('small', { text: label }), value]) }; };
        const last = make('Last played'), time = make('Play time'), trophies = make('Achievements');
        const wrap = el('div', { class: 'sl-stats' }, [last.node, time.node, trophies.node]);
        const anchor = bar && (bar.querySelector('#gpStopBtn') || bar.querySelector('#gpPlayBtn'));
        if (bar && anchor) anchor.after(wrap);
        function update() {
            const id = SailAPI.getActiveGameId();
            const game = id ? SailAPI.getGame(id) : null;
            wrap.hidden = !game;
            if (!game) return;
            last.value.textContent = formatDay(game.lastPlayed);
            time.value.textContent = formatPlaytime(game.playtime);
            trophies.node.hidden = !game.achievements.total;
            trophies.value.textContent = `${game.achievements.unlocked} / ${game.achievements.total}`;
        }
        return { update, destroy() { wrap.remove(); } };
    }

    // Swaps the home grid's wide Steam banners for tall covers. A tall image is only used once it has loaded, so a game
    // Steam has no tall art for keeps its wide one, and a cover you picked yourself is never replaced. Puts them back afterwards.
    function coverSwapper() {
        const isSteamArt = url => /^https:\/\/[^/]*steamstatic\.com\//.test(url);
        function apply() {
            if (!prefs.get('tallCovers')) return;
            const games = SailAPI.getGames();
            for (const card of document.querySelectorAll('#gameGrid .game-card')) {
                const image = card.querySelector('img.card-banner');
                const game = games[Number(card.dataset.masterIndex)];
                if (!image || !game || image.dataset.slState) continue;
                const url = isSteamArt(image.getAttribute('src') || '') ? SailAPI.getCover(game.id, 'portrait') : '';
                if (!url) { image.dataset.slState = 'kept'; continue; }
                image.dataset.slState = 'probing';
                const probe = new Image();
                probe.onload = () => {
                    if (!image.isConnected || image.dataset.slState !== 'probing') return;
                    image.dataset.slOriginal = image.getAttribute('src') || '';
                    image.dataset.slState = 'tall';
                    image.src = url;
                };
                probe.onerror = () => { if (image.dataset.slState === 'probing') image.dataset.slState = 'wide'; };
                probe.src = url;
            }
        }
        function restore() {
            for (const image of document.querySelectorAll('#gameGrid img.card-banner[data-sl-state]')) {
                if (image.dataset.slOriginal) image.src = image.dataset.slOriginal;
                delete image.dataset.slOriginal;
                delete image.dataset.slState;
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
        if (prefs.get('layout') === 'steam') {
            const next = steamLayout();
            try { next.mount(); controller.set(next); } catch (error) { console.error('[Library Layouts] Could not start the layout:', error); try { next.unmount(); } catch (_) { /* Already undone as far as it went. */ } }
        }
    }
    const entry = buildEntry();
    applyLayout();
    // Changes made in Sail's settings dialog (or by anything else) apply straight away.
    const stopListening = prefs.onChange(id => {
        if (id === 'layout') { applyLayout(); return; }
        const current = controller.current();
        if (current) current.ensureClasses();
        document.dispatchEvent(new Event('sl-settings'));
    });

    return {
        dispose() {
            const current = controller.current();
            if (current) current.unmount();
            controller.set(null);
            stopListening();
            entry.destroy();
        }
    };
};
