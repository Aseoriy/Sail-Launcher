'use strict';

const ACHIEVEMENT_SCHEMA_VERSION = 1;
const STEAM_CACHE_SUMMARY_KEYS = new Set([
    'nachieved', 'ntotal', 'nunlocked', 'nlocked', 'ncount', 'nprogress',
    'npercentage', 'ncompletionpercentage', 'flcompletion', 'bhasachievements',
    'bhasanyachievements'
]);

function cleanText(value, fallback = '') {
    const text = value === undefined || value === null ? '' : String(value).trim();
    return text || fallback;
}

function normalizeTimestamp(value) {
    if (value === undefined || value === null || value === '' || value === false) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        if (numeric <= 0) return null;
        if (numeric >= 100000000000) return Math.round(numeric);
        if (numeric >= 1000000000) return Math.round(numeric * 1000);
        return null;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    const text = cleanText(value).toLowerCase();
    if (!text) return false;
    if (['1', 'true', 'yes', 'y', 'on', 'unlocked', 'achieved', 'earned', 'complete', 'completed'].includes(text)) return true;
    if (['0', 'false', 'no', 'n', 'off', 'locked', 'none'].includes(text)) return false;
    const numeric = Number(text);
    return Number.isFinite(numeric) && numeric > 0;
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

function achievementKey(value) {
    const text = cleanText(value);
    // Locale-aware lowercasing is far slower and only differs from the plain form for non-ASCII text.
    return ASCII_ONLY.test(text) ? text.toLowerCase() : text.toLocaleLowerCase('en-US');
}

function achievementMatchKeys(value) {
    const raw = achievementKey(value);
    if (!raw) return [];
    const keys = [raw];
    const withoutNumber = raw.replace(/^\d+_/, '');
    if (withoutNumber && withoutNumber !== raw) keys.push(withoutNumber);
    const withoutPrefix = raw.replace(/^(?:ach|achievement)[_-]?/, '');
    if (withoutPrefix && withoutPrefix !== raw) keys.push(withoutPrefix);
    if (withoutNumber) {
        const stripped = withoutNumber.replace(/^(?:ach|achievement)[_-]?/, '');
        if (stripped && !keys.includes(stripped)) keys.push(stripped);
    }
    return keys;
}

function findAchievementMapKey(byId, id) {
    for (const key of achievementMatchKeys(id)) {
        if (byId.has(key)) return key;
    }
    const incomingKeys = new Set(achievementMatchKeys(id));
    for (const existing of byId.keys()) {
        if (achievementMatchKeys(existing).some(key => incomingKeys.has(key))) return existing;
    }
    return achievementKey(id);
}

// Keyed collection of achievements. Besides exact keys it finds entries whose ids differ only by a numeric
// or "ach_" prefix, using an index of every alias instead of scanning all entries for each lookup.
class AchievementIndex {
    constructor(items = []) {
        this.byId = new Map();
        this.order = [];
        this.rank = new Map();
        this.nextRank = 0;
        this.aliases = new Map();
        for (const item of items) this.set(achievementKey(item.id), item);
    }

    // Same answer as findAchievementMapKey: an exact alias match, else the earliest-added entry sharing an alias.
    find(id) {
        const keys = achievementMatchKeys(id);
        for (const key of keys) {
            if (this.byId.has(key)) return key;
        }
        let best = null;
        let bestRank = Infinity;
        for (const key of keys) {
            const owners = this.aliases.get(key);
            if (!owners) continue;
            for (const owner of owners) {
                const rank = this.rank.get(owner);
                if (rank < bestRank) { bestRank = rank; best = owner; }
            }
        }
        return best !== null ? best : achievementKey(id);
    }

    set(key, item) {
        if (!this.byId.has(key)) {
            this.rank.set(key, this.nextRank++);
            this.order.push(key);
            for (const alias of achievementMatchKeys(key)) {
                const owners = this.aliases.get(alias);
                if (owners) owners.push(key); else this.aliases.set(alias, [key]);
            }
        }
        this.byId.set(key, item);
    }

    delete(key) {
        if (!this.byId.delete(key)) return;
        this.rank.delete(key);
        this.order = this.order.filter(candidate => candidate !== key);
        for (const alias of achievementMatchKeys(key)) {
            const owners = (this.aliases.get(alias) || []).filter(candidate => candidate !== key);
            if (owners.length) this.aliases.set(alias, owners); else this.aliases.delete(alias);
        }
    }

    items() {
        return this.order.map(key => this.byId.get(key)).filter(Boolean);
    }
}

function mergeItemsIntoIndex(index, incomingItems) {
    const becameSynthetic = [];
    for (const item of incomingItems) {
        const key = index.find(item.id);
        if (!key) continue;
        const current = index.byId.get(key);
        const merged = pickMetadata(current, current ? { ...item, id: current.id } : item);
        index.set(key, merged);
        if (isSyntheticAchievementItem(merged)) becameSynthetic.push(key);
    }
    return becameSynthetic;
}

function normalizeIconUrl(value) {
    const text = cleanText(value);
    if (!text) return null;
    try {
        const url = new URL(text);
        if (url.protocol === 'http:') {
            const hostname = url.hostname.toLowerCase();
            const trustedSteamHost = ['steampowered.com', 'steamstatic.com', 'steamcommunity.com', 'steamcdn-a.akamaihd.net']
                .some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
            if (trustedSteamHost) url.protocol = 'https:';
        }
        return url.protocol === 'https:' ? url.toString() : null;
    } catch (_) {
        return null;
    }
}

function normalizeAchievementItem(item = {}) {
    if (typeof item === 'string') item = { id: item, displayName: item };
    const id = cleanText(
        item.id ?? item.apiName ?? item.apiname ?? item.internalName ?? item.key ?? item.name
    );
    if (!id) return null;

    const unlockTime = normalizeTimestamp(
        item.unlockTime ?? item.unlocktime ?? item.unlock_time ?? item.unlockedAt ?? item.timestamp ?? item.earned_time
    );
    const unlocked = booleanValue(
        item.unlocked ?? item.achieved ?? item.earned ?? item.isUnlocked ?? item.complete ?? (unlockTime !== null)
    );

    return {
        id,
        displayName: cleanText(item.displayName ?? item.display_name ?? item.title ?? item.name, id),
        description: cleanText(item.description ?? item.desc),
        hidden: booleanValue(item.hidden),
        icon: normalizeIconUrl(item.icon ?? item.iconUrl ?? item.icon_url),
        iconGray: normalizeIconUrl(item.iconGray ?? item.icongray ?? item.icon_gray ?? item.lockedIcon),
        iconPath: cleanText(item.iconPath ?? item.icon_path) || null,
        iconGrayPath: cleanText(item.iconGrayPath ?? item.icon_gray_path ?? item.lockedIconPath) || null,
        unlocked,
        unlockTime: unlocked ? unlockTime : null,
        source: cleanText(item.source) || null
    };
}

function isSyntheticAchievementItem(item = {}) {
    return cleanText(item.source).toLowerCase() === 'steam-cache'
        && STEAM_CACHE_SUMMARY_KEYS.has(achievementKey(item.id));
}

function normalizeAchievementData(data, fallbackAppId = '') {
    if (!data || typeof data !== 'object') return null;
    const seen = new Set();
    const items = [];
    for (const rawItem of Array.isArray(data.items) ? data.items : []) {
        const item = normalizeAchievementItem(rawItem);
        if (!item || isSyntheticAchievementItem(item)) continue;
        const key = achievementKey(item.id);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(item);
    }
    return {
        schemaVersion: ACHIEVEMENT_SCHEMA_VERSION,
        appId: cleanText(data.appId ?? data.appid, cleanText(fallbackAppId)),
        updatedAt: normalizeTimestamp(data.updatedAt) || 0,
        lastSteamRefreshAt: normalizeTimestamp(data.lastSteamRefreshAt),
        lastLocalScanAt: normalizeTimestamp(data.lastLocalScanAt),
        items
    };
}

function pickMetadata(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const incomingIsSteam = incoming.source === 'steam';
    const existingIsSteam = existing.source === 'steam';
    const pick = (oldValue, newValue) => {
        if (incomingIsSteam && newValue) return newValue;
        if (oldValue) return oldValue;
        return newValue || oldValue;
    };
    const existingId = cleanText(existing.id).toLowerCase();
    const incomingId = cleanText(incoming.id).toLowerCase();
    const oldDisplay = cleanText(existing.displayName);
    const newDisplay = cleanText(incoming.displayName);
    const oldDisplayIsFallback = !oldDisplay || oldDisplay.toLowerCase() === existingId;
    const newDisplayIsFallback = !newDisplay || newDisplay.toLowerCase() === incomingId;
    const displayName = incomingIsSteam && newDisplay
        ? newDisplay
        : oldDisplayIsFallback && !newDisplayIsFallback
            ? newDisplay
            : oldDisplay || newDisplay || existing.id || incoming.id;
    const oldTime = normalizeTimestamp(existing.unlockTime);
    const newTime = normalizeTimestamp(incoming.unlockTime);
    const unlocked = !!existing.unlocked || !!incoming.unlocked;
    let unlockTime = null;
    if (unlocked) {
        const candidates = [oldTime, newTime].filter(value => Number.isFinite(value) && value > 0);
        unlockTime = candidates.length ? Math.min(...candidates) : null;
    }
    return {
        id: existing.id || incoming.id,
        displayName,
        description: pick(existing.description, incoming.description) || '',
        hidden: incomingIsSteam ? !!incoming.hidden : (!!existing.hidden || !!incoming.hidden),
        icon: pick(existing.icon, incoming.icon) || null,
        iconGray: pick(existing.iconGray, incoming.iconGray) || null,
        iconPath: pick(existing.iconPath, incoming.iconPath) || null,
        iconGrayPath: pick(existing.iconGrayPath, incoming.iconGrayPath) || null,
        unlocked,
        unlockTime,
        source: incomingIsSteam || !existingIsSteam ? (incoming.source || existing.source || null) : existing.source
    };
}

function mergeAchievementData(existingData, incomingData, fallbackAppId = '') {
    const existing = normalizeAchievementData(existingData, fallbackAppId);
    const incoming = normalizeAchievementData(incomingData, fallbackAppId);
    if (!existing && !incoming) return null;
    if (!existing) return incoming;
    if (!incoming) return existing;

    const index = new AchievementIndex(existing.items);
    mergeItemsIntoIndex(index, incoming.items);
    const items = index.items();
    return {
        schemaVersion: ACHIEVEMENT_SCHEMA_VERSION,
        appId: incoming.appId || existing.appId || cleanText(fallbackAppId),
        updatedAt: Math.max(existing.updatedAt || 0, incoming.updatedAt || 0),
        lastSteamRefreshAt: Math.max(existing.lastSteamRefreshAt || 0, incoming.lastSteamRefreshAt || 0) || null,
        lastLocalScanAt: Math.max(existing.lastLocalScanAt || 0, incoming.lastLocalScanAt || 0) || null,
        items
    };
}

// Folds many chunks into one result, giving what repeated mergeAchievementData(result, chunk) calls give,
// without normalizing and re-indexing the growing result for every chunk.
class AchievementAccumulator {
    constructor(fallbackAppId = '') {
        this.fallbackAppId = fallbackAppId;
        this.index = null;
        this.meta = null;
        this.pendingSynthetic = [];
    }

    add(chunk) {
        // Normalizing the accumulated data on every merge drops entries that merged into a Steam cache counter.
        if (this.index) {
            for (const key of this.pendingSynthetic) this.index.delete(key);
            this.pendingSynthetic = [];
        }
        const incoming = normalizeAchievementData(chunk, this.fallbackAppId);
        if (!incoming) return;
        if (!this.index) {
            this.index = new AchievementIndex(incoming.items);
            this.meta = { appId: incoming.appId, updatedAt: incoming.updatedAt, lastSteamRefreshAt: incoming.lastSteamRefreshAt, lastLocalScanAt: incoming.lastLocalScanAt };
            return;
        }
        this.pendingSynthetic = mergeItemsIntoIndex(this.index, incoming.items);
        this.meta = {
            appId: incoming.appId || this.meta.appId || cleanText(this.fallbackAppId),
            updatedAt: Math.max(this.meta.updatedAt || 0, incoming.updatedAt || 0),
            lastSteamRefreshAt: Math.max(this.meta.lastSteamRefreshAt || 0, incoming.lastSteamRefreshAt || 0) || null,
            lastLocalScanAt: Math.max(this.meta.lastLocalScanAt || 0, incoming.lastLocalScanAt || 0) || null
        };
    }

    result() {
        return this.index ? { schemaVersion: ACHIEVEMENT_SCHEMA_VERSION, ...this.meta, items: this.index.items() } : null;
    }
}

function diffNewUnlocks(previousData, nextData) {
    const previous = normalizeAchievementData(previousData) || { items: [] };
    const next = normalizeAchievementData(nextData) || { items: [] };
    const previousById = new Map(previous.items.map(item => [achievementKey(item.id), item]));
    return next.items.filter(item => item.unlocked && !(previousById.get(achievementKey(item.id)) || {}).unlocked);
}

function summarizeAchievementData(data) {
    const normalized = normalizeAchievementData(data) || { items: [] };
    const total = normalized.items.length;
    const unlocked = normalized.items.filter(item => item.unlocked).length;
    return {
        total,
        unlocked,
        locked: Math.max(0, total - unlocked),
        percent: total ? Math.round((unlocked / total) * 100) : 0,
        latestUnlock: normalized.items
            .filter(item => item.unlocked && item.unlockTime)
            .sort((left, right) => right.unlockTime - left.unlockTime)[0] || null
    };
}

function achievementDataEqual(left, right) {
    return JSON.stringify(normalizeAchievementData(left)) === JSON.stringify(normalizeAchievementData(right));
}

module.exports = {
    ACHIEVEMENT_SCHEMA_VERSION,
    AchievementAccumulator,
    achievementDataEqual,
    achievementKey,
    achievementMatchKeys,
    findAchievementMapKey,
    booleanValue,
    diffNewUnlocks,
    isSyntheticAchievementItem,
    mergeAchievementData,
    normalizeAchievementData,
    normalizeAchievementItem,
    normalizeIconUrl,
    normalizeTimestamp,
    summarizeAchievementData
};
