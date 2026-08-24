'use strict';

const { normalizeAchievementData, summarizeAchievementData } = require('./achievementLogic');

const BROWSE_PAGE = 40;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function achievementSearchText(item, gameName = '') {
    const hidden = !!(item && item.hidden && !item.unlocked);
    const name = hidden ? 'Hidden achievement' : String((item && item.displayName) || '');
    const description = hidden ? '' : String((item && item.description) || '');
    return `${gameName} ${name} ${description}`.toLowerCase();
}

function compactGamePageState(compact) {
    return {
        compact: compact === true,
        contentLayoutDisplay: compact === true ? 'none' : 'flex',
        achievementsPanelHidden: false,
        compactClass: compact === true
    };
}

function gamePagePanelPlacement(gamePageHtml) {
    const html = String(gamePageHtml || '');
    const contentMatch = html.match(/<div[^>]*id=["']gpContentLayout["'][^>]*>/i);
    const panelMatch = html.match(/<(?:section|div)[^>]*id=["']gpAchievementsPanel["'][^>]*>/i);
    if (!contentMatch || !panelMatch) {
        return { contentFound: !!contentMatch, panelFound: !!panelMatch, panelInsideContentLayout: false };
    }
    const contentStart = html.indexOf(contentMatch[0]);
    const panelStart = html.indexOf(panelMatch[0]);
    let depth = 0;
    const tag = /<\/?div\b/gi;
    tag.lastIndex = contentStart;
    let contentEnd = html.length;
    let found = tag.exec(html);
    while (found) {
        if (found[0][1] === '/') {
            depth -= 1;
            if (depth === 0) {
                contentEnd = found.index;
                break;
            }
        } else {
            depth += 1;
        }
        found = tag.exec(html);
    }
    return {
        contentFound: true,
        panelFound: true,
        panelInsideContentLayout: panelStart > contentStart && panelStart < contentEnd
    };
}

function humanizeAchievementId(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const withoutNumber = text.replace(/^\d+_/, '');
    const spaced = withoutNumber
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
    if (!spaced) return text;
    return spaced.replace(/\b\w/g, character => character.toUpperCase());
}

function looksLikeApiName(value, id) {
    const name = String(value || '').trim();
    const rawId = String(id || '').trim();
    if (!name) return true;
    if (name.toLowerCase() === rawId.toLowerCase()) return true;
    return /^\d+_/.test(name) || /_/.test(name) && !/\s/.test(name);
}

function displayName(item, hidden) {
    if (hidden) return 'Hidden achievement';
    const name = String((item && (item.displayName || item.id)) || '').trim();
    if (/^\d+$/.test(name)) return `Achievement ${name}`;
    if (/^hidden$/i.test(name)) return item && item.unlocked ? 'Hidden achievement unlocked' : 'Hidden achievement';
    if (looksLikeApiName(name, item && item.id)) return humanizeAchievementId(name) || name || 'Achievement';
    return name || 'Achievement';
}

function buildAchievementRow(item, game, options = {}) {
    const html = options.escapeHtml || escapeHtml;
    const showGame = options.showGame === true;
    const gameIndex = options.gameIndex;
    const openable = Number.isInteger(gameIndex);
    const hidden = !!(item.hidden && !item.unlocked);
    const name = displayName(item, hidden);
    const description = hidden ? 'Unlock this achievement to reveal its details.' : String(item.description || '').trim();
    const source = item.source && item.source !== 'steam' ? String(item.source).replace(/[-_]/g, ' ') : '';
    const openAttrs = openable
        ? ` tabindex="0" data-achievement-open="${gameIndex}"`
        : '';
    return `
            <div class="achievement-row ${item.unlocked ? 'unlocked' : 'locked'}${openable ? ' is-openable' : ''}"${openAttrs}>
                ${options.imageHtml || ''}
                <div class="achievement-copy">
                    <div class="achievement-name">${html(name)}</div>
                    ${description ? `<div class="achievement-description">${html(description)}</div>` : ''}
                    ${showGame || source ? `<div class="achievement-meta">${[showGame ? game.name : '', source ? `Source: ${source}` : ''].filter(Boolean).map(html).join(' · ')}</div>` : ''}
                </div>
                ${options.stateHtml || ''}
            </div>`;
}

function collectBrowsableAchievements(gameList, options = {}) {
    const search = String(options.search || '').trim().toLowerCase();
    const filter = String(options.filter || 'all');
    const sort = String(options.sort || 'recent');
    const rows = [];
    (Array.isArray(gameList) ? gameList : []).forEach((game, gameIndex) => {
        const data = normalizeAchievementData(game && game.achievementData, game && game.steamAppId);
        if (!data || !data.items.length) return;
        const summary = summarizeAchievementData(data);
        data.items.forEach(item => {
            if (filter === 'unlocked' && !item.unlocked) return;
            if (filter === 'locked' && item.unlocked) return;
            if (search && !achievementSearchText(item, game.name).includes(search)) return;
            rows.push({ game, gameIndex, item, summary });
        });
    });
    if (sort === 'name') {
        rows.sort((left, right) => String(left.item.displayName || '').localeCompare(String(right.item.displayName || ''), undefined, { sensitivity: 'base' }));
    } else if (sort === 'game') {
        rows.sort((left, right) => String(left.game.name || '').localeCompare(String(right.game.name || ''), undefined, { sensitivity: 'base' }));
    } else {
        rows.sort((left, right) => (Number(right.item.unlockTime) || 0) - (Number(left.item.unlockTime) || 0)
            || Number(!!right.item.unlocked) - Number(!!left.item.unlocked)
            || String(left.item.displayName || '').localeCompare(String(right.item.displayName || '')));
    }
    return rows;
}

function pageAchievements(rows, limit) {
    const items = Array.isArray(rows) ? rows : [];
    const page = Number.isInteger(limit) && limit > 0 ? limit : BROWSE_PAGE;
    return {
        shown: items.slice(0, page),
        remaining: Math.max(0, items.length - page),
        total: items.length
    };
}

module.exports = {
    BROWSE_PAGE,
    achievementSearchText,
    buildAchievementRow,
    collectBrowsableAchievements,
    compactGamePageState,
    displayName,
    escapeHtml,
    humanizeAchievementId,
    looksLikeApiName,
    gamePagePanelPlacement,
    pageAchievements
};
