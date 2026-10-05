'use strict';
function showProtonLaunchLog({ document, gameId, invoke, available }) {
    const panel = document.getElementById('protonLaunchLogPanel'), button = document.getElementById('viewProtonLaunchLog');
    const hint = document.getElementById('protonLaunchLogHint'), output = document.getElementById('protonLaunchLogText');
    panel.hidden = !available; output.hidden = true; output.textContent = ''; hint.textContent = ''; button.disabled = false;
    const token = Symbol('launch-log'); panel.launchLogToken = token;
    button.onclick = async () => {
        button.disabled = true;
        try {
            const result = await invoke('proton-launch-log', { gameId });
            if (panel.launchLogToken !== token) return;
            hint.textContent = result.hint; output.textContent = result.text || ''; output.hidden = !result.text;
            button.textContent = 'Refresh launch log';
        } catch (error) { if (panel.launchLogToken === token) hint.textContent = error.message; }
        finally { if (panel.launchLogToken === token) button.disabled = false; }
    };
    button.textContent = 'View launch log';
}
module.exports = { showProtonLaunchLog };
