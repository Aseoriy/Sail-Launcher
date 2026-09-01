'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
    CapabilityError,
    CapabilityStore,
    parseArgumentString
} = require('../security/capabilityStore');
const { createExecutionPhaseAuthority } = require('../security/executionPhaseAuthority');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-gate-a-capability-'));
    const files = path.join(root, 'files');
    fs.mkdirSync(files, { recursive: true });
    const executablePath = path.join(files, 'game.exe');
    const preLaunchScript = path.join(files, 'before.ps1');
    const postLaunchScript = path.join(files, 'after.cmd');
    const companionPath = path.join(files, 'companion.exe');
    const trackingPath = path.join(files, 'tracked.exe');
    const savePath = path.join(files, 'save');
    const configPath = path.join(files, 'settings.ini');
    fs.writeFileSync(executablePath, 'exe');
    fs.writeFileSync(preLaunchScript, 'script');
    fs.writeFileSync(postLaunchScript, 'script');
    fs.writeFileSync(companionPath, 'exe');
    fs.writeFileSync(trackingPath, 'exe');
    fs.mkdirSync(savePath);
    fs.writeFileSync(configPath, 'setting=true');
    const active = { profileId: 'profile-a', libraryId: 'library-a' };
    const store = new CapabilityStore(path.join(root, 'authority'), () => ({ ...active }));
    store.initialize();
    const scope = { ...active, gameId: 'game-a' };
    return {
        root, files, store, scope, active,
        executablePath, preLaunchScript, postLaunchScript,
        companionPath, trackingPath, savePath, configPath
    };
}

function assertCode(expected, callback) {
    assert.throws(callback, error => {
        assert.ok(error instanceof CapabilityError);
        assert.equal(error.code, expected);
        return true;
    });
}

test('main-owned launch references reject guessed, wrong-scope, stale and replayed IDs', t => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const created = f.store.createApprovedExecution(f.scope, {
        executablePath: f.executablePath,
        argv: ['--safe', 'two words'],
        workingDirectory: f.files,
        runAsAdmin: false,
        highPriority: false
    });

    const request = {
        capabilityId: created.capabilityId,
        expectedRevision: created.revision,
        ...f.scope,
        operation: 'launch'
    };
    assertCode('SAIL_CAPABILITY_NOT_FOUND', () => f.store.resolveExecution({ ...request, capabilityId: '00000000-0000-4000-8000-000000000000' }));
    assertCode('SAIL_CAPABILITY_WRONG_SCOPE', () => f.store.resolveExecution({ ...request, gameId: 'game-b' }));
    f.active.profileId = 'profile-b';
    assertCode('SAIL_CAPABILITY_WRONG_SCOPE', () => f.store.resolveExecution(request));
    f.active.profileId = 'profile-a';
    f.active.libraryId = 'library-b';
    assertCode('SAIL_CAPABILITY_WRONG_SCOPE', () => f.store.resolveExecution(request));
    f.active.libraryId = 'library-a';

    const resolved = f.store.resolveExecution(request);
    assert.equal(resolved.details.executablePath, f.executablePath);
    assert.deepEqual(resolved.details.argv, ['--safe', 'two words']);
    assertCode('SAIL_CAPABILITY_REPLAYED', () => f.store.resolveExecution(request));
    assert.ok(resolved.replacement);
    assertCode('SAIL_CAPABILITY_STALE_REVISION', () => f.store.resolveExecution({
        ...request,
        capabilityId: resolved.replacement.capabilityId,
        expectedRevision: created.revision
    }));
});

test('normal game updates stay usable while missing and elevated replacement executables fail closed', t => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const created = f.store.createApprovedExecution(f.scope, {
        executablePath: f.executablePath,
        argv: [],
        workingDirectory: f.files,
        runAsAdmin: false,
        highPriority: false
    });
    fs.appendFileSync(f.executablePath, 'replacement');
    const updated = f.store.resolveExecution({
        capabilityId: created.capabilityId,
        expectedRevision: created.revision,
        ...f.scope,
        operation: 'launch'
    });
    assert.equal(updated.details.executablePath, f.executablePath);
    fs.unlinkSync(f.executablePath);
    assertCode('SAIL_CAPABILITY_PATH_MISSING', () => f.store.resolveExecution({
        capabilityId: updated.replacement.capabilityId,
        expectedRevision: updated.replacement.revision,
        ...f.scope,
        operation: 'launch'
    }));

    fs.writeFileSync(f.executablePath, 'elevated executable');
    const elevated = f.store.createApprovedExecution(f.scope, {
        executablePath: f.executablePath,
        argv: [],
        workingDirectory: f.files,
        runAsAdmin: true,
        highPriority: false
    });
    fs.appendFileSync(f.executablePath, ' replacement');
    assertCode('SAIL_CAPABILITY_PATH_CHANGED', () => f.store.resolveExecution({
        capabilityId: elevated.capabilityId,
        expectedRevision: elevated.revision,
        ...f.scope,
        operation: 'launch'
    }));
});

test('each delayed launch phase revalidates replacement, revocation, scripts, companion and elevation authority', t => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const created = f.store.createApprovedExecution(f.scope, {
        executablePath: f.executablePath,
        argv: ['--approved'],
        workingDirectory: f.files,
        preLaunchScript: f.preLaunchScript,
        postLaunchScript: f.postLaunchScript,
        companionPath: f.companionPath,
        runAsAdmin: true,
        highPriority: false
    });
    const resolved = f.store.resolveExecution({
        capabilityId: created.capabilityId,
        expectedRevision: created.revision,
        ...f.scope,
        operation: 'launch'
    });
    const profileStore = {
        validateExecutionCapability(request) {
            return f.store.validateExecution({ ...request, ...f.scope });
        }
    };
    const phases = createExecutionPhaseAuthority({
        profileStore,
        gameId: f.scope.gameId,
        resolvedCapability: resolved
    });
    assert.equal(phases.resolve('pre-script').preLaunchScript, f.preLaunchScript);
    assert.equal(phases.resolve('companion').companionPath, f.companionPath);
    const launch = phases.resolve('launch');
    assert.deepEqual(launch.argv, ['--approved']);
    assert.equal(launch.runAsAdmin, true);

    fs.renameSync(f.postLaunchScript, `${f.postLaunchScript}.old`);
    fs.writeFileSync(f.postLaunchScript, 'replacement');
    assertCode('SAIL_CAPABILITY_PATH_CHANGED', () => phases.resolve('post-script'));

    f.store.createApprovedExecution(f.scope, {
        executablePath: f.executablePath,
        argv: [],
        workingDirectory: f.files,
        runAsAdmin: false,
        highPriority: false
    });
    assertCode('SAIL_CAPABILITY_REPLAYED', () => phases.resolve('launch'));
});

test('legacy execution remains pending until base, arguments, scripts, companion and elevation are individually reviewed', t => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const pending = f.store.createPendingExecution(f.scope, {
        exePath: f.executablePath,
        launchArgs: '--name "two words"',
        preLaunchScript: f.preLaunchScript,
        postLaunchScript: f.postLaunchScript,
        companionApp: f.companionPath,
        runAsAdmin: true,
        highPriority: true,
        playDetectionPath: f.trackingPath
    });
    assert.equal(pending.state, 'pending-review');
    assert.deepEqual(new Set(pending.reviewComponents), new Set([
        'base', 'arguments', 'preLaunchScript', 'postLaunchScript',
        'companion', 'elevation', 'priority', 'tracking'
    ]));
    assertCode('SAIL_CAPABILITY_PENDING_REVIEW', () => f.store.resolveExecution({
        capabilityId: pending.capabilityId,
        expectedRevision: pending.revision,
        ...f.scope,
        operation: 'launch'
    }));

    f.store.approvePendingExecutionComponent(pending.capabilityId, 'base', { accept: true, selectedPath: f.executablePath });
    f.store.approvePendingExecutionComponent(pending.capabilityId, 'arguments', { accept: true });
    f.store.approvePendingExecutionComponent(pending.capabilityId, 'preLaunchScript', { accept: true, selectedPath: f.preLaunchScript });
    f.store.approvePendingExecutionComponent(pending.capabilityId, 'postLaunchScript', { accept: false });
    f.store.approvePendingExecutionComponent(pending.capabilityId, 'companion', { accept: true, selectedPath: f.companionPath });
    f.store.approvePendingExecutionComponent(pending.capabilityId, 'elevation', { accept: true });
    f.store.approvePendingExecutionComponent(pending.capabilityId, 'priority', { accept: false });
    const active = f.store.approvePendingExecutionComponent(pending.capabilityId, 'tracking', { accept: true, selectedPath: f.trackingPath });
    assert.equal(active.state, 'active');
    assert.equal(active.reviewComponents.length, 0);
    const resolved = f.store.resolveExecution({
        capabilityId: active.capabilityId,
        expectedRevision: active.revision,
        ...f.scope,
        operation: 'launch'
    });
    assert.deepEqual(resolved.details.argv, ['--name', 'two words']);
    assert.equal(resolved.details.runAsAdmin, true);
    assert.equal(resolved.details.highPriority, false);
    assert.equal(resolved.details.postLaunchScript, '');
});

test('filesystem roots are locally selected, operation scoped, revision checked and replay safe', t => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const save = f.store.createApprovedFilesystem(f.scope, 'save', f.savePath);
    assertCode('SAIL_CAPABILITY_WRONG_OPERATION', () => f.store.resolveFilesystem({
        capabilityId: save.capabilityId,
        expectedRevision: save.revision,
        ...f.scope,
        operation: 'config-read'
    }));
    const read = f.store.resolveFilesystem({
        capabilityId: save.capabilityId,
        expectedRevision: save.revision,
        ...f.scope,
        operation: 'save-read'
    });
    assert.equal(read.details.rootPath, f.savePath);
    assertCode('SAIL_CAPABILITY_REPLAYED', () => f.store.resolveFilesystem({
        capabilityId: save.capabilityId,
        expectedRevision: save.revision,
        ...f.scope,
        operation: 'save-read'
    }));

    const pending = f.store.createPendingFilesystem(f.scope, 'config', f.configPath, 'config-main');
    assert.equal(pending.state, 'pending-review');
    const approved = f.store.approvePendingFilesystem(pending.capabilityId, f.configPath);
    const config = f.store.resolveFilesystem({
        capabilityId: approved.capabilityId,
        expectedRevision: approved.revision,
        ...f.scope,
        operation: 'config-write'
    });
    assert.equal(config.details.rootPath, f.configPath);
});

test('approved mutable data files retain path identity after their contents change', t => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const created = f.store.createApprovedFilesystem(f.scope, 'config', f.configPath, 'config-main');
    const write = f.store.resolveFilesystem({
        capabilityId: created.capabilityId,
        expectedRevision: created.revision,
        ...f.scope,
        operation: 'config-write'
    });
    fs.writeFileSync(f.configPath, 'setting=false\nupdated=true');
    const read = f.store.resolveFilesystem({
        capabilityId: write.replacement.capabilityId,
        expectedRevision: write.replacement.revision,
        ...f.scope,
        operation: 'config-read'
    });
    assert.equal(read.details.rootPath, f.configPath);
});

test('approved argument parsing returns argv data and never a shell fragment', () => {
    assert.deepEqual(parseArgumentString('--one "two words" plain'), ['--one', 'two words', 'plain']);
    assert.deepEqual(parseArgumentString(''), []);
    assertCode('SAIL_CAPABILITY_INVALID', () => parseArgumentString('"unterminated'));
});

test('tampered persisted authority fails closed instead of becoming active', t => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    f.store.createApprovedExecution(f.scope, {
        executablePath: f.executablePath,
        argv: ['--approved'],
        workingDirectory: f.files,
        runAsAdmin: false,
        highPriority: false
    });
    const executionPath = path.join(f.root, 'authority', 'execution.json');
    const persisted = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
    persisted.records[0].details.shellFragment = '&& attacker.exe';
    fs.writeFileSync(executionPath, JSON.stringify(persisted));
    const restarted = new CapabilityStore(path.join(f.root, 'authority'), () => ({ ...f.active }));
    assertCode('SAIL_CAPABILITY_INVALID', () => restarted.initialize());
});

test('download install ownership is delete-only and rejects a replaced directory identity', t => {
    const f = fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const install = path.join(f.root, 'installed-game');
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, 'game.exe'), 'game');
    const capability = f.store.createApprovedFilesystem(f.scope, 'game-install', install, '', 'download-result');

    assertCode('SAIL_CAPABILITY_WRONG_OPERATION', () => f.store.validateFilesystem({
        capabilityId: capability.capabilityId,
        expectedRevision: capability.revision,
        ...f.scope,
        operation: 'folder-open'
    }));
    assert.equal(f.store.validateFilesystem({
        capabilityId: capability.capabilityId,
        expectedRevision: capability.revision,
        ...f.scope,
        operation: 'install-delete'
    }).details.rootPath, install);

    const moved = `${install}-old`;
    fs.renameSync(install, moved);
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, 'different.exe'), 'different');
    assertCode('SAIL_CAPABILITY_PATH_CHANGED', () => f.store.validateFilesystem({
        capabilityId: capability.capabilityId,
        expectedRevision: capability.revision,
        ...f.scope,
        operation: 'install-delete'
    }));
});
