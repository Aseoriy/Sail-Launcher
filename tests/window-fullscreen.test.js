'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('the titlebar control is the only fullscreen toggle and exposes a Windows restore state', () => {
    assert.match(main, /ipcMain\.on\('window-fullscreen-toggle'[\s\S]{0,220}setWindowFullscreen\(win, !isWindowFullscreen\(win\)\)/);
    assert.match(main, /window-fullscreen-changed/);
    assert.match(main, /enter-full-screen/);
    assert.match(main, /leave-full-screen/);
    assert.match(main, /sendFullscreenState\(enabled\)/);
    assert.match(main, /setAlwaysOnTop\(true, 'screen-saver'\)/);
    assert.match(main, /restoreNormalWindowLevelAfterFullscreen[\s\S]{0,220}setAlwaysOnTop\(false\)/);
    assert.doesNotMatch(main, /ipcMain\.on\('window-max'/);
    assert.match(renderer, /id="maxBtn"[^>]+title="Enter full screen"[^>]+aria-pressed="false"/);
    assert.match(renderer, /window-fullscreen-toggle/);
    assert.match(renderer, /active \? 'restore' : 'maximize'/);
    assert.match(renderer, /icon\.removeAttribute\('data-mode'\)/);
    assert.match(renderer, /active \? 'Exit full screen' : 'Enter full screen'/);
    assert.match(renderer, /'restore':\s+'<path d="M8 7V5[\s\S]{0,180}<rect x="3" y="8" width="13" height="13"/);
    assert.doesNotMatch(renderer, /nativeFullscreenExitBtn|native-fullscreen-exit/);
    assert.match(renderer, /classList\.toggle\('native-fullscreen', active\)/);
});

test('fullscreen preserves normal bounds, restores them on a manual drag, and supports display transfers', () => {
    assert.match(main, /!win\.isMaximized\(\) && !win\.isMinimized\(\) && !isWindowFullscreen\(win\)/);
    assert.match(main, /normalWindowStateBeforeFullscreen\s*=\s*\{[\s\S]{0,180}bounds: wasMaximized \? win\.getNormalBounds\(\) : win\.getBounds\(\)/);
    assert.match(main, /restoreNormalWindowState[\s\S]{0,900}win\.setBounds\(previousState\.bounds\)/);
    assert.match(main, /win\.on\('will-move', \(event, newBounds\)[\s\S]{0,550}newBounds\.x - fullscreenBounds\.x[\s\S]{0,180}event\.preventDefault\(\)[\s\S]{0,100}setNativeFullscreen\(false\)/);
    assert.match(main, /beginDisplayTransfer[\s\S]{0,220}fullscreenDisplayTransferPending = true/);
    assert.match(main, /move-to-display-fullscreen[\s\S]{0,700}setWindowFullscreen\(win, true\)/);
    assert.match(renderer, /bigPictureUsesNativeFullscreen[\s\S]{0,700}window-set-fullscreen', false/);
});
