'use strict';

function showProtonSetup({ document, gameId, invoke, available, selectedRuntimeId = '', getLaunchRequest, onPrepared = () => {} }) {
    const panel = document.getElementById('protonSetupPanel'), select = document.getElementById('protonRuntimeSelect');
    const button = document.getElementById('addProtonRuntimeBtn'), status = document.getElementById('protonSetupStatus');
    const wineButton = document.getElementById('registerWineRuntimeBtn');
    const discoveryStatus = document.getElementById('protonDiscoveryStatus');
    const prepare = document.getElementById('prepareProtonEnvironmentBtn'), environment = document.getElementById('protonEnvironmentStatus');
    panel.hidden = !available; panel.dataset.gameId = gameId;
    const token = Symbol('proton-setup'); panel.protonSetupToken = token;
    button.disabled = false; if (wineButton) wineButton.disabled = false; prepare.disabled = true; environment.textContent = '';
    const current = () => panel.dataset.gameId === gameId && panel.protonSetupToken === token;
    let selection = selectedRuntimeId, useDefault = false, windowsGame = false, busy = false, catalogRevision = 0, environmentRevision = 0;
    const refreshEnvironment = async () => {
        const revision = ++environmentRevision, runtimeId = selection;
        prepare.disabled = true;
        if (!runtimeId || runtimeId.startsWith('detected:') || runtimeId.startsWith('wine:')) { environment.textContent = ''; return; }
        try {
            const result = await invoke('proton-environment-status', { gameId, runtimeId });
            if (!current() || revision !== environmentRevision || selection !== runtimeId) return;
            environment.textContent = result.reason;
            prepare.disabled = busy || !result.preparation?.available || typeof getLaunchRequest !== 'function';
            prepare.title = result.preparation?.reason || '';
        } catch (error) { if (current() && revision === environmentRevision) environment.textContent = error.message; }
    };
    const refresh = async () => {
        const revision = ++catalogRevision;
        const result = await invoke('proton-list-runtimes', { gameId });
        if (!current() || revision !== catalogRevision) return;
        select.replaceChildren();
        const native = document.createElement('option'); native.value = ''; native.textContent = windowsGame ? 'Choose Proton or Wine' : 'Native Linux executable'; select.append(native);
        if (useDefault && !selection && result.runtimes.some(runtime => runtime.id === result.defaultRuntimeId && runtime.ready)) {
            selection = result.defaultRuntimeId; useDefault = false;
        }
        for (const runtime of result.runtimes) {
            const option = document.createElement('option'); option.value = runtime.id;
            option.textContent = runtime.label + (runtime.id === result.defaultRuntimeId ? ' (default)' : '') + (runtime.ready ? '' : ' — unavailable'); option.disabled = !runtime.ready; select.append(option);
        }
        const discovery = result.discovery || { proton: [], wine: [], umu: [] };
        for (const runtime of discovery.proton) {
            if (runtime.registeredRuntimeId) continue;
            const option = document.createElement('option'); option.value = 'detected:' + runtime.id;
            option.textContent = runtime.label + ' — detected' + (runtime.available ? '' : ' — unavailable');
            option.title = runtime.reason || runtime.path; option.disabled = !runtime.available; select.append(option);
        }
        for (const runtime of discovery.wine) {
            if (runtime.registeredRuntimeId) continue;
            const option = document.createElement('option'); option.value = 'wine:' + runtime.id;
            option.textContent = 'Wine · ' + runtime.label + (runtime.version ? ' ' + runtime.version : '') + ' — detected';
            option.title = runtime.reason || runtime.path; option.disabled = !runtime.available; select.append(option);
        }
        const toolsMissing = windowsGame && !result.runtimes.some(runtime => runtime.ready);
        const manage = document.getElementById('manageCompatibilityBtn');
        if (manage) manage.textContent = toolsMissing ? 'Set up Windows gaming' : 'Manage compatibility versions';
        if (discoveryStatus) discoveryStatus.textContent = toolsMissing
            ? 'Install UMU and Proton in Windows gaming setup, or select an installed Proton or Wine version.'
            : `${discovery.proton.length} installed Proton version(s) detected. `
            + (discovery.umu.length ? 'UMU launcher found.' : 'UMU launcher not found. Selecting Proton will ask for the separate umu-run file.')
            + (discovery.wine.length ? ` ${discovery.wine.length} Wine installation(s) detected.` : '')
            + (discovery.issueCount ? ' Some runtime folders could not be scanned.' : '');
        if ([...select.options].some(option => option.value === selection)) select.value = selection;
        else if (selection) {
            const option = document.createElement('option'); option.value = selection; option.textContent = 'Previously selected version — unavailable';
            option.disabled = true; select.append(option); select.value = selection;
        }
        status.textContent = result.reason || 'Choose the compatibility version for this game.';
        await refreshEnvironment();
    };
    const register = async (discoveryId, backend = 'proton-umu') => {
        if (busy) return;
        busy = true; button.disabled = true; if (wineButton) wineButton.disabled = true; select.disabled = true; prepare.disabled = true;
        status.textContent = 'Select and approve the compatibility tools for this game…';
        try {
            const result = await invoke(backend === 'wine' ? 'wine-register-runtime' : 'proton-register-runtime', { gameId, ...(discoveryId ? { discoveryId } : {}) });
            if (!current()) return;
            if (!result.canceled) { selection = result.registeredRuntimeId || selection; await refresh(); }
            else { select.value = selection; status.textContent = 'Compatibility selection was not changed.'; }
        } catch (error) {
            if (current()) { select.value = selection; status.textContent = error.message; }
        } finally {
            busy = false;
            if (current()) { button.disabled = false; if (wineButton) wineButton.disabled = false; select.disabled = false; await refreshEnvironment(); }
        }
    };
    select.onchange = async () => {
        if (busy || !current()) return;
        useDefault = false;
        if (select.value.startsWith('detected:')) await register(select.value.slice(9));
        else if (select.value.startsWith('wine:')) await register(select.value.slice(5), 'wine');
        else { selection = select.value; await refreshEnvironment(); }
    };
    button.onclick = () => register();
    if (wineButton) wineButton.onclick = () => register('', 'wine');
    if (panel.compatibilityRefreshListener) document.removeEventListener('sail-compatibility-changed', panel.compatibilityRefreshListener);
    panel.compatibilityRefreshListener = () => { if (current() && !busy) refresh().catch(error => { if (current()) status.textContent = error.message; }); };
    document.addEventListener('sail-compatibility-changed', panel.compatibilityRefreshListener);
    prepare.onclick = async () => {
        if (busy || prepare.disabled) return; busy = true; button.disabled = true; if (wineButton) wineButton.disabled = true; prepare.disabled = true;
        const runtimeId = selection; let failure = '';
        try {
            const saved = await invoke('authority-get-native-setup', { gameId });
            if (!current()) return;
            if (saved.runtimeId !== runtimeId || !['proton-umu', 'wine'].includes(saved.backend)) throw new Error('Update local launch setup with this version before preparing the environment.');
            const request = await getLaunchRequest();
            if (!current() || selection !== runtimeId) return;
            const result = await invoke('proton-prepare-environment', { gameId, ...request });
            if (!current()) return;
            await onPrepared(result);
        } catch (error) { failure = error.message; if (current()) environment.textContent = failure; }
        finally {
            busy = false;
            if (current()) { button.disabled = false; if (wineButton) wineButton.disabled = false; await refreshEnvironment(); if (failure && current()) environment.textContent = failure; }
        }
    };
    if (available) refresh().catch(error => { if (current()) status.textContent = error.message; });
    return { setSelected(id, preferDefault = false) { if (!current() || busy) return; selection = id || ''; useDefault = preferDefault; windowsGame = preferDefault;
        if (available) refresh().catch(error => { if (current()) status.textContent = error.message; }); }, refresh };
}
module.exports = { showProtonSetup };
