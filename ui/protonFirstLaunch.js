'use strict';
function createProtonFirstLaunch({ invoke, getSetup, getAuthority, getScope, launch, configure, manage, changed, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const operations = new Map();
    const key = gameId => `${getScope()}:${gameId}`;
    const label = gameId => { const operation = operations.get(key(gameId)); return operation && !operation.launching ? operation.label : ''; };
    const update = (operation, value) => { operation.label = value; changed(); };
    const current = operation => {
        if (getScope() !== operation.scope) throw Error('The active library changed. Click Play in the original library to continue.');
        if (operation.canceled) throw Error('First-launch setup was canceled. Existing files were kept.');
    };
    async function stop(operation) {
        current({ ...operation, canceled: false });
        const status = await invoke('proton-installation-status', { gameId: operation.gameId });
        if (status.online?.job?.id !== operation.jobId) throw Error('The setup job changed. Open Manage Game to review its current status.');
        if (['checking', 'downloading', 'extracting', 'queuing'].includes(status.online.job.phase)) {
            await invoke('proton-cancel-online-prerequisites', { gameId: operation.gameId, jobId: operation.jobId });
        } else if (status.online.job.phase === 'installing' && status.job && ['checking', 'starting', 'running', 'waiting', 'tracking-lost'].includes(status.job.phase)) {
            const permission = await getAuthority(operation.game, 'terminate');
            await invoke('proton-installation-cancel', { gameId: operation.gameId, jobId: status.job.id, ...permission });
        }
    }
    async function cancel(gameId) {
        const operation = operations.get(key(gameId)); if (!operation || operation.stopping || operation.launching) return;
        operation.canceled = true; operation.stopping = true; update(operation, 'Canceling setup…');
        try { if (operation.jobId) await stop(operation); }
        finally { operation.stopping = false; changed(); }
    }
    async function play(game) {
        const id = String(game.id), operationKey = key(id);
        if (operations.has(operationKey)) return;
        const operation = { game, gameId: id, scope: getScope(), label: 'Checking setup…', jobId: '', canceled: false, stopping: false };
        operations.set(operationKey, operation); changed();
        try {
            if (!await configure(game)) return;
            current(operation); const setup = await getSetup(id); current(operation);
            if (!['proton-umu', 'wine'].includes(setup.backend)) { operations.delete(operationKey); changed(); return launch(game); }
            await getAuthority(game, 'launch'); current(operation);
            const plan = await invoke('proton-first-launch-plan', { gameId: id }); current(operation);
            if (plan.busy) throw Error(plan.reason);
            if (plan.available && plan.reviewRequired) {
                update(operation, 'Review setup…'); const permission = await getAuthority(game, 'launch'); current(operation);
                const result = await invoke('proton-first-launch-begin', { gameId: id, fingerprint: plan.fingerprint, ...permission });
                if (result.job) operation.jobId = result.job.id;
                if (operation.canceled) { if (operation.jobId) await stop(operation); return; }
                current(operation); if (result.canceled) return;
                if (result.manage) { await manage(game); return; }
                if (operation.jobId) {
                    const deadline = Date.now() + 40 * 60 * 1000;
                    while (true) {
                        current(operation);
                        const status = await invoke('proton-installation-status', { gameId: id }); current(operation);
                        const job = status.online?.job;
                        if (!job || job.id !== operation.jobId) throw Error('The setup job changed. Open Manage Game before playing.');
                        if (job.phase === 'completed') break;
                        if (['failed', 'canceled', 'interrupted'].includes(job.phase)) throw Error(job.error || 'Setup did not finish. Click Play to review or retry.');
                        if (Date.now() > deadline) throw Error('Setup is taking longer than expected. Open Manage Game to check or cancel it.');
                        const titles = { checking: 'Checking requirements…', downloading: 'Downloading components…', extracting: 'Preparing DirectX…', queuing: 'Starting installation…', installing: 'Installing components…' };
                        update(operation, titles[job.phase] || 'Setting up…'); await delay(750);
                    }
                    const fresh = await invoke('proton-first-launch-plan', { gameId: id }); current(operation);
                    if (fresh.fingerprint !== result.fingerprint || fresh.reviewRequired || fresh.busy || !fresh.completed) throw Error('Setup could not be confirmed. Open Manage Game to check components before playing.');
                }
            }
            current(operation); operation.launching = true; changed();
            // A fresh launch capability is obtained by the existing launch path.
            // No authority or automatic launch intent survives renderer restart.
            await launch(game);
        } finally { operations.delete(operationKey); changed(); }
    }
    return { play, cancel, label, active: gameId => { const operation = operations.get(key(String(gameId))); return !!operation && !operation.launching; } };
}
module.exports = { createProtonFirstLaunch };
