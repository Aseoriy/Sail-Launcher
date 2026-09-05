'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const achievementRenderer = fs.readFileSync(path.join(root, 'ui', 'achievements.js'), 'utf8');
const achievementCss = fs.readFileSync(path.join(root, 'ui', 'achievements.css'), 'utf8');
const dialogs = fs.readFileSync(path.join(root, 'ui', 'dialogs.js'), 'utf8');
const dialogsCss = fs.readFileSync(path.join(root, 'ui', 'dialogs.css'), 'utf8');
const achievementService = fs.readFileSync(path.join(root, 'achievements', 'achievementService.js'), 'utf8');

test('visual regressions use the themed icon and dialog systems', () => {
    const downloads = index.slice(index.indexOf('<div id="downloadsView"'), index.indexOf('<div id="downloadsManagerView"'));
    assert.match(downloads, /data-ic="skull"/);
    assert.doesNotMatch(downloads, /🏴‍☠️/);
    assert.match(index, /const DL_CATS = \[[\s\S]{0,180}icon: 'folder'/);
    assert.match(index, /function dlIconElement\(name\)/);
    assert.match(index, /dlIconElement\(c\.icon\)/);
    assert.match(index, /data-ic="folder-open"/);
    assert.match(index, /\.account-pill[\s\S]{0,500}height: 28px/);
    assert.match(index, /'heart':\s+'<path/);
    assert.match(index, /favoriteIcon\.dataset\.ic = 'heart'/);
    assert.match(index, /favoriteButton\.setAttribute\('aria-pressed', String\(isFav\)\)/);
    assert.doesNotMatch(index, /className: `friend-fav-btn[\s\S]{0,120}text: '★'/);
    assert.match(achievementRenderer, /function themedIconElement\(name, ownerDocument = document\)/);
    assert.match(achievementRenderer, /function achievementGlyphElement\(unlocked\)/);
    assert.match(achievementRenderer, /return themedIconElement\(unlocked \? 'trophy' : 'lock'\)/);
    assert.match(achievementRenderer, /const marker = themedIconElement\('trophy', document\)/);
    assert.doesNotMatch(achievementRenderer, /textContent = '🏆'/);
    assert.doesNotMatch(achievementRenderer, /const icon = '<svg/);
    assert.match(achievementCss, /\.gp-achievement-list::-webkit-scrollbar/);
    assert.match(achievementCss, /#achievementSearchInput,[\s\S]{0,100}#achievementFilterSelect/);
    assert.match(achievementCss, /-webkit-text-fill-color: var\(--text-color\)/);
    assert.match(achievementRenderer, /removeStoredCacheCounters/);
    assert.match(index, /\.dlpage-cover\s*\{[\s\S]{0,180}overflow: hidden/);
    assert.match(index, /\.dlpage-cover img\s*\{[\s\S]{0,160}object-fit: cover/);
});

test('achievement source selection stays inside the themed renderer dialog', () => {
    assert.match(dialogs, /window\.sailChoice/);
    assert.match(dialogs, /sail-dialog-choice-list/);
    assert.match(dialogsCss, /\.sail-dialog-choice/);
    assert.match(achievementRenderer, /window\.sailChoice\('Choose whether to attach/);
    assert.match(achievementService, /async pickSource\(request = \{\}\)/);
    assert.doesNotMatch(achievementService, /showMessageBox/);
});

test('download popover stays compact for long names and manual page rows hide raw URLs', () => {
    assert.match(index, /\.dl-dock-name\s*\{[\s\S]{0,400}text-overflow: ellipsis;[\s\S]{0,100}white-space: nowrap;/);
    assert.match(index, /\.dl-dock-row > \.dl-state-text\s*\{[\s\S]{0,300}text-overflow: ellipsis;[\s\S]{0,100}white-space: nowrap;/);
    assert.match(index, /\.dl-dock-actions\s*\{[\s\S]{0,160}flex-shrink: 0;/);
    assert.match(index, /if \(link\.type !== 'page'\) \{\s*label\.append\(SafeDom\.element\(document, 'div', \{ text: String\(link\.url/);
    assert.match(index, /className: page \? 'dlpage-name' : 'dl-dock-name',[\s\S]{0,120}title: displayName/);
    assert.match(index, /text: stateText,\s*title: stateText/);
    assert.match(index, /\.dl-card \.dl-play > span\s*\{/);
    assert.match(index, /playIcon\.dataset\.ic = 'play'/);
    assert.match(index, /return DownloadSourceLogic\.groupDownloadSets\(links, sourceId,/);
    assert.match(index, /function isExternalBrowserOnlyHost\(host\) \{[\s\S]{0,180}akirabox/);
    assert.match(index, /function isCFBlockedHost\(host\) \{\s*return isExternalBrowserOnlyHost\(host\);/);
    assert.match(index, /function isRestrictedHost\(host\) \{[\s\S]{0,260}return false;/);
    assert.match(index, /b\.onclick = \(\) => startRestrictedBrowserDownload\(item, set, sourceId\)/);
});

test('download detail layout stays polished, responsive, and keyboard accessible', () => {
    assert.match(index, /class="download-detail-backbar"/);
    assert.match(index, /\.download-detail-backbar\s*\{[\s\S]{0,420}width: max-content;[\s\S]{0,220}background: transparent;/);
    assert.match(index, /\.download-detail-back-button\s*\{[\s\S]{0,260}display: inline-flex;[\s\S]{0,160}gap: 7px;/);
    assert.match(index, /\.download-meta-row\s*\{[\s\S]{0,300}display: grid;[\s\S]{0,160}column-gap: 12px;/);
    assert.match(index, /\.download-meta-row > span:last-child\s*\{[\s\S]{0,220}overflow-wrap: anywhere;/);
    assert.match(index, /\.download-option-row\s*\{[\s\S]{0,220}flex-wrap: wrap;/);
    assert.match(index, /\.download-option-copy\s*\{[\s\S]{0,240}overflow-wrap: anywhere;/);
    assert.match(index, /\.dl-screenshot-viewer-close\s*\{[\s\S]{0,300}display: inline-flex;[\s\S]{0,260}padding: 0;[\s\S]{0,260}line-height: 1;/);
    assert.match(index, /\.dl-screenshot-stage\s*\{[\s\S]{0,220}position: relative;[\s\S]{0,220}width: min\(78vw, 1200px\)/);
    assert.match(index, /\.dl-screenshot-viewer img\.enter-from-right/);
    assert.match(index, /\.dl-screenshot-viewer img\.exit-to-left/);
    assert.match(index, /\.dl-screenshot-viewer-nav\.previous\s*\{ left: -68px; \}/);
    assert.match(index, /\.dl-screenshot-viewer-nav\s*\{[\s\S]{0,320}width: 42px;[\s\S]{0,100}height: 42px;[\s\S]{0,100}border-radius: 50% !important;/);
    assert.match(index, /#downloadScreenshotViewer \.dl-screenshot-viewer-nav:hover\s*\{[\s\S]{0,180}translateY\(-50%\) !important;[\s\S]{0,180}filter: brightness/);
    assert.doesNotMatch(index, /#downloadScreenshotViewer \.dl-screenshot-viewer-nav:hover\s*\{[^}]*scale\(/);
    assert.match(index, /image\.className = 'dl-screenshot-image';/);
    assert.match(index, /viewer\.id = 'downloadScreenshotViewer';/);
    assert.match(index, /body\.reduce-motion \.dl-screenshot-viewer img/);
    assert.match(index, /id="ddpTitle"[^>]+overflow-wrap: anywhere/);
    assert.match(index, /card\.tabIndex = 0;[\s\S]{0,120}card\.setAttribute\('role', 'button'\)/);
    assert.match(index, /card\.onkeydown = event => \{[\s\S]{0,220}event\.key === 'Enter' \|\| event\.key === ' '/);
    assert.match(index, /let dlDetailReturnFocus = null;[\s\S]{0,700}focusTarget\.focus\(\{ preventScroll: true \}\)/);
    assert.match(index, /body\.less-animations #downloadDetailPanel,[\s\S]{0,100}body\.less-animations \.dl-screenshot-viewer/);
});

test('shared UI polish keeps roles distinct without bypassing theme or accessibility hooks', () => {
    const polish = index.slice(index.indexOf('<style id="sailDesignPolish">'), index.indexOf('</style>', index.indexOf('<style id="sailDesignPolish">')));

    assert.doesNotMatch(polish, /fonts\.googleapis\.com|Claude Design|prototype-style/);
    assert.match(polish, /\.sidebar-page-nav\s*\{[\s\S]{0,260}border:\s*0;[\s\S]{0,180}background:\s*transparent;/);
    assert.match(polish, /#mainSidebar \.sidebar-page-link\.active-tab\s*\{[\s\S]{0,500}box-shadow:\s*inset 0 0 0 1px color-mix/);
    assert.match(polish, /#mainSidebar \.sidebar-sub-item\.active\s*\{[\s\S]{0,520}border:\s*0 !important;[\s\S]{0,420}box-shadow:\s*inset 0 0 0 1px color-mix/);
    assert.doesNotMatch(polish, /box-shadow:\s*inset 2px 0 0 var\(--accent\)/);
    assert.match(polish, /body:not\(\.theme-custom\) \.search-bar\s*\{[\s\S]{0,100}border-radius:\s*6px !important/);
    assert.match(polish, /\.library-toolbar-select:hover,[\s\S]{0,420}border-color:\s*color-mix\(in srgb, var\(--text-color\) 24%, transparent\) !important/);
    assert.match(polish, /:is\(#actionButtonsGroup,[^}]+button\[data-btn-id\]\.outline:hover\s*\{[\s\S]{0,420}border-color:\s*color-mix\(in srgb, var\(--text-color\) 20%, transparent\) !important/);
    assert.match(polish, /#downloadSearchPanel > \.toolbar\s*\{[\s\S]{0,320}border-bottom:\s*1px solid/);
    assert.match(polish, /body\.dedicated-settings-page #settingsModal \.settings-tab\.active\s*\{[\s\S]{0,420}box-shadow:\s*inset 0 0 0 1px color-mix/);
    assert.doesNotMatch(polish, /border-left-color:\s*var\(--accent\) !important/);
    assert.match(polish, /#socialSidebar \.friend-fav-btn\[aria-pressed="true"\][\s\S]{0,260}background:\s*color-mix\(in srgb, var\(--accent\) 14%, transparent\) !important/);
    assert.match(polish, /body\.theme-custom #mainSidebar \.sidebar-page-link,[\s\S]{0,900}var\(--custom-theme-control-radius/);
    assert.match(polish, /body\.theme-custom #achievementsView \.achievement-view-toggle button\s*\{[\s\S]{0,140}var\(--custom-theme-control-radius/);
    assert.match(polish, /@media \(prefers-reduced-motion: reduce\)/);

    assert.match(achievementCss, /\.achievement-summary-card::after\s*\{\s*display:\s*none;/);
    assert.match(achievementCss, /\.achievement-view-toggle button\.active,[\s\S]{0,440}box-shadow:[\s\S]{0,120}inset 0 0 0 1px color-mix/);
    assert.doesNotMatch(achievementCss, /\.achievement-view-toggle button\.active,[\s\S]{0,440}inset 0 -2px 0 var\(--accent\)/);
    assert.match(achievementCss, /\.achievement-game-card\s*\{[\s\S]{0,260}border-radius:\s*14px;/);
    assert.match(achievementCss, /\.achievement-game-art\s*\{[\s\S]{0,180}overflow:\s*hidden;/);
    assert.match(achievementCss, /\.achievement-game-art img\s*\{[\s\S]{0,220}width:\s*100%;[\s\S]{0,100}height:\s*100%;[\s\S]{0,120}object-fit:\s*cover;/);
    assert.match(achievementCss, /\.achievement-row\.is-openable:focus-visible\s*\{[\s\S]{0,260}outline:\s*2px solid var\(--accent\)/);
});

test('library list view is a compact themed row layout instead of stacked game tiles', () => {
    const polish = index.slice(index.indexOf('<style id="sailDesignPolish">'), index.indexOf('</style>', index.indexOf('<style id="sailDesignPolish">')));

    assert.match(polish, /#gameGrid\.list-view\s*\{[\s\S]{0,180}grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]{0,120}container:\s*library-list \/ inline-size;[\s\S]{0,120}gap:\s*0;[\s\S]{0,280}var\(--card-bg\)/);
    assert.match(polish, /#gameGrid\.list-view \.game-card\s*\{[\s\S]{0,220}grid-template-areas:\s*"copy achievement stop favorite";[\s\S]{0,260}min-height:\s*58px !important;/);
    assert.match(polish, /#gameGrid\.list-view \.game-card\s*\{[\s\S]{0,700}border-radius:\s*0 !important;[\s\S]{0,260}animation:\s*none !important;/);
    assert.match(polish, /#gameGrid\.list-view \.game-card:hover,[\s\S]{0,320}transform:\s*none !important;/);
    assert.match(polish, /body\.keep-list-covers #gameGrid\.list-view \.game-card\s*\{[\s\S]{0,180}grid-template-areas:\s*"art copy achievement stop favorite";[\s\S]{0,120}68px/);
    assert.match(polish, /body\.keep-list-covers #gameGrid\.list-view \.game-card \.card-banner,[\s\S]{0,420}width:\s*68px !important;[\s\S]{0,100}height:\s*42px !important;/);
    assert.match(polish, /#gameGrid\.list-view \.game-card \.card-text-area\s*\{[\s\S]{0,240}grid-template-columns:\s*minmax\(0, 1fr\) minmax\(110px, auto\);/);
    assert.match(polish, /#gameGrid\.list-view \.achievement-card-badge\s*\{[\s\S]{0,260}position:\s*static !important;[\s\S]{0,260}background:\s*transparent;/);
    assert.match(polish, /#gameGrid\.list-view \.game-card\.selected\s*\{[\s\S]{0,260}var\(--accent\)/);
    assert.match(polish, /body\.big-picture-mode #gameGrid\.list-view \.game-card\.selected\s*\{[\s\S]{0,100}padding-left:\s*46px !important;/);
    assert.match(polish, /body\.theme-custom #gameGrid\.list-view\s*\{[\s\S]{0,120}var\(--custom-theme-surface-radius/);
    assert.match(polish, /@media \(max-width: 880px\)[\s\S]{0,700}grid-template-columns:\s*minmax\(0, 1fr\);/);
    assert.match(polish, /@container library-list \(max-width: 420px\)[\s\S]{0,380}grid-template-areas:\s*"copy favorite";[\s\S]{0,700}display:\s*none !important;/);
    assert.match(polish, /body\.less-animations #gameGrid\.list-view \.game-card\s*\{[\s\S]{0,100}transition-duration:\s*\.12s !important;/);
    assert.match(polish, /body\.reduce-motion #gameGrid\.list-view \.game-card,[\s\S]{0,340}transition:\s*none !important;[\s\S]{0,100}transform:\s*none !important;/);

    assert.match(index, /id="viewToggleBtn"[^>]+aria-label="Switch to list view" aria-pressed="false"/);
    assert.match(index, /function syncLibraryViewToggle\(\)[\s\S]{0,420}button\.setAttribute\('aria-pressed', String\(isListView\)\)/);
    assert.match(index, /window\.toggleViewMode = function \(\) \{[\s\S]{0,500}syncLibraryViewToggle\(\);/);
});

test('library artwork hover and continue-playing banner do not expose edge gaps', () => {
    const polish = index.slice(index.indexOf('<style id="sailDesignPolish">'), index.indexOf('</style>', index.indexOf('<style id="sailDesignPolish">')));

    assert.match(index, /const HOVER_CORRIDOR_PX = 24;/);
    assert.match(index, /function getHoverCorridor\(card\) \{\s*return Math\.max\(HOVER_CORRIDOR_PX, getLift\(card\) \+ 12\);/);
    assert.match(index, /function canExtendHover\(card\)[\s\S]{0,520}!grid\.classList\.contains\('list-view'\)[\s\S]{0,260}!document\.body\.classList\.contains\('reduce-motion'\)/);
    assert.match(index, /function isInHoverCorridor\(card, clientX, clientY\)[\s\S]{0,320}clientY >= r\.bottom - corridor[\s\S]{0,100}clientY <= r\.bottom \+ corridor/);
    assert.match(index, /if \(isInHoverCorridor\(card, e\.clientX, e\.clientY\)\)[\s\S]{0,260}card\.classList\.add\('hover-extend'\)/);
    assert.match(index, /const overCard = e\.target[\s\S]{0,240}if \(overCard && overCard !== extendedCard\)/);
    assert.match(index, /if \(overCard === extendedCard\) return;/);
    assert.match(index, /document\.addEventListener\('mouseleave', clearExtendedHover[\s\S]{0,120}window\.addEventListener\('blur', clearExtendedHover/);
    assert.doesNotMatch(index, /r\.bottom \+ lift \+ 2/);
    assert.match(polish, /\.game-card:not\(\.selected\):hover::before,[\s\S]{0,160}\.game-card:not\(\.selected\)\.hover-extend::before[\s\S]{0,100}opacity:\s*1;/);
    assert.match(polish, /\.game-card:hover \.sl-play-orb,[\s\S]{0,140}\.game-card\.hover-extend \.sl-play-orb[\s\S]{0,120}opacity:\s*1;/);

    assert.match(polish, /\.continue-card\s*\{[\s\S]{0,360}background-repeat:\s*no-repeat, no-repeat !important;/);
    assert.match(polish, /\.continue-card\s*\{[\s\S]{0,460}background-size:\s*100% 100%, cover !important;[\s\S]{0,100}background-position:\s*left top, right center !important;/);
    assert.match(polish, /\.continue-card\s*\{[\s\S]{0,620}background-origin:\s*border-box, border-box !important;[\s\S]{0,100}background-clip:\s*border-box, border-box !important;/);
});

test('workshop results normalize preview geometry and center card content', () => {
    const polish = index.slice(index.indexOf('<style id="sailDesignPolish">'), index.indexOf('</style>', index.indexOf('<style id="sailDesignPolish">')));

    assert.doesNotMatch(index, /card\.style\.height\s*=\s*'100%'/);
    assert.match(polish, /#workshopPageResults \.workshop-page-card\s*\{[\s\S]{0,220}height:\s*330px;[\s\S]{0,140}grid-template-rows:\s*190px minmax\(0, 1fr\);/);
    assert.match(polish, /#workshopPageResults \.workshop-card-preview\s*\{[\s\S]{0,100}position:\s*relative;/);
    assert.match(polish, /#workshopPageResults \.workshop-card-preview img\s*\{[\s\S]{0,140}position:\s*absolute;[\s\S]{0,80}inset:\s*0;[\s\S]{0,300}object-fit:\s*contain;[\s\S]{0,80}object-position:\s*center;/);
    assert.match(polish, /#workshopPageResults \.workshop-card-copy\s*\{[\s\S]{0,220}align-items:\s*center;/);
    assert.match(polish, /#workshopPageResults \.workshop-card-actions\s*\{[\s\S]{0,180}flex-direction:\s*column;[\s\S]{0,140}justify-content:\s*center;/);
});
