'use strict';

function sessionStatus(session, pending = false) {
    if (!session) return { label: pending ? 'Saving playtime…' : '', detail: '' };
    const state = session.native;
    const windows = ['proton-umu', 'wine'].includes(state.runtime?.backend);
    const preparing = windows && state.runtime.activity === 'preparation';
    const installing = windows && state.runtime.activity === 'installation';
    const counting = !windows || state.gameConfirmed && !state.gameTrackingError;
    const phase = state.phase;
    let label = 'Starting…';
    if (installing) label = 'Installing…';
    else if (preparing) label = 'Preparing…';
    else if (['running', 'root-exited-descendants-running'].includes(phase)) {
        label = windows && !state.gameConfirmed ? 'Starting…' : windows && !state.gameActiveProcesses ? 'Finishing…' : 'Running';
        if (label === 'Running' && counting) {
            const seconds = Math.floor((state.elapsedMs || 0) / 1000);
            label += ` · ${seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm'}`;
        }
    }
    if (phase === 'stopping') label = 'Stopping…';
    if (phase === 'cleanup-pending') label = 'Finishing…';
    if (['tracking-lost', 'cleanup-failed'].includes(phase) || state.gameTrackingError) label = 'Tracking unavailable';
    const detail = phase.startsWith('cleanup-') ? 'Script cleanup is pending or failed. Playtime is frozen until cleanup is resolved.'
        : installing ? 'A Windows installer is running in this game’s environment. Installation time is not counted as playtime.'
        : windows && !counting ? 'Waiting for confirmed game startup. Playtime is not being counted.'
        : 'Playtime counts confirmed game activity; launcher startup and cleanup are excluded.';
    return { label, detail: state.gameTrackingError ? `Gameplay tracking failed (code ${state.gameTrackingError}). Playtime is frozen.` : state.error || detail };
}

module.exports = { sessionStatus };
