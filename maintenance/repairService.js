'use strict';

const fs = require('fs');
const path = require('path');
const { IssueCode } = require('./constants');
const { resolveWithin } = require('./pathSafety');
const { installRootForGame, throwIfCancelled } = require('./scanner');

class RepairService {
    constructor({ scanner, manifestStore, snapshotService }) {
        this.scanner = scanner;
        this.manifestStore = manifestStore;
        this.snapshotService = snapshotService;
    }

    async rebuildBaseline(game, options = {}) {
        const manifest = await this.scanner.createBaseline(game, Object.assign({}, options, { creationMethod: options.creationMethod || 'rebuilt-baseline' }));
        await this.manifestStore.save(manifest);
        return manifest;
    }

    async quickRepair(game, options = {}) {
        let manifest = await this.manifestStore.load(game.id).catch(error => {
            if (error.code === 'MANIFEST_UNREADABLE') throw error;
            return null;
        });
        const scan = await this.scanner.scan(game, manifest, options);
        const actions = [];
        const gamePatch = {};
        const movedExe = scan.issues.find(item => item.code === IssueCode.EXECUTABLE_MOVED && item.discoveredPath);
        if (movedExe) {
            gamePatch.exePath = movedExe.discoveredPath;
            actions.push({ action: 'update-executable', success: true, path: movedExe.discoveredPath });
            game = Object.assign({}, game, gamePatch);
        }
        if (!manifest) {
            manifest = await this.rebuildBaseline(game, Object.assign({}, options, { creationMethod: 'repair-generated' }));
            actions.push({ action: 'create-baseline', success: true });
        } else if (scan.issues.some(item => item.code === IssueCode.INSTALL_MOVED)) {
            manifest.installRoot = installRootForGame(game);
            if (gamePatch.exePath) manifest.executablePath = path.relative(manifest.installRoot, gamePatch.exePath).replace(/\\/g, '/');
            manifest.repairHistory = manifest.repairHistory || [];
            manifest.repairHistory.push({ at: new Date().toISOString(), action: 'accept-install-location' });
            await this.manifestStore.save(manifest);
            actions.push({ action: 'accept-install-location', success: true });
        }
        if (options.removeSafeTemporaryFiles) {
            const cleanup = await this.removeKnownSafeTemporaryFiles(game, scan.issues, options);
            actions.push({ action: 'remove-safe-temporary', success: cleanup.failed.length === 0, result: cleanup });
        }
        const validation = await this.scanner.scan(game, manifest, options);
        return { gamePatch, actions, validation };
    }

    async removeKnownSafeTemporaryFiles(game, issues, options = {}) {
        const root = installRootForGame(game);
        const removable = (issues || []).filter(item => item.path && [IssueCode.FAILED_DOWNLOAD_FRAGMENT].includes(item.code));
        const removed = [];
        const failed = [];
        for (const item of removable) {
            throwIfCancelled(options.signal);
            try {
                const target = resolveWithin(root, item.path);
                if (!/\.(aria2|partial|crdownload)$/i.test(target)) throw new Error('File is not in the known-safe cleanup allowlist.');
                const stat = await fs.promises.lstat(target);
                if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe file type.');
                await fs.promises.rm(target, { force: true });
                removed.push(item.path);
            } catch (error) { failed.push({ path: item.path, error: error.message }); }
        }
        return { removed, failed };
    }

    async selectiveRepair(game, actionIds, options = {}) {
        const allowed = new Set(['update-executable', 'create-baseline', 'rebuild-manifest', 'accept-change', 'remove-safe-temporary']);
        const requested = Array.from(new Set(actionIds || []));
        if (requested.some(action => !allowed.has(action))) throw new Error('Unsupported repair action requested.');
        let manifest = await this.manifestStore.load(game.id);
        const scan = await this.scanner.scan(game, manifest, options);
        const result = { gamePatch: {}, actions: [] };
        if (requested.includes('update-executable')) {
            const found = scan.issues.find(item => item.code === IssueCode.EXECUTABLE_MOVED && item.discoveredPath);
            if (found) { result.gamePatch.exePath = found.discoveredPath; result.actions.push({ action: 'update-executable', success: true }); }
        }
        if (requested.includes('create-baseline') || requested.includes('rebuild-manifest') || requested.includes('accept-change')) {
            const nextGame = Object.assign({}, game, result.gamePatch);
            manifest = await this.rebuildBaseline(nextGame, Object.assign({}, options, { creationMethod: requested.includes('accept-change') ? 'accepted-changes' : 'rebuilt-baseline' }));
            result.actions.push({ action: 'rebuild-manifest', success: true });
        }
        if (requested.includes('remove-safe-temporary')) {
            const cleanup = await this.removeKnownSafeTemporaryFiles(game, scan.issues, options);
            result.actions.push({ action: 'remove-safe-temporary', success: cleanup.failed.length === 0, result: cleanup });
        }
        result.validation = await this.scanner.scan(Object.assign({}, game, result.gamePatch), manifest, options);
        return result;
    }

    async rollbackModification(game, modificationId, options = {}) {
        const manifest = await this.manifestStore.load(game.id);
        const record = manifest && (manifest.modifications || []).find(item => item.id === modificationId);
        if (!record) throw new Error('Modification snapshot not found.');
        const impact = await this.snapshotService.rollback(game, record, options);
        if (!options.dryRun) await this.manifestStore.save(manifest);
        return impact;
    }
}

module.exports = { RepairService };
