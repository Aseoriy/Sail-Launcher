'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_IDLE_MINUTES = 5;
const MAX_TRACKED_SESSIONS = 64;

function idleMinutesValue(value) {
    const minutes = Number(value);
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 120 ? minutes : DEFAULT_IDLE_MINUTES;
}

// Counts how much of each running game session nobody touched the keyboard, mouse or a controller.
// Once input has been quiet for the idle limit, the whole quiet stretch counts as idle (back to the
// last input), so "active" time never includes the minutes spent waiting for the limit to pass.
class ActivityMonitor {
    constructor({ filePath, systemIdleSeconds, controllers = null, now = Date.now } = {}) {
        this.filePath = filePath;
        this.systemIdleSeconds = systemIdleSeconds;
        this.controllers = controllers;
        this.now = now;
        this.idleLimitMs = DEFAULT_IDLE_MINUTES * 60000;
        this.sessions = this.read();
        this.dirty = false;
        this.primed = false;
    }

    read() {
        try {
            const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            const sessions = value && value.schemaVersion === 1 && value.sessions && typeof value.sessions === 'object' ? value.sessions : {};
            const valid = {};
            for (const [id, record] of Object.entries(sessions).slice(-MAX_TRACKED_SESSIONS)) {
                if (record && Number.isFinite(record.idleMs) && record.idleMs >= 0 && Number.isFinite(record.countedUntil)) {
                    valid[id] = { idleMs: record.idleMs, countedUntil: record.countedUntil };
                }
            }
            return valid;
        } catch (error) {
            if (error.code !== 'ENOENT') console.error('Active playtime record could not be read; idle time starts over:', error.message);
            return {};
        }
    }

    persist() {
        if (!this.dirty || !this.filePath) return;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const temporary = `${this.filePath}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, sessions: this.sessions }));
            fs.renameSync(temporary, this.filePath);
            this.dirty = false;
        } catch (error) {
            console.error('Active playtime record could not be saved:', error.message);
        }
    }

    setIdleMinutes(value) {
        this.idleLimitMs = idleMinutesValue(value) * 60000;
        return this.idleLimitMs / 60000;
    }

    lastInputAt(now) {
        let idleSeconds = Number(this.systemIdleSeconds());
        // Chromium reports 0 on its first read on some desktops, before it has a real value.
        if (!this.primed) { this.primed = true; if (idleSeconds === 0) idleSeconds = NaN; }
        let last = Number.isFinite(idleSeconds) && idleSeconds >= 0 ? now - idleSeconds * 1000 : now;
        const controllerAt = this.controllers ? this.controllers.lastActivityAt() : 0;
        if (Number.isFinite(controllerAt) && controllerAt > last) last = Math.min(now, controllerAt);
        return last;
    }

    // `sessions` are the recovery journal's active sessions.
    tick(sessions) {
        const now = this.now();
        const running = (Array.isArray(sessions) ? sessions : []).filter(item => item && item.sessionId && Number.isFinite(item.startedAt));
        if (this.controllers) this.controllers.setActive(running.length > 0);
        if (!running.length) { this.primed = false; return; }
        if (this.controllers) this.controllers.poll();
        const lastInput = this.lastInputAt(now);
        const idle = now - lastInput >= this.idleLimitMs;
        for (const session of running) {
            const record = this.sessions[session.sessionId] || (this.sessions[session.sessionId] = { idleMs: 0, countedUntil: session.startedAt });
            if (!idle) continue;
            const from = Math.max(lastInput, record.countedUntil, session.startedAt);
            if (now > from) { record.idleMs += now - from; record.countedUntil = now; this.dirty = true; }
        }
        const ids = Object.keys(this.sessions);
        if (ids.length > MAX_TRACKED_SESSIONS) {
            for (const id of ids.slice(0, ids.length - MAX_TRACKED_SESSIONS)) delete this.sessions[id];
            this.dirty = true;
        }
        this.persist();
    }

    // Idle seconds seen during a session; a session Sail never watched has none to subtract.
    idleSecondsFor(sessionId) {
        const record = this.sessions[sessionId];
        return record ? Math.round(record.idleMs / 1000) : 0;
    }

    forget(sessionId) {
        if (!this.sessions[sessionId]) return;
        delete this.sessions[sessionId];
        this.dirty = true;
        this.persist();
    }
}

module.exports = { ActivityMonitor, DEFAULT_IDLE_MINUTES, idleMinutesValue };
