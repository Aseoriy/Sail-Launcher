'use strict';

function showProtonSaves({ document, gameId, invoke, available }) {
    const panel = document.getElementById('protonSavesPanel'), status = document.getElementById('protonSavesStatus');
    const select = document.getElementById('protonSaveSelect'), check = document.getElementById('checkProtonSavesBtn');
    const button = document.getElementById('importProtonSaveBtn');
    // Only a Windows game has a separate save folder to import into; the panel stays hidden until that is known.
    const token = Symbol('proton-saves'); panel.saveToken = token; panel.hidden = true;
    let windowsGame = false;
    const current = () => panel.saveToken === token;
    let busy = false;
    async function refresh() {
        if (!available || !windowsGame || busy) return;
        busy = true; check.disabled = true; button.disabled = true; status.textContent = 'Checking Steam saves…';
        try {
            const result = await invoke('proton-save-status', { gameId });
            if (!current()) return;
            select.replaceChildren();
            for (const candidate of result.candidates) {
                const option = document.createElement('option'); option.value = candidate.id;
                option.textContent = candidate.label + (candidate.busy ? ' — game active' : ''); option.disabled = candidate.busy; select.append(option);
            }
            select.hidden = !result.candidates.length;
            if (result.candidates.some(item => !item.busy)) select.value = result.candidates.find(item => !item.busy).id;
            status.textContent = result.busy ? 'Close the game in Sail before importing a save.' : result.reason;
            button.disabled = result.busy || !result.candidates.some(item => !item.busy);
        } catch (error) { if (current()) status.textContent = error.message; }
        finally { busy = false; if (current()) check.disabled = false; }
    }
    check.onclick = refresh;
    button.onclick = async () => {
        if (busy || button.disabled || !select.value) return;
        busy = true; button.disabled = true; check.disabled = true;
        try {
            const result = await invoke('proton-import-save', { gameId, candidateId: select.value });
            if (!current()) return;
            status.textContent = result.canceled ? 'Import canceled.' : result.reason + (result.backup ? ` Previous save backup: ${result.backup}` : '');
            button.disabled = !!result.imported;
        } catch (error) { if (current()) { status.textContent = error.message; button.disabled = false; } }
        finally { busy = false; if (current()) check.disabled = false; }
    };
    function setWindowsGame(value) {
        if (!current()) return;
        windowsGame = !!value; panel.hidden = !available || !windowsGame;
        if (!panel.hidden) refresh();
    }
    return { refresh, setWindowsGame };
}

module.exports = { showProtonSaves };
