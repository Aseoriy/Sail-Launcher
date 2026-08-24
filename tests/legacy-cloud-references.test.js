'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { LegacyCloudReferenceStore } = require('../security/legacyCloudReferences');

function fixture() {
    const active = { profileId: 'profile-a', libraryId: 'library-a' };
    const games = new Map([
        ['game-a', {
            id: 'game-a',
            name: 'Bad<>:"/\\|?* Name',
            configSyncEntries: [{ id: 'config-main' }]
        }],
        ['game-b', { id: 'game-b', name: 'Other Game', configSyncEntries: [] }]
    ]);
    let now = 1000;
    let sequence = 0;
    const profileStore = {
        activeScope: () => ({ ...active }),
        activeGameMetadata(gameId) {
            const game = games.get(String(gameId));
            if (!game) throw new Error('Game not found.');
            return { ...game };
        }
    };
    const references = new LegacyCloudReferenceStore(() => profileStore, {
        now: () => now,
        ttlMs: 500,
        makeId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
    });
    return { active, games, references, setNow: value => { now = value; } };
}

test('legacy provider scopes are main-derived and portable names cannot create remote paths', () => {
    const f = fixture();
    const save = f.references.scope({ gameId: 'game-a', artifactType: 'game-save', configEntryId: '' });
    assert.equal(save.gameName, 'Bad Name');
    assert.equal(save.subFolder, 'Bad Name/Saves');
    assert.equal(save.profileId, 'profile-a');
    assert.equal(save.libraryId, 'library-a');
    const config = f.references.scope({ gameId: 'game-a', artifactType: 'game-config', configEntryId: 'config-main' });
    assert.equal(config.gameName, 'game-a-config-main');
    assert.equal(config.subFolder, 'GameConfigs');
    assert.throws(
        () => f.references.scope({ gameId: 'game-a', artifactType: 'game-config', configEntryId: 'unapproved' }),
        /does not match/
    );
    assert.throws(
        () => f.references.scope({ gameId: 'launcher-portable', artifactType: 'game-save', configEntryId: '' }),
        /invalid/
    );
});

test('legacy provider references reject guessed, wrong-scope, stale and replayed values', () => {
    const f = fixture();
    const input = { gameId: 'game-a', artifactType: 'game-save', configEntryId: '' };
    const scope = f.references.scope(input);
    const [row] = f.references.issue(scope, 'google', [{
        id: 'provider-file-id',
        name: 'Save\u0000 name',
        date: '2026-08-21 01:02',
        size: 42,
        onclick: 'alert(1)'
    }]);
    assert.equal(row.reference.length, 36);
    assert.equal(row.name, 'Save name');
    assert.equal(JSON.stringify(row).includes('provider-file-id'), false);
    assert.equal(Object.hasOwn(row, 'onclick'), false);
    assert.throws(() => f.references.resolve({ ...input, reference: '00000000-0000-4000-8000-999999999999' }, 'google'), /stale or unavailable/);
    assert.throws(() => f.references.resolve({ ...input, reference: row.reference }, 'dropbox'), /another profile/);
    f.active.profileId = 'profile-b';
    assert.throws(() => f.references.resolve({ ...input, reference: row.reference }, 'google'), /another profile/);
    f.active.profileId = 'profile-a';
    f.active.libraryId = 'library-b';
    assert.throws(() => f.references.resolve({ ...input, reference: row.reference }, 'google'), /another profile/);
    f.active.libraryId = 'library-a';
    assert.throws(() => f.references.resolve({ ...input, gameId: 'game-b', reference: row.reference }, 'google'), /another profile/);
    const resolved = f.references.resolve({ ...input, reference: row.reference }, 'google');
    assert.equal(resolved.fileId, 'provider-file-id');
    assert.throws(() => f.references.resolve({ ...input, reference: row.reference }, 'google'), /stale or unavailable/);

    const [expiring] = f.references.issue(scope, 'google', [{ id: 'expiring-id' }]);
    f.setNow(1500);
    assert.throws(() => f.references.resolve({ ...input, reference: expiring.reference }, 'google'), /stale or unavailable/);
});

test('production legacy cloud upload, list and download handlers use scoped references and transfer capabilities', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const upload = source.slice(source.indexOf("ipcMain.handle('cloud-upload-save'"), source.indexOf("ipcMain.handle('cloud-list-versions'"));
    const list = source.slice(source.indexOf("ipcMain.handle('cloud-list-versions'"), source.indexOf("ipcMain.handle('cloud-create-download-transfer'"));
    const download = source.slice(source.indexOf("ipcMain.handle('cloud-download-save'"), source.indexOf('function createCloudZipWithPowerShell'));
    assert.match(upload, /legacyCloudReferences\.scope\(input\)/);
    assert.match(upload, /resolveTransferCapability/);
    assert.doesNotMatch(upload, /localSavePath|zipPath|fileId/);
    assert.match(list, /legacyCloudReferences\.issue\(scope, provider, versions\)/);
    assert.match(download, /legacyCloudReferences\.resolve\(input, provider\)/);
    assert.match(download, /resolveTransferCapability/);
    assert.doesNotMatch(download, /input\.(?:fileId|destinationPath|localPath|zipPath)/);
});
