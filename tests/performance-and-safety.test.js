'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const hardwareMonitor = fs.readFileSync(path.join(root, 'plugins', 'hw-monitor', 'index.js'), 'utf8');

test('all inline renderer scripts compile', () => {
    const scripts = [...index.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0);
    scripts.forEach((match, scriptIndex) => {
        if (match[1].trim()) new vm.Script(match[1], { filename: `index.inline.${scriptIndex + 1}.js` });
    });
});

test('restart and Sail Hub download IPC handlers are registered once', () => {
    assert.equal((main.match(/ipcMain\.on\(['"]restart-app['"]/g) || []).length, 1);
    assert.equal((main.match(/ipcMain\.handle\(['"]hub-download-file['"]/g) || []).length, 1);
    assert.doesNotMatch(main, /resolve\(ipcMain\.handle\(['"]hub-download-file['"]/);
    assert.match(main, /function downloadHubFile\(/);
    assert.match(main, /Only HTTP and HTTPS downloads are supported/);
    assert.match(main, /\.part`/);
});

test('cloud archive IPC uses directory creation supported by node fs', () => {
    assert.doesNotMatch(main, /fs\.ensureDirSync/);
    assert.match(main, /fs\.mkdirSync\(path\.dirname\(zipPath\), \{ recursive: true \}\)/);
    assert.match(main, /fs\.mkdirSync\(localSavePath, \{ recursive: true \}\)/);
});

test('uploaded-file loading is bounded and explains when a full restart is required', () => {
    assert.match(index, /invokeAccount\('account-cloud-list-files', undefined, 10000\)/);
    assert.match(index, /Sail Launcher needs a full restart to load the updated Sail Cloud file service/);
    assert.match(index, /Completely exit Sail Launcher, start it again, then press Refresh List/);
});

test('renderer avoids continuous blob animation and throttles pointer tilt', () => {
    for (const className of ['glass-blob-1', 'glass-blob-2', 'glass-blob-3', 'glass-blob-4']) {
        const start = index.indexOf(`body.glassmorphic-mode .${className}`);
        const end = index.indexOf('}', start);
        assert.ok(start >= 0, `${className} rule is missing`);
        assert.doesNotMatch(index.slice(start, end), /animation\s*:/);
    }
    assert.match(index, /tiltFrame = requestAnimationFrame/);
    assert.match(index, /const _iconPendingRoots = new Set\(\)/);
    assert.match(index, /roots\.forEach\(root => \{ if \(root\.isConnected\) paintIcons\(root\); \}\)/);
    assert.match(index, /content-visibility:\s*auto/);
    assert.match(index, /loading="lazy" decoding="async" class="card-banner"/);
    assert.match(index, /document\.hidden \? hiddenDelay : 10000/);
    assert.match(index, /function queueConfigSync\(\)/);
    assert.doesNotMatch(index, /fs\.writeJsonSync\(dataPath[\s\S]{0,1000}syncConfigToCloud\(\);/);
    assert.doesNotMatch(index, /will-change:\s*(?:transform|box-shadow)/);
    assert.doesNotMatch(index, /glassmorphic-mode \.sidebar \*\s*\{[^}]*transition:\s*all/s);
    assert.match(index, /#accountModal\s*\{[^}]*backdrop-filter:\s*none\s*!important/s);
    assert.match(index, /#accountModal button,[\s\S]*?#accountModal select\s*\{[^}]*backdrop-filter:\s*none\s*!important/s);
});

test('library names are escaped before entering generated markup', () => {
    assert.match(index, /escapeHtml\(game\.name\)/);
    assert.match(index, /escapeHtml\(g\.name\)/);
    assert.match(index, /escapeHtml\(section\.name\)/);
    assert.doesNotMatch(index, /onclick="editSection\('\$\{section\.name\}/);
    assert.match(index, /else if \(!game\.tags\.includes\(sectionId\)\) game\.tags\.push\(sectionId\)/);
    assert.doesNotMatch(index, /myGames\[index\]\.sectionId\s*=/);
});

test('theme styles use defined accent variables and modal fallbacks', () => {
    assert.doesNotMatch(index, /var\(--primary-color\)/);
    assert.doesNotMatch(index, /var\(--accent-color\)/);
    assert.doesNotMatch(index, /background:\s*var\(--modal-bg\);/);
});

test('hardware monitor samples asynchronously and pauses while hidden', () => {
    assert.doesNotMatch(hardwareMonitor, /execSync/);
    assert.match(hardwareMonitor, /execFile\('nvidia-smi\.exe'/);
    assert.match(hardwareMonitor, /gpuQueryInFlight/);
    assert.match(hardwareMonitor, /if \(document\.hidden\) return/);
    assert.match(hardwareMonitor, /setInterval\(update, 5000\)/);
});
