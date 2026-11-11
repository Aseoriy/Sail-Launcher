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

// A pre-release build (6.0.0-beta.3) always looks at pre-releases too; otherwise GitHub's
// "latest" is the last stable release and a beta would never be offered the next beta.
function includesPrereleases(currentVersion, betaUpdatesSetting) {
    return !!betaUpdatesSetting || splitVersion(currentVersion).suffix !== null;
}

// The highest-versioned published release (GitHub lists by creation date, so a later
// stable hotfix would otherwise hide a newer beta).
// Versions that have an active rollback are skipped, and a stable channel skips pre-releases.
function newestRelease(releases, { withdrawn = [], prereleases = true } = {}) {
    const skip = new Set((Array.isArray(withdrawn) ? withdrawn : []).map(normalizeLauncherVersion));
    const published = (Array.isArray(releases) ? releases : []).filter(item => item && !item.draft
        && (prereleases || !item.prerelease)
        && VERSION_PATTERN.test(normalizeLauncherVersion(item.tag_name))
        && !skip.has(normalizeLauncherVersion(item.tag_name)));
    return published.sort((a, b) => compareLauncherVersions(b.tag_name, a.tag_name))[0] || null;
}

// Every version an active rollback moves people away from: no launcher offers those as an update.
function withdrawnVersions(directives) {
    const versions = new Set();
    (Array.isArray(directives) ? directives : []).forEach(row => {
        if (row && row.active !== false && row.kind === 'rollback' && Array.isArray(row.from_versions)) {
            row.from_versions.forEach(version => versions.add(normalizeLauncherVersion(version)));
        }
    });
    return Array.from(versions);
}

// The rollback or re-update this launcher should offer, or null.
// handled: re-update ids already reinstalled here. firstSeenAt: when this version first opened here (ms);
// a copy installed after the re-update was published already has the fixed build.
function selectUpdateDirective(directives, currentVersion, { handled = [], firstSeenAt = null } = {}) {
    const current = normalizeLauncherVersion(currentVersion);
    const done = new Set((Array.isArray(handled) ? handled : []).map(String));
    const candidates = (Array.isArray(directives) ? directives : []).filter(row => {
        if (!row || row.active === false || !targetsLauncherVersion(row.from_versions, current)) return false;
        if (row.kind === 'rollback') {
            const target = normalizeLauncherVersion(row.target_version);
            return VERSION_PATTERN.test(target) && target !== current;
        }
        if (row.kind !== 'reupdate' || done.has(String(row.id))) return false;
        const publishedAt = Date.parse(row.created_at || '') || 0;
        return !(Number.isFinite(firstSeenAt) && firstSeenAt > publishedAt);
    });
    // A rollback always wins over a re-update; otherwise the newest one.
    candidates.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'rollback' ? -1 : 1)
        || (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0));
    return candidates[0] || null;
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
    includesPrereleases,
    newestRelease,
    withdrawnVersions,
    selectUpdateDirective,
    parseVersionTargets,
    announcementKey,
    isAnnouncementDismissed,
    selectLatestAnnouncement,
    safeHttpUrl
};
