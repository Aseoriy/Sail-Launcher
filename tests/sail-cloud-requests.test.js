'use strict';

const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountService } = require('../accounts/accountService');
const { SailCloudClient, sha256 } = require('../accounts/sailCloud');
const { PORTABLE_SCHEMA, canonicalPortableBytes } = require('../sync/portableArtifactV3');

function portableLibraryBytes(gameId, sourceTitle = '') {
    return Buffer.from(JSON.stringify({
        schema: PORTABLE_SCHEMA,
        kind: 'control-plane',
        exportedAt: '2026-08-21T00:00:00.000Z',
        profiles: [{ id: 'profile-1', name: 'Main', conflictMode: 'prompt' }],
        libraries: [{
            id: 'library-1',
            profileId: 'profile-1',
            name: 'Games',
            games: [{
                id: gameId,
                name: `Game ${gameId}`,
                tags: [],
                isFavorite: false,
                addedAt: 0,
                playtime: 0,
                lastPlayed: null,
                playtimeSessionIds: [],
                configSyncEntries: [],
                ...(sourceTitle ? { sourceTitle } : {})
            }],
            sections: []
        }],
        presets: []
    }));
}

function portableLauncherBytes(gameName) {
    return canonicalPortableBytes({
        schema: PORTABLE_SCHEMA,
        kind: 'launcher-snapshot',
        exportedAt: '2026-08-21T00:00:00.000Z',
        profiles: [{ id: 'profile-1', name: 'Main', conflictMode: 'prompt' }],
        libraries: [{
            id: 'library-1', profileId: 'profile-1', name: 'Games', sections: [],
            games: [{
                id: 'game-1', name: gameName, tags: [], isFavorite: false,
                addedAt: 0, playtime: 0, lastPlayed: null,
                playtimeSessionIds: [], configSyncEntries: []
            }]
        }],
        presets: [{ id: 'preset-1', profileId: 'profile-1', name: 'Default', settings: {} }]
    }, { expectedKind: 'launcher-snapshot' }).bytes;
}

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body)
    };
}

function binaryResponse(bytes, status = 200) {
    const buffer = Buffer.from(bytes);
    return {
        ok: status >= 200 && status < 300,
        status,
        arrayBuffer: async () => buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength
        )
    };
}

function queryClient(results) {
    return {
        from(table) {
            const builder = {
                select: () => builder,
                order: () => builder,
                in: () => builder,
                then(resolve, reject) {
                    const value = typeof results[table] === 'function'
                        ? results[table]()
                        : results[table];
                    return Promise.resolve(value).then(resolve, reject);
                }
            };
            return builder;
        }
    };
}

function duplicateIdentityControlPlane() {
    const localProfileId = '11111111-1111-4111-8111-111111111111';
    const remoteProfileId = '22222222-2222-4222-8222-222222222222';
    const localLibraryId = '33333333-3333-4333-8333-333333333333';
    const remoteLibraryId = '44444444-4444-4444-8444-444444444444';
    const localPresetId = '55555555-5555-4555-8555-555555555555';
    const remotePresetId = '66666666-6666-4666-8666-666666666666';
    const game = (id, name) => ({
        id, name, tags: [], isFavorite: false, addedAt: 0, playtime: 0,
        lastPlayed: null, playtimeSessionIds: [], configSyncEntries: []
    });
    return {
        ids: {
            localProfileId, remoteProfileId, localLibraryId, remoteLibraryId,
            localPresetId, remotePresetId
        },
        remote: {
            launcher_profiles: [{ id: remoteProfileId, name: 'Main' }],
            launcher_libraries: [{ id: remoteLibraryId, profile_id: remoteProfileId, name: 'Games' }],
            launcher_presets: [{ id: remotePresetId, profile_id: remoteProfileId, name: 'Default' }]
        },
        artifact: {
            schema: PORTABLE_SCHEMA,
            kind: 'control-plane',
            exportedAt: '2026-08-23T00:00:00.000Z',
            profiles: [{
                id: localProfileId, name: 'Main', conflictMode: 'prompt',
                updatedAt: '2026-08-23T00:00:00.000Z'
            }, {
                id: remoteProfileId, name: 'Main', conflictMode: 'prompt',
                updatedAt: '2026-08-22T00:00:00.000Z'
            }],
            libraries: [{
                id: localLibraryId, profileId: localProfileId, name: 'Games',
                updatedAt: '2026-08-23T00:00:00.000Z',
                games: [game('legacy-game-1700000000', 'Local Game')], sections: []
            }, {
                id: remoteLibraryId, profileId: remoteProfileId, name: 'Games',
                updatedAt: '2026-08-22T00:00:00.000Z',
                games: [game('cloud-game', 'Cloud Game')], sections: []
            }],
            presets: [{
                id: localPresetId, profileId: localProfileId, name: 'Default',
                updatedAt: '2026-08-23T00:00:00.000Z', settings: { theme: 'theme-midnight' }
            }, {
                id: remotePresetId, profileId: remoteProfileId, name: 'Default',
                updatedAt: '2026-08-22T00:00:00.000Z', settings: { theme: 'theme-ocean' }
            }]
        }
    };
}

function identityClient(remote) {
    const operations = [];
    return {
        operations,
        from(table) {
            return {
                select(columns) {
                    operations.push({ type: 'select', table, columns });
                    return Promise.resolve({ data: remote[table] || [], error: null });
                },
                upsert(rows, options) {
                    operations.push({ type: 'upsert', table, rows, options });
                    return Promise.resolve({ data: rows, error: null });
                }
            };
        }
    };
}

test('control-plane sync reuses same-name cloud identities without duplicate profile rows', async () => {
    const fixture = duplicateIdentityControlPlane();
    const client = identityClient(fixture.remote);
    const service = Object.create(AccountService.prototype);
    service.state = async () => ({ signedIn: true, user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    service.client = client;
    service.findArtifact = async () => null;
    const uploads = [];
    service.uploadJsonArtifactIfChanged = async (_accountId, payload, value) => {
        uploads.push({ payload, value });
        return { artifact_id: `artifact-${uploads.length}`, revision: 1 };
    };
    service.listRemoteControlPlane = async () => ({ reconciled: true });

    assert.deepEqual(await service.upsertControlPlane(fixture.artifact), { reconciled: true });
    const upserts = Object.fromEntries(client.operations
        .filter(operation => operation.type === 'upsert')
        .map(operation => [operation.table, operation.rows]));
    assert.equal(upserts.launcher_profiles.length, 1);
    assert.equal(upserts.launcher_profiles[0].id, fixture.ids.remoteProfileId);
    assert.equal(upserts.launcher_libraries.length, 1);
    assert.equal(upserts.launcher_libraries[0].id, fixture.ids.remoteLibraryId);
    assert.equal(upserts.launcher_libraries[0].profile_id, fixture.ids.remoteProfileId);
    assert.equal(upserts.launcher_presets.length, 1);
    assert.equal(upserts.launcher_presets[0].id, fixture.ids.remotePresetId);
    assert.equal(upserts.launcher_presets[0].profile_id, fixture.ids.remoteProfileId);
    assert.equal(service.resolveCloudIdentity('profiles', fixture.ids.localProfileId), fixture.ids.remoteProfileId);
    assert.equal(service.resolveCloudIdentity('libraries', fixture.ids.localLibraryId), fixture.ids.remoteLibraryId);
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].value.profiles[0].id, fixture.ids.remoteProfileId);
    assert.equal(uploads[0].value.libraries[0].id, fixture.ids.remoteLibraryId);
    assert.equal(uploads[0].value.libraries[0].games[0].id, 'legacy-game-1700000000');
});

test('account control-plane boundaries discard historical achievement cache paths in later libraries', async () => {
    const fixture = duplicateIdentityControlPlane();
    fixture.artifact.libraries[1] = {
        ...fixture.artifact.libraries[1],
        id: '88888888-8888-4888-8888-888888888888',
        profileId: fixture.ids.localProfileId,
        name: 'Extras',
        games: [{
            ...fixture.artifact.libraries[1].games[0],
            achievementData: {
                schemaVersion: 1,
                appId: '480',
                updatedAt: 1710000000000,
                lastSteamRefreshAt: null,
                lastLocalScanAt: 1710000000000,
                items: [{
                    id: 'ACH_LOCAL_ART', displayName: 'Local artwork', description: '', hidden: false,
                    icon: null, iconGray: null, iconPath: 'C:\\SailCache\\unlocked.png',
                    iconGrayPath: 'C:\\SailCache\\locked.png', unlocked: true,
                    unlockTime: 1710000000000, source: 'local'
                }]
            }
        }]
    };
    const client = identityClient(fixture.remote);
    const service = Object.create(AccountService.prototype);
    service.state = async () => ({ signedIn: true, user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    service.client = client;
    service.findArtifact = async () => null;
    const uploads = [];
    service.uploadJsonArtifactIfChanged = async (_accountId, payload, value) => {
        uploads.push({ payload, value });
        return { artifact_id: `artifact-${uploads.length}`, revision: 1 };
    };
    service.listRemoteControlPlane = async () => ({ reconciled: true });

    await service.upsertControlPlane(fixture.artifact);

    const extras = uploads.find(upload => upload.value.libraries[0] && upload.value.libraries[0].name === 'Extras');
    assert.ok(extras);
    assert.equal(extras.value.libraries[0].games[0].achievementData.items[0].iconPath, undefined);
    assert.equal(extras.value.libraries[0].games[0].achievementData.items[0].iconGrayPath, undefined);
    assert.equal(JSON.stringify(uploads).includes('SailCache'), false);
});

test('cloud uploads prepare profile aliases and translate legacy game identifiers to UUID metadata', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-cloud-legacy-id-'));
    t.after(() => fs.removeSync(root));
    const filePath = path.join(root, 'config.zip');
    fs.writeFileSync(filePath, 'legacy config bytes');
    const fixture = duplicateIdentityControlPlane();
    const client = identityClient(fixture.remote);
    const service = Object.create(AccountService.prototype);
    service.state = async () => ({ signedIn: true, user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    service.client = client;
    const finds = [];
    service.findArtifact = async (profileId, logicalKey) => {
        finds.push({ profileId, logicalKey });
        return null;
    };
    const uploads = [];
    service.sailCloud = {
        uploadBytes: async payload => {
            uploads.push(payload);
            return { artifact_id: '77777777-7777-4777-8777-777777777777', revision: 1 };
        }
    };

    await service.uploadCloudFile({
        profileId: fixture.ids.localProfileId,
        libraryId: fixture.ids.localLibraryId,
        gameId: 'legacy-game-1700000000',
        configEntryId: 'config-main',
        artifactType: 'game-config',
        logicalKey: 'game-config:legacy-game-1700000000:config-main',
        expectedRevision: 0,
        maxVersions: 3,
        contentType: 'application/zip',
        filePath,
        controlPlane: fixture.artifact
    });

    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.equal(finds[0].profileId, fixture.ids.remoteProfileId);
    assert.equal(uploads[0].profileId, fixture.ids.remoteProfileId);
    assert.equal(uploads[0].libraryId, fixture.ids.remoteLibraryId);
    assert.match(uploads[0].gameId, uuid);
    assert.match(uploads[0].configEntryId, uuid);
    assert.equal(uploads[0].logicalKey, 'game-config:legacy-game-1700000000:config-main');
    assert.equal(
        service.resolveCloudIdentity('games', 'legacy-game-1700000000'),
        uploads[0].gameId
    );
});

test('cloud uploads rebuild stale profile identities and retry one failed reservation', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-cloud-stale-profile-'));
    t.after(() => fs.removeSync(root));
    const filePath = path.join(root, 'config.zip');
    fs.writeFileSync(filePath, 'config bytes');
    const fixture = duplicateIdentityControlPlane();
    const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const client = identityClient(fixture.remote);
    const service = Object.create(AccountService.prototype);
    service.state = async () => ({ signedIn: true, user: { id: accountId } });
    service.client = client;
    service.remoteIdentityAliases = {
        accountId,
        profiles: new Map([
            [fixture.ids.localProfileId, fixture.ids.remoteProfileId],
            [fixture.ids.remoteProfileId, fixture.ids.remoteProfileId]
        ]),
        libraries: new Map([
            [fixture.ids.localLibraryId, fixture.ids.remoteLibraryId],
            [fixture.ids.remoteLibraryId, fixture.ids.remoteLibraryId]
        ]),
        presets: new Map()
    };
    service.findArtifact = async () => null;
    const uploads = [];
    service.sailCloud = {
        uploadBytes: async payload => {
            uploads.push(payload);
            if (uploads.length === 1) {
                const error = new Error('profile not found');
                error.status = 404;
                throw error;
            }
            return { artifact_id: '77777777-7777-4777-8777-777777777777', revision: 1 };
        }
    };

    const result = await service.uploadCloudFile({
        profileId: fixture.ids.localProfileId,
        libraryId: fixture.ids.localLibraryId,
        gameId: 'legacy-game-1700000000',
        configEntryId: 'config-main',
        artifactType: 'game-config',
        logicalKey: 'game-config:legacy-game-1700000000:config-main',
        filePath,
        controlPlane: fixture.artifact
    });

    assert.equal(result.revision, 1);
    assert.equal(uploads.length, 2);
    assert.equal(client.operations.filter(operation => operation.type === 'select').length, 3);
    assert.equal(client.operations.filter(operation => operation.type === 'upsert').length, 3);
    assert.equal(uploads[1].profileId, fixture.ids.remoteProfileId);
    assert.equal(uploads[1].libraryId, fixture.ids.remoteLibraryId);
});

test('concurrent Sail Cloud reads share one account-scoped Worker request', async t => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    let token = 'account-a-token';
    const calls = [];
    global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), authorization: options.headers && options.headers.Authorization });
        return jsonResponse({ used_bytes: 12 });
    };
    const client = new SailCloudClient({ getAccessToken: async () => token });

    const [first, second] = await Promise.all([client.status(), client.status()]);
    assert.deepEqual(first, { used_bytes: 12 });
    assert.deepEqual(second, first);
    assert.equal(calls.length, 1);

    token = 'account-b-token';
    await client.status();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].authorization, 'Bearer account-a-token');
    assert.equal(calls[1].authorization, 'Bearer account-b-token');
});

test('failed Sail Cloud reads are released so a later retry reaches the Worker', async t => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    let attempts = 0;
    global.fetch = async () => {
        attempts += 1;
        return attempts === 1
            ? jsonResponse({ error: 'Temporary outage' }, 503)
            : jsonResponse([{ revision: 2 }]);
    };
    const client = new SailCloudClient({ getAccessToken: async () => 'retry-token' });

    const failed = await Promise.allSettled([
        client.versions('artifact-1'),
        client.versions('artifact-1')
    ]);
    assert.equal(attempts, 1);
    assert.equal(failed.every(result => result.status === 'rejected'), true);
    assert.deepEqual(await client.versions('artifact-1'), [{ revision: 2 }]);
    assert.equal(attempts, 2);
});

test('one artifact download can safely serve concurrent destination files', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-cloud-downloads-'));
    t.after(() => fs.removeSync(root));
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    const bytes = Buffer.from('shared artifact bytes');
    let reservations = 0;
    let objectDownloads = 0;
    global.fetch = async url => {
        if (String(url).startsWith('https://r2.test/')) {
            objectDownloads += 1;
            return binaryResponse(bytes);
        }
        reservations += 1;
        return jsonResponse({
            artifact_id: 'artifact-1',
            revision: 7,
            sha256: sha256(bytes),
            download_url: 'https://r2.test/artifact-1'
        });
    };
    const client = new SailCloudClient({ getAccessToken: async () => 'download-token' });
    const firstPath = path.join(root, 'first.bin');
    const secondPath = path.join(root, 'second.bin');

    await Promise.all([
        client.downloadArtifactToFile('artifact-1', firstPath, 7),
        client.downloadArtifactToFile('artifact-1', secondPath, 7)
    ]);
    assert.equal(reservations, 1);
    assert.equal(objectDownloads, 1);
    assert.equal(fs.readFileSync(firstPath, 'utf8'), bytes.toString('utf8'));
    assert.equal(fs.readFileSync(secondPath, 'utf8'), bytes.toString('utf8'));
});

test('warm and cold control-plane refreshes reuse hydrated revisions and fetch changed revisions once', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-cloud-artifact-cache-'));
    t.after(() => fs.removeSync(root));
    let revision = 1;
    let downloads = 0;
    let statusCalls = 0;
    const artifactBytes = () => portableLibraryBytes(`game-${revision}`);
    const service = Object.create(AccountService.prototype);
    service.artifactCachePath = root;
    service.state = async () => ({ signedIn: true, user: { id: 'account-a' } });
    service.client = queryClient({
        launcher_profiles: { data: [{ id: 'profile-1', name: 'Main' }], error: null },
        launcher_libraries: { data: [{ id: 'library-1', profile_id: 'profile-1', name: 'Games' }], error: null },
        launcher_presets: { data: [], error: null },
        sync_policies: { data: [], error: null },
        cloud_connections: { data: [], error: null },
        sync_artifacts: () => ({
            data: [{
                id: 'artifact-1',
                profile_id: 'profile-1',
                artifact_type: 'library',
                logical_key: 'library:library-1',
                revision,
                content_hash: sha256(artifactBytes())
            }],
            error: null
        })
    });
    service.sailCloud = {
        downloadArtifact: async (_artifactId, requestedRevision) => {
            downloads += 1;
            await new Promise(resolve => setImmediate(resolve));
            return { bytes: portableLibraryBytes(`game-${requestedRevision}`) };
        },
        status: async () => {
            statusCalls += 1;
            return { used_bytes: revision };
        }
    };

    const concurrent = await Promise.all([
        service.listRemoteControlPlane(),
        service.listRemoteControlPlane()
    ]);
    assert.equal(downloads, 1);
    assert.equal(statusCalls, 1);
    assert.equal(concurrent[0].libraries[0].catalog.games[0].id, 'game-1');

    const repeated = await service.listRemoteControlPlane();
    assert.equal(downloads, 1);
    assert.equal(statusCalls, 2);
    assert.equal(repeated.libraries[0].catalog.games[0].id, 'game-1');

    const metadataOnly = await service.listRemoteControlPlane({ includeStorage: false });
    assert.equal(statusCalls, 2);
    assert.equal(metadataOnly.storage, null);

    const coldService = Object.create(AccountService.prototype);
    coldService.artifactCachePath = root;
    coldService.state = service.state;
    coldService.client = service.client;
    coldService.sailCloud = service.sailCloud;
    const cold = await coldService.listRemoteControlPlane();
    assert.equal(downloads, 1);
    assert.equal(statusCalls, 3);
    assert.equal(cold.libraries[0].catalog.games[0].id, 'game-1');

    revision = 2;
    const changed = await coldService.listRemoteControlPlane();
    assert.equal(downloads, 2);
    assert.equal(statusCalls, 4);
    assert.equal(changed.libraries[0].catalog.games[0].id, 'game-2');
});

test('artifact hydration cache is isolated by Sail account', async () => {
    let accountId = 'account-a';
    let downloads = 0;
    const service = Object.create(AccountService.prototype);
    service.state = async () => ({ signedIn: true, user: { id: accountId } });
    service.client = queryClient({
        launcher_profiles: { data: [{ id: 'profile-1' }], error: null },
        launcher_libraries: { data: [{ id: 'library-1', profile_id: 'profile-1' }], error: null },
        launcher_presets: { data: [], error: null },
        sync_policies: { data: [], error: null },
        cloud_connections: { data: [], error: null },
        sync_artifacts: {
            data: [{
                id: 'shared-artifact-id',
                profile_id: 'profile-1',
                artifact_type: 'library',
                logical_key: 'library:library-1',
                revision: 1
            }],
            error: null
        }
    });
    service.sailCloud = {
        downloadArtifact: async () => {
            downloads += 1;
            return { bytes: portableLibraryBytes('shared-game', accountId) };
        },
        status: async () => ({})
    };

    const first = await service.listRemoteControlPlane();
    accountId = 'account-b';
    const second = await service.listRemoteControlPlane();
    assert.equal(downloads, 2);
    assert.equal(first.libraries[0].catalog.games[0].sourceTitle, 'account-a');
    assert.equal(second.libraries[0].catalog.games[0].sourceTitle, 'account-b');
});

test('unchanged uploads are skipped while changed content still uploads', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-cloud-upload-'));
    t.after(() => fs.removeSync(root));
    const filePath = path.join(root, 'portable.json');
    const original = portableLauncherBytes('Version 1');
    fs.writeFileSync(filePath, original);
    let uploads = 0;
    const service = Object.create(AccountService.prototype);
    service.state = async () => ({ signedIn: true, user: { id: 'account-a' } });
    service.findArtifact = async () => ({
        id: 'artifact-1',
        revision: 4,
        content_hash: sha256(original)
    });
    service.sailCloud = {
        uploadBytes: async () => {
            uploads += 1;
            return { artifact_id: 'artifact-1', revision: 5 };
        }
    };

    const unchanged = await service.uploadCloudFile({
        profileId: 'profile-1',
        logicalKey: 'launcher-config:portable',
        artifactType: 'launcher-config',
        filePath
    });
    assert.equal(unchanged.unchanged, true);
    assert.equal(uploads, 0);

    fs.writeFileSync(filePath, portableLauncherBytes('Version 2'));
    const changed = await service.uploadCloudFile({
        profileId: 'profile-1',
        logicalKey: 'launcher-config:portable',
        artifactType: 'launcher-config',
        filePath
    });
    assert.equal(changed.revision, 5);
    assert.equal(uploads, 1);
});

test('Sail Cloud row projection bounds remote fields before privileged rendering', async () => {
    const service = Object.create(AccountService.prototype);
    service.sailCloud = {
        files: async () => [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            profile_id: 'profile-1',
            artifact_type: 'game-save',
            logical_key: 'game-save:game-1',
            revision: 3,
            updated_at: '2026-08-21T01:02:03.000Z',
            size_bytes: 1024,
            version_count: 2,
            latest_created_at: '2026-08-21T01:02:03.000Z',
            onclick: 'alert(1)',
            display_name: '<img src=x onerror=alert(1)>'
        }, {
            id: '<svg onload=alert(1)>',
            profile_id: 'profile-1',
            artifact_type: 'game-save',
            logical_key: 'game-save:game-1',
            revision: 1,
            size_bytes: 1,
            version_count: 1
        }]
    };
    const rows = await service.listCloudFiles();
    assert.deepEqual(rows, [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        profile_id: 'profile-1',
        artifact_type: 'game-save',
        logical_key: 'game-save:game-1',
        revision: 3,
        updated_at: '2026-08-21T01:02:03.000Z',
        size_bytes: 1024,
        version_count: 2,
        latest_created_at: '2026-08-21T01:02:03.000Z'
    }]);
});

test('Sail Cloud download and version lookup reject artifact type confusion before provider reads', async () => {
    const service = Object.create(AccountService.prototype);
    let versionReads = 0;
    let downloadReads = 0;
    const artifact = {
        id: 'artifact-config',
        profile_id: 'profile-1',
        library_id: 'library-1',
        game_id: 'game-1',
        artifact_type: 'game-config',
        logical_key: 'game-save:game-1'
    };
    service.findArtifact = async () => artifact;
    service.findArtifactById = async () => artifact;
    service.sailCloud = {
        versions: async () => { versionReads += 1; return []; },
        downloadArtifactToFile: async () => { downloadReads += 1; return {}; }
    };
    await assert.rejects(
        service.listCloudVersions({
            profileId: 'profile-1', libraryId: 'library-1', gameId: 'game-1',
            logicalKey: 'game-save:game-1', expectedArtifactType: 'game-save'
        }),
        /wrong artifact type/i
    );
    await assert.rejects(
        service.downloadCloudFile({
            profileId: 'profile-1', libraryId: 'library-1', gameId: 'game-1',
            artifactId: 'artifact-config', logicalKey: 'game-save:game-1',
            expectedArtifactType: 'game-save', destinationPath: 'unused.zip'
        }),
        /wrong artifact type/i
    );
    assert.equal(versionReads, 0);
    assert.equal(downloadReads, 0);
});

test('Sail account component serializer rejects authority before any cloud upload', async () => {
    const service = Object.create(AccountService.prototype);
    let uploads = 0;
    service.sailCloud = {
        uploadBytes: async () => { uploads += 1; return { artifact_id: 'artifact', revision: 1 }; }
    };
    service.cacheArtifactBytes = () => {};
    const artifact = JSON.parse(portableLibraryBytes('game-one'));
    artifact.libraries[0].games[0].exePath = 'C:\\Remote\\evil.exe';
    await assert.rejects(
        service.uploadJsonArtifactIfChanged('account-a', {
            profileId: 'profile-1', artifactType: 'library', logicalKey: 'library:library-1'
        }, artifact, null),
        error => error && error.code === 'SAIL_PORTABLE_UNKNOWN_PROPERTY'
    );
    assert.equal(uploads, 0);
});

test('startup restore imports through the V3 transfer boundary before applying renderer state', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const restoreStart = source.indexOf('async function syncConfigFromCloudIfNeeded()');
    const restoreEnd = source.indexOf('function syncConfigToCloudPromise()', restoreStart);
    const restoreSource = source.slice(restoreStart, restoreEnd);
    assert.match(restoreSource, /profiles-import-portable-transfer/);
    assert.match(restoreSource, /applyLauncherSnapshot\(imported\)/);
    assert.match(restoreSource, /saveToMemory\(\)/);
    assert.ok(
        restoreSource.indexOf('profiles-import-portable-transfer')
            < restoreSource.indexOf('applyLauncherSnapshot(imported)')
    );
    assert.doesNotMatch(restoreSource, /fs\.writeJsonSync\(dataPath/);
    assert.match(source, /if \(sailCloudGameSaveBackfillQueued \|\| sailCloudGameSaveBackfillInFlight\) return/);
});
