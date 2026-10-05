'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { fileIdentity, identityMatches } = require('../../security/capabilityStore');
const PROTOCOL = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHASES = new Set(['starting', 'running', 'root-exited-descendants-running', 'stopping', 'cleanup-pending', 'cleanup-failed', 'completed', 'launch-failed', 'tracking-lost']);

function nativeError(code, message) { const error = new Error(message); error.code = code; return error; }
function validateArgv(argv) {
    if (!Array.isArray(argv) || argv.length > 128 || argv.some(arg => typeof arg !== 'string' || (/[\u0000-\u001f\u007f]/.test(arg)) || Buffer.byteLength(arg) > 32767)) {
        throw nativeError('SAIL_NATIVE_ARGUMENTS', 'Native arguments must be an array of at most 128 literal strings without NUL or other control characters.');
    }
    return argv.slice();
}
function withinRoot(target, root) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function assertFixturePath(target, root) {
    if (root && !withinRoot(target, root)) throw nativeError('SAIL_NATIVE_FIXTURE_PATH', 'Choose a path inside this session’s private native fixture directory.');
}
function validateNativeExecutable(selected, { fixtureRoot = null, expected = null, allowScripts = false } = {}) {
    const canonical = fs.realpathSync(selected);
    assertFixturePath(canonical, fixtureRoot);
    const identity = fileIdentity(canonical, 'file');
    if (expected && (!identityMatches(expected, identity) || path.resolve(selected) !== canonical)) {
        throw nativeError('SAIL_CAPABILITY_PATH_CHANGED', 'The approved executable or its parent path changed. Choose it again.');
    }
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK);
    const fd = fs.openSync(canonical, 'r');
    try {
        const header = Buffer.alloc(256); const count = fs.readSync(fd, header, 0, header.length, 0);
        const elf = count >= 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]));
        const script = count >= 2 && header[0] === 35 && header[1] === 33;
        if (script && !allowScripts) throw nativeError('SAIL_NATIVE_SCRIPTS_UNAVAILABLE', require('../platformSupport').NATIVE_SCRIPT_UNAVAILABLE_REASON);
        if (!elf && !script) throw nativeError('SAIL_NATIVE_FORMAT', 'Choose a native Linux x64 ELF executable or an executable script with a shebang.');
        if (elf && (header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62)) {
            throw nativeError('SAIL_NATIVE_ARCH', 'This native provider requires a Linux x64 executable.');
        }
        if (script) identity.executionKind = 'script-native-path';
    } finally { fs.closeSync(fd); }
    return identity;
}
function validateWorkingDirectory(selected, { fixtureRoot = null, expected = null } = {}) {
    const canonical = fs.realpathSync(selected); assertFixturePath(canonical, fixtureRoot);
    const identity = fileIdentity(canonical, 'directory');
    if (expected && (!identityMatches(expected, identity) || path.resolve(selected) !== canonical)) throw nativeError('SAIL_CAPABILITY_PATH_CHANGED', 'The approved working directory changed. Choose it again.');
    fs.accessSync(canonical, fs.constants.X_OK);
    return identity;
}
function assertNativeOptions(details) {
    if (details.steamAppId || details.preLaunchScript || details.postLaunchScript || details.companion || details.companionPath
        || details.playDetectionPath || details.runAsAdmin || details.highPriority) {
        throw nativeError('SAIL_NATIVE_OPTIONS_UNSUPPORTED', 'This native launch has unsupported Steam, script, companion, tracking, elevation or priority options. Review its local setup; those options have not been removed.');
    }
}
function encodeConfig({ sessionId, nonce, directory, executable, cwd, argv, gameTracking }) {
    if (!UUID.test(sessionId) || !/^[0-9a-f]{64}$/.test(nonce)) throw nativeError('SAIL_NATIVE_PROTOCOL', 'Invalid native session identity.');
    const fields = ['SAIL_NATIVE_1', sessionId, nonce, directory, executable.realPath, cwd.realPath,
        executable.dev, executable.ino, executable.size, executable.mtimeMs, cwd.dev, cwd.ino, argv.length, ...validateArgv(argv)];
    const game = require('../proton/tracking').validateGameTracking(gameTracking);
    if (game) {
        fields.push(game.backend === 'wine' ? 'SAIL_WINE_IMAGE_1' : 'SAIL_GAME_IMAGE_1', game.target.realPath, game.target.dev, game.target.ino, game.target.size, game.target.mtimeMs, game.prefix, game.protonRoot);
        if (game.backend === 'wine') fields.push(game.loaders.length, ...game.loaders.flatMap(item => [item.realPath, item.dev, item.ino, item.size, item.mtimeMs]));
    }
    if (fields.some(value => String(value).includes('\0'))) throw nativeError('SAIL_NATIVE_PROTOCOL', 'Invalid native configuration field.');
    const payload = Buffer.from(`${fields.map(String).join('\0')}\0`);
    if (payload.length > 131072) throw nativeError('SAIL_NATIVE_ARGUMENTS', 'The native launch configuration is too large.');
    const size = Buffer.alloc(4); size.writeUInt32LE(payload.length); return Buffer.concat([size, payload]);
}
function processIdentity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw nativeError('SAIL_NATIVE_IDENTITY', 'Invalid supervisor identity.');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')'); const fields = stat.slice(close + 2).split(' ');
    if (close < 0 || !/^\d+$/.test(fields[19] || '')) throw nativeError('SAIL_NATIVE_IDENTITY', 'The supervisor identity could not be verified.');
    return { bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
        pidNamespace: fs.readlinkSync(`/proc/${pid}/ns/pid`), supervisorPid: pid, supervisorStartTicks: fields[19] };
}
function sameOwner(expected, actual) {
    return ['bootId', 'pidNamespace', 'supervisorPid', 'supervisorStartTicks'].every(key => expected && actual && expected[key] === actual[key]);
}
function validateReceipt(value, sessionId, owner = null, previous = null, expectedKind = null, gameTracking = undefined) {
    if (!value || value.protocol !== PROTOCOL || value.sessionId !== sessionId || !UUID.test(sessionId)
        || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !PHASES.has(value.phase)
        || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.clock !== 'CLOCK_MONOTONIC'
        || !Number.isSafeInteger(value.ownedChildren) || value.ownedChildren < 0
        || !Number.isSafeInteger(value.rootPid) || value.rootPid < 0 || typeof value.rootExited !== 'boolean'
        || !Number.isSafeInteger(value.rootCode) || value.rootCode < 0 || !Number.isSafeInteger(value.rootSignal) || value.rootSignal < 0
        || typeof value.execSucceeded !== 'boolean' || typeof value.terminal !== 'boolean' || typeof value.durable !== 'boolean'
        || !Number.isSafeInteger(value.supervisorPid) || value.supervisorPid <= 0 || !/^\d+$/.test(value.supervisorStartTicks)
        || !UUID.test(value.bootId) || !/^pid:\[\d+\]$/.test(value.pidNamespace)
        || ['execErrno', 'trackingErrno', 'receiptErrno'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)
        || (owner && !sameOwner(owner, value))
        || (previous && (value.sequence < previous.sequence || value.elapsedMs < previous.elapsedMs))
        || (value.terminal && (value.ownedChildren !== 0 || value.trackingErrno || !['completed', 'launch-failed'].includes(value.phase)))
        || (value.phase === 'completed' && (!value.terminal || !value.execSucceeded || !value.rootExited || value.execErrno))
        || (value.phase === 'launch-failed' && (!value.terminal || value.execSucceeded))
        || (previous && previous.terminal && !value.terminal)
        || (previous && value.sequence === previous.sequence && !require('node:util').isDeepStrictEqual(value, previous))
        || (!value.execSucceeded && value.elapsedMs !== 0)
        || !require('../proton/tracking').validGameReceipt(value.game, previous?.game, gameTracking, value)
        || !require('./scriptLifecycle').validScriptLifecycle(value, previous, expectedKind)) throw nativeError('SAIL_NATIVE_RECEIPT', 'The native session receipt is invalid or out of order. Tracking remains unresolved.');
    return value;
}
module.exports = { PROTOCOL, UUID, validateArgv, withinRoot, assertFixturePath, validateNativeExecutable,
    validateWorkingDirectory, assertNativeOptions, encodeConfig, processIdentity, sameOwner, validateReceipt, nativeError,
    newSession: () => ({ sessionId: crypto.randomUUID(), nonce: crypto.randomBytes(32).toString('hex') }) };
