'use strict';
function installLinuxDownloads({ document, ipc, invoke, ready, onChanged, notice, getRuntimeId, getScope, onImport }) {
    const states = new Map(); let available = false, timer = null, refreshing = false, configuring = false;
    const panel = document.getElementById('linuxDownloadedGamePanel'), button = document.getElementById('configureLinuxDownloadedGame');
    const status = document.getElementById('linuxDownloadedGameStatus'), imports = document.getElementById('importLinuxGameArchive');
    const retained = document.getElementById('linuxRetainedDownloads');
    let visibleGame = '';
    const label = state => ({ ready: 'Ready to Play', installing: 'Installing…', 'installation-required': 'Installation required',
        interrupted: 'Setup interrupted', saved: 'Files saved', failed: 'Download failed', canceled: 'Download stopped' }[state?.phase] || 'Setup required');
    function render() {
        const state = states.get(visibleGame); panel.hidden = !available || !state;
        button.disabled = configuring || state?.phase === 'installing';
        button.textContent = state?.phase === 'ready' ? 'Scan downloaded game again' : 'Finish downloaded game setup';
        status.textContent = state ? label(state) : ''; status.title = state?.error || state?.detail || '';
    }
    async function configure(gameId, afterInstallation = false) {
        if (configuring) return;
        configuring = true; render();
        try {
            const result = await invoke('linux-download-configure', { gameId, afterInstallation,
                ...(visibleGame === gameId && getRuntimeId() ? { runtimeId: getRuntimeId() } : {}) });
            if (!result.canceled) { states.set(gameId, result); await onChanged(result); }
        } catch (error) { notice(error.message); }
        finally { configuring = false; await refresh().catch(error => notice(error.message)); render(); }
    }
    async function refresh() {
        if (!available || !getScope() || refreshing) return;
        refreshing = true;
        try {
            const result = await invoke('linux-download-list'), currentScope = getScope();
            if (currentScope && currentScope !== `${result.scope.profileId}:${result.scope.libraryId}`) { setTimeout(() => refresh().catch(error => notice(error.message)), 0); return; }
            const rows = result.downloads; const previous = new Map(states);
            states.clear(); retained.replaceChildren();
            for (const row of rows) {
                if (row.gameId) states.set(String(row.gameId), row);
                else if (row.phase !== 'canceled') {
                    const item = document.createElement('div'); item.style.cssText = 'display:flex;gap:10px;align-items:center;margin-top:8px;';
                    const text = document.createElement('span'); text.textContent = `${row.gameName} · ${label(row)}`; text.title = row.error || '';
                    const open = document.createElement('button'); open.className = 'outline'; open.textContent = 'Open saved files';
                    open.onclick = () => invoke('linux-download-open', { id: row.id }).catch(error => notice(error.message));
                    item.append(text, open);
                    if (row.canAdopt) {
                        const finish = document.createElement('button'); finish.className = 'outline'; finish.textContent = 'Finish setup';
                        finish.onclick = async () => { finish.disabled = true; try { const result = await invoke('linux-download-adopt', { id: row.id }); await onChanged(result); await refresh(); } catch (error) { notice(error.message); } finally { finish.disabled = false; } };
                        item.append(finish);
                    }
                    retained.append(item);
                }
            }
            retained.hidden = !retained.childElementCount; render();
            onChanged();
            const completed = rows.find(row => row.gameId && previous.get(String(row.gameId))?.phase === 'installing'
                && row.installation?.phase === 'completed' && row.phase === 'installation-required');
            if (completed && !configuring) setTimeout(() => configure(String(completed.gameId), true), 0);
            if (timer) clearTimeout(timer);
            timer = rows.some(row => row.phase === 'installing') ? setTimeout(() => refresh().catch(error => notice(error.message)), 1500) : null;
        } finally { refreshing = false; }
    }
    button.onclick = () => configure(visibleGame);
    imports.onclick = () => onImport().catch(error => notice(error.message));
    ipc.on('linux-download-state', (_event, result) => {
        if (!available || (getScope() && result.state && getScope() !== `${result.state.activeProfileId}:${result.state.activeLibraryId}`)) return;
        states.set(String(result.gameId), result); onChanged(result); render(); refresh().catch(error => notice(error.message));
    });
    ready.then(support => {
        available = support.platform === 'linux' && support.features.downloads.available;
        document.getElementById('linuxArchiveImportControls').style.display = available ? 'flex' : 'none';
        imports.hidden = !available; document.getElementById('linuxDownloadHint').hidden = !available; document.getElementById('linuxArchiveGameName').hidden = !available;
        if (available) refresh().catch(error => notice(error.message));
    });
    return { refresh, showGame(gameId) { visibleGame = String(gameId); render(); refresh().catch(error => notice(error.message)); },
        state: gameId => states.get(String(gameId)), label };
}
module.exports = { installLinuxDownloads };
