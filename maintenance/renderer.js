(function () {
    'use strict';

    const ipc = require('electron').ipcRenderer;
    // Renderer scripts execute in the index.html CommonJS context, so local
    // modules resolve from the application root rather than this file's folder.
    const { normalizeSettings } = require('./maintenance/settings');
    const DEFAULTS = {
        automaticHealthChecks: true,
        scanOnStartup: false,
        scanAfterInstall: true,
        scanAfterModInstall: true,
        maxConcurrentScans: 2,
        verificationLevel: 'metadata',
        hashImportantFiles: true,
        snapshotRetentionCount: 5,
        snapshotStorageLimitGb: 10,
        snapshotLocation: '',
        autoCleanSafeTemporaryFiles: false,
        notifyWhenUnhealthy: true,
        hideInformationIssues: false,
        activityClearedAt: null,
        saveScanIncludeInstallRoot: true,
        saveScanCustomDirectories: [],
        ignorePatterns: []
    };
    const healthIcons = { healthy: '✓', information: 'ⓘ', warning: '⚠', error: '!', critical: '✕' };
    const jobs = new Map();
    const waiters = new Map();
    let dashboardRefresh = null;
    let initialized = false;
    let lastCleanupResult = null;
    const automaticChecksStarted = new Set();

    function html(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function settings() {
        const current = normalizeSettings(globalSettings.maintenance, DEFAULTS);
        if (globalSettings.maintenance !== current) globalSettings.maintenance = current;
        if (!Array.isArray(current.ignorePatterns)) current.ignorePatterns = [];
        if (!Array.isArray(current.saveScanCustomDirectories)) current.saveScanCustomDirectories = [];
        return current;
    }

    function saveSettings() {
        saveToMemory();
    }

    function bytes(value) {
        const amount = Number(value) || 0;
        if (amount < 1024) return `${amount} B`;
        if (amount < 1024 ** 2) return `${(amount / 1024).toFixed(1)} KB`;
        if (amount < 1024 ** 3) return `${(amount / 1024 ** 2).toFixed(1)} MB`;
        return `${(amount / 1024 ** 3).toFixed(2)} GB`;
    }

    function date(value) {
        if (!value) return 'Never';
        try { return new Date(value).toLocaleString(); } catch (_) { return String(value); }
    }

    function healthBadge(status) {
        const safe = status || 'information';
        return `<span class="maintenance-health" data-health="${html(safe)}">${healthIcons[safe] || 'ⓘ'} ${html(safe.charAt(0).toUpperCase() + safe.slice(1))}</span>`;
    }

    function gameById(gameId) {
        return myGames.find(game => String(game.id) === String(gameId));
    }

    function activeJobs() {
        return Array.from(jobs.values()).filter(job => ['queued', 'running', 'cancelling'].includes(job.status));
    }

    function waitForJob(jobId) {
        const existing = jobs.get(jobId);
        if (existing && ['completed', 'failed', 'cancelled'].includes(existing.status)) {
            return existing.status === 'completed' ? Promise.resolve(existing.result) : Promise.reject(new Error(existing.error ? existing.error.message : `Job ${existing.status}`));
        }
        return new Promise((resolve, reject) => waiters.set(jobId, { resolve, reject }));
    }
    window.maintenanceWaitForJob = waitForJob;

    function applyJobResult(job) {
        if (!job || !job.result || !job.gameId) return;
        const patch = job.result.gamePatch;
        if (patch && typeof patch === 'object') {
            const game = gameById(job.gameId);
            if (game) {
                Object.assign(game, patch);
                saveToMemory();
                try { renderGames(); } catch (_) {}
            }
        }
        if (job.type === 'cleanup-scan' && job.result.candidates) {
            lastCleanupResult = job.result;
            openCleanupPreview(job.result);
        }
        const scan = job.result.validation || job.result.report || (job.result.summary ? job.result : null);
        if (scan && scan.summary && settings().notifyWhenUnhealthy && ['error', 'critical'].includes(scan.summary.status)) {
            const game = gameById(job.gameId);
            try { new Notification('Game maintenance needed', { body: `${game ? game.name : 'A game'} has ${scan.summary.issueCount} maintenance issue(s).` }); } catch (_) {}
        }
    }

    ipc.on('maintenance-job', (_event, job) => {
        jobs.set(job.id, job);
        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
            applyJobResult(job);
            const waiter = waiters.get(job.id);
            if (waiter) {
                waiters.delete(job.id);
                if (job.status === 'completed') waiter.resolve(job.result);
                else waiter.reject(new Error(job.error ? job.error.message : `Job ${job.status}`));
            }
            clearTimeout(dashboardRefresh);
            dashboardRefresh = setTimeout(() => {
                if (currentTabName === 'maintenance') renderMaintenanceCenter();
                if (viewingGameIndex !== null) renderGameMaintenancePanel(myGames[viewingGameIndex]);
            }, 180);
        }
        renderMaintenanceJobs();
    });

    window.renderMaintenanceJobs = function () {
        const host = document.getElementById('maintenanceJobs');
        if (!host) return;
        const all = Array.from(jobs.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 12);
        if (!all.length) { host.innerHTML = '<div style="opacity:.55;font-size:12px;">No maintenance jobs yet.</div>'; return; }
        host.innerHTML = all.map(job => {
            const game = gameById(job.gameId);
            return `<div class="maintenance-job-row">
                <div class="maintenance-job-body">
                    <div class="maintenance-job-title">${html(game ? game.name : job.metadata && job.metadata.title || job.type)} · ${html(job.status)}</div>
                    <div class="maintenance-job-detail">${html(job.phase || '')}${job.currentFile ? ` · ${html(job.currentFile)}` : ''}</div>
                    <div class="maintenance-progress"><span style="width:${Number(job.percent) || 0}%"></span></div>
                </div>
                ${['queued', 'running', 'cancelling'].includes(job.status) ? `<button class="outline" onclick="maintenanceCancelJob('${html(job.id)}')" aria-label="Cancel maintenance job">Cancel</button>` : ''}
            </div>`;
        }).join('');
    };

    window.renderMaintenanceCenter = async function () {
        const host = document.getElementById('maintenanceGameList');
        if (!host) return;
        host.innerHTML = '<div style="opacity:.6;padding:20px;">Loading library health…</div>';
        try {
            const data = await ipc.invoke('maintenance-dashboard', { games: myGames, settings: settings() });
            document.getElementById('maintenanceOverall').innerHTML = healthBadge(data.overallHealth);
            document.getElementById('maintStatAttention').textContent = data.attentionCount;
            document.getElementById('maintStatBroken').textContent = data.brokenLaunchPaths;
            document.getElementById('maintStatManifests').textContent = data.missingManifests;
            document.getElementById('maintStatChanged').textContent = data.changedOutsideSail;
            document.getElementById('maintStatSaves').textContent = data.saveUnavailable;
            document.getElementById('maintStatStorage').textContent = bytes(data.reclaimableBytes);
            for (const job of data.jobs || []) jobs.set(job.id, job);
            renderMaintenanceJobs();
            const recent = document.getElementById('maintenanceRecentActivity');
            if (recent) recent.innerHTML = (data.recentActivity || []).length ? data.recentActivity.map(item => `<div class="maintenance-job-row"><div class="maintenance-job-body"><div class="maintenance-job-title">${html(item.gameName)} · ${html(item.type)}</div><div class="maintenance-job-detail">${html(date(item.at))} · ${html(item.detail)}</div></div></div>`).join('') : '<div style="opacity:.55;font-size:12px;">No scans, repairs, or modification snapshots recorded yet.</div>';
            if (!data.games.length) {
                host.innerHTML = '<div style="text-align:center;opacity:.6;padding:35px;">Add a game to begin maintenance tracking.</div>';
                return;
            }
            host.innerHTML = data.games.map(item => `<article class="maintenance-game-card">
                <div class="maintenance-game-head">
                    <img class="maintenance-game-cover" src="${html(item.cover || 'icon.ico')}" alt="" onerror="this.src='icon.ico'">
                    <div class="maintenance-game-main"><div class="maintenance-game-name">${html(item.name)}</div>
                    <div class="maintenance-game-meta">${item.issueCount} issue(s) · Last scan: ${html(date(item.lastScanAt))}<br>Manifest: ${html(item.manifestStatus)}</div></div>
                    ${healthBadge(item.health)}
                </div>
                <div class="maintenance-actions">
                    <button onclick="maintenanceQuickScan('${html(item.gameId)}')">Quick Scan</button>
                    <button class="outline" onclick="maintenanceOpenGame('${html(item.gameId)}')">Open Details</button>
                    ${item.manifestStatus !== 'ready' ? `<button class="outline" onclick="maintenanceCreateBaseline('${html(item.gameId)}')">Create Baseline</button>` : ''}
                    ${item.brokenLaunchPath ? `<button class="outline" onclick="maintenanceQuickRepair('${html(item.gameId)}')">Repair Path</button>` : ''}
                </div>
            </article>`).join('');
        } catch (error) {
            host.innerHTML = `<div style="padding:20px;">Maintenance Center could not load: ${html(error.message)}</div>`;
        }
    };

    window.maintenanceCancelJob = async function (jobId) { await ipc.invoke('maintenance-cancel-job', jobId); };
    window.maintenanceCancelAll = async function () { await ipc.invoke('maintenance-cancel-all'); };
    window.maintenanceClearActivity = async function () {
        if (!await sailConfirm('Clear completed jobs and hide all maintenance activity recorded before now? Manifests, scan results, repair history, and snapshots will remain intact.')) return;
        const result = await ipc.invoke('maintenance-clear-activity');
        settings().activityClearedAt = result.clearedAt;
        for (const [id, job] of jobs) if (!['queued', 'running', 'cancelling'].includes(job.status)) jobs.delete(id);
        saveSettings();
        renderMaintenanceJobs();
        renderMaintenanceCenter();
    };
    window.maintenanceRefresh = function () { renderMaintenanceCenter(); };
    window.maintenanceScanAll = async function () {
        if (!myGames.length) return;
        const started = await ipc.invoke('maintenance-scan-all', { games: myGames, settings: settings() });
        for (const job of started || []) if (job.id) jobs.set(job.id, job);
        renderMaintenanceJobs();
    };
    window.maintenanceQuickScan = async function (gameId, deep) {
        const game = gameById(gameId); if (!game) return;
        try {
            const job = await ipc.invoke('maintenance-start-scan', { game, settings: settings(), deep: !!deep });
            jobs.set(job.id, job); renderMaintenanceJobs();
        } catch (error) { alert(`Scan could not start: ${error.message}`); }
    };
    window.maintenanceCreateBaseline = async function (gameId, creationMethod) {
        const game = gameById(gameId); if (!game) return null;
        const details = await ipc.invoke('maintenance-game-details', { game, settings: settings() });
        if (details.manifestStatus === 'ready' && !await sailConfirm('Rebuild this baseline? The current manifest will be kept as a recoverable backup.')) return null;
        try {
            const job = await ipc.invoke('maintenance-start-baseline', { game, settings: settings(), creationMethod: creationMethod || (details.manifestStatus === 'ready' ? 'rebuilt-baseline' : 'manual-baseline') });
            jobs.set(job.id, job); renderMaintenanceJobs(); return job;
        } catch (error) { alert(`Baseline could not start: ${error.message}`); return null; }
    };
    window.maintenanceQuickRepair = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        if (!await sailConfirm('Run Quick Repair? Sail may update launcher metadata and remove only known-safe incomplete download fragments. Your saves and configuration are preserved.')) return;
        try {
            const job = await ipc.invoke('maintenance-quick-repair', { game, settings: settings(), options: { removeSafeTemporaryFiles: true } });
            jobs.set(job.id, job); renderMaintenanceJobs();
        } catch (error) { alert(`Repair could not start: ${error.message}`); }
    };
    window.maintenanceSelectiveRepair = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        const checked = Array.from(document.querySelectorAll('#gpMaintenanceIssues input[data-repair]:checked'));
        const actions = Array.from(new Set(checked.flatMap(input => String(input.dataset.repair || '').split(',').filter(Boolean))));
        if (!actions.length) { alert('Select one or more repairable findings first.'); return; }
        if (!await sailConfirm(`Run these selected safe repairs?\n\n${actions.join('\n')}`)) return;
        try {
            const job = await ipc.invoke('maintenance-selective-repair', { game, actionIds: actions, settings: settings() });
            jobs.set(job.id, job); renderMaintenanceJobs();
        } catch (error) { alert(`Selective repair could not start: ${error.message}`); }
    };
    window.maintenanceOpenGame = async function (gameId) {
        const index = myGames.findIndex(game => String(game.id) === String(gameId));
        if (index < 0) return;
        await openGamePage(index);
        setTimeout(() => document.getElementById('gpMaintenancePanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    };

    window.renderGameMaintenancePanel = async function (game) {
        const panel = document.getElementById('gpMaintenancePanel');
        if (!panel || !game) return;
        panel.style.display = 'block';
        panel.innerHTML = '<div style="opacity:.6;">Loading maintenance details…</div>';
        try {
            const details = await ipc.invoke('maintenance-game-details', { game, settings: settings() });
            const report = details.report;
            const manifest = details.manifest;
            const issues = report ? report.issues || [] : [];
            const storage = manifest ? Number(manifest.trackedBytes) || 0 : 0;
            const repairMap = { 'EXECUTABLE_MOVED': 'update-executable', 'MANIFEST_MISSING': 'create-baseline', 'FAILED_DOWNLOAD_FRAGMENT': 'remove-safe-temporary', 'MANIFEST_FILE_CHANGED': 'accept-change', 'HASH_MISMATCH': 'accept-change' };
            panel.innerHTML = `<div class="maintenance-game-head"><div class="maintenance-game-main"><h2 style="margin:0 0 4px;">Maintenance</h2><div style="font-size:12px;opacity:.62;">Verify, repair, clean, and track modifications for this installation.</div></div>${healthBadge(report ? report.summary.status : 'information')}</div>
                <div class="maintenance-detail-grid">
                    <div class="maintenance-detail-cell"><span class="maintenance-detail-label">Last scan</span>${html(date(report && report.completedAt))}</div>
                    <div class="maintenance-detail-cell"><span class="maintenance-detail-label">Manifest</span>${html(details.manifestStatus)}${manifest ? ` · schema ${manifest.schemaVersion}` : ''}</div>
                    <div class="maintenance-detail-cell"><span class="maintenance-detail-label">Installation</span><span class="maintenance-path">${html(report && report.installRoot || game.installFolder || '')}</span></div>
                    <div class="maintenance-detail-cell"><span class="maintenance-detail-label">Executable</span><span class="maintenance-path">${html(game.exePath || manifest && manifest.executablePath || 'Not configured')}</span></div>
                    <div class="maintenance-detail-cell"><span class="maintenance-detail-label">Save folder</span><span class="maintenance-path">${html(game.localSave || 'Not configured')}</span>${(game.saveScanDirectories || []).length ? `<div class="maintenance-detail-note">${game.saveScanDirectories.length} custom scan root(s)</div>` : ''}</div>
                    <div class="maintenance-detail-cell"><span class="maintenance-detail-label">Tracked storage</span>${bytes(storage)}</div>
                </div>
                <div class="maintenance-actions">
                    <button onclick="maintenanceQuickScan('${html(game.id)}')">Quick Scan</button>
                    <button class="outline" onclick="maintenanceQuickScan('${html(game.id)}', true)">Deep Scan</button>
                    <button class="outline" onclick="maintenanceCreateBaseline('${html(game.id)}')">${manifest ? 'Rebuild' : 'Create'} Baseline</button>
                    <button class="outline" onclick="maintenanceQuickRepair('${html(game.id)}')">Quick Repair</button>
                    <button class="outline" onclick="maintenanceSelectiveRepair('${html(game.id)}')">Selective Repair</button>
                    <button class="outline" onclick="maintenanceCleanGame('${html(game.id)}')">Clean Temporary Files</button>
                    <button class="outline" onclick="maintenanceOpenInstall('${html(game.id)}')">Open Installation Folder</button>
                    <button class="outline" onclick="maintenanceExportDiagnostic('${html(game.id)}')">Export Diagnostic Report</button>
                    <button class="outline" onclick="maintenancePrepareReinstall('${html(game.id)}')">Prepare Clean Reinstall</button>
                    ${settings().hideInformationIssues ? '<button class="outline" disabled title="Turn off the global Maintenance setting to manage this per game.">Info Hidden Globally</button>' : `<button class="outline" onclick="maintenanceToggleGameInformation('${html(game.id)}')">${game.maintenanceHideInformationIssues ? 'Show' : 'Hide'} Info for This Game</button>`}
                    <button class="outline" data-save-rescan="${html(game.id)}" onclick="maintenanceRescanSaves('${html(game.id)}')">Rescan Save Folders</button>
                    <button class="outline" onclick="maintenanceAddSaveScanRoot('${html(game.id)}')">Add Save Scan Directory</button>
                </div>
                <h3 style="margin:20px 0 6px;">Detected issues</h3>
                <div id="gpMaintenanceIssues">${issues.length ? issues.map(item => {
                    const repair = repairMap[item.code] || (item.repairActions || []).find(action => ['update-executable', 'create-baseline', 'remove-safe-temporary', 'accept-change'].includes(action)) || '';
                    return `<label class="maintenance-issue">${repair ? `<input type="checkbox" data-repair="${html(repair)}" aria-label="Select ${html(item.code)} for repair">` : '<span aria-hidden="true">•</span>'}<span><span class="maintenance-issue-message">${html(item.message)}</span><br><span class="maintenance-issue-code">${html(item.code)}${item.path ? ` · ${html(item.path)}` : ''}</span></span></label>`;
                }).join('') : '<div style="opacity:.6;font-size:12px;padding:10px 0;">No findings yet. Run a scan to inspect this game.</div>'}</div>
                <h3 style="margin:20px 0 6px;">Modification timeline</h3>
                <div>${manifest && manifest.modifications && manifest.modifications.length ? manifest.modifications.slice().reverse().map(mod => `<div class="maintenance-timeline-item"><strong>${html(mod.displayName)}</strong> ${mod.acceptedAt ? '<span style="opacity:.6;">· accepted</span>' : ''}<div style="font-size:11px;opacity:.62;margin-top:4px;">${html(mod.source)} · ${html(date(mod.installedAt))} · ${(mod.filesAdded || []).length} added / ${(mod.filesReplaced || []).length} replaced · ${html(mod.managed)}</div><div class="maintenance-actions">${mod.restoreCapability !== 'none' && !mod.rolledBackAt ? `<button class="outline" onclick="maintenanceRollback('${html(game.id)}','${html(mod.id)}')">Estimate / Restore</button>` : ''}${mod.snapshotLocation ? `<button class="outline" onclick="maintenanceDeleteSnapshot('${html(game.id)}','${html(mod.id)}')">Delete Snapshot</button>` : ''}${!mod.acceptedAt ? `<button class="outline" onclick="maintenanceAcceptModification('${html(game.id)}','${html(mod.id)}')">Mark Accepted</button>` : ''}</div></div>`).join('') : '<div style="opacity:.6;font-size:12px;padding:10px 0;">No Sail-managed modification snapshots yet.</div>'}</div>`;
            const stale = !report || Date.now() - new Date(report.completedAt).getTime() > 7 * 24 * 60 * 60 * 1000;
            if (settings().automaticHealthChecks && stale && !details.activeJob && !automaticChecksStarted.has(String(game.id))) {
                automaticChecksStarted.add(String(game.id));
                setTimeout(() => maintenanceQuickScan(game.id), 250);
            }
        } catch (error) {
            panel.innerHTML = `<div>Maintenance details could not load: ${html(error.message)}</div>`;
        }
    };

    window.maintenanceCleanGame = function (gameId) { maintenanceQuickRepair(gameId); };
    window.maintenanceToggleGameInformation = function (gameId) {
        const game = gameById(gameId); if (!game) return;
        game.maintenanceHideInformationIssues = !game.maintenanceHideInformationIssues;
        saveToMemory();
        renderGameMaintenancePanel(game);
        if (currentTabName === 'maintenance') renderMaintenanceCenter();
    };
    function ensureSaveCandidateModal() {
        let modal = document.getElementById('maintenanceSaveCandidateModal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'maintenanceSaveCandidateModal'; modal.className = 'modal';
        modal.innerHTML = `<div class="modal-content maintenance-save-modal"><button class="close-x" onclick="closeModal('maintenanceSaveCandidateModal')">✕</button><h2>Save Folder Candidates</h2><p class="maintenance-help-text">Sail searched common Windows locations, this game’s installation, and your custom scan directories. Choose the folder that actually contains the saves.</p><div id="maintenanceSaveCandidateList"></div></div>`;
        document.body.appendChild(modal);
        return modal;
    }
    function openSaveCandidates(game, candidates) {
        ensureSaveCandidateModal();
        const list = document.getElementById('maintenanceSaveCandidateList');
        list.innerHTML = candidates.length ? candidates.map((candidate, index) => `<button class="maintenance-save-candidate" onclick="maintenanceUseSaveCandidate('${html(game.id)}', ${index})"><strong>${html(candidate.path)}</strong><span>${html(candidate.reason)} · ${html(candidate.source)}</span></button>`).join('') : '<div class="maintenance-empty-state">No matching folders were found. Add the game folder or a publisher directory as a custom scan directory and try again.</div>';
        window.__maintenanceSaveCandidates = candidates;
        openModal('maintenanceSaveCandidateModal');
    }
    window.maintenanceUseSaveCandidate = function (gameId, index) {
        const game = gameById(gameId); const candidate = (window.__maintenanceSaveCandidates || [])[index];
        if (!game || !candidate) return;
        game.localSave = candidate.path; game.saveScanPending = false;
        saveToMemory(); closeModal('maintenanceSaveCandidateModal'); renderGameMaintenancePanel(game);
    };
    window.maintenanceRescanSaves = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        const button = Array.from(document.querySelectorAll('[data-save-rescan]')).find(item => item.dataset.saveRescan === String(gameId));
        const originalHtml = button ? button.innerHTML : '';
        if (button) {
            button.disabled = true;
            button.classList.add('save-scan-loading');
            button.setAttribute('aria-busy', 'true');
            button.innerHTML = '<span class="save-scan-spinner" aria-hidden="true"></span><span>Scanning Save Folders…</span>';
        }
        try {
            const job = await ipc.invoke('maintenance-scan-save-folders', { game, settings: settings(), input: {} });
            jobs.set(job.id, job); renderMaintenanceJobs();
            openSaveCandidates(game, await waitForJob(job.id));
        } catch (error) { alert(`Save-folder scan failed: ${error.message}`); }
        finally {
            if (button && button.isConnected) {
                button.disabled = false;
                button.classList.remove('save-scan-loading');
                button.removeAttribute('aria-busy');
                button.innerHTML = originalHtml;
            }
        }
    };
    window.maintenanceAddSaveScanRoot = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        const chosen = await ipc.invoke('maintenance-pick-save-root');
        if (!chosen) return;
        game.saveScanDirectories = Array.from(new Set([...(game.saveScanDirectories || []), chosen]));
        saveToMemory();
        maintenanceRescanSaves(gameId);
    };
    window.maintenanceOpenInstall = function (gameId) { const game = gameById(gameId); if (game) ipc.invoke('maintenance-open-installation', game); };
    window.maintenanceExportDiagnostic = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        const result = await ipc.invoke('maintenance-export-diagnostic', { game });
        if (result) alert(`Diagnostic report exported to:\n${result}`);
    };
    window.maintenanceRollback = async function (gameId, modificationId) {
        const game = gameById(gameId); if (!game) return;
        const impact = await ipc.invoke('maintenance-rollback-snapshot', { game, modificationId, dryRun: true });
        if (!await sailConfirm(`Restore ${impact.restoreFiles} file(s) and remove ${impact.removeFiles} file(s) introduced by this modification? About ${bytes(impact.restoreBytes)} will be restored. Affected save/config paths are not included unless explicitly snapshot-managed.`)) return;
        const job = await ipc.invoke('maintenance-rollback-snapshot', { game, modificationId, dryRun: false });
        jobs.set(job.id, job); renderMaintenanceJobs();
        await waitForJob(job.id);
        await renderGameMaintenancePanel(game);
    };
    window.maintenanceDeleteSnapshot = async function (gameId, modificationId) {
        if (!await sailConfirm('Permanently delete this maintenance snapshot? The modification record will remain, but rollback will no longer be available.')) return;
        const job = await ipc.invoke('maintenance-delete-snapshot', { gameId, modificationId });
        jobs.set(job.id, job); renderMaintenanceJobs();
        await waitForJob(job.id);
        const game = gameById(gameId); if (game) renderGameMaintenancePanel(game);
    };
    window.maintenanceAcceptModification = async function (gameId, modificationId) {
        await ipc.invoke('maintenance-accept-modification', { gameId, modificationId });
        const game = gameById(gameId); if (game) renderGameMaintenancePanel(game);
    };
    window.maintenancePrepareReinstall = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        if (!await sailConfirm('Prepare for a clean reinstall? Sail will create existing local save and game-folder backups using its current backup system. It will not delete or redownload anything until you explicitly continue outside this step.')) return;
        try {
            if (game.localSave) await ipc.invoke('zip-save-to-drive', game.localSave, '', game.name, settings().snapshotRetentionCount);
            if (game.exePath) await ipc.invoke('backup-game', game.exePath, game.name, settings().snapshotRetentionCount);
            alert('Preparation complete. Backups were created. Review them, then choose a replacement package from Game Downloads. Sail has not deleted the current installation.');
            switchMainTab('downloads');
        } catch (error) { alert(`Reinstall preparation failed safely: ${error.message}`); }
    };

    window.maintenanceStorageCleanup = async function () {
        const installRoots = myGames.map(game => game.installFolder || (game.exePath ? require('path').dirname(game.exePath) : '')).filter(Boolean);
        try {
            const job = await ipc.invoke('maintenance-cleanup-scan', { input: { downloadsRoot: globalSettings.dlInstallDir || '', installRoots }, settings: settings() });
            jobs.set(job.id, job); renderMaintenanceJobs();
        } catch (error) { alert(`Cleanup scan could not start: ${error.message}`); }
    };

    function ensureCleanupModal() {
        let modal = document.getElementById('maintenanceCleanupModal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'maintenanceCleanupModal'; modal.className = 'modal';
        modal.innerHTML = `<div class="modal-content" style="width:760px;max-width:92vw;"><button class="close-x" onclick="closeModal('maintenanceCleanupModal')">✕</button><h2 style="margin-top:0;">Storage Cleanup Preview</h2><p style="font-size:12px;opacity:.65;">Only clearly Sail-owned incomplete fragments are selected by default. Archives, installers, caches, and ambiguous files require your explicit selection.</p><div id="maintenanceCleanupList" class="maintenance-cleanup-list"></div><div class="maintenance-actions" style="justify-content:flex-end;"><strong id="maintenanceCleanupTotal" style="margin-right:auto;"></strong><button class="outline" onclick="closeModal('maintenanceCleanupModal')">Cancel</button><button onclick="maintenanceDeleteCleanupSelection()">Delete Selected</button></div></div>`;
        document.body.appendChild(modal);
        return modal;
    }

    function updateCleanupTotal() {
        const chosen = Array.from(document.querySelectorAll('#maintenanceCleanupList input:checked'));
        const total = chosen.reduce((sum, input) => sum + Number(input.dataset.size || 0), 0);
        const label = document.getElementById('maintenanceCleanupTotal');
        if (label) label.textContent = `${chosen.length} selected · ${bytes(total)}`;
    }

    function openCleanupPreview(result) {
        ensureCleanupModal();
        const list = document.getElementById('maintenanceCleanupList');
        list.innerHTML = result.candidates.length ? result.candidates.map((item, index) => `<label class="maintenance-cleanup-item"><input type="checkbox" data-index="${index}" data-size="${item.size}" ${item.selected ? 'checked' : ''} onchange="maintenanceCleanupSelectionChanged()"><span><strong>${html(item.category)}</strong><div class="maintenance-cleanup-path">${html(item.path)}</div><div style="font-size:11px;opacity:.62;margin-top:4px;">${html(item.reason)}</div></span><span style="text-align:right;">${bytes(item.size)}<br><span class="maintenance-risk">${html(item.risk)} risk</span></span></label>`).join('') : '<div style="padding:30px;text-align:center;opacity:.6;">No cleanup candidates found.</div>';
        updateCleanupTotal(); openModal('maintenanceCleanupModal');
    }
    window.maintenanceCleanupSelectionChanged = updateCleanupTotal;
    window.maintenanceDeleteCleanupSelection = async function () {
        if (!lastCleanupResult) return;
        const selected = Array.from(document.querySelectorAll('#maintenanceCleanupList input:checked')).map(input => lastCleanupResult.candidates[Number(input.dataset.index)]).filter(Boolean);
        if (!selected.length) return;
        const total = selected.reduce((sum, item) => sum + item.size, 0);
        if (!await sailConfirm(`Permanently delete ${selected.length} selected file(s) and reclaim about ${bytes(total)}? This cannot be undone.`)) return;
        closeModal('maintenanceCleanupModal');
        const job = await ipc.invoke('maintenance-cleanup-delete', { candidates: selected, allowedRoots: lastCleanupResult.allowedRoots });
        jobs.set(job.id, job); renderMaintenanceJobs();
    };

    window.maintenanceAfterInstall = async function (game) {
        if (!settings().scanAfterInstall) return;
        const job = await maintenanceCreateBaseline(game.id, 'post-install');
        if (job) waitForJob(job.id).catch(() => {});
    };

    window.maintenanceRecordWorkshop = async function (game, result, itemId) {
        if (!settings().scanAfterModInstall) return;
        try {
            let details = await ipc.invoke('maintenance-game-details', { game, settings: settings() });
            if (details.manifestStatus === 'missing') {
                const job = await maintenanceCreateBaseline(game.id, 'pre-mod-baseline');
                if (job) await waitForJob(job.id);
                details = await ipc.invoke('maintenance-game-details', { game, settings: settings() });
            }
            if (details.manifestStatus === 'ready') {
                await ipc.invoke('maintenance-record-external-modification', { game, info: { displayName: `Steam Workshop item ${itemId}`, source: 'steam-workshop', externalPath: result.path, note: 'SteamCMD downloaded this item outside the game directory. Sail did not apply external installer changes, so it is partially managed.' } });
                await maintenanceQuickScan(game.id);
            }
        } catch (error) { console.warn('Workshop maintenance record failed:', error); }
    };

    function wireSettings() {
        const map = {
            maintenanceAutomaticToggle: ['automaticHealthChecks', 'checked'], maintenanceStartupToggle: ['scanOnStartup', 'checked'],
            maintenanceAfterInstallToggle: ['scanAfterInstall', 'checked'], maintenanceAfterModToggle: ['scanAfterModInstall', 'checked'],
            maintenanceHashToggle: ['hashImportantFiles', 'checked'], maintenanceAutoCleanToggle: ['autoCleanSafeTemporaryFiles', 'checked'],
            maintenanceNotifyToggle: ['notifyWhenUnhealthy', 'checked'], maintenanceConcurrentInput: ['maxConcurrentScans', 'number'],
            maintenanceHideInformationToggle: ['hideInformationIssues', 'checked'],
            saveScanInstallRootToggle: ['saveScanIncludeInstallRoot', 'checked'],
            maintenanceVerificationSelect: ['verificationLevel', 'value'], maintenanceRetentionInput: ['snapshotRetentionCount', 'number'],
            maintenanceLimitInput: ['snapshotStorageLimitGb', 'number'], maintenanceSnapshotLocation: ['snapshotLocation', 'value']
        };
        const current = settings();
        for (const [id, [key, kind]] of Object.entries(map)) {
            const element = document.getElementById(id); if (!element) continue;
            if (kind === 'checked') element.checked = !!current[key];
            else element.value = current[key];
            element.addEventListener('change', () => {
                current[key] = kind === 'checked' ? element.checked : kind === 'number' ? Number(element.value) : element.value;
                saveSettings();
            });
        }
        const ignore = document.getElementById('maintenanceIgnorePatterns');
        if (ignore) {
            ignore.value = current.ignorePatterns.join('\n');
            ignore.addEventListener('change', () => { current.ignorePatterns = ignore.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean); saveSettings(); });
        }
        const saveRoots = document.getElementById('saveScanCustomDirectories');
        if (saveRoots) {
            saveRoots.value = current.saveScanCustomDirectories.join('\n');
            saveRoots.addEventListener('change', () => { current.saveScanCustomDirectories = saveRoots.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean); saveSettings(); });
        }
        const addSaveRoot = document.getElementById('addSaveScanDirectoryBtn');
        if (addSaveRoot) addSaveRoot.addEventListener('click', async () => {
            const chosen = await ipc.invoke('maintenance-pick-save-root');
            if (!chosen) return;
            current.saveScanCustomDirectories = Array.from(new Set([...current.saveScanCustomDirectories, chosen]));
            saveRoots.value = current.saveScanCustomDirectories.join('\n'); saveSettings();
        });
        const browse = document.getElementById('maintenanceBrowseSnapshots');
        if (browse) browse.addEventListener('click', async () => {
            const chosen = await ipc.invoke('maintenance-pick-snapshot-folder');
            if (chosen) { current.snapshotLocation = chosen; document.getElementById('maintenanceSnapshotLocation').value = chosen; saveSettings(); }
        });
    }

    window.maintenanceInitialize = async function () {
        if (initialized) return;
        initialized = true;
        const created = !globalSettings.maintenance;
        settings();
        if (created) saveSettings();
        wireSettings();
        const existing = await ipc.invoke('maintenance-list-jobs', {});
        for (const job of existing || []) jobs.set(job.id, job);
        renderMaintenanceJobs();
        if (settings().scanOnStartup && myGames.length) setTimeout(() => maintenanceScanAll(), 1200);
    };
})();
