'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { ManifestStore } = require('../maintenance/manifestStore');
const { MaintenanceScanner } = require('../maintenance/scanner');
const { SnapshotService } = require('../maintenance/snapshotService');

async function write(target, content = 'x') {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
}

async function main() {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sail-dry-dock-manual-'));
    const results = [];
    const scanner = new MaintenanceScanner();
    try {
        const normalRoot = path.join(workspace, 'normal');
        await write(path.join(normalRoot, 'Normal.exe'), 'normal-executable');
        await write(path.join(normalRoot, 'bin', 'engine.dll'), 'engine');
        const normalGame = { id: 'normal', name: 'Normal', installFolder: normalRoot, exePath: path.join(normalRoot, 'Normal.exe') };
        const normalManifest = await scanner.createBaseline(normalGame, { hashImportantFiles: true });
        const normalScan = await scanner.scan(normalGame, normalManifest, { deep: true });
        assert.equal(normalScan.issues.some(item => /INSTALL|EXECUTABLE|HASH_MISMATCH/.test(item.code)), false);
        results.push('normal-installed-game');

        const movedRoot = path.join(workspace, 'moved');
        await fs.promises.rename(normalRoot, movedRoot);
        const movedGame = Object.assign({}, normalGame, { installFolder: movedRoot, exePath: path.join(movedRoot, 'Normal.exe') });
        assert.ok((await scanner.scan(movedGame, normalManifest)).issues.some(item => item.code === 'INSTALL_MOVED'));
        results.push('manually-moved-game');

        await fs.promises.rename(path.join(movedRoot, 'Normal.exe'), path.join(movedRoot, 'Renamed.exe'));
        const renamed = await scanner.scan(Object.assign({}, movedGame, { exePath: path.join(movedRoot, 'Normal.exe') }), normalManifest);
        assert.ok(renamed.issues.some(item => item.code === 'EXECUTABLE_MOVED'));
        results.push('renamed-executable');

        await write(path.join(movedRoot, '.sail-temp', 'payload.tmp'));
        await write(path.join(movedRoot, 'package.r00'));
        await write(path.join(movedRoot, 'download.aria2'));
        const partial = await scanner.scan(Object.assign({}, movedGame, { exePath: path.join(movedRoot, 'Renamed.exe') }), normalManifest);
        for (const code of ['EXTRACTION_REMNANT', 'MULTIPART_ARCHIVE_LEFTOVER', 'FAILED_DOWNLOAD_FRAGMENT']) assert.ok(partial.issues.some(item => item.code === code));
        results.push('partially-extracted-archive');

        const snapshots = new SnapshotService(path.join(workspace, 'maintenance'));
        const modification = await snapshots.create(movedGame, { displayName: 'Fixture mod' }, ['bin/engine.dll', 'mods/new.dat']);
        await write(path.join(movedRoot, 'bin', 'engine.dll'), 'modified');
        await write(path.join(movedRoot, 'mods', 'new.dat'), 'new');
        await snapshots.rollback(movedGame, modification);
        assert.equal(await fs.promises.readFile(path.join(movedRoot, 'bin', 'engine.dll'), 'utf8'), 'engine');
        assert.equal(fs.existsSync(path.join(movedRoot, 'mods', 'new.dat')), false);
        results.push('mod-replace-and-add-rollback');

        const missingSave = await scanner.scan(Object.assign({}, movedGame, { exePath: path.join(movedRoot, 'Renamed.exe'), localSave: path.join(workspace, 'missing-save') }), null);
        assert.ok(missingSave.issues.some(item => item.code === 'SAVE_FOLDER_MISSING'));
        results.push('missing-save-directory');

        const lockedPath = path.join(movedRoot, 'bin', 'locked.dll');
        await write(lockedPath, 'locked');
        const lockedManifest = await scanner.createBaseline(Object.assign({}, movedGame, { exePath: path.join(movedRoot, 'Renamed.exe') }), { hashImportantFiles: true });
        const originalCreateReadStream = fs.createReadStream;
        fs.createReadStream = function (target, options) {
            if (path.resolve(target) !== path.resolve(lockedPath)) return originalCreateReadStream.call(fs, target, options);
            const stream = new PassThrough();
            process.nextTick(() => stream.destroy(Object.assign(new Error('File is locked by another process.'), { code: 'EBUSY' })));
            return stream;
        };
        try {
            const lockedScan = await scanner.scan(Object.assign({}, movedGame, { exePath: path.join(movedRoot, 'Renamed.exe') }), lockedManifest, { deep: true });
            assert.ok(lockedScan.issues.some(item => item.code === 'FILE_INACCESSIBLE' && item.path === 'bin/locked.dll'));
        } finally { fs.createReadStream = originalCreateReadStream; }
        results.push('locked-file-graceful-handling');

        const largeRoot = path.join(workspace, 'large');
        await write(path.join(largeRoot, 'Large.exe'), 'exe');
        for (let index = 0; index < 1200; index++) await write(path.join(largeRoot, 'data', `${index}.bin`), String(index));
        const largeGame = { id: 'large', name: 'Large', installFolder: largeRoot, exePath: path.join(largeRoot, 'Large.exe') };
        const largeManifest = await scanner.createBaseline(largeGame);
        assert.equal(largeManifest.files.length, 1201);
        results.push('very-large-directory');

        const controller = new AbortController();
        await assert.rejects(scanner.createBaseline(largeGame, { signal: controller.signal, onProgress: update => { if (update.processedFiles > 25) controller.abort(); } }), error => error.code === 'CANCELLED');
        results.push('mid-scan-cancellation');

        const storeRoot = path.join(workspace, 'restart-state');
        const firstStore = new ManifestStore(storeRoot);
        await firstStore.save(largeManifest);
        const secondStore = new ManifestStore(storeRoot);
        assert.equal((await secondStore.load('large')).files.length, 1201);
        results.push('launcher-restart-persistence');

        console.log(JSON.stringify({ status: 'PASS', scenarios: results }, null, 2));
    } finally {
        await fs.promises.rm(workspace, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
