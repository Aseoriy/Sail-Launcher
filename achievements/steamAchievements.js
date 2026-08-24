'use strict';

const { mergeAchievementData, normalizeAchievementItem } = require('./achievementLogic');

const STEAM_API_BASE = 'https://api.steampowered.com';

function steamApiError(message, code = 'steam_unavailable') {
    const error = new Error(message);
    error.code = code;
    error.safeSteamAchievementError = true;
    return error;
}

function validateApiKey(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) throw steamApiError('Add your Steam Web API key in Settings > Social first.', 'missing_key');
    return key;
}

function validateCredentials(apiKey, steamId) {
    const key = validateApiKey(apiKey);
    const id = String(steamId || '').trim();
    if (!/^\d{17}$/.test(id)) throw steamApiError('Enter a valid 17-digit SteamID64 in Settings > Social first.', 'invalid_steam_id');
    return { key, steamId: id };
}

async function fetchJson(url, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw steamApiError('Steam requests are not available in this build.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 12000);
    try {
        const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response || !response.ok) {
            if (response && response.status === 403) throw steamApiError('Steam rejected the API key or the profile is private.', 'forbidden');
            if (response && response.status === 429) throw steamApiError('Steam is rate limiting requests. Wait a moment and try again.', 'rate_limited');
            throw steamApiError('Steam could not return achievement data right now.');
        }
        return await response.json();
    } catch (error) {
        if (error && error.name === 'AbortError') throw steamApiError('Steam took too long to respond.', 'timeout');
        if (error && error.safeSteamAchievementError) throw error;
        throw steamApiError('Steam could not return achievement data right now.');
    } finally {
        clearTimeout(timeout);
    }
}

function apiUrl(interfaceName, method, version, parameters) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters || {})) {
        if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    return `${STEAM_API_BASE}/${interfaceName}/${method}/${version}/?${query.toString()}`;
}

async function fetchOwnedGames(apiKey, steamId, options = {}) {
    const json = await fetchJson(apiUrl('IPlayerService', 'GetOwnedGames', 'v1', {
        key: apiKey,
        steamid: steamId,
        include_appinfo: 1,
        include_played_free_games: 1
    }), options);
    const games = json && json.response && json.response.games;
    if (!Array.isArray(games)) throw steamApiError('Steam owned games are private or unavailable.', 'private_games');
    return games.map(game => ({
        appId: String(game.appid || ''),
        name: String(game.name || `Steam App ${game.appid || ''}`),
        iconHash: String(game.img_icon_url || '')
    })).filter(game => game.appId);
}

function parseCommunityAchievementXml(xml, appId) {
    const blocks = String(xml || '').match(/<achievement\b[\s\S]*?<\/achievement>/gi) || [];
    return blocks.map(block => {
        const tag = (name) => {
            const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
            return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
        };
        const id = tag('apiname') || tag('name');
        if (!id) return null;
        return {
            name: id,
            displayName: tag('name') || id,
            description: tag('description'),
            icon: tag('iconClosed') || tag('iconOpen') || tag('icon'),
            icongray: tag('iconOpen') || tag('iconClosed') || tag('icongray'),
            hidden: 0
        };
    }).filter(Boolean).map(item => ({ ...item, appId: String(appId) }));
}

function decodeHtml(value) {
    const codePoint = (match, code, radix) => {
        const value = parseInt(code, radix);
        return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    };
    return String(value || '')
        .replace(/&#(\d+);/g, (match, code) => codePoint(match, code, 10))
        .replace(/&#x([\da-f]+);/gi, (match, code) => codePoint(match, code, 16))
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function htmlText(value) {
    return decodeHtml(String(value || '').replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function parseCommunityAchievementHtml(html, appId) {
    const chunks = String(html || '').split(/(?=<div\s+class=["'][^"']*\bachieveRow\b)/i).slice(1);
    return chunks.map(chunk => {
        const icon = chunk.match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
        const name = chunk.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
        const description = chunk.match(/<h5\b[^>]*>([\s\S]*?)<\/h5>/i);
        const percent = chunk.match(/class=["'][^"']*\bachievePercent\b[^"']*["'][^>]*>\s*([\d.]+)%/i);
        if (!icon || !name || !percent) return null;
        return {
            appId: String(appId),
            displayName: htmlText(name[1]),
            description: description ? htmlText(description[1]) : '',
            icon: decodeHtml(icon[1]),
            percent: Number(percent[1])
        };
    }).filter(item => item && item.displayName && item.icon && Number.isFinite(item.percent));
}

function pairGlobalAchievementMetadata(apiItems, communityItems, appId) {
    const percentages = (Array.isArray(apiItems) ? apiItems : []).map(item => ({
        name: String(item && item.name || '').trim(),
        percent: Number(item && item.percent)
    })).filter(item => item.name && Number.isFinite(item.percent));
    const details = Array.isArray(communityItems) ? communityItems : [];
    const stopWords = new Set(['achievement', 'achievements', 'all', 'char', 'character', 'complete', 'ending', 'kill', 'level', 'max', 'new', 'stat', 'upgrade']);
    const tokens = value => String(value || '')
        .replace(/^\d+[_-]?/, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z\d]+/)
        .map(token => token.length > 4 && token.endsWith('ed') ? token.slice(0, -2) : token)
        .map(token => token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token)
        .filter(token => token.length > 2 && !stopWords.has(token));
    const tokenMatches = (left, right) => left === right
        || left.length >= 5 && right.length >= 5 && (left.startsWith(right) || right.startsWith(left));
    const candidates = [];
    percentages.forEach((item, apiIndex) => {
        const apiTokens = tokens(item.name);
        details.forEach((detail, detailIndex) => {
            const detailTokens = tokens(`${detail.displayName} ${detail.description}`);
            const matched = apiTokens.filter(token => detailTokens.some(candidate => tokenMatches(token, candidate))).length;
            const textCoverage = apiTokens.length ? matched / apiTokens.length : 0;
            const percentDistance = Math.abs(item.percent - Number(detail.percent));
            if (percentDistance > 1 && textCoverage < .5) return;
            const percentScore = Math.max(0, 35 - percentDistance * 100);
            const orderScore = Math.max(0, 5 - Math.abs(apiIndex - detailIndex) * .5);
            candidates.push({ apiIndex, detailIndex, score: textCoverage * 100 + percentScore + orderScore });
        });
    });
    candidates.sort((left, right) => right.score - left.score || left.apiIndex - right.apiIndex || left.detailIndex - right.detailIndex);
    const detailForApi = new Map();
    const usedDetails = new Set();
    for (const candidate of candidates) {
        if (detailForApi.has(candidate.apiIndex) || usedDetails.has(candidate.detailIndex)) continue;
        detailForApi.set(candidate.apiIndex, details[candidate.detailIndex]);
        usedDetails.add(candidate.detailIndex);
    }
    if (percentages.length === details.length) {
        for (let apiIndex = 0; apiIndex < percentages.length; apiIndex += 1) {
            if (detailForApi.has(apiIndex)) continue;
            const remaining = details
                .map((detail, detailIndex) => ({
                    detail,
                    detailIndex,
                    distance: Math.abs(percentages[apiIndex].percent - Number(detail.percent)) * 100 + Math.abs(apiIndex - detailIndex)
                }))
                .filter(candidate => !usedDetails.has(candidate.detailIndex))
                .sort((left, right) => left.distance - right.distance || left.detailIndex - right.detailIndex);
            if (!remaining.length) break;
            detailForApi.set(apiIndex, remaining[0].detail);
            usedDetails.add(remaining[0].detailIndex);
        }
    }
    return percentages.map((item, index) => {
        const detail = detailForApi.get(index);
        if (!detail) return null;
        return {
            appId: String(appId),
            name: item.name,
            displayName: detail.displayName || item.name,
            description: detail.description || '',
            icon: detail.icon,
            icongray: detail.icon,
            hidden: 0
        };
    }).filter(Boolean);
}

async function fetchCommunitySchema(appId, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw steamApiError('Steam requests are not available in this build.');
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 12000);
        let responses;
        try {
            responses = await Promise.all([
                fetchImpl(`https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${encodeURIComponent(String(appId))}`, {
                    signal: controller.signal,
                    headers: { Accept: 'application/json' }
                }),
                fetchImpl(`https://steamcommunity.com/stats/${encodeURIComponent(String(appId))}/achievements/?l=english`, {
                    signal: controller.signal,
                    headers: { Accept: 'text/html' }
                })
            ]);
        } finally {
            clearTimeout(timeout);
        }
        if (responses.some(response => !response || !response.ok)) throw steamApiError('Steam community achievement details are unavailable.');
        const [percentageResponse, communityResponse] = responses;
        const [percentageBody, communityHtml] = await Promise.all([percentageResponse.json(), communityResponse.text()]);
        const percentages = percentageBody && percentageBody.achievementpercentages && percentageBody.achievementpercentages.achievements;
        const items = pairGlobalAchievementMetadata(percentages, parseCommunityAchievementHtml(communityHtml, appId), appId);
        if (!items.length) throw steamApiError('Steam community did not return achievement details for this app.');
        return items;
    } catch (error) {
        if (error && error.safeSteamAchievementError) throw error;
        if (error && error.name === 'AbortError') throw steamApiError('Steam took too long to respond.', 'timeout');
        throw steamApiError('Steam community achievement details are unavailable.');
    }
}

async function fetchGameSchema(apiKey, appId, language, options = {}) {
    const json = await fetchJson(apiUrl('ISteamUserStats', 'GetSchemaForGame', 'v2', {
        key: apiKey,
        appid: appId,
        l: language || 'english'
    }), options);
    const achievements = json && json.game && json.game.availableGameStats && json.game.availableGameStats.achievements;
    return Array.isArray(achievements) ? achievements : [];
}

async function fetchPlayerAchievements(apiKey, steamId, appId, language, options = {}) {
    const json = await fetchJson(apiUrl('ISteamUserStats', 'GetPlayerAchievements', 'v1', {
        key: apiKey,
        steamid: steamId,
        appid: appId,
        l: language || 'english'
    }), options);
    const stats = json && json.playerstats;
    if (!stats || stats.success === false) {
        const detail = String(stats && stats.error || '').toLowerCase();
        if (detail.includes('private')) throw steamApiError('Steam achievement details are private for this account.', 'private_achievements');
        throw steamApiError('This game has no public Steam achievement progress.', 'no_player_stats');
    }
    return Array.isArray(stats.achievements) ? stats.achievements : [];
}

function normalizeSteamData(appId, schemaItems, playerItems, now = Date.now()) {
    const progressById = new Map((Array.isArray(playerItems) ? playerItems : []).map(item => [
        String(item.apiname || item.name || '').toLowerCase(),
        item
    ]));
    let data = null;
    for (const schema of Array.isArray(schemaItems) ? schemaItems : []) {
        const id = String(schema.name || schema.apiname || '').trim();
        if (!id) continue;
        const progress = progressById.get(id.toLowerCase()) || {};
        const item = normalizeAchievementItem({
            id,
            displayName: schema.displayName || progress.name || id,
            description: schema.description || '',
            hidden: schema.hidden,
            icon: schema.icon,
            iconGray: schema.icongray,
            unlocked: progress.achieved,
            unlockTime: progress.unlocktime,
            source: 'steam'
        });
        data = mergeAchievementData(data, { appId: String(appId), updatedAt: now, lastSteamRefreshAt: now, items: [item] }, appId);
        progressById.delete(id.toLowerCase());
    }
    for (const progress of progressById.values()) {
        const id = String(progress.apiname || progress.name || '').trim();
        if (!id) continue;
        data = mergeAchievementData(data, {
            appId: String(appId),
            updatedAt: now,
            lastSteamRefreshAt: now,
            items: [normalizeAchievementItem({
                id,
                displayName: progress.name || id,
                unlocked: progress.achieved,
                unlockTime: progress.unlocktime,
                source: 'steam'
            })]
        }, appId);
    }
    return data || {
        schemaVersion: 1,
        appId: String(appId),
        updatedAt: now,
        lastSteamRefreshAt: now,
        lastLocalScanAt: null,
        items: []
    };
}

async function fetchGameAchievementData({ apiKey, steamId, appId, language = 'english' }, options = {}) {
    const [schemaResult, progressResult] = await Promise.allSettled([
        fetchGameSchema(apiKey, appId, language, options),
        fetchPlayerAchievements(apiKey, steamId, appId, language, options)
    ]);
    if (schemaResult.status === 'rejected' && progressResult.status === 'rejected') throw progressResult.reason || schemaResult.reason;
    const schema = schemaResult.status === 'fulfilled' ? schemaResult.value : [];
    const progress = progressResult.status === 'fulfilled' ? progressResult.value : [];
    const data = normalizeSteamData(appId, schema, progress);
    const warnings = [];
    if (schemaResult.status === 'rejected') {
        data.lastSteamRefreshAt = null;
        warnings.push(schemaResult.reason && schemaResult.reason.message || 'Steam achievement details could not be refreshed.');
    }
    if (progressResult.status === 'rejected') {
        warnings.push(progressResult.reason && progressResult.reason.message || 'Steam achievement progress could not be refreshed.');
    }
    return {
        data,
        warning: warnings.length ? warnings.join(' ') : null
    };
}

async function mapWithConcurrency(values, concurrency, mapper) {
    const result = new Array(values.length);
    let next = 0;
    async function worker() {
        while (next < values.length) {
            const index = next++;
            result[index] = await mapper(values[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length || 1) }, () => worker()));
    return result;
}

async function resolveSteamSchema(appId, payload = {}, options = {}) {
    const language = payload.language || 'english';
    const key = String(payload.steamApiKey || '').trim();
    if (key) {
        try {
            const schema = await fetchGameSchema(key, appId, language, options);
            if (schema.length) return schema;
        } catch (error) {
            if (!options.allowCommunityFallback) throw error;
        }
    }
    return fetchCommunitySchema(appId, options);
}

async function importSteamSchema(payload = {}, options = {}) {
    const games = (Array.isArray(payload.games) ? payload.games : []).filter(game => game && game.id && game.steamAppId);
    const selectedIds = Array.isArray(payload.gameIds) && payload.gameIds.length ? new Set(payload.gameIds.map(String)) : null;
    const targets = selectedIds ? games.filter(game => selectedIds.has(String(game.id))) : games;
    const rows = await mapWithConcurrency(targets, Number(options.concurrency) || 3, async game => {
        try {
            const schema = await resolveSteamSchema(String(game.steamAppId), payload, { ...options, allowCommunityFallback: true });
            return {
                gameId: String(game.id),
                appId: String(game.steamAppId),
                data: normalizeSteamData(game.steamAppId, schema, [], Date.now())
            };
        } catch (error) {
            return {
                gameId: String(game.id),
                appId: String(game.steamAppId),
                error: error && error.message ? error.message : 'Steam achievement details could not be loaded.'
            };
        }
    });
    return {
        updates: rows.filter(row => row && row.data),
        errors: rows.filter(row => row && row.error),
        unmatched: []
    };
}

async function importSteamAchievements(payload = {}, options = {}) {
    const credentials = validateCredentials(payload.steamApiKey, payload.steamId);
    const games = (Array.isArray(payload.games) ? payload.games : []).filter(game => game && game.id && game.steamAppId);
    const selectedIds = Array.isArray(payload.gameIds) && payload.gameIds.length ? new Set(payload.gameIds.map(String)) : null;
    let targets = selectedIds ? games.filter(game => selectedIds.has(String(game.id))) : games;
    let unmatched = [];

    if (!selectedIds) {
        const ownedGames = await fetchOwnedGames(credentials.key, credentials.steamId, options);
        const libraryAppIds = new Set(games.map(game => String(game.steamAppId)));
        const ownedAppIds = new Set(ownedGames.map(game => game.appId));
        targets = games.filter(game => ownedAppIds.has(String(game.steamAppId)));
        unmatched = ownedGames.filter(game => !libraryAppIds.has(game.appId));
    }

    const rows = await mapWithConcurrency(targets, Number(options.concurrency) || 4, async game => {
        try {
            const result = await fetchGameAchievementData({
                apiKey: credentials.key,
                steamId: credentials.steamId,
                appId: String(game.steamAppId),
                language: payload.language || 'english'
            }, options);
            return { gameId: String(game.id), appId: String(game.steamAppId), data: result.data, warning: result.warning };
        } catch (error) {
            return {
                gameId: String(game.id),
                appId: String(game.steamAppId),
                error: error && error.message ? error.message : 'Steam achievement refresh failed.'
            };
        }
    });

    const errors = rows.filter(row => row && row.error);
    for (const row of rows.filter(row => row && row.warning)) {
        errors.push({ gameId: row.gameId, appId: row.appId, error: row.warning });
    }
    return {
        updates: rows.filter(row => row && row.data),
        errors,
        unmatched
    };
}

module.exports = {
    fetchCommunitySchema,
    fetchGameAchievementData,
    fetchGameSchema,
    fetchOwnedGames,
    fetchPlayerAchievements,
    importSteamAchievements,
    importSteamSchema,
    normalizeSteamData,
    pairGlobalAchievementMetadata,
    parseCommunityAchievementHtml,
    parseCommunityAchievementXml,
    resolveSteamSchema,
    validateApiKey,
    validateCredentials
};
