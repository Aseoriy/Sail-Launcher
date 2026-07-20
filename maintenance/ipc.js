'use strict';

const path = require('path');
const { MaintenanceService } = require('./service');

function registerMaintenanceIpc({ app, ipcMain, BrowserWindow, dialog, shell, findExecutable }) {
    const service = new MaintenanceService({
        baseDir: path.join(app.getPath('userData'), 'maintenance'),
        version: app.getVersion(),
        findExecutable,
        onJobEvent: job => {
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) win.webContents.send('maintenance-job', job);
            }
        }
    });

    ipcMain.handle('maintenance-dashboard', (_event, payload) => Array.isArray(payload) ? service.dashboard(payload) : service.dashboard(payload.games, payload.settings));
    ipcMain.handle('maintenance-game-details', (_event, payload) => payload && payload.game ? service.gameDetails(payload.game, payload.settings) : service.gameDetails(payload));
    ipcMain.handle('maintenance-clear-activity', () => service.clearActivity());
    ipcMain.handle('maintenance-start-baseline', (_event, { game, settings, creationMethod }) => service.startBaseline(game, settings, creationMethod));
    ipcMain.handle('maintenance-start-scan', (_event, { game, settings, deep }) => service.startScan(game, settings, !!deep));
    ipcMain.handle('maintenance-scan-all', (_event, { games, settings }) => {
        service.configure(settings);
        const jobs = [];
        for (const game of games || []) {
            try { jobs.push(service.startScan(game, settings, false)); }
            catch (error) { jobs.push({ gameId: String(game.id), status: 'rejected', error: { code: error.code, message: error.message } }); }
        }
        return jobs;
    });
    ipcMain.handle('maintenance-cancel-job', (_event, jobId) => service.jobs.cancel(jobId));
    ipcMain.handle('maintenance-cancel-all', () => { service.jobs.cancelAll(); return true; });
    ipcMain.handle('maintenance-list-jobs', (_event, options) => service.jobs.list(options));
    ipcMain.handle('maintenance-quick-repair', (_event, { game, settings, options }) => service.startQuickRepair(game, settings, options));
    ipcMain.handle('maintenance-selective-repair', (_event, { game, actionIds, settings }) => service.startSelectiveRepair(game, actionIds, settings));
    ipcMain.handle('maintenance-cleanup-scan', (_event, { input, settings }) => service.startCleanupScan(input, settings));
    ipcMain.handle('maintenance-cleanup-delete', (_event, { candidates, allowedRoots }) => service.startCleanupDelete(candidates, allowedRoots));
    ipcMain.handle('maintenance-scan-save-folders', (_event, { game, input, settings }) => service.startSaveFolderScan(game, input, settings));
    ipcMain.handle('maintenance-pick-save-root', async event => {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('maintenance-create-snapshot', (_event, { game, info, plannedPaths, settings }) => service.startModificationSnapshot(game, info, plannedPaths, settings));
    ipcMain.handle('maintenance-record-external-modification', (_event, { game, info }) => service.recordExternalModification(game, info));
    ipcMain.handle('maintenance-rollback-snapshot', (_event, { game, modificationId, dryRun }) => dryRun
        ? service.repairs.rollbackModification(game, modificationId, { dryRun: true })
        : service.startRollback(game, modificationId));
    ipcMain.handle('maintenance-accept-modification', (_event, { gameId, modificationId }) => service.updateModification(gameId, modificationId, { accepted: true }));
    ipcMain.handle('maintenance-delete-snapshot', (_event, { gameId, modificationId }) => service.startSnapshotDelete(gameId, modificationId));
    ipcMain.handle('maintenance-export-diagnostic', async (event, { game }) => {
        const owner = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showSaveDialog(owner, { defaultPath: `${String(game.name || 'game').replace(/[<>:"/\\|?*]+/g, '')}-sail-diagnostic.json`, filters: [{ name: 'JSON diagnostic report', extensions: ['json'] }] });
        if (result.canceled || !result.filePath) return null;
        return service.exportDiagnostic(game, result.filePath);
    });
    ipcMain.handle('maintenance-open-installation', async (_event, game) => {
        const target = game.installFolder || (game.exePath ? path.dirname(game.exePath) : '');
        if (!target) return 'No installation folder is configured.';
        return shell.openPath(target);
    });
    ipcMain.handle('maintenance-pick-snapshot-folder', async event => {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? null : result.filePaths[0];
    });

    app.on('before-quit', () => service.stop());
    return service;
}

module.exports = { registerMaintenanceIpc };
