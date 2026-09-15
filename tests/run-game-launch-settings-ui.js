'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
    const { spawn } = require('node:child_process');
    const tempParent = fs.realpathSync(os.tmpdir());
    const tempRoot = fs.mkdtempSync(path.join(tempParent, 'sail-launch-settings-ui-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, '--launch-settings-child', tempRoot], {
        cwd: path.join(__dirname, '..'), env, stdio: 'inherit', windowsHide: true
    });
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 30000);
    child.once('error', error => { failed = true; console.error(error); });
    child.once('close', code => {
        clearTimeout(timer);
        try {
            const resolved = fs.realpathSync(tempRoot);
            assert.equal(resolved, path.resolve(tempRoot));
            assert.equal(path.dirname(resolved), tempParent);
            assert.ok(path.basename(resolved).startsWith('sail-launch-settings-ui-'));
            fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch (error) { failed = true; console.error(error); }
        process.exitCode = failed || code !== 0 ? 1 : 0;
    });
    return;
}

const { app, BrowserWindow } = require('electron');
const rootArg = process.argv.indexOf('--launch-settings-child');
assert.ok(rootArg >= 0, 'Run with node tests/run-game-launch-settings-ui.js');
const tempUserData = fs.realpathSync(process.argv[rootArg + 1]);
assert.equal(path.dirname(tempUserData), fs.realpathSync(os.tmpdir()));
assert.ok(path.basename(tempUserData).startsWith('sail-launch-settings-ui-'));
app.setPath('userData', tempUserData);

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function between(start, end) {
    const startAt = html.indexOf(start);
    const endAt = html.indexOf(end, startAt + start.length);
    assert.ok(startAt >= 0 && endAt > startAt);
    return html.slice(startAt, endAt);
}
const settingsMarkup = between('<div id="gameSettingsModal"', 'id="approveLocalExecutionBtn"');
const settingsFunctions = between('const gameLaunchSettingsDrafts = new Map();', 'async function openGameSettings()');
const modalFunctions = between('const modalStack = [];', 'let currentDropdownTarget = null;');

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({ show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
        (_details, callback) => callback({ cancel: true }));
    try {
        await win.loadURL('data:text/html,<html><body></body></html>');
        await win.webContents.executeJavaScript(`(async () => {
            const assert = require('node:assert/strict');
            document.body.innerHTML = ${JSON.stringify(settingsMarkup)} + 'id="approveLocalExecutionBtn">Save launch options</button>'
                + '<button id="discardLocalExecutionBtn">Discard changes</button><div id="localExecutionSetupStatus"></div></div></div>';
            const launcherProfileState = { activeProfileId: 'test-profile', activeLibraryId: 'test-library' };
            const game = { id: 'fixture-game' };
            let saved = { state: 'active', capabilityId: 'fixture-capability', revision: 1,
                argumentProposal: '--initial', runAsAdmin: true, highPriority: false, companionName: 'helper.exe' };
            let saves = 0;
            const invokeAccount = async (channel, input) => {
                if (channel === 'authority-get-execution-settings') return { ...saved };
                assert.equal(channel, 'authority-configure-execution');
                saves++;
                saved = { ...saved, argumentProposal: input.argumentProposal,
                    runAsAdmin: input.requestElevation, highPriority: input.requestHighPriority };
                return { state: 'active' };
            };
            const safeSyncErrorMessage = error => error.message;
            const pushNavState = () => {};
            const resetAddForm = () => {};
            ${modalFunctions}
            ${settingsFunctions}
            window.closeModal = closeModal;
            await loadGameLaunchSettings(game);
            openModal('gameSettingsModal');
            const args = document.getElementById('launchArgsInput');
            assert.equal(args.value, '--initial');
            args.value = '--profile "Local User"';
            args.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('highPriorityToggle').click();
            document.querySelector('#gameSettingsModal .close-x').click();
            await new Promise(resolve => setTimeout(resolve, 250));
            assert.equal(document.getElementById('gameSettingsModal').classList.contains('show'), false);
            await loadGameLaunchSettings(game);
            openModal('gameSettingsModal');
            assert.equal(args.value, '--profile "Local User"');
            assert.equal(document.getElementById('highPriorityToggle').checked, true);
            assert.equal(saves, 0);
            assert.match(document.getElementById('localExecutionSetupStatus').textContent, /unsaved/i);
            await document.getElementById('approveLocalExecutionBtn').onclick();
            assert.equal(saves, 1);
            assert.equal(saved.argumentProposal, '--profile "Local User"');
            closeModal('gameSettingsModal');
            await new Promise(resolve => setTimeout(resolve, 250));
            await loadGameLaunchSettings(game);
            openModal('gameSettingsModal');
            assert.equal(args.value, saved.argumentProposal);
            assert.match(document.getElementById('localExecutionSetupStatus').textContent, /saved on this PC/i);
        })()`);
        console.log('Manage Game Electron DOM checks passed: type, toggle, close, reopen, save, and reload.');
    } finally { win.destroy(); }
}
main().then(() => app.quit(), error => { console.error(error); app.exit(1); });
