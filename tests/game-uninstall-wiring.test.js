'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const profileStore = fs.readFileSync(path.join(root, 'accounts', 'profileStore.js'), 'utf8');
const capabilityStore = fs.readFileSync(path.join(root, 'security', 'capabilityStore.js'), 'utf8');
const accountIpc = fs.readFileSync(path.join(root, 'accounts', 'ipc.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('download completion records scoped install ownership and uninstall never accepts a renderer path', () => {
    assert.match(profileStore, /adoptTrustedLocalFilesystem\(scope, 'game-install', folderPath, '', 'download-result'\)/);
    assert.match(capabilityStore, /'game-install': \['install-delete'\]/);
    assert.match(capabilityStore, /details\.kind !== 'game-install'/);
    assert.match(accountIpc, /downloaded-game-uninstall-status/);
    assert.match(main, /ipcMain\.handle\('uninstall-downloaded-game'/);
    assert.match(main, /exactGateAPayload\(payload, \[[\s\S]{0,200}'gameId', 'capabilityId', 'expectedRevision', 'removeSailData', 'keepSailData'/);
    assert.doesNotMatch(main, /uninstall-downloaded-game[\s\S]{0,240}folderPath/);
    assert.match(main, /metadata\.source !== 'sail-download'/);
    assert.match(main, /operation: 'install-delete'/);
    assert.match(main, /await removeOwnedInstallDirectory\(install\.details\.rootPath/);
    assert.match(main, /achievementService\.suspendGame\(input\.gameId\)/);
    assert.match(main, /achievementService\.resumeGame\(input\.gameId\)/);
    assert.match(main, /achievementService\.forgetGame\(input\.gameId\)/);
});

test('manage game separates uninstall from metadata-only library removal', () => {
    assert.match(renderer, /id="uninstallGameBtn"[^>]*>🗑️ Uninstall Game</);
    assert.match(renderer, /id="deleteFromPageBtn"[^>]*>🗑️ Remove Game from Library</);
    assert.match(renderer, /Its installed files will not be deleted\./);
    assert.match(renderer, /id="uninstallRemoveSailData"/);
    assert.match(renderer, /id="uninstallKeepSailData"/);
    assert.match(renderer, /Keep this game’s Sail data for reinstalling later/);
    assert.match(renderer, /Sail Cloud save\/config files/);
    assert.match(renderer, /keepSailData: keepSailData\.checked/);
    assert.match(main, /input\.removeSailData && input\.keepSailData/);
    assert.match(profileStore, /retainedGamesPath/);
    assert.match(profileStore, /matchingRetainedDownloadedGame/);
    assert.match(renderer, /ipcRenderer\.invoke\('uninstall-downloaded-game'/);
    assert.match(renderer, /replace\(\/\^Error invoking remote method/);
    assert.match(renderer, /invokeAccount\('profiles-remove-game'/);
    assert.match(main, /Remove Game from Library/);
});

test('optional Sail-data cleanup stays game-scoped and preserves user-selected save folders', () => {
    assert.match(main, /file\.logical_key === `game-save:\$\{gameId\}`/);
    assert.match(main, /const prefix = `game-config:\$\{gameId\}:`/);
    assert.match(main, /strictChildPath\(saveRoot, candidate\)/);
    assert.doesNotMatch(main, /removeSailManagedGameFiles[\s\S]{0,1800}localSavePath/);
    assert.match(renderer, /Your original save and config folders outside the install folder are not deleted\./);
    assert.match(packageJson.scripts.check, /runtime\/gameUninstall\.js/);
});
