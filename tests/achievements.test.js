'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    diffNewUnlocks,
    mergeAchievementData,
    normalizeAchievementData,
    summarizeAchievementData
} = require('../achievements/achievementLogic');
const {
    parseAchievementIni,
    parseAchievementBinary,
    parseAchievementJson,
    parseAchievementText,
    readAchievementFile
} = require('../achievements/achievementParsers');
const {
    automaticCandidatePaths,
    collectMappedFiles,
    resolveGameAppId,
    resolveInstalledSteamApp
} = require('../achievements/achievementDiscovery');
const {
    fetchCommunitySchema,
    fetchGameAchievementData,
    importSteamAchievements,
    importSteamSchema,
    normalizeSteamData,
    parseCommunityAchievementHtml,
    parseCommunityAchievementXml
} = require('../achievements/steamAchievements');
const { humanizeAchievementId } = require('../achievements/achievementView');
const { portableArtifactToSnapshot, portableSnapshot } = require('../sync/syncV2');
const { mergePortableGames } = require('../accounts/profileStore');
const { AchievementService } = require('../achievements/achievementService');

function approvedRoot(target, kind = 'directory') {
    const realPath = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
    const stat = fs.statSync(realPath);
    return {
        path: realPath,
        kind,
        dev: String(stat.dev),
        ino: String(stat.ino),
        birthtimeMs: Math.round(stat.birthtimeMs || 0)
    };
}

test('achievement merge unions unlocks case-insensitively and never regresses progress', () => {
    const local = {
        appId: '123',
        updatedAt: 100,
        items: [{ id: 'ACH_WIN', displayName: 'Winner', unlocked: true, unlockTime: 1710000000000, source: 'local' }]
    };
    const remote = {
        appId: '123',
        updatedAt: 200,
        items: [
            { id: 'ach_win', displayName: 'Steam Winner', description: 'Win once.', unlocked: false, source: 'steam' },
            { id: 'ACH_TWO', displayName: 'Second', unlocked: true, source: 'steam' }
        ]
    };
    const merged = mergeAchievementData(local, remote);
    assert.equal(merged.items.length, 2);
    assert.equal(merged.items[0].unlocked, true);
    assert.equal(merged.items[0].displayName, 'Steam Winner');
    assert.equal(merged.items[0].unlockTime, 1710000000000);
    assert.deepEqual(summarizeAchievementData(merged), {
        total: 2,
        unlocked: 2,
        locked: 0,
        percent: 100,
        latestUnlock: merged.items[0]
    });
});

test('new unlock detection ignores items that were already unlocked', () => {
    const previous = { items: [{ id: 'ONE', unlocked: true }, { id: 'TWO', unlocked: false }] };
    const next = { items: [{ id: 'one', unlocked: true }, { id: 'two', unlocked: true }, { id: 'THREE', unlocked: false }] };
    assert.deepEqual(diffNewUnlocks(previous, next).map(item => item.id), ['two']);
});

test('core INI and JSON achievement formats normalize locked and unlocked records', () => {
    const ini = parseAchievementIni(`
        [ACH_FIRST]
        Achieved=1
        UnlockTime=1710000000

        [ACH_SECOND]
        Unlocked=false
    `);
    assert.equal(ini.length, 2);
    assert.equal(ini[0].unlocked, true);
    assert.equal(ini[0].unlockTime, 1710000000000);
    assert.equal(ini[1].unlocked, false);
    assert.equal(parseAchievementIni('[Achievements]\nACH_BOOLEAN=1')[0].unlockTime, null);

    const json = parseAchievementJson(JSON.stringify({
        achievements: {
            ACH_JSON: { earned: true, earned_time: 1710000100 },
            ACH_LOCKED: { achieved: 0 }
        }
    }));
    assert.equal(json.length, 2);
    assert.equal(json.find(item => item.id === 'ACH_JSON').unlocked, true);
    assert.equal(json.find(item => item.id === 'ACH_LOCKED').unlocked, false);
    const flatJson = parseAchievementJson(JSON.stringify({ ACH_FLAT: true, ACH_FLAT_LOCKED: 0, appid: 123 }));
    assert.deepEqual(flatJson.map(item => [item.id, item.unlocked]), [['ACH_FLAT', true], ['ACH_FLAT_LOCKED', false]]);

    const iconHash = '0123456789abcdef0123456789abcdef01234567';
    const steamCache = parseAchievementText(JSON.stringify([
        ['achievements', { data: {
            nAchieved: 1,
            nTotal: 40,
            vecHighlight: [{
                strID: 'ACH_CACHE',
                strName: 'Cached achievement',
                strDescription: 'Read from Steam cache.',
                strImage: iconHash,
                bAchieved: true,
                rtUnlocked: 1710000200
            }]
        } }]
    ]), 'C:\\Steam\\userdata\\123\\config\\librarycache\\777.json').items;
    assert.equal(steamCache.length, 1);
    assert.equal(steamCache[0].id, 'ACH_CACHE');
    assert.equal(steamCache[0].displayName, 'Cached achievement');
    assert.equal(steamCache[0].description, 'Read from Steam cache.');
    assert.equal(steamCache[0].icon, `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/777/${iconHash}.jpg`);
    assert.equal(steamCache[0].unlockTime, 1710000200000);

    const cleaned = normalizeAchievementData({ items: [
        { id: 'nAchieved', unlocked: false, source: 'steam-cache' },
        { id: 'nTotal', unlocked: false, source: 'steam-cache' },
        steamCache[0]
    ] });
    assert.deepEqual(cleaned.items.map(item => item.id), ['ACH_CACHE']);
});

test('Hydra-style emulator variants parse without writing back to their source files', () => {
    const encodedTime = Buffer.alloc(4);
    encodedTime.writeUInt32LE(1710000000);
    const ini = parseAchievementIni(`
        [Achievements]
        ACH_SKIDROW=1@ignored@1710000000
        "ACH_USERSTATS"={ unlocked = true, time = 1710000100 }

        [ACH_RLD]
        State=01000000
        Time=${encodedTime.toString('hex')}

        [State]
        ACH_3DM=0101

        [Time]
        ACH_3DM=${encodedTime.toString('hex')}
    `);
    const byId = new Map(ini.map(item => [item.id, item]));
    assert.equal(byId.get('ACH_SKIDROW').unlockTime, 1710000000000);
    assert.equal(byId.get('ACH_USERSTATS').unlockTime, 1710000100000);
    assert.equal(byId.get('ACH_RLD').unlockTime, 1710000000000);
    assert.equal(byId.get('ACH_3DM').unlocked, true);

    const razor = parseAchievementText('ACH_RAZOR 1 1710000300\nACH_LOCKED 0 0', 'C:\\Users\\Pookie\\AppData\\Roaming\\.1911\\777\\achievement');
    assert.equal(razor.parser, 'razor1911');
    assert.deepEqual(razor.items.map(item => [item.id, item.unlocked]), [['ACH_RAZOR', true], ['ACH_LOCKED', false]]);
});

test('achievement file reader rejects oversized files before reading their contents', () => {
    let read = false;
    const fakeFs = {
        statSync: () => ({ isFile: () => true, size: 200 }),
        readFileSync: () => { read = true; return Buffer.from('{}'); }
    };
    assert.throws(() => readAchievementFile('achievements.json', { fs: fakeFs, maxBytes: 100 }), /too large/i);
    assert.equal(read, false);
});

test('discovery includes core emulator locations and bounds mapped-folder traversal', () => {
    const fakeRealpath = value => value;
    fakeRealpath.native = fakeRealpath;
    const directoryStat = {
        dev: 1, ino: 1, birthtimeMs: 1,
        isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false
    };
    const candidates = automaticCandidatePaths({ steamAppId: '777', exePath: 'C:\\Games\\Demo\\demo.exe' }, {
        env: { APPDATA: 'C:\\Users\\Pookie\\AppData\\Roaming', PROGRAMDATA: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public' },
        steamRoot: 'C:\\Steam',
        documentsPath: 'C:\\Users\\Pookie\\Documents',
        allowKnownLocations: true,
        allowSteamData: true,
        approvedRoots: [{ path: 'C:\\Steam', kind: 'directory' }],
        fs: {
            lstatSync: () => directoryStat,
            statSync: () => directoryStat,
            realpathSync: fakeRealpath,
            readdirSync: () => ['12345', 'not-an-account']
        }
    });
    assert.ok(candidates.some(candidate => /Goldberg SteamEmu Saves[\\/]777[\\/]achievements\.json$/i.test(candidate)));
    assert.ok(candidates.some(candidate => /Steam[\\/]CODEX[\\/]777[\\/]achievements\.ini$/i.test(candidate)));
    assert.ok(candidates.some(candidate => /userdata[\\/]12345[\\/]config[\\/]librarycache[\\/]777\.json$/i.test(candidate)));
    assert.ok(candidates.some(candidate => /Games[\\/]Demo[\\/]steam_settings[\\/]achievements\.json$/i.test(candidate)));
    assert.ok(candidates.some(candidate => /EMPRESS[\\/]remote[\\/]777[\\/]achievements\.json$/i.test(candidate)));
    assert.ok(candidates.some(candidate => /SKIDROW[\\/]777[\\/]SteamEmu[\\/]UserStats[\\/]achiev\.ini$/i.test(candidate)));
    assert.ok(candidates.some(candidate => /3DMGAME[\\/]Player[\\/]stats[\\/]achievements\.ini$/i.test(candidate)));
    assert.ok(candidates.some(candidate => /\.1911[\\/]777[\\/]achievement$/i.test(candidate)));
    assert.equal(resolveGameAppId({
        achievementSources: [{ path: 'C:\\Users\\Pookie\\AppData\\Roaming\\Goldberg SteamEmu Saves\\480\\achievements.json' }]
    }), '480');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-achievements-'));
    try {
        fs.mkdirSync(path.join(root, 'nested'));
        fs.writeFileSync(path.join(root, 'achievements.json'), '{}');
        fs.writeFileSync(path.join(root, 'nested', 'achievements.ini'), '');
        fs.writeFileSync(path.join(root, 'achievement'), 'ACH 1 1710000000');
        fs.writeFileSync(path.join(root, 'ignore.txt'), '');
        const mapped = collectMappedFiles({ path: root, kind: 'folder', enabled: true }, {
            approvedRoots: [approvedRoot(root)]
        });
        assert.equal(mapped.length, 3);
        assert.ok(mapped.every(candidate => /\.(json|ini)$/i.test(candidate) || path.basename(candidate) === 'achievement'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('local app IDs, schemas, and artwork are discovered without Steam account details', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-local-schema-'));
    try {
        const settingsRoot = path.join(root, 'steam_settings');
        const imageRoot = path.join(settingsRoot, 'achievement_images');
        fs.mkdirSync(imageRoot, { recursive: true });
        fs.writeFileSync(path.join(root, 'steam_appid.txt'), '777\n');
        fs.writeFileSync(path.join(imageRoot, 'winner.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        const schemaPath = path.join(settingsRoot, 'achievements.json');
        fs.writeFileSync(schemaPath, JSON.stringify([{
            name: 'ACH_LOCAL',
            displayName: 'Local winner',
            description: 'Win using only files on this PC.',
            icon: 'achievement_images/winner.jpg'
        }]));

        const game = { id: 'local', exePath: path.join(root, 'game.exe') };
        const approvedRoots = [approvedRoot(root)];
        assert.equal(resolveGameAppId(game, { approvedRoots }), '777');
        assert.ok(automaticCandidatePaths(game, { steamRoot: '', approvedRoots }).includes(schemaPath));
        const parsed = readAchievementFile(schemaPath, { approvedRoots });
        assert.equal(parsed.items[0].displayName, 'Local winner');
        assert.equal(parsed.items[0].description, 'Win using only files on this PC.');
        assert.equal(parsed.items[0].iconPath, path.join(imageRoot, 'winner.jpg'));

        const merged = mergeAchievementData(
            { items: [{ id: 'ACH_LOCAL', displayName: 'ACH_LOCAL', unlocked: true, source: 'goldberg' }] },
            { items: parsed.items }
        );
        assert.equal(merged.items[0].displayName, 'Local winner');
        assert.equal(merged.items[0].unlocked, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('derived achievement artwork stays inside approved roots and rejects forward-slash UNC before filesystem access', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-achievement-artwork-'));
    try {
        const sourcePath = path.join(root, 'achievements.json');
        const outsidePath = path.join(path.dirname(root), `${path.basename(root)}-outside.png`);
        fs.writeFileSync(outsidePath, 'outside');
        fs.writeFileSync(sourcePath, JSON.stringify([
            { name: 'UNC_ICON', icon: '//attacker.invalid/share/icon.png' },
            { name: 'TRAVERSAL_ICON', icon: `../${path.basename(outsidePath)}` }
        ]));
        let uncTouched = false;
        const guardedFs = Object.create(fs);
        guardedFs.lstatSync = candidate => {
            if (/^[\\/]{2}/.test(String(candidate))) uncTouched = true;
            return fs.lstatSync(candidate);
        };
        const parsed = readAchievementFile(sourcePath, {
            fs: guardedFs,
            approvedRoots: [approvedRoot(root)]
        });
        assert.equal(uncTouched, false);
        assert.equal(parsed.items.every(item => item.iconPath === null), true);
        fs.rmSync(outsidePath, { force: true });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Steam achievement scans bind the approved AppID, freshly resolved root, and filesystem identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-steam-root-identity-'));
    const steamA = path.join(root, 'steam-a');
    const steamB = path.join(root, 'steam-b');
    const install = (steamRoot, appId, achievementId) => {
        fs.mkdirSync(path.join(steamRoot, 'steamapps'), { recursive: true });
        fs.writeFileSync(path.join(steamRoot, 'steamapps', `appmanifest_${appId}.acf`), '"AppState" {}');
        const cache = path.join(steamRoot, 'userdata', '1', 'config', 'librarycache');
        fs.mkdirSync(cache, { recursive: true });
        fs.writeFileSync(path.join(cache, `${appId}.json`), JSON.stringify({
            achievements: { [achievementId]: { achieved: true } }
        }));
    };
    install(steamA, '123', 'FROM_STALE_ROOT');
    install(steamB, '123', 'FROM_CURRENT_ROOT');
    install(steamB, '999', 'FROM_REMOTE_METADATA');
    const identityA = resolveInstalledSteamApp('123', { steamRoot: steamA });
    let activeInstallation = resolveInstalledSteamApp('123', { steamRoot: steamB });
    const service = new AchievementService({
        app: { getAppPath: () => root },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        steamRoot: steamA,
        resolveLocalAuthority: () => {
            return {
                exePath: '', installFolder: '', achievementSources: [],
                approvedRoots: [{ ...activeInstallation.rootIdentity, path: activeInstallation.rootIdentity.realPath }],
                allowSteamData: true,
                steamRoot: activeInstallation.rootIdentity.realPath,
                steamAppId: '123'
            };
        }
    });
    try {
        assert.notEqual(identityA.rootIdentity.realPath, path.resolve(steamB));
        const result = await service.setLibrary({
            libraryKey: 'profile:library',
            games: [{ id: 'steam-game', name: 'Steam Game', steamAppId: '999', localScanConfigured: true }],
            notificationsEnabled: false,
            trackingEnabled: true,
            forceScan: true
        });
        const ids = result.updates[0].data.items.map(item => item.id);
        assert.equal(ids.includes('FROM_CURRENT_ROOT'), true);
        assert.equal(ids.includes('FROM_STALE_ROOT'), false);
        assert.equal(ids.includes('FROM_REMOTE_METADATA'), false);
        assert.equal(result.updates[0].data.appId, '123');

        service.closeWatchers('steam-game');
        fs.renameSync(steamB, `${steamB}.approved`);
        install(steamB, '123', 'FROM_REPLACEMENT_ROOT');
        await service.scanGame('steam-game', { force: true });
        const staleArtwork = service.readLocalArtwork({
            gameId: 'steam-game', itemId: 'FROM_CURRENT_ROOT', variant: 'unlocked'
        });
        assert.equal(staleArtwork.available, false);
        assert.equal(service.watchers.has('steam-game'), false);

        activeInstallation = resolveInstalledSteamApp('123', { steamRoot: steamB });
        const refreshed = await service.scanGame('steam-game', { force: true });
        assert.equal(refreshed.data.items.some(item => item.id === 'FROM_REPLACEMENT_ROOT'), true);
    } finally {
        service.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Steam binary achievement schemas provide local names and descriptions', () => {
    const cstring = value => Buffer.concat([Buffer.from(String(value), 'utf8'), Buffer.from([0])]);
    const field = (type, key, value) => Buffer.concat([Buffer.from([type]), cstring(key), value]);
    const stringField = (key, value) => field(1, key, cstring(value));
    const objectField = (key, children) => field(0, key, Buffer.concat([...children, Buffer.from([8])]));
    const schema = Buffer.concat([
        objectField('777', [
            objectField('stats', [
                objectField('0', [
                    objectField('bits', [
                        objectField('0', [
                            stringField('name', 'ACH_BINARY'),
                            objectField('display', [
                                stringField('name', 'Cached locally'),
                                stringField('desc', 'Read from Steam client cache.'),
                                stringField('hidden', '0')
                            ])
                        ])
                    ])
                ])
            ])
        ]),
        Buffer.from([8])
    ]);
    const items = parseAchievementBinary(schema);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'ACH_BINARY');
    assert.equal(items[0].displayName, 'Cached locally');
    assert.equal(items[0].description, 'Read from Steam client cache.');
});

test('achievement service pairs local progress and metadata without configured Steam fields', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-local-service-'));
    const settingsRoot = path.join(root, 'steam_settings');
    fs.mkdirSync(settingsRoot, { recursive: true });
    fs.writeFileSync(path.join(root, 'steam_appid.txt'), '777');
    fs.writeFileSync(path.join(root, 'achievements.json'), JSON.stringify({
        achievements: { ACH_OFFLINE: { achieved: true, unlocktime: 1710000000 } }
    }));
    fs.writeFileSync(path.join(settingsRoot, 'achievements.json'), JSON.stringify([{
        name: 'ACH_OFFLINE',
        displayName: 'Works offline',
        description: 'No account details needed.'
    }]));
    const service = new AchievementService({
        app: { getAppPath: () => root },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        steamRoot: ''
    });
    try {
        const result = await service.setLibrary({
            libraryKey: 'local:default',
            forceScan: true,
            games: [{
                id: 'offline-game', name: 'Offline Game', exePath: path.join(root, 'game.exe'),
                localScanConfigured: true, approvedRoots: [approvedRoot(root)]
            }]
        });
        assert.equal(result.updates.length, 1);
        assert.equal(result.updates[0].data.appId, '777');
        assert.equal(result.updates[0].data.items[0].displayName, 'Works offline');
        assert.equal(result.updates[0].data.items[0].description, 'No account details needed.');
        assert.equal(result.updates[0].data.items[0].unlocked, true);
    } finally {
        service.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('portable snapshots sync achievement data but never device source paths', () => {
    const portable = portableArtifactToSnapshot(portableSnapshot({
        myGames: [{
            id: 'game-1',
            name: 'Portable Achievements',
            steamAppId: '123',
            achievementData: { appId: '123', items: [{ id: 'A', unlocked: true, icon: 'C:\\Private\\achievement.png', iconPath: 'C:\\Private\\achievement.png' }] },
            achievementSources: [{ id: 'source', path: 'C:\\Private\\achievements.ini', kind: 'file' }]
        }],
        globalSettings: { steamApiKey: 'secret' }
    }));
    assert.ok(portable.myGames[0].achievementData);
    assert.equal(portable.myGames[0].achievementData.items[0].icon, null);
    assert.equal(Object.prototype.hasOwnProperty.call(portable.myGames[0].achievementData.items[0], 'iconPath'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(portable.myGames[0], 'achievementSources'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(portable.globalSettings, 'steamApiKey'), false);
});

test('profile merge unions remote achievement progress without carrying renderer-owned source paths', () => {
    const merged = mergePortableGames([
        {
            id: 'game-1',
            steamAppId: '123',
            achievementSources: [{ id: 'local-source', path: 'C:\\Local\\achievements.ini' }],
            achievementData: { appId: '123', items: [{ id: 'LOCAL', unlocked: true }] },
            playtime: 7200,
            lastPlayed: 1720000000000,
            playtimeSessionIds: ['local-session']
        }
    ], [
        {
            id: 'game-1',
            steamAppId: '123',
            achievementData: { appId: '123', items: [{ id: 'REMOTE', unlocked: true }] },
            playtime: 3600,
            lastPlayed: 1710000000000,
            playtimeSessionIds: ['remote-session']
        }
    ]);
    assert.equal(Object.prototype.hasOwnProperty.call(merged[0], 'achievementSources'), false);
    assert.deepEqual(merged[0].achievementData.items.map(item => item.id), ['LOCAL', 'REMOTE']);
    assert.equal(merged[0].playtime, 7200);
    assert.equal(merged[0].lastPlayed, 1720000000000);
    assert.deepEqual(merged[0].playtimeSessionIds, ['remote-session', 'local-session']);
    const admittedRemote = portableArtifactToSnapshot(portableSnapshot({
        myGames: [{
            id: 'remote-only', name: 'Remote Only',
            achievementSources: [{ path: 'C:\\OtherPc\\achievements.ini' }]
        }]
    }));
    const remoteOnly = mergePortableGames([], admittedRemote.myGames);
    assert.equal(Object.prototype.hasOwnProperty.call(remoteOnly[0], 'achievementSources'), false);
});

test('Steam schema and player progress normalize metadata, icons, and unlock times', () => {
    const data = normalizeSteamData('123', [{
        name: 'ACH_STEAM', displayName: 'Steam Name', description: 'Steam description', hidden: 0,
        icon: 'https://example.test/unlocked.jpg', icongray: 'https://example.test/locked.jpg'
    }], [{ apiname: 'ACH_STEAM', achieved: 1, unlocktime: 1710000200 }], 1710000300000);
    assert.equal(data.items[0].displayName, 'Steam Name');
    assert.equal(data.items[0].unlocked, true);
    assert.equal(data.items[0].unlockTime, 1710000200000);
    assert.equal(data.items[0].iconGray, 'https://example.test/locked.jpg');
});

test('Steam icon URLs are upgraded safely and failed schema metadata retries next launch', async () => {
    const normalized = normalizeAchievementData({ items: [
        { id: 'STEAM_ICON', icon: 'http://media.steampowered.com/icon.jpg' },
        { id: 'UNTRUSTED_ICON', icon: 'http://example.test/icon.jpg' }
    ] });
    assert.equal(normalized.items[0].icon, 'https://media.steampowered.com/icon.jpg');
    assert.equal(normalized.items[1].icon, null);

    const result = await fetchGameAchievementData({
        apiKey: 'key',
        steamId: '76561198000000000',
        appId: '123'
    }, {
        fetchImpl: async url => String(url).includes('GetSchemaForGame')
            ? { ok: false, status: 500, json: async () => ({}) }
            : { ok: true, status: 200, json: async () => ({ playerstats: { success: true, achievements: [{ apiname: 'ACH', achieved: 1 }] } }) }
    });
    assert.equal(result.data.items[0].unlocked, true);
    assert.equal(result.data.lastSteamRefreshAt, null);
    assert.match(result.warning, /Steam could not return achievement data/i);
});

test('Steam account import matches existing games and reports unmatched owned games', async () => {
    const fetchImpl = async url => {
        const value = String(url);
        let body;
        if (value.includes('GetOwnedGames')) {
            body = { response: { games: [{ appid: 123, name: 'Matched' }, { appid: 999, name: 'Unmatched' }] } };
        } else if (value.includes('GetSchemaForGame')) {
            body = { game: { availableGameStats: { achievements: [{ name: 'ACH', displayName: 'Achievement' }] } } };
        } else {
            body = { playerstats: { success: true, achievements: [{ apiname: 'ACH', achieved: 1, unlocktime: 1710000000 }] } };
        }
        return { ok: true, status: 200, json: async () => body };
    };
    const result = await importSteamAchievements({
        steamApiKey: 'test-key',
        steamId: '76561198000000000',
        games: [{ id: 'local-game', name: 'Matched', steamAppId: '123' }]
    }, { fetchImpl });
    assert.equal(result.updates.length, 1);
    assert.equal(result.updates[0].data.items[0].unlocked, true);
    assert.deepEqual(result.unmatched.map(game => game.appId), ['999']);
    assert.deepEqual(result.errors, []);
});

test('Steam schema-only import does not need a SteamID and keeps local unlocks', async () => {
    const result = await importSteamSchema({
        steamApiKey: 'test-key',
        games: [{
            id: 'offline-game',
            steamAppId: '480',
            achievementData: { items: [{ id: '21_Acquire_AllNanoSuit', unlocked: true, unlockTime: 1710000000000, source: 'goldberg' }] }
        }]
    }, {
        fetchImpl: async url => {
            assert.match(String(url), /GetSchemaForGame/);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    game: {
                        availableGameStats: {
                            achievements: [{
                                name: '21_Acquire_AllNanoSuit',
                                displayName: 'Acquire All Nano Suit',
                                description: 'Collect every nanosuit.',
                                icon: 'https://example.test/nano.jpg',
                                icongray: 'https://example.test/nano-gray.jpg'
                            }]
                        }
                    }
                })
            };
        }
    });
    assert.equal(result.errors.length, 0);
    const item = result.updates[0].data.items[0];
    assert.equal(item.displayName, 'Acquire All Nano Suit');
    assert.equal(item.icon, 'https://example.test/nano.jpg');
    const merged = mergeAchievementData({
        items: [{ id: '21_Acquire_AllNanoSuit', unlocked: true, unlockTime: 1710000000000, source: 'goldberg' }]
    }, result.updates[0].data);
    assert.equal(merged.items[0].unlocked, true);
    assert.equal(merged.items[0].displayName, 'Acquire All Nano Suit');
});

test('public Steam metadata maps Goldberg IDs to official titles and icons without an API key', async () => {
    const requested = [];
    const fetchImpl = async url => {
        const value = String(url);
        requested.push(value);
        if (value.includes('GetGlobalAchievementPercentagesForApp')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    achievementpercentages: {
                        achievements: [
                            { name: '02_Activate_FirstCamp', percent: 94.2 },
                            { name: '39_CharKill_BetaSkill', percent: 53.4 },
                            { name: '09_KillCharacter_Juggernaut_Kill', percent: 53.4 },
                            { name: '21_Acquire_AllNanoSuit', percent: 38.7 }
                        ]
                    }
                })
            };
        }
        assert.match(value, /steamcommunity\.com\/stats\/3489700\/achievements/);
        return {
            ok: true,
            status: 200,
            text: async () => `
                <div class="achieveRow ">
                    <img src="https://shared.fastly.steamstatic.com/community_assets/images/apps/3489700/camp.jpg">
                    <div class="achievePercent">94.2%</div>
                    <h3>Camp Preparation</h3><h5>Activated the first Camp.</h5>
                </div>
                <div class="achieveRow ">
                    <img src="https://shared.fastly.steamstatic.com/community_assets/images/apps/3489700/juggernaut.jpg">
                    <div class="achievePercent">53.5%</div>
                    <h3>Juggernaut</h3><h5></h5>
                </div>
                <div class="achieveRow ">
                    <img src="https://shared.fastly.steamstatic.com/community_assets/images/apps/3489700/beta.jpg">
                    <div class="achievePercent">53.4%</div>
                    <h3>Naytiba Hunter</h3><h5>Defeated 100 enemies with Beta Skills.</h5>
                </div>
                <div class="achieveRow ">
                    <img src="https://shared.fastly.steamstatic.com/community_assets/images/apps/3489700/suit.jpg?x=1&amp;y=2">
                    <div class="achievePercent">38.7%</div>
                    <h3>Nano Suit Collector</h3><h5>Acquired 30 Nano Suits.</h5>
                </div>`
        };
    };
    const schema = await fetchCommunitySchema('3489700', { fetchImpl });
    assert.equal(requested.length, 2);
    assert.deepEqual(schema.map(item => item.name), ['02_Activate_FirstCamp', '39_CharKill_BetaSkill', '09_KillCharacter_Juggernaut_Kill', '21_Acquire_AllNanoSuit']);
    assert.equal(schema[1].displayName, 'Naytiba Hunter');
    assert.equal(schema[2].displayName, 'Juggernaut');
    assert.equal(schema[3].displayName, 'Nano Suit Collector');
    assert.equal(schema[3].icon, 'https://shared.fastly.steamstatic.com/community_assets/images/apps/3489700/suit.jpg?x=1&y=2');

    const result = await importSteamSchema({
        games: [{ id: 'goldberg-game', steamAppId: '3489700' }]
    }, { fetchImpl });
    assert.equal(result.errors.length, 0);
    assert.equal(result.updates[0].data.items[3].icon, schema[3].icon);
    const merged = mergeAchievementData({
        items: [{ id: '21_Acquire_AllNanoSuit', unlocked: true, source: 'goldberg' }]
    }, result.updates[0].data);
    assert.equal(merged.items[0].unlocked, true);
    assert.equal(merged.items[0].displayName, 'Nano Suit Collector');
    assert.equal(merged.items[0].icon, schema[3].icon);
});

test('community XML and numbered emulator IDs map onto official Steam names', () => {
    assert.equal(humanizeAchievementId('21_Acquire_AllNanoSuit'), 'Acquire All Nano Suit');
    const parsed = parseCommunityAchievementXml(`
        <achievements>
            <achievement>
                <apiname>21_Acquire_AllNanoSuit</apiname>
                <name>Acquire All Nano Suit</name>
                <description>Collect every nanosuit.</description>
                <iconClosed>https://example.test/closed.jpg</iconClosed>
            </achievement>
        </achievements>
    `, '480');
    assert.equal(parsed[0].displayName, 'Acquire All Nano Suit');
    const merged = mergeAchievementData({
        items: [{ id: '21_Acquire_AllNanoSuit', unlocked: true, source: 'goldberg' }]
    }, { items: [{ id: 'Acquire_AllNanoSuit', displayName: 'Acquire All Nano Suit', icon: 'https://example.test/closed.jpg', source: 'steam' }] });
    assert.equal(merged.items[0].unlocked, true);
    assert.equal(merged.items[0].displayName, 'Acquire All Nano Suit');
    assert.equal(merged.items[0].icon, 'https://example.test/closed.jpg');
});

test('community achievement HTML ignores unrelated images and preserves row order', () => {
    const rows = parseCommunityAchievementHtml(`
        <img src="https://example.test/header.jpg">
        <div class="achieveRow "><img src="https://example.test/a.jpg"><div class="achievePercent">50.0%</div><h3>A &amp; B</h3><h5>First</h5></div>
        <div class="achieveRow "><img src="https://example.test/b.jpg"><div class="achievePercent">25.5%</div><h3>Second</h3><h5></h5></div>
    `, '123');
    assert.deepEqual(rows.map(row => row.displayName), ['A & B', 'Second']);
    assert.deepEqual(rows.map(row => row.percent), [50, 25.5]);
});

test('normalization accepts absent optional timestamps without manufacturing unlocks', () => {
    const data = normalizeAchievementData({ appId: '1', updatedAt: 0, items: [{ id: 'LOCKED', displayName: 'Locked' }] });
    assert.equal(data.updatedAt, 0);
    assert.equal(data.items[0].unlocked, false);
    assert.equal(data.items[0].unlockTime, null);
});

test('achievement service suppresses initial notifications and emits a later live unlock once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-achievement-service-'));
    const sourcePath = path.join(root, 'achievements.json');
    fs.writeFileSync(sourcePath, JSON.stringify({ achievements: { LIVE_UNLOCK: { achieved: false } } }));
    const sent = [];
    const window = {
        isDestroyed: () => false,
        isVisible: () => true,
        webContents: { send: (channel, payload) => sent.push({ channel, payload }) }
    };
    class FakeNotification {
        static isSupported() { return true; }
        show() {}
    }
    const service = new AchievementService({
        app: { getAppPath: () => root },
        BrowserWindow: { getAllWindows: () => [window] },
        Notification: FakeNotification,
        dialog: {},
        steamRoot: ''
    });
    try {
        const initial = await service.setLibrary({
            games: [{
                id: 'live-game',
                name: 'Live Game',
                achievementSources: [{ id: 'manual', kind: 'file', path: sourcePath, enabled: true }],
                localScanConfigured: true,
                approvedRoots: [approvedRoot(sourcePath, 'file')]
            }],
            notificationsEnabled: true
        });
        assert.equal(initial.updates.length, 1);
        assert.equal(sent.length, 0);

        fs.writeFileSync(sourcePath, JSON.stringify({ achievements: { LIVE_UNLOCK: { achieved: true, unlocktime: 1710000000 } } }));
        const update = await service.scanGame('live-game', { force: true, emit: true, notify: true, trackDiff: true });
        assert.deepEqual(update.newlyUnlocked.map(item => item.id), ['LIVE_UNLOCK']);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].channel, 'achievements-updated');
        assert.deepEqual(sent[0].payload.newlyUnlocked.map(item => item.id), ['LIVE_UNLOCK']);

        fs.writeFileSync(sourcePath, JSON.stringify({ achievements: { LIVE_UNLOCK: { achieved: false } } }));
        const switched = await service.setLibrary({
            libraryKey: 'another-profile:library',
            games: [{
                id: 'live-game',
                name: 'Live Game',
                achievementSources: [{ id: 'manual', kind: 'file', path: sourcePath, enabled: true }],
                localScanConfigured: true,
                approvedRoots: [approvedRoot(sourcePath, 'file')]
            }],
            notificationsEnabled: true
        });
        assert.equal(switched.updates[0].data.items[0].unlocked, false);
        const staleRefresh = await service.refreshLocal({
            libraryKey: 'local',
            gameId: 'live-game',
            game: { id: 'live-game', achievementSources: [] }
        });
        assert.equal(staleRefresh.stale, true);
        assert.equal(service.games.get('live-game').achievementSources[0].path, sourcePath);
    } finally {
        service.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('unchanged main-owned achievement authority does not restart the save and scan loop', async () => {
    const service = new AchievementService({
        app: { getAppPath: () => process.cwd() },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        steamRoot: '',
        resolveLocalAuthority: () => ({ approvedRoots: [], achievementSources: [] })
    });
    let scanCount = 0;
    service.scanGame = async () => {
        scanCount += 1;
        return { changed: false, data: null, newlyUnlocked: [], errors: [] };
    };
    const payload = localAuthorityVersion => ({
        libraryKey: 'profile:library',
        trackingEnabled: true,
        games: [{
            id: 'authority-game', name: 'Authority Game', localScanConfigured: true,
            localAuthorityVersion
        }]
    });
    try {
        await service.setLibrary(payload('revision-1'));
        await service.setLibrary(payload('revision-1'));
        assert.equal(scanCount, 1);

        await service.setLibrary(payload('revision-2'));
        assert.equal(scanCount, 2);

        await service.setLibrary({ ...payload('revision-2'), forceScan: true });
        assert.equal(scanCount, 3);
    } finally {
        service.dispose();
    }
});

test('disabling achievement tracking closes watchers and blocks manual scans without deleting progress', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-achievement-disabled-'));
    const sourcePath = path.join(root, 'achievements.json');
    fs.writeFileSync(sourcePath, JSON.stringify({ achievements: { STORED: { achieved: true } } }));
    const service = new AchievementService({
        app: { getAppPath: () => root },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        steamRoot: ''
    });
    try {
        const disabled = await service.setLibrary({
            libraryKey: 'local:default',
            trackingEnabled: false,
            games: [{
                id: 'disabled-game',
                name: 'Disabled Game',
                achievementSources: [{ id: 'manual', kind: 'file', path: sourcePath, enabled: true }],
                achievementData: { items: [{ id: 'STORED', unlocked: true }] }
            }]
        });
        assert.equal(disabled.disabled, true);
        assert.equal(service.watchers.size, 0);
        assert.equal(service.baselines.get('disabled-game').items[0].unlocked, true);
        const scan = await service.refreshLocal({ libraryKey: 'local:default', gameId: 'disabled-game' });
        assert.equal(scan.disabled, true);

        const enabled = await service.setLibrary({
            libraryKey: 'local:default',
            trackingEnabled: true,
            forceScan: true,
            games: [{ id: 'disabled-game', name: 'Disabled Game', achievementSources: [{ id: 'manual', kind: 'file', path: sourcePath, enabled: true }] }]
        });
        assert.equal(enabled.disabled, undefined);
        assert.equal(service.baselines.get('disabled-game').items[0].unlocked, true);
    } finally {
        service.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('per-game suspension releases achievement watchers and resumes them after a failed uninstall', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-achievement-uninstall-'));
    const sourcePath = path.join(root, 'achievements.json');
    fs.writeFileSync(sourcePath, JSON.stringify({ achievements: { WATCHED: { achieved: true } } }));
    const service = new AchievementService({
        app: { getAppPath: () => root },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        steamRoot: ''
    });
    try {
        await service.setLibrary({
            libraryKey: 'local:default',
            trackingEnabled: true,
            forceScan: true,
            games: [{
                id: 'uninstall-game',
                name: 'Uninstall Game',
                approvedRoots: [{ path: root, kind: 'directory' }],
                achievementSources: [{ id: 'manual', kind: 'file', path: sourcePath, enabled: true }]
            }]
        });
        assert.equal(service.watchers.has('uninstall-game'), true);
        assert.equal(service.suspendGame('uninstall-game'), true);
        assert.equal(service.watchers.has('uninstall-game'), false);
        assert.equal(service.resumeGame('uninstall-game'), true);
        assert.equal(service.watchers.has('uninstall-game'), true);
        service.forgetGame('uninstall-game');
        assert.equal(service.watchers.has('uninstall-game'), false);
        assert.equal(service.games.has('uninstall-game'), false);
    } finally {
        service.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
