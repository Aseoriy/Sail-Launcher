'use strict';

const path = require('path');
const { MaintenanceService } = require('./service');

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SETTINGS_KEYS = new Set([
    'automaticHealthChecks', 'scanOnStartup', 'scanAfterInstall', 'scanAfterModInstall',
    'maxConcurrentScans', 'verificationLevel', 'hashImportantFiles',
    'snapshotRetentionCount', 'snapshotStorageLimitGb', 'autoCleanSafeTemporaryFiles',
    'notifyWhenUnhealthy', 'hideInformationIssues', 'activityClearedAt',
    'saveScanIncludeInstallRoot', 'ignorePatterns'
]);

function exactObject(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    for (const key of Object.keys(value)) {
        if (PROTOTYPE_KEYS.has(key) || !allowed.has(key)) throw new Error(`${label}.${key} is not allowed.`);
    }
    return value;
}

function boundedId(value, label) {
    const text = String(value || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throw new Error(`${label} is invalid.`);
    return text;
}

function boundedText(value, max, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return fallback;
    return text;
}

function sanitizeSettings(value) {
    const input = value === undefined ? {} : exactObject(value, SETTINGS_KEYS, 'Maintenance settings');
    const output = {};
    for (const key of [
        'automaticHealthChecks', 'scanOnStartup', 'scanAfterInstall', 'scanAfterModInstall',
        'hashImportantFiles', 'autoCleanSafeTemporaryFiles', 'notifyWhenUnhealthy',
        'hideInformationIssues', 'saveScanIncludeInstallRoot'
    ]) if (input[key] !== undefined) output[key] = input[key] === true;
    if (input.maxConcurrentScans !== undefined) output.maxConcurrentScans = Math.max(1, Math.min(8, Number(input.maxConcurrentScans) || 1));
    if (input.snapshotRetentionCount !== undefined) output.snapshotRetentionCount = Math.max(1, Math.min(50, Number(input.snapshotRetentionCount) || 5));
    if (input.snapshotStorageLimitGb !== undefined) output.snapshotStorageLimitGb = Math.max(1, Math.min(1000, Number(input.snapshotStorageLimitGb) || 10));
    if (input.verificationLevel !== undefined) output.verificationLevel = ['metadata', 'important', 'full'].includes(input.verificationLevel) ? input.verificationLevel : 'metadata';
    if (input.activityClearedAt !== undefined) output.activityClearedAt = typeof input.activityClearedAt === 'string' && Number.isFinite(Date.parse(input.activityClearedAt)) ? new Date(input.activityClearedAt).toISOString() : null;
    if (input.ignorePatterns !== undefined) {
        if (!Array.isArray(input.ignorePatterns) || input.ignorePatterns.length > 128) throw new Error('Maintenance ignore patterns are invalid.');
        output.ignorePatterns = input.ignorePatterns.map(value => boundedText(value, 160)).filter(value => value && !value.includes('..') && !/[\\/:]/.test(value));
    }
    output.saveScanCustomDirectories = [];
    output.snapshotLocation = '';
    return output;
}

function sanitizeModificationInfo(value) {
    const input = exactObject(value || {}, new Set(['displayName', 'source', 'note']), 'Maintenance modification');
    return {
        displayName: boundedText(input.displayName, 160, 'External modification'),
        source: boundedText(input.source, 80, 'external'),
        note: boundedText(input.note, 1000, 'Sail did not apply files to the installation, so rollback is not available.')
    };
}

function sanitizeRelativePaths(value) {
    if (!Array.isArray(value) || value.length > 4096) throw new Error('Maintenance snapshot paths are invalid.');
    return value.map((item, index) => {
        const text = boundedText(item, 1024);
        if (!text || path.isAbsolute(text) || text.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
            throw new Error(`Maintenance snapshot path ${index} is invalid.`);
        }
        return text;
    });
}

function sanitizeJob(job) {
    if (!job) return job;
    const clone = JSON.parse(JSON.stringify(job));
    clone.currentFile = clone.currentFile ? path.basename(String(clone.currentFile)).slice(0, 512) : '';
    if (!clone.result) return clone;
    if (clone.result && typeof clone.result === 'object') delete clone.result.gamePatch;
    if (clone.type === 'cleanup-scan' && clone.result) {
        clone.result = {
            scannedAt: clone.result.scannedAt,
            totalBytes: clone.result.totalBytes,
            selectedBytes: clone.result.selectedBytes,
            candidates: (clone.result.candidates || []).map(candidate => ({
                id: candidate.id,
                relativePath: String(candidate.relativePath || path.basename(candidate.path || '')).slice(0, 1024),
                size: candidate.size,
                modifiedAt: candidate.modifiedAt,
                source: candidate.source,
                category: candidate.category,
                reason: candidate.reason,
                risk: candidate.risk,
                selected: candidate.selected
            }))
        };
    } else if (clone.type === 'cleanup-delete' && clone.result) {
        clone.result.removed = (clone.result.removed || []).map(item => ({ size: item.size, category: item.category }));
        clone.result.failed = (clone.result.failed || []).map(item => ({ error: item.error }));
    } else if (clone.type === 'save-folder-scan' && Array.isArray(clone.result)) {
        clone.result = clone.result.slice(0, 256).map(candidate => ({
            label: path.basename(String(candidate.path || '')) || 'Candidate folder',
            source: boundedText(candidate.source, 80, 'local-scan'),
            score: Number(candidate.score) || 0,
            reason: boundedText(candidate.reason, 512, 'Possible local save folder'),
            modifiedAt: candidate.modifiedAt
        }));
    }
    return clone;
}

function registerMaintenanceIpc({ app, ipcMain, BrowserWindow, dialog, shell, findExecutable, authorizeIpcEvent, profileStore }) {
    if (typeof authorizeIpcEvent !== 'function') throw new TypeError('Maintenance IPC requires sender authorization.');
    if (!profileStore) throw new TypeError('Maintenance IPC requires the main-owned profile authority store.');
    const service = new MaintenanceService({
        baseDir: path.join(app.getPath('userData'), 'maintenance'),
        version: app.getVersion(),
        findExecutable,
        onJobEvent: job => {
            const publicJob = sanitizeJob(job);
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) win.webContents.send('maintenance-job', publicJob);
            }
        }
    });
    let enabled = false;
    const handle = (channel, handler, requiresEnabled = true) => ipcMain.handle(channel, (event, ...args) => {
        authorizeIpcEvent(event, channel);
        if (requiresEnabled && !enabled) {
            const error = new Error('Maintenance Center is disabled in Settings.');
            error.code = 'MAINTENANCE_DISABLED';
            throw error;
        }
        return handler(event, ...args);
    });

    const resolveGame = (payload, operation) => {
        const metadata = profileStore.activeGameMetadata(payload.gameId);
        const resolved = profileStore.resolveExecutionCapability({
            gameId: payload.gameId,
            capabilityId: payload.capabilityId,
            expectedRevision: payload.expectedRevision,
            operation
        });
        return {
            ...metadata,
            exePath: resolved.details.executablePath || '',
            installFolder: resolved.details.workingDirectory || '',
            companionApp: resolved.details.companionPath || ''
        };
    };
    const publicGame = gameId => profileStore.activeGameMetadata(gameId);
    const settingsFor = payload => {
        const settings = sanitizeSettings(payload.settings);
        if (payload.archiveCapabilityId !== undefined || payload.archiveExpectedRevision !== undefined) {
            if (typeof payload.archiveCapabilityId !== 'string' || !Number.isSafeInteger(payload.archiveExpectedRevision)) throw new Error('Maintenance archive root reference is invalid.');
            const archive = profileStore.resolveDeviceRootCapability({
                kind: 'archive-root', capabilityId: payload.archiveCapabilityId,
                expectedRevision: payload.archiveExpectedRevision
            });
            settings.snapshotLocation = archive.details.rootPath;
        }
        return settings;
    };
    const commonKeys = ['gameId', 'capabilityId', 'expectedRevision', 'settings', 'archiveCapabilityId', 'archiveExpectedRevision'];

    handle('maintenance-set-enabled', (_event, value) => {
        enabled = value !== false;
        if (!enabled) service.stop();
        return { enabled };
    }, false);
    handle('maintenance-dashboard', (_event, payload) => {
        const input = exactObject(payload, new Set(['gameIds', 'settings']), 'Maintenance dashboard');
        if (!Array.isArray(input.gameIds) || input.gameIds.length > 5000) throw new Error('Maintenance game list is invalid.');
        return service.dashboard(input.gameIds.map(gameId => publicGame(boundedId(gameId, 'gameId'))), sanitizeSettings(input.settings));
    });
    handle('maintenance-game-details', (_event, payload) => {
        const input = exactObject(payload, new Set(['gameId', 'settings']), 'Maintenance game details');
        return service.gameDetails(publicGame(boundedId(input.gameId, 'gameId')), sanitizeSettings(input.settings));
    });
    handle('maintenance-clear-activity', () => service.clearActivity());
    handle('maintenance-start-baseline', (_event, payload) => {
        const input = exactObject(payload, new Set([...commonKeys, 'creationMethod']), 'Maintenance baseline');
        return service.startBaseline(resolveGame(input, 'maintenance-write'), settingsFor(input), boundedText(input.creationMethod, 80, 'manual-baseline'));
    });
    handle('maintenance-start-scan', (_event, payload) => {
        const input = exactObject(payload, new Set([...commonKeys, 'deep']), 'Maintenance scan');
        return service.startScan(resolveGame(input, 'maintenance-read'), settingsFor(input), input.deep === true);
    });
    handle('maintenance-scan-all', (_event, payload) => {
        const input = exactObject(payload, new Set(['games', 'settings', 'archiveCapabilityId', 'archiveExpectedRevision']), 'Maintenance scan all');
        if (!Array.isArray(input.games) || input.games.length > 5000) throw new Error('Maintenance scan list is invalid.');
        const settings = settingsFor(input);
        service.configure(settings);
        return input.games.map(row => {
            try {
                const reference = exactObject(row, new Set(['gameId', 'capabilityId', 'expectedRevision']), 'Maintenance scan reference');
                const game = resolveGame(reference, 'maintenance-read');
                return service.startScan(game, settings, false);
            } catch (error) {
                return { gameId: String(row && row.gameId || ''), status: 'rejected', error: { code: error.code, message: error.message } };
            }
        });
    });
    handle('maintenance-cancel-job', (_event, jobId) => service.jobs.cancel(boundedId(jobId, 'jobId')));
    handle('maintenance-cancel-all', () => { service.jobs.cancelAll(); return true; });
    handle('maintenance-list-jobs', (_event, options) => {
        const input = exactObject(options || {}, new Set(['includeCompleted']), 'Maintenance job list');
        return service.jobs.list({ includeCompleted: input.includeCompleted !== false }).map(sanitizeJob);
    });
    handle('maintenance-quick-repair', (_event, payload) => {
        const input = exactObject(payload, new Set([...commonKeys, 'options']), 'Maintenance quick repair');
        const options = exactObject(input.options || {}, new Set(['removeSafeTemporaryFiles']), 'Maintenance repair options');
        return service.startQuickRepair(resolveGame(input, 'maintenance-write'), settingsFor(input), { removeSafeTemporaryFiles: options.removeSafeTemporaryFiles !== false });
    });
    handle('maintenance-selective-repair', (_event, payload) => {
        const input = exactObject(payload, new Set([...commonKeys, 'actionIds']), 'Maintenance selective repair');
        if (!Array.isArray(input.actionIds) || input.actionIds.length > 32) throw new Error('Maintenance repair actions are invalid.');
        const actions = input.actionIds.map(value => boundedId(value, 'actionId'));
        return service.startSelectiveRepair(resolveGame(input, 'maintenance-write'), actions, settingsFor(input));
    });
    handle('maintenance-cleanup-scan', (_event, payload) => {
        const input = exactObject(payload, new Set(['settings', 'rootCapabilityId', 'rootExpectedRevision', 'games']), 'Maintenance cleanup scan');
        let downloadsRoot = '';
        if (input.rootCapabilityId !== undefined || input.rootExpectedRevision !== undefined) {
            const root = profileStore.resolveDeviceRootCapability({
                kind: 'download-root', capabilityId: input.rootCapabilityId,
                expectedRevision: input.rootExpectedRevision
            });
            downloadsRoot = root.details.rootPath;
        }
        if (!Array.isArray(input.games) || input.games.length > 5000) throw new Error('Maintenance cleanup game list is invalid.');
        const installRoots = input.games.map(row => {
            const reference = exactObject(row, new Set(['gameId', 'capabilityId', 'expectedRevision']), 'Maintenance cleanup game');
            return resolveGame(reference, 'maintenance-read').installFolder;
        }).filter(Boolean);
        return service.startCleanupScan({ downloadsRoot, installRoots }, sanitizeSettings(input.settings));
    });
    handle('maintenance-cleanup-delete', (_event, payload) => {
        const input = exactObject(payload, new Set(['scanJobId', 'candidateIds']), 'Maintenance cleanup delete');
        const scan = service.jobs.get(boundedId(input.scanJobId, 'scanJobId'));
        if (!scan || scan.type !== 'cleanup-scan' || scan.status !== 'completed' || !scan.result) throw new Error('The cleanup scan is stale or unavailable.');
        if (!Array.isArray(input.candidateIds) || !input.candidateIds.length || input.candidateIds.length > 10000) throw new Error('Cleanup selection is invalid.');
        const ids = new Set(input.candidateIds.map(value => boundedId(value, 'candidateId')));
        const candidates = (scan.result.candidates || []).filter(candidate => ids.has(candidate.id));
        if (candidates.length !== ids.size) throw new Error('Cleanup selection does not match the completed scan.');
        return service.startCleanupDelete(candidates, scan.result.allowedRoots || []);
    });
    handle('maintenance-scan-save-folders', (_event, payload) => {
        const input = exactObject(payload, new Set(commonKeys), 'Maintenance save scan');
        return service.startSaveFolderScan(resolveGame(input, 'save-scan'), {}, settingsFor(input));
    });
    handle('maintenance-pick-save-root', async (event, payload) => {
        const input = exactObject(payload, new Set(['gameId']), 'Maintenance save approval');
        const gameId = boundedId(input.gameId, 'gameId');
        publicGame(gameId);
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths[0]) return { canceled: true };
        const capability = profileStore.createFilesystemCapability(gameId, 'save', result.filePaths[0], '');
        return { canceled: false, capability, label: path.basename(result.filePaths[0]) || 'Selected folder' };
    });
    handle('maintenance-create-snapshot', (_event, payload) => {
        const input = exactObject(payload, new Set([...commonKeys, 'info', 'plannedPaths']), 'Maintenance snapshot');
        const game = resolveGame(input, 'maintenance-write');
        if (!game.installFolder) throw new Error('A locally approved installation folder is required.');
        const plannedPaths = sanitizeRelativePaths(input.plannedPaths).map(relative => path.join(game.installFolder, relative));
        return service.startModificationSnapshot(game, sanitizeModificationInfo(input.info), plannedPaths, settingsFor(input));
    });
    handle('maintenance-record-external-modification', (_event, payload) => {
        const input = exactObject(payload, new Set(['gameId', 'info']), 'Maintenance modification record');
        return service.recordExternalModification(publicGame(boundedId(input.gameId, 'gameId')), sanitizeModificationInfo(input.info));
    });
    handle('maintenance-rollback-snapshot', (_event, payload) => {
        const input = exactObject(payload, new Set([...commonKeys, 'modificationId', 'dryRun']), 'Maintenance rollback');
        const game = resolveGame(input, 'maintenance-write');
        const modificationId = boundedId(input.modificationId, 'modificationId');
        return input.dryRun === true
            ? service.repairs.rollbackModification(game, modificationId, { dryRun: true })
            : service.startRollback(game, modificationId);
    });
    handle('maintenance-accept-modification', (_event, payload) => {
        const input = exactObject(payload, new Set(['gameId', 'modificationId']), 'Maintenance modification acceptance');
        publicGame(boundedId(input.gameId, 'gameId'));
        return service.updateModification(input.gameId, boundedId(input.modificationId, 'modificationId'), { accepted: true });
    });
    handle('maintenance-delete-snapshot', (_event, payload) => {
        const input = exactObject(payload, new Set(['gameId', 'capabilityId', 'expectedRevision', 'modificationId']), 'Maintenance snapshot delete');
        resolveGame(input, 'maintenance-write');
        return service.startSnapshotDelete(input.gameId, boundedId(input.modificationId, 'modificationId'));
    });
    handle('maintenance-export-diagnostic', async (event, payload) => {
        const input = exactObject(payload, new Set(['gameId', 'capabilityId', 'expectedRevision']), 'Maintenance diagnostic export');
        const game = resolveGame(input, 'maintenance-read');
        const owner = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showSaveDialog(owner, { defaultPath: `${String(game.name || 'game').replace(/[<>:"/\\|?*]+/g, '')}-sail-diagnostic.json`, filters: [{ name: 'JSON diagnostic report', extensions: ['json'] }] });
        if (result.canceled || !result.filePath) return { canceled: true };
        await service.exportDiagnostic(game, result.filePath);
        return { canceled: false, label: path.basename(result.filePath) };
    });
    handle('maintenance-open-installation', async (_event, payload) => {
        const input = exactObject(payload, new Set(['gameId', 'capabilityId', 'expectedRevision']), 'Maintenance open installation');
        const game = resolveGame(input, 'reveal');
        if (!game.installFolder) return 'No installation folder is configured.';
        return shell.openPath(game.installFolder);
    });
    handle('maintenance-pick-snapshot-folder', async event => {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openDirectory', 'createDirectory'] });
        if (result.canceled || !result.filePaths[0]) return { canceled: true };
        const capability = profileStore.createDeviceRootCapability('archive-root', result.filePaths[0]);
        return { canceled: false, capability, label: path.basename(result.filePaths[0]) || 'Selected folder' };
    });

    app.on('before-quit', () => service.stop());
    return service;
}

module.exports = { registerMaintenanceIpc, sanitizeJob, sanitizeSettings };
