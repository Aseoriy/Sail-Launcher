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
