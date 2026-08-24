'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const maintenance = fs.readFileSync(path.join(root, 'maintenance', 'renderer.js'), 'utf8');
const maintenanceIpc = fs.readFileSync(path.join(root, 'maintenance', 'ipc.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('runtime recovery is packaged and wired through the main and renderer processes', () => {
    assert.ok(packageJson.build.files.includes('runtime/**/*'));
    assert.match(packageJson.scripts.check, /runtime\/recoveryJournal\.js/);
    assert.match(main, /new RecoveryJournal/);
    assert.match(main, /runtime-recovery-state/);
    assert.match(main, /runtime-session-start/);
    assert.match(main, /runtime-post-exit-update/);
    assert.match(main, /deferQuitForRuntimeWork/);
    assert.match(main, /render-process-gone/);
    assert.match(main, /\.partial\.zip/);
    assert.match(renderer, /initializeRuntimeRecovery/);
    assert.match(renderer, /playtimeSessionIds/);
    assert.match(renderer, /runtimeLaunchGraceUntil/);
    assert.match(renderer, /processRuntimePostExitJob/);
    assert.match(renderer, /runtimeUploadCheckpoint/);
    assert.match(renderer, /runtime-session-acknowledge/);
});

test('maintenance is an opt-in experimental feature', () => {
    assert.match(renderer, /id="maintenanceEnabledToggle"/);
    assert.match(renderer, /id="maintenanceGamePageToggle"/);
    const experimentalPane = renderer.slice(renderer.indexOf('id="tab-experimental"'), renderer.indexOf('id="tab-cloud"'));
    const maintenancePane = renderer.slice(renderer.indexOf('id="tab-maintenance"'), renderer.indexOf('id="tab-alerts"'));
    assert.match(experimentalPane, /id="experimentalMaintenanceToggle"[\s\S]+id="maintenanceEnabledToggle"/);
    assert.doesNotMatch(experimentalPane, /id="maintenanceSettingsBody"|id="maintenanceGamePageToggle"/);
    assert.match(maintenancePane, /id="maintenanceSettingsBody"/);
    assert.match(renderer, /id="settingsTabMaintenance"[\s\S]+switchSettingsTab\('maintenance'\)/);
    assert.match(maintenance, /settingsTab\.style\.display = enabled \? '' : 'none'/);
    assert.match(renderer, /maintenanceEnabled:\s*false/);
    assert.match(renderer, /maintenanceGamePageEnabled:\s*true/);
    assert.match(maintenance, /globalSettings\.maintenanceEnabled === true/);
    assert.match(maintenance, /panel\.style\.display = 'none'/);
    assert.match(maintenanceIpc, /let enabled = false/);
    assert.match(maintenanceIpc, /MAINTENANCE_DISABLED/);
});
