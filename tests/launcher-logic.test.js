'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const logic = require('../ui/launcherLogic');

test('launcher versions normalize and compare stable and prerelease tags', () => {
    assert.equal(logic.normalizeLauncherVersion(' v5.2.1-beta-2 '), '5.2.1-beta-2');
    assert.equal(logic.compareLauncherVersions('5.2.1', '5.2.1-beta-2'), 1);
    assert.equal(logic.compareLauncherVersions('5.2.1-beta-2', '5.2.1-beta-1'), 1);
    assert.equal(logic.compareLauncherVersions('5.2.1', '5.2.1'), 0);
});

test('version target parsing rejects malformed, duplicate, empty, and legacy targets', () => {
    const parsed = logic.parseVersionTargets('v5.2.1, 5.2.1-beta-1, 5.2.1, nope, 5.2.0');
    assert.deepEqual(parsed.versions, ['5.2.1', '5.2.1-beta-1']);
    assert.deepEqual(parsed.duplicates, ['5.2.1']);
    assert.deepEqual(parsed.invalid, ['nope']);
    assert.deepEqual(parsed.unsupported, ['5.2.0']);
    assert.deepEqual(logic.parseVersionTargets('').versions, []);
});

test('multi-version audiences match exact normalized versions only', () => {
    const targets = ['5.2.1', '5.2.1-beta-2'];
    assert.equal(logic.targetsLauncherVersion(targets, 'v5.2.1'), true);
    assert.equal(logic.targetsLauncherVersion(targets, '5.2.1-beta-2'), true);
    assert.equal(logic.targetsLauncherVersion(targets, '5.2.1-beta-1'), false);
    assert.equal(logic.targetsLauncherVersion(targets, '5.2.10'), false);
});

test('newest matching announcement wins across global and targeted sources', () => {
    const global = [{ id: 4, created_at: '2026-07-21T10:00:00Z', message: 'global' }];
    const targeted = [{ id: 'abc', created_at: '2026-07-21T11:00:00Z', message: 'targeted' }];
    assert.equal(logic.selectLatestAnnouncement(global, targeted)._source, 'version');
    global[0].created_at = '2026-07-21T12:00:00Z';
    assert.equal(logic.selectLatestAnnouncement(global, targeted)._source, 'global');
    assert.equal(logic.selectLatestAnnouncement(global, []).message, 'global');
});

test('dismissals are namespaced while legacy numeric global IDs remain recognized', () => {
    assert.equal(logic.announcementKey('version', 'abc'), 'version:abc');
    assert.equal(logic.isAnnouncementDismissed(['global:7'], 'global', 7), true);
    assert.equal(logic.isAnnouncementDismissed(['7'], 'global', 7), true);
    assert.equal(logic.isAnnouncementDismissed(['7'], 'version', 7), false);
});

test('announcement action URLs allow only HTTP and HTTPS', () => {
    assert.equal(logic.safeHttpUrl('javascript:alert(1)'), null);
    assert.equal(logic.safeHttpUrl('file:///C:/secret.txt'), null);
    assert.match(logic.safeHttpUrl('https://sailhub.fyi/news'), /^https:/);
});

test('normal checks report up to date while force mode reinstalls the same release', () => {
    assert.deepEqual(logic.updateDecision('5.2.1', '5.2.1', false), { comparison: 0, action: 'up-to-date' });
    assert.deepEqual(logic.updateDecision('5.2.1', '5.2.1', true), { comparison: 0, action: 'install' });
    assert.deepEqual(logic.updateDecision('5.2.0', '5.2.1', true), { comparison: -1, action: 'downgrade' });
});
