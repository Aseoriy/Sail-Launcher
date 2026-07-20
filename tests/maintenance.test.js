'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { CleanupService, classifyFile } = require('../maintenance/cleanupService');
const { redactValue } = require('../maintenance/diagnosticService');
const { MaintenanceJobManager } = require('../maintenance/jobManager');
const { ManifestStore, migrateManifest } = require('../maintenance/manifestStore');
const { ensureNoLinkEscape, resolveWithin } = require('../maintenance/pathSafety');
const { MaintenanceScanner, CancellationError } = require('../maintenance/scanner');
const { scanSaveCandidates } = require('../maintenance/saveScanner');
const { MaintenanceService } = require('../maintenance/service');
const { SnapshotService } = require('../maintenance/snapshotService');

async function fixture(t) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sail-maintenance-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    return root;
}

async function write(target, content = 'data') {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
}

async function waitForJob(service, jobId) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const job = service.jobs.get(jobId);
        if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for maintenance job ${jobId}`);
}

function game(root, extra = {}) {
    return Object.assign({ id: 'game-1', name: 'Example Game', installFolder: root, exePath: path.join(root, 'ExampleGame.exe'), addedAt: Date.now() }, extra);
}

test('manifest serialization migrates schema 1 and keeps a recoverable backup', async t => {
    const root = await fixture(t);
    const store = new ManifestStore(path.join(root, 'maintenance'));
    const migrated = migrateManifest({ schemaVersion: 1, gameId: 'game-1', installRoot: root, files: [] });
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.creationMethod, 'migrated');
    await store.save(migrated);
    const updated = Object.assign({}, migrated, { lastScannedAt: new Date().toISOString() });
    await store.save(updated);
    assert.equal((await store.load('game-1')).lastScannedAt, updated.lastScannedAt);
    assert.equal(fs.existsSync(store.manifestPath('game-1') + '.bak'), true);
});

test('atomic manifest replacement refuses to overwrite an unreadable manifest', async t => {
    const root = await fixture(t);
    const store = new ManifestStore(path.join(root, 'maintenance'));
    await fs.promises.mkdir(path.dirname(store.manifestPath('game-1')), { recursive: true });
    await fs.promises.writeFile(store.manifestPath('game-1'), '{broken', 'utf8');
    await assert.rejects(store.save({ schemaVersion: 2, gameId: 'game-1', installRoot: root, files: [], mutablePaths: [], protectedPaths: [], modifications: [] }), /invalid/i);
    assert.equal(await fs.promises.readFile(store.manifestPath('game-1'), 'utf8'), '{broken');
});

test('baseline generation records important files, hashes, and mutable paths', async t => {
    const root = await fixture(t);
    await write(path.join(root, 'ExampleGame.exe'), 'binary-game');
    await write(path.join(root, 'bin', 'engine.dll'), 'binary-dll');
    await write(path.join(root, 'Saves', 'slot1.sav'), 'player-data');
    const scanner = new MaintenanceScanner();
    const manifest = await scanner.createBaseline(game(root), { hashImportantFiles: true });
    assert.equal(manifest.executablePath, 'ExampleGame.exe');
    assert.ok(manifest.files.find(item => item.path === 'bin/engine.dll').sha256);
    assert.ok(manifest.mutablePaths.some(item => item.toLowerCase() === 'saves'));
    assert.equal(manifest.files.find(item => item.path === 'Saves/slot1.sav').mutable, true);
});

test('scanner detects a missing executable', async t => {
    const root = await fixture(t);
    await write(path.join(root, 'readme.txt'));
    const scanner = new MaintenanceScanner();
    const result = await scanner.scan(game(root, { exePath: path.join(root, 'missing.exe') }), null);
    assert.ok(result.issues.some(item => item.code === 'EXECUTABLE_MISSING'));
});

test('scanner rediscovers a renamed executable', async t => {
    const root = await fixture(t);
    await write(path.join(root, 'RenamedGame.exe'), 'exe');
    const scanner = new MaintenanceScanner();
    const result = await scanner.scan(game(root, { exePath: path.join(root, 'old.exe') }), null);
    const issue = result.issues.find(item => item.code === 'EXECUTABLE_MOVED');
    assert.ok(issue);
    assert.equal(issue.discoveredPath, path.join(root, 'RenamedGame.exe'));
});

test('scanner handles a moved installation and missing baseline files', async t => {
    const oldRoot = await fixture(t);
    const newRoot = await fixture(t);
    await write(path.join(newRoot, 'ExampleGame.exe'), 'exe');
    const manifest = { schemaVersion: 2, gameId: 'game-1', installRoot: oldRoot, executablePath: 'ExampleGame.exe', files: [{ path: 'missing.dll', size: 4, mtimeMs: 1, important: true }], mutablePaths: [], protectedPaths: ['missing.dll'], modifications: [] };
    const result = await new MaintenanceScanner().scan(game(newRoot), manifest);
    assert.ok(result.issues.some(item => item.code === 'INSTALL_MOVED'));
    assert.ok(result.issues.some(item => item.code === 'MANIFEST_FILE_MISSING'));
});

test('mutable file changes are excluded while optional hashes detect protected changes', async t => {
    const root = await fixture(t);
    await write(path.join(root, 'ExampleGame.exe'), '12345678');
    await write(path.join(root, 'Saves', 'slot.sav'), 'save-one');
    const scanner = new MaintenanceScanner();
    const manifest = await scanner.createBaseline(game(root), { hashImportantFiles: true });
    await write(path.join(root, 'Saves', 'slot.sav'), 'save-two');
    await write(path.join(root, 'ExampleGame.exe'), '87654321');
    const result = await scanner.scan(game(root), manifest, { deep: true });
    assert.ok(result.issues.some(item => item.code === 'HASH_MISMATCH' && item.path === 'ExampleGame.exe'));
    assert.equal(result.issues.some(item => item.path === 'Saves/slot.sav' && /FILE_CHANGED|HASH_MISMATCH/.test(item.code)), false);
});

test('scanner handles inaccessible or linked entries without failing the scan', async t => {
    const root = await fixture(t);
    const outside = await fixture(t);
    await write(path.join(root, 'ExampleGame.exe'), 'exe');
    await write(path.join(outside, 'secret.dll'), 'secret');
    try { await fs.promises.symlink(outside, path.join(root, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { t.skip(`links unavailable on this host: ${error.code}`); return; }
    const manifest = await new MaintenanceScanner().createBaseline(game(root));
    assert.ok(manifest.scan.skippedLinks.includes('linked-outside'));
    assert.equal(manifest.files.some(item => item.path.includes('secret.dll')), false);
});

test('baseline generation supports cancellation', async t => {
    const root = await fixture(t);
    await write(path.join(root, 'ExampleGame.exe'), 'exe');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(new MaintenanceScanner().createBaseline(game(root), { signal: controller.signal }), CancellationError);
});

test('service baseline with automatic cleanup enabled completes and renderer details omit the large file list', async t => {
    const root = await fixture(t);
    const serviceRoot = await fixture(t);
    await write(path.join(root, 'ExampleGame.exe'), 'exe');
    await write(path.join(root, 'download.bin.aria2'), 'partial');
    const service = new MaintenanceService({ baseDir: serviceRoot, version: '5.2.0', homeDir: os.homedir() });
    const started = service.startBaseline(game(root), { autoCleanSafeTemporaryFiles: true });
    const completed = await waitForJob(service, started.id);
    assert.equal(completed.status, 'completed');
    const details = await service.gameDetails(game(root));
    assert.equal(details.manifest.files, undefined);
    assert.equal(details.manifest.fileCount, 1);
    assert.ok(details.manifest.trackedBytes > 0);
    const scanned = service.startScan(game(root), { autoCleanSafeTemporaryFiles: true });
    assert.equal((await waitForJob(service, scanned.id)).status, 'completed');
    assert.equal(fs.existsSync(path.join(root, 'download.bin.aria2')), false);
    assert.match(await fs.promises.readFile(service.auditPath, 'utf8'), /automatic-safe-temporary-files-removed/);
});

test('snapshot creation and rollback restore replaced files and remove added files', async t => {
    const root = await fixture(t);
    const serviceRoot = await fixture(t);
    await write(path.join(root, 'ExampleGame.exe'), 'original');
    const snapshots = new SnapshotService(serviceRoot);
    const record = await snapshots.create(game(root), { displayName: 'Test Mod' }, ['ExampleGame.exe', 'mods/new.txt']);
    await write(path.join(root, 'ExampleGame.exe'), 'modified');
    await write(path.join(root, 'mods', 'new.txt'), 'new');
    const impact = await snapshots.rollback(game(root), record);
    assert.equal(await fs.promises.readFile(path.join(root, 'ExampleGame.exe'), 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(root, 'mods', 'new.txt')), false);
    assert.deepEqual(impact, { restoreFiles: 1, removeFiles: 1, restoreBytes: 8 });
});

test('cleanup classification defaults only known Sail fragments to selected', async t => {
    const root = await fixture(t);
    await write(path.join(root, 'game.zip'), 'archive');
    await write(path.join(root, 'game.bin.aria2'), 'partial');
    const result = await new CleanupService(path.join(root, 'maintenance')).scan({ downloadsRoot: root });
    assert.equal(result.candidates.find(item => item.path.endsWith('game.bin.aria2')).selected, true);
    assert.equal(result.candidates.find(item => item.path.endsWith('game.zip')).selected, false);
});

test('path traversal and symlink escape prevention block paths outside approved roots', async t => {
    const root = await fixture(t);
    assert.throws(() => resolveWithin(root, '..\\outside.txt'), /traversal|escapes/i);
    const outside = await fixture(t);
    try { await fs.promises.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { t.skip(`links unavailable on this host: ${error.code}`); return; }
    await assert.rejects(ensureNoLinkEscape(root, path.join(root, 'escape', 'file.txt')), /link/i);
});

test('job manager prevents conflicting jobs and permits unrelated games within its limit', async () => {
    const manager = new MaintenanceJobManager({ maxConcurrent: 2 });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const one = manager.enqueue('scan', 'one', () => gate);
    assert.throws(() => manager.enqueue('repair', 'one', async () => true), error => error.code === 'JOB_CONFLICT');
    const two = manager.enqueue('scan', 'two', () => gate);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.get(one.id).status, 'running');
    assert.equal(manager.get(two.id).status, 'running');
    release(true);
    await new Promise(resolve => setImmediate(resolve));
});

test('job manager clears completed activity without removing running work', async () => {
    const manager = new MaintenanceJobManager({ maxConcurrent: 1 });
    const completed = manager.enqueue('scan', 'done', async () => true);
    await new Promise(resolve => setTimeout(resolve, 10));
    let release;
    const active = manager.enqueue('scan', 'active', () => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.clearCompleted(), 1);
    assert.equal(manager.get(completed.id), null);
    assert.equal(manager.get(active.id).status, 'running');
    release(true);
});

test('save folder scanner returns multiple candidates from install and custom roots', async t => {
    const root = await fixture(t);
    const install = path.join(root, 'Assassins Creed Shadows');
    const custom = path.join(root, 'Publisher Data');
    await write(path.join(install, 'storage', 'saves', 'slot.dat'));
    await write(path.join(custom, 'Assassins Creed Shadows', 'profiles', 'profile.dat'));
    const candidates = await scanSaveCandidates({ gameName: 'Assassins Creed Shadows', installRoot: install, customRoots: [custom] }, { maxVisited: 500 });
    assert.ok(candidates.some(item => item.path === path.join(install, 'storage', 'saves') && item.source === 'installation'));
    assert.ok(candidates.some(item => item.path === path.join(custom, 'Assassins Creed Shadows')));
    assert.ok(candidates.length >= 2);
});

test('information findings can be hidden globally or for one game without deleting the stored report', async t => {
    const root = await fixture(t);
    const serviceRoot = await fixture(t);
    await write(path.join(root, 'ExampleGame.exe'), 'exe');
    const service = new MaintenanceService({ baseDir: serviceRoot, version: '5.2.0', homeDir: os.homedir() });
    const currentGame = game(root);
    const scanned = service.startScan(currentGame, {});
    assert.equal((await waitForJob(service, scanned.id)).status, 'completed');
    assert.ok((await service.gameDetails(currentGame)).report.issues.some(item => item.severity === 'information'));
    assert.equal((await service.gameDetails(currentGame, { hideInformationIssues: true })).report.issues.some(item => item.severity === 'information'), false);
    assert.ok((await service.loadReport(currentGame.id)).issues.some(item => item.severity === 'information'));
});

test('diagnostic redaction removes secrets, credentials, and personal home paths', () => {
    const home = path.join('C:', 'Users', 'Player');
    const redacted = redactValue({ apiKey: 'abc', nested: { cookie: 'cookie', path: path.join(home, 'Games'), note: 'Bearer abc.def' } }, '', home);
    assert.equal(redacted.apiKey, '[REDACTED]');
    assert.equal(redacted.nested.cookie, '[REDACTED]');
    assert.match(redacted.nested.path, /%USERPROFILE%/);
    assert.equal(redacted.nested.note, 'Bearer [REDACTED]');
});
