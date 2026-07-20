'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    IMPORTANT_EXTENSIONS,
    IssueCode,
    MANIFEST_SCHEMA_VERSION,
    MUTABLE_DIRECTORY_NAMES,
    Severity,
    severityRank
} = require('./constants');
const { isWithin, normalizeAbsolute, resolveWithin, toRelative } = require('./pathSafety');

class CancellationError extends Error {
    constructor() { super('Maintenance operation cancelled.'); this.name = 'CancellationError'; this.code = 'CANCELLED'; }
}

function throwIfCancelled(signal) {
    if (signal && signal.aborted) throw new CancellationError();
}

function wildcardRegex(pattern) {
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

function isIgnored(relativePath, patterns = []) {
    const posix = relativePath.split(path.sep).join('/');
    return patterns.some(pattern => {
        try { return wildcardRegex(String(pattern).replace(/\\/g, '/')).test(posix); } catch (_) { return false; }
    });
}

function isMutablePath(relativePath) {
    return relativePath.split(/[\\/]+/).some(segment => MUTABLE_DIRECTORY_NAMES.has(segment.toLowerCase()));
}

function isImportantPath(relativePath, executableRelative) {
    if (executableRelative && relativePath.toLowerCase() === executableRelative.toLowerCase()) return true;
    return IMPORTANT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function isTransientInstallArtifact(relativePath) {
    const value = String(relativePath).replace(/\\/g, '/');
    return /\.(aria2|partial|crdownload|part)$/i.test(value) || /(^|\/)(\.sail-temp|sail[_-]temp|sail[_-]extract)(\/|$)/i.test(value);
}

function issue(code, severity, message, extra = {}) {
    return Object.assign({ code, severity, message, repairActions: [] }, extra);
}

function summarizeIssues(issues) {
    if (!issues.length) return { status: Severity.HEALTHY, issueCount: 0, counts: {} };
    const counts = {};
    let status = Severity.HEALTHY;
    for (const item of issues) {
        counts[item.severity] = (counts[item.severity] || 0) + 1;
        if (severityRank[item.severity] > severityRank[status]) status = item.severity;
    }
    return { status, issueCount: issues.length, counts };
}

async function hashFile(filePath, signal) {
    throwIfCancelled(signal);
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        const cancel = () => stream.destroy(new CancellationError());
        if (signal) signal.addEventListener('abort', cancel, { once: true });
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('close', () => { if (signal) signal.removeEventListener('abort', cancel); });
    });
}

async function walkTree(root, options = {}) {
    const safeRoot = normalizeAbsolute(root);
    const results = [];
    const errors = [];
    const symlinks = [];
    const mutablePaths = new Set();
    const stack = [{ absolute: safeRoot, relative: '', depth: 0 }];
    let processed = 0;

    while (stack.length) {
        throwIfCancelled(options.signal);
        const current = stack.pop();
        if (current.depth > (options.maxDepth || 64)) continue;
        let entries;
        try { entries = await fs.promises.readdir(current.absolute, { withFileTypes: true }); }
        catch (error) { errors.push({ path: current.relative, code: error.code, message: error.message }); continue; }

        for (const entry of entries) {
            throwIfCancelled(options.signal);
            const absolute = path.join(current.absolute, entry.name);
            const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
            if (isIgnored(relative, options.ignorePatterns)) continue;
            let stat;
            try { stat = await fs.promises.lstat(absolute); }
            catch (error) { errors.push({ path: relative, code: error.code, message: error.message }); continue; }
            if (stat.isSymbolicLink()) {
                symlinks.push(relative);
                continue;
            }
            if (stat.isDirectory()) {
                if (isMutablePath(relative)) mutablePaths.add(relative.split(path.sep).join('/'));
                stack.push({ absolute, relative, depth: current.depth + 1 });
                continue;
            }
            if (!stat.isFile()) continue;
            processed += 1;
            const posixRelative = relative.split(path.sep).join('/');
            const record = {
                path: posixRelative,
                size: stat.size,
                mtimeMs: Math.trunc(stat.mtimeMs),
                important: isImportantPath(posixRelative, options.executableRelative),
                mutable: isMutablePath(posixRelative)
            };
            results.push(record);
            if (options.onProgress) options.onProgress({ phase: options.phase || 'scanning', currentFile: posixRelative, processedFiles: processed });
        }
    }
    return { files: results, errors, symlinks, mutablePaths: Array.from(mutablePaths).sort(), processedFiles: processed };
}

async function findBestExecutable(folderPath, gameName = '', options = {}) {
    const root = normalizeAbsolute(folderPath);
    const cleanName = String(gameName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const skipDirs = /redist|engine|extra|commonredist|__installer|prereq|support/i;
    const skipFiles = /unins|crash|helper|setup|install|reporter|overlay|launcher|redistributable/i;
    let best = null;
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length) {
        throwIfCancelled(options.signal);
        const { dir, depth } = stack.pop();
        if (depth > (options.maxDepth || 12)) continue;
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const entry of entries) {
            throwIfCancelled(options.signal);
            const full = path.join(dir, entry.name);
            let stat;
            try { stat = await fs.promises.lstat(full); } catch (_) { continue; }
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
                if (!skipDirs.test(entry.name)) stack.push({ dir: full, depth: depth + 1 });
                continue;
            }
            if (!stat.isFile() || path.extname(entry.name).toLowerCase() !== '.exe' || skipFiles.test(entry.name)) continue;
            const normalizedName = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            const depthPenalty = path.relative(root, full).split(path.sep).length * 1000;
            let score = Math.min(stat.size, 1_000_000_000) - depthPenalty;
            if (cleanName && normalizedName.includes(cleanName)) score += 2_000_000_000;
            if (!best || score > best.score) best = { path: full, score };
        }
    }
    return best ? best.path : null;
}

function installRootForGame(game) {
    if (game.installFolder) return normalizeAbsolute(game.installFolder);
    if (game.exePath) return path.dirname(normalizeAbsolute(game.exePath));
    return null;
}

class MaintenanceScanner {
    constructor(options = {}) {
        this.findExecutable = options.findExecutable || findBestExecutable;
        this.dependencyService = options.dependencyService || null;
    }

    async createBaseline(game, options = {}) {
        if (!game || !game.id) throw new Error('A game with an ID is required.');
        const installRoot = installRootForGame(game);
        if (!installRoot) throw new Error('The game has no installation path.');
        const rootStat = await fs.promises.stat(installRoot);
        if (!rootStat.isDirectory()) throw new Error('Installation root is not a directory.');

        let executablePath = game.exePath && isWithin(installRoot, game.exePath, false) ? normalizeAbsolute(game.exePath) : null;
        try { if (executablePath && !(await fs.promises.stat(executablePath)).isFile()) executablePath = null; } catch (_) { executablePath = null; }
        if (!executablePath) executablePath = await this.findExecutable(installRoot, game.name, options);
        const executableRelative = executablePath && isWithin(installRoot, executablePath, false) ? toRelative(installRoot, executablePath) : undefined;
        const walked = await walkTree(installRoot, {
            signal: options.signal,
            ignorePatterns: options.ignorePatterns || [],
            executableRelative,
            phase: 'baseline',
            onProgress: options.onProgress
        });
        const baselineFiles = walked.files.filter(record => !isTransientInstallArtifact(record.path));

        const shouldHash = options.hashImportantFiles !== false;
        for (let i = 0; i < baselineFiles.length; i++) {
            throwIfCancelled(options.signal);
            const record = baselineFiles[i];
            if (!record.important || record.mutable || !shouldHash) continue;
            try {
                record.sha256 = await hashFile(resolveWithin(installRoot, record.path), options.signal);
                if (options.onProgress) options.onProgress({ phase: 'hashing', currentFile: record.path, processedFiles: i + 1, totalFiles: baselineFiles.length });
            } catch (error) {
                if (error instanceof CancellationError) throw error;
                record.hashError = error.code || error.message;
            }
        }

        const now = new Date().toISOString();
        const protectedPaths = baselineFiles.filter(record => record.important && !record.mutable).map(record => record.path);
        return {
            schemaVersion: MANIFEST_SCHEMA_VERSION,
            gameId: String(game.id),
            gameTitle: game.name || '',
            installRoot,
            executablePath: executableRelative,
            installedAt: game.installedAt || (game.addedAt ? new Date(game.addedAt).toISOString() : now),
            lastScannedAt: now,
            source: {
                provider: game.source || game.platform || 'manual',
                title: game.sourceTitle || game.name || '',
                version: game.sourceVersion || '',
                identifier: game.sourceIdentifier || game.steamAppId || game.epicId || game.gogId || ''
            },
            files: baselineFiles,
            mutablePaths: walked.mutablePaths,
            protectedPaths,
            modifications: [],
            creationMethod: options.creationMethod || 'manual-baseline',
            scan: { inaccessible: walked.errors, skippedLinks: walked.symlinks }
        };
    }

    async scan(game, manifest, options = {}) {
        const startedAt = new Date().toISOString();
        const issues = [];
        let installRoot;
        try { installRoot = installRootForGame(game); } catch (error) {
            issues.push(issue(IssueCode.INSTALL_DIR_MISSING, Severity.CRITICAL, 'The installation path is invalid.', { details: error.message }));
        }
        if (!installRoot) issues.push(issue(IssueCode.INSTALL_DIR_MISSING, Severity.CRITICAL, 'No installation directory is configured.'));
        if (!manifest) issues.push(issue(IssueCode.MANIFEST_MISSING, Severity.WARNING, 'This game does not have an installation baseline.', { repairActions: ['create-baseline'] }));
        if (manifest && manifest.schemaVersion < MANIFEST_SCHEMA_VERSION) {
            issues.push(issue(IssueCode.MANIFEST_OUTDATED, Severity.INFORMATION, 'The installation manifest will be upgraded on its next safe write.', { repairActions: ['rebuild-manifest'] }));
        }

        let rootStat = null;
        if (installRoot) {
            try { rootStat = await fs.promises.stat(installRoot); }
            catch (error) {
                issues.push(issue(error.code === 'ENOENT' ? IssueCode.INSTALL_DIR_MISSING : IssueCode.INSTALL_DIR_INACCESSIBLE,
                    error.code === 'ENOENT' ? Severity.CRITICAL : Severity.ERROR,
                    error.code === 'ENOENT' ? 'The installation directory is missing.' : 'The installation directory could not be accessed.',
                    { path: installRoot, details: error.message, repairActions: ['locate-installation'] }));
            }
            if (rootStat && !rootStat.isDirectory()) issues.push(issue(IssueCode.INSTALL_DIR_MISSING, Severity.CRITICAL, 'The configured installation path is not a directory.', { path: installRoot }));
        }

        if (!rootStat || !rootStat.isDirectory()) {
            return { gameId: String(game.id), startedAt, completedAt: new Date().toISOString(), issues, summary: summarizeIssues(issues), dependencies: [] };
        }

        if (manifest && manifest.installRoot && path.resolve(manifest.installRoot) !== installRoot) {
            issues.push(issue(IssueCode.INSTALL_MOVED, Severity.INFORMATION, 'The installation path changed since the baseline was created.', {
                previousPath: manifest.installRoot, path: installRoot, repairActions: ['accept-install-location']
            }));
        }

        let configuredExe = game.exePath ? normalizeAbsolute(game.exePath) : (manifest && manifest.executablePath ? resolveWithin(installRoot, manifest.executablePath) : null);
        let exeValid = false;
        if (configuredExe && isWithin(installRoot, configuredExe, false)) {
            try { exeValid = (await fs.promises.stat(configuredExe)).isFile() && path.extname(configuredExe).toLowerCase() === '.exe'; } catch (_) {}
        }
        if (!exeValid) {
            const discovered = await this.findExecutable(installRoot, game.name, options);
            if (discovered) {
                issues.push(issue(IssueCode.EXECUTABLE_MOVED, Severity.ERROR, 'The configured executable is missing, but another likely executable was found.', {
                    path: configuredExe || '', discoveredPath: discovered, repairActions: ['update-executable']
                }));
            } else {
                issues.push(issue(configuredExe ? IssueCode.EXECUTABLE_MISSING : IssueCode.EXECUTABLE_INVALID, Severity.CRITICAL,
                    configuredExe ? 'The configured executable is missing.' : 'No valid executable is configured or discoverable.',
                    { path: configuredExe || '', repairActions: ['locate-executable'] }));
            }
        }

        if (manifest) {
            const mutablePrefixes = (manifest.mutablePaths || []).map(item => item.toLowerCase().replace(/\\/g, '/'));
            const records = manifest.files || [];
            for (let i = 0; i < records.length; i++) {
                throwIfCancelled(options.signal);
                const record = records[i];
                const relative = String(record.path || '').replace(/\\/g, '/');
                if (!relative || record.mutable || mutablePrefixes.some(prefix => relative.toLowerCase() === prefix || relative.toLowerCase().startsWith(prefix + '/'))) continue;
                let absolute;
                try { absolute = resolveWithin(installRoot, relative); }
                catch (error) {
                    issues.push(issue(IssueCode.PATH_ESCAPE_SKIPPED, Severity.WARNING, 'A manifest path escaped the installation root and was skipped.', { path: relative }));
                    continue;
                }
                let stat;
                try { stat = await fs.promises.lstat(absolute); }
                catch (error) {
                    if (error.code === 'ENOENT') issues.push(issue(IssueCode.MANIFEST_FILE_MISSING, record.important ? Severity.ERROR : Severity.WARNING, 'A baseline file is missing.', { path: relative, repairActions: ['accept-change', 'restore-snapshot'] }));
                    else issues.push(issue(IssueCode.FILE_INACCESSIBLE, Severity.INFORMATION, 'A baseline file could not be inspected.', { path: relative, details: error.message }));
                    continue;
                }
                if (stat.isSymbolicLink()) {
                    issues.push(issue(IssueCode.PATH_ESCAPE_SKIPPED, Severity.WARNING, 'A symbolic link was not followed during verification.', { path: relative }));
                    continue;
                }
                if (!stat.isFile()) continue;
                const metadataChanged = Number(record.size) !== stat.size || Math.abs(Number(record.mtimeMs || 0) - Math.trunc(stat.mtimeMs)) > 1500;
                if (metadataChanged && record.important && options.verificationLevel !== 'existence') {
                    issues.push(issue(IssueCode.MANIFEST_FILE_CHANGED, Severity.WARNING, 'An important file changed since the baseline.', { path: relative, repairActions: ['accept-change', 'restore-snapshot'] }));
                }
                if (record.sha256 && (options.deep || options.verificationLevel === 'deep' || (options.hashImportantFiles && metadataChanged && options.verificationLevel !== 'existence'))) {
                    try {
                        const currentHash = await hashFile(absolute, options.signal);
                        if (currentHash !== record.sha256) issues.push(issue(IssueCode.HASH_MISMATCH, Severity.ERROR, 'A protected file hash does not match the baseline.', { path: relative, repairActions: ['restore-snapshot', 'accept-change'] }));
                    } catch (error) {
                        if (error instanceof CancellationError) throw error;
                        issues.push(issue(IssueCode.FILE_INACCESSIBLE, Severity.INFORMATION, 'A file could not be hashed.', { path: relative, details: error.message }));
                    }
                }
                if (options.onProgress) options.onProgress({ phase: 'verifying', currentFile: relative, processedFiles: i + 1, totalFiles: records.length });
            }
        }

        const walked = await walkTree(installRoot, { signal: options.signal, ignorePatterns: options.ignorePatterns || [], phase: 'inspecting', onProgress: options.onProgress });
        const remnantPatterns = [
            { re: /\.aria2$/i, code: IssueCode.FAILED_DOWNLOAD_FRAGMENT, severity: Severity.WARNING, action: 'remove-safe-temporary', message: 'An incomplete aria2 download fragment remains.' },
            { re: /\.(part|partial|crdownload)$/i, code: IssueCode.FAILED_DOWNLOAD_FRAGMENT, severity: Severity.WARNING, action: 'remove-safe-temporary', message: 'An incomplete download fragment remains.' },
            { re: /\.(r\d\d|z\d\d|\d{3})$/i, code: IssueCode.MULTIPART_ARCHIVE_LEFTOVER, severity: Severity.INFORMATION, action: 'review-cleanup', message: 'A multipart archive piece remains in the installation.' },
            { re: /(^|\/)(_?extract(?:ed|ion)?|sail[_-]?extract|\.sail[_-]?temp)(\/|$)/i, code: IssueCode.EXTRACTION_REMNANT, severity: Severity.WARNING, action: 'review-cleanup', message: 'An extraction working folder remains.' },
            { re: /\.(tmp|temp)$/i, code: IssueCode.TEMP_INSTALL_FILE, severity: Severity.INFORMATION, action: 'review-cleanup', message: 'A temporary installation file remains.' }
        ];
        for (const record of walked.files) {
            const match = remnantPatterns.find(pattern => pattern.re.test(record.path));
            if (match) issues.push(issue(match.code, match.severity, match.message, { path: record.path, size: record.size, repairActions: [match.action] }));
        }
        for (const inaccessible of walked.errors) issues.push(issue(IssueCode.FILE_INACCESSIBLE, Severity.INFORMATION, 'A file or folder could not be inspected.', inaccessible));
        for (const linked of walked.symlinks) issues.push(issue(IssueCode.PATH_ESCAPE_SKIPPED, Severity.INFORMATION, 'A symbolic link or junction was skipped for safety.', { path: linked }));

        if (game.localSave) {
            try {
                const saveStat = await fs.promises.stat(normalizeAbsolute(game.localSave));
                if (!saveStat.isDirectory()) throw Object.assign(new Error('Save path is not a directory.'), { code: 'ENOTDIR' });
                await fs.promises.access(normalizeAbsolute(game.localSave), fs.constants.R_OK);
            } catch (error) {
                issues.push(issue(error.code === 'ENOENT' ? IssueCode.SAVE_FOLDER_MISSING : IssueCode.SAVE_FOLDER_INACCESSIBLE,
                    error.code === 'ENOENT' ? Severity.WARNING : Severity.INFORMATION,
                    error.code === 'ENOENT' ? 'The configured save folder does not exist yet.' : 'The configured save folder is not currently accessible.',
                    { path: game.localSave, details: error.message, repairActions: ['reevaluate-save-path'] }));
            }
        } else {
            issues.push(issue(IssueCode.SAVE_FOLDER_MISSING, Severity.INFORMATION, 'No save folder is configured.', { repairActions: ['reevaluate-save-path'] }));
        }

        try {
            if (typeof fs.promises.statfs === 'function') {
                const disk = await fs.promises.statfs(installRoot);
                const freeBytes = Number(disk.bavail) * Number(disk.bsize);
                if (Number.isFinite(freeBytes) && freeBytes < (options.lowDiskThresholdBytes || 1024 ** 3)) {
                    issues.push(issue(IssueCode.LOW_DISK_SPACE, Severity.WARNING, 'The installation drive has less than 1 GB free.', { freeBytes }));
                }
            }
        } catch (_) {}

        if (manifest && Array.isArray(manifest.modifications)) {
            const owners = new Map();
            for (const modification of manifest.modifications.filter(item => !item.acceptedAt && !item.rolledBackAt)) {
                for (const relative of [...(modification.filesAdded || []), ...(modification.filesReplaced || [])]) {
                    const key = String(relative).toLowerCase();
                    if (owners.has(key)) issues.push(issue(IssueCode.MODIFICATION_CONFLICT, Severity.WARNING, 'Multiple active modifications manage the same file.', { path: relative, modifications: [owners.get(key), modification.id], repairActions: ['review-modifications'] }));
                    else owners.set(key, modification.id);
                }
            }
        }

        let dependencies = [];
        if (this.dependencyService) {
            try {
                dependencies = await this.dependencyService.check(game, { installRoot });
                for (const finding of dependencies) {
                    if (finding.status === 'missing') issues.push(issue(IssueCode.DEPENDENCY_MISSING, Severity.WARNING, `${finding.name} appears to be missing.`, { dependency: finding, repairActions: ['view-official-source'] }));
                    if (finding.status === 'uncertain') issues.push(issue(IssueCode.DEPENDENCY_UNCERTAIN, Severity.INFORMATION, `${finding.name} could not be confirmed.`, { dependency: finding }));
                }
            } catch (error) {
                dependencies = [{ id: 'framework', name: 'Dependency checks', status: 'uncertain', details: error.message }];
            }
        }

        return {
            gameId: String(game.id),
            startedAt,
            completedAt: new Date().toISOString(),
            installRoot,
            executablePath: exeValid ? configuredExe : null,
            scannedFiles: walked.processedFiles,
            reclaimableBytes: issues.reduce((total, item) => total + (item.size || 0), 0),
            issues,
            summary: summarizeIssues(issues),
            dependencies
        };
    }
}

module.exports = {
    CancellationError,
    MaintenanceScanner,
    findBestExecutable,
    hashFile,
    installRootForGame,
    isTransientInstallArtifact,
    isMutablePath,
    summarizeIssues,
    throwIfCancelled,
    walkTree
};
