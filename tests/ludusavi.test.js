'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    LUDUSAVI_MANIFEST_URL,
    detectLudusaviSaveCandidates,
    findManifestGame,
    loadLudusaviManifest,
    parseManifest,
    resolveLudusaviPaths,
    steamLibraryRoot
} = require('../maintenance/ludusavi');

test('Ludusavi uses the published YAML manifest and matches renamed Steam games by AppID', () => {
    assert.match(LUDUSAVI_MANIFEST_URL, /data\/manifest\.yaml$/);
    const manifest = parseManifest(`
Canonical Game:
  files:
    <winAppData>/Studio/Canonical Game/*.sav:
      tags: [save]
  steam:
    id: 12345
Store Display Name:
  alias: Canonical Game
  steam:
    id: 98765
`);
    assert.equal(findManifestGame(manifest, { gameName: 'A completely different Steam title', steamAppId: '12345' }).title, 'Canonical Game');
    assert.equal(findManifestGame(manifest, { gameName: 'Store Display Name', steamAppId: '98765' }).title, 'Canonical Game');
});

test('Ludusavi resolves Windows, installation, Steam game, and Steam user placeholders', () => {
    const root = path.join('D:\\', 'SteamLibrary');
    const installFolder = path.join(root, 'steamapps', 'common', 'Demo Game');
    assert.equal(steamLibraryRoot(installFolder), root);
    const gameData = { steam: { id: 765 }, installDir: { 'Demo Game': {} } };
    const options = {
        env: {
            APPDATA: 'C:\\Users\\Pookie\\AppData\\Roaming',
            LOCALAPPDATA: 'C:\\Users\\Pookie\\AppData\\Local',
            USERNAME: 'Pookie'
        },
        homePath: 'C:\\Users\\Pookie',
        documentsPath: 'E:\\Pookie Documents',
        steamRoot: 'C:\\Program Files (x86)\\Steam',
        steamUserIds: ['111', '222']
    };
    assert.deepEqual(resolveLudusaviPaths('<winDocuments>/My Games/Demo', gameData, { steamAppId: '765', installFolder }, options), [
        path.normalize('E:\\Pookie Documents\\My Games\\Demo')
    ]);
    assert.deepEqual(resolveLudusaviPaths('<root>/userdata/<storeUserId>/<storeGameId>/remote', gameData, { steamAppId: '765', installFolder }, options), [
        path.normalize('D:\\SteamLibrary\\userdata\\111\\765\\remote'),
        path.normalize('D:\\SteamLibrary\\userdata\\222\\765\\remote')
    ]);
    assert.deepEqual(resolveLudusaviPaths('<base>/Saves', gameData, { steamAppId: '765', installFolder }, options), [
        path.normalize('D:\\SteamLibrary\\steamapps\\common\\Demo Game\\Saves')
    ]);
});

test('Ludusavi returns existing save folders, follows globs, and excludes config-only paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-ludusavi-'));
    try {
        const home = path.join(root, 'Users', 'Pookie');
        const roaming = path.join(home, 'AppData', 'Roaming');
        const local = path.join(home, 'AppData', 'Local');
        const saveFolder = path.join(roaming, 'Demo Studio', 'Demo Game', 'Saves');
        const configFolder = path.join(local, 'Demo Studio', 'Demo Game');
        fs.mkdirSync(saveFolder, { recursive: true });
        fs.mkdirSync(configFolder, { recursive: true });
        fs.writeFileSync(path.join(saveFolder, 'slot-1.sav'), 'save');
        fs.writeFileSync(path.join(configFolder, 'settings.ini'), 'config');
        const manifest = {
            'Canonical Demo': {
                steam: { id: 2468 },
                files: {
                    '<winAppData>/Demo Studio/Demo Game/Saves/*.sav': { tags: ['save'], when: [{ os: 'windows', store: 'steam' }] },
                    '<winLocalAppData>/Demo Studio/Demo Game/settings.ini': { tags: ['config'] },
                    '<home>': { tags: ['save'] },
                    '<home>/../': { tags: ['save'] },
                    '<home>/Linux Game/save.dat': { tags: ['save'], when: [{ os: 'linux' }] }
                }
            }
        };
        const result = detectLudusaviSaveCandidates(manifest, {
            gameName: 'Wrong Store Name',
            steamAppId: '2468'
        }, {
            env: { APPDATA: roaming, LOCALAPPDATA: local, USERNAME: 'Pookie' },
            homePath: home,
            documentsPath: path.join(home, 'Documents')
        });
        assert.equal(result.matchedGame, 'Canonical Demo');
        assert.deepEqual(result.candidates.map(candidate => candidate.path), [saveFolder]);
        assert.equal(result.candidates[0].matchedFiles, true);
        assert.match(result.candidates[0].reason, /Canonical Demo/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Ludusavi downloads, parses, and reuses a fresh local YAML cache', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-ludusavi-cache-'));
    try {
        const cachePath = path.join(root, 'ludusavi_manifest.yaml');
        let requests = 0;
        const firstStatuses = [];
        const first = await loadLudusaviManifest({
            cachePath,
            onStatus: status => firstStatuses.push(status.phase),
            fetchImpl: async url => {
                requests++;
                assert.equal(url, LUDUSAVI_MANIFEST_URL);
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => null },
                    text: async () => 'Cached Game:\n  steam:\n    id: 99\n'
                };
            }
        });
        const secondStatuses = [];
        const second = await loadLudusaviManifest({
            cachePath,
            onStatus: status => secondStatuses.push(status.phase),
            fetchImpl: async () => { throw new Error('The fresh cache should be used.'); }
        });
        assert.equal(first.manifest['Cached Game'].steam.id, 99);
        assert.equal(second.manifest['Cached Game'].steam.id, 99);
        assert.equal(requests, 1);
        assert.deepEqual(firstStatuses, ['download', 'ready']);
        assert.deepEqual(secondStatuses, ['cache']);
        assert.match(fs.readFileSync(cachePath, 'utf8'), /Cached Game:/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Ludusavi scan UI reports real phases, labels sources, and uses broad scanning only as fallback', () => {
    const root = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const renderer = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(main, /sender\.send\('save-detection-status'/);
    assert.match(renderer, /ipcRenderer\.on\('save-detection-status'/);
    assert.match(renderer, /Preparing Ludusavi save detection/);
    assert.match(renderer, /mode !== 'ludusavi' \|\| !providerCandidates\.length/);
    assert.match(renderer, /No Ludusavi save folder was found\. Scanning local folders/);
    assert.match(renderer, /ludusavi:\s*'Ludusavi'/);
    assert.match(renderer, /saveDetectionSourceLabel\(candidate\.source\)/);
});

test('save management settings are grouped under Saves & Data without beta labeling', () => {
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const systemPane = renderer.slice(
        renderer.indexOf('id="tab-system"'),
        renderer.indexOf('id="tab-library"')
    );
    const advancedPane = renderer.slice(
        renderer.indexOf('id="tab-advanced"'),
        renderer.indexOf('id="tab-extra"')
    );
    const dataPane = renderer.slice(
        renderer.indexOf('id="tab-data"'),
        renderer.indexOf('id="tab-experimental"')
    );
    const experimentalPane = renderer.slice(
        renderer.indexOf('id="tab-experimental"'),
        renderer.indexOf('id="tab-cloud"')
    );
    assert.match(renderer, /data-i18n="dataBackup">💾\s+Saves &amp; Data/);
    assert.match(dataPane, /Save Folder Detection/);
    assert.match(dataPane, /id="enableSaveDetectionToggle"/);
    assert.match(dataPane, /Ludusavi Save Database/);
    assert.match(dataPane, /Save Backups &amp; Versioning/);
    assert.match(dataPane, /id="saveBackupCountSelect"/);
    assert.match(dataPane, /id="disableLocalSavesToggle"/);
    assert.match(dataPane, /Save Locations/);
    assert.match(dataPane, /Custom Quick Save\s+Paths/);
    assert.match(dataPane, /data-i18n="launcherData">Launcher Data/);
    assert.doesNotMatch(systemPane, /enableSaveDetectionToggle|saveDetectionModeSelect|Save Folder Detection/);
    assert.doesNotMatch(advancedPane, /saveBackupCountSelect|disableLocalSavesToggle|Save Folder Detection/);
    assert.doesNotMatch(experimentalPane, /enableSaveDetectionToggle|saveDetectionModeSelect|Save Folder Detection/);
    assert.doesNotMatch(renderer, /This feature is currently in beta/);
    assert.doesNotMatch(renderer, /Settings → System/);
    assert.match(renderer, /Settings → Saves & Data/);
    assert.equal((renderer.match(/id="enableSaveDetectionToggle"/g) || []).length, 1);
    assert.equal((renderer.match(/id="saveBackupCountSelect"/g) || []).length, 1);
    assert.equal((renderer.match(/id="disableLocalSavesToggle"/g) || []).length, 1);
});

test('Ludusavi replaces a stale YAML cache and keeps its stale copy when refresh fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-ludusavi-stale-'));
    try {
        const replacedPath = path.join(root, 'replace.yaml');
        fs.writeFileSync(replacedPath, 'Old Game:\n  steam:\n    id: 1\n');
        const oldTime = new Date(Date.now() - 60_000);
        fs.utimesSync(replacedPath, oldTime, oldTime);
        const replaced = await loadLudusaviManifest({
            cachePath: replacedPath,
            maxAgeMs: 1,
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                headers: { get: () => null },
                text: async () => 'New Game:\n  steam:\n    id: 2\n'
            })
        });
        assert.equal(replaced.source, 'download');
        assert.equal(replaced.manifest['New Game'].steam.id, 2);

        const fallbackPath = path.join(root, 'fallback.yaml');
        fs.writeFileSync(fallbackPath, 'Fallback Game:\n  steam:\n    id: 3\n');
        fs.utimesSync(fallbackPath, oldTime, oldTime);
        const fallback = await loadLudusaviManifest({
            cachePath: fallbackPath,
            maxAgeMs: 1,
            fetchImpl: async () => { throw new Error('offline'); }
        });
        assert.equal(fallback.source, 'cache');
        assert.equal(fallback.stale, true);
        assert.equal(fallback.manifest['Fallback Game'].steam.id, 3);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
