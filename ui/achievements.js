(function () {
    'use strict';

    const ipc = require('electron').ipcRenderer;
    const { pathToFileURL } = require('url');
    const SafeDom = require('./ui/safeDom');
    const { bindAchievementArtwork } = require('./ui/achievementArtwork');
    const {
        achievementDataEqual,
        mergeAchievementData,
        normalizeAchievementData,
        summarizeAchievementData
    } = require('./achievements/achievementLogic');
    const {
        BROWSE_PAGE,
        achievementSearchText,
        collectBrowsableAchievements,
        pageAchievements
    } = require('./achievements/achievementView');

    let context = null;
    let initialized = false;
    let bound = false;
    let saveTimer = null;
    let librarySyncTimer = null;
    let hubSearchTimer = null;
    let hubRenderFrame = null;
    let backToTopFrame = null;
    let steamSchemaQueueTimer = null;
    let steamSchemaBatchPending = false;
    let hubSort = 'recent';
    let hubView = 'browse';
    let browseLimit = BROWSE_PAGE;
    let librarySyncQueue = Promise.resolve();
    let lastImportReport = null;
    const pendingEvents = [];
    const expandedGamePanels = new Set();
    const gamePanelFilters = new Map();
    const steamEnrichmentAttempts = new Set();
    const steamEnrichmentInFlight = new Set();

    function games() {
        return context && typeof context.getGames === 'function' ? context.getGames() : [];
    }

    function settings() {
        return context && typeof context.getSettings === 'function' ? context.getSettings() : {};
    }

    function trackingEnabled() {
        return settings().achievementTrackingEnabled !== false;
    }

    function currentLibraryKey() {
        return context && typeof context.getLibraryKey === 'function' ? String(context.getLibraryKey()) : 'local';
    }

    function gamePayload(game) {
        return {
            id: game.id,
            ...(gameSteamAppId(game) ? { steamAppId: gameSteamAppId(game) } : {})
        };
    }

    function rendererAchievementData(data, fallbackAppId = '') {
        const normalized = normalizeAchievementData(data, fallbackAppId);
        if (!normalized) return null;
        return {
            ...normalized,
            items: normalized.items.map(item => {
                const { iconPath, iconGrayPath, ...plainItem } = item;
                return plainItem;
            })
        };
    }

    function applyLocalSources(result) {
        if (!result || !result.localSources || typeof result.localSources !== 'object') return;
        for (const [gameId, sources] of Object.entries(result.localSources)) {
            const game = games().find(item => String(item.id) === String(gameId));
            if (game && Array.isArray(sources)) game.achievementSources = sources;
        }
    }

    function gameArtwork(game) {
        if (game.customBannerPath) {
            try { return SafeDom.safeImageUrl(pathToFileURL(String(game.customBannerPath)).href, { allowFile: true }); } catch (_) { return ''; }
        }
        return SafeDom.safeImageUrl(game.steamHeroUrl || game.steamImageUrl || (game.steamAppId
            ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.steamAppId}/library_hero.jpg`
            : game.iconData), { allowSteam: true, allowData: true, maxDataLength: 2 * 1024 * 1024 });
    }

    function queueSave() {
        if (!context || typeof context.save !== 'function') return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => context.save(), 700);
    }

    function removeStoredCacheCounters() {
        let changed = false;
        for (const game of games()) {
            const rawItems = game && game.achievementData && Array.isArray(game.achievementData.items)
                ? game.achievementData.items
                : [];
            if (!rawItems.length) continue;
            const normalized = rendererAchievementData(game.achievementData, game.steamAppId);
            const retainsLocalArtwork = rawItems.some(item => item && (item.iconPath || item.iconGrayPath));
            if (!normalized || normalized.items.length === rawItems.length && !retainsLocalArtwork) continue;
            if (normalized.items.length) game.achievementData = normalized;
            else delete game.achievementData;
            changed = true;
        }
        if (changed) queueSave();
        return changed;
    }

    function renderAll() {
        renderHub();
        const viewingIndex = context && typeof context.getViewingGameIndex === 'function'
            ? context.getViewingGameIndex()
            : null;
        if (Number.isInteger(viewingIndex) && viewingIndex >= 0) renderGamePanel(viewingIndex);
        if (context && typeof context.renderGames === 'function') context.renderGames();
    }

    function applyData(gameId, incoming, options = {}) {
        const game = games().find(item => String(item.id) === String(gameId));
        if (!game) return false;
        let changed = false;
        if (incoming && incoming.appId && !game.steamAppId) {
            game.steamAppId = String(incoming.appId);
            changed = true;
        }
        const current = rendererAchievementData(game.achievementData, game.steamAppId);
        const admitted = rendererAchievementData(incoming, game.steamAppId);
        const merged = rendererAchievementData(mergeAchievementData(current, admitted, game.steamAppId), game.steamAppId);
        if (merged && !achievementDataEqual(game.achievementData, merged)) {
            game.achievementData = merged;
            changed = true;
        }
        if (!changed) return false;
        if (options.persist !== false) queueSave();
        if (options.render !== false) renderAll();
        return true;
    }

    async function performLibrarySync(options = {}) {
        if (!initialized) return { updates: [], errors: [] };
        removeStoredCacheCounters();
        const requestLibraryKey = currentLibraryKey();
        const result = await ipc.invoke('achievements-set-library', {
            games: games().map(gamePayload),
            notificationsEnabled: settings().achievementNotificationsEnabled !== false,
            trackingEnabled: trackingEnabled(),
            libraryKey: requestLibraryKey,
            forceScan: options.forceScan === true
        });
        applyLocalSources(result);
        if (requestLibraryKey !== currentLibraryKey()) {
            return { ...(result || {}), updates: [], stale: true };
        }
        let changed = false;
        for (const update of result && Array.isArray(result.updates) ? result.updates : []) {
            changed = applyData(update.gameId, update.data, { persist: false, render: false }) || changed;
        }
        if (changed) {
            queueSave();
            renderAll();
        } else if (options.render !== false) {
            renderHub();
        }
        return result || { updates: [], errors: [] };
    }

    function syncLibrary(options = {}) {
        const run = () => performLibrarySync(options);
        const result = librarySyncQueue.then(run, run);
        librarySyncQueue = result.catch(() => {});
        return result;
    }

    function scheduleLibrarySync() {
        if (!initialized) return;
        clearTimeout(librarySyncTimer);
        librarySyncTimer = setTimeout(() => syncLibrary({ render: false }).catch(() => {}), 900);
    }

    async function scanAllLocal() {
        if (!trackingEnabled()) {
            setHubStatus('Achievement tracking is turned off in Settings > Social.', true);
            return;
        }
        setHubStatus('Scanning local achievement files…');
        try {
            const result = await syncLibrary({ forceScan: true });
            if (result && result.stale) {
                setHubStatus('');
                return;
            }
            const errors = result && Array.isArray(result.errors) ? result.errors.length : 0;
            setHubStatus(errors ? `Local scan finished with ${errors} game error${errors === 1 ? '' : 's'}.` : 'Local achievement scan finished.', errors > 0);
        } catch (error) {
            setHubStatus(error.message || 'Local achievement scan failed.', true);
        }
    }

    function setHubStatus(message, isError = false) {
        const element = document.getElementById('achievementHubStatus');
        if (!element) return;
        element.textContent = message || '';
        element.style.color = isError ? '#ef4444' : 'var(--accent)';
        element.style.display = message ? 'block' : 'none';
    }

    function formatDate(timestamp) {
        if (!timestamp) return '';
        try { return new Date(timestamp).toLocaleString(); } catch (_) { return ''; }
    }

    function relativeDate(timestamp) {
        const value = Number(timestamp);
        if (!Number.isFinite(value) || value <= 0) return '';
        const delta = Math.max(0, Date.now() - value);
        if (delta < 60000) return 'just now';
        if (delta < 60 * 60000) return `${Math.max(1, Math.floor(delta / 60000))}m ago`;
        if (delta < 24 * 60 * 60000) return `${Math.max(1, Math.floor(delta / (60 * 60000)))}h ago`;
        if (delta < 7 * 24 * 60 * 60000) return `${Math.max(1, Math.floor(delta / (24 * 60 * 60000)))}d ago`;
        try { return new Date(value).toLocaleDateString(); } catch (_) { return ''; }
    }

    function themedIconElement(name, ownerDocument = document) {
        const glyph = ownerDocument.createElement('span');
        glyph.className = 'app-ic';
        glyph.dataset.ic = name;
        glyph.setAttribute('aria-hidden', 'true');
        if (typeof window.paintIcons === 'function') window.paintIcons(glyph);
        return glyph;
    }

    function achievementGlyphElement(unlocked) {
        return themedIconElement(unlocked ? 'trophy' : 'lock');
    }

    function itemImageElement(item, game) {
        const fallback = SafeDom.element(document, 'span', {
            className: 'achievement-icon achievement-icon-fallback'
        }, [achievementGlyphElement(!!item.unlocked)]);
        if (item.hidden && !item.unlocked) {
            return fallback;
        }
        const image = SafeDom.element(document, 'img', { className: 'achievement-icon' });
        image.loading = 'lazy'; image.decoding = 'async'; image.alt = '';
        if (bindAchievementArtwork({ image, item, game, ipc, currentLibraryKey, SafeDom })) {
            fallback.classList.add('achievement-icon-behind');
            return SafeDom.element(document, 'span', { className: 'achievement-icon-wrap' }, [image, fallback]);
        }
        return fallback;
    }

    function displayName(item, hidden) {
        if (hidden) return 'Hidden achievement';
        const name = String(item.displayName || item.id || '').trim();
        if (/^\d+$/.test(name)) return `Achievement ${name}`;
        if (/^hidden$/i.test(name)) return item.unlocked ? 'Hidden achievement unlocked' : 'Hidden achievement';
        return name || 'Achievement';
    }

    function unlockStateElement(item) {
        if (!item.unlocked) return SafeDom.element(document, 'div', { className: 'achievement-state locked-state' }, [SafeDom.element(document, 'strong', { text: 'Locked' })]);
        const date = new Date(Number(item.unlockTime));
        const exact = Number.isFinite(date.getTime()) ? formatDate(item.unlockTime) : '';
        const state = SafeDom.element(document, 'div', { className: 'achievement-state' }, [SafeDom.element(document, 'strong', { text: 'Unlocked' })]);
        if (!exact) state.append(SafeDom.element(document, 'span', { text: 'Time unavailable' }));
        else {
            const time = SafeDom.element(document, 'time', { text: relativeDate(item.unlockTime), title: exact });
            time.dateTime = date.toISOString();
            state.append(time);
        }
        return state;
    }

    function itemRowElement(item, game, options = {}) {
        const hidden = !!(item.hidden && !item.unlocked);
        const name = displayName(item, hidden);
        const description = hidden ? 'Unlock this achievement to reveal its details.' : String(item.description || '').trim();
        const source = item.source && item.source !== 'steam' ? String(item.source).replace(/[-_]/g, ' ') : '';
        const openable = Number.isInteger(options.gameIndex);
        const row = SafeDom.element(document, 'div', {
            className: `achievement-row ${item.unlocked ? 'unlocked' : 'locked'}${openable ? ' is-openable' : ''}`
        });
        if (openable) {
            row.tabIndex = 0;
            row.dataset.achievementOpen = String(options.gameIndex);
        }
        const copy = SafeDom.element(document, 'div', { className: 'achievement-copy' }, [
            SafeDom.element(document, 'div', { className: 'achievement-name', text: name })
        ]);
        if (description) copy.append(SafeDom.element(document, 'div', { className: 'achievement-description', text: description.slice(0, 4096) }));
        const meta = [options.showGame === true ? String(game.name || '') : '', source ? `Source: ${source}` : ''].filter(Boolean).join(' · ');
        if (meta) copy.append(SafeDom.element(document, 'div', { className: 'achievement-meta', text: meta.slice(0, 1024) }));
        row.append(itemImageElement(item, game), copy, unlockStateElement(item));
        return row;
    }

    function openGameFromHub(index) {
        const game = games()[index];
        if (game) expandedGamePanels.add(String(game.id));
        if (context && typeof context.openGamePage === 'function') context.openGamePage(index);
    }

    function collectRecentUnlocks() {
        const recent = [];
        games().forEach((game, gameIndex) => {
            const data = normalizeAchievementData(game.achievementData, game.steamAppId);
            if (!data) return;
            data.items.forEach(item => {
                if (item.unlocked && item.unlockTime) recent.push({ game, gameIndex, item });
            });
        });
        return recent.sort((left, right) => right.item.unlockTime - left.item.unlockTime);
    }

    function renderImportReport() {
        const element = document.getElementById('achievementImportReport');
        if (!element) return;
        if (!lastImportReport) {
            element.style.display = 'none';
            element.replaceChildren();
            return;
        }
        const unmatched = Array.isArray(lastImportReport.unmatched) ? lastImportReport.unmatched : [];
        const errors = Array.isArray(lastImportReport.errors) ? lastImportReport.errors : [];
        const parts = [`Updated ${lastImportReport.updated || 0} game${lastImportReport.updated === 1 ? '' : 's'} from Steam.`];
        if (unmatched.length) {
            const names = unmatched.slice(0, 8).map(game => String(game.name || `App ${game.appId}`).slice(0, 256)).join(', ');
            parts.push(`${unmatched.length} owned game${unmatched.length === 1 ? '' : 's'} were not in Sail: ${names}${unmatched.length > 8 ? ', …' : ''}`);
        }
        if (errors.length) parts.push(`${errors.length} game${errors.length === 1 ? '' : 's'} could not be refreshed.`);
        element.replaceChildren(...parts.map(part => SafeDom.element(document, 'div', { text: part })));
        element.style.display = 'block';
    }

    function renderHub() {
        hubRenderFrame = null;
        const view = document.getElementById('achievementsView');
        if (!view) return;
        const notice = document.getElementById('achievementTrackingNotice');
        if (notice) {
            notice.style.display = trackingEnabled() ? 'none' : 'block';
            notice.textContent = trackingEnabled()
                ? ''
                : 'Achievement tracking is off. Sail is keeping your saved progress, but it is not watching files or contacting Steam.';
        }
        view.querySelectorAll('.achievement-page-header .achievement-actions button').forEach(button => {
            button.disabled = !trackingEnabled();
        });
        const search = String((document.getElementById('achievementSearchInput') || {}).value || '').trim().toLowerCase();
        const filter = String((document.getElementById('achievementFilterSelect') || {}).value || 'all');
        const sortSelect = document.getElementById('achievementSortSelect');
        if (sortSelect && sortSelect.value) hubSort = sortSelect.value;
        const rows = [];
        let total = 0;
        let unlocked = 0;

        games().forEach((game, gameIndex) => {
            const data = normalizeAchievementData(game.achievementData, game.steamAppId);
            if (!data || !data.items.length) return;
            const summary = summarizeAchievementData(data);
            total += summary.total;
            unlocked += summary.unlocked;
            const matchingItems = data.items.filter(item => {
                if (filter === 'unlocked' && !item.unlocked) return false;
                if (filter === 'locked' && item.unlocked) return false;
                if (!search) return true;
                return achievementSearchText(item, game.name).includes(search);
            });
            if (!matchingItems.length && (search || filter !== 'all')) return;
            rows.push({ game, gameIndex, data, summary, matchingItems });
        });

        if (hubSort === 'name') {
            rows.sort((left, right) => String(left.game.name || '').localeCompare(String(right.game.name || ''), undefined, { sensitivity: 'base' }));
        } else if (hubSort === 'completion') {
            rows.sort((left, right) => right.summary.percent - left.summary.percent || right.summary.unlocked - left.summary.unlocked || String(left.game.name || '').localeCompare(String(right.game.name || '')));
        } else if (hubSort === 'recent') {
            rows.sort((left, right) => (right.summary.latestUnlock && right.summary.latestUnlock.unlockTime || 0) - (left.summary.latestUnlock && left.summary.latestUnlock.unlockTime || 0));
        }

        const trackedGames = games().filter(game => normalizeAchievementData(game.achievementData, game.steamAppId)?.items.length).length;
        const percent = total ? Math.round(unlocked / total * 100) : 0;
        const values = {
            achievementStatGames: trackedGames,
            achievementStatUnlocked: unlocked,
            achievementStatTotal: total,
            achievementStatCompletion: `${percent}%`
        };
        Object.entries(values).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        });

        const recentElement = document.getElementById('achievementRecentList');
        if (recentElement) {
            const recent = collectRecentUnlocks().slice(0, 8);
            recentElement.replaceChildren(...(recent.length
                ? recent.map(row => itemRowElement(row.item, row.game, { showGame: true, gameIndex: row.gameIndex }))
                : [SafeDom.element(document, 'div', { className: 'achievement-empty', text: 'Your recent unlocks will show up here.' })]));
        }

        const browsePanel = document.getElementById('achievementBrowsePanel');
        const browseList = document.getElementById('achievementBrowseList');
        const browseMore = document.getElementById('achievementBrowseMore');
        const browseCollapse = document.getElementById('achievementBrowseCollapse');
        const browsable = collectBrowsableAchievements(games(), { search, filter, sort: hubSort === 'completion' ? 'recent' : hubSort });
        const paged = pageAchievements(browsable, browseLimit);
        if (browseList) {
            browseList.replaceChildren(...(paged.shown.length
                ? paged.shown.map(row => itemRowElement(row.item, row.game, { showGame: true, gameIndex: row.gameIndex }))
                : [SafeDom.element(document, 'div', {
                    className: 'achievement-empty',
                    text: search || filter !== 'all' ? 'No achievements match this search or filter.' : 'Unlocks and locked achievements from your library will show up here after a local scan.'
                })]));
        }
        if (browseMore) {
            browseMore.hidden = paged.remaining <= 0;
            browseMore.textContent = paged.remaining > 0 ? `Show more (${paged.remaining} remaining)` : '';
        }
        if (browseCollapse) browseCollapse.hidden = browseLimit <= BROWSE_PAGE;

        const grid = document.getElementById('achievementGameGrid');
        if (grid) {
            const cards = rows.map(row => {
                const artwork = gameArtwork(row.game);
                const card = SafeDom.element(document, 'article', { className: 'achievement-game-card' });
                card.tabIndex = 0;
                card.setAttribute('role', 'button');
                card.dataset.achievementOpen = String(row.gameIndex);
                const art = SafeDom.element(document, 'div', { className: 'achievement-game-art' });
                if (artwork) {
                    const image = SafeDom.element(document, 'img');
                    image.alt = '';
                    SafeDom.setImageSource(image, artwork, { allowFile: true, allowSteam: true, allowData: true, maxDataLength: 2 * 1024 * 1024 });
                    art.append(image);
                }
                const fill = SafeDom.element(document, 'div', { className: 'achievement-progress-fill' });
                fill.style.width = `${Math.max(0, Math.min(100, Number(row.summary.percent) || 0))}%`;
                card.append(art, SafeDom.element(document, 'div', { className: 'achievement-game-body' }, [
                    SafeDom.element(document, 'h3', { className: 'achievement-game-title', text: String(row.game.name || '').slice(0, 256) }),
                    SafeDom.element(document, 'div', { className: 'achievement-progress-track' }, [fill]),
                    SafeDom.element(document, 'div', { className: 'achievement-game-progress' }, [
                        SafeDom.element(document, 'span', { text: `${row.summary.unlocked} / ${row.summary.total} unlocked` }),
                        SafeDom.element(document, 'strong', { text: `${row.summary.percent}%` })
                    ])
                ]));
                return card;
            });
            grid.replaceChildren(...(cards.length ? cards : [SafeDom.element(document, 'div', {
                className: 'achievement-empty',
                text: 'No games match this view. Scan local files or add a local source from a game page.'
            })]));
        }
        applyHubView(false);
        renderImportReport();
        queueMissingSteamSchema();
        scheduleBackToTopUpdate();
    }

    function applyHubView(animate) {
        const browsePanel = document.getElementById('achievementBrowsePanel');
        const grid = document.getElementById('achievementGameGrid');
        const reduceMotion = document.body.classList.contains('reduce-motion');
        const useMotion = animate !== false && !reduceMotion && !document.body.classList.contains('less-animations');
        document.querySelectorAll('[data-hub-view]').forEach(button => {
            button.classList.toggle('active', button.dataset.hubView === hubView);
            button.setAttribute('aria-pressed', button.dataset.hubView === hubView ? 'true' : 'false');
        });
        [browsePanel, grid].forEach(pane => {
            if (!pane) return;
            const active = pane === browsePanel ? hubView === 'browse' : hubView === 'games';
            pane.hidden = false;
            pane.classList.toggle('hub-view-animate', useMotion);
            pane.classList.toggle('hub-view-active', active);
            pane.setAttribute('aria-hidden', active ? 'false' : 'true');
        });
    }

    function switchHubView(nextView) {
        const next = nextView === 'games' ? 'games' : 'browse';
        if (next === hubView) return;
        hubView = next;
        applyHubView(true);
    }

    function scheduleHubRender() {
        if (hubRenderFrame !== null) cancelAnimationFrame(hubRenderFrame);
        hubRenderFrame = requestAnimationFrame(renderHub);
    }

    function updateBackToTopButton() {
        backToTopFrame = null;
        const button = document.getElementById('achievementBackToTop');
        const scroller = document.getElementById('mainScroller');
        const search = document.getElementById('achievementSearchInput');
        const view = document.getElementById('achievementsView');
        if (!button || !scroller || !search || !view) return;
        const scrollerRect = scroller.getBoundingClientRect();
        const searchIsAboveView = search.getBoundingClientRect().bottom <= scrollerRect.top;
        const achievementsAreVisible = getComputedStyle(view).display !== 'none';
        button.hidden = !achievementsAreVisible || !searchIsAboveView;
        if (!button.hidden) {
            button.style.right = `${Math.max(18, window.innerWidth - scrollerRect.right + 18)}px`;
        }
    }

    function scheduleBackToTopUpdate() {
        if (backToTopFrame !== null) return;
        backToTopFrame = requestAnimationFrame(updateBackToTopButton);
    }

    function scrollAchievementsToTop() {
        const scroller = document.getElementById('mainScroller');
        const search = document.getElementById('achievementSearchInput');
        if (!scroller) return;
        const useMotion = !document.body.classList.contains('reduce-motion')
            && !document.body.classList.contains('less-animations');
        let focused = false;
        const focusSearch = () => {
            if (focused) return;
            focused = true;
            if (search) search.focus({ preventScroll: true });
            scheduleBackToTopUpdate();
        };
        scroller.scrollTo({ top: 0, behavior: useMotion ? 'smooth' : 'auto' });
        if (!useMotion) focusSearch();
        else {
            scroller.addEventListener('scrollend', focusSearch, { once: true });
            setTimeout(focusSearch, 500);
        }
    }

    function steamCredentialsReady() {
        const current = settings();
        return !!String(current.steamApiKey || '').trim() && /^\d{17}$/.test(String(current.steamId || '').trim());
    }

    function steamApiKeyReady() {
        return !!String(settings().steamApiKey || '').trim();
    }

    function gameSteamAppId(game) {
        return String((game && game.steamAppId) || (game && game.achievementData && game.achievementData.appId) || '').trim();
    }

    function missingMetadataCount(data) {
        if (!data) return 0;
        return data.items.filter(item => !item.hidden && (
            !(item.icon || item.iconPath) || !item.description || String(item.displayName || '').trim().toLowerCase() === String(item.id || '').trim().toLowerCase()
        )).length;
    }

    async function enrichSteamSchema(gameIndex, options = {}) {
        const silent = options.silent !== false;
        const game = games()[gameIndex];
        const appId = gameSteamAppId(game);
        if (!game || !trackingEnabled() || !appId) return null;
        const requestLibraryKey = currentLibraryKey();
        const payloadGame = { ...gamePayload(game), steamAppId: appId };
        try {
            const result = await ipc.invoke('achievements-import-steam-schema', {
                games: [payloadGame],
                gameIds: [String(game.id)],
                libraryKey: requestLibraryKey,
                steamApiKey: settings().steamApiKey,
                language: settings().language || 'english'
            });
            if ((result && result.stale) || requestLibraryKey !== currentLibraryKey()) return result;
            if (result && result.updates) {
                for (const update of result.updates) applyData(update.gameId, update.data, { persist: true, render: options.render !== false });
            }
            return result;
        } catch (error) {
            if (!silent && window.sailAlert) await window.sailAlert(error.message || 'Steam achievement details could not be loaded.');
            return { updates: [], errors: [{ error: error.message || 'Steam achievement details could not be loaded.' }] };
        }
    }

    function maybeEnrichFromSteam(gameIndex, data) {
        const game = games()[gameIndex];
        const appId = gameSteamAppId(game);
        if (!game || !trackingEnabled() || !appId) return;
        const key = `${currentLibraryKey()}:${game.id}`;
        if (steamEnrichmentAttempts.has(key)) return;
        if (data && data.items.length && !missingMetadataCount(data)) return;
        steamEnrichmentAttempts.add(key);
        steamEnrichmentInFlight.add(key);
        setTimeout(() => {
            enrichSteamSchema(gameIndex, { silent: true, render: true }).catch(() => {}).finally(() => {
                steamEnrichmentInFlight.delete(key);
                if (context && context.getViewingGameIndex && context.getViewingGameIndex() === gameIndex) renderGamePanel(gameIndex);
            });
        }, 80);
    }

    function queueMissingSteamSchema() {
        if (!trackingEnabled() || steamSchemaQueueTimer || steamSchemaBatchPending) return;
        steamSchemaQueueTimer = setTimeout(async () => {
            steamSchemaQueueTimer = null;
            steamSchemaBatchPending = true;
            let shouldRender = false;
            const targetKeys = [];
            try {
                await librarySyncQueue.catch(() => {});
                const requestLibraryKey = currentLibraryKey();
                const targets = games().map((game, gameIndex) => {
                    const appId = gameSteamAppId(game);
                    if (!game || !appId) return null;
                    const data = normalizeAchievementData(game.achievementData, appId);
                    const key = `${requestLibraryKey}:${game.id}`;
                    if (steamEnrichmentAttempts.has(key)
                        || data && data.items.length && !missingMetadataCount(data)) return null;
                    return { game, appId, gameIndex, key };
                }).filter(Boolean);
                if (!targets.length) return;

                for (const target of targets) {
                    steamEnrichmentAttempts.add(target.key);
                    steamEnrichmentInFlight.add(target.key);
                    targetKeys.push(target.key);
                }
                shouldRender = targets.some(target => context && context.getViewingGameIndex
                    && context.getViewingGameIndex() === target.gameIndex);
                const result = await ipc.invoke('achievements-import-steam-schema', {
                    games: targets.map(target => ({ ...gamePayload(target.game), steamAppId: target.appId })),
                    gameIds: targets.map(target => String(target.game.id)),
                    libraryKey: requestLibraryKey,
                    steamApiKey: settings().steamApiKey,
                    language: settings().language || 'english'
                });
                if ((result && result.stale) || requestLibraryKey !== currentLibraryKey()) return;
                let changed = false;
                for (const update of result && Array.isArray(result.updates) ? result.updates : []) {
                    changed = applyData(update.gameId, update.data, { persist: false, render: false }) || changed;
                }
                if (changed) queueSave();
                shouldRender = changed || shouldRender;
            } catch (_) {
            } finally {
                for (const key of targetKeys) steamEnrichmentInFlight.delete(key);
                steamSchemaBatchPending = false;
                if (shouldRender) renderAll();
            }
        }, 80);
    }

    function renderGamePanel(gameIndex) {
        const panel = document.getElementById('gpAchievementsPanel');
        const game = games()[gameIndex];
        if (!panel || !game) return;
        panel.style.display = '';
        const gameKey = String(game.id);
        const data = normalizeAchievementData(game.achievementData, game.steamAppId);
        const summary = summarizeAchievementData(data);
        const sources = Array.isArray(game.achievementSources) ? game.achievementSources : [];
        const expanded = expandedGamePanels.has(gameKey);
        const filter = gamePanelFilters.get(gameKey) || 'all';
        const sortedItems = data ? [...data.items].sort((left, right) => {
            if (left.unlocked !== right.unlocked) return left.unlocked ? -1 : 1;
            return (right.unlockTime || 0) - (left.unlockTime || 0) || String(left.displayName || '').localeCompare(String(right.displayName || ''));
        }) : [];
        const visibleItems = sortedItems.filter(item => filter === 'all' || filter === 'unlocked' && item.unlocked || filter === 'locked' && !item.unlocked);
        const previewItems = sortedItems.filter(item => item.unlocked).slice(0, 4);
        const lastRefresh = Math.max(data && data.lastSteamRefreshAt || 0, data && data.lastLocalScanAt || 0);
        const metadataMissing = missingMetadataCount(data);
        const enrichmentKey = `${currentLibraryKey()}:${game.id}`;
        let metadataNotice = null;
        if (steamEnrichmentInFlight.has(enrichmentKey)) {
            metadataNotice = { className: 'achievement-metadata-note is-loading', text: 'Filling in official Steam titles and artwork…' };
        } else if (metadataMissing) {
            metadataNotice = {
                className: 'achievement-metadata-note',
                text: `${metadataMissing} achievement${metadataMissing === 1 ? '' : 's'} still use the emulator’s internal IDs. Sail is matching them to official Steam names and icons${steamApiKeyReady() ? ' with your Web API key' : ' from Steam’s public achievement list'}.`
            };
        }
        const summaryLine = summary.total
            ? `${summary.unlocked} of ${summary.total} unlocked · ${summary.percent}% complete`
            : trackingEnabled() ? 'No achievement data found yet' : 'Tracking is off · saved progress is preserved';
        const bodyId = `gpAchievementBody-${gameKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)}`;
        const shell = SafeDom.element(document, 'div', { className: `gp-achievement-shell ${expanded ? 'is-expanded' : ''}` });
        const summaryButton = SafeDom.element(document, 'button', { className: 'gp-achievement-summary', type: 'button' });
        summaryButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        summaryButton.setAttribute('aria-controls', bodyId);
        const progressFill = SafeDom.element(document, 'span');
        progressFill.style.width = `${Math.max(0, Math.min(100, Number(summary.percent) || 0))}%`;
        const preview = SafeDom.element(document, 'span', { className: 'gp-achievement-preview-icons' });
        preview.setAttribute('aria-hidden', 'true');
        preview.append(...previewItems.map(item => itemImageElement(item, game)));
        summaryButton.append(
            SafeDom.element(document, 'span', { className: 'gp-achievement-emblem' }, [achievementGlyphElement(true)]),
            SafeDom.element(document, 'span', { className: 'gp-achievement-summary-copy' }, [
                SafeDom.element(document, 'span', { className: 'gp-achievement-eyebrow', text: 'Achievements' }),
                SafeDom.element(document, 'strong', { text: summaryLine }),
                SafeDom.element(document, 'span', { className: 'gp-achievement-mini-track' }, [progressFill])
            ]),
            preview,
            SafeDom.element(document, 'span', { className: 'gp-achievement-caret', text: '⌄' })
        );
        const body = SafeDom.element(document, 'div', { className: 'gp-achievement-body', id: bodyId });
        body.hidden = !expanded;
        if (!trackingEnabled()) {
            body.append(SafeDom.element(document, 'div', { className: 'achievement-tracking-off' }, [
                SafeDom.element(document, 'strong', { text: 'Achievement tracking is off.' }),
                SafeDom.element(document, 'span', { text: 'Saved unlocks stay visible, but Sail is not scanning files or contacting Steam.' })
            ]));
        }
        const filterGroup = SafeDom.element(document, 'div', { className: 'achievement-filter-group', ariaLabel: 'Filter achievements' });
        filterGroup.setAttribute('role', 'group');
        for (const value of ['all', 'unlocked', 'locked']) {
            const label = value === 'all' ? `All ${summary.total}` : value === 'unlocked' ? `Unlocked ${summary.unlocked}` : `Locked ${summary.locked}`;
            const button = SafeDom.element(document, 'button', { type: 'button', className: `achievement-filter ${filter === value ? 'active' : ''}`, text: label });
            button.dataset.achievementFilter = value;
            button.setAttribute('aria-pressed', filter === value ? 'true' : 'false');
            filterGroup.append(button);
        }
        const actions = SafeDom.element(document, 'div', { className: 'gp-achievement-actions' });
        const addAction = (value, label) => {
            const button = SafeDom.element(document, 'button', { className: 'outline', type: 'button', text: label });
            button.dataset.achievementAction = value;
            actions.append(button);
        };
        if (gameSteamAppId(game)) addAction('steam', 'Steam details');
        addAction('local', 'Rescan');
        addAction('source', 'Add source');
        body.append(SafeDom.element(document, 'div', { className: 'gp-achievement-toolbar' }, [filterGroup, actions]));
        if (metadataNotice) body.append(SafeDom.element(document, 'div', metadataNotice));
        const sourceList = SafeDom.element(document, 'div', { className: 'achievement-sources' });
        if (sources.length) {
            for (const source of sources.slice(0, 128)) {
                const label = String(source.label || (source.kind === 'folder' ? 'Achievement folder' : 'Achievement file')).slice(0, 256);
                const pending = source.state === 'pending-review';
                const sourceAction = SafeDom.element(document, 'button', {
                    className: pending ? 'achievement-source-review' : 'achievement-source-remove',
                    type: 'button',
                    title: pending ? 'Review source' : 'Remove source',
                    text: pending ? 'Review' : '×'
                });
                sourceAction.dataset.sourceId = String(source.id || '').slice(0, 128);
                sourceList.append(SafeDom.element(document, 'span', { className: 'achievement-source-chip' }, [
                    SafeDom.element(document, 'span', { title: 'Local achievement source', text: label }), sourceAction
                ]));
            }
        } else {
            sourceList.append(SafeDom.element(document, 'span', {
                className: 'achievement-meta',
                text: trackingEnabled() ? 'Supported local achievement folders are watched automatically.' : 'Local achievement folders are not being watched.'
            }));
        }
        body.append(sourceList);
        const itemList = SafeDom.element(document, 'div', { className: 'gp-achievement-list' });
        if (visibleItems.length) itemList.append(...visibleItems.map(item => itemRowElement(item, game)));
        else itemList.append(SafeDom.element(document, 'div', {
            className: 'achievement-empty',
            text: sortedItems.length ? 'No achievements match this filter.' : trackingEnabled() ? 'Launch the game, scan local files, or add a local source.' : 'Turn tracking back on in Settings → Social to scan for achievements.'
        }));
        body.append(itemList, SafeDom.element(document, 'div', { className: 'gp-achievement-footer' }, [
            SafeDom.element(document, 'span', { text: lastRefresh ? `Last updated ${relativeDate(lastRefresh)}` : 'Not scanned yet' }),
            SafeDom.element(document, 'span', { text: `${summary.unlocked} unlocked · ${summary.locked} locked` })
        ]));
        shell.append(summaryButton, body);
        panel.replaceChildren(shell);
        panel.querySelector('.gp-achievement-summary')?.addEventListener('click', () => {
            if (expanded) expandedGamePanels.delete(gameKey); else expandedGamePanels.add(gameKey);
            renderGamePanel(gameIndex);
        });
        panel.querySelectorAll('[data-achievement-filter]').forEach(button => {
            button.addEventListener('click', () => {
                gamePanelFilters.set(gameKey, button.dataset.achievementFilter || 'all');
                renderGamePanel(gameIndex);
            });
        });
        panel.querySelectorAll('[data-achievement-action]').forEach(button => {
            button.disabled = !trackingEnabled();
            button.addEventListener('click', () => {
                if (button.dataset.achievementAction === 'steam') enrichSteamSchema(gameIndex, { silent: false, render: true });
                else if (button.dataset.achievementAction === 'local') refreshLocal(gameIndex);
                else addSource(gameIndex);
            });
        });
        panel.querySelectorAll('.achievement-source-remove').forEach(button => {
            button.disabled = !trackingEnabled();
            button.addEventListener('click', () => removeSource(gameIndex, button.dataset.sourceId || ''));
        });
        panel.querySelectorAll('.achievement-source-review').forEach(button => {
            button.disabled = !trackingEnabled();
            button.addEventListener('click', () => reviewSource(gameIndex, button.dataset.sourceId || ''));
        });
        maybeEnrichFromSteam(gameIndex, data);
    }

    function progressBadgeElement(document, game) {
        if (settings().achievementCardBadgesEnabled === false) return null;
        const summary = summarizeAchievementData(game && game.achievementData);
        if (!summary.total) return null;
        const badge = document.createElement('span');
        badge.className = 'achievement-card-badge';
        badge.title = `${summary.unlocked} of ${summary.total} achievements unlocked`;
        const marker = themedIconElement('trophy', document);
        const count = document.createElement('span');
        count.textContent = `${summary.unlocked}/${summary.total}`;
        badge.append(marker, count);
        return badge;
    }

    async function refreshLocal(gameIndex) {
        const game = games()[gameIndex];
        if (!game) return;
        if (!trackingEnabled()) {
            if (window.sailAlert) await window.sailAlert('Achievement tracking is turned off in Settings > Social.');
            return;
        }
        const requestLibraryKey = currentLibraryKey();
        setHubStatus(`Scanning ${game.name} for achievement files…`);
        try {
            const result = await ipc.invoke('achievements-refresh-local', {
                gameId: game.id,
                libraryKey: requestLibraryKey
            });
            applyLocalSources(result);
            if ((result && result.stale) || requestLibraryKey !== currentLibraryKey()) {
                setHubStatus('');
                return;
            }
            if (result && result.data) applyData(game.id, result.data);
            const errorCount = result && Array.isArray(result.errors) ? result.errors.length : 0;
            setHubStatus(errorCount ? `Scan finished with ${errorCount} unreadable source${errorCount === 1 ? '' : 's'}.` : `Finished scanning ${game.name}.`, errorCount > 0);
        } catch (error) {
            setHubStatus(error.message || 'Local achievement scan failed.', true);
            if (window.sailAlert) await window.sailAlert(error.message || 'Local achievement scan failed.');
        }
    }

    async function refreshSteam(gameIndex = null, options = {}) {
        const silent = options.silent === true;
        if (!trackingEnabled()) {
            if (!silent && window.sailAlert) await window.sailAlert('Achievement tracking is turned off in Settings > Social.');
            return { updates: [], errors: [], disabled: true };
        }
        const currentSettings = settings();
        if (!steamCredentialsReady()) {
            if (!silent && window.sailAlert) await window.sailAlert('Local achievement tracking does not need Steam details. The optional Steam account import uses the Web API key and SteamID64 from Settings > Social.');
            return { updates: [], errors: [], optionalCredentialsMissing: true };
        }
        const steamGames = games().filter(game => game.steamAppId);
        if (!steamGames.length) {
            if (!silent && window.sailAlert) await window.sailAlert('Add a game with a Steam App ID first.');
            return;
        }
        const selected = Number.isInteger(gameIndex) && games()[gameIndex] ? [String(games()[gameIndex].id)] : null;
        const label = selected ? games()[gameIndex].name : 'your Steam library';
        const requestLibraryKey = currentLibraryKey();
        if (!silent) setHubStatus(`Importing achievements from ${label}…`);
        try {
            const result = await ipc.invoke('achievements-import-steam', {
                games: steamGames.map(gamePayload),
                gameIds: selected,
                libraryKey: requestLibraryKey,
                steamApiKey: currentSettings.steamApiKey,
                steamId: currentSettings.steamId,
                language: currentSettings.language || 'english'
            });
            if ((result && result.stale) || requestLibraryKey !== currentLibraryKey()) {
                if (!silent) setHubStatus('');
                return;
            }
            let changed = false;
            for (const update of result.updates || []) changed = applyData(update.gameId, update.data, { persist: false, render: false }) || changed;
            if (changed) queueSave();
            if (!silent) lastImportReport = { updated: (result.updates || []).length, unmatched: result.unmatched || [], errors: result.errors || [] };
            renderAll();
            if (!silent) setHubStatus(`Steam import finished: ${(result.updates || []).length} game${(result.updates || []).length === 1 ? '' : 's'} updated.`, (result.errors || []).length > 0);
            return result;
        } catch (error) {
            if (!silent) {
                setHubStatus(error.message || 'Steam achievement import failed.', true);
                if (window.sailAlert) await window.sailAlert(error.message || 'Steam achievement import failed.');
            }
            return { updates: [], errors: [{ error: error.message || 'Steam achievement import failed.' }] };
        }
    }

    async function addSource(gameIndex) {
        const game = games()[gameIndex];
        if (!game) return;
        if (!trackingEnabled()) {
            if (window.sailAlert) await window.sailAlert('Achievement tracking is turned off in Settings > Social.');
            return;
        }
        const kind = typeof window.sailChoice === 'function'
            ? await window.sailChoice('Choose whether to attach one achievement file or watch an achievement folder.', [
                { value: 'file', label: 'Choose a file', description: 'Attach a JSON, INI, CFG, TXT, or Steam schema source.', icon: 'file' },
                { value: 'folder', label: 'Choose a folder', description: 'Watch a folder for supported achievement files.', icon: 'folder' }
            ], { title: 'Add achievement source', eyebrow: 'Achievements' })
            : 'file';
        if (!kind) return;
        const picked = await ipc.invoke('achievements-pick-source', { gameId: String(game.id), kind });
        if (!picked || picked.canceled || !picked.source) return;
        if (!Array.isArray(game.achievementSources)) game.achievementSources = [];
        game.achievementSources.push(picked.source);
        await syncLibrary({ render: false });
        await refreshLocal(gameIndex);
        renderGamePanel(gameIndex);
    }

    async function reviewSource(gameIndex, sourceId) {
        const game = games()[gameIndex];
        const source = game && Array.isArray(game.achievementSources)
            ? game.achievementSources.find(item => String(item.id) === String(sourceId))
            : null;
        if (!source || !source.capabilityId || !Number.isSafeInteger(source.expectedRevision)) return;
        const reviewed = await ipc.invoke('achievements-review-source', {
            gameId: String(game.id),
            capabilityId: source.capabilityId,
            expectedRevision: source.expectedRevision
        });
        if (!reviewed || reviewed.canceled || !reviewed.source) return;
        game.achievementSources = game.achievementSources.map(item => String(item.id) === String(sourceId) ? reviewed.source : item);
        await syncLibrary({ forceScan: true, render: false });
        renderGamePanel(gameIndex);
    }

    async function removeSource(gameIndex, sourceId) {
        const game = games()[gameIndex];
        if (!game || !Array.isArray(game.achievementSources)) return;
        const source = game.achievementSources.find(item => String(item.id) === String(sourceId));
        if (!source || !source.capabilityId || !Number.isSafeInteger(source.expectedRevision)) return;
        if (window.sailConfirm && !(await window.sailConfirm('Remove this local achievement source? Existing tracked progress will stay in your library.'))) return;
        await ipc.invoke('achievements-remove-source', {
            gameId: String(game.id),
            capabilityId: source.capabilityId,
            expectedRevision: source.expectedRevision
        });
        game.achievementSources = game.achievementSources.filter(source => String(source.id) !== String(sourceId));
        await syncLibrary({ render: false });
        renderGamePanel(gameIndex);
    }

    function removeToast(element) {
        if (!element || !element.isConnected) return;
        element.classList.add('leaving');
        setTimeout(() => element.remove(), 260);
    }

    function showUnlockToasts(game, achievements) {
        if (!trackingEnabled() || settings().achievementNotificationsEnabled === false) return;
        const stack = document.getElementById('achievementToastStack');
        if (!stack) return;
        for (const item of achievements.slice(0, 3)) {
            const toast = document.createElement('div');
            toast.className = 'achievement-toast';
            toast.setAttribute('role', 'status');
            const close = SafeDom.element(document, 'button', { className: 'achievement-toast-close', type: 'button', ariaLabel: 'Dismiss', text: '×' });
            close.addEventListener('click', () => removeToast(toast));
            toast.append(
                itemImageElement({ ...item, unlocked: true }, game),
                SafeDom.element(document, 'div', { className: 'achievement-toast-copy' }, [
                    SafeDom.element(document, 'strong', { text: 'Achievement unlocked' }),
                    SafeDom.element(document, 'span', { text: String(item.displayName || item.id || '').slice(0, 512) }),
                    SafeDom.element(document, 'small', { text: String(game.name || '').slice(0, 256) })
                ]),
                close
            );
            stack.appendChild(toast);
            setTimeout(() => removeToast(toast), 6500);
        }
    }

    function handleUpdate(payload) {
        if (!initialized) {
            pendingEvents.push(payload);
            return;
        }
        if (payload.libraryKey && String(payload.libraryKey) !== currentLibraryKey()) return;
        const game = games().find(item => String(item.id) === String(payload.gameId));
        if (!game) return;
        applyData(payload.gameId, payload.data);
        if (payload.launcherVisible && Array.isArray(payload.newlyUnlocked) && payload.newlyUnlocked.length) {
            showUnlockToasts(game, payload.newlyUnlocked);
        }
    }

    function bindHub() {
        if (bound) return;
        bound = true;
        const view = document.getElementById('achievementsView');
        const search = document.getElementById('achievementSearchInput');
        const filter = document.getElementById('achievementFilterSelect');
        const sort = document.getElementById('achievementSortSelect');
        const browseMore = document.getElementById('achievementBrowseMore');
        const browseCollapse = document.getElementById('achievementBrowseCollapse');
        const backToTop = document.getElementById('achievementBackToTop');
        const mainScroller = document.getElementById('mainScroller');
        if (search) {
            search.addEventListener('input', () => {
                clearTimeout(hubSearchTimer);
                hubSearchTimer = setTimeout(() => {
                    browseLimit = BROWSE_PAGE;
                    scheduleHubRender();
                }, 140);
            });
        }
        if (filter) filter.addEventListener('change', () => { browseLimit = BROWSE_PAGE; scheduleHubRender(); });
        if (sort) {
            const updateSort = () => {
                hubSort = sort.value || 'recent';
                browseLimit = BROWSE_PAGE;
                scheduleHubRender();
            };
            sort.addEventListener('input', updateSort);
            sort.addEventListener('change', updateSort);
        }
        document.querySelectorAll('[data-hub-view]').forEach(button => {
            button.addEventListener('click', () => switchHubView(button.dataset.hubView));
        });
        if (browseMore) {
            browseMore.addEventListener('click', () => {
                browseLimit += BROWSE_PAGE;
                renderHub();
            });
        }
        if (browseCollapse) {
            browseCollapse.addEventListener('click', () => {
                browseLimit = BROWSE_PAGE;
                renderHub();
            });
        }
        if (backToTop) backToTop.addEventListener('click', scrollAchievementsToTop);
        if (mainScroller) mainScroller.addEventListener('scroll', scheduleBackToTopUpdate, { passive: true });
        window.addEventListener('resize', scheduleBackToTopUpdate);
        if (view) {
            view.addEventListener('click', event => {
                const target = event.target.closest('[data-achievement-open]');
                if (!target || !view.contains(target)) return;
                const index = Number(target.getAttribute('data-achievement-open'));
                if (Number.isInteger(index)) window.achievementOpenGame(index);
            });
            view.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                const target = event.target.closest('[data-achievement-open]');
                if (!target || !view.contains(target)) return;
                event.preventDefault();
                const index = Number(target.getAttribute('data-achievement-open'));
                if (Number.isInteger(index)) window.achievementOpenGame(index);
            });
        }
    }

    async function initialize(nextContext) {
        context = nextContext;
        initialized = true;
        removeStoredCacheCounters();
        bindHub();
        await ipc.invoke('achievements-set-preferences', {
            notificationsEnabled: settings().achievementNotificationsEnabled !== false,
            trackingEnabled: trackingEnabled()
        });
        syncLibrary().catch(() => {});
        while (pendingEvents.length) handleUpdate(pendingEvents.shift());
        renderHub();
    }

    async function setNotifications(enabled) {
        await ipc.invoke('achievements-set-preferences', { notificationsEnabled: enabled !== false });
    }

    async function setTracking(enabled) {
        await ipc.invoke('achievements-set-preferences', { trackingEnabled: enabled !== false });
        await syncLibrary({ forceScan: enabled !== false, render: false });
        renderAll();
    }

    ipc.on('achievements-updated', (_event, payload) => handleUpdate(payload || {}));

    window.SailAchievements = {
        addSource,
        initialize,
        progressBadgeElement,
        refreshLocal,
        refreshSteam,
        removeSource,
        renderGamePanel,
        renderHub,
        scanAllLocal,
        scheduleLibrarySync,
        setNotifications,
        setTracking,
        syncLibrary
    };
    window.achievementAddSource = addSource;
    window.achievementRefreshLocal = refreshLocal;
    window.achievementRefreshSteam = refreshSteam;
    window.achievementRemoveSource = removeSource;
    window.achievementOpenGame = openGameFromHub;
})();
