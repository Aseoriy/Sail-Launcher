'use strict';

const MANIFEST_SCHEMA_VERSION = 2;

const Severity = Object.freeze({
    HEALTHY: 'healthy',
    INFORMATION: 'information',
    WARNING: 'warning',
    ERROR: 'error',
    CRITICAL: 'critical'
});

const severityRank = Object.freeze({
    [Severity.HEALTHY]: 0,
    [Severity.INFORMATION]: 1,
    [Severity.WARNING]: 2,
    [Severity.ERROR]: 3,
    [Severity.CRITICAL]: 4
});

const IssueCode = Object.freeze({
    INSTALL_DIR_MISSING: 'INSTALL_DIR_MISSING',
    INSTALL_DIR_INACCESSIBLE: 'INSTALL_DIR_INACCESSIBLE',
    EXECUTABLE_MISSING: 'EXECUTABLE_MISSING',
    EXECUTABLE_INVALID: 'EXECUTABLE_INVALID',
    EXECUTABLE_MOVED: 'EXECUTABLE_MOVED',
    MANIFEST_MISSING: 'MANIFEST_MISSING',
    MANIFEST_UNREADABLE: 'MANIFEST_UNREADABLE',
    MANIFEST_OUTDATED: 'MANIFEST_OUTDATED',
    INSTALL_MOVED: 'INSTALL_MOVED',
    MANIFEST_FILE_MISSING: 'MANIFEST_FILE_MISSING',
    MANIFEST_FILE_CHANGED: 'MANIFEST_FILE_CHANGED',
    HASH_MISMATCH: 'HASH_MISMATCH',
    EXTRACTION_REMNANT: 'EXTRACTION_REMNANT',
    TEMP_INSTALL_FILE: 'TEMP_INSTALL_FILE',
    MULTIPART_ARCHIVE_LEFTOVER: 'MULTIPART_ARCHIVE_LEFTOVER',
    FAILED_DOWNLOAD_FRAGMENT: 'FAILED_DOWNLOAD_FRAGMENT',
    SAVE_FOLDER_MISSING: 'SAVE_FOLDER_MISSING',
    SAVE_FOLDER_INACCESSIBLE: 'SAVE_FOLDER_INACCESSIBLE',
    LOW_DISK_SPACE: 'LOW_DISK_SPACE',
    MODIFICATION_CONFLICT: 'MODIFICATION_CONFLICT',
    DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
    DEPENDENCY_UNCERTAIN: 'DEPENDENCY_UNCERTAIN',
    PATH_ESCAPE_SKIPPED: 'PATH_ESCAPE_SKIPPED',
    FILE_INACCESSIBLE: 'FILE_INACCESSIBLE',
    SCAN_CANCELLED: 'SCAN_CANCELLED'
});

const DEFAULT_SETTINGS = Object.freeze({
    automaticHealthChecks: true,
    scanOnStartup: false,
    scanAfterInstall: true,
    scanAfterModInstall: true,
    maxConcurrentScans: 2,
    verificationLevel: 'metadata',
    hashImportantFiles: true,
    snapshotRetentionCount: 5,
    snapshotStorageLimitGb: 10,
    snapshotLocation: '',
    autoCleanSafeTemporaryFiles: false,
    notifyWhenUnhealthy: true,
    hideInformationIssues: false,
    activityClearedAt: null,
    saveScanIncludeInstallRoot: true,
    saveScanCustomDirectories: [],
    ignorePatterns: []
});

const IMPORTANT_EXTENSIONS = new Set([
    '.exe', '.dll', '.sys', '.ini', '.cfg', '.conf', '.json', '.xml', '.yaml', '.yml'
]);

const MUTABLE_DIRECTORY_NAMES = new Set([
    'save', 'saves', 'saved', 'savegame', 'savegames', 'logs', 'log', 'cache', 'caches',
    'screenshots', 'screenshot', 'shadercache', 'shader-cache', 'crashdumps', 'crashes',
    'config', 'configs', 'configuration', 'userdata'
]);

module.exports = {
    DEFAULT_SETTINGS,
    IMPORTANT_EXTENSIONS,
    IssueCode,
    MANIFEST_SCHEMA_VERSION,
    MUTABLE_DIRECTORY_NAMES,
    Severity,
    severityRank
};
