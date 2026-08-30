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
    assert.match(achievementRenderer, /function achievementGlyphElement\(unlocked\)/);
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
    assert.match(index, /id="ddpTitle"[^>]+overflow-wrap: anywhere/);
    assert.match(index, /card\.tabIndex = 0;[\s\S]{0,120}card\.setAttribute\('role', 'button'\)/);
    assert.match(index, /card\.onkeydown = event => \{[\s\S]{0,220}event\.key === 'Enter' \|\| event\.key === ' '/);
    assert.match(index, /let dlDetailReturnFocus = null;[\s\S]{0,700}focusTarget\.focus\(\{ preventScroll: true \}\)/);
    assert.match(index, /body\.less-animations #downloadDetailPanel,[\s\S]{0,100}body\.less-animations \.dl-screenshot-viewer/);
});
