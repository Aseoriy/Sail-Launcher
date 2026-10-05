'use strict';

const STATES = new Set(['preparing', 'active', 'cleanup-pending', 'cleanup-failed', 'released']);
const STAGES = ['cUnmounted', 'drainComplete', 'vUnmounted', 'workerReaped', 'keeperReaped'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const ticks = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);

// This is a receipt contract for the future script backend. Only the existing
// authenticated supervisor may attest these stages; renderer input is no proof.
function validScriptLifecycle(receipt, previous, expectedKind) {
    const view = receipt.scriptView;
    const old = previous && previous.scriptView;
    const kind = receipt.executionKind === undefined ? 'elf' : receipt.executionKind;
    if (!['elf', 'script', 'script-native-path'].includes(kind) || (expectedKind && kind !== expectedKind)
        || (previous && kind !== (previous.executionKind || 'elf'))) return false;
    if (kind === 'elf' || kind === 'script-native-path') return view === undefined && !['cleanup-pending', 'cleanup-failed'].includes(receipt.phase);
    if (!view || view.protocol !== 1 || view.viewId !== receipt.sessionId || !STATES.has(view.state)
        || typeof view.gameFinished !== 'boolean' || !integer(view.gameElapsedMs)
        || !integer(view.gameChildren) || !integer(view.cleanupErrno)
        || !integer(view.keeperPid) || !view.keeperPid || !ticks(view.keeperStartTicks)
        || !integer(view.workerPid) || (view.workerPid ? !ticks(view.workerStartTicks) : view.workerStartTicks !== '0')
        || ['workerCode', 'workerSignal', 'keeperCode', 'keeperSignal'].some(key => !integer(view[key]))
        || STAGES.some(stage => typeof view[stage] !== 'boolean')
        || view.keeperPid === receipt.supervisorPid
        || view.keeperPid === receipt.rootPid
        || (view.workerPid && [receipt.supervisorPid, view.keeperPid, receipt.rootPid].includes(view.workerPid))) return false;
    // ownedChildren includes infrastructure. gameChildren never counts it.
    const infrastructure = Number(!view.keeperReaped) + Number(!!view.workerPid && !view.workerReaped);
    if (receipt.ownedChildren !== view.gameChildren + infrastructure
        || (!view.gameFinished && (view.gameElapsedMs !== 0 || STAGES.some(stage => view[stage])))
        || (view.gameFinished && (view.gameChildren !== 0 || view.gameElapsedMs !== receipt.elapsedMs
            || (receipt.execSucceeded && !receipt.rootExited)))
        || (!receipt.execSucceeded && view.gameElapsedMs !== 0)
        || (!view.workerReaped && (view.workerCode || view.workerSignal))
        || (!view.keeperReaped && (view.keeperCode || view.keeperSignal))
        || (!view.cleanupErrno && ((view.drainComplete && !view.cUnmounted) || (view.vUnmounted && !view.drainComplete)
            || (view.workerReaped && view.workerPid && !view.vUnmounted)
            || (view.keeperReaped && (!view.vUnmounted || !view.workerReaped))))) return false;
    if (view.state === 'released') {
        if (!receipt.terminal || !view.gameFinished || view.cleanupErrno || STAGES.some(stage => !view[stage])
            || view.workerCode || view.workerSignal || view.keeperCode || view.keeperSignal) return false;
    } else if (receipt.terminal || (view.keeperReaped && view.state !== 'cleanup-failed')) return false;
    if (view.state === 'cleanup-pending' || view.state === 'cleanup-failed') {
        if (!view.gameFinished || receipt.phase !== view.state
            || (view.state === 'cleanup-failed') !== (view.cleanupErrno > 0)) return false;
    } else if (view.cleanupErrno || ['cleanup-pending', 'cleanup-failed'].includes(receipt.phase)) return false;
    if (['preparing', 'active'].includes(view.state) && view.gameFinished) return false;
    if (view.state === 'active' && (!receipt.execSucceeded || !view.workerPid)) return false;
    if (view.state === 'preparing' && receipt.execSucceeded) return false;
    if (old) {
        if (view.viewId !== old.viewId || view.keeperPid !== old.keeperPid || view.keeperStartTicks !== old.keeperStartTicks
            || (old.workerPid && (view.workerPid !== old.workerPid || view.workerStartTicks !== old.workerStartTicks))
            || (old.gameFinished && (!view.gameFinished || receipt.elapsedMs !== previous.elapsedMs))
            || (previous.execSucceeded && !receipt.execSucceeded)
            || (old.state === 'active' && view.state === 'preparing')
            || STAGES.some(stage => old[stage] && !view[stage])
            || (old.workerReaped && (view.workerCode !== old.workerCode || view.workerSignal !== old.workerSignal))
            || (old.keeperReaped && (view.keeperCode !== old.keeperCode || view.keeperSignal !== old.keeperSignal))
            || (old.cleanupErrno && view.cleanupErrno !== old.cleanupErrno)) return false;
    }
    return true;
}

module.exports = { validScriptLifecycle };
