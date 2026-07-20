'use strict';

const crypto = require('crypto');

class MaintenanceJobManager {
    constructor(options = {}) {
        this.maxConcurrent = Math.max(1, Math.min(8, Number(options.maxConcurrent) || 2));
        this.onEvent = options.onEvent || (() => {});
        this.jobs = new Map();
        this.queue = [];
        this.running = 0;
        this.historyLimit = options.historyLimit || 100;
    }

    setMaxConcurrent(value) {
        this.maxConcurrent = Math.max(1, Math.min(8, Number(value) || 2));
        this._drain();
    }

    hasConflict(gameId) {
        if (!gameId) return false;
        return Array.from(this.jobs.values()).some(job => job.gameId === String(gameId) && ['queued', 'running', 'cancelling'].includes(job.status));
    }

    enqueue(type, gameId, worker, metadata = {}) {
        if (gameId && this.hasConflict(gameId)) {
            const error = new Error('Another maintenance job is already active for this game.');
            error.code = 'JOB_CONFLICT';
            throw error;
        }
        const job = {
            id: crypto.randomUUID(),
            type,
            gameId: gameId ? String(gameId) : null,
            status: 'queued',
            phase: 'queued',
            percent: 0,
            currentFile: '',
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            error: null,
            result: null,
            metadata,
            controller: new AbortController(),
            worker,
            lastProgressAt: 0
        };
        this.jobs.set(job.id, job);
        this.queue.push(job.id);
        this._emit(job, true);
        this._drain();
        return this.snapshot(job);
    }

    cancel(jobId) {
        const job = this.jobs.get(jobId);
        if (!job || !['queued', 'running', 'cancelling'].includes(job.status)) return false;
        job.controller.abort();
        if (job.status === 'queued') {
            job.status = 'cancelled';
            job.phase = 'cancelled';
            job.completedAt = new Date().toISOString();
            this.queue = this.queue.filter(id => id !== job.id);
        } else {
            job.status = 'cancelling';
            job.phase = 'cancelling';
        }
        this._emit(job, true);
        return true;
    }

    cancelAll() {
        for (const job of this.jobs.values()) this.cancel(job.id);
    }

    clearCompleted() {
        let cleared = 0;
        for (const [id, job] of this.jobs) {
            if (['queued', 'running', 'cancelling'].includes(job.status)) continue;
            this.jobs.delete(id);
            cleared += 1;
        }
        return cleared;
    }

    list(options = {}) {
        const includeCompleted = options.includeCompleted !== false;
        return Array.from(this.jobs.values())
            .filter(job => includeCompleted || ['queued', 'running', 'cancelling'].includes(job.status))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
            .map(job => this.snapshot(job));
    }

    get(jobId) {
        const job = this.jobs.get(jobId);
        return job ? this.snapshot(job) : null;
    }

    snapshot(job) {
        const { controller, worker, lastProgressAt, ...safe } = job;
        return JSON.parse(JSON.stringify(safe));
    }

    _progress(job, update = {}) {
        if (!job || !['running', 'cancelling'].includes(job.status)) return;
        if (update.phase) job.phase = update.phase;
        if (update.percent !== undefined) job.percent = Math.max(0, Math.min(100, Number(update.percent) || 0));
        if (update.currentFile !== undefined) job.currentFile = update.currentFile || '';
        if (update.processedFiles !== undefined) job.processedFiles = update.processedFiles;
        if (update.totalFiles !== undefined) {
            job.totalFiles = update.totalFiles;
            if (update.percent === undefined && update.totalFiles > 0) job.percent = Math.round((update.processedFiles || 0) / update.totalFiles * 100);
        }
        const now = Date.now();
        const force = update.force || (update.phase && update.phase !== job.lastEmittedPhase);
        if (force || now - job.lastProgressAt >= 120) {
            job.lastProgressAt = now;
            job.lastEmittedPhase = job.phase;
            this._emit(job);
        }
    }

    _emit(job, force = false) {
        try { this.onEvent(this.snapshot(job), force); } catch (_) {}
    }

    _drain() {
        while (this.running < this.maxConcurrent && this.queue.length) {
            const id = this.queue.shift();
            const job = this.jobs.get(id);
            if (!job || job.status !== 'queued') continue;
            this._run(job);
        }
    }

    async _run(job) {
        this.running += 1;
        job.status = 'running';
        job.phase = 'starting';
        job.startedAt = new Date().toISOString();
        this._emit(job, true);
        try {
            const result = await job.worker({
                jobId: job.id,
                signal: job.controller.signal,
                progress: update => this._progress(job, update)
            });
            if (job.controller.signal.aborted) {
                job.status = 'cancelled';
                job.phase = 'cancelled';
            } else {
                job.status = 'completed';
                job.phase = 'completed';
                job.percent = 100;
                job.result = result === undefined ? null : result;
            }
        } catch (error) {
            if (job.controller.signal.aborted || error.code === 'CANCELLED' || error.name === 'CancellationError') {
                job.status = 'cancelled';
                job.phase = 'cancelled';
            } else {
                job.status = 'failed';
                job.phase = 'failed';
                job.error = { code: error.code || 'MAINTENANCE_ERROR', message: error.message || String(error) };
            }
        } finally {
            job.completedAt = new Date().toISOString();
            this.running -= 1;
            this._emit(job, true);
            this._trimHistory();
            this._drain();
        }
    }

    _trimHistory() {
        const completed = Array.from(this.jobs.values())
            .filter(job => !['queued', 'running', 'cancelling'].includes(job.status))
            .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
        for (const job of completed.slice(this.historyLimit)) this.jobs.delete(job.id);
    }
}

module.exports = { MaintenanceJobManager };
