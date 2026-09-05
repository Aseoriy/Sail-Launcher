'use strict';

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
// TorBox calls this 100 GB; its public hoster API reports this limit in bytes.
const TORBOX_WEB_LIMIT_BYTES = 100 * 1024 ** 3;

function formatBytes(value, options = {}) {
    const unknown = options.unknown === undefined ? 'Unknown' : String(options.unknown);
    const decimals = Number.isInteger(options.decimals) ? Math.min(20, Math.max(0, options.decimals)) : 1;
    if (typeof value === 'boolean' || value === null || value === undefined) return unknown;
    if (typeof value === 'string' && !value.trim()) return unknown;
    const numeric = typeof value === 'number' ? value : (typeof value === 'string' && /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(value) ? Number(value) : NaN);
    if (!Number.isFinite(numeric) || numeric < 0) return unknown;
    let bytes = numeric;
    if (bytes === 0) return '0 B';
    let unit = 0;
    while (bytes >= 1024 && unit < UNITS.length - 1) { bytes /= 1024; unit++; }
    const digits = unit === 0 ? 0 : decimals;
    return `${bytes.toFixed(digits)} ${UNITS[unit]}`;
}

function normalizedNumber(value) {
    let text = String(value || '').trim();
    if (!text) return NaN;
    if (text.includes(',') && text.includes('.')) text = text.replace(/,/g, '');
    else if (/^\d{1,3}(?:,\d{3})+$/.test(text)) text = text.replace(/,/g, '');
    else text = text.replace(',', '.');
    return Number(text);
}

function parseSize(value) {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(/^((?:[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:[.,][0-9]+)?))\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i);
    if (!match) return null;
    const amount = normalizedNumber(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const unit = match[2].toUpperCase();
    const binary = /^KI|^MI|^GI|^TI/.test(unit);
    const index = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, KIB: 1, MIB: 2, GIB: 3, TIB: 4 }[unit];
    const base = binary ? 1024 : 1000;
    const bytes = amount * (index ? base ** index : 1);
    if (!Number.isFinite(bytes) || bytes > Number.MAX_SAFE_INTEGER) return null;
    return { bytes, label: `${match[1]} ${match[2]}` };
}

const LABELS = ['Download Size', 'Repack Size', 'Archive Size', 'Compressed Size', 'File Size', 'Game Size'];
const LABEL_RE = new RegExp(`(?:^|[\\n\\r;|])\\s*(${LABELS.map(label => label.replace(/ /g, '\\s+')).join('|')})\\s*[:\\-]?\\s*([^\\n\\r;|]+)`, 'ig');
const VALUE_RE = /^(?:~|approx(?:imately)?\.?\s+|from\s+)?(?:[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:[.,][0-9]+)?)\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?(?:\s*(?:-|–|—|to)\s*(?:[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:[.,][0-9]+)?)\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB))?$/i;

function sourceDownloadSize(text, options = {}) {
    const candidates = [];
    const input = String(text || '');
    for (const match of input.matchAll(LABEL_RE)) {
        const kind = match[1].replace(/\s+/g, ' ');
        const gameSize = /^game size$/i.test(kind);
        if (gameSize && !options.allowGameSize) continue;
        const value = match[2].trim();
        const note = value.match(/\s+(\([^()\n]{1,100}\)|\[[^\[\]\n]{1,100}\])$/);
        const raw = note ? value.slice(0, note.index).trim() : value;
        if (note && /\b(?:RAM|storage|installed|disk space)\b/i.test(note[1])) continue;
        if (!VALUE_RE.test(raw) || !/[KMGT]?i?B$/i.test(raw)) continue;
        const normalized = raw.replace(/\s+/g, ' ').trim();
        const ranged = /\bfrom\b|[\d.,]+\s*(?:-|–|—|to)\s*[\d.,]+/i.test(normalized);
        const approximate = /^(?:~|approx)/i.test(normalized);
        const exactText = normalized.replace(/^(?:~|approx(?:imately)?\.?|from)\s*/i, '');
        const parsed = !ranged && !approximate && !note && !gameSize ? parseSize(exactText) : null;
        candidates.push({
            priority: LABELS.findIndex(item => item.toLowerCase() === match[1].replace(/\s+/g, ' ').toLowerCase()),
            bytes: parsed && parsed.bytes,
            label: normalized + (note ? ' ' + note[1] : ''),
            kind
        });
    }
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length ? { bytes: candidates[0].bytes === undefined ? null : candidates[0].bytes, label: candidates[0].label, kind: candidates[0].kind } : null;
}

function aggregateDownloadSizes(values) {
    const entries = Array.isArray(values) ? values : [];
    if (!entries.length || entries.some(entry => !entry || entry.status === 'down')) return null;
    if (entries.every(entry => Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes > 0)) {
        const bytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
        if (!Number.isSafeInteger(bytes)) return null;
        return { bytes, label: formatBytes(bytes) };
    }
    if (entries.length === 1 && entries[0] && entries[0].sizeLabel) {
        const parsed = parseSize(String(entries[0].sizeLabel).trim());
        if (parsed) return { bytes: null, label: parsed.label, hostReported: true };
    }
    const reported = entries.map(entry => Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes > 0
        ? entry.sizeBytes : (parseSize(entry.sizeLabel) || {}).bytes);
    if (reported.every(bytes => Number.isFinite(bytes) && bytes > 0 && bytes <= Number.MAX_SAFE_INTEGER)) {
        const total = reported.reduce((sum, bytes) => sum + bytes, 0);
        // Rounded host labels give an estimate, never an exact total or ETA.
        if (total <= Number.MAX_SAFE_INTEGER) return { bytes: null, label: '~' + formatBytes(total), hostReported: true };
    }
    return null;
}

function estimateDownloadTime(size, bytesPerSecond = 10e6) {
    const bytes = size && size.bytes !== null && size.bytes !== undefined ? Number(size.bytes) : NaN;
    const rate = Number(bytesPerSecond);
    if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(rate) || rate <= 0) return '';
    const rateLabel = `${(rate / 1e6).toFixed(rate % 1e6 ? 1 : 0)} MB/s`;
    const seconds = bytes / rate;
    if (seconds < 60) return `~${Math.max(1, Math.round(seconds))}s at ${rateLabel}`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `~${minutes} min at ${rateLabel}`;
    return `~${(minutes / 60).toFixed(1)} h at ${rateLabel}`;
}

// A reported/rounded size is useful for a warning, but still isn't an exact ETA.
function downloadSizeBytes(value) {
    if (value && typeof value === 'object') {
        return downloadSizeBytes(value.bytes) || downloadSizeBytes(value.label);
    }
    const bytes = typeof value === 'number' ? value
        : typeof value === 'string' ? (parseSize(value.replace(/^~\s*/, '')) || {}).bytes : null;
    return Number.isFinite(bytes) && bytes > 0 && bytes <= Number.MAX_SAFE_INTEGER ? Math.round(bytes) : null;
}

function downloadSizeMismatch(reportedBytes, actualBytes, approvedBytes = 0) {
    const reported = downloadSizeBytes(reportedBytes);
    const actual = downloadSizeBytes(actualBytes);
    if (!reported || !actual || actual >= reported * 0.75) return null;
    const approved = downloadSizeBytes(approvedBytes);
    // aria2 rounds its totals. Keep consent for that same file, but ask again if
    // a refreshed link becomes materially smaller than the file the user approved.
    if (approved && actual >= approved * 0.9) return null;
    return { reportedBytes: reported, actualBytes: actual };
}

function torboxSizeWarning(service, links) {
    if (String(service || '').trim().toLowerCase() !== 'torbox' || !Array.isArray(links)) return '';
    const oversized = links.some(link => {
        if (!link || link.status === 'down') return false;
        let url;
        try { url = new URL(link.url); } catch (_) { return false; }
        if (!/^https?:$/.test(url.protocol) || /\.torrent$/i.test(url.pathname)
            || /(^|\.)(?:1337x\.(?:to|st|gd|is|tw|ws)|rutor\.info)$/i.test(url.hostname)) return false;
        const label = parseSize(link.sizeLabel);
        const bytes = Number.isSafeInteger(link.sizeBytes) && link.sizeBytes > 0
            ? link.sizeBytes : label && label.bytes;
        return Number.isFinite(bytes) && bytes > TORBOX_WEB_LIMIT_BYTES;
    });
    // Each source link becomes a separate web job: do not sum split links here.
    return oversized ? 'TorBox doesn’t support web links over 100 GB. Try a smaller link or download without TorBox.' : '';
}

module.exports = { aggregateDownloadSizes, estimateDownloadTime, formatBytes, parseSize, sourceDownloadSize, torboxSizeWarning, downloadSizeBytes, downloadSizeMismatch };
