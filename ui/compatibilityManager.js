'use strict';

function installCompatibilityManager({ document, invoke, ready, open }) {
    const pane = document.getElementById('tab-compatibility'), tab = document.getElementById('settingsTabCompatibility');
    const installed = document.getElementById('compatibilityInstalled'), detected = document.getElementById('compatibilityDetected');
    const versions = document.getElementById('compatibilityVersion'), kind = document.getElementById('compatibilityKind');
    const defaultSelect = document.getElementById('compatibilityDefault'), progress = document.getElementById('compatibilityProgress');
    const status = document.getElementById('compatibilityStatus'), jobText = document.getElementById('compatibilityJob');
    const refreshButton = document.getElementById('compatibilityRefresh'), installButton = document.getElementById('compatibilityInstall');
    const cancelButton = document.getElementById('compatibilityCancel'), browse = document.getElementById('compatibilityBrowse');
    const setupButton = document.getElementById('compatibilitySetup'), checkButton = document.getElementById('compatibilityCheck');
    const summary = document.getElementById('compatibilitySetupSummary'), checklist = document.getElementById('compatibilityChecklist');
    const checklistDetails = document.getElementById('compatibilityChecklistDetails');
    const banner = document.getElementById('compatibilitySetupBanner'), bannerText = document.getElementById('compatibilitySetupBannerText');
    let supported = false, data = null, timer = null, requesting = null, action = false, fingerprint = '', runtimeFingerprint = '', checklistFingerprint = '';
    const bytes = value => `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
    const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
    const option = (value, label, disabled = false) => { const node = element('option', label); node.value = value; node.disabled = disabled; return node; };
    const active = () => !!data?.job && !['completed', 'failed', 'canceled'].includes(data.job.phase);
    function releaseOptions() {
        const selected = versions.value;
        versions.replaceChildren(...(data?.releases || []).filter(release => release.kind === kind.value)
            .map((release, index) => option(release.id, `${release.tag}${index === 0 ? ' (latest)' : ''} · ${bytes(release.size)}`)));
        if ([...versions.options].some(item => item.value === selected)) versions.value = selected;
        if (!versions.options.length) versions.append(option('', 'Check for available versions', true));
        installButton.disabled = action || active() || !data?.available || !versions.value || !!data?.setup && !data.setup.canInstall;
    }
    function render() {
        if (!data) return;
        if (!data.available && !status.textContent) status.textContent = data.reason;
        const setup = data.setup;
        if (setup) {
            summary.textContent = active() ? 'Preparing compatibility tools…' : setup.summary;
            setupButton.textContent = active() ? 'Setting up…' : setup.toolsReady ? 'Check setup again' : 'Set up Windows gaming';
            setupButton.disabled = action || active() || !data.available || !setup.canSetUp;
            checkButton.disabled = action;
            const checklistState = JSON.stringify(setup.checks);
            if (checklistState !== checklistFingerprint) {
                checklistFingerprint = checklistState; checklist.replaceChildren();
                // Show the details only when something needs attention.
                if (checklistDetails) checklistDetails.open = !setup.toolsReady;
                const states = { detected: 'Detected', missing: 'Needed', warning: 'Check', unchecked: 'On launch' };
                for (const item of setup.checks) {
                    const row = element('div'); row.className = 'compatibility-row';
                    const info = element('div'); info.append(element('strong', item.label), element('small', item.detail));
                    const state = element('span', states[item.state] || 'Check'); state.className = 'compatibility-check-state'; state.dataset.state = item.state;
                    row.append(info, state); checklist.append(row);
                }
            }
            banner.hidden = setup.noticeDismissed || setup.toolsReady;
            bannerText.textContent = active() ? 'Windows gaming setup is in progress.' : setup.summary;
        }
        const runtimeState = JSON.stringify([data.runtimes, data.defaultRuntimeId]);
        if (runtimeState !== runtimeFingerprint) {
            runtimeFingerprint = runtimeState;
            document.dispatchEvent(new document.defaultView.Event('sail-compatibility-changed'));
        }
        const next = JSON.stringify([data.installed, data.runtimes, data.discovery, data.defaultRuntimeId, data.releases]);
        if (next !== fingerprint) {
            fingerprint = next; installed.replaceChildren(); detected.replaceChildren();
            defaultSelect.replaceChildren(option('', 'Ask when setting up a Windows game'));
            const group = (label, items) => { if (!items.length) return; const box = element('optgroup'); box.label = label; box.append(...items); defaultSelect.append(box); };
            group('Ready to use', (data.runtimes || []).map(runtime => option(runtime.id, runtime.label + (runtime.ready ? '' : ' — unavailable'), !runtime.ready)));
            // Versions installed outside Sail are added (after confirmation) when chosen.
            group('Installed on this PC', [
                ...(data.discovery?.proton || []).filter(runtime => !runtime.registeredRuntimeId && runtime.available).map(runtime => option('detected:' + runtime.id, runtime.label)),
                ...(data.discovery?.wine || []).filter(runtime => !runtime.registeredRuntimeId && runtime.available)
                    .map(runtime => option('wine:' + runtime.id, 'Wine · ' + runtime.label + (runtime.version ? ' ' + runtime.version : '')))
            ]);
            defaultSelect.value = data.defaultRuntimeId || '';
            if (!defaultSelect.value && data.defaultRuntimeId) {
                defaultSelect.append(option(data.defaultRuntimeId, 'Previous default — unavailable', true)); defaultSelect.value = data.defaultRuntimeId;
            }
            if (!data.installed.length) installed.append(element('p', 'No versions downloaded by Sail yet.'));
            for (const runtime of data.installed) {
                const row = element('div'); row.className = 'compatibility-row';
                const info = element('div'), label = element('strong', runtime.kind === 'umu' ? `UMU ${runtime.tag}` : runtime.tag);
                info.append(label, element('small', `${bytes(runtime.size)}${runtime.reason ? ' · ' + runtime.reason : ''}`));
                const remove = element('button', 'Remove'); remove.className = 'outline'; remove.disabled = !runtime.removable || active(); remove.title = runtime.reason;
                remove.dataset.available = String(runtime.removable);
                remove.onclick = () => run(() => invoke('compatibility-remove', { installedId: runtime.id })); row.append(info, remove); installed.append(row);
            }
            const managedIds = new Set(data.installed.map(item => item.runtimeId));
            for (const runtime of data.runtimes || []) {
                if (managedIds.has(runtime.id)) continue;
                const row = element('div'); row.className = 'compatibility-row';
                const info = element('div'); info.append(element('strong', runtime.label), element('small', runtime.ready ? 'Available from another installation' : runtime.reason));
                row.append(info); detected.append(row);
            }
            for (const runtime of data.discovery?.proton || []) {
                if (runtime.registeredRuntimeId) continue;
                const row = element('div'); row.className = 'compatibility-row';
                const info = element('div'); info.append(element('strong', runtime.label), element('small', runtime.available ? runtime.path : runtime.reason));
                const add = element('button', 'Use this version'); add.className = 'outline'; add.disabled = !runtime.available || active();
                add.dataset.available = String(runtime.available);
                add.onclick = () => run(() => invoke('proton-register-runtime', { discoveryId: runtime.id })); row.append(info, add); detected.append(row);
            }
            const umuFound = (data.discovery?.umu || []).length > 0;
            document.getElementById('compatibilityUmu').textContent = umuFound ? 'UMU is installed and available.'
                : 'UMU is needed to run Proton outside Steam. Sail will install it when downloading your first Proton version.';
            if (!detected.children.length) detected.append(element('p', 'No other Proton versions detected.'));
            const wine = data.discovery?.wine || [];
            for (const runtime of wine) {
                if (runtime.registeredRuntimeId) continue;
                const row = element('div'); row.className = 'compatibility-row';
                const info = element('div'); info.append(element('strong', 'Wine · ' + runtime.label + (runtime.version ? ' ' + runtime.version : '')),
                    element('small', runtime.available ? runtime.path : runtime.reason));
                const add = element('button', 'Use this version'); add.className = 'outline'; add.disabled = !runtime.available || active();
                add.dataset.available = String(runtime.available); add.title = runtime.reason || '';
                add.onclick = () => run(() => invoke('wine-register-runtime', { discoveryId: runtime.id })); row.append(info, add); detected.append(row);
            }
            document.getElementById('compatibilityWine').textContent = wine.length
                ? `${wine.length} Wine installation(s) detected. ${data.wineLaunch?.reason || 'Wine uses a separate environment for each game.'}` : '';
            releaseOptions();
        }
        const job = data.job;
        progress.hidden = !active(); cancelButton.hidden = !active(); cancelButton.disabled = action;
        progress.max = job?.total || 1; progress.value = job?.received || 0;
        const phases = { checking: 'Checking', starting: 'Starting', downloading: 'Downloading', extracting: 'Extracting', installing: 'Installing' };
        if (active() && job.phase !== 'downloading') progress.removeAttribute('value');
        jobText.textContent = !job ? '' : job.phase === 'completed' ? job.task === 'setup'
            ? job.reused ? 'Setup completed using your installed Proton version.' : 'Windows gaming tools are installed.' : `${job.tag} is installed.`
            : job.phase === 'failed' || job.phase === 'canceled' ? job.error
            : `${phases[job.phase] || job.phase} ${job.currentTag || job.tag}${job.phase === 'downloading' ? ` · ${bytes(job.received)} / ${bytes(job.total)}` : '…'}`;
        installButton.disabled = action || active() || !data.available || !versions.value || !!setup && !setup.canInstall;
        for (const button of [...installed.querySelectorAll('button'), ...detected.querySelectorAll('button')]) button.disabled = action || active() || button.dataset.available !== 'true';
        refreshButton.disabled = action || active(); defaultSelect.disabled = action || active(); browse.disabled = action || active();
        const browseWine = document.getElementById('compatibilityBrowseWine'); if (browseWine) browseWine.disabled = action || active();
        if (active() && pane.classList.contains('active')) schedule();
    }
    function schedule() {
        if (timer) return;
        timer = setTimeout(() => { timer = null; if (pane.classList.contains('active')) refresh().catch(error => { status.textContent = error.message; schedule(); }); }, 1000);
    }
    async function refresh(force = false) {
        if (!supported) return;
        if (requesting) { await requesting; if (!force) return; }
        requesting = (async () => { data = await invoke('compatibility-status', {}); render(); })();
        try { await requesting; } finally { requesting = null; }
    }
    async function run(operation) {
        if (action) return; action = true; status.textContent = ''; render();
        try { await operation(); await refresh(true); }
        catch (error) { status.textContent = error.message; fingerprint = ''; }
        finally { action = false; render(); }
    }
    async function checkReleases() {
        await run(async () => {
            status.textContent = 'Checking official releases…';
            await invoke('compatibility-releases', {}); status.textContent = 'Available versions updated.';
        });
    }
    refreshButton.onclick = checkReleases;
    kind.onchange = releaseOptions;
    installButton.onclick = () => run(() => invoke('compatibility-install', { releaseId: versions.value }));
    cancelButton.onclick = () => run(() => invoke('compatibility-cancel', { jobId: data.job.id }));
    defaultSelect.onchange = () => run(async () => {
        const value = defaultSelect.value;
        let runtimeId = value;
        if (value.startsWith('detected:') || value.startsWith('wine:')) {
            const wine = value.startsWith('wine:');
            const result = await invoke(wine ? 'wine-register-runtime' : 'proton-register-runtime', { discoveryId: value.slice(wine ? 5 : 9) });
            if (result.canceled || !result.registeredRuntimeId) { fingerprint = ''; return; }
            runtimeId = result.registeredRuntimeId;
        }
        await invoke('compatibility-default', { runtimeId });
    });
    browse.onclick = () => run(() => invoke('proton-register-runtime', {}));
    const browseWine = document.getElementById('compatibilityBrowseWine');
    if (browseWine) browseWine.onclick = () => run(() => invoke('wine-register-runtime', {}));
    setupButton.onclick = () => run(() => invoke('compatibility-setup', {}));
    checkButton.onclick = () => run(() => invoke('compatibility-check', {}));
    document.getElementById('compatibilitySetupBannerOpen').onclick = () => show().catch(error => { bannerText.textContent = error.message; });
    document.getElementById('compatibilitySetupBannerDismiss').onclick = async () => {
        try { await invoke('compatibility-dismiss-setup', {}); await refresh(true); }
        catch (error) { bannerText.textContent = error.message; }
    };
    ready.then(support => { supported = support.platform === 'linux' && support.features.protonSetup.available;
        tab.hidden = !supported; tab.style.display = supported ? '' : 'none'; pane.hidden = !supported; pane.style.display = supported ? '' : 'none'; });
    async function enter() {
        await ready; if (!supported) return;
        await refresh();
    }
    async function show() { open(); await enter(); }
    return { show, refresh, enter, async offerSetup() { await ready; if (supported) await refresh(); } };
}
module.exports = { installCompatibilityManager };
