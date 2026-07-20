'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveWithin, safeId } = require('./pathSafety');
const { throwIfCancelled } = require('./scanner');

async function copyFileSafe(source, destination) {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.copyFile(source, destination);
}

class SnapshotService {
    constructor(baseDir) {
        this.baseDir = path.resolve(baseDir);
    }

    snapshotRoot(gameId, snapshotId) {
        return path.join(this.baseDir, 'snapshots', safeId(gameId), safeId(snapshotId));
    }

    async create(game, info = {}, plannedPaths = [], options = {}) {
        if (!game || !game.id) throw new Error('A game is required.');
        const configuredRoot = game.installFolder || (game.exePath ? path.dirname(game.exePath) : '');
        if (!configuredRoot) throw new Error('A safe installation root is required.');
        const installRoot = path.resolve(configuredRoot);
        if (!installRoot || installRoot === path.parse(installRoot).root) throw new Error('A safe installation root is required.');
        const id = crypto.randomUUID();
        const root = this.snapshotRoot(game.id, id);
        const filesRoot = path.join(root, 'files');
        const filesAdded = [];
        const filesReplaced = [];
        const skipped = [];
        let backupBytes = 0;

        for (const requested of Array.from(new Set(plannedPaths.map(item => typeof item === 'string' ? item : item.path)))) {
            throwIfCancelled(options.signal);
            let source;
            try { source = resolveWithin(installRoot, requested); }
            catch (error) { skipped.push({ path: requested, reason: error.message }); continue; }
            let stat;
            try { stat = await fs.promises.lstat(source); }
            catch (error) {
                if (error.code === 'ENOENT') { filesAdded.push(requested.replace(/\\/g, '/')); continue; }
                skipped.push({ path: requested, reason: error.message }); continue;
            }
            if (stat.isSymbolicLink() || !stat.isFile()) { skipped.push({ path: requested, reason: 'Only regular files are snapshot-managed.' }); continue; }
            const relative = requested.replace(/\\/g, '/');
            await copyFileSafe(source, resolveWithin(filesRoot, relative));
            filesReplaced.push(relative);
            backupBytes += stat.size;
            if (options.onProgress) options.onProgress({ phase: 'snapshot', currentFile: relative, processedBytes: backupBytes });
        }

        const record = {
            id,
            gameId: String(game.id),
            displayName: info.displayName || 'Modification snapshot',
            source: info.source || 'manual',
            installedAt: new Date().toISOString(),
            filesAdded,
            filesReplaced,
            snapshotLocation: root,
            storageRoot: this.baseDir,
            restoreCapability: skipped.length ? 'partial' : 'full',
            managed: skipped.length ? 'partial' : (info.managed || 'full'),
            parentId: info.parentId || null,
            dependencies: info.dependencies || [],
            skipped,
            backupBytes
        };
        await fs.promises.mkdir(root, { recursive: true });
        await fs.promises.writeFile(path.join(root, 'snapshot.json'), JSON.stringify(record, null, 2), 'utf8');
        return record;
    }

    async rollback(game, record, options = {}) {
        const configuredRoot = game.installFolder || (game.exePath ? path.dirname(game.exePath) : '');
        if (!configuredRoot) throw new Error('A safe installation root is required.');
        const installRoot = path.resolve(configuredRoot);
        const impact = { restoreFiles: (record.filesReplaced || []).length, removeFiles: (record.filesAdded || []).length, restoreBytes: record.backupBytes || 0 };
        if (options.dryRun) return impact;
        const filesRoot = path.join(record.snapshotLocation, 'files');
        for (const relative of record.filesReplaced || []) {
            throwIfCancelled(options.signal);
            const source = resolveWithin(filesRoot, relative);
            const destination = resolveWithin(installRoot, relative);
            const stat = await fs.promises.lstat(source);
            if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe snapshot entry: ${relative}`);
            await copyFileSafe(source, destination);
            if (options.onProgress) options.onProgress({ phase: 'restoring', currentFile: relative });
        }
        for (const relative of record.filesAdded || []) {
            throwIfCancelled(options.signal);
            const target = resolveWithin(installRoot, relative);
            let stat;
            try { stat = await fs.promises.lstat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
            await fs.promises.rm(target, { force: true });
            if (options.onProgress) options.onProgress({ phase: 'removing-added-files', currentFile: relative });
        }
        record.rolledBackAt = new Date().toISOString();
        return impact;
    }

    async remove(record) {
        const storageRoot = record.storageRoot ? path.resolve(record.storageRoot) : this.baseDir;
        const expected = path.join(storageRoot, 'snapshots', safeId(record.gameId), safeId(record.id));
        if (path.resolve(record.snapshotLocation) !== expected) throw new Error('Snapshot path validation failed.');
        await fs.promises.rm(expected, { recursive: true, force: true });
        return true;
    }
}

module.exports = { SnapshotService };
