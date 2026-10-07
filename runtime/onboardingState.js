'use strict';

const fs = require('node:fs');
const { durableWriteJson } = require('../security/capabilityStore');

const PROTOCOL = 1;
// Raise this when the first-run setup changes enough that people who finished an older one should see it again.
const SETUP_VERSION = 1;

// Remembers, on this device only, whether the first-run setup was finished or skipped. It is deliberately
// not part of the synced settings: finishing setup on one computer says nothing about another.
function createOnboardingState({ file, force = false, platform = process.platform, io = fs, write = durableWriteJson }) {
    function read() {
        try {
            const value = JSON.parse(io.readFileSync(file, 'utf8'));
            if (value && value.protocol === PROTOCOL && typeof value.completed === 'boolean') {
                return {
                    completed: value.completed,
                    skipped: value.skipped === true,
                    completedAt: typeof value.completedAt === 'string' ? value.completedAt.slice(0, 40) : '',
                    version: Number.isSafeInteger(value.version) ? value.version : 0,
                    rerunHidden: value.rerunHidden === true
                };
            }
        } catch (_) { /* A missing or damaged file means setup has not been completed. */ }
        return { completed: false, skipped: false, completedAt: '', version: 0, rerunHidden: false };
    }
    function status() {
        const state = read();
        const available = platform === 'linux';
        return {
            available,
            completed: state.completed,
            skipped: state.skipped,
            rerunHidden: state.rerunHidden,
            shouldShow: available && (force || !state.completed || state.version < SETUP_VERSION)
        };
    }
    function finish({ skipped = false } = {}) {
        if (platform !== 'linux') throw new Error('The first-run setup is not available on this platform.');
        write(file, { protocol: PROTOCOL, completed: true, skipped: skipped === true, completedAt: new Date().toISOString(), version: SETUP_VERSION, rerunHidden: read().rerunHidden });
        return { ...status(), shouldShow: false };
    }
    // The "Run setup again" card in Settings can be dismissed for good.
    function hideRerun() {
        if (platform !== 'linux') throw new Error('The first-run setup is not available on this platform.');
        const state = read();
        write(file, { protocol: PROTOCOL, completed: state.completed, skipped: state.skipped, completedAt: state.completedAt, version: state.version, rerunHidden: true });
        return status();
    }
    return { status, finish, hideRerun };
}

module.exports = { SETUP_VERSION, createOnboardingState };
