'use strict';

const TARGETING_MIN_VERSION = '5.2.1';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

function normalizeLauncherVersion(value) {
    return String(value || '').trim().replace(/^v/i, '');
}

function splitVersion(value) {
    const normalized = normalizeLauncherVersion(value);
    const [release, ...suffixParts] = normalized.split('-');
    return {
        normalized,
        release: release.split('.').map(part => Number(part)),
        suffix: suffixParts.length ? suffixParts.join('-') : null
    };
}

function compareLauncherVersions(left, right) {
    const a = splitVersion(left);
    const b = splitVersion(right);
    for (let index = 0; index < Math.max(a.release.length, b.release.length, 3); index++) {
        const av = Number.isFinite(a.release[index]) ? a.release[index] : 0;
        const bv = Number.isFinite(b.release[index]) ? b.release[index] : 0;
        if (av !== bv) return av > bv ? 1 : -1;
    }
    if (!a.suffix && !b.suffix) return 0;
    if (!a.suffix) return 1;
    if (!b.suffix) return -1;
    return a.suffix.localeCompare(b.suffix, undefined, { numeric: true, sensitivity: 'base' });
}

function isTargetingCapableVersion(value) {
    const normalized = normalizeLauncherVersion(value);
    if (!VERSION_PATTERN.test(normalized)) return false;
    const core = normalized.split('-')[0];
    return compareLauncherVersions(core, TARGETING_MIN_VERSION) >= 0;
}

function targetsLauncherVersion(targets, version) {
    const normalized = normalizeLauncherVersion(version);
    return Array.isArray(targets) && targets.some(target => normalizeLauncherVersion(target) === normalized);
}

function updateDecision(latest, current, forceInstall = false) {
    const comparison = compareLauncherVersions(latest, current);
    if (forceInstall) return { comparison, action: comparison < 0 ? 'downgrade' : 'install' };
    return { comparison, action: comparison > 0 ? 'update' : 'up-to-date' };
}

function parseVersionTargets(values) {
    const rawValues = Array.isArray(values) ? values : String(values || '').split(/[\s,]+/);
    const versions = [];
    const invalid = [];
    const unsupported = [];
    const duplicates = [];
    const seen = new Set();

    for (const raw of rawValues) {
        const normalized = normalizeLauncherVersion(raw);
        if (!normalized) continue;
        if (!VERSION_PATTERN.test(normalized)) {
            invalid.push(String(raw).trim());
            continue;
        }
        if (!isTargetingCapableVersion(normalized)) {
            unsupported.push(normalized);
            continue;
        }
        if (seen.has(normalized)) duplicates.push(normalized);
        else {
            seen.add(normalized);
            versions.push(normalized);
        }
    }

    return { versions, invalid, unsupported, duplicates };
}

function announcementKey(source, id) {
    return `${source === 'version' ? 'version' : 'global'}:${String(id)}`;
}

function isAnnouncementDismissed(dismissed, source, id) {
    const values = Array.isArray(dismissed) ? dismissed.map(String) : [];
    const key = announcementKey(source, id);
    return values.includes(key) || (source === 'global' && values.includes(String(id)));
}

function selectLatestAnnouncement(globalRows, versionRows) {
    const candidates = [];
    if (Array.isArray(globalRows)) {
        globalRows.forEach(row => candidates.push({ ...row, _source: 'global' }));
    }
    if (Array.isArray(versionRows)) {
        versionRows.forEach(row => candidates.push({ ...row, _source: 'version' }));
    }
    candidates.sort((a, b) => {
        const bt = Date.parse(b.created_at || 0) || 0;
        const at = Date.parse(a.created_at || 0) || 0;
        return bt - at;
    });
    return candidates[0] || null;
}

function safeHttpUrl(value) {
    if (!value) return null;
    try {
        const parsed = new URL(String(value));
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch (_) {
        return null;
    }
}

module.exports = {
    TARGETING_MIN_VERSION,
    VERSION_PATTERN,
    normalizeLauncherVersion,
    compareLauncherVersions,
    isTargetingCapableVersion,
    targetsLauncherVersion,
    updateDecision,
    parseVersionTargets,
    announcementKey,
    isAnnouncementDismissed,
    selectLatestAnnouncement,
    safeHttpUrl
};
