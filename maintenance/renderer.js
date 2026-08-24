(function () {
    'use strict';

    const ipc = require('electron').ipcRenderer;
    // Renderer scripts execute in the index.html CommonJS context, so local
    // modules resolve from the application root rather than this file's folder.
    const { normalizeSettings } = require('./maintenance/settings');
    const SafeDom = require('./ui/safeDom');
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
    let lastCleanupJobId = '';
    const automaticChecksStarted = new Set();

    function maintenanceEnabled() {
        return globalSettings.maintenanceEnabled === true;
    }

    function maintenanceGamePageEnabled() {
        return maintenanceEnabled() && globalSettings.maintenanceGamePageEnabled !== false;
    }

    function settings() {
        const current = normalizeSettings(globalSettings.maintenance, DEFAULTS);
        if (globalSettings.maintenance !== current) globalSettings.maintenance = current;
        if (!Array.isArray(current.ignorePatterns)) current.ignorePatterns = [];
        // Local roots are held by main-owned capabilities. Legacy renderer values
        // remain readable for migration, but are never sent back to privileged IPC.
        current.saveScanCustomDirectories = [];
        current.snapshotLocation = '';
        return current;
    }

    function portableMaintenanceSettings() {
        const current = settings();
        return {
            automaticHealthChecks: current.automaticHealthChecks === true,
            scanOnStartup: current.scanOnStartup === true,
            scanAfterInstall: current.scanAfterInstall === true,
            scanAfterModInstall: current.scanAfterModInstall === true,
            maxConcurrentScans: Number(current.maxConcurrentScans),
            verificationLevel: current.verificationLevel,
            hashImportantFiles: current.hashImportantFiles === true,
            snapshotRetentionCount: Number(current.snapshotRetentionCount),
            snapshotStorageLimitGb: Number(current.snapshotStorageLimitGb),
            autoCleanSafeTemporaryFiles: current.autoCleanSafeTemporaryFiles === true,
            notifyWhenUnhealthy: current.notifyWhenUnhealthy === true,
            hideInformationIssues: current.hideInformationIssues === true,
            activityClearedAt: current.activityClearedAt || null,
            saveScanIncludeInstallRoot: current.saveScanIncludeInstallRoot === true,
            ignorePatterns: current.ignorePatterns.slice(0, 128)
        };
    }

    async function archiveRootReference() {
        const status = await ipc.invoke('authority-get-device-root-status', { kind: 'archive-root' });
        if (!status || status.state !== 'active' || !status.capabilityId || !status.operations.includes('archive-write')) return {};
        return { archiveCapabilityId: status.capabilityId, archiveExpectedRevision: status.revision };
    }

    async function maintenanceGamePayload(game, operation, extra = {}, includeArchive = true) {
        const reference = await executionAuthorityReference(game, operation);
        return {
            gameId: String(game.id),
            capabilityId: reference.capabilityId,
            expectedRevision: reference.expectedRevision,
            settings: portableMaintenanceSettings(),
            ...(includeArchive ? await archiveRootReference() : {}),
            ...extra
        };
    }

    async function maintenanceGameReference(game, operation) {
        const reference = await executionAuthorityReference(game, operation);
        return {
            gameId: String(game.id),
            capabilityId: reference.capabilityId,
            expectedRevision: reference.expectedRevision
        };
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

    function healthBadgeElement(status) {
        const safe = Object.prototype.hasOwnProperty.call(healthIcons, status) ? status : 'information';
        const badge = SafeDom.element(document, 'span', {
            className: 'maintenance-health',
            text: `${healthIcons[safe]} ${safe.charAt(0).toUpperCase() + safe.slice(1)}`
        });
        badge.dataset.health = safe;
        return badge;
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
        if (!job || !job.result) return;
        if (job.type === 'cleanup-scan' && job.result.candidates) {
            lastCleanupResult = job.result;
            lastCleanupJobId = String(job.id || '');
            openCleanupPreview(job.result);
        }
        if (!job.gameId) return;
        const scan = job.result.validation || job.result.report || (job.result.summary ? job.result : null);
        if (scan && scan.summary && settings().notifyWhenUnhealthy && ['error', 'critical'].includes(scan.summary.status)) {
            const game = gameById(job.gameId);
            try { new Notification('Game maintenance needed', { body: `${game ? game.name : 'A game'} has ${scan.summary.issueCount} maintenance issue(s).` }); } catch (_) {}
        }
    }

    ipc.on('maintenance-job', (_event, job) => {
        if (!maintenanceEnabled()) return;
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
        if (!all.length) { host.replaceChildren(SafeDom.element(document, 'div', { text: 'No maintenance jobs yet.' })); return; }
        host.replaceChildren(...all.map(job => {
            const game = gameById(job.gameId);
            const fill = SafeDom.element(document, 'span');
            fill.style.width = `${Math.max(0, Math.min(100, Number(job.percent) || 0))}%`;
            const body = SafeDom.element(document, 'div', { className: 'maintenance-job-body' }, [
                SafeDom.element(document, 'div', { className: 'maintenance-job-title', text: `${String(game ? game.name : job.metadata && job.metadata.title || job.type).slice(0, 256)} · ${String(job.status || '').slice(0, 64)}` }),
                SafeDom.element(document, 'div', { className: 'maintenance-job-detail', text: `${String(job.phase || '').slice(0, 256)}${job.currentFile ? ` · ${String(job.currentFile).slice(0, 32767)}` : ''}` }),
                SafeDom.element(document, 'div', { className: 'maintenance-progress' }, [fill])
            ]);
            const row = SafeDom.element(document, 'div', { className: 'maintenance-job-row' }, [body]);
            if (['queued', 'running', 'cancelling'].includes(job.status)) {
                const cancel = SafeDom.element(document, 'button', { className: 'outline', text: 'Cancel', ariaLabel: 'Cancel maintenance job' });
                cancel.addEventListener('click', () => maintenanceCancelJob(String(job.id || '')));
                row.append(cancel);
            }
            return row;
        }));
    };

    window.renderMaintenanceCenter = async function () {
        const host = document.getElementById('maintenanceGameList');
        if (!host) return;
        if (!maintenanceEnabled()) {
            host.replaceChildren(SafeDom.element(document, 'div', { text: 'Maintenance Center is disabled in Settings.' }));
            return;
        }
        host.replaceChildren(SafeDom.element(document, 'div', { text: 'Loading library health…' }));
        try {
            const data = await ipc.invoke('maintenance-dashboard', {
                gameIds: myGames.map(game => String(game.id)),
                settings: portableMaintenanceSettings()
            });
            document.getElementById('maintenanceOverall').replaceChildren(healthBadgeElement(data.overallHealth));
            document.getElementById('maintStatAttention').textContent = data.attentionCount;
            document.getElementById('maintStatBroken').textContent = data.brokenLaunchPaths;
            document.getElementById('maintStatManifests').textContent = data.missingManifests;
            document.getElementById('maintStatChanged').textContent = data.changedOutsideSail;
            document.getElementById('maintStatSaves').textContent = data.saveUnavailable;
            document.getElementById('maintStatStorage').textContent = bytes(data.reclaimableBytes);
            for (const job of data.jobs || []) jobs.set(job.id, job);
            renderMaintenanceJobs();
            const recent = document.getElementById('maintenanceRecentActivity');
            if (recent) recent.replaceChildren(...((data.recentActivity || []).length ? data.recentActivity.slice(0, 100).map(item => SafeDom.element(document, 'div', { className: 'maintenance-job-row' }, [
                SafeDom.element(document, 'div', { className: 'maintenance-job-body' }, [
                    SafeDom.element(document, 'div', { className: 'maintenance-job-title', text: `${String(item.gameName || '').slice(0, 256)} · ${String(item.type || '').slice(0, 128)}` }),
                    SafeDom.element(document, 'div', { className: 'maintenance-job-detail', text: `${date(item.at)} · ${String(item.detail || '').slice(0, 4096)}` })
                ])
            ])) : [SafeDom.element(document, 'div', { text: 'No scans, repairs, or modification snapshots recorded yet.' })]));
            if (!data.games.length) {
                host.replaceChildren(SafeDom.element(document, 'div', { text: 'Add a game to begin maintenance tracking.' }));
                return;
            }
            host.replaceChildren(...data.games.slice(0, 10000).map(item => {
                const gameId = String(item.gameId || '').slice(0, 128);
                const cover = SafeDom.element(document, 'img', { className: 'maintenance-game-cover' });
                cover.alt = '';
                if (!SafeDom.setImageSource(cover, item.cover, { allowFile: true, allowSteam: true, allowData: true, maxDataLength: 2 * 1024 * 1024, hideInvalid: false })) cover.src = 'icon.ico';
                cover.addEventListener('error', () => { cover.onerror = null; cover.src = 'icon.ico'; }, { once: true });
                const head = SafeDom.element(document, 'div', { className: 'maintenance-game-head' }, [
                    cover,
                    SafeDom.element(document, 'div', { className: 'maintenance-game-main' }, [
                        SafeDom.element(document, 'div', { className: 'maintenance-game-name', text: String(item.name || '').slice(0, 256) }),
                        SafeDom.element(document, 'div', { className: 'maintenance-game-meta', text: `${Number(item.issueCount) || 0} issue(s) · Last scan: ${date(item.lastScanAt)} · Manifest: ${String(item.manifestStatus || '').slice(0, 64)}` })
                    ]),
                    healthBadgeElement(item.health)
                ]);
                const actions = SafeDom.element(document, 'div', { className: 'maintenance-actions' });
                const add = (label, handler, className = '') => { const button = SafeDom.element(document, 'button', { className, text: label }); button.addEventListener('click', handler); actions.append(button); };
                add('Quick Scan', () => maintenanceQuickScan(gameId));
                add('Open Details', () => maintenanceOpenGame(gameId), 'outline');
                if (item.manifestStatus !== 'ready') add('Create Baseline', () => maintenanceCreateBaseline(gameId), 'outline');
                if (item.brokenLaunchPath) add('Repair Path', () => maintenanceQuickRepair(gameId), 'outline');
                return SafeDom.element(document, 'article', { className: 'maintenance-game-card' }, [head, actions]);
            }));
        } catch (error) {
            host.replaceChildren(SafeDom.element(document, 'div', { text: `Maintenance Center could not load: ${String(error.message || '').slice(0, 2048)}` }));
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
        if (!maintenanceEnabled() || !myGames.length) return;
        const references = [];
        for (const game of myGames) {
            try { references.push(await maintenanceGameReference(game, 'maintenance-read')); }
            catch (_) {}
        }
        const started = await ipc.invoke('maintenance-scan-all', {
            games: references,
            settings: portableMaintenanceSettings(),
            ...await archiveRootReference()
        });
        for (const job of started || []) if (job.id) jobs.set(job.id, job);
        renderMaintenanceJobs();
    };
    window.maintenanceQuickScan = async function (gameId, deep) {
        if (!maintenanceEnabled()) return;
        const game = gameById(gameId); if (!game) return;
        try {
            const job = await ipc.invoke('maintenance-start-scan', await maintenanceGamePayload(game, 'maintenance-read', { deep: !!deep }));
            jobs.set(job.id, job); renderMaintenanceJobs();
        } catch (error) { alert(`Scan could not start: ${error.message}`); }
    };
    window.maintenanceCreateBaseline = async function (gameId, creationMethod) {
        if (!maintenanceEnabled()) return null;
        const game = gameById(gameId); if (!game) return null;
        const details = await ipc.invoke('maintenance-game-details', { gameId: String(game.id), settings: portableMaintenanceSettings() });
        if (details.manifestStatus === 'ready' && !await sailConfirm('Rebuild this baseline? The current manifest will be kept as a recoverable backup.')) return null;
        try {
            const job = await ipc.invoke('maintenance-start-baseline', await maintenanceGamePayload(game, 'maintenance-write', {
                creationMethod: creationMethod || (details.manifestStatus === 'ready' ? 'rebuilt-baseline' : 'manual-baseline')
            }));
            jobs.set(job.id, job); renderMaintenanceJobs(); return job;
        } catch (error) { alert(`Baseline could not start: ${error.message}`); return null; }
    };
    window.maintenanceQuickRepair = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        if (!await sailConfirm('Run Quick Repair? Sail may update launcher metadata and remove only known-safe incomplete download fragments. Your saves and configuration are preserved.')) return;
        try {
            const job = await ipc.invoke('maintenance-quick-repair', await maintenanceGamePayload(game, 'maintenance-write', {
                options: { removeSafeTemporaryFiles: true }
            }));
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
            const job = await ipc.invoke('maintenance-selective-repair', await maintenanceGamePayload(game, 'maintenance-write', { actionIds: actions }));
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
        if (!maintenanceGamePageEnabled()) {
            panel.style.display = 'none';
            panel.replaceChildren();
            return;
        }
        panel.style.display = 'block';
        panel.replaceChildren(SafeDom.element(document, 'div', { text: 'Loading maintenance details…' }));
        try {
            const details = await ipc.invoke('maintenance-game-details', { gameId: String(game.id), settings: portableMaintenanceSettings() });
            const report = details.report;
            const manifest = details.manifest;
            const issues = report ? report.issues || [] : [];
            const storage = manifest ? Number(manifest.trackedBytes) || 0 : 0;
            const repairMap = { 'EXECUTABLE_MOVED': 'update-executable', 'MANIFEST_MISSING': 'create-baseline', 'FAILED_DOWNLOAD_FRAGMENT': 'remove-safe-temporary', 'MANIFEST_FILE_CHANGED': 'accept-change', 'HASH_MISMATCH': 'accept-change' };
            const gameId = String(game.id || '').slice(0, 128);
            const head = SafeDom.element(document, 'div', { className: 'maintenance-game-head' }, [
                SafeDom.element(document, 'div', { className: 'maintenance-game-main' }, [
                    SafeDom.element(document, 'h2', { text: 'Maintenance' }),
                    SafeDom.element(document, 'div', { text: 'Verify, repair, clean, and track modifications for this installation.' })
                ]),
                healthBadgeElement(report ? report.summary.status : 'information')
            ]);
            const detailGrid = SafeDom.element(document, 'div', { className: 'maintenance-detail-grid' });
            const detail = (label, value, pathValue = false) => detailGrid.append(SafeDom.element(document, 'div', { className: 'maintenance-detail-cell' }, [
                SafeDom.element(document, 'span', { className: 'maintenance-detail-label', text: label }),
                SafeDom.element(document, 'span', { className: pathValue ? 'maintenance-path' : '', text: String(value || '').slice(0, 32767) })
            ]));
            detail('Last scan', date(report && report.completedAt));
            detail('Manifest', `${String(details.manifestStatus || '').slice(0, 64)}${manifest ? ` · schema ${Number(manifest.schemaVersion) || 0}` : ''}`);
            detail('Installation', report && report.installRoot || 'Local capability required', true);
            detail('Executable', manifest && manifest.executablePath || 'Local capability required', true);
            detail('Save folder', 'Local capability required', true);
            detail('Tracked storage', bytes(storage));

            const actions = SafeDom.element(document, 'div', { className: 'maintenance-actions' });
            const addAction = (label, handler, options = {}) => {
                const button = SafeDom.element(document, 'button', { className: options.className || 'outline', text: label, disabled: options.disabled, title: options.title || '' });
                if (options.dataSaveRescan) button.dataset.saveRescan = gameId;
                if (!options.disabled) button.addEventListener('click', handler);
                actions.append(button);
                return button;
            };
            addAction('Quick Scan', () => maintenanceQuickScan(gameId), { className: '' });
            addAction('Deep Scan', () => maintenanceQuickScan(gameId, true));
            addAction(`${manifest ? 'Rebuild' : 'Create'} Baseline`, () => maintenanceCreateBaseline(gameId));
            addAction('Quick Repair', () => maintenanceQuickRepair(gameId));
            addAction('Selective Repair', () => maintenanceSelectiveRepair(gameId));
            addAction('Clean Temporary Files', () => maintenanceCleanGame(gameId));
            addAction('Open Installation Folder', () => maintenanceOpenInstall(gameId));
            addAction('Export Diagnostic Report', () => maintenanceExportDiagnostic(gameId));
            addAction('Prepare Clean Reinstall', () => maintenancePrepareReinstall(gameId));
            if (settings().hideInformationIssues) addAction('Info Hidden Globally', () => {}, { disabled: true, title: 'Turn off the global Maintenance setting to manage this per game.' });
            else addAction(`${game.maintenanceHideInformationIssues ? 'Show' : 'Hide'} Info for This Game`, () => maintenanceToggleGameInformation(gameId));
            addAction('Rescan Save Folders', () => maintenanceRescanSaves(gameId), { dataSaveRescan: true });
            addAction('Add Save Scan Directory', () => maintenanceAddSaveScanRoot(gameId));

            const issueList = SafeDom.element(document, 'div', { id: 'gpMaintenanceIssues' });
            if (issues.length) {
                for (const item of issues.slice(0, 10000)) {
                    const repair = repairMap[item.code] || (item.repairActions || []).find(action => ['update-executable', 'create-baseline', 'remove-safe-temporary', 'accept-change'].includes(action)) || '';
                    const selector = repair
                        ? SafeDom.element(document, 'input', { type: 'checkbox', ariaLabel: `Select ${String(item.code || '').slice(0, 128)} for repair` })
                        : SafeDom.element(document, 'span', { text: '•' });
                    if (repair) selector.dataset.repair = repair;
                    issueList.append(SafeDom.element(document, 'label', { className: 'maintenance-issue' }, [
                        selector,
                        SafeDom.element(document, 'span', {}, [
                            SafeDom.element(document, 'span', { className: 'maintenance-issue-message', text: String(item.message || '').slice(0, 4096) }),
                            document.createElement('br'),
                            SafeDom.element(document, 'span', { className: 'maintenance-issue-code', text: `${String(item.code || '').slice(0, 128)}${item.path ? ` · ${String(item.path).slice(0, 32767)}` : ''}` })
                        ])
                    ]));
                }
            } else issueList.append(SafeDom.element(document, 'div', { text: 'No findings yet. Run a scan to inspect this game.' }));

            const timeline = SafeDom.element(document, 'div', { className: 'maintenance-timeline' });
            const modifications = manifest && Array.isArray(manifest.modifications) ? manifest.modifications.slice().reverse().slice(0, 1000) : [];
            if (!modifications.length) timeline.append(SafeDom.element(document, 'div', { text: 'No Sail-managed modification snapshots yet.' }));
            for (const mod of modifications) {
                const modId = String(mod.id || '').slice(0, 128);
                const rowActions = SafeDom.element(document, 'div', { className: 'maintenance-actions' });
                const addModAction = (label, handler) => { const button = SafeDom.element(document, 'button', { className: 'outline', text: label }); button.addEventListener('click', handler); rowActions.append(button); };
                if (mod.restoreCapability !== 'none' && !mod.rolledBackAt) addModAction('Estimate / Restore', () => maintenanceRollback(gameId, modId));
                if (mod.snapshotLocation) addModAction('Delete Snapshot', () => maintenanceDeleteSnapshot(gameId, modId));
                if (!mod.acceptedAt) addModAction('Mark Accepted', () => maintenanceAcceptModification(gameId, modId));
                timeline.append(SafeDom.element(document, 'div', { className: 'maintenance-timeline-item' }, [
                    SafeDom.element(document, 'strong', { text: String(mod.displayName || '').slice(0, 512) }),
                    mod.acceptedAt ? SafeDom.element(document, 'span', { text: ' · accepted' }) : null,
                    SafeDom.element(document, 'div', { text: `${String(mod.source || '').slice(0, 128)} · ${date(mod.installedAt)} · ${(mod.filesAdded || []).length} added / ${(mod.filesReplaced || []).length} replaced · ${String(mod.managed || '').slice(0, 128)}` }),
                    rowActions
                ]));
            }
            panel.replaceChildren(
                head, detailGrid, actions,
                SafeDom.element(document, 'h3', { text: 'Detected issues' }), issueList,
                SafeDom.element(document, 'h3', { text: 'Modification timeline' }), timeline
            );
            const stale = !report || Date.now() - new Date(report.completedAt).getTime() > 7 * 24 * 60 * 60 * 1000;
            if (settings().automaticHealthChecks && stale && !details.activeJob && !automaticChecksStarted.has(String(game.id))) {
                automaticChecksStarted.add(String(game.id));
                setTimeout(() => maintenanceQuickScan(game.id), 250);
            }
        } catch (error) {
            panel.replaceChildren(SafeDom.element(document, 'div', { text: `Maintenance details could not load: ${String(error.message || '').slice(0, 2048)}` }));
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
        const close = SafeDom.element(document, 'button', { className: 'close-x', text: '✕', ariaLabel: 'Close save folder candidates' });
        close.addEventListener('click', () => closeModal('maintenanceSaveCandidateModal'));
        modal.append(SafeDom.element(document, 'div', { className: 'modal-content maintenance-save-modal' }, [
            close,
            SafeDom.element(document, 'h2', { text: 'Save Folder Candidates' }),
            SafeDom.element(document, 'p', { className: 'maintenance-help-text', text: 'Sail found possible locations. Review the hint, then use the native picker to approve the actual save folder.' }),
            SafeDom.element(document, 'div', { id: 'maintenanceSaveCandidateList' })
        ]));
        document.body.appendChild(modal);
        return modal;
    }
    function openSaveCandidates(game, candidates) {
        ensureSaveCandidateModal();
        const list = document.getElementById('maintenanceSaveCandidateList');
        const rows = candidates.slice(0, 256).map((candidate, index) => {
            const button = SafeDom.element(document, 'button', { className: 'maintenance-save-candidate' }, [
                SafeDom.element(document, 'strong', { text: String(candidate.label || 'Candidate folder').slice(0, 512) }),
                SafeDom.element(document, 'span', { text: `${String(candidate.reason || '').slice(0, 512)} · ${String(candidate.source || '').slice(0, 128)}` })
            ]);
            button.addEventListener('click', () => maintenanceUseSaveCandidate(String(game.id || ''), index));
            return button;
        });
        list.replaceChildren(...(rows.length ? rows : [SafeDom.element(document, 'div', { className: 'maintenance-empty-state', text: 'No matching folders were found. Add a local scan directory and try again.' })]));
        window.__maintenanceSaveCandidates = candidates;
        openModal('maintenanceSaveCandidateModal');
    }
    window.maintenanceUseSaveCandidate = async function (gameId, index) {
        const game = gameById(gameId); const candidate = (window.__maintenanceSaveCandidates || [])[index];
        if (!game || !candidate) return;
        const approved = await invokeAccount('authority-configure-filesystem', {
            gameId: String(game.id), kind: 'save', entryId: '', pathKind: 'folder'
        });
        if (!approved || approved.canceled) return;
        game.localSaveSetupStatus = 'active';
        game.saveScanPending = false;
        saveToMemory(); closeModal('maintenanceSaveCandidateModal'); renderGameMaintenancePanel(game);
    };
    window.maintenanceRescanSaves = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        const button = Array.from(document.querySelectorAll('[data-save-rescan]')).find(item => item.dataset.saveRescan === String(gameId));
        const originalText = button ? button.textContent : '';
        if (button) {
            button.disabled = true;
            button.classList.add('save-scan-loading');
            button.setAttribute('aria-busy', 'true');
            button.replaceChildren(
                SafeDom.element(document, 'span', { className: 'save-scan-spinner' }),
                SafeDom.element(document, 'span', { text: 'Scanning Save Folders…' })
            );
        }
        try {
            const job = await ipc.invoke('maintenance-scan-save-folders', await maintenanceGamePayload(game, 'save-scan'));
            jobs.set(job.id, job); renderMaintenanceJobs();
            openSaveCandidates(game, await waitForJob(job.id));
        } catch (error) { alert(`Save-folder scan failed: ${error.message}`); }
        finally {
            if (button && button.isConnected) {
                button.disabled = false;
                button.classList.remove('save-scan-loading');
                button.removeAttribute('aria-busy');
                button.textContent = originalText;
            }
        }
    };
    window.maintenanceAddSaveScanRoot = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        const chosen = await ipc.invoke('maintenance-pick-save-root', { gameId: String(game.id) });
        if (!chosen || chosen.canceled) return;
        game.localSaveSetupStatus = 'active';
        game.saveScanPending = false;
        saveToMemory();
        maintenanceRescanSaves(gameId);
    };
    window.maintenanceOpenInstall = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        try {
            await ipc.invoke('maintenance-open-installation', await maintenanceGameReference(game, 'reveal'));
        } catch (error) { alert(`Installation folder could not be opened: ${error.message}`); }
    };
    window.maintenanceExportDiagnostic = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        const result = await ipc.invoke('maintenance-export-diagnostic', await maintenanceGameReference(game, 'maintenance-read'));
        if (result && !result.canceled) alert(`Diagnostic report exported as:\n${String(result.label || 'diagnostic report')}`);
    };
    window.maintenanceRollback = async function (gameId, modificationId) {
        const game = gameById(gameId); if (!game) return;
        const impact = await ipc.invoke('maintenance-rollback-snapshot', await maintenanceGamePayload(game, 'maintenance-write', { modificationId, dryRun: true }));
        if (!await sailConfirm(`Restore ${impact.restoreFiles} file(s) and remove ${impact.removeFiles} file(s) introduced by this modification? About ${bytes(impact.restoreBytes)} will be restored. Affected save/config paths are not included unless explicitly snapshot-managed.`)) return;
        const job = await ipc.invoke('maintenance-rollback-snapshot', await maintenanceGamePayload(game, 'maintenance-write', { modificationId, dryRun: false }));
        jobs.set(job.id, job); renderMaintenanceJobs();
        await waitForJob(job.id);
        await renderGameMaintenancePanel(game);
    };
    window.maintenanceDeleteSnapshot = async function (gameId, modificationId) {
        if (!await sailConfirm('Permanently delete this maintenance snapshot? The modification record will remain, but rollback will no longer be available.')) return;
        const game = gameById(gameId); if (!game) return;
        const job = await ipc.invoke('maintenance-delete-snapshot', {
            ...await maintenanceGameReference(game, 'maintenance-write'), modificationId
        });
        jobs.set(job.id, job); renderMaintenanceJobs();
        await waitForJob(job.id);
        renderGameMaintenancePanel(game);
    };
    window.maintenanceAcceptModification = async function (gameId, modificationId) {
        await ipc.invoke('maintenance-accept-modification', { gameId, modificationId });
        const game = gameById(gameId); if (game) renderGameMaintenancePanel(game);
    };
    window.maintenancePrepareReinstall = async function (gameId) {
        const game = gameById(gameId); if (!game) return;
        if (!await sailConfirm('Prepare for a clean reinstall? Sail will create existing local save and game-folder backups using its current backup system. It will not delete or redownload anything until you explicitly continue outside this step.')) return;
        try {
            if (['active', 'pending-review'].includes(game.localSaveSetupStatus)) {
                const saveReference = await filesystemAuthorityReference(game, 'save', 'backup-read');
                await ipc.invoke('zip-save-to-drive', {
                    gameId: String(game.id),
                    capabilityId: saveReference.capabilityId,
                    expectedRevision: saveReference.expectedRevision,
                    maxVersions: settings().snapshotRetentionCount
                });
            }
            const gameReference = await executionAuthorityReference(game, 'backup-create');
            await ipc.invoke('backup-game', {
                gameId: String(game.id),
                capabilityId: gameReference.capabilityId,
                expectedRevision: gameReference.expectedRevision
            });
            alert('Preparation complete. Backups were created. Review them, then choose a replacement package from Game Downloads. Sail has not deleted the current installation.');
            switchMainTab('downloads');
        } catch (error) { alert(`Reinstall preparation failed safely: ${error.message}`); }
    };

    window.maintenanceStorageCleanup = async function () {
        try {
            const games = [];
            for (const game of myGames) {
                try { games.push(await maintenanceGameReference(game, 'maintenance-read')); }
                catch (_) {}
            }
            const root = await ipc.invoke('authority-get-device-root-status', { kind: 'download-root' });
            const rootReference = root && root.state === 'active' && root.capabilityId && root.operations.includes('download-write')
                ? { rootCapabilityId: root.capabilityId, rootExpectedRevision: root.revision }
                : {};
            const job = await ipc.invoke('maintenance-cleanup-scan', {
                games,
                settings: portableMaintenanceSettings(),
                ...rootReference
            });
            jobs.set(job.id, job); renderMaintenanceJobs();
        } catch (error) { alert(`Cleanup scan could not start: ${error.message}`); }
    };

    function ensureCleanupModal() {
        let modal = document.getElementById('maintenanceCleanupModal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'maintenanceCleanupModal'; modal.className = 'modal';
        const close = SafeDom.element(document, 'button', { className: 'close-x', text: '✕', ariaLabel: 'Close cleanup preview' });
        const cancel = SafeDom.element(document, 'button', { className: 'outline', text: 'Cancel' });
        const remove = SafeDom.element(document, 'button', { text: 'Delete Selected' });
        close.addEventListener('click', () => closeModal('maintenanceCleanupModal'));
        cancel.addEventListener('click', () => closeModal('maintenanceCleanupModal'));
        remove.addEventListener('click', () => maintenanceDeleteCleanupSelection());
        modal.append(SafeDom.element(document, 'div', { className: 'modal-content maintenance-cleanup-modal' }, [
            close,
            SafeDom.element(document, 'h2', { text: 'Storage Cleanup Preview' }),
            SafeDom.element(document, 'p', { text: 'Only clearly Sail-owned incomplete fragments are selected by default. Archives, installers, caches, and ambiguous files require your explicit selection.' }),
            SafeDom.element(document, 'div', { id: 'maintenanceCleanupList', className: 'maintenance-cleanup-list' }),
            SafeDom.element(document, 'div', { className: 'maintenance-actions' }, [
                SafeDom.element(document, 'strong', { id: 'maintenanceCleanupTotal' }), cancel, remove
            ])
        ]));
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
        const rows = result.candidates.slice(0, 10000).map((item, index) => {
            const checkbox = SafeDom.element(document, 'input', { type: 'checkbox', checked: !!item.selected });
            checkbox.dataset.index = String(index);
            checkbox.dataset.size = String(Math.max(0, Number(item.size) || 0));
            checkbox.addEventListener('change', updateCleanupTotal);
            return SafeDom.element(document, 'label', { className: 'maintenance-cleanup-item' }, [
                checkbox,
                SafeDom.element(document, 'span', {}, [
                    SafeDom.element(document, 'strong', { text: String(item.category || '').slice(0, 128) }),
                    SafeDom.element(document, 'div', { className: 'maintenance-cleanup-path', text: String(item.relativePath || '').slice(0, 1024) }),
                    SafeDom.element(document, 'div', { text: String(item.reason || '').slice(0, 2048) })
                ]),
                SafeDom.element(document, 'span', {}, [
                    document.createTextNode(bytes(item.size)), document.createElement('br'),
                    SafeDom.element(document, 'span', { className: 'maintenance-risk', text: `${String(item.risk || '').slice(0, 64)} risk` })
                ])
            ]);
        });
        list.replaceChildren(...(rows.length ? rows : [SafeDom.element(document, 'div', { text: 'No cleanup candidates found.' })]));
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
        const job = await ipc.invoke('maintenance-cleanup-delete', {
            scanJobId: lastCleanupJobId,
            candidateIds: selected.map(item => String(item.id || ''))
        });
        jobs.set(job.id, job); renderMaintenanceJobs();
    };

    window.maintenanceAfterInstall = async function (game) {
        if (!maintenanceEnabled() || !settings().scanAfterInstall) return;
        const job = await maintenanceCreateBaseline(game.id, 'post-install');
        if (job) waitForJob(job.id).catch(() => {});
    };

    window.maintenanceRecordWorkshop = async function (game, result, itemId) {
        if (!maintenanceEnabled() || !settings().scanAfterModInstall) return;
        try {
            let details = await ipc.invoke('maintenance-game-details', { gameId: String(game.id), settings: portableMaintenanceSettings() });
            if (details.manifestStatus === 'missing') {
                const job = await maintenanceCreateBaseline(game.id, 'pre-mod-baseline');
                if (job) await waitForJob(job.id);
                details = await ipc.invoke('maintenance-game-details', { gameId: String(game.id), settings: portableMaintenanceSettings() });
            }
            if (details.manifestStatus === 'ready') {
                await ipc.invoke('maintenance-record-external-modification', {
                    gameId: String(game.id),
                    info: {
                        displayName: `Steam Workshop item ${itemId}`,
                        source: 'steam-workshop',
                        note: 'SteamCMD downloaded this item outside the game directory. Sail did not apply external installer changes, so it is partially managed.'
                    }
                });
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
            maintenanceLimitInput: ['snapshotStorageLimitGb', 'number']
        };
        const current = settings();
        const enabledToggle = document.getElementById('maintenanceEnabledToggle');
        const gamePageToggle = document.getElementById('maintenanceGamePageToggle');
        const refreshAvailability = () => {
            const enabled = maintenanceEnabled();
            const body = document.getElementById('maintenanceSettingsBody');
            const dependent = document.querySelector('[data-maintenance-dependent]');
            const settingsTab = document.getElementById('settingsTabMaintenance');
            if (settingsTab) settingsTab.style.display = enabled ? '' : 'none';
            if (body) body.classList.toggle('maintenance-disabled', !enabled);
            if (dependent) dependent.classList.toggle('maintenance-disabled', !enabled);
            if (gamePageToggle) gamePageToggle.disabled = !enabled;
            try { if (typeof applyPageVisibility === 'function') applyPageVisibility(); } catch (_) {}
            const panel = document.getElementById('gpMaintenancePanel');
            if (panel && viewingGameIndex !== null) renderGameMaintenancePanel(myGames[viewingGameIndex]);
        };
        if (enabledToggle) {
            enabledToggle.checked = maintenanceEnabled();
            enabledToggle.addEventListener('change', async () => {
                globalSettings.maintenanceEnabled = enabledToggle.checked;
                saveSettings();
                refreshAvailability();
                await ipc.invoke('maintenance-set-enabled', enabledToggle.checked);
                if (!enabledToggle.checked) {
                    jobs.clear();
                    renderMaintenanceJobs();
                    const maintenanceSettingsPane = document.getElementById('tab-maintenance');
                    if (maintenanceSettingsPane && maintenanceSettingsPane.classList.contains('active') && typeof switchSettingsTab === 'function') {
                        await switchSettingsTab('experimental');
                    }
                    if (currentTabName === 'maintenance' && typeof switchMainTab === 'function') {
                        await switchMainTab('library');
                    }
                } else {
                    const existing = await ipc.invoke('maintenance-list-jobs', {});
                    for (const job of existing || []) jobs.set(job.id, job);
                    renderMaintenanceJobs();
                }
            });
        }
        if (gamePageToggle) {
            gamePageToggle.checked = globalSettings.maintenanceGamePageEnabled !== false;
            gamePageToggle.addEventListener('change', () => {
                globalSettings.maintenanceGamePageEnabled = gamePageToggle.checked;
                saveSettings();
                refreshAvailability();
            });
        }
        refreshAvailability();
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
            saveRoots.value = 'Use Add Save Scan Directory on an individual game to approve a local folder.';
            saveRoots.readOnly = true;
        }
        const addSaveRoot = document.getElementById('addSaveScanDirectoryBtn');
        if (addSaveRoot) {
            addSaveRoot.disabled = true;
            addSaveRoot.title = 'Save roots are approved per game from its Maintenance panel.';
        }
        const snapshotLocation = document.getElementById('maintenanceSnapshotLocation');
        if (snapshotLocation) {
            snapshotLocation.readOnly = true;
            snapshotLocation.value = 'No local snapshot folder approved';
            ipc.invoke('authority-get-device-root-status', { kind: 'archive-root' }).then(status => {
                if (snapshotLocation.isConnected && status && status.state === 'active') snapshotLocation.value = 'Approved local snapshot folder';
            }).catch(() => {});
        }
        const browse = document.getElementById('maintenanceBrowseSnapshots');
        if (browse) browse.addEventListener('click', async () => {
            const chosen = await ipc.invoke('maintenance-pick-snapshot-folder');
            if (chosen && !chosen.canceled && snapshotLocation) snapshotLocation.value = `Approved locally: ${String(chosen.label || 'Selected folder')}`;
        });
    }

    window.maintenanceInitialize = async function () {
        if (initialized) return;
        initialized = true;
        const created = !globalSettings.maintenance;
        settings();
        if (created) saveSettings();
        wireSettings();
        await ipc.invoke('maintenance-set-enabled', maintenanceEnabled());
        if (!maintenanceEnabled()) {
            renderMaintenanceJobs();
            return;
        }
        const existing = await ipc.invoke('maintenance-list-jobs', {});
        for (const job of existing || []) jobs.set(job.id, job);
        renderMaintenanceJobs();
        if (settings().scanOnStartup && myGames.length) setTimeout(() => maintenanceScanAll(), 1200);
    };
})();
