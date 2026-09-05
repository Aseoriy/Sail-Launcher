'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const hardwareMonitorPath = [
    path.join(root, 'plugins', 'HW-Monitor', 'hw-monitor', 'index.js'),
    path.join(root, 'plugins', 'hw-monitor', 'index.js')
].find(fs.existsSync);
assert.ok(hardwareMonitorPath, 'hardware monitor plugin source is missing');
const hardwareMonitor = fs.readFileSync(hardwareMonitorPath, 'utf8');

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

test('main-window lifecycle listeners register before packaged navigation starts', () => {
    const start = main.indexOf('function createWindow()');
    const end = main.indexOf('// Restart App Hook', start);
    assert.ok(start >= 0 && end > start);
    const createWindow = main.slice(start, end);
    const loadIndex = createWindow.indexOf("win.loadFile('index.html')");
    assert.ok(loadIndex > 0);
    assert.ok(createWindow.indexOf("win.webContents.on('did-finish-load'") < loadIndex);
    assert.ok(createWindow.indexOf("win.webContents.on('render-process-gone'") < loadIndex);
    assert.equal((createWindow.match(/win\.loadFile\('index\.html'\)/g) || []).length, 1);
});

test('cloud archive IPC uses directory creation supported by node fs', () => {
    assert.doesNotMatch(main, /fs\.ensureDirSync/);
    assert.match(main, /fs\.mkdirSync\(path\.dirname\(zipPath\), \{ recursive: true \}\)/);
    assert.match(main, /fs\.mkdirSync\(extractionPath, \{ recursive: true \}\)/);
});

test('plugin archive IPC delegates to the safe shared extractor', () => {
    const handlerStart = main.indexOf("ipcMain.handle('extract-zip'");
    const handlerEnd = main.indexOf("ipcMain.handle('extract-rar'", handlerStart);
    assert.ok(handlerStart >= 0);
    assert.ok(handlerEnd > handlerStart);
    const handler = main.slice(handlerStart, handlerEnd);
    assert.match(handler, /await extractArchive\(zipPath, destPath\)/);
    assert.doesNotMatch(handler, /child_process|exec\(|powershell\s+-Command|Expand-Archive/);

    const fallbackStart = main.indexOf('function extractArchive(');
    const fallbackEnd = main.indexOf('// Read the leading bytes', fallbackStart);
    assert.ok(fallbackStart >= 0);
    assert.ok(fallbackEnd > fallbackStart);
    const extractor = main.slice(fallbackStart, fallbackEnd);
    assert.match(extractor, /replace\(\/\'\/g, "\'\'"\)/);
    assert.match(extractor, /runOwnedChildProcess\('powershell', \['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd\], work\)/);
});

test('game extraction and recursive preparation stay off Electron main thread', () => {
    const rarStart = main.indexOf('async function extractRar(');
    const rarEnd = main.indexOf('async function extractArchive(', rarStart);
    const rar = main.slice(rarStart, rarEnd);
    assert.match(rar, /runOwnedWorker\(ARCHIVE_EXTRACT_WORKER,/);
    assert.doesNotMatch(rar, /extractor\.extract\(|for \(const _f of result\.files\)/);

    const postStart = main.indexOf('async function postProcessDownloadBody(');
    const postEnd = main.indexOf('// Generic repair bundles', postStart);
    const post = main.slice(postStart, postEnd);
    assert.match(post, /runDownloadPreparation\('normalize-archives'/);
    assert.match(post, /await scanDownloadedPayload\(dir, opts\.gameName, work\)/);
    assert.match(post, /runDownloadPreparation\('clean-extracted-junk'/);
    assert.match(post, /runDownloadPreparation\('delete-archive-sources'/);
    assert.doesNotMatch(post, /normalizeArchiveExtensions\(dir, 0\)|findArchives\(dir\)|dirSizeBytes\(extractTo/);

    const capturedStart = main.indexOf('async function finishCapturedGameDownload(');
    const capturedEnd = main.indexOf('async function captureBrowserDownload(', capturedStart);
    const captured = main.slice(capturedStart, capturedEnd);
    assert.match(captured, /await preparedDirectorySize\(installTarget, null\)/);
    assert.match(captured, /await scanDownloadedPayload\(installTarget, opts\.gameName, work\)/);
    assert.doesNotMatch(captured, /dirSizeBytes\(|findGameExe\(|cleanRepackSource\(/);
});

test('aria2 downloads keep HTTPS certificate validation enabled', () => {
    assert.match(main, /--check-certificate=true/);
    assert.doesNotMatch(main, /--check-certificate=false/);
});

test('legacy Rutor links are upgraded narrowly while the HTTPS download gate stays closed', () => {
    const start = main.indexOf('function boundedDownloadText(');
    const end = main.indexOf('function normalizeDownloadRequest(', start);
    assert.ok(start >= 0 && end > start);
    const typedDownloadUrl = vm.runInNewContext(`(() => { ${main.slice(start, end)}; return typedDownloadUrl; })()`, { URL });
    assert.equal(
        typedDownloadUrl('http://rutor.info/torrent/1018701/example', 'Download URL'),
        'https://rutor.info/torrent/1018701/example'
    );
    assert.throws(() => typedDownloadUrl('http://example.com/file.zip', 'Download URL'), /credential-free HTTPS/);
    assert.throws(() => typedDownloadUrl('http://rutor.info.evil.example/file.zip', 'Download URL'), /credential-free HTTPS/);
    assert.match(main, /magnet\[1\]\.replace\(\/&amp;\/gi, '&'\)/);
});

test('legacy OAuth connections bind callbacks to a one-time state value', () => {
    const cloudSync = fs.readFileSync(path.join(root, 'cloudSync.js'), 'utf8');
    assert.match(main, /crypto\.randomBytes\(32\)\.toString\('hex'\)/);
    assert.match(main, /cloudSync\.appendOauthState\(authUrl, oauthState\)/);
    assert.match(main, /cloudSync\.startOauthServer\(oauthState\)/);
    assert.match(cloudSync, /const callbackStateBuffer = Buffer\.from\(callbackState \|\| ''\)/);
    assert.match(cloudSync, /crypto\.timingSafeEqual\(callbackStateBuffer, expectedStateBuffer\)/);
    assert.match(cloudSync, /if \(callbackConsumed\)/);
    assert.match(cloudSync, /activeOauthServer\.listen\(REDIRECT_PORT, 'localhost'\)/);
});

test('uploaded-file loading is bounded and explains when a full restart is required', () => {
    assert.match(index, /invokeAccount\('account-cloud-list-files', undefined, 10000\)/);
    assert.match(index, /Sail Launcher needs a full restart to load the updated Sail Cloud file service/);
    assert.match(index, /Completely exit Sail Launcher, start it again, then press Refresh List/);
});

test('renderer avoids continuous blob animation and throttles the card pointer spotlight', () => {
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
    assert.match(index, /image\.loading = 'lazy';\s*image\.decoding = 'async'/);
    assert.match(index, /document\.hidden \? hiddenDelay : 10000/);
    assert.match(index, /function queueConfigSync\(\)/);
    assert.doesNotMatch(index, /fs\.writeJsonSync\(dataPath[\s\S]{0,1000}syncConfigToCloud\(\);/);
    assert.doesNotMatch(index, /will-change:\s*(?:transform|box-shadow)/);
    assert.doesNotMatch(index, /glassmorphic-mode \.sidebar \*\s*\{[^}]*transition:\s*all/s);
    assert.match(index, /#accountModal\s*\{[^}]*backdrop-filter:\s*none\s*!important/s);
    assert.match(index, /#accountModal button,[\s\S]*?#accountModal select\s*\{[^}]*backdrop-filter:\s*none\s*!important/s);
});

test('library names enter privileged DOM only through text properties', () => {
    assert.match(index, /className: 'card-title', text: String\(game\.name \|\| ''\)\.slice\(0, 256\)/);
    assert.match(index, /className: 'continue-title', text: String\(g\.name \|\| ''\)\.slice\(0, 256\)/);
    assert.match(index, /className: 'folder-name', text: String\(section\.name \|\| ''\)\.slice\(0, 128\)/);
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
