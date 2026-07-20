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

test('removed download providers are absent from the source registry and IPC surface', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.doesNotMatch(index, /\bonlinefix\s*:\s*\{/i);
    assert.doesNotMatch(index, /\bdodi\s*:\s*\{/i);
    assert.match(index, /const dlEnabled = \{ steamgg: true, fitgirl: true, steamrip: false \}/);
    assert.doesNotMatch(main, /ipcMain\.handle\(['"]resolve-onlinefix['"]/i);
});

test('accent highlight preference covers buttons and save scans expose progress', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const maintenance = fs.readFileSync(path.join(root, 'maintenance', 'renderer.js'), 'utf8');
    const maintenanceCss = fs.readFileSync(path.join(root, 'maintenance', 'maintenance.css'), 'utf8');
    assert.match(index, /body\.dropdown-accent-outline button/);
    assert.match(index, /Button &amp; dropdown highlight style/);
    assert.match(index, /browseBtn\.classList\.add\('save-scan-loading'\)/);
    assert.match(maintenance, /data-save-rescan=/);
    assert.match(maintenance, /Scanning Save Folders/);
    assert.match(maintenanceCss, /@keyframes maintenanceSaveScanSpin/);
});
