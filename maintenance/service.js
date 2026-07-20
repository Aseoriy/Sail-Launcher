'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_SETTINGS, IssueCode, Severity } = require('./constants');
const { CleanupService } = require('./cleanupService');
const { DependencyService } = require('./dependencyService');
const { DiagnosticService } = require('./diagnosticService');
const { MaintenanceJobManager } = require('./jobManager');
const { ManifestLoadError, ManifestStore } = require('./manifestStore');
const { RepairService } = require('./repairService');
const { MaintenanceScanner, summarizeIssues } = require('./scanner');
const { SnapshotService } = require('./snapshotService');
const { scanSaveCandidates } = require('./saveScanner');
const { safeId } = require('./pathSafety');

async function atomicJsonWrite(destination, value) {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const temp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
        await fs.promises.rename(temp, destination);
    } finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
}

class MaintenanceService {
    constructor(options) {
        this.baseDir = path.resolve(options.baseDir);
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        this.manifests = new ManifestStore(this.baseDir);
        this.dependencies = new DependencyService(options);
        this.scanner = new MaintenanceScanner({ findExecutable: options.findExecutable, dependencyService: this.dependencies });
        this.snapshots = new SnapshotService(this.baseDir);
        this.cleanup = new CleanupService(this.baseDir);
        this.diagnostics = new DiagnosticService({ version: options.version, homeDir: options.homeDir });
        this.repairs = new RepairService({ scanner: this.scanner, manifestStore: this.manifests, snapshotService: this.snapshots });
        this.jobs = new MaintenanceJobManager({ maxConcurrent: this.settings.maxConcurrentScans, onEvent: options.onJobEvent });
        this.reportsDir = path.join(this.baseDir, 'reports');
        this.auditPath = path.join(this.baseDir, 'destructive-actions.jsonl');
    }

    configure(settings = {}) {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
        this.jobs.setMaxConcurrent(this.settings.maxConcurrentScans);
        const desiredSnapshotRoot = this.settings.snapshotLocation
            ? path.join(path.resolve(this.settings.snapshotLocation), 'Sail Maintenance')
            : this.baseDir;
        if (this.snapshots.baseDir !== desiredSnapshotRoot) {
            this.snapshots = new SnapshotService(desiredSnapshotRoot);
            this.repairs.snapshotService = this.snapshots;
        }
        return this.settings;
    }

    reportPath(gameId) { return path.join(this.reportsDir, `${safeId(gameId)}.json`); }

    async loadReport(gameId) {
        try { return JSON.parse(await fs.promises.readFile(this.reportPath(gameId), 'utf8')); } catch (_) { return null; }
    }

    async saveReport(report) {
        await atomicJsonWrite(this.reportPath(report.gameId), report);
        return report;
    }

    async audit(action, details = {}) {
        await fs.promises.mkdir(path.dirname(this.auditPath), { recursive: true });
        await fs.promises.appendFile(this.auditPath, `${JSON.stringify({ at: new Date().toISOString(), action, details })}\n`, 'utf8');
    }

    async loadManifestState(gameId) {
        try {
            const manifest = await this.manifests.load(gameId);
            return { status: manifest ? 'ready' : 'missing', manifest };
        } catch (error) {
            return { status: 'unreadable', manifest: null, error: { code: error.code || 'MANIFEST_UNREADABLE', message: error.message } };
        }
    }

    startBaseline(game, settings = {}, creationMethod = 'manual-baseline') {
        const configured = this.configure(settings);
        return this.jobs.enqueue('baseline', game.id, async ({ signal, progress }) => {
            const manifest = await this.scanner.createBaseline(game, {
                signal,
                onProgress: progress,
                ignorePatterns: configured.ignorePatterns,
                hashImportantFiles: configured.hashImportantFiles,
                creationMethod
            });
            await this.manifests.save(manifest);
            const report = await this.scanner.scan(game, manifest, { signal, onProgress: progress, verificationLevel: configured.verificationLevel, hashImportantFiles: configured.hashImportantFiles, ignorePatterns: configured.ignorePatterns });
            await this.saveReport(report);
            return { manifest: { schemaVersion: manifest.schemaVersion, gameId: manifest.gameId, lastScannedAt: manifest.lastScannedAt }, report };
        }, { title: game.name });
    }

    startScan(game, settings = {}, deep = false) {
        const configured = this.configure(settings);
        return this.jobs.enqueue(deep ? 'deep-scan' : 'quick-scan', game.id, async ({ signal, progress }) => {
            const manifestState = await this.loadManifestState(game.id);
            let report;
            if (manifestState.status === 'unreadable') {
                const unreadableIssue = { code: IssueCode.MANIFEST_UNREADABLE, severity: Severity.ERROR, message: 'The installation manifest is unreadable and was not overwritten.', details: manifestState.error.message, repairActions: ['export-diagnostics', 'rebuild-manifest-after-confirmation'] };
                report = await this.scanner.scan(game, null, { signal, onProgress: progress, deep, verificationLevel: configured.verificationLevel, hashImportantFiles: configured.hashImportantFiles, ignorePatterns: configured.ignorePatterns });
                report.issues.unshift(unreadableIssue);
                report.summary = summarizeIssues(report.issues);
                report.manifestStatus = 'unreadable';
            } else {
                report = await this.scanner.scan(game, manifestState.manifest, { signal, onProgress: progress, deep, verificationLevel: configured.verificationLevel, hashImportantFiles: configured.hashImportantFiles, ignorePatterns: configured.ignorePatterns });
                report.manifestStatus = manifestState.status;
                if (manifestState.manifest) {
                    manifestState.manifest.lastScannedAt = report.completedAt;
                    manifestState.manifest.scan = Object.assign({}, manifestState.manifest.scan, { lastSummary: report.summary });
                    await this.manifests.save(manifestState.manifest);
                }
            }
            if (configured.autoCleanSafeTemporaryFiles && manifestState.status !== 'unreadable') {
                const cleanup = await this.repairs.removeKnownSafeTemporaryFiles(game, report.issues, { signal });
                if (cleanup.removed.length) {
                    await this.audit('automatic-safe-temporary-files-removed', { gameId: String(game.id), paths: cleanup.removed });
                    report = await this.scanner.scan(game, manifestState.manifest, { signal, onProgress: progress, deep, verificationLevel: configured.verificationLevel, hashImportantFiles: configured.hashImportantFiles, ignorePatterns: configured.ignorePatterns });
                    report.manifestStatus = manifestState.status;
                    report.automaticCleanup = cleanup;
                }
            }
            await this.saveReport(report);
            return report;
        }, { title: game.name });
    }

    startQuickRepair(game, settings = {}, options = {}) {
        const configured = this.configure(settings);
        return this.jobs.enqueue('quick-repair', game.id, async ({ signal, progress }) => {
            const result = await this.repairs.quickRepair(game, {
                signal, onProgress: progress,
                ignorePatterns: configured.ignorePatterns,
                hashImportantFiles: configured.hashImportantFiles,
                verificationLevel: configured.verificationLevel,
                removeSafeTemporaryFiles: options.removeSafeTemporaryFiles !== false
            });
            const removed = result.actions.flatMap(item => item.result && item.result.removed || []);
            if (removed.length) await this.audit('quick-repair-temporary-files-removed', { gameId: String(game.id), paths: removed });
            await this.saveReport(result.validation);
            return result;
        }, { title: game.name });
    }

    startSelectiveRepair(game, actionIds, settings = {}) {
        const configured = this.configure(settings);
        return this.jobs.enqueue('selective-repair', game.id, async ({ signal, progress }) => {
            const result = await this.repairs.selectiveRepair(game, actionIds, { signal, onProgress: progress, ignorePatterns: configured.ignorePatterns, hashImportantFiles: configured.hashImportantFiles, verificationLevel: configured.verificationLevel });
            const removed = result.actions.flatMap(item => item.result && item.result.removed || []);
            if (removed.length) await this.audit('selective-repair-temporary-files-removed', { gameId: String(game.id), paths: removed });
            await this.saveReport(result.validation);
            return result;
        }, { title: game.name, actions: actionIds });
    }

    startCleanupScan(input, settings = {}) {
        this.configure(settings);
        return this.jobs.enqueue('cleanup-scan', null, async ({ signal, progress }) => this.cleanup.scan(input, { signal, onProgress: progress }), { title: 'Storage cleanup' });
    }

    startCleanupDelete(candidates, allowedRoots) {
        return this.jobs.enqueue('cleanup-delete', null, async ({ signal, progress }) => {
            const result = await this.cleanup.remove(candidates, allowedRoots, { signal, onProgress: progress });
            if (result.removed.length) await this.audit('storage-cleanup-files-removed', { files: result.removed, reclaimedBytes: result.reclaimedBytes });
            return result;
        }, { title: 'Storage cleanup' });
    }

    startSaveFolderScan(game, input = {}, settings = {}) {
        this.configure(settings);
        const installRoot = game.installFolder || (game.exePath ? path.dirname(game.exePath) : '');
        const customRoots = Array.from(new Set([...(settings.saveScanCustomDirectories || []), ...(game.saveScanDirectories || []), ...(input.customRoots || [])].filter(Boolean)));
        return this.jobs.enqueue('save-folder-scan', game.id, ({ signal, progress }) => scanSaveCandidates({
            gameName: game.name,
            installRoot,
            includeInstallRoot: settings.saveScanIncludeInstallRoot !== false,
            customRoots
        }, { signal, onProgress: progress }), { title: `${game.name} save folders` });
    }

    async gameDetails(game, settings = {}) {
        const manifestState = await this.loadManifestState(game.id);
        const sourceManifest = manifestState.manifest;
        const manifest = sourceManifest ? Object.assign({}, sourceManifest, {
            files: undefined,
            fileCount: Array.isArray(sourceManifest.files) ? sourceManifest.files.length : 0,
            trackedBytes: (sourceManifest.files || []).reduce((sum, item) => sum + (Number(item.size) || 0), 0)
        }) : null;
        const sourceReport = await this.loadReport(game.id);
        const hideInformation = !!(settings.hideInformationIssues || game.maintenanceHideInformationIssues);
        const report = sourceReport && hideInformation ? Object.assign({}, sourceReport, {
            issues: (sourceReport.issues || []).filter(item => item.severity !== Severity.INFORMATION),
            summary: summarizeIssues((sourceReport.issues || []).filter(item => item.severity !== Severity.INFORMATION))
        }) : sourceReport;
        return {
            gameId: String(game.id),
            manifestStatus: manifestState.status,
            manifest,
            manifestError: manifestState.error || null,
            report,
            informationIssuesHidden: hideInformation,
            activeJob: this.jobs.list({ includeCompleted: false }).find(job => job.gameId === String(game.id)) || null
        };
    }

    async dashboard(games, settings = {}) {
        const items = [];
        const recentActivity = [];
        for (const game of games || []) {
            const details = await this.gameDetails(game, settings);
            const report = details.report;
            items.push({
                gameId: String(game.id), name: game.name, cover: game.steamImageUrl || game.customBannerPath || game.iconData || '',
                manifestStatus: details.manifestStatus,
                health: report ? report.summary.status : (details.manifestStatus === 'ready' ? Severity.INFORMATION : Severity.WARNING),
                issueCount: report ? report.summary.issueCount : 0,
                lastScanAt: report ? report.completedAt : null,
                reclaimableBytes: report ? report.reclaimableBytes || 0 : 0,
                brokenLaunchPath: !!(report && report.issues.some(item => [IssueCode.EXECUTABLE_MISSING, IssueCode.EXECUTABLE_INVALID, IssueCode.EXECUTABLE_MOVED].includes(item.code))),
                saveUnavailable: !!(report && report.issues.some(item => [IssueCode.SAVE_FOLDER_MISSING, IssueCode.SAVE_FOLDER_INACCESSIBLE].includes(item.code))),
                changedOutsideSail: !!(report && report.issues.some(item => [IssueCode.INSTALL_MOVED, IssueCode.MANIFEST_FILE_CHANGED, IssueCode.HASH_MISMATCH, IssueCode.MODIFICATION_CONFLICT].includes(item.code))),
                activeJob: details.activeJob
            });
            if (report && report.completedAt) recentActivity.push({ type: 'scan', gameId: String(game.id), gameName: game.name, at: report.completedAt, detail: `${report.summary.issueCount} issue(s) · ${report.summary.status}` });
            for (const repair of (details.manifest && details.manifest.repairHistory) || []) recentActivity.push({ type: 'repair', gameId: String(game.id), gameName: game.name, at: repair.at, detail: repair.action || 'Repair completed' });
            for (const mod of (details.manifest && details.manifest.modifications) || []) recentActivity.push({ type: 'snapshot', gameId: String(game.id), gameName: game.name, at: mod.installedAt, detail: `${mod.displayName || 'Modification'} · ${mod.managed || 'partial'}` });
        }
        const attention = items.filter(item => ['warning', 'error', 'critical'].includes(item.health));
        return {
            generatedAt: new Date().toISOString(),
            overallHealth: items.some(item => item.health === Severity.CRITICAL) ? Severity.CRITICAL : items.some(item => item.health === Severity.ERROR) ? Severity.ERROR : attention.length ? Severity.WARNING : Severity.HEALTHY,
            totalGames: items.length,
            attentionCount: attention.length,
            brokenLaunchPaths: items.filter(item => item.brokenLaunchPath).length,
            missingManifests: items.filter(item => item.manifestStatus !== 'ready').length,
            changedOutsideSail: items.filter(item => item.changedOutsideSail).length,
            saveUnavailable: items.filter(item => item.saveUnavailable).length,
            reclaimableBytes: items.reduce((sum, item) => sum + item.reclaimableBytes, 0),
            games: items,
            recentActivity: recentActivity.filter(item => item.at && (!settings.activityClearedAt || new Date(item.at).getTime() > new Date(settings.activityClearedAt).getTime())).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12),
            jobs: this.jobs.list()
        };
    }

    clearActivity() {
        return { clearedJobs: this.jobs.clearCompleted(), clearedAt: new Date().toISOString() };
    }

    async createModificationSnapshot(game, info, plannedPaths, options = {}) {
        const record = await this.snapshots.create(game, info, plannedPaths, options);
        const manifest = await this.manifests.update(game.id, manifest => {
            manifest.modifications = manifest.modifications || [];
            manifest.modifications.push(record);
            return manifest;
        });
        const active = (manifest.modifications || []).filter(item => item.snapshotLocation && !item.snapshotDeletedAt).sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)));
        const retention = Math.max(1, Number(this.settings.snapshotRetentionCount) || DEFAULT_SETTINGS.snapshotRetentionCount);
        const limitBytes = Math.max(1, Number(this.settings.snapshotStorageLimitGb) || DEFAULT_SETTINGS.snapshotStorageLimitGb) * 1024 ** 3;
        let retainedBytes = 0;
        for (let index = 0; index < active.length; index++) {
            const item = active[index];
            retainedBytes += Number(item.backupBytes) || 0;
            if (index < retention && retainedBytes <= limitBytes) continue;
            try {
                await this.snapshots.remove(item);
                await this.audit('snapshot-retention-delete', { gameId: String(game.id), modificationId: item.id, snapshotLocation: item.snapshotLocation });
            } catch (error) {
                item.snapshotRetentionError = { at: new Date().toISOString(), message: error.message };
                continue;
            }
            item.snapshotLocation = '';
            item.restoreCapability = 'none';
            item.snapshotDeletedAt = new Date().toISOString();
            item.snapshotRetentionReason = index >= retention ? 'retention-count' : 'storage-limit';
        }
        await this.manifests.save(manifest);
        return record;
    }

    startModificationSnapshot(game, info, plannedPaths, settings = {}) {
        this.configure(settings);
        return this.jobs.enqueue('snapshot-create', game.id, ({ signal, progress }) =>
            this.createModificationSnapshot(game, info, plannedPaths, { signal, onProgress: progress }),
        { title: game.name, modification: info && info.displayName });
    }

    startRollback(game, modificationId) {
        return this.jobs.enqueue('snapshot-rollback', game.id, async ({ signal, progress }) => {
            const result = await this.repairs.rollbackModification(game, modificationId, { signal, onProgress: progress });
            await this.audit('modification-snapshot-rollback', { gameId: String(game.id), modificationId, impact: result });
            return result;
        },
        { title: game.name, modificationId });
    }

    startSnapshotDelete(gameId, modificationId) {
        return this.jobs.enqueue('snapshot-delete', gameId, async ({ progress }) => {
            const manifest = await this.manifests.load(gameId);
            const record = manifest && (manifest.modifications || []).find(item => item.id === modificationId);
            if (!record || !record.snapshotLocation) throw new Error('Restorable snapshot not found.');
            progress({ phase: 'deleting-snapshot', currentFile: record.displayName || modificationId });
            await this.snapshots.remove(record);
            await this.audit('modification-snapshot-delete', { gameId: String(gameId), modificationId, snapshotLocation: record.snapshotLocation });
            record.snapshotLocation = '';
            record.restoreCapability = 'none';
            record.snapshotDeletedAt = new Date().toISOString();
            await this.manifests.save(manifest);
            return { deleted: true, modificationId };
        }, { title: 'Delete modification snapshot', modificationId });
    }

    async recordExternalModification(game, info) {
        const record = {
            id: crypto.randomUUID(), gameId: String(game.id), displayName: info.displayName || 'External modification',
            source: info.source || 'external', installedAt: new Date().toISOString(), filesAdded: [], filesReplaced: [],
            snapshotLocation: '', restoreCapability: 'none', managed: 'partial', externalPath: info.externalPath || '',
            note: info.note || 'Sail did not apply files to the installation, so rollback is not available.'
        };
        await this.manifests.update(game.id, manifest => { manifest.modifications = manifest.modifications || []; manifest.modifications.push(record); return manifest; });
        return record;
    }

    async updateModification(gameId, modificationId, patch) {
        return this.manifests.update(gameId, manifest => {
            const record = (manifest.modifications || []).find(item => item.id === modificationId);
            if (!record) throw new Error('Modification record not found.');
            if (patch.accepted) record.acceptedAt = new Date().toISOString();
            return manifest;
        });
    }

    async exportDiagnostic(game, destination) {
        const manifestState = await this.loadManifestState(game.id);
        const manifest = manifestState.manifest;
        const report = this.diagnostics.build({ game, manifest, scan: await this.loadReport(game.id), repairAttempts: (manifest && manifest.repairHistory) || [], logs: [] });
        await this.diagnostics.write(report, destination);
        return destination;
    }

    stop() { this.jobs.cancelAll(); }
}

module.exports = { MaintenanceService, atomicJsonWrite };
