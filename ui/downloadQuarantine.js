'use strict';

const CANCELLATION_MESSAGES = Object.freeze({
    cancelled_clean: 'Download cancelled. No temporary files were created.',
    cancelled_quarantined: 'Download cancelled. Temporary files were retained in quarantine for safety.',
    already_cancelled: 'This download was already cancelled.',
    cancellation_pending: 'Cancellation requested. Sail is waiting for active download work to stop safely.',
    cleanup_pending: 'Cancellation requested. Sail is waiting for active download work to stop safely.',
    cancellation_refused_unknown_job: 'Sail could not confirm that download job, so no cancellation or cleanup was performed.',
    cancellation_refused_installer_running: 'An external installer is already running. Close or cancel it directly before Sail can finish cancelling this download.',
    cleanup_refused: 'Sail could not prove that the temporary data was safe to quarantine. It was left untouched and cancellation was not reported as complete.'
});

function cancellationMessage(result) {
    const status = result && typeof result.status === 'string' ? result.status : 'cleanup_refused';
    return CANCELLATION_MESSAGES[status] || CANCELLATION_MESSAGES.cleanup_refused;
}

function cancellationPresentation(result) {
    const status = result && typeof result.status === 'string' ? result.status : 'cancellation_refused_unknown_job';
    const refused = status === 'cleanup_refused'
        || status === 'cancellation_refused_unknown_job'
        || status === 'cancellation_refused_installer_running';
    const pending = status === 'cancellation_pending' || status === 'cleanup_pending';
    const completed = status === 'cancelled_clean'
        || status === 'cancelled_quarantined'
        || status === 'already_cancelled';
    return {
        status,
        message: cancellationMessage({ status }),
        title: completed ? 'Download cancelled' : (pending ? 'Cancellation pending' : 'Cancellation not completed'),
        tone: refused ? 'danger' : 'warning',
        completed
    };
}

function formatBytes(value) {
    const bytes = Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = bytes / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit += 1;
    }
    return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
}

function formatQuarantineDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Date unavailable';
}

module.exports = {
    CANCELLATION_MESSAGES,
    cancellationMessage,
    cancellationPresentation,
    formatBytes,
    formatQuarantineDate
};
