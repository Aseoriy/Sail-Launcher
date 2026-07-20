'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeSettings } = require('../maintenance/settings');

test('maintenance settings normalization preserves object identity and toggle changes', () => {
    const saved = { hideInformationIssues: false };
    const normalized = normalizeSettings(saved, { hideInformationIssues: false, maxConcurrentScans: 2, ignorePatterns: [] });
    assert.equal(normalized, saved);
    normalized.hideInformationIssues = true;
    assert.equal(saved.hideInformationIssues, true);
    assert.deepEqual(saved.ignorePatterns, []);
});

test('launcher confirmations use the themed asynchronous dialog', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const maintenance = fs.readFileSync(path.join(root, 'maintenance', 'renderer.js'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(index, /ui\/dialogs\.css/);
    assert.match(index, /ui\/dialogs\.js/);
    assert.doesNotMatch(index, /\bconfirm\s*\(/);
    assert.doesNotMatch(maintenance, /\bconfirm\s*\(/);
    assert.match(index, /sailConfirm\s*\(/);
    assert.ok(packageJson.build.files.includes('ui/**/*'));
});
