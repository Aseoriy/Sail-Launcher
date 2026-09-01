'use strict';

const fs = require('fs');
const path = require('path');
const {
    achievementDataEqual,
    diffNewUnlocks,
    mergeAchievementData,
    normalizeAchievementData
} = require('./achievementLogic');
const {
    achievementWatchDirectories,
    discoverAchievementFiles,
    findSteamRoot,
    normalizedPath,
    resolveApprovedPath,
    resolveGameAppId
} = require('./achievementDiscovery');
const { readAchievementFile } = require('./achievementParsers');
const { importSteamAchievements, importSteamSchema } = require('./steamAchievements');

function safeGame(game = {}) {
    return {
        id: String(game.id || ''),
        name: String(game.name || 'Unknown game'),
        steamAppId: game.steamAppId ? String(game.steamAppId) : '',
        exePath: typeof game.exePath === 'string' ? game.exePath : '',
        installFolder: typeof game.installFolder === 'string' ? game.installFolder : '',
        steamImageUrl: typeof game.steamImageUrl === 'string' ? game.steamImageUrl : '',
        steamRoot: typeof game.steamRoot === 'string' ? game.steamRoot : '',
        localAuthorityVersion: typeof game.localAuthorityVersion === 'string'
            ? game.localAuthorityVersion.slice(0, 16384)
            : '',
        localScanConfigured: game.localScanConfigured === true,
        allowSteamData: game.allowSteamData === true,
        approvedRoots: Array.isArray(game.approvedRoots)
            ? game.approvedRoots.filter(root => root && typeof root.path === 'string'
                && (root.kind === 'file' || root.kind === 'directory')).map(root => ({
                path: String(root.path), kind: root.kind,
                ...(root.dev !== undefined ? { dev: String(root.dev) } : {}),
                ...(root.ino !== undefined ? { ino: String(root.ino) } : {}),
                ...(Number.isFinite(root.birthtimeMs) ? { birthtimeMs: Number(root.birthtimeMs) } : {})
            }))
            : [],
        achievementSources: Array.isArray(game.achievementSources)
            ? game.achievementSources.filter(source => source && source.path).map(source => ({
                id: String(source.id || ''),
                kind: source.kind === 'folder' ? 'folder' : 'file',
                path: String(source.path),
                enabled: source.enabled !== false
            }))
            : [],
        achievementData: normalizeAchievementData(game.achievementData, game.steamAppId)
    };
}

function rendererAchievementData(data, fallbackAppId = '') {
    const normalized = normalizeAchievementData(data, fallbackAppId);
    if (!normalized) return null;
    return {
        ...normalized,
        items: normalized.items.map(item => {
            const { iconPath, iconGrayPath, ...portableItem } = item;
            return portableItem;
        })
    };
}

function rendererAchievementItems(items = []) {
    return (Array.isArray(items) ? items : []).map(item => {
        const { iconPath, iconGrayPath, ...portableItem } = item || {};
        return portableItem;
    });
}

function rasterMimeType(bytes) {
    if (!Buffer.isBuffer(bytes)) return '';
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return '';
}

function signatureForFiles(files, fileSystem = fs, approvedRoots = null) {
    const rows = [];
    for (const candidate of files) {
        try {
            const approvedPath = approvedRoots
                ? resolveApprovedPath(candidate.path, { fs: fileSystem, approvedRoots }, 'file')
                : candidate.path;
            if (!approvedPath) continue;
            const stat = fileSystem.statSync(approvedPath);
            rows.push(`${normalizedPath(approvedPath)}:${stat.size}:${Math.round(stat.mtimeMs)}`);
        } catch (_) {}
    }
    return rows.sort().join('|');
}

function watchConfigurationKey(game) {
    return JSON.stringify({
        steamAppId: game.steamAppId,
        exePath: game.exePath,
        installFolder: game.installFolder,
        localAuthorityVersion: game.localAuthorityVersion,
        achievementSources: game.achievementSources
    });
}

function steamAppIdChanged(previousGame, nextGame) {
    return !!(previousGame && nextGame && previousGame.steamAppId && nextGame.steamAppId
        && String(previousGame.steamAppId) !== String(nextGame.steamAppId));
}

function isLauncherForeground(win) {
    if (!win || typeof win.isVisible !== 'function' || !win.isVisible()) return false;
    if (typeof win.isMinimized === 'function' && win.isMinimized()) return false;
    return typeof win.isFocused !== 'function' || win.isFocused();
}

class AchievementService {
    constructor(options = {}) {
        this.app = options.app;
        this.BrowserWindow = options.BrowserWindow;
        this.Notification = options.Notification;
        this.dialog = options.dialog;
        this.fs = options.fs || fs;
        this.resolveLocalAuthority = typeof options.resolveLocalAuthority === 'function'
            ? options.resolveLocalAuthority
            : null;
        this.games = new Map();
        this.baselines = new Map();
        this.signatures = new Map();
        this.watchers = new Map();
        this.refreshTimers = new Map();
        this.notificationsEnabled = true;
        this.trackingEnabled = true;
        this.libraryKey = '';
        this.disposed = false;
        this.steamRoot = Object.prototype.hasOwnProperty.call(options, 'steamRoot')
            ? options.steamRoot
            : findSteamRoot({ fs: this.fs });
        this.documentsPath = Object.prototype.hasOwnProperty.call(options, 'documentsPath')
            ? options.documentsPath
            : this.app && typeof this.app.getPath === 'function' ? this.app.getPath('documents') : '';
        this.fallbackCursor = 0;
        this.fallbackTimer = setInterval(() => this.fallbackScan(), 30000);
        if (this.fallbackTimer.unref) this.fallbackTimer.unref();
    }

    discoveryOptions(game = {}) {
        const approvedRoots = Array.isArray(game.approvedRoots) ? game.approvedRoots.slice() : [];
        const steamRoot = game.allowSteamData === true ? String(game.steamRoot || '') : '';
        return {
            fs: this.fs,
            steamRoot,
            documentsPath: this.documentsPath,
            allowKnownLocations: false,
            allowSteamData: game.allowSteamData === true,
            approvedRoots
        };
    }

    resolveScanGame(game) {
        if (!this.resolveLocalAuthority) return game;
        const local = this.resolveLocalAuthority({ gameId: game.id, libraryKey: this.libraryKey });
        if (!local || typeof local !== 'object' || typeof local.then === 'function') {
            throw new Error('Local achievement authority could not be validated.');
        }
        return safeGame({
            ...game,
            steamAppId: local.steamAppId || game.steamAppId,
            exePath: local.exePath,
            installFolder: local.installFolder,
            achievementSources: local.achievementSources,
            approvedRoots: local.approvedRoots,
            allowSteamData: local.allowSteamData,
            steamRoot: local.steamRoot
        });
    }

    setPreferences(preferences = {}) {
        if (Object.prototype.hasOwnProperty.call(preferences, 'notificationsEnabled')) {
            this.notificationsEnabled = preferences.notificationsEnabled !== false;
        }
        if (Object.prototype.hasOwnProperty.call(preferences, 'trackingEnabled')) {
            const nextTrackingEnabled = preferences.trackingEnabled !== false;
            if (this.trackingEnabled && !nextTrackingEnabled) {
                for (const gameId of this.watchers.keys()) this.closeWatchers(gameId);
                for (const timer of this.refreshTimers.values()) clearTimeout(timer);
                this.refreshTimers.clear();
                this.signatures.clear();
            }
            this.trackingEnabled = nextTrackingEnabled;
        }
        return { notificationsEnabled: this.notificationsEnabled, trackingEnabled: this.trackingEnabled };
    }

    async setLibrary(payload = {}) {
        this.setPreferences({
            notificationsEnabled: payload.notificationsEnabled,
            trackingEnabled: payload.trackingEnabled
        });
        const nextLibraryKey = String(payload.libraryKey || 'local');
        if (this.libraryKey && this.libraryKey !== nextLibraryKey) {
            for (const gameId of this.games.keys()) this.removeGame(gameId);
            this.games = new Map();
            this.baselines.clear();
            this.signatures.clear();
        }
        this.libraryKey = nextLibraryKey;
        const previousGames = this.games;
        const incoming = new Map();
        for (const rawGame of Array.isArray(payload.games) ? payload.games : []) {
            const game = safeGame(rawGame);
            if (!game.id) continue;
            incoming.set(game.id, game);
            const previousGame = previousGames.get(game.id);
            const current = steamAppIdChanged(previousGame, game) ? null : this.baselines.get(game.id);
            this.baselines.set(game.id, mergeAchievementData(current, game.achievementData, game.steamAppId));
        }
        for (const gameId of this.games.keys()) {
            if (!incoming.has(gameId)) this.removeGame(gameId);
        }
        this.games = incoming;

        if (!this.trackingEnabled) return { updates: [], errors: [], disabled: true };

        const updates = [];
        const errors = [];
        for (const game of this.games.values()) {
            if (!game.localScanConfigured && !game.exePath && !game.installFolder && !game.achievementSources.length) continue;
            const previousGame = previousGames.get(game.id);
            if (!payload.forceScan && previousGame
                && watchConfigurationKey(previousGame) === watchConfigurationKey(game)) continue;
            try {
                const result = await this.scanGame(game.id, { force: true, emit: false, notify: false, trackDiff: false });
                if (result && result.changed) updates.push({ gameId: game.id, data: result.data });
            } catch (error) {
                errors.push({ gameId: game.id, error: error.message || 'Local achievement scan failed.' });
            }
        }
        return { updates, errors };
    }

    removeGame(gameId) {
        this.closeWatchers(gameId);
        clearTimeout(this.refreshTimers.get(gameId));
        this.refreshTimers.delete(gameId);
        this.baselines.delete(gameId);
        this.signatures.delete(gameId);
    }

    closeWatchers(gameId) {
        for (const watcher of this.watchers.get(gameId) || []) {
            try { watcher.close(); } catch (_) {}
        }
        this.watchers.delete(gameId);
    }

    suspendGame(gameId) {
        const id = String(gameId || '');
        const canResume = !this.disposed && this.trackingEnabled && this.games.has(id);
        this.closeWatchers(id);
        clearTimeout(this.refreshTimers.get(id));
        this.refreshTimers.delete(id);
        return canResume;
    }

    resumeGame(gameId) {
        const id = String(gameId || '');
        if (this.disposed || !this.trackingEnabled) return false;
        const storedGame = this.games.get(id);
        if (!storedGame) return false;
        try {
            this.installWatchers(this.resolveScanGame(storedGame));
            return true;
        } catch (_) {
            this.invalidateLocalAuthority(id);
            return false;
        }
    }

    forgetGame(gameId) {
        const id = String(gameId || '');
        this.removeGame(id);
        this.games.delete(id);
    }

    invalidateLocalAuthority(gameId) {
        const id = String(gameId || '');
        this.closeWatchers(id);
        clearTimeout(this.refreshTimers.get(id));
        this.refreshTimers.delete(id);
        this.signatures.delete(id);
    }

    readLocalArtwork(payload = {}) {
        if (!this.trackingEnabled) return { available: false };
        const gameId = String(payload.gameId || '');
        const itemId = String(payload.itemId || '');
        const variant = payload.variant === 'locked' ? 'locked' : 'unlocked';
        const storedGame = this.games.get(gameId);
        if (!storedGame || !itemId) return { available: false };

        let game;
        try {
            game = this.resolveScanGame(storedGame);
        } catch (_) {
            this.invalidateLocalAuthority(gameId);
            return { available: false };
        }
        if (!game.approvedRoots.length && !game.allowSteamData && this.resolveLocalAuthority) {
            this.invalidateLocalAuthority(gameId);
            return { available: false };
        }

        const data = this.baselines.get(gameId) || storedGame.achievementData;
        const normalized = normalizeAchievementData(data, storedGame.steamAppId);
        const item = normalized && normalized.items.find(candidate => String(candidate.id) === itemId);
        if (!item) return { available: false };
        const candidates = variant === 'locked'
            ? [item.iconGrayPath, item.iconPath]
            : [item.iconPath, item.iconGrayPath];
        const discoveryOptions = this.discoveryOptions(game);
        for (const candidate of candidates) {
            if (!candidate) continue;
            try {
                const approvedPath = resolveApprovedPath(candidate, discoveryOptions, 'file');
                if (!approvedPath) continue;
                const stat = this.fs.statSync(approvedPath);
                if (!stat.isFile() || stat.size < 3 || stat.size > 1024 * 1024) continue;
                const bytes = this.fs.readFileSync(approvedPath);
                const mimeType = rasterMimeType(bytes);
                if (!mimeType) continue;
                return {
                    available: true,
                    mimeType,
                    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`
                };
            } catch (_) {}
        }
        return { available: false };
    }

    installWatchers(game) {
        this.closeWatchers(game.id);
        if (!this.trackingEnabled) return;
        const watchers = [];
        for (const directory of achievementWatchDirectories(game, this.discoveryOptions(game)).slice(0, 64)) {
            try {
                const watcher = this.fs.watch(directory, { persistent: false }, () => this.scheduleScan(game.id));
                watcher.on('error', () => {});
                watchers.push(watcher);
            } catch (_) {}
        }
        if (watchers.length) this.watchers.set(game.id, watchers);
        else this.watchers.delete(game.id);
    }

    scheduleScan(gameId) {
        if (this.disposed || !this.trackingEnabled || !this.games.has(gameId)) return;
        clearTimeout(this.refreshTimers.get(gameId));
        this.refreshTimers.set(gameId, setTimeout(() => {
            this.refreshTimers.delete(gameId);
            this.scanGame(gameId, { force: false, emit: true, notify: true, trackDiff: true }).catch(() => {});
        }, 500));
    }

    gameNeedsBackgroundScan(game) {
        if (!game) return false;
        if (game.localScanConfigured || game.exePath || game.installFolder
            || game.achievementSources && game.achievementSources.length) return true;
        const signature = String(this.signatures.get(game.id) || '');
        const filesPart = signature.includes('|') ? signature.slice(signature.indexOf('|') + 1) : '';
        return !!filesPart;
    }

    async fallbackScan() {
        if (this.disposed || !this.trackingEnabled) return;
        const ids = [...this.games.values()]
            .filter(game => this.gameNeedsBackgroundScan(game))
            .map(game => game.id);
        if (!ids.length) return;
        const batchSize = 8;
        if (this.fallbackCursor >= ids.length) this.fallbackCursor = 0;
        const batch = ids.slice(this.fallbackCursor, this.fallbackCursor + batchSize);
        this.fallbackCursor += batch.length;
        for (const gameId of batch) {
            if (this.disposed || !this.trackingEnabled) return;
            try {
                await this.scanGame(gameId, { force: false, emit: true, notify: true, trackDiff: true });
            } catch (_) {}
        }
    }

    async scanGame(gameId, options = {}) {
        if (!this.trackingEnabled) return null;
        const storedGame = this.games.get(String(gameId));
        if (!storedGame) throw new Error('Game is no longer in the library.');
        let game;
        try {
            game = this.resolveScanGame(storedGame);
        } catch (error) {
            this.closeWatchers(storedGame.id);
            this.signatures.delete(storedGame.id);
            throw error;
        }
        if (!game.approvedRoots.length && !game.allowSteamData && this.resolveLocalAuthority) {
            this.closeWatchers(game.id);
            this.signatures.delete(game.id);
            return null;
        }
        const discoveryOptions = this.discoveryOptions(game);
        const appId = resolveGameAppId(game, discoveryOptions);
        const scanTarget = appId && appId !== game.steamAppId ? { ...game, steamAppId: appId } : game;
        const files = discoverAchievementFiles(scanTarget, discoveryOptions);
        const signature = `${appId}|${signatureForFiles(files, this.fs, discoveryOptions.approvedRoots)}`;
        if (!options.force && this.signatures.get(storedGame.id) === signature) return null;
        this.signatures.set(storedGame.id, signature);
        this.installWatchers(scanTarget);

        const previous = this.baselines.get(storedGame.id) || storedGame.achievementData;
        if (!files.length && !previous) return null;
        const now = Date.now();
        let incoming = {
            schemaVersion: 1,
            appId,
            updatedAt: now,
            lastSteamRefreshAt: null,
            lastLocalScanAt: now,
            items: []
        };
        const errors = [];
        for (const candidate of files) {
            try {
                const parsed = readAchievementFile(candidate.path, {
                    fs: this.fs,
                    approvedRoots: discoveryOptions.approvedRoots
                });
                incoming = mergeAchievementData(incoming, {
                    appId,
                    updatedAt: now,
                    lastLocalScanAt: now,
                    items: parsed.items
                }, appId);
            } catch (error) {
                errors.push({ source: path.basename(candidate.path), error: error.message || 'Could not parse achievement source.' });
            }
        }

        const merged = mergeAchievementData(previous, incoming, appId);
        const newlyUnlocked = options.trackDiff ? diffNewUnlocks(previous, merged) : [];
        const changed = !achievementDataEqual(previous, merged);
        this.baselines.set(storedGame.id, merged);
        storedGame.achievementData = merged;
        if (changed && options.emit) this.sendRendererUpdate(storedGame, merged, newlyUnlocked, errors);
        if (newlyUnlocked.length && options.notify) this.showNativeNotifications(storedGame, newlyUnlocked);
        return {
            changed,
            data: rendererAchievementData(merged, appId),
            newlyUnlocked: rendererAchievementItems(newlyUnlocked),
            errors
        };
    }

    async refreshLocal(payload = {}) {
        if (!this.trackingEnabled) return { changed: false, data: null, newlyUnlocked: [], errors: [], disabled: true };
        const requestedLibraryKey = String(payload.libraryKey || this.libraryKey || 'local');
        if (!this.libraryKey) this.libraryKey = requestedLibraryKey;
        if (this.libraryKey && this.libraryKey !== requestedLibraryKey) {
            return { changed: false, data: null, newlyUnlocked: [], errors: [], stale: true };
        }
        if (payload.game) {
            const game = safeGame(payload.game);
            if (!game.id) throw new Error('A game is required for local achievement refresh.');
            const currentGame = this.games.get(game.id);
            this.games.set(game.id, game);
            const current = steamAppIdChanged(currentGame, game) ? null : this.baselines.get(game.id);
            this.baselines.set(game.id, mergeAchievementData(current, game.achievementData, game.steamAppId));
        }
        const gameId = String(payload.gameId || (payload.game && payload.game.id) || '');
        const result = await this.scanGame(gameId, { force: true, emit: false, notify: false, trackDiff: true });
        return result || {
            changed: false,
            data: rendererAchievementData(this.baselines.get(gameId), this.games.get(gameId) && this.games.get(gameId).steamAppId),
            newlyUnlocked: [],
            errors: []
        };
    }

    async importSteamSchema(payload = {}) {
        if (!this.trackingEnabled) return { updates: [], errors: [], unmatched: [], disabled: true };
        const requestedLibraryKey = String(payload.libraryKey || this.libraryKey || 'local');
        if (!this.libraryKey) this.libraryKey = requestedLibraryKey;
        if (this.libraryKey !== requestedLibraryKey) {
            return { updates: [], errors: [], unmatched: [], stale: true };
        }
        const incomingGames = Array.isArray(payload.games) ? payload.games.map(safeGame) : [];
        for (const game of incomingGames) {
            if (!game.id) continue;
            const currentGame = this.games.get(game.id);
            this.games.set(game.id, game);
            const current = steamAppIdChanged(currentGame, game) ? null : this.baselines.get(game.id);
            this.baselines.set(game.id, mergeAchievementData(current, game.achievementData, game.steamAppId));
        }
        const result = await importSteamSchema({ ...payload, games: incomingGames });
        if (this.libraryKey !== requestedLibraryKey) {
            return { updates: [], errors: [], unmatched: [], stale: true };
        }
        result.updates = result.updates.map(update => {
            const game = this.games.get(update.gameId);
            const merged = mergeAchievementData(this.baselines.get(update.gameId), update.data, update.appId);
            this.baselines.set(update.gameId, merged);
            if (game) {
                game.achievementData = merged;
                if (update.appId && !game.steamAppId) game.steamAppId = String(update.appId);
            }
            return { ...update, data: rendererAchievementData(merged, update.appId) };
        });
        return result;
    }

    async importSteam(payload = {}) {
        if (!this.trackingEnabled) return { updates: [], errors: [], unmatched: [], disabled: true };
        const requestedLibraryKey = String(payload.libraryKey || this.libraryKey || 'local');
        if (!this.libraryKey) this.libraryKey = requestedLibraryKey;
        if (this.libraryKey !== requestedLibraryKey) {
            return { updates: [], errors: [], unmatched: [], stale: true };
        }
        const incomingGames = Array.isArray(payload.games) ? payload.games.map(safeGame) : [];
        for (const game of incomingGames) {
            if (!game.id) continue;
            const currentGame = this.games.get(game.id);
            this.games.set(game.id, game);
            const current = steamAppIdChanged(currentGame, game) ? null : this.baselines.get(game.id);
            this.baselines.set(game.id, mergeAchievementData(current, game.achievementData, game.steamAppId));
        }
        const result = await importSteamAchievements({ ...payload, games: incomingGames });
        if (this.libraryKey !== requestedLibraryKey) {
            return { updates: [], errors: [], unmatched: result.unmatched || [], stale: true };
        }
        result.updates = result.updates.map(update => {
            const game = this.games.get(update.gameId);
            const merged = mergeAchievementData(this.baselines.get(update.gameId), update.data, update.appId);
            this.baselines.set(update.gameId, merged);
            if (game) game.achievementData = merged;
            return { ...update, data: rendererAchievementData(merged, update.appId) };
        });
        return result;
    }

    async pickSource(request = {}) {
        if (!this.trackingEnabled) return { canceled: true, disabled: true };
        const win = this.BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
        const kind = request && (request.kind === 'folder' || request.kind === 'file') ? request.kind : null;
        if (!kind) return { canceled: true, needsChoice: true };
        const openOptions = {
            title: 'Choose an achievement file or folder',
            properties: [kind === 'folder' ? 'openDirectory' : 'openFile']
        };
        if (kind === 'file') openOptions.filters = [
            { name: 'Achievement data', extensions: ['json', 'ini', 'cfg', 'bin', 'txt'] },
            { name: 'All files', extensions: ['*'] }
        ];
        const result = win
            ? await this.dialog.showOpenDialog(win, openOptions)
            : await this.dialog.showOpenDialog(openOptions);
        if (result.canceled || !result.filePaths.length) return { canceled: true };
        const selectedPath = result.filePaths[0];
        return { canceled: false, path: selectedPath, kind };
    }

    sendRendererUpdate(game, data, newlyUnlocked, errors) {
        const win = this.BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
        if (!win) return;
        win.webContents.send('achievements-updated', {
            gameId: game.id,
            data: rendererAchievementData(data, game.steamAppId),
            newlyUnlocked: rendererAchievementItems(newlyUnlocked),
            errors,
            libraryKey: this.libraryKey,
            launcherVisible: isLauncherForeground(win)
        });
    }

    showNativeNotifications(game, achievements) {
        if (!this.notificationsEnabled || !this.Notification || !this.Notification.isSupported()) return;
        const win = this.BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
        if (isLauncherForeground(win)) return;
        for (const achievement of achievements.slice(0, 3)) {
            try {
                new this.Notification({
                    title: 'Achievement unlocked',
                    body: `${achievement.displayName} — ${game.name}`,
                    icon: this.app ? path.join(this.app.getAppPath(), 'icon.ico') : undefined,
                    silent: true
                }).show();
            } catch (_) {}
        }
    }

    dispose() {
        this.disposed = true;
        clearInterval(this.fallbackTimer);
        for (const gameId of this.watchers.keys()) this.closeWatchers(gameId);
        for (const timer of this.refreshTimers.values()) clearTimeout(timer);
        this.refreshTimers.clear();
    }
}

module.exports = {
    AchievementService,
    isLauncherForeground,
    rasterMimeType,
    rendererAchievementData,
    safeGame,
    signatureForFiles,
    steamAppIdChanged,
    watchConfigurationKey
};
