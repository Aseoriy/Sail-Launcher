'use strict';
function showProtonInstallation({ document, gameId, invoke, available, getRequest, onChanged }) {
    const panel = document.getElementById('protonInstallationPanel'), status = document.getElementById('protonInstallationStatus');
    const run = document.getElementById('runWindowsInstaller'), check = document.getElementById('checkProtonPrerequisites');
    const prerequisites = document.getElementById('installProtonPrerequisites'), cancel = document.getElementById('cancelWindowsInstallation');
    const bundled = document.getElementById('protonBundledPrerequisites'), include = document.getElementById('includeBundledPrerequisites');
    const onlineCheck = document.getElementById('checkOnlineProtonPrerequisites'), onlineInstall = document.getElementById('installOnlineProtonPrerequisites');
    const onlineCancel = document.getElementById('cancelOnlineProtonPrerequisites'), onlineStatus = document.getElementById('protonOnlinePrerequisiteStatus');
    const onlineList = document.getElementById('protonOnlineComponents');
    const guidanceList = document.getElementById('protonComponentGuidance');
    if (panel.installationTimer) clearTimeout(panel.installationTimer);
    const token = Symbol('installation'); panel.installationToken = token; panel.dataset.gameId = gameId;
    panel.hidden = !available; status.textContent = ''; bundled.textContent = ''; include.checked = true;
    let busy = false, job = null, supported = false, setupReason = '', found = 0, failure = '', revision = 0;
    let online = { available: false, job: null }, components = [], checked = false;
    const selected = new Set(), rows = [];
    const current = () => panel.installationToken === token && panel.dataset.gameId === gameId;
    const active = () => job && ['checking', 'starting', 'running', 'waiting', 'tracking-lost'].includes(job.phase);
    const acquiring = () => online.job && ['checking', 'downloading', 'extracting', 'queuing'].includes(online.job.phase);
    function renderComponents() {
        if (!onlineList?.replaceChildren || !current()) return;
        onlineList.replaceChildren(); rows.length = 0;
        for (const item of [...components].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended))) {
            const row = document.createElement('label'), box = document.createElement('input'), text = document.createElement('span');
            row.style.display = 'flex'; row.style.gap = '8px'; row.style.alignItems = 'center';
            box.type = 'checkbox'; box.checked = selected.has(item.id);
            box.setAttribute('aria-label', item.label);
            box.onchange = () => { box.checked ? selected.add(item.id) : selected.delete(item.id); render(); };
            const detection = { detected: 'Detected', 'not-detected': 'Not detected', unknown: 'Check unavailable' }[item.detection] || 'Check unavailable';
            text.textContent = `${item.label}${item.recommended ? ' · Suggested' : ''} · ${detection} · ${(item.size / 1024 ** 2).toFixed(1)} MB`;
            row.title = `${item.version}${item.detectedVersion ? `; installed ${item.detectedVersion}` : ''}. ${(item.reasons || []).join(' ')} ${item.reason || ''} ${item.legacy ? 'Legacy runtime; Microsoft support has ended. ' : ''}${item.infoUrl}`;
            row.appendChild(box); row.appendChild(text); onlineList.appendChild(row); rows.push({ box, item });
        }
    }
    function renderGuidance(result) {
        if (!guidanceList?.replaceChildren || !current()) return;
        guidanceList.replaceChildren();
        const entries = result.guidance || [], warnings = result.warnings || [];
        guidanceList.hidden = !entries.length && !warnings.length;
        if (entries.length) {
            const heading = document.createElement('strong'); heading.textContent = 'Other requirements'; guidanceList.appendChild(heading);
            for (const item of entries) {
                const text = document.createElement('p'); text.textContent = `${item.title}: ${item.detail}`; guidanceList.appendChild(text);
            }
        }
        if (warnings.length) { const text = document.createElement('p'); text.textContent = warnings.join(' '); guidanceList.appendChild(text); }
    }
    function render() {
        if (!current()) return;
        const blocked = busy || !!active() || !!acquiring() || !supported;
        run.disabled = check.disabled = include.disabled = blocked;
        prerequisites.disabled = blocked || !found;
        cancel.hidden = !active(); cancel.disabled = busy || !!job?.cancelRequested;
        const labels = { checking: 'Checking requirements…', starting: 'Starting installer…', running: 'Installing…', waiting: 'Saving installation state…',
            'tracking-lost': 'Tracking unavailable', completed: 'Installation steps finished', failed: 'Installation failed', canceled: 'Installation stopped', interrupted: 'Installation interrupted' };
        status.textContent = failure || (!supported && setupReason) || (job ? labels[job.phase] || job.phase : supported ? 'Ready for installation' : 'Save a Proton or Wine launch setup to use Windows installers.');
        status.title = failure || job?.detail || 'Installers and prerequisites use this game’s separate Windows environment.';
        if (onlineCheck && onlineInstall && onlineCancel && onlineStatus) {
            onlineCheck.disabled = blocked || !online.available;
            onlineInstall.disabled = blocked || !online.available || !selected.size;
            onlineCancel.hidden = !acquiring(); onlineCancel.disabled = busy || !!online.job?.cancelRequested;
            for (const { box, item } of rows) box.disabled = blocked || !online.available || item.detection === 'detected' || item.detection === 'unknown';
            const onlineLabels = { checking: 'Checking requirements…', downloading: 'Downloading components…', extracting: 'Preparing DirectX…', queuing: 'Starting installation…',
                installing: 'Components in installation queue', completed: 'Component installers finished', failed: 'Component download or installation failed', canceled: 'Component download stopped', interrupted: 'Component download interrupted' };
            const task = online.job;
            const percent = task?.phase === 'downloading' && task.total ? ` ${Math.floor(task.received / task.total * 100)}%` : '';
            onlineStatus.textContent = task ? (onlineLabels[task.phase] || task.phase) + percent
                : !online.available ? 'Component downloads unavailable in this mode.' : checked ? 'Select missing components to install.' : 'Check components to see what is missing.';
            onlineStatus.title = task?.detail || 'Common components only. A detection check does not confirm that every game requirement works.';
        }
    }
    async function refresh() {
        const requested = ++revision;
        const result = await invoke('proton-installation-status', { gameId });
        if (!current() || requested !== revision) return;
        if (panel.installationTimer) clearTimeout(panel.installationTimer);
        panel.installationTimer = null;
        supported = result.available; setupReason = result.reason || ''; job = result.job; online = result.online || { available: false, job: null }; render();
        if (supported && online.available && !checked && !active() && !acquiring() && onlineList?.replaceChildren) await checkOnline();
        if (active() || acquiring() || online.job?.phase === 'installing') {
            panel.installationTimer = setTimeout(() => {
                panel.installationTimer = null;
                if (current() && document.getElementById('gameSettingsModal').classList.contains('show')) refresh().catch(error => { failure = error.message; render(); });
            }, 1000);
        }
    }
    async function action(operation) {
        if (!current() || busy) return;
        busy = true; failure = ''; render();
        try { await operation(); if (current()) { await onChanged?.(); await refresh(); } }
        catch (error) { if (current()) failure = error.message; }
        finally { busy = false; render(); }
    }
    async function request(operation = 'launch') {
        const saved = await invoke('authority-get-native-setup', { gameId });
        if (!current()) throw Error('The game settings changed.');
        if (operation === 'launch' && (!['proton-umu', 'wine'].includes(saved.backend) || saved.runtimeId !== document.getElementById('protonRuntimeSelect').value)) throw Error('Update local launch setup with this compatibility version before installing.');
        return getRequest(operation);
    }
    async function checkOnline() {
        const result = await invoke('proton-check-online-prerequisites', { gameId });
        if (!current()) return;
        online = { available: result.available, job: result.job }; components = result.components;
        const first = !checked; checked = true;
        for (const item of components) {
            if (item.detection !== 'not-detected') selected.delete(item.id);
            else if (first && item.recommended) selected.add(item.id);
        }
        renderComponents(); renderGuidance(result); render();
    }
    check.onclick = () => action(async () => {
        const result = await invoke('proton-prerequisites', { gameId });
        if (!current()) return;
        found = result.candidates.length; bundled.textContent = found ? result.candidates.map(item => item.label).join(' · ') : 'No supported bundled installers found.';
        bundled.title = [...result.issues, ...(result.truncated ? ['The bounded scan stopped before checking every folder.'] : [])].join(' ');
    });
    run.onclick = () => action(async () => { const permission = await request(); if (current()) await invoke('proton-run-installer', { gameId, ...permission, mode: 'installer', includePrerequisites: include.checked }); });
    prerequisites.onclick = () => action(async () => { const permission = await request(); if (current()) await invoke('proton-run-installer', { gameId, ...permission, mode: 'prerequisites', includePrerequisites: true }); });
    cancel.onclick = () => action(async () => { const permission = await request('terminate'); if (current() && job) await invoke('proton-installation-cancel', { gameId, ...permission, jobId: job.id }); });
    if (onlineList?.replaceChildren) onlineList.replaceChildren();
    if (guidanceList?.replaceChildren) { guidanceList.replaceChildren(); guidanceList.hidden = true; }
    if (onlineCheck && onlineInstall && onlineCancel) {
        onlineCheck.onclick = () => action(checkOnline);
        onlineInstall.onclick = () => action(async () => {
            const permission = await request();
            if (current()) await invoke('proton-install-online-prerequisites', { gameId, ...permission, recipeIds: [...selected] });
        });
        onlineCancel.onclick = () => action(async () => {
            if (current() && online.job) await invoke('proton-cancel-online-prerequisites', { gameId, jobId: online.job.id });
        });
    }
    if (panel.installationRefreshListener) document.removeEventListener?.('sail-local-execution-changed', panel.installationRefreshListener);
    panel.installationRefreshListener = event => {
        if (current() && !busy && String(event.detail?.gameId) === gameId && document.getElementById('gameSettingsModal').classList.contains('show')) {
            refresh().catch(error => { if (current()) { failure = error.message; render(); } });
        }
    };
    document.addEventListener?.('sail-local-execution-changed', panel.installationRefreshListener);
    if (available) refresh().catch(error => { if (current()) { failure = error.message; render(); } });
    else render();
    return { refresh };
}
module.exports = { showProtonInstallation };
