'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RecoveryJournal } = require('../runtime/recoveryJournal');

function fixture(t, start = 1_720_000_000_000) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let now = start;
    let nextId = 0;
    return {
        filePath: path.join(root, 'runtime-recovery.json'),
        journal: () => new RecoveryJournal(path.join(root, 'runtime-recovery.json'), {
            now: () => now,
            idFactory: () => `id-${++nextId}`
        }),
        setNow(value) { now = value; }
    };
}

test('active sessions survive a restart and finish at the last durable heartbeat', t => {
    const env = fixture(t);
    const first = env.journal();
    const session = first.startSession({ gameId: 'game-1', gameName: 'Pookie Quest', exeName: 'game.exe', needsSaveSync: true });
    env.setNow(1_720_000_030_000);
    first.touchSession({ gameId: 'game-1', sessionId: session.sessionId });

    env.setNow(1_720_000_090_000);
    const recovered = env.journal();
    const active = Object.values(recovered.snapshot().activeSessions)[0];
    assert.equal(active.recovered, true);
    assert.equal(active.processConfirmed, true);
    const event = recovered.finishSession({ gameId: 'game-1', sessionId: session.sessionId, endedAt: active.lastHeartbeatAt, reason: 'launcher-recovered-session' });
    assert.equal(event.durationSeconds, 30);
    assert.ok(event.postExitJobId);
    assert.equal(recovered.snapshot().postExitJobs[0].save.status, 'pending');
});

test('session acknowledgements are idempotent and do not remove recovery work', t => {
    const env = fixture(t);
    const journal = env.journal();
    const session = journal.startSession({ gameId: 'game-2', gameName: 'Two', needsSaveSync: true, needsGameConfigSync: true });
    env.setNow(1_720_000_010_000);
    const event = journal.finishSession({ gameId: 'game-2', sessionId: session.sessionId });
    assert.equal(journal.acknowledgeSession(event.id), true);
    assert.equal(journal.acknowledgeSession(event.id), false);
    const state = journal.snapshot();
    assert.equal(state.completedSessions.length, 0);
    assert.equal(state.postExitJobs.length, 1);
    assert.equal(state.postExitJobs[0].config.required, true);
});

test('interrupted save work becomes retryable and is cleared only after every required operation', t => {
    const env = fixture(t);
    const first = env.journal();
    const job = first.ensurePostExitJob({ gameId: 'game-3', gameName: 'Three', needsSaveSync: true, needsGameConfigSync: true });
    first.updatePostExitJob({
        jobId: job.id,
        operation: 'save',
        status: 'running',
        stage: 'uploading',
        checkpoint: 'local-backup'
    });

    const recovered = env.journal();
    let state = recovered.snapshot();
    assert.equal(state.postExitJobs[0].save.status, 'retry');
    assert.match(state.postExitJobs[0].save.error, /closed before/i);
    assert.deepEqual(state.postExitJobs[0].save.checkpoints, ['local-backup']);
    recovered.updatePostExitJob({
        jobId: job.id,
        operation: 'save',
        status: 'running',
        stage: 'uploading',
        checkpoint: 'local-backup'
    });
    assert.deepEqual(recovered.snapshot().postExitJobs[0].save.checkpoints, ['local-backup']);
    recovered.updatePostExitJob({ jobId: job.id, operation: 'save', status: 'complete', stage: 'uploaded' });
    state = recovered.snapshot();
    assert.equal(state.postExitJobs.length, 1);
    const result = recovered.updatePostExitJob({ jobId: job.id, operation: 'config', status: 'complete', stage: 'uploaded' });
    assert.equal(result.finished, true);
    assert.equal(recovered.snapshot().postExitJobs.length, 0);
});

test('journal errors redact bearer credentials and query tokens', t => {
    const env = fixture(t);
    const journal = env.journal();
    const job = journal.ensurePostExitJob({ gameId: 'game-4', needsSaveSync: true });
    journal.updatePostExitJob({
        jobId: job.id,
        operation: 'save',
        status: 'retry',
        error: 'Bearer very-secret-token https://example.test/upload?access_token=also-secret'
    });
    const serialized = fs.readFileSync(env.filePath, 'utf8');
    assert.doesNotMatch(serialized, /very-secret-token|also-secret/);
    assert.match(serialized, /\[redacted\]/);
});

test('sessions with the same game ID stay isolated between launcher libraries', t => {
    const env = fixture(t);
    const journal = env.journal();
    const first = journal.startSession({ gameId: 'shared-id', libraryKey: 'profile-a:library', gameName: 'A' });
    const second = journal.startSession({ gameId: 'shared-id', libraryKey: 'profile-b:library', gameName: 'B' });
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(Object.keys(journal.snapshot().activeSessions).length, 2);
    env.setNow(1_720_000_005_000);
    const event = journal.finishSession({ gameId: 'shared-id', libraryKey: 'profile-a:library', sessionId: first.sessionId });
    assert.equal(event.libraryKey, 'profile-a:library');
    assert.equal(Object.keys(journal.snapshot().activeSessions).length, 1);
});

test('game purge removes completed and post-exit recovery data but refuses active sessions', t => {
    const env = fixture(t);
    const journal = env.journal();
    const active = journal.startSession({
        gameId: 'game-remove', libraryKey: 'profile:library', gameName: 'Remove Me',
        startedAt: 1_720_000_000_000, needsSaveSync: true
    });
    assert.throws(() => journal.purgeGame({ gameId: 'game-remove', libraryKey: 'profile:library' }), /close the game/i);
    env.setNow(1_720_000_005_000);
    journal.finishSession({
        gameId: 'game-remove', libraryKey: 'profile:library', sessionId: active.sessionId,
        endedAt: 1_720_000_005_000
    });
    const removed = journal.purgeGame({ gameId: 'game-remove', libraryKey: 'profile:library' });
    assert.equal(removed.completedSessions, 1);
    assert.equal(removed.postExitJobs, 1);
    assert.equal(journal.snapshot().completedSessions.length, 0);
    assert.equal(journal.snapshot().postExitJobs.length, 0);
});
