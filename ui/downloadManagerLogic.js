'use strict';

const ACTIVE_DOWNLOAD_STATES = Object.freeze([
    'queued',
    'resolving',
    'starting',
    'downloading',
    'processing',
    'installing'
]);

function asDownloadArray(downloads) {
    if (!downloads) return [];
    if (typeof downloads.values === 'function') return Array.from(downloads.values());
    return Array.isArray(downloads) ? downloads : Array.from(downloads);
}

function isDownloadSlotActive(download) {
    return !!download && ACTIVE_DOWNLOAD_STATES.includes(download.state);
}

function isBulkRetryableDownload(download) {
    return !!download
        && download.state === 'error'
        && !!download.resumeOpts
        && !download.browserCapture
        && !download.needsBrowser
        && !download.requiresUserAction;
}

function countActiveDownloadSlots(downloads) {
    return asDownloadArray(downloads).filter(isDownloadSlotActive).length;
}

function planBulkRetry(downloads, maxConcurrent = 3) {
    const all = asDownloadArray(downloads);
    const limitValue = Number(maxConcurrent);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(10, Math.floor(limitValue))) : 3;
    const retryable = all.filter(isBulkRetryableDownload);
    const available = Math.max(0, limit - countActiveDownloadSlots(all));
    return {
        limit,
        retryable,
        start: retryable.slice(0, available),
        queued: retryable.slice(available),
        skipped: all.filter(download => download && download.state === 'error' && !isBulkRetryableDownload(download))
    };
}

function clearCompletedHistory(history) {
    return (Array.isArray(history) ? history : []).filter(entry => entry && entry.state && entry.state !== 'done');
}

function removeCompletedQueueEntries(downloads) {
    return asDownloadArray(downloads).filter(download => !download || download.state !== 'done');
}

function matchesDownloadSearch(download, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return true;
    const fields = [
        download && download.name,
        download && download.category,
        download && download.sourceId,
        download && download.error,
        download && download.label,
        download && download.fileName
    ];
    return fields.some(value => String(value || '').toLowerCase().includes(needle));
}

function safeDownloadErrorMessage(download) {
    if (download && download.needsBrowser) {
        return 'This host needs a browser step before the download can continue.';
    }
    const raw = download && download.error ? String(download.error) : '';
    const sanitized = raw
        .replace(/https?:\/\/[^\s]+/gi, 'the remote host')
        .replace(/[A-Za-z]:[\\/][^\s,;)]*/g, 'a local file')
        .replace(/\b(?:access|refresh|api)[-_ ]?token\b\s*[:=]?\s*[^\s,;]+/gi, 'account credentials')
        .replace(/\bauthorization\b\s*[:=]?\s*bearer\s+[^\s,;]+/gi, 'account credentials')
        .replace(/\bbearer\s+[^\s,;]+/gi, 'account credentials')
        .replace(/\bauthorization\b\s*[:=]?\s*[^\s,;]+/gi, 'account credentials')
        .replace(/\b(?:password|api[-_ ]?key|client[-_ ]?secret)\b\s*[:=]\s*[^\s,;]+/gi, 'account credentials')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
    if (/not enough disk|disk space/i.test(raw)) return 'There is not enough disk space to finish this download.';
    if (/404|file no longer exists|no longer has this file/i.test(raw)) return 'The file is no longer available on that host.';
    if (/captcha|verification|cloudflare|browser/i.test(raw)) return 'This host needs a browser step before the download can continue.';
    // TorBox already supplies a bounded, actionable provider error. Keep that context
    // instead of collapsing a TorBox API timeout into the generic transfer message.
    if (/^TorBox\b/i.test(sanitized)) return sanitized;
    if (/timed? ?out|network|connection|ECONN|ENOTFOUND|EAI_AGAIN/i.test(raw)) return 'The connection was interrupted while downloading.';
    return sanitized || 'The download failed before it could finish.';
}

function downloadErrorNextStep(download) {
    if (download && download.needsBrowser) return 'Open in Browser to complete the host check, then try the download again.';
    if (/disk space/i.test(String(download && download.error || ''))) return 'Free up space, then use Retry to resume the download.';
    if (/404|no longer available/i.test(safeDownloadErrorMessage(download))) return 'Choose another host or open the game page for a fresh link.';
    return 'Use Retry to try the existing resume options, or open the game page and choose another host.';
}

module.exports = {
    ACTIVE_DOWNLOAD_STATES,
    clearCompletedHistory,
    countActiveDownloadSlots,
    downloadErrorNextStep,
    isBulkRetryableDownload,
    isDownloadSlotActive,
    matchesDownloadSearch,
    planBulkRetry,
    removeCompletedQueueEntries,
    safeDownloadErrorMessage
};
