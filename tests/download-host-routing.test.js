'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, `${startMarker} is missing`);
    assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
    return source.slice(start, end);
}

test('a host button sends only its selected provider through download IPC', () => {
    const primaryButton = sourceBetween(
        index,
        "window.openDownloadDetail = async function",
        '// A grouped host set:'
    );
    const rowButton = sourceBetween(
        index,
        'function buildSetRow(',
        'window.__sailProbeDownloadHostButtons'
    );
    const setStarter = sourceBetween(
        index,
        'window.startGameDownloadSet = function',
        "ipcRenderer.on('download-engine-status'"
    );

    assert.doesNotMatch(primaryButton, /mirrorUrlsFor\s*\(/);
    assert.doesNotMatch(rowButton, /mirrorUrlsFor\s*\(/);
    assert.doesNotMatch(setStarter, /\bmirrors\b/);
});

test('main resolves only the provider selected by the renderer', () => {
    const normalizer = sourceBetween(
        main,
        'function normalizeDownloadRequest(',
        "ipcMain.handle('download-game'"
    );
    const handler = sourceBetween(
        main,
        "ipcMain.handle('download-game'",
        "ipcMain.handle('pause-download'"
    );

    assert.doesNotMatch(handler, /resolveFirstMirror\s*\(/);
    assert.doesNotMatch(handler, /opts\.mirrors/);
    assert.doesNotMatch(normalizer, /output\.mirrors\s*=\s*input\.mirrors/);
    assert.match(normalizer, /input\.mirrors\.forEach/);
    assert.doesNotMatch(handler, /resolveSelectedLinksSequentially\(/);
    const sourceLoop = handler.indexOf('for (let sourceIndex = 0; sourceIndex < sourceTotal; sourceIndex++)');
    const resolveSelected = handler.indexOf('resolveDirectUrl(sourceLink.url', sourceLoop);
    const consumeSelected = handler.indexOf('runAria2Download(aria2, file', resolveSelected);
    const loopComplete = handler.indexOf('if (!downloadedAny)', consumeSelected);
    assert.ok(sourceLoop >= 0 && resolveSelected > sourceLoop && consumeSelected > resolveSelected && loopComplete > consumeSelected,
        'each selected provider link must resolve and begin downloading inside the same sequential loop');
    assert.match(normalizer, /output\.referer = typedDownloadUrl\(input\.referrer/);
    assert.match(handler, /sourceId: opts\.sourceId,[\s\S]{0,100}referer: opts\.referer/);
    assert.match(index, /sourceId, referrer: item\.url/);
});

test('post-processing failures cannot emit a successful completion', () => {
    const directFinish = sourceBetween(
        main,
        "async function finishCapturedGameDownload",
        "async function captureBrowserDownload"
    );
    const downloadHandler = sourceBetween(
        main,
        "ipcMain.handle('download-game'",
        "ipcMain.handle('pause-download'"
    );
    assert.doesNotMatch(directFinish, /warning:\s*'Saved, but extraction failed/);
    assert.doesNotMatch(downloadHandler, /warning:\s*'Saved, but extraction failed/);
    assert.match(directFinish, /downloaded bytes could not be validated or prepared/i);
    assert.match(downloadHandler, /downloaded bytes could not be validated or prepared/i);
    assert.match(main, /result\.usable\s*=\s*!archiveValidationFailed/);
});

test('completion notifications do not claim manual-step downloads are ready to play', () => {
    const completionHandler = sourceBetween(
        index,
        "ipcRenderer.on('download-complete'",
        '// ---- Debrid services'
    );
    assert.match(completionHandler, /needsManualStep\s*=\s*Boolean\(d\.warning\)\s*\|\|\s*d\.localSetupStatus\s*!==\s*'active'/);
    assert.match(completionHandler, /needsManualStep\s*\?\s*'Download saved'/);
    assert.match(completionHandler, /was saved, but needs a manual setup step/);
    assert.match(index, /needsSetup \? `⚠ Saved · needs setup · \$\{ts\}` : `✓ Installed · \$\{ts\}`/);
});

test('installer payloads cannot register as installed games before a playable exe exists', () => {
    const finish = sourceBetween(
        main,
        'async function finishDownloadJob',
        'function installerTargetForDownload'
    );
    const policy = sourceBetween(
        main,
        'function applyInstallerCompletionPolicy',
        'async function retainDownloadJobError'
    );
    const directFinish = sourceBetween(
        main,
        'async function finishCapturedGameDownload',
        'async function captureBrowserDownload'
    );
    const downloadHandler = sourceBetween(
        main,
        "ipcMain.handle('download-game'",
        "ipcMain.handle('pause-download'"
    );

    assert.match(finish, /publishedResult\.needsInstall !== true/);
    assert.match(finish, /publishedResult\.installFailed !== true/);
    assert.match(finish, /!!publishedResult\.exePath[\s\S]*?fs\.existsSync\(publishedResult\.exePath\)/);
    assert.match(policy, /result\.autoAdd = false/);
    assert.match(policy, /result\.exePath = ''/);
    assert.match(directFinish, /applyInstallerCompletionPolicy\(res, opts\)/);
    assert.match(downloadHandler, /applyInstallerCompletionPolicy\(res, opts\)/);
});

test('an extracted FitGirl repack installs outside its setup and bin payload folder', () => {
    const helperSource = sourceBetween(
        main,
        'function installerTargetForDownload',
        'function applyInstallerCompletionPolicy'
    );
    const installerTargetForDownload = Function('path', `${helperSource}; return installerTargetForDownload;`)(path);
    const downloadDir = path.join('C:\\SailDownloads', 'Example Game');

    assert.equal(
        installerTargetForDownload(downloadDir, path.join(downloadDir, '_game', 'setup.exe')),
        path.join(downloadDir, 'i')
    );
    assert.equal(
        installerTargetForDownload(downloadDir, path.join(downloadDir, 'FitGirl Repack', 'setup.exe')),
        path.join(downloadDir, '_game')
    );
});

test('managed verification downloads have exactly one session owner', () => {
    const sessionHandler = sourceBetween(
        main,
        'const handleSessionDownload = createBrowserWillDownloadHandler',
        'const downloadSessions = new Set'
    );
    const interceptor = sourceBetween(
        main,
        'function interceptDownload(',
        'function managedHostUrlAllowed('
    );
    assert.match(sessionHandler, /managedResolverWebContents\.has\(downloadWebContents\.id\)/);
    assert.match(interceptor, /managedResolverWebContents\.add\(win\.webContents\.id\)/);
    assert.match(interceptor, /managedResolverWebContents\.delete\(win\.webContents\.id\)/);
    assert.match(interceptor, /if \(!accepted\)[\s\S]*?item\.pause\(\)/);
    assert.match(main, /managedVerificationCoordinator\.run\(/);
});
