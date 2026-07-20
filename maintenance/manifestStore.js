'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MANIFEST_SCHEMA_VERSION } = require('./constants');
const { safeId } = require('./pathSafety');

class ManifestLoadError extends Error {
    constructor(message, code = 'MANIFEST_UNREADABLE', cause) {
        super(message);
        this.name = 'ManifestLoadError';
        this.code = code;
        this.cause = cause;
    }
}

function migrateManifest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ManifestLoadError('Manifest root must be an object.');
    }
    const manifest = JSON.parse(JSON.stringify(input));
    let version = Number.isInteger(manifest.schemaVersion) ? manifest.schemaVersion : 1;
    if (version > MANIFEST_SCHEMA_VERSION) {
        throw new ManifestLoadError(`Manifest schema ${version} is newer than this launcher supports.`, 'MANIFEST_NEWER');
    }
    if (version < 1) throw new ManifestLoadError(`Unsupported manifest schema ${version}.`);

    if (version === 1) {
        manifest.creationMethod = manifest.creationMethod || 'migrated';
        manifest.protectedPaths = Array.isArray(manifest.protectedPaths) ? manifest.protectedPaths : [];
        manifest.mutablePaths = Array.isArray(manifest.mutablePaths) ? manifest.mutablePaths : [];
        manifest.modifications = Array.isArray(manifest.modifications) ? manifest.modifications : [];
        manifest.scan = manifest.scan || {};
        version = 2;
    }
    manifest.schemaVersion = version;
    manifest.files = Array.isArray(manifest.files) ? manifest.files : [];
    manifest.protectedPaths = Array.isArray(manifest.protectedPaths) ? manifest.protectedPaths : [];
    manifest.mutablePaths = Array.isArray(manifest.mutablePaths) ? manifest.mutablePaths : [];
    manifest.modifications = Array.isArray(manifest.modifications) ? manifest.modifications : [];
    return manifest;
}

class ManifestStore {
    constructor(baseDir) {
        this.baseDir = path.resolve(baseDir);
        this.manifestsDir = path.join(this.baseDir, 'manifests');
    }

    manifestPath(gameId) {
        return path.join(this.manifestsDir, `${safeId(gameId)}.json`);
    }

    async exists(gameId) {
        try { await fs.promises.access(this.manifestPath(gameId)); return true; } catch (_) { return false; }
    }

    async load(gameId) {
        const target = this.manifestPath(gameId);
        let raw;
        try { raw = await fs.promises.readFile(target, 'utf8'); }
        catch (error) {
            if (error.code === 'ENOENT') return null;
            throw new ManifestLoadError(`Unable to read manifest: ${error.message}`, 'MANIFEST_UNREADABLE', error);
        }
        try { return migrateManifest(JSON.parse(raw)); }
        catch (error) {
            if (error instanceof ManifestLoadError) throw error;
            throw new ManifestLoadError(`Manifest JSON is invalid: ${error.message}`, 'MANIFEST_UNREADABLE', error);
        }
    }

    async save(manifest, options = {}) {
        const migrated = migrateManifest(manifest);
        if (!migrated.gameId) throw new Error('Manifest gameId is required.');
        const target = this.manifestPath(migrated.gameId);
        await fs.promises.mkdir(this.manifestsDir, { recursive: true });

        if (await this.exists(migrated.gameId)) {
            // Refuse to turn a transient access/parse failure into a destructive reset.
            if (!options.allowUnreadableOverwrite) await this.load(migrated.gameId);
            await fs.promises.copyFile(target, `${target}.bak`);
        }

        const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        let handle;
        try {
            handle = await fs.promises.open(temp, 'wx');
            await handle.writeFile(JSON.stringify(migrated, null, 2), 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            try {
                await fs.promises.rename(temp, target);
            } catch (error) {
                if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
                const displaced = `${target}.replace-${crypto.randomUUID()}`;
                await fs.promises.rename(target, displaced);
                try { await fs.promises.rename(temp, target); }
                catch (renameError) {
                    await fs.promises.rename(displaced, target).catch(() => {});
                    throw renameError;
                }
                await fs.promises.rm(displaced, { force: true });
            }
            return migrated;
        } finally {
            if (handle) await handle.close().catch(() => {});
            await fs.promises.rm(temp, { force: true }).catch(() => {});
        }
    }

    async update(gameId, updater) {
        const current = await this.load(gameId);
        if (!current) throw new ManifestLoadError('Manifest does not exist.', 'MANIFEST_MISSING');
        const updated = await updater(JSON.parse(JSON.stringify(current)));
        return this.save(updated || current);
    }

    async list() {
        await fs.promises.mkdir(this.manifestsDir, { recursive: true });
        const entries = await fs.promises.readdir(this.manifestsDir, { withFileTypes: true });
        const results = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            const gameId = entry.name.slice(0, -5);
            try { results.push({ gameId, manifest: await this.load(gameId) }); }
            catch (error) { results.push({ gameId, error: { code: error.code, message: error.message } }); }
        }
        return results;
    }
}

module.exports = { ManifestLoadError, ManifestStore, migrateManifest };
