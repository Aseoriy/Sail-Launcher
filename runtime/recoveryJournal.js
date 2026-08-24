'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_SCHEMA_VERSION = 1;
const MAX_COMPLETED_SESSIONS = 100;
const MAX_POST_EXIT_JOBS = 50;
const MAX_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function finiteTime(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
}

function cleanText(value, maxLength = 240) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, maxLength);
}

function cleanExeName(value) {
    return cleanText(value, 260).split(/[\\/]/).pop().toLowerCase();
}

function activeSessionKey(libraryKey, gameId) {
    return `${cleanText(libraryKey || 'local:default', 240)}::${cleanText(gameId, 160)}`;
}

function findActiveSession(state, input = {}) {
    const sessionId = cleanText(input.sessionId, 160);
    if (sessionId) return Object.entries(state.activeSessions).find(([, item]) => item.sessionId === sessionId) || null;
    const gameId = cleanText(input.gameId, 160);
    const libraryKey = cleanText(input.libraryKey || 'local:default', 240);
    const key = activeSessionKey(libraryKey, gameId);
    return state.activeSessions[key] ? [key, state.activeSessions[key]] : null;
}

function safeError(value) {
    return cleanText(value, 300)
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
        .replace(/([?&](?:access_token|refresh_token|token|key)=)[^&\s]+/gi, '$1[redacted]');
}

function operation(required) {
    return {
        required: !!required,
        status: required ? 'pending' : 'skipped',
        stage: required ? 'waiting' : 'not-required',
        error: '',
        checkpoints: []
    };
}

function cleanCheckpoint(value) {
    return cleanText(value, 100).toLowerCase().replace(/[^a-z0-9:_-]/g, '');
}

function operationFinished(value) {
    return !value.required || ['complete', 'skipped'].includes(value.status);
}

function normalizeOperation(value, required) {
    const next = value && typeof value === 'object' ? value : operation(required);
    next.required = required !== undefined ? !!required : !!next.required;
    next.checkpoints = [...new Set((Array.isArray(next.checkpoints) ? next.checkpoints : [])
        .map(cleanCheckpoint)
        .filter(Boolean))].slice(-30);
    if (!next.required) {
        next.status = 'skipped';
        next.stage = 'not-required';
        next.error = '';
        return next;
    }
    if (!['pending', 'running', 'retry', 'complete'].includes(next.status)) next.status = 'pending';
    next.stage = cleanText(next.stage || 'waiting', 80);
    next.error = safeError(next.error);
    return next;
}

function emptyState() {
    return {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        activeSessions: {},
        completedSessions: [],
        postExitJobs: []
    };
}

function normalizeState(value) {
    const state = value && typeof value === 'object' ? value : {};
    const activeSessions = {};
    for (const [key, raw] of Object.entries(state.activeSessions || {})) {
        if (!raw || typeof raw !== 'object') continue;
        const gameId = cleanText(raw.gameId || key, 160);
        const sessionId = cleanText(raw.sessionId, 160);
        const startedAt = finiteTime(raw.startedAt, 0);
        if (!gameId || !sessionId || !startedAt) continue;
        const libraryKey = cleanText(raw.libraryKey || 'local:default', 240);
        activeSessions[activeSessionKey(libraryKey, gameId)] = {
            sessionId,
            gameId,
            libraryKey,
            gameName: cleanText(raw.gameName || 'Unknown game', 200),
            startedAt,
            lastHeartbeatAt: Math.max(startedAt, finiteTime(raw.lastHeartbeatAt, startedAt)),
            pid: Number.isInteger(Number(raw.pid)) && Number(raw.pid) > 0 ? Number(raw.pid) : null,
            exeName: cleanExeName(raw.exeName),
            processConfirmed: !!raw.processConfirmed,
            needsSaveSync: !!raw.needsSaveSync,
            needsGameConfigSync: !!raw.needsGameConfigSync,
            recovered: !!raw.recovered
        };
    }

    const completedSessions = (Array.isArray(state.completedSessions) ? state.completedSessions : [])
        .filter(item => item && item.id && item.gameId && Number(item.durationSeconds) >= 0)
        .slice(-MAX_COMPLETED_SESSIONS)
        .map(item => ({
            id: cleanText(item.id, 180),
            sessionId: cleanText(item.sessionId, 160),
            gameId: cleanText(item.gameId, 160),
            libraryKey: cleanText(item.libraryKey || 'local:default', 240),
            gameName: cleanText(item.gameName || 'Unknown game', 200),
            startedAt: finiteTime(item.startedAt, 0),
            endedAt: finiteTime(item.endedAt, 0),
            durationSeconds: Math.max(0, Number(item.durationSeconds) || 0),
            reason: cleanText(item.reason || 'process-exited', 80),
            postExitJobId: cleanText(item.postExitJobId, 180) || null
        }));

    const postExitJobs = (Array.isArray(state.postExitJobs) ? state.postExitJobs : [])
        .filter(item => item && item.id && item.gameId)
        .slice(-MAX_POST_EXIT_JOBS)
        .map(item => ({
            id: cleanText(item.id, 180),
            sessionId: cleanText(item.sessionId, 160) || null,
            gameId: cleanText(item.gameId, 160),
            libraryKey: cleanText(item.libraryKey || 'local:default', 240),
            gameName: cleanText(item.gameName || 'Unknown game', 200),
            createdAt: finiteTime(item.createdAt, Date.now()),
            updatedAt: finiteTime(item.updatedAt, Date.now()),
            save: normalizeOperation(item.save, item.save && item.save.required),
            config: normalizeOperation(item.config, item.config && item.config.required)
        }));

    return { schemaVersion: RUNTIME_SCHEMA_VERSION, activeSessions, completedSessions, postExitJobs };
}

class RecoveryJournal {
    constructor(filePath, options = {}) {
        this.filePath = filePath;
        this.backupPath = `${filePath}.bak`;
        this.fs = options.fs || fs;
        this.now = options.now || (() => Date.now());
        this.idFactory = options.idFactory || (() => crypto.randomUUID());
        this.state = this.readState();
        let changed = false;
        for (const session of Object.values(this.state.activeSessions)) {
            if (!session.recovered) {
                session.recovered = true;
                changed = true;
            }
        }
        for (const job of this.state.postExitJobs) {
            for (const value of [job.save, job.config]) {
                if (value.required && value.status === 'running') {
                    value.status = 'retry';
                    value.error = 'Sail closed before this operation finished.';
                    changed = true;
                }
            }
        }
        if (changed) this.persist();
    }

    readState() {
        for (const candidate of [this.filePath, this.backupPath]) {
            try {
                if (!this.fs.existsSync(candidate)) continue;
                return normalizeState(JSON.parse(this.fs.readFileSync(candidate, 'utf8')));
            } catch (_) {}
        }
        return emptyState();
    }

    persist() {
        const directory = path.dirname(this.filePath);
        const temporaryPath = `${this.filePath}.${process.pid}.${this.idFactory()}.tmp`;
        this.fs.mkdirSync(directory, { recursive: true });
        this.fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
        try {
            if (this.fs.existsSync(this.filePath)) this.fs.copyFileSync(this.filePath, this.backupPath);
            this.fs.rmSync(this.filePath, { force: true });
            this.fs.renameSync(temporaryPath, this.filePath);
        } catch (error) {
            try { this.fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
            throw error;
        }
    }

    snapshot() {
        return clone(this.state);
    }

    startSession(input = {}) {
        const gameId = cleanText(input.gameId, 160);
        if (!gameId) throw new Error('A game ID is required to track playtime.');
        const now = this.now();
        const libraryKey = cleanText(input.libraryKey || 'local:default', 240);
        const storageKey = activeSessionKey(libraryKey, gameId);
        const existing = this.state.activeSessions[storageKey];
        if (existing) {
            existing.pid = Number(input.pid) > 0 ? Number(input.pid) : existing.pid;
            existing.exeName = cleanExeName(input.exeName) || existing.exeName;
            existing.processConfirmed = existing.processConfirmed || !!input.processConfirmed;
            existing.needsSaveSync = existing.needsSaveSync || !!input.needsSaveSync;
            existing.needsGameConfigSync = existing.needsGameConfigSync || !!input.needsGameConfigSync;
            existing.recovered = false;
            this.persist();
            return clone(existing);
        }
        const startedAt = Math.min(now, finiteTime(input.startedAt, now));
        const session = {
            sessionId: cleanText(input.sessionId, 160) || this.idFactory(),
            gameId,
            libraryKey,
            gameName: cleanText(input.gameName || 'Unknown game', 200),
            startedAt,
            lastHeartbeatAt: startedAt,
            pid: Number(input.pid) > 0 ? Number(input.pid) : null,
            exeName: cleanExeName(input.exeName),
            processConfirmed: !!input.processConfirmed,
            needsSaveSync: !!input.needsSaveSync,
            needsGameConfigSync: !!input.needsGameConfigSync,
            recovered: false
        };
        this.state.activeSessions[storageKey] = session;
        this.persist();
        return clone(session);
    }

    touchSession(input = {}) {
        const gameId = cleanText(input.gameId, 160);
        const found = findActiveSession(this.state, input);
        if (!found) return null;
        const session = found[1];
        if (gameId && session.gameId !== gameId) return null;
        const observedAt = Math.max(session.startedAt, finiteTime(input.observedAt, this.now()));
        session.lastHeartbeatAt = Math.max(session.lastHeartbeatAt, observedAt);
        if (Number(input.pid) > 0) session.pid = Number(input.pid);
        if (cleanExeName(input.exeName)) session.exeName = cleanExeName(input.exeName);
        session.processConfirmed = true;
        session.recovered = false;
        this.persist();
        return clone(session);
    }

    ensurePostExitJob(input = {}, persist = true) {
        const gameId = cleanText(input.gameId, 160);
        if (!gameId) throw new Error('A game ID is required for post-exit recovery.');
        const sessionId = cleanText(input.sessionId, 160) || null;
        let job = null;
        if (input.jobId) job = this.state.postExitJobs.find(item => item.id === cleanText(input.jobId, 180));
        if (!job && sessionId) job = this.state.postExitJobs.find(item => item.sessionId === sessionId);
        const libraryKey = cleanText(input.libraryKey || 'local:default', 240);
        if (!job) job = [...this.state.postExitJobs].reverse().find(item => item.gameId === gameId && item.libraryKey === libraryKey && (!operationFinished(item.save) || !operationFinished(item.config)));
        const now = this.now();
        if (!job) {
            job = {
                id: cleanText(input.jobId, 180) || `post-exit:${sessionId || this.idFactory()}`,
                sessionId,
                gameId,
                libraryKey,
                gameName: cleanText(input.gameName || 'Unknown game', 200),
                createdAt: now,
                updatedAt: now,
                save: operation(input.needsSaveSync),
                config: operation(input.needsGameConfigSync)
            };
            this.state.postExitJobs.push(job);
        } else {
            if (input.needsSaveSync) job.save = normalizeOperation(job.save, true);
            if (input.needsGameConfigSync) job.config = normalizeOperation(job.config, true);
            job.updatedAt = now;
        }
        this.state.postExitJobs = this.state.postExitJobs.slice(-MAX_POST_EXIT_JOBS);
        if (persist) this.persist();
        return clone(job);
    }

    finishSession(input = {}) {
        const gameId = cleanText(input.gameId, 160);
        const requestedSessionId = cleanText(input.sessionId, 160);
        const found = findActiveSession(this.state, input);
        const session = found && found[1];
        if (!session || gameId && session.gameId !== gameId || requestedSessionId && session.sessionId !== requestedSessionId) {
            const existing = [...this.state.completedSessions].reverse().find(item =>
                requestedSessionId ? item.sessionId === requestedSessionId : item.gameId === gameId
            );
            return existing ? clone(existing) : null;
        }
        const now = this.now();
        const requestedEnd = finiteTime(input.endedAt, now);
        const endedAt = Math.max(session.startedAt, Math.min(now, requestedEnd));
        const durationMs = Math.min(MAX_SESSION_DURATION_MS, Math.max(0, endedAt - session.startedAt));
        const postExitJob = session.needsSaveSync || session.needsGameConfigSync
            ? this.ensurePostExitJob({
                sessionId: session.sessionId,
                gameId,
                libraryKey: session.libraryKey,
                gameName: session.gameName,
                needsSaveSync: session.needsSaveSync,
                needsGameConfigSync: session.needsGameConfigSync
            }, false)
            : null;
        const event = {
            id: `session:${session.sessionId}`,
            sessionId: session.sessionId,
            gameId,
            libraryKey: session.libraryKey,
            gameName: session.gameName,
            startedAt: session.startedAt,
            endedAt,
            durationSeconds: Math.round(durationMs / 1000),
            reason: cleanText(input.reason || 'process-exited', 80),
            postExitJobId: postExitJob ? postExitJob.id : null
        };
        delete this.state.activeSessions[found[0]];
        this.state.completedSessions.push(event);
        this.state.completedSessions = this.state.completedSessions.slice(-MAX_COMPLETED_SESSIONS);
        this.persist();
        return clone(event);
    }

    acknowledgeSession(eventId) {
        const id = cleanText(eventId, 180);
        const before = this.state.completedSessions.length;
        this.state.completedSessions = this.state.completedSessions.filter(item => item.id !== id);
        if (this.state.completedSessions.length !== before) this.persist();
        return this.state.completedSessions.length !== before;
    }

    updatePostExitJob(input = {}) {
        const job = this.state.postExitJobs.find(item => item.id === cleanText(input.jobId, 180));
        if (!job) return null;
        const key = input.operation === 'config' ? 'config' : 'save';
        const target = job[key];
        if (!target.required && input.required !== true) return clone(job);
        target.required = true;
        const status = cleanText(input.status, 20);
        if (['pending', 'running', 'retry', 'complete', 'skipped'].includes(status)) target.status = status;
        if (input.stage !== undefined) target.stage = cleanText(input.stage, 80);
        const checkpoint = cleanCheckpoint(input.checkpoint);
        if (checkpoint && !target.checkpoints.includes(checkpoint)) {
            target.checkpoints = [...target.checkpoints, checkpoint].slice(-30);
        }
        target.error = target.status === 'retry' ? safeError(input.error || target.error) : '';
        job.updatedAt = this.now();
        const finished = operationFinished(job.save) && operationFinished(job.config);
        if (finished) this.state.postExitJobs = this.state.postExitJobs.filter(item => item.id !== job.id);
        this.persist();
        return { job: clone(job), finished };
    }
}

module.exports = {
    MAX_SESSION_DURATION_MS,
    RUNTIME_SCHEMA_VERSION,
    RecoveryJournal,
    normalizeState,
    safeError
};
