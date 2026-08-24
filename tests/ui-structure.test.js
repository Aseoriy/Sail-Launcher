'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    achievementSearchText,
    buildAchievementRow,
    collectBrowsableAchievements,
    compactGamePageState,
    gamePagePanelPlacement
} = require('../achievements/achievementView');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const achievementRenderer = fs.readFileSync(path.join(root, 'ui', 'achievements.js'), 'utf8');
const achievementCss = fs.readFileSync(path.join(root, 'ui', 'achievements.css'), 'utf8');

function gamePageHtml() {
    const start = index.indexOf('id="gamePageView"');
    const end = index.indexOf('id="downloadsManagerView"');
    assert.ok(start >= 0 && end > start, 'game page and downloads manager must exist in index.html');
    return index.slice(start, end);
}

test('compact game pages keep achievements outside the hidden content layout', () => {
    const page = gamePageHtml();
    const placement = gamePagePanelPlacement(page);
    assert.equal(placement.contentFound, true);
    assert.equal(placement.panelFound, true);
    assert.equal(placement.panelInsideContentLayout, false);

    const nested = gamePagePanelPlacement(`
        <div id="gpContentLayout"><div class="gp-expandable"></div><section id="gpAchievementsPanel"></section></div>
        <section id="gpMaintenancePanel"></section>
    `);
    assert.equal(nested.panelInsideContentLayout, true);

    const compact = compactGamePageState(true);
    assert.equal(compact.contentLayoutDisplay, 'none');
    assert.equal(compact.achievementsPanelHidden, false);
    assert.match(index, /classList\.toggle\('compact-game-page'/);
    assert.match(index, /#gamePageView\.compact-game-page #gpContentLayout/);
    assert.match(index, /#gamePageView\.compact-game-page #gpAchievementsPanel/);
    assert.doesNotMatch(index, /gpAchievementsPanel'\)\.style\.display = globalSettings\.compactLayout/);
});

test('game pages return to the page that opened them', () => {
    const page = gamePageHtml();
    assert.match(page, /id="gpBackBtn"/);
    assert.match(page, /id="gpBackLabel">Back to Library/);
    assert.match(index, /let gamePageReturnTab = 'library'/);
    assert.match(index, /gamePageReturnTab = normalizeGamePageReturnTab\(returnTab \|\| currentTabName\)/);
    assert.match(index, /await switchMainTab\(returnTab\)/);
    assert.match(index, /gameReturnTab: document\.getElementById\('gamePageView'\)/);
    assert.doesNotMatch(index, /async function closeGamePage\(\) \{[\s\S]{0,320}await switchMainTab\('library'\)/);
});

test('recent unlocks and hub rows are opened through delegated data-achievement-open clicks', () => {
    const row = buildAchievementRow(
        { id: 'WIN', displayName: 'Winner', unlocked: true, unlockTime: 1710000000000 },
        { name: 'Pookie Quest' },
        { showGame: true, gameIndex: 3, imageHtml: '', stateHtml: '' }
    );
    assert.match(row, /data-achievement-open="3"/);
    assert.match(row, /is-openable/);
    assert.match(achievementRenderer, /itemRowElement\(row\.item, row\.game, \{ showGame: true, gameIndex: row\.gameIndex \}\)/);
    assert.match(achievementRenderer, /view\.addEventListener\('click'/);
    assert.match(achievementRenderer, /closest\('\[data-achievement-open\]'\)/);
    assert.match(achievementRenderer, /function openGameFromHub/);
    assert.doesNotMatch(achievementRenderer, /recent\.map\(row => itemRow\(row\.item, row\.game, true\)\)/);
});

test('achievement hub can browse individual achievements instead of only game cards', () => {
    assert.match(index, /id="achievementBrowseList"/);
    assert.match(index, /data-hub-view="browse"/);
    assert.match(index, /data-hub-view="games"/);
    assert.match(achievementRenderer, /collectBrowsableAchievements/);
    assert.match(achievementRenderer, /function switchHubView/);
    assert.match(achievementRenderer, /applyHubView\(true\)/);
    assert.match(index, /achievement-hub-panes/);
    assert.match(index, /id="achievementBrowseCollapse"/);
    assert.match(achievementRenderer, /browseCollapse\.addEventListener\('click'/);
    assert.match(achievementCss, /\.achievement-hub-panes > \.hub-view-pane[\s\S]{0,220}position: absolute/);
    assert.match(achievementCss, /\.hub-view-pane\.hub-view-active[\s\S]{0,100}position: relative/);
    assert.match(achievementCss, /\.achievement-game-grid[\s\S]{0,180}grid-auto-rows: max-content/);
    assert.match(achievementRenderer, /achievements-import-steam-schema/);
    const rows = collectBrowsableAchievements([
        {
            name: 'Quest',
            achievementData: {
                items: [
                    { id: 'A', displayName: 'First win', unlocked: true, unlockTime: 200, hidden: false },
                    { id: 'B', displayName: 'Secret', unlocked: false, hidden: true, description: 'hidden-secret-token' }
                ]
            }
        }
    ], { search: 'hidden-secret-token', filter: 'all' });
    assert.equal(rows.length, 0);
    assert.match(achievementSearchText({ hidden: true, unlocked: false, displayName: 'Secret', description: 'hidden-secret-token' }, 'Quest'), /hidden achievement/);
    assert.doesNotMatch(achievementSearchText({ hidden: true, unlocked: false, displayName: 'Secret', description: 'hidden-secret-token' }, 'Quest'), /hidden-secret-token/);
});

test('achievement browse sorting reuses one summary per game and renders after the select updates', () => {
    const rows = collectBrowsableAchievements([{
        name: 'Big Quest',
        achievementData: {
            items: Array.from({ length: 500 }, (_value, index) => ({
                id: `ACH_${index}`,
                displayName: `Achievement ${index}`,
                unlocked: index % 2 === 0,
                unlockTime: index + 1000000000
            }))
        }
    }], { sort: 'name' });
    assert.equal(rows.length, 500);
    assert.equal(rows[0].summary, rows[1].summary);
    assert.match(achievementRenderer, /sort\.addEventListener\('input', updateSort\)/);
    assert.match(achievementRenderer, /requestAnimationFrame\(renderHub\)/);
});

test('achievement hub offers back to top only after its search leaves the scroll viewport', () => {
    assert.match(index, /id="achievementBackToTop"[^>]*hidden/);
    assert.match(achievementRenderer, /search\.getBoundingClientRect\(\)\.bottom <= scrollerRect\.top/);
    assert.match(achievementRenderer, /mainScroller\.addEventListener\('scroll', scheduleBackToTopUpdate/);
    assert.match(achievementRenderer, /scroller\.scrollTo\(\{ top: 0, behavior: useMotion \? 'smooth' : 'auto' \}\)/);
    assert.match(achievementRenderer, /search\.focus\(\{ preventScroll: true \}\)/);
    assert.match(achievementCss, /\.achievement-back-to-top\s*\{[\s\S]{0,120}position: fixed/);
    assert.match(achievementCss, /\.achievement-back-to-top\[hidden\][\s\S]{0,80}display: none !important/);
});

test('less animations no longer nukes every transition while reduced motion still can', () => {
    assert.doesNotMatch(index, /body\.less-animations \*:not\(\.spin-icon\)/);
    assert.match(index, /body\.less-animations::before/);
    assert.match(index, /body\.less-animations \.game-card:hover/);
    assert.match(index, /Turns off page slides, background motion, card lifts/);
    assert.match(index, /body\.classList\.toggle\('reduce-motion'/);
    assert.match(index, /body\.reduce-motion \*:not\(\.spin-icon\)/);
    assert.match(index, /playbackRate = osReduceMotion \? 1000 : speed/);
    assert.doesNotMatch(index, /playbackRate = globalSettings\.lessAnimations \? 1000/);
});

test('cloud save sync reports compression and destination upload stages', () => {
    assert.match(index, /function setCloudSyncProgress/);
    assert.match(index, /setCloudSyncProgress\(statusText, 'Compressing save files…'\)/);
    assert.match(index, /setCloudSyncProgress\(statusText, `Uploading to \$\{destinationLabels\.join\(', '\)\}…`\)/);
    assert.match(index, /setCloudSyncProgress\(statusText, 'Uploading to Sail Cloud…'\)/);
    assert.match(index, /id="globalSyncIndicatorLabel"/);
});
