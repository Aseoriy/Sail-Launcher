'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');

const CAPABILITY_SCHEMA = 1;
const CAPABILITY_STATES = new Set(['pending-review', 'active', 'revoked']);
const EXECUTION_OPERATIONS = Object.freeze([
    'launch', 'backup-list', 'backup-create', 'backup-restore', 'backup-open',
    'reveal', 'shortcut', 'terminate', 'save-scan', 'maintenance-read', 'maintenance-write',
    'achievement-read'
]);
const FILESYSTEM_OPERATIONS = Object.freeze([
    'save-read', 'save-write', 'config-read', 'config-write',
    'backup-read', 'backup-write', 'backup-delete', 'backup-open',
    'transfer-read', 'transfer-write', 'folder-open',
    'download-write', 'install-write', 'archive-read', 'archive-write',
    'achievement-read'
]);
const FILESYSTEM_KIND_OPERATIONS = Object.freeze({
    save: ['save-read', 'save-write', 'backup-read', 'backup-write'],
    config: ['config-read', 'config-write'],
    'download-root': ['download-write'],
    'install-root': ['install-write'],
    'archive-root': ['archive-read', 'archive-write'],
    'achievement-file': ['achievement-read'],
    'achievement-folder': ['achievement-read']
});
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EXECUTION_COMPONENTS = new Set([
    'base', 'arguments', 'preLaunchScript', 'postLaunchScript',
    'companion', 'elevation', 'priority', 'tracking'
]);

class CapabilityError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CapabilityError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new CapabilityError(code, message);
}

function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('SAIL_CAPABILITY_INVALID', `${label} must be an object.`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail('SAIL_CAPABILITY_INVALID', `${label} has an unsupported prototype.`);
    }
    for (const key of Object.keys(value)) {
        if (PROTOTYPE_KEYS.has(key)) fail('SAIL_CAPABILITY_INVALID', `${label} contains a forbidden key.`);
    }
    return value;
}

function assertExactKeys(value, allowed, label) {
    assertPlainObject(value, label);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail('SAIL_CAPABILITY_INVALID', `${label}.${key} is not allowed.`);
    }
    return value;
}

function boundedString(value, label, { min = 0, max = 32767, pattern = null } = {}) {
    if (typeof value !== 'string') fail('SAIL_CAPABILITY_INVALID', `${label} must be a string.`);
    if (value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
        fail('SAIL_CAPABILITY_INVALID', `${label} is outside its allowed bounds.`);
    }
    if (pattern && !pattern.test(value)) fail('SAIL_CAPABILITY_INVALID', `${label} has an invalid format.`);
    return value;
}

function idValue(value, label) {
    return boundedString(String(value || ''), label, { min: 1, max: 128, pattern: ID_PATTERN });
}

function absolutePath(value, label) {
    const candidate = boundedString(String(value || ''), label, { min: 1, max: 32767 });
    if (!path.isAbsolute(candidate)) fail('SAIL_CAPABILITY_INVALID', `${label} must be absolute.`);
    return path.normalize(candidate);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeId() {
    return crypto.randomUUID();
}

function fileIdentity(targetPath, expectedKind = null, options = {}) {
    const normalized = absolutePath(targetPath, 'capability path');
    if (!fs.existsSync(normalized)) {
        if (options.allowMissing) return null;
        fail('SAIL_CAPABILITY_PATH_MISSING', 'The locally approved path is no longer available.');
    }
    const linkStat = fs.lstatSync(normalized);
    if (linkStat.isSymbolicLink()) {
        fail('SAIL_CAPABILITY_PATH_CHANGED', 'The locally approved path is now a link and must be reviewed again.');
    }
    const realPath = fs.realpathSync.native ? fs.realpathSync.native(normalized) : fs.realpathSync(normalized);
    const stat = fs.statSync(realPath);
    const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
    if (expectedKind && kind !== expectedKind) {
        fail('SAIL_CAPABILITY_PATH_CHANGED', `The locally approved path is no longer a ${expectedKind}.`);
    }
    if (kind === 'other') fail('SAIL_CAPABILITY_PATH_CHANGED', 'The locally approved path type is unsupported.');
    const identity = {
        realPath: path.normalize(realPath),
        kind,
        dev: String(stat.dev),
        ino: String(stat.ino),
        birthtimeMs: Math.round(stat.birthtimeMs || 0)
    };
    if (kind === 'file') {
        identity.size = stat.size;
        identity.mtimeMs = Math.round(stat.mtimeMs || 0);
    }
    return identity;
}

function identityMatches(expected, actual, options = {}) {
    if (!expected || !actual) return false;
    const identityKeys = options.comparePathOnly
        ? ['realPath', 'kind']
        : ['realPath', 'kind', 'dev', 'ino', 'birthtimeMs'];
    for (const key of identityKeys) {
        if (String(expected[key]) !== String(actual[key])) return false;
    }
    if (options.comparePathOnly) return true;
    if (expected.kind === 'file' && options.compareContent !== false) {
        return Number(expected.size) === Number(actual.size)
            && Number(expected.mtimeMs) === Number(actual.mtimeMs);
    }
    return true;
}

function approvedFilesystemKind(kind, selectedPath) {
    if (kind === 'achievement-file') return 'file';
    if (kind === 'achievement-folder') return 'directory';
    if (kind === 'config' && fs.existsSync(selectedPath) && fs.statSync(selectedPath).isFile()) return 'file';
    return 'directory';
}

function parseArgumentString(value) {
    const source = String(value || '').trim();
    if (!source) return [];
    if (source.length > 8192 || /[\u0000\r\n]/.test(source)) {
        fail('SAIL_CAPABILITY_INVALID', 'Approved arguments are outside their allowed bounds.');
    }
    const args = [];
    let current = '';
    let quoted = false;
    let slashCount = 0;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (character === '\\') {
            slashCount += 1;
            continue;
        }
        if (character === '"') {
            current += '\\'.repeat(Math.floor(slashCount / 2));
            if (slashCount % 2 === 1) current += '"';
            else quoted = !quoted;
            slashCount = 0;
            continue;
        }
        if (slashCount) {
            current += '\\'.repeat(slashCount);
            slashCount = 0;
        }
        if (/\s/.test(character) && !quoted) {
            if (current) {
                args.push(current);
                current = '';
                if (args.length > 128) fail('SAIL_CAPABILITY_INVALID', 'Too many launch arguments were approved.');
            }
            continue;
        }
        current += character;
        if (current.length > 32767) fail('SAIL_CAPABILITY_INVALID', 'An approved launch argument is too long.');
    }
    if (slashCount) current += '\\'.repeat(slashCount);
    if (quoted) fail('SAIL_CAPABILITY_INVALID', 'Approved launch arguments contain an unmatched quote.');
    if (current) args.push(current);
    return args;
}

function normalizeArgv(value) {
    if (!Array.isArray(value) || value.length > 128) fail('SAIL_CAPABILITY_INVALID', 'argv must be a bounded array.');
    return value.map((item, index) => boundedString(item, `argv[${index}]`, { max: 32767 }));
}

function scopeValue(scope) {
    const input = assertExactKeys(scope, new Set(['profileId', 'libraryId', 'gameId']), 'scope');
    return {
        profileId: idValue(input.profileId, 'scope.profileId'),
        libraryId: idValue(input.libraryId, 'scope.libraryId'),
        gameId: idValue(input.gameId, 'scope.gameId')
    };
}

function sameScope(left, right) {
    return left.profileId === right.profileId
        && left.libraryId === right.libraryId
        && left.gameId === right.gameId;
}

function optionalAbsolutePath(value, label) {
    if (value === undefined || value === '') return '';
    return absolutePath(value, label);
}

function validateIdentityObject(value, label, expectedKind = '') {
    if (value === undefined || value === null) return null;
    const identity = assertExactKeys(value, new Set([
        'realPath', 'kind', 'dev', 'ino', 'birthtimeMs', 'size', 'mtimeMs'
    ]), label);
    absolutePath(identity.realPath, `${label}.realPath`);
    if (!['file', 'directory'].includes(identity.kind) || expectedKind && identity.kind !== expectedKind) {
        fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.kind is invalid.`);
    }
    for (const key of ['dev', 'ino']) boundedString(identity[key], `${label}.${key}`, { min: 1, max: 80 });
    if (!Number.isFinite(identity.birthtimeMs) || identity.birthtimeMs < 0) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.birthtimeMs is invalid.`);
    if (identity.kind === 'file') {
        if (!Number.isFinite(identity.size) || identity.size < 0 || !Number.isFinite(identity.mtimeMs) || identity.mtimeMs < 0) {
            fail('SAIL_CAPABILITY_STORE_INVALID', `${label} file metadata is invalid.`);
        }
    } else if (own(identity, 'size') || own(identity, 'mtimeMs')) {
        fail('SAIL_CAPABILITY_STORE_INVALID', `${label} directory metadata is invalid.`);
    }
    return identity;
}

function validateExecutionDetails(value, label, state) {
    const details = assertExactKeys(value || {}, new Set([
        'executablePath', 'executableIdentity', 'argv', 'workingDirectory', 'workingDirectoryIdentity',
        'preLaunchScript', 'preLaunchScriptIdentity', 'postLaunchScript', 'postLaunchScriptIdentity',
        'companionPath', 'companionIdentity', 'runAsAdmin', 'highPriority',
        'playDetectionPath', 'playDetectionIdentity', 'steamAppId'
    ]), label);
    const pathPairs = [
        ['executablePath', 'executableIdentity', 'file'],
        ['workingDirectory', 'workingDirectoryIdentity', 'directory'],
        ['preLaunchScript', 'preLaunchScriptIdentity', 'file'],
        ['postLaunchScript', 'postLaunchScriptIdentity', 'file'],
        ['companionPath', 'companionIdentity', 'file'],
        ['playDetectionPath', 'playDetectionIdentity', 'file']
    ];
    for (const [pathKey, identityKey, kind] of pathPairs) {
        const selectedPath = optionalAbsolutePath(details[pathKey], `${label}.${pathKey}`);
        const identity = validateIdentityObject(details[identityKey], `${label}.${identityKey}`, kind);
        if (selectedPath && !identity || !selectedPath && identity) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.${identityKey} does not match its path.`);
    }
    if (details.argv !== undefined) normalizeArgv(details.argv);
    for (const key of ['runAsAdmin', 'highPriority']) {
        if (details[key] !== undefined && typeof details[key] !== 'boolean') fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.${key} is invalid.`);
    }
    if (details.steamAppId !== undefined && details.steamAppId !== '') {
        boundedString(details.steamAppId, `${label}.steamAppId`, { min: 1, max: 10, pattern: /^[1-9]\d{0,9}$/ });
    }
    if (state === 'active' && !details.executablePath && !details.steamAppId) {
        fail('SAIL_CAPABILITY_STORE_INVALID', `${label} has no approved launch identity.`);
    }
}

function validateExecutionProposals(value, label) {
    const proposals = assertExactKeys(value, new Set([
        'executablePath', 'arguments', 'preLaunchScript', 'postLaunchScript',
        'companion', 'runAsAdmin', 'highPriority', 'playDetectionPath', 'steamAppId'
    ]), label);
    for (const key of ['executablePath', 'preLaunchScript', 'postLaunchScript', 'companion', 'playDetectionPath']) {
        optionalAbsolutePath(proposals[key], `${label}.${key}`);
    }
    boundedString(proposals.arguments, `${label}.arguments`, { max: 8192 });
    if (typeof proposals.runAsAdmin !== 'boolean' || typeof proposals.highPriority !== 'boolean') {
        fail('SAIL_CAPABILITY_STORE_INVALID', `${label} flags are invalid.`);
    }
    if (proposals.steamAppId) boundedString(proposals.steamAppId, `${label}.steamAppId`, { min: 1, max: 10, pattern: /^[1-9]\d{0,9}$/ });
}

function validateFilesystemDetails(value, label, state) {
    const details = assertExactKeys(value || {}, new Set([
        'kind', 'entryId', 'rootPath', 'rootIdentity', 'targetPath', 'targetIdentity', 'parentIdentity'
    ]), label);
    const kinds = new Set([...Object.keys(FILESYSTEM_KIND_OPERATIONS), 'transfer', 'directory-reference']);
    if (!kinds.has(details.kind)) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.kind is invalid.`);
    if (details.entryId !== '') idValue(details.entryId, `${label}.entryId`);
    if (details.kind === 'transfer') {
        if (own(details, 'rootPath') || own(details, 'rootIdentity')) fail('SAIL_CAPABILITY_STORE_INVALID', `${label} mixes filesystem record kinds.`);
        absolutePath(details.targetPath, `${label}.targetPath`);
        const targetIdentity = validateIdentityObject(details.targetIdentity, `${label}.targetIdentity`, 'file');
        const parentIdentity = validateIdentityObject(details.parentIdentity, `${label}.parentIdentity`, 'directory');
        if (!!targetIdentity === !!parentIdentity) fail('SAIL_CAPABILITY_STORE_INVALID', `${label} transfer identity is invalid.`);
        return;
    }
    if (own(details, 'targetPath') || own(details, 'targetIdentity') || own(details, 'parentIdentity')) {
        fail('SAIL_CAPABILITY_STORE_INVALID', `${label} mixes filesystem record kinds.`);
    }
    const rootPath = optionalAbsolutePath(details.rootPath, `${label}.rootPath`);
    const rootIdentity = validateIdentityObject(details.rootIdentity, `${label}.rootIdentity`);
    if (rootPath && !rootIdentity || !rootPath && rootIdentity) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.rootIdentity does not match its path.`);
    if (state === 'active' && !rootPath) fail('SAIL_CAPABILITY_STORE_INVALID', `${label} has no approved root.`);
}

function validateFilesystemProposals(value, label) {
    const proposals = assertExactKeys(value, new Set(['rootPath']), label);
    absolutePath(proposals.rootPath, `${label}.rootPath`);
}

function durableWriteJson(destination, value) {
    fsExtra.ensureDirSync(path.dirname(destination));
    const temporary = `${destination}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx');
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    fsExtra.moveSync(temporary, destination, { overwrite: true });
    try {
        const directoryDescriptor = fs.openSync(path.dirname(destination), 'r');
        try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } catch (_) {}
}

function pendingComponentNames(proposals) {
    const components = ['base'];
    if (proposals.arguments) components.push('arguments');
    if (proposals.preLaunchScript) components.push('preLaunchScript');
    if (proposals.postLaunchScript) components.push('postLaunchScript');
    if (proposals.companion) components.push('companion');
    if (proposals.runAsAdmin) components.push('elevation');
    if (proposals.highPriority) components.push('priority');
    if (proposals.playDetectionPath) components.push('tracking');
    return components;
}

function executionProposalFromLegacy(game = {}) {
    const candidateExecutablePath = game.isRom
        ? String(game.emulatorPath || game.exePath || '')
        : String(game.exePath || '');
    const candidateArguments = game.isRom
        ? String(game.romArgs || '"%rom%"').replace(/%rom%/g, String(game.romPath || ''))
        : String(game.launchArgs || '');
    const localPath = value => path.isAbsolute(String(value || '')) ? path.normalize(String(value)) : '';
    const localText = value => {
        const text = String(value || '');
        return text.length <= 8192 && !/[\u0000\r\n]/.test(text) ? text : '';
    };
    const proposal = {
        executablePath: localPath(candidateExecutablePath),
        arguments: localText(candidateArguments),
        preLaunchScript: localPath(game.preLaunchScript),
        postLaunchScript: localPath(game.postLaunchScript),
        companion: localPath(game.companionApp),
        runAsAdmin: !!game.runAsAdmin,
        highPriority: !!game.highPriority,
        playDetectionPath: localPath(game.playDetectionPath),
        steamAppId: /^[1-9]\d{0,9}$/.test(String(game.steamAppId || '')) ? String(game.steamAppId) : ''
    };
    const hasAuthority = Object.entries(proposal).some(([key, value]) => key === 'steamAppId'
        ? !!value && !proposal.executablePath
        : typeof value === 'boolean' ? value : !!value);
    return hasAuthority ? proposal : null;
}

class CapabilityStore {
    constructor(rootPath, scopeProvider = null) {
        this.root = path.resolve(rootPath);
        this.executionPath = path.join(this.root, 'execution.json');
        this.filesystemPath = path.join(this.root, 'filesystem.json');
        this.scopeProvider = typeof scopeProvider === 'function' ? scopeProvider : () => null;
        this.execution = { schemaVersion: CAPABILITY_SCHEMA, records: [] };
        this.filesystem = { schemaVersion: CAPABILITY_SCHEMA, records: [] };
        this.initialized = false;
    }

    initialize() {
        if (this.initialized) return;
        this.execution = this.readStore(this.executionPath, 'execution');
        this.filesystem = this.readStore(this.filesystemPath, 'filesystem');
        this.initialized = true;
    }

    readStore(filePath, type) {
        if (!fs.existsSync(filePath)) return { schemaVersion: CAPABILITY_SCHEMA, records: [] };
        const parsed = fsExtra.readJsonSync(filePath);
        assertExactKeys(parsed, new Set(['schemaVersion', 'records']), `${type} capability store`);
        if (parsed.schemaVersion !== CAPABILITY_SCHEMA || !Array.isArray(parsed.records) || parsed.records.length > 30000) {
            fail('SAIL_CAPABILITY_STORE_INVALID', `The ${type} capability store is invalid.`);
        }
        const ids = new Set();
        for (const [index, record] of parsed.records.entries()) {
            this.validateRecord(record, type, `${type}.records[${index}]`);
            if (ids.has(record.id)) fail('SAIL_CAPABILITY_STORE_INVALID', 'Capability IDs must be unique.');
            ids.add(record.id);
        }
        return parsed;
    }

    validateRecord(record, type, label) {
        const common = new Set([
            'id', 'type', 'profileId', 'libraryId', 'gameId', 'revision', 'state',
            'operations', 'createdAt', 'updatedAt', 'source', 'singleUse', 'details',
            'proposals', 'reviewComponents', 'revokedReason'
        ]);
        assertExactKeys(record, common, label);
        idValue(record.id, `${label}.id`);
        if (record.type !== type) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.type is invalid.`);
        scopeValue({ profileId: record.profileId, libraryId: record.libraryId, gameId: record.gameId });
        if (!Number.isSafeInteger(record.revision) || record.revision < 1) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.revision is invalid.`);
        if (!CAPABILITY_STATES.has(record.state)) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.state is invalid.`);
        if (!Array.isArray(record.operations) || !record.operations.length || record.operations.length > 16) {
            fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.operations is invalid.`);
        }
        const allowedOperations = type === 'execution' ? EXECUTION_OPERATIONS : FILESYSTEM_OPERATIONS;
        record.operations.forEach(operation => {
            if (!allowedOperations.includes(operation)) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.operations contains an invalid operation.`);
        });
        if (new Set(record.operations).size !== record.operations.length) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.operations contains duplicates.`);
        boundedString(record.createdAt, `${label}.createdAt`, { min: 1, max: 40 });
        boundedString(record.updatedAt, `${label}.updatedAt`, { min: 1, max: 40 });
        if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) {
            fail('SAIL_CAPABILITY_STORE_INVALID', `${label} timestamps are invalid.`);
        }
        boundedString(record.source, `${label}.source`, { min: 1, max: 40, pattern: /^[A-Za-z0-9._-]+$/ });
        if (typeof record.singleUse !== 'boolean') fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.singleUse is invalid.`);
        if (!Array.isArray(record.reviewComponents) || record.reviewComponents.length > 16) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.reviewComponents is invalid.`);
        record.reviewComponents.forEach(component => {
            if (type === 'execution' && !EXECUTION_COMPONENTS.has(component) || type === 'filesystem' && component !== 'root') {
                fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.reviewComponents contains an invalid component.`);
            }
        });
        if (new Set(record.reviewComponents).size !== record.reviewComponents.length) fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.reviewComponents contains duplicates.`);
        if (record.revokedReason !== undefined) boundedString(record.revokedReason, `${label}.revokedReason`, { min: 1, max: 80, pattern: /^[A-Za-z0-9._-]+$/ });
        if (record.state === 'revoked' !== own(record, 'revokedReason')) {
            fail('SAIL_CAPABILITY_STORE_INVALID', `${label}.revokedReason does not match its state.`);
        }
        if (record.state === 'pending-review') {
            if (!record.reviewComponents.length || !own(record, 'proposals')) fail('SAIL_CAPABILITY_STORE_INVALID', `${label} has no pending review proposal.`);
        } else if (record.state === 'active' && (record.reviewComponents.length || own(record, 'proposals'))) {
            fail('SAIL_CAPABILITY_STORE_INVALID', `${label} retains pending review authority.`);
        } else if (record.state === 'revoked' && (!!record.reviewComponents.length !== own(record, 'proposals'))) {
            fail('SAIL_CAPABILITY_STORE_INVALID', `${label} has an incomplete revoked proposal.`);
        }
        if (type === 'execution') {
            if (record.singleUse) fail('SAIL_CAPABILITY_STORE_INVALID', `${label} execution capability cannot be single-use.`);
            validateExecutionDetails(record.details, `${label}.details`, record.state);
            if (record.proposals !== undefined) validateExecutionProposals(record.proposals, `${label}.proposals`);
        } else {
            validateFilesystemDetails(record.details, `${label}.details`, record.state);
            if (record.proposals !== undefined) validateFilesystemProposals(record.proposals, `${label}.proposals`);
        }
    }

    persist(type) {
        const target = type === 'execution' ? this.execution : this.filesystem;
        const targetPath = type === 'execution' ? this.executionPath : this.filesystemPath;
        if (target.records.length > 20000) {
            target.records = target.records.filter(record => record.state !== 'revoked').slice(-18000);
        }
        durableWriteJson(targetPath, target);
    }

    latest(type, scope, predicate = () => true) {
        const records = type === 'execution' ? this.execution.records : this.filesystem.records;
        return records
            .filter(record => record.state !== 'revoked' && sameScope(record, scope) && predicate(record))
            .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] || null;
    }

    revokeMatching(type, scope, predicate, reason) {
        const records = type === 'execution' ? this.execution.records : this.filesystem.records;
        const now = new Date().toISOString();
        for (const record of records) {
            if (record.state !== 'revoked' && sameScope(record, scope) && predicate(record)) {
                record.state = 'revoked';
                record.revokedReason = reason;
                record.updatedAt = now;
            }
        }
    }

    pendingExecutionBaseProposals(profileIdInput) {
        this.initialize();
        const profileId = idValue(profileIdInput, 'profileId');
        return this.execution.records
            .filter(record => record.profileId === profileId
                && record.state === 'pending-review'
                && record.reviewComponents.includes('base'))
            .map(record => ({
                capabilityId: record.id,
                expectedRevision: record.revision,
                profileId: record.profileId,
                libraryId: record.libraryId,
                gameId: record.gameId,
                executablePath: record.proposals && record.proposals.executablePath || '',
                steamAppId: record.proposals && record.proposals.steamAppId || ''
            }));
    }

    createPendingExecution(scopeInput, proposalInput, source = 'legacy-migration') {
        this.initialize();
        const scope = scopeValue(scopeInput);
        const proposal = executionProposalFromLegacy(proposalInput);
        if (!proposal) return null;
        const now = new Date().toISOString();
        this.revokeMatching('execution', scope, () => true, 'replaced');
        const record = {
            id: makeId(), type: 'execution', ...scope, revision: 1,
            state: 'pending-review', operations: [...EXECUTION_OPERATIONS],
            createdAt: now, updatedAt: now, source, singleUse: false,
            details: {}, proposals: proposal,
            reviewComponents: pendingComponentNames(proposal)
        };
        this.execution.records.push(record);
        this.persist('execution');
        return this.publicRecord(record);
    }

    createApprovedExecution(scopeInput, detailsInput, source = 'local-selection') {
        this.initialize();
        const scope = scopeValue(scopeInput);
        const input = assertExactKeys(detailsInput, new Set([
            'executablePath', 'argv', 'workingDirectory', 'preLaunchScript',
            'postLaunchScript', 'companionPath', 'runAsAdmin', 'highPriority',
            'playDetectionPath', 'steamAppId'
        ]), 'execution details');
        const executablePath = input.executablePath ? absolutePath(input.executablePath, 'execution executablePath') : '';
        const steamAppId = input.steamAppId ? boundedString(String(input.steamAppId), 'execution steamAppId', { min: 1, max: 10, pattern: /^[1-9]\d{0,9}$/ }) : '';
        if (!executablePath && !steamAppId) fail('SAIL_CAPABILITY_INVALID', 'An approved executable or locally validated Steam AppID is required.');
        const details = {
            executablePath,
            executableIdentity: executablePath ? fileIdentity(executablePath, 'file') : null,
            argv: normalizeArgv(input.argv || []),
            workingDirectory: executablePath
                ? absolutePath(input.workingDirectory || path.dirname(executablePath), 'execution workingDirectory')
                : '',
            workingDirectoryIdentity: executablePath ? fileIdentity(input.workingDirectory || path.dirname(executablePath), 'directory') : null,
            preLaunchScript: input.preLaunchScript ? absolutePath(input.preLaunchScript, 'execution preLaunchScript') : '',
            preLaunchScriptIdentity: input.preLaunchScript ? fileIdentity(input.preLaunchScript, 'file') : null,
            postLaunchScript: input.postLaunchScript ? absolutePath(input.postLaunchScript, 'execution postLaunchScript') : '',
            postLaunchScriptIdentity: input.postLaunchScript ? fileIdentity(input.postLaunchScript, 'file') : null,
            companionPath: input.companionPath ? absolutePath(input.companionPath, 'execution companionPath') : '',
            companionIdentity: input.companionPath ? fileIdentity(input.companionPath, 'file') : null,
            runAsAdmin: !!input.runAsAdmin,
            highPriority: !!input.highPriority,
            playDetectionPath: input.playDetectionPath ? absolutePath(input.playDetectionPath, 'execution playDetectionPath') : '',
            playDetectionIdentity: input.playDetectionPath ? fileIdentity(input.playDetectionPath, 'file') : null,
            steamAppId
        };
        const now = new Date().toISOString();
        this.revokeMatching('execution', scope, () => true, 'replaced');
        const record = {
            id: makeId(), type: 'execution', ...scope, revision: 1, state: 'active',
            operations: [...EXECUTION_OPERATIONS], createdAt: now, updatedAt: now,
            source, singleUse: false, details, reviewComponents: []
        };
        this.execution.records.push(record);
        this.persist('execution');
        return this.publicRecord(record);
    }

    adoptTrustedLocalExecution(scopeInput, gameInput, source = 'local-import') {
        const proposal = executionProposalFromLegacy(gameInput);
        if (!proposal) return null;
        let argv = [];
        try { argv = parseArgumentString(proposal.arguments); } catch (_) {}
        return this.adoptTrustedLocalExecutionDetails(scopeInput, {
            executablePath: proposal.executablePath,
            argv,
            workingDirectory: proposal.executablePath ? path.dirname(proposal.executablePath) : '',
            preLaunchScript: proposal.preLaunchScript,
            postLaunchScript: proposal.postLaunchScript,
            companionPath: proposal.companion,
            runAsAdmin: proposal.runAsAdmin,
            highPriority: proposal.highPriority,
            playDetectionPath: proposal.playDetectionPath,
            steamAppId: proposal.steamAppId
        }, source);
    }

    adoptTrustedLocalExecutionDetails(scopeInput, detailsInput, source = 'local-import') {
        this.initialize();
        const input = assertExactKeys(detailsInput, new Set([
            'executablePath', 'argv', 'workingDirectory', 'preLaunchScript',
            'postLaunchScript', 'companionPath', 'runAsAdmin', 'highPriority',
            'playDetectionPath', 'steamAppId'
        ]), 'trusted local execution details');
        const existingPath = (value, kind) => {
            if (!value) return '';
            try {
                const selected = absolutePath(value, 'trusted local path');
                fileIdentity(selected, kind);
                return selected;
            } catch (_) {
                return '';
            }
        };
        const executablePath = existingPath(input.executablePath, 'file');
        const steamAppId = /^[1-9]\d{0,9}$/.test(String(input.steamAppId || ''))
            ? String(input.steamAppId)
            : '';
        if (!executablePath && !steamAppId) return null;
        const requestedWorkingDirectory = executablePath
            ? existingPath(input.workingDirectory || path.dirname(executablePath), 'directory')
            : '';
        return this.createApprovedExecution(scopeInput, {
            executablePath,
            argv: normalizeArgv(Array.isArray(input.argv) ? input.argv : []),
            workingDirectory: executablePath
                ? requestedWorkingDirectory || path.dirname(executablePath)
                : '',
            preLaunchScript: existingPath(input.preLaunchScript, 'file'),
            postLaunchScript: existingPath(input.postLaunchScript, 'file'),
            companionPath: existingPath(input.companionPath, 'file'),
            runAsAdmin: input.runAsAdmin === true,
            highPriority: input.highPriority === true,
            playDetectionPath: existingPath(input.playDetectionPath, 'file'),
            steamAppId: executablePath ? '' : steamAppId
        }, boundedString(String(source || 'local-import'), 'trusted local source', {
            min: 1, max: 40, pattern: /^[A-Za-z0-9._-]+$/
        }));
    }

    approvePendingExecutionComponent(capabilityId, component, decision = {}) {
        this.initialize();
        if (!EXECUTION_COMPONENTS.has(component)) fail('SAIL_CAPABILITY_INVALID', 'Unknown execution review component.');
        const record = this.execution.records.find(item => item.id === capabilityId);
        if (!record || record.state !== 'pending-review') fail('SAIL_CAPABILITY_NOT_FOUND', 'The pending execution setup is no longer available.');
        if (!record.reviewComponents.includes(component)) fail('SAIL_CAPABILITY_STALE', 'That execution component has already been reviewed.');
        const accept = decision.accept === true;
        const proposal = record.proposals || {};
        const details = record.details;
        if (component === 'base') {
            if (!accept) {
                record.state = 'revoked';
                record.revokedReason = 'base-rejected';
            } else if (decision.steamAppId) {
                details.steamAppId = boundedString(String(decision.steamAppId), 'steamAppId', { min: 1, max: 10, pattern: /^[1-9]\d{0,9}$/ });
                details.executablePath = '';
                details.executableIdentity = null;
                details.workingDirectory = '';
                details.workingDirectoryIdentity = null;
            } else {
                const selected = absolutePath(decision.selectedPath || proposal.executablePath, 'approved executable');
                details.executablePath = selected;
                details.executableIdentity = fileIdentity(selected, 'file');
                details.workingDirectory = path.dirname(selected);
                details.workingDirectoryIdentity = fileIdentity(details.workingDirectory, 'directory');
                details.steamAppId = '';
            }
        } else if (component === 'arguments') {
            details.argv = accept ? parseArgumentString(proposal.arguments) : [];
        } else if (component === 'preLaunchScript' || component === 'postLaunchScript') {
            const detailKey = component;
            const identityKey = `${component}Identity`;
            const selected = accept ? absolutePath(decision.selectedPath || proposal[component], `approved ${component}`) : '';
            details[detailKey] = selected;
            details[identityKey] = selected ? fileIdentity(selected, 'file') : null;
        } else if (component === 'companion') {
            const selected = accept ? absolutePath(decision.selectedPath || proposal.companion, 'approved companion') : '';
            details.companionPath = selected;
            details.companionIdentity = selected ? fileIdentity(selected, 'file') : null;
        } else if (component === 'elevation') {
            details.runAsAdmin = accept && proposal.runAsAdmin === true;
        } else if (component === 'priority') {
            details.highPriority = accept && proposal.highPriority === true;
        } else if (component === 'tracking') {
            const selected = accept ? absolutePath(decision.selectedPath || proposal.playDetectionPath, 'approved tracking executable') : '';
            details.playDetectionPath = selected;
            details.playDetectionIdentity = selected ? fileIdentity(selected, 'file') : null;
        }
        record.reviewComponents = record.reviewComponents.filter(item => item !== component);
        record.revision += 1;
        record.updatedAt = new Date().toISOString();
        if (record.state !== 'revoked' && record.reviewComponents.length === 0) {
            record.state = 'active';
            delete record.proposals;
            details.argv = details.argv || [];
            details.preLaunchScript = details.preLaunchScript || '';
            details.preLaunchScriptIdentity = details.preLaunchScriptIdentity || null;
            details.postLaunchScript = details.postLaunchScript || '';
            details.postLaunchScriptIdentity = details.postLaunchScriptIdentity || null;
            details.companionPath = details.companionPath || '';
            details.companionIdentity = details.companionIdentity || null;
            details.runAsAdmin = !!details.runAsAdmin;
            details.highPriority = !!details.highPriority;
            details.playDetectionPath = details.playDetectionPath || '';
            details.playDetectionIdentity = details.playDetectionIdentity || null;
        }
        this.persist('execution');
        return this.publicRecord(record);
    }

    pendingExecutionReview(requestInput) {
        this.initialize();
        const request = assertExactKeys(requestInput, new Set([
            'capabilityId', 'expectedRevision', 'profileId', 'libraryId', 'gameId', 'component'
        ]), 'pending execution review');
        const scope = scopeValue({ profileId: request.profileId, libraryId: request.libraryId, gameId: request.gameId });
        this.assertActiveScope(scope);
        if (!EXECUTION_COMPONENTS.has(request.component)) fail('SAIL_CAPABILITY_INVALID', 'Unknown execution review component.');
        const record = this.execution.records.find(item => item.id === request.capabilityId);
        if (!record) fail('SAIL_CAPABILITY_NOT_FOUND', 'The pending execution setup was not found.');
        if (!sameScope(record, scope)) fail('SAIL_CAPABILITY_WRONG_SCOPE', 'The pending execution setup belongs to another game, profile, or library.');
        if (record.state !== 'pending-review') fail(record.state === 'revoked' ? 'SAIL_CAPABILITY_REPLAYED' : 'SAIL_CAPABILITY_PENDING_REVIEW', 'The execution setup is not pending review.');
        if (record.revision !== request.expectedRevision) fail('SAIL_CAPABILITY_STALE_REVISION', 'The pending execution revision is stale.');
        if (!record.reviewComponents.includes(request.component)) fail('SAIL_CAPABILITY_STALE', 'That execution component has already been reviewed.');
        const proposal = record.proposals || {};
        const values = {
            base: proposal.executablePath || proposal.steamAppId || '',
            arguments: proposal.arguments || '',
            preLaunchScript: proposal.preLaunchScript || '',
            postLaunchScript: proposal.postLaunchScript || '',
            companion: proposal.companion || '',
            elevation: proposal.runAsAdmin ? 'Run as administrator' : '',
            priority: proposal.highPriority ? 'High process priority' : '',
            tracking: proposal.playDetectionPath || ''
        };
        return {
            value: values[request.component],
            steamAppId: request.component === 'base' ? proposal.steamAppId || '' : '',
            label: values[request.component] && path.basename(String(values[request.component])) || request.component
        };
    }

    reviewPendingExecution(request, decision = {}) {
        this.pendingExecutionReview(request);
        return this.approvePendingExecutionComponent(request.capabilityId, request.component, decision);
    }

    createPendingFilesystem(scopeInput, kind, rootPath, entryId = '', source = 'legacy-migration') {
        this.initialize();
        const scope = scopeValue(scopeInput);
        if (!FILESYSTEM_KIND_OPERATIONS[kind]) fail('SAIL_CAPABILITY_INVALID', 'Unsupported filesystem capability kind.');
        const proposalPath = absolutePath(rootPath, 'pending filesystem path');
        const normalizedEntryId = entryId ? idValue(entryId, 'entryId') : '';
        const operations = [...FILESYSTEM_KIND_OPERATIONS[kind]];
        const now = new Date().toISOString();
        this.revokeMatching('filesystem', scope, record => record.details.kind === kind && (record.details.entryId || '') === normalizedEntryId, 'replaced');
        const record = {
            id: makeId(), type: 'filesystem', ...scope, revision: 1,
            state: 'pending-review', operations, createdAt: now, updatedAt: now,
            source, singleUse: false,
            details: { kind, entryId: normalizedEntryId },
            proposals: { rootPath: proposalPath }, reviewComponents: ['root']
        };
        this.filesystem.records.push(record);
        this.persist('filesystem');
        return this.publicRecord(record);
    }

    createApprovedFilesystem(scopeInput, kind, rootPath, entryId = '', source = 'local-selection') {
        this.initialize();
        const scope = scopeValue(scopeInput);
        if (!FILESYSTEM_KIND_OPERATIONS[kind]) fail('SAIL_CAPABILITY_INVALID', 'Unsupported filesystem capability kind.');
        const selectedPath = absolutePath(rootPath, 'approved filesystem path');
        const expectedKind = approvedFilesystemKind(kind, selectedPath);
        const normalizedEntryId = entryId ? idValue(entryId, 'entryId') : '';
        const operations = [...FILESYSTEM_KIND_OPERATIONS[kind]];
        const now = new Date().toISOString();
        this.revokeMatching('filesystem', scope, record => record.details.kind === kind && (record.details.entryId || '') === normalizedEntryId, 'replaced');
        const record = {
            id: makeId(), type: 'filesystem', ...scope, revision: 1,
            state: 'active', operations, createdAt: now, updatedAt: now,
            source, singleUse: false,
            details: { kind, entryId: normalizedEntryId, rootPath: selectedPath, rootIdentity: fileIdentity(selectedPath, expectedKind) },
            reviewComponents: []
        };
        this.filesystem.records.push(record);
        this.persist('filesystem');
        return this.publicRecord(record);
    }

    adoptTrustedLocalFilesystem(scopeInput, kind, rootPath, entryId = '', source = 'local-import') {
        try {
            return this.createApprovedFilesystem(
                scopeInput,
                kind,
                rootPath,
                entryId,
                boundedString(String(source || 'local-import'), 'trusted local source', {
                    min: 1, max: 40, pattern: /^[A-Za-z0-9._-]+$/
                })
            );
        } catch (error) {
            if (error instanceof CapabilityError && [
                'SAIL_CAPABILITY_INVALID', 'SAIL_CAPABILITY_PATH_MISSING', 'SAIL_CAPABILITY_PATH_CHANGED'
            ].includes(error.code)) return null;
            throw error;
        }
    }

    promoteTrustedLocalPending(sourceInputs = []) {
        this.initialize();
        const sources = new Set(sourceInputs.map(value => String(value)));
        const summary = { executionPromoted: 0, filesystemPromoted: 0, skipped: 0 };
        const executions = this.execution.records.filter(record =>
            record.state === 'pending-review' && sources.has(record.source)
        );
        for (const record of executions) {
            const proposal = record.proposals || {};
            const promoted = this.adoptTrustedLocalExecution({
                profileId: record.profileId,
                libraryId: record.libraryId,
                gameId: record.gameId
            }, {
                exePath: proposal.executablePath,
                launchArgs: proposal.arguments,
                preLaunchScript: proposal.preLaunchScript,
                postLaunchScript: proposal.postLaunchScript,
                companionApp: proposal.companion,
                runAsAdmin: proposal.runAsAdmin,
                highPriority: proposal.highPriority,
                playDetectionPath: proposal.playDetectionPath,
                steamAppId: proposal.steamAppId
            }, record.source);
            if (promoted) summary.executionPromoted += 1;
            else summary.skipped += 1;
        }
        const filesystems = this.filesystem.records.filter(record =>
            record.state === 'pending-review' && sources.has(record.source)
        );
        for (const record of filesystems) {
            const promoted = this.adoptTrustedLocalFilesystem({
                profileId: record.profileId,
                libraryId: record.libraryId,
                gameId: record.gameId
            }, record.details.kind, record.proposals && record.proposals.rootPath,
            record.details.entryId || '', record.source);
            if (promoted) summary.filesystemPromoted += 1;
            else summary.skipped += 1;
        }
        return summary;
    }

    exportLocalAuthorities(profileIdInput, libraryIdInput) {
        this.initialize();
        const profileId = idValue(profileIdInput, 'profileId');
        const libraryId = idValue(libraryIdInput, 'libraryId');
        const games = {};
        const ensureGame = gameId => {
            if (!games[gameId]) games[gameId] = { execution: null, filesystems: [] };
            return games[gameId];
        };
        const executions = this.execution.records
            .filter(record => record.state === 'active'
                && record.profileId === profileId
                && record.libraryId === libraryId)
            .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
        const executionGames = new Set();
        for (const record of executions) {
            if (executionGames.has(record.gameId)) continue;
            executionGames.add(record.gameId);
            const details = record.details || {};
            ensureGame(record.gameId).execution = {
                executablePath: details.executablePath || '',
                argv: clone(details.argv || []),
                workingDirectory: details.workingDirectory || '',
                preLaunchScript: details.preLaunchScript || '',
                postLaunchScript: details.postLaunchScript || '',
                companionPath: details.companionPath || '',
                runAsAdmin: details.runAsAdmin === true,
                highPriority: details.highPriority === true,
                playDetectionPath: details.playDetectionPath || '',
                steamAppId: details.steamAppId || ''
            };
        }
        const filesystemKeys = new Set();
        const filesystems = this.filesystem.records
            .filter(record => record.state === 'active'
                && !record.singleUse
                && record.profileId === profileId
                && record.libraryId === libraryId
                && Object.prototype.hasOwnProperty.call(FILESYSTEM_KIND_OPERATIONS, record.details.kind))
            .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
        for (const record of filesystems) {
            const key = `${record.gameId}:${record.details.kind}:${record.details.entryId || ''}`;
            if (filesystemKeys.has(key)) continue;
            filesystemKeys.add(key);
            ensureGame(record.gameId).filesystems.push({
                kind: record.details.kind,
                entryId: record.details.entryId || '',
                rootPath: record.details.rootPath
            });
        }
        return { schemaVersion: 1, games };
    }

    approvePendingFilesystem(capabilityId, selectedPath = '') {
        this.initialize();
        const record = this.filesystem.records.find(item => item.id === capabilityId);
        if (!record || record.state !== 'pending-review') fail('SAIL_CAPABILITY_NOT_FOUND', 'The pending filesystem setup is no longer available.');
        const approvedPath = absolutePath(selectedPath || record.proposals.rootPath, 'approved filesystem path');
        const expectedKind = approvedFilesystemKind(record.details.kind, approvedPath);
        record.details.rootPath = approvedPath;
        record.details.rootIdentity = fileIdentity(approvedPath, expectedKind);
        record.reviewComponents = [];
        delete record.proposals;
        record.state = 'active';
        record.revision += 1;
        record.updatedAt = new Date().toISOString();
        this.persist('filesystem');
        return this.publicRecord(record);
    }

    pendingFilesystemReview(requestInput) {
        this.initialize();
        const request = assertExactKeys(requestInput, new Set([
            'capabilityId', 'expectedRevision', 'profileId', 'libraryId', 'gameId'
        ]), 'pending filesystem review');
        const scope = scopeValue({ profileId: request.profileId, libraryId: request.libraryId, gameId: request.gameId });
        this.assertActiveScope(scope);
        const record = this.filesystem.records.find(item => item.id === request.capabilityId);
        if (!record) fail('SAIL_CAPABILITY_NOT_FOUND', 'The pending filesystem setup was not found.');
        if (!sameScope(record, scope)) fail('SAIL_CAPABILITY_WRONG_SCOPE', 'The pending filesystem setup belongs to another game, profile, or library.');
        if (record.state !== 'pending-review') fail(record.state === 'revoked' ? 'SAIL_CAPABILITY_REPLAYED' : 'SAIL_CAPABILITY_PENDING_REVIEW', 'The filesystem setup is not pending review.');
        if (record.revision !== request.expectedRevision) fail('SAIL_CAPABILITY_STALE_REVISION', 'The pending filesystem revision is stale.');
        return {
            kind: record.details.kind,
            entryId: record.details.entryId || '',
            value: record.proposals.rootPath,
            label: path.basename(record.proposals.rootPath) || record.details.kind
        };
    }

    reviewPendingFilesystem(request, selectedPath = '') {
        const pending = this.pendingFilesystemReview(request);
        return this.approvePendingFilesystem(request.capabilityId, selectedPath || pending.value);
    }

    createTransferCapability(scopeInput, targetPath, operationInput, options = {}) {
        this.initialize();
        const scope = scopeValue(scopeInput);
        const operations = Array.isArray(operationInput) ? operationInput : [operationInput];
        if (!operations.length || operations.length > 4 || operations.some(operation => ![
            'transfer-read', 'transfer-write', 'backup-read', 'backup-delete', 'backup-open'
        ].includes(operation))) fail('SAIL_CAPABILITY_INVALID', 'Unsupported transfer operation.');
        if (operations.includes('transfer-write') && operations.length !== 1) fail('SAIL_CAPABILITY_INVALID', 'Write transfers cannot be combined with other operations.');
        const selectedPath = absolutePath(targetPath, 'transfer path');
        const details = { kind: 'transfer', entryId: '', targetPath: selectedPath };
        if (!operations.includes('transfer-write')) details.targetIdentity = fileIdentity(selectedPath, 'file');
        else {
            const parent = path.dirname(selectedPath);
            fsExtra.ensureDirSync(parent);
            details.parentIdentity = fileIdentity(parent, 'directory');
        }
        const now = new Date().toISOString();
        const record = {
            id: makeId(), type: 'filesystem', ...scope, revision: 1, state: 'active',
            operations, createdAt: now, updatedAt: now,
            source: options.source || 'main-transfer', singleUse: true,
            details, reviewComponents: []
        };
        this.filesystem.records.push(record);
        this.persist('filesystem');
        return this.publicRecord(record);
    }

    createDirectoryCapability(scopeInput, targetPath, operation = 'folder-open', options = {}) {
        this.initialize();
        const scope = scopeValue(scopeInput);
        if (operation !== 'folder-open') fail('SAIL_CAPABILITY_INVALID', 'Unsupported directory operation.');
        const selectedPath = absolutePath(targetPath, 'directory path');
        const now = new Date().toISOString();
        const record = {
            id: makeId(), type: 'filesystem', ...scope, revision: 1, state: 'active',
            operations: [operation], createdAt: now, updatedAt: now,
            source: options.source || 'main-directory', singleUse: true,
            details: {
                kind: 'directory-reference', entryId: '', rootPath: selectedPath,
                rootIdentity: fileIdentity(selectedPath, 'directory')
            },
            reviewComponents: []
        };
        this.filesystem.records.push(record);
        this.persist('filesystem');
        return this.publicRecord(record);
    }

    publicRecord(record) {
        const result = {
            capabilityId: record.id,
            revision: record.revision,
            state: record.state,
            type: record.type,
            gameId: record.gameId,
            operations: [...record.operations],
            reviewComponents: [...(record.reviewComponents || [])],
            label: record.type === 'execution'
                ? record.details && record.details.steamAppId ? `Steam App ${record.details.steamAppId}` : record.proposals && record.proposals.executablePath ? path.basename(record.proposals.executablePath) : record.details && record.details.executablePath ? path.basename(record.details.executablePath) : 'Local execution'
                : record.details && /^achievement-(?:file|folder)$/.test(record.details.kind)
                    ? path.basename(record.proposals && record.proposals.rootPath || record.details.rootPath || '') || 'Achievement source'
                    : record.details && record.details.entryId ? record.details.entryId : record.details && record.details.kind || 'Local files'
        };
        if (record.type === 'filesystem') {
            result.kind = record.details && record.details.kind || '';
            result.entryId = record.details && record.details.entryId || '';
        }
        return result;
    }

    revokeFilesystem(requestInput) {
        this.initialize();
        const request = assertExactKeys(requestInput, new Set([
            'capabilityId', 'expectedRevision', 'profileId', 'libraryId', 'gameId'
        ]), 'filesystem revocation');
        const scope = scopeValue({ profileId: request.profileId, libraryId: request.libraryId, gameId: request.gameId });
        this.assertActiveScope(scope);
        const record = this.filesystem.records.find(item => item.id === request.capabilityId);
        if (!record) fail('SAIL_CAPABILITY_NOT_FOUND', 'The filesystem capability was not found.');
        if (!sameScope(record, scope)) fail('SAIL_CAPABILITY_WRONG_SCOPE', 'The filesystem capability belongs to another game, profile, or library.');
        if (record.state === 'revoked') fail('SAIL_CAPABILITY_REPLAYED', 'The filesystem capability was already revoked.');
        if (record.revision !== request.expectedRevision) fail('SAIL_CAPABILITY_STALE_REVISION', 'The filesystem capability revision is stale.');
        record.state = 'revoked';
        record.revokedReason = 'local-removal';
        record.updatedAt = new Date().toISOString();
        this.persist('filesystem');
        return { revoked: true, capabilityId: record.id };
    }

    status(scopeInput) {
        this.initialize();
        const scope = scopeValue(scopeInput);
        const execution = this.latest('execution', scope);
        const filesystems = this.filesystem.records
            .filter(record => record.state !== 'revoked' && sameScope(record, scope) && !record.singleUse)
            .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
        const unique = new Map();
        for (const record of filesystems) {
            const key = `${record.details.kind}:${record.details.entryId || ''}`;
            if (!unique.has(key)) unique.set(key, this.publicRecord(record));
        }
        return {
            execution: execution ? this.publicRecord(execution) : {
                capabilityId: null, revision: 0, state: 'local-setup-required', type: 'execution',
                gameId: scope.gameId, operations: [], reviewComponents: [], label: 'Local setup required'
            },
            filesystems: [...unique.values()]
        };
    }

    assertActiveScope(expectedScope) {
        const active = this.scopeProvider();
        if (!active || active.profileId !== expectedScope.profileId || active.libraryId !== expectedScope.libraryId) {
            fail('SAIL_CAPABILITY_WRONG_SCOPE', 'This capability does not belong to the active profile and library.');
        }
    }

    validateCurrentIdentity(record) {
        const details = record.details || {};
        const compare = (targetPath, identity, kind, options = {}) => {
            if (!targetPath) return;
            const current = fileIdentity(targetPath, kind);
            if (!identityMatches(identity, current, options)) fail('SAIL_CAPABILITY_PATH_CHANGED', 'A selected local file changed. Choose it again before use.');
        };
        if (record.type === 'execution') {
            const replaceablePath = { comparePathOnly: true };
            compare(details.executablePath, details.executableIdentity, 'file', details.runAsAdmin ? {} : replaceablePath);
            compare(details.workingDirectory, details.workingDirectoryIdentity, 'directory', replaceablePath);
            compare(details.preLaunchScript, details.preLaunchScriptIdentity, 'file');
            compare(details.postLaunchScript, details.postLaunchScriptIdentity, 'file');
            compare(details.companionPath, details.companionIdentity, 'file');
            compare(details.playDetectionPath, details.playDetectionIdentity, 'file', replaceablePath);
        } else if (details.kind === 'transfer') {
            if (!record.operations.includes('transfer-write')) compare(details.targetPath, details.targetIdentity, 'file');
            else compare(path.dirname(details.targetPath), details.parentIdentity, 'directory');
        } else {
            compare(details.rootPath, details.rootIdentity, details.rootIdentity && details.rootIdentity.kind, {
                comparePathOnly: true
            });
        }
    }

    resolve(requestInput, type, options = {}) {
        this.initialize();
        const request = assertExactKeys(requestInput, new Set([
            'capabilityId', 'expectedRevision', 'profileId', 'libraryId', 'gameId', 'operation'
        ]), 'capability request');
        const expectedScope = scopeValue({
            profileId: request.profileId,
            libraryId: request.libraryId,
            gameId: request.gameId
        });
        this.assertActiveScope(expectedScope);
        const records = type === 'execution' ? this.execution.records : this.filesystem.records;
        const record = records.find(item => item.id === request.capabilityId);
        if (!record) fail('SAIL_CAPABILITY_NOT_FOUND', 'The capability reference was not found.');
        if (!sameScope(record, expectedScope)) fail('SAIL_CAPABILITY_WRONG_SCOPE', 'The capability does not match the requested game, profile, or library.');
        if (record.state !== 'active') fail(record.state === 'revoked' ? 'SAIL_CAPABILITY_REPLAYED' : 'SAIL_CAPABILITY_PENDING_REVIEW', 'The capability is not active.');
        if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== record.revision) {
            fail('SAIL_CAPABILITY_STALE_REVISION', 'The capability revision is stale.');
        }
        if (!record.operations.includes(request.operation)) fail('SAIL_CAPABILITY_WRONG_OPERATION', 'The capability does not allow this operation.');
        this.validateCurrentIdentity(record);
        const details = clone(record.details);
        if (options.consume === false) {
            return { details, capability: this.publicRecord(record), replacement: null };
        }
        const now = new Date().toISOString();
        record.state = 'revoked';
        record.revokedReason = 'consumed';
        record.updatedAt = now;
        let replacement = null;
        if (!record.singleUse) {
            replacement = {
                ...clone(record), id: makeId(), revision: record.revision + 1,
                state: 'active', createdAt: record.createdAt, updatedAt: now
            };
            delete replacement.revokedReason;
            records.push(replacement);
        }
        this.persist(type);
        return { details, replacement: replacement ? this.publicRecord(replacement) : null };
    }

    resolveExecution(request) {
        return this.resolve(request, 'execution');
    }

    resolveFilesystem(request) {
        return this.resolve(request, 'filesystem');
    }

    validateExecution(request) {
        return this.resolve(request, 'execution', { consume: false });
    }

    validateFilesystem(request) {
        return this.resolve(request, 'filesystem', { consume: false });
    }

    migrateLegacyGame(scope, game) {
        const created = { execution: null, filesystems: [] };
        const proposal = executionProposalFromLegacy(game);
        if (proposal) created.execution = this.adoptTrustedLocalExecution(scope, game, 'legacy-migration');
        for (const candidate of [game.localSave, game.driveSave]) {
            if (!candidate || !path.isAbsolute(String(candidate))) continue;
            if (created.filesystems.some(item => item.label === 'save')) continue;
            const approved = this.adoptTrustedLocalFilesystem(scope, 'save', String(candidate), '', 'legacy-migration');
            if (approved) created.filesystems.push(approved);
        }
        for (const entry of Array.isArray(game.configSyncEntries) ? game.configSyncEntries : []) {
            if (!entry || !entry.localPath || !path.isAbsolute(String(entry.localPath))) continue;
            const approved = this.adoptTrustedLocalFilesystem(scope, 'config', String(entry.localPath), String(entry.id || makeId()), 'legacy-migration');
            if (approved) created.filesystems.push(approved);
        }
        for (const source of Array.isArray(game.achievementSources) ? game.achievementSources : []) {
            if (!source || !path.isAbsolute(String(source.path || ''))) continue;
            const kind = source.kind === 'folder' ? 'achievement-folder' : 'achievement-file';
            const candidateId = String(source.id || '');
            const entryId = ID_PATTERN.test(candidateId) ? candidateId : makeId();
            const approved = this.adoptTrustedLocalFilesystem(scope, kind, String(source.path), entryId, 'legacy-migration');
            if (approved) created.filesystems.push(approved);
        }
        return created;
    }
}

module.exports = {
    CAPABILITY_SCHEMA,
    CapabilityError,
    CapabilityStore,
    EXECUTION_OPERATIONS,
    FILESYSTEM_KIND_OPERATIONS,
    FILESYSTEM_OPERATIONS,
    durableWriteJson,
    executionProposalFromLegacy,
    fileIdentity,
    identityMatches,
    parseArgumentString
};
