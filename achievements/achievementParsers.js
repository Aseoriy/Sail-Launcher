'use strict';

const fs = require('fs');
const path = require('path');
const { resolveApprovedPath } = require('./achievementDiscovery');
const {
    booleanValue,
    mergeAchievementData,
    normalizeAchievementItem,
    normalizeTimestamp
} = require('./achievementLogic');

const MAX_ACHIEVEMENT_FILE_BYTES = 8 * 1024 * 1024;
const STATUS_KEYS = ['achieved', 'unlocked', 'earned', 'complete', 'completed', 'isunlocked', 'is_unlocked', 'bachieved', 'state', 'value'];
const TIME_KEYS = ['unlocktime', 'unlock_time', 'unlocktimestamp', 'unlock_timestamp', 'unlockedat', 'unlocked_at', 'timeunlocked', 'timestamp', 'earned_time', 'time', 'rtunlocktime', 'rtunlocked'];
const ID_KEYS = ['id', 'apiname', 'api_name', 'achievement', 'achievementid', 'achievement_id', 'key', 'internalname', 'internal_name', 'strid', 'name'];
const DISPLAY_KEYS = ['displayname', 'display_name', 'title', 'localizedname', 'localized_name', 'strname', 'strdisplayname', 'strtitle'];
const DESCRIPTION_KEYS = ['description', 'desc', 'details', 'strdescription', 'strdesc'];
const ICON_KEYS = ['icon', 'iconurl', 'icon_url', 'strimage', 'stricon', 'striconurl'];
const LOCKED_ICON_KEYS = ['icongray', 'icon_gray', 'lockedicon', 'locked_icon', 'strimagegray', 'strlockedimage', 'strlockedicon'];
const GENERIC_SECTIONS = new Set(['achievement', 'achievements', 'stats', 'statistics', 'playerstats', 'steam', 'general', 'settings', 'global']);

function stripQuotes(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
        return text.slice(1, -1);
    }
    return text;
}

function lowerObject(record) {
    const lowered = {};
    for (const [key, value] of Object.entries(record || {})) lowered[String(key).toLowerCase()] = value;
    return lowered;
}

function firstValue(record, keys) {
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
    }
    return undefined;
}

function localizedText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'object') return stripQuotes(value);
    if (Array.isArray(value)) return localizedText(value.find(entry => typeof entry === 'string'));
    const lowered = lowerObject(value);
    for (const key of ['english', 'en', 'token', 'value']) {
        const text = localizedText(lowered[key]);
        if (text) return text;
    }
    for (const entry of Object.values(value)) {
        const text = localizedText(entry);
        if (text) return text;
    }
    return '';
}

function localArtworkPath(value, options = {}) {
    const raw = localizedText(value);
    if (!raw || /^[a-z][a-z\d+.-]*:/i.test(raw) || /^[\\/]{2}/.test(raw)) return null;
    const sourceFilePath = String(options.sourceFilePath || '');
    if (!sourceFilePath) return null;
    const fileSystem = options.fs || fs;
    const base = path.dirname(sourceFilePath);
    const names = [raw];
    if (!path.extname(raw)) names.push(`${raw}.jpg`, `${raw}.png`);
    const candidates = [];
    for (const name of names) {
        if (path.isAbsolute(name)) candidates.push(path.normalize(name));
        else candidates.push(
            path.resolve(base, name),
            path.resolve(base, 'achievement_images', name),
            path.resolve(base, 'img', name)
        );
    }
    const schemaMatch = path.basename(sourceFilePath).match(/^UserGameStatsSchema_(\d+)\.bin$/i);
    if (schemaMatch && path.basename(base).toLowerCase() === 'stats') {
        const libraryCache = path.resolve(base, '..', 'librarycache', schemaMatch[1]);
        for (const name of names) candidates.push(path.resolve(libraryCache, name));
    }
    const cacheMatch = path.basename(sourceFilePath).match(/^(\d+)\.json$/i);
    if (cacheMatch && path.basename(base).toLowerCase() === 'librarycache') {
        const steamRoot = path.resolve(base, '..', '..', '..', '..');
        const cacheRoot = path.join(steamRoot, 'appcache', 'librarycache');
        for (const name of names) candidates.push(
            path.resolve(cacheRoot, cacheMatch[1], name),
            path.resolve(cacheRoot, `${cacheMatch[1]}_${name}`),
            path.resolve(cacheRoot, name)
        );
    }
    for (const candidate of candidates) {
        try {
            const approvedCandidate = Object.hasOwn(options, 'approvedRoots')
                ? resolveApprovedPath(candidate, options, 'file')
                : candidate;
            if (!approvedCandidate) continue;
            const stat = fileSystem.lstatSync(approvedCandidate);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) continue;
            if (!/\.(?:png|jpe?g|webp|gif)$/i.test(approvedCandidate)) continue;
            return approvedCandidate;
        } catch (_) {}
    }
    return null;
}

function sourceAppId(options = {}) {
    const sourceFilePath = String(options.sourceFilePath || '');
    const basename = path.basename(sourceFilePath);
    const schema = basename.match(/^UserGameStatsSchema_(\d+)\.bin$/i);
    if (schema) return schema[1];
    if (String(sourceFilePath).replace(/\\/g, '/').toLowerCase().includes('/librarycache/')) {
        const cache = basename.match(/^(\d+)\.json$/i);
        if (cache) return cache[1];
    }
    return '';
}

function steamArtworkValue(value, options = {}) {
    const text = localizedText(value);
    if (!text) return '';
    const appId = sourceAppId(options);
    if (appId && /^[a-f\d]{20,64}$/i.test(text)) {
        return `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${appId}/${text}.jpg`;
    }
    return text;
}

function keyFor(record, keys) {
    return keys.find(key => Object.prototype.hasOwnProperty.call(record, key));
}

function decodeLittleEndianHex(value) {
    const text = stripQuotes(value).replace(/^0x/i, '');
    if (!/^[0-9a-f]+$/i.test(text) || text.length < 4 || text.length % 2 !== 0) return null;
    const bytes = Buffer.from(text, 'hex');
    if (!bytes.length || bytes.length > 6) return null;
    return bytes.readUIntLE(0, bytes.length);
}

function normalizeFormatTimestamp(value, key, stateValue) {
    let timestamp = normalizeTimestamp(value);
    const stateLooksEncoded = decodeLittleEndianHex(stateValue) !== null;
    if (key === 'time' && stateLooksEncoded) {
        const decoded = decodeLittleEndianHex(value);
        if (decoded !== null) timestamp = normalizeTimestamp(decoded);
    }
    const text = stripQuotes(value);
    if (timestamp === null && ['timeunlocked', 'unlocktime'].includes(key) && /^\d{7}$/.test(text)) {
        timestamp = Number(text) * 1000000;
    }
    return timestamp;
}

function recordFromObject(raw, fallbackId = '', source = 'local', options = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = lowerObject(raw);
    const display = record.display && typeof record.display === 'object' ? lowerObject(record.display) : {};
    const id = stripQuotes(firstValue(record, ID_KEYS) ?? fallbackId);
    if (!id) return null;
    const statusKey = keyFor(record, STATUS_KEYS);
    const timeKey = keyFor(record, TIME_KEYS);
    if (statusKey === 'value' && (record.type !== undefined || record.min !== undefined || record.max !== undefined)
        && keyFor(record, ['achieved', 'unlocked', 'earned', 'complete', 'completed', 'isunlocked', 'is_unlocked', 'bachieved', 'state']) === undefined
        && !timeKey) {
        return null;
    }
    let status = statusKey ? record[statusKey] : undefined;
    const timeValue = timeKey ? record[timeKey] : undefined;
    if (statusKey === 'state') {
        const decodedState = decodeLittleEndianHex(status);
        if (decodedState !== null) status = stripQuotes(status).toLowerCase() === '0101' || decodedState === 1;
    }
    const time = normalizeFormatTimestamp(timeValue, timeKey, statusKey === 'state' ? record[statusKey] : null);
    const hasStatus = status !== undefined || timeValue !== undefined;
    const displayValue = firstValue(record, DISPLAY_KEYS) ?? firstValue(display, ['name', ...DISPLAY_KEYS]);
    const descriptionValue = firstValue(record, DESCRIPTION_KEYS) ?? firstValue(display, ['desc', ...DESCRIPTION_KEYS]);
    const iconValue = firstValue(record, ICON_KEYS) ?? firstValue(display, ICON_KEYS);
    const iconGrayValue = firstValue(record, LOCKED_ICON_KEYS) ?? firstValue(display, LOCKED_ICON_KEYS);
    const hasMetadata = displayValue !== undefined || descriptionValue !== undefined || Object.keys(display).length > 0;
    if (!hasStatus && !hasMetadata && !fallbackId) return null;
    return normalizeAchievementItem({
        id,
        displayName: localizedText(displayValue) || id,
        description: localizedText(descriptionValue),
        hidden: firstValue(record, ['hidden', 'ishidden', 'is_hidden']) ?? firstValue(display, ['hidden', 'ishidden', 'is_hidden']) ?? false,
        icon: steamArtworkValue(iconValue, options),
        iconGray: steamArtworkValue(iconGrayValue, options),
        iconPath: localArtworkPath(iconValue, options),
        iconGrayPath: localArtworkPath(iconGrayValue, options),
        unlocked: hasStatus ? booleanValue(status ?? (time !== null)) : false,
        unlockTime: time,
        source
    });
}

function recordFromIniValue(id, rawValue, source) {
    const value = stripQuotes(rawValue);
    const userStats = value.match(/unlocked\s*=\s*(true|false|1|0).*?time\s*=\s*(\d+)/i);
    if (userStats) {
        return normalizeAchievementItem({
            id,
            displayName: id,
            unlocked: booleanValue(userStats[1]),
            unlockTime: userStats[2],
            source
        });
    }
    const skidrow = value.split('@');
    if (skidrow.length > 1 && /^(0|1)$/.test(skidrow[0].trim())) {
        return normalizeAchievementItem({
            id,
            displayName: id,
            unlocked: skidrow[0].trim() === '1',
            unlockTime: skidrow[skidrow.length - 1].trim(),
            source
        });
    }
    return null;
}

function primitiveRecord(id, value, source = 'local') {
    if (!id || value === undefined || value === null) return null;
    const timestamp = normalizeTimestamp(value);
    return normalizeAchievementItem({
        id,
        displayName: id,
        unlocked: booleanValue(value),
        unlockTime: timestamp,
        source
    });
}

function dedupeItems(items) {
    let data = null;
    for (const item of items) {
        if (!item) continue;
        data = mergeAchievementData(data, {
            schemaVersion: 1,
            updatedAt: 0,
            items: [item]
        });
    }
    return data ? data.items : [];
}

function parseAchievementJson(text, source = 'local-json', options = {}) {
    const root = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    const items = [];
    const visited = new Set();
    const allowPrimitiveRecords = options.allowPrimitiveRecords !== false;

    function visit(value, contextKey = '', inAchievementContainer = false, depth = 0) {
        if (depth > 12 || value === null || value === undefined) return;
        if (typeof value !== 'object') {
            if (allowPrimitiveRecords && contextKey && inAchievementContainer) items.push(primitiveRecord(contextKey, value, source));
            return;
        }
        if (visited.has(value)) return;
        visited.add(value);
        if (Array.isArray(value)) {
            value.forEach(entry => visit(entry, '', true, depth + 1));
            return;
        }

        const lowered = lowerObject(value);
        const explicitId = firstValue(lowered, ID_KEYS);
        const status = firstValue(lowered, STATUS_KEYS);
        const time = firstValue(lowered, TIME_KEYS);
        const metadata = firstValue(lowered, DISPLAY_KEYS) ?? firstValue(lowered, DESCRIPTION_KEYS) ?? lowered.display;
        if (explicitId !== undefined && (status !== undefined || time !== undefined || metadata !== undefined)) {
            items.push(recordFromObject(value, '', source, options));
        } else if (contextKey && (status !== undefined || time !== undefined || metadata !== undefined)) {
            items.push(recordFromObject(value, contextKey, source, options));
        }

        for (const [key, child] of Object.entries(value)) {
            const lowerKey = key.toLowerCase();
            if (explicitId !== undefined && ['display', 'localization', 'localized'].includes(lowerKey)) continue;
            const container = inAchievementContainer || /achievements?|playerstats|userstats|achievementprogress/.test(lowerKey);
            if (child && typeof child === 'object') {
                const childLowered = lowerObject(child);
                const childLooksLikeRecord = firstValue(childLowered, STATUS_KEYS) !== undefined
                    || firstValue(childLowered, TIME_KEYS) !== undefined
                    || firstValue(childLowered, ID_KEYS) !== undefined;
                visit(child, childLooksLikeRecord && !firstValue(childLowered, ID_KEYS) ? key : '', container, depth + 1);
            } else if (allowPrimitiveRecords && (container || depth === 0) && !ID_KEYS.includes(lowerKey) && !DISPLAY_KEYS.includes(lowerKey) && !DESCRIPTION_KEYS.includes(lowerKey)) {
                if (!STATUS_KEYS.includes(lowerKey) && !TIME_KEYS.includes(lowerKey)
                    && !['success', 'gameid', 'appid', 'steamid', 'userid', 'version', 'buildid', 'count'].includes(lowerKey)) {
                    if (/^(true|false|yes|no|on|off|locked|unlocked|achieved|earned|\d+)$/i.test(String(child).trim())) {
                        items.push(primitiveRecord(key, child, source));
                    }
                }
            }
        }
    }

    visit(root);
    return dedupeItems(items);
}

function parseIniSections(text) {
    const sections = new Map();
    let current = '';
    sections.set(current, {});
    for (const rawLine of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('//')) continue;
        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            current = stripQuotes(sectionMatch[1]);
            if (!sections.has(current)) sections.set(current, {});
            continue;
        }
        const separator = line.search(/=|:/);
        if (separator < 1) continue;
        const key = stripQuotes(line.slice(0, separator));
        let value = line.slice(separator + 1).trim();
        const comment = value.search(/\s[;#]/);
        if (comment >= 0) value = value.slice(0, comment).trim();
        sections.get(current)[key] = stripQuotes(value);
    }
    return sections;
}

function parseAchievementIni(text, source = 'local-ini', options = {}) {
    const sections = parseIniSections(text);
    const items = [];

    for (const [sectionName, values] of sections.entries()) {
        const lowerValues = lowerObject(values);
        const generic = !sectionName || GENERIC_SECTIONS.has(sectionName.toLowerCase());
        const hasStatus = firstValue(lowerValues, STATUS_KEYS) !== undefined || firstValue(lowerValues, TIME_KEYS) !== undefined;
        if (!generic && hasStatus) items.push(recordFromObject(values, sectionName, source, options));

        const grouped = new Map();
        for (const [rawKey, rawValue] of Object.entries(values)) {
            const key = stripQuotes(rawKey);
            const lowerKey = key.toLowerCase();
            const groupMatch = lowerKey.match(/^(achievement[_ .-]?\d+)(?:[_ .-]?(id|name|state|achieved|unlocked|unlocktime|timestamp))?$/);
            if (groupMatch) {
                const group = grouped.get(groupMatch[1]) || {};
                group[groupMatch[2] || 'id'] = rawValue;
                grouped.set(groupMatch[1], group);
                continue;
            }

            const propertyMatch = key.match(/^(.+?)[._-](achieved|unlocked|earned|state|unlocktime|unlock_time|timestamp)$/i);
            if (propertyMatch) {
                const groupKey = propertyMatch[1];
                const group = grouped.get(groupKey) || { id: groupKey };
                group[propertyMatch[2]] = rawValue;
                grouped.set(groupKey, group);
                continue;
            }

            if (generic && !STATUS_KEYS.includes(lowerKey) && !TIME_KEYS.includes(lowerKey)
                && !ID_KEYS.includes(lowerKey) && !DISPLAY_KEYS.includes(lowerKey)
                && !DESCRIPTION_KEYS.includes(lowerKey) && !['appid', 'gameid', 'success', 'version'].includes(lowerKey)) {
                const special = recordFromIniValue(key.replace(/"/g, ''), rawValue, source);
                if (special) {
                    items.push(special);
                } else if (/^(true|false|yes|no|on|off|locked|unlocked|achieved|earned|\d+)$/i.test(String(rawValue).trim())) {
                    items.push(primitiveRecord(key, rawValue, source));
                }
            }
        }
        for (const [groupKey, group] of grouped.entries()) {
            const id = group.id || group.name || groupKey;
            items.push(recordFromObject(group, id, source, options));
        }
    }

    const stateEntry = [...sections.entries()].find(([name]) => name.toLowerCase() === 'state');
    const timeEntry = [...sections.entries()].find(([name]) => name.toLowerCase() === 'time');
    if (stateEntry && timeEntry) {
        const times = lowerObject(timeEntry[1]);
        for (const [id, state] of Object.entries(stateEntry[1])) {
            const decodedState = decodeLittleEndianHex(state);
            const unlocked = stripQuotes(state).toLowerCase() === '0101' || decodedState === 1 || booleanValue(state);
            const timeValue = times[id.toLowerCase()];
            const decodedTime = decodeLittleEndianHex(timeValue);
            items.push(normalizeAchievementItem({
                id,
                displayName: id,
                unlocked,
                unlockTime: decodedTime === null ? timeValue : decodedTime,
                source
            }));
        }
    }
    return dedupeItems(items);
}

function parseRazor1911(text, source = 'razor1911') {
    const items = [];
    for (const rawLine of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const [id, state, unlockTime] = rawLine.trim().split(/\s+/);
        if (!id || !/^(0|1)$/.test(state || '')) continue;
        items.push(normalizeAchievementItem({
            id,
            displayName: id,
            unlocked: state === '1',
            unlockTime,
            source
        }));
    }
    return dedupeItems(items);
}

function sourceForPath(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    if (/\/usergamestatsschema_\d+\.bin$/.test(normalized)) return 'steam-schema';
    if (normalized.includes('/librarycache/')) return 'steam-cache';
    if (normalized.includes('goldberg') || normalized.includes('/gse saves/')) return 'goldberg';
    if (normalized.includes('/codex/')) return 'codex';
    if (normalized.includes('/rune/')) return 'rune';
    if (normalized.includes('onlinefix')) return 'onlinefix';
    if (normalized.includes('rld!') || normalized.includes('/rld/')) return 'rld';
    if (normalized.includes('smartsteamemu')) return 'smartsteamemu';
    if (normalized.includes('creamapi')) return 'creamapi';
    if (normalized.includes('/empress/')) return 'empress';
    if (normalized.includes('/skidrow/') || normalized.endsWith('/achiev.ini')) return 'skidrow';
    if (normalized.includes('/3dmgame/')) return '3dm';
    if (normalized.includes('/.1911/') || normalized.endsWith('/achievement')) return 'razor1911';
    if (normalized.includes('/rle/')) return 'rle';
    if (normalized.endsWith('/user_stats.ini')) return 'userstats';
    return 'local';
}

function parseBinaryKeyValues(buffer, options = {}) {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    const maxDepth = Number(options.maxDepth) || 48;
    const maxEntries = Number(options.maxEntries) || 100000;
    let offset = 0;
    let entries = 0;

    function requireBytes(count) {
        if (count < 0 || offset + count > data.length) throw new Error('Achievement schema is truncated.');
    }

    function readCString(encoding = 'utf8') {
        const end = data.indexOf(0, offset);
        if (end < 0 || end - offset > 1024 * 1024) throw new Error('Achievement schema contains an invalid string.');
        const value = data.toString(encoding, offset, end);
        offset = end + 1;
        return value;
    }

    function readWideString() {
        requireBytes(2);
        const characters = data.readUInt16LE(offset);
        offset += 2;
        const bytes = characters * 2;
        requireBytes(bytes);
        const value = data.toString('utf16le', offset, offset + Math.max(0, bytes - 2));
        offset += bytes;
        return value;
    }

    function assign(target, key, value) {
        if (!Object.prototype.hasOwnProperty.call(target, key)) target[key] = value;
        else if (Array.isArray(target[key])) target[key].push(value);
        else target[key] = [target[key], value];
    }

    function readObject(depth) {
        if (depth > maxDepth) throw new Error('Achievement schema nesting is too deep.');
        const result = {};
        while (offset < data.length) {
            if (++entries > maxEntries) throw new Error('Achievement schema contains too many records.');
            const type = data.readUInt8(offset++);
            if (type === 8 || type === 11) break;
            const key = readCString();
            let value;
            if (type === 0) value = readObject(depth + 1);
            else if (type === 1) value = readCString();
            else if (type === 2) { requireBytes(4); value = data.readInt32LE(offset); offset += 4; }
            else if (type === 3) { requireBytes(4); value = data.readFloatLE(offset); offset += 4; }
            else if (type === 4 || type === 6) { requireBytes(4); value = data.readUInt32LE(offset); offset += 4; }
            else if (type === 5) value = readWideString();
            else if (type === 7) { requireBytes(8); value = data.readBigUInt64LE(offset).toString(); offset += 8; }
            else if (type === 10) { requireBytes(8); value = data.readBigInt64LE(offset).toString(); offset += 8; }
            else throw new Error(`Achievement schema uses unsupported field type ${type}.`);
            assign(result, key, value);
        }
        return result;
    }

    return readObject(0);
}

function parseAchievementBinary(buffer, source = 'steam-schema', options = {}) {
    const root = parseBinaryKeyValues(buffer, options);
    return parseAchievementJson(JSON.stringify(root), source, options);
}

const PARSER_REGISTRY = [
    {
        id: 'razor1911',
        matches(filePath) {
            return path.basename(filePath).toLowerCase() === 'achievement';
        },
        parse: parseRazor1911
    },
    {
        id: 'json',
        matches(filePath, text) {
            return path.extname(filePath).toLowerCase() === '.json' || /^[\s\uFEFF]*[\[{]/.test(text);
        },
        parse: parseAchievementJson
    },
    {
        id: 'ini',
        matches() { return true; },
        parse: parseAchievementIni
    }
];

function parseAchievementText(text, filePath = 'achievements.ini', options = {}) {
    const parser = PARSER_REGISTRY.find(candidate => candidate.matches(filePath, text));
    const source = sourceForPath(filePath);
    const parserOptions = {
        ...options,
        sourceFilePath: filePath,
        allowPrimitiveRecords: source === 'steam-cache' ? false : options.allowPrimitiveRecords
    };
    return {
        parser: parser.id,
        source,
        items: parser.parse(text, source, parserOptions)
    };
}

function readAchievementFile(filePath, options = {}) {
    const fileSystem = options.fs || fs;
    const maxBytes = Number(options.maxBytes) || MAX_ACHIEVEMENT_FILE_BYTES;
    const approvedFilePath = Object.hasOwn(options, 'approvedRoots')
        ? resolveApprovedPath(filePath, options, 'file')
        : filePath;
    if (!approvedFilePath) throw new Error('Achievement source is outside its approved local capability.');
    const stat = fileSystem.statSync(approvedFilePath);
    if (!stat.isFile()) throw new Error('Achievement source is not a file.');
    if (stat.size > maxBytes) throw new Error('Achievement source is too large to read safely.');
    const buffer = fileSystem.readFileSync(approvedFilePath);
    if (/^UserGameStatsSchema_\d+\.bin$/i.test(path.basename(approvedFilePath))) {
        return {
            parser: 'binary-vdf',
            source: 'steam-schema',
            items: parseAchievementBinary(buffer, 'steam-schema', { ...options, fs: fileSystem, sourceFilePath: approvedFilePath })
        };
    }
    const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
    return parseAchievementText(text, approvedFilePath, { ...options, fs: fileSystem });
}

module.exports = {
    MAX_ACHIEVEMENT_FILE_BYTES,
    PARSER_REGISTRY,
    localArtworkPath,
    parseAchievementBinary,
    parseAchievementIni,
    parseAchievementJson,
    parseRazor1911,
    parseAchievementText,
    parseBinaryKeyValues,
    readAchievementFile,
    sourceAppId,
    steamArtworkValue,
    sourceForPath
};
