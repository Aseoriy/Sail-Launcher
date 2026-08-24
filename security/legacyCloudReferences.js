'use strict';

const crypto = require('crypto');

const REFERENCE_PATTERN = /^[0-9a-f-]{36}$/i;
const CONFIG_ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class LegacyCloudReferenceStore {
    constructor(getProfileStore, options = {}) {
        if (typeof getProfileStore !== 'function') throw new TypeError('Legacy cloud references require the active profile store.');
        this.getProfileStore = getProfileStore;
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        this.makeId = typeof options.makeId === 'function' ? options.makeId : () => crypto.randomUUID();
        this.ttlMs = Number.isSafeInteger(options.ttlMs) ? options.ttlMs : 15 * 60 * 1000;
        this.records = new Map();
    }

    scope(input = {}) {
        const store = this.getProfileStore();
        const gameId = String(input.gameId || '');
        const artifactType = String(input.artifactType || '');
        const configEntryId = String(input.configEntryId || '');
        const active = store.activeScope();
        if (gameId === 'launcher-portable') {
            if (artifactType !== 'launcher-config' || configEntryId) throw new Error('The portable cloud artifact scope is invalid.');
            return {
                ...active,
                gameId,
                artifactType,
                configEntryId: '',
                gameName: 'sail_library',
                subFolder: 'Config'
            };
        }
        const metadata = store.activeGameMetadata(gameId);
        const safeName = String(metadata.name || 'Game')
            .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '')
            .slice(0, 120) || 'Game';
        if (artifactType === 'game-save' && !configEntryId) {
            return {
                ...active,
                gameId,
                artifactType,
                configEntryId: '',
                gameName: safeName,
                subFolder: `${safeName}/Saves`
            };
        }
        if (artifactType === 'game-config' && CONFIG_ENTRY_PATTERN.test(configEntryId)
            && (metadata.configSyncEntries || []).some(entry => String(entry.id) === configEntryId)) {
            return {
                ...active,
                gameId,
                artifactType,
                configEntryId,
                gameName: `${gameId}-${configEntryId}`,
                subFolder: 'GameConfigs'
            };
        }
        throw new Error('The cloud artifact scope does not match the active game.');
    }

    prune(now) {
        for (const [reference, record] of this.records) {
            if (record.expiresAt <= now) this.records.delete(reference);
        }
        if (this.records.size > 5000) {
            for (const reference of [...this.records.keys()].slice(0, this.records.size - 4000)) {
                this.records.delete(reference);
            }
        }
    }

    issue(scope, provider, versions) {
        const now = this.now();
        this.prune(now);
        return (Array.isArray(versions) ? versions : []).slice(0, 500).map(row => {
            const fileId = String(row && row.id || '');
            if (!fileId || fileId.length > 2048 || /[\u0000-\u001f\u007f]/.test(fileId)) return null;
            const reference = this.makeId();
            this.records.set(reference, {
                reference,
                provider,
                fileId,
                profileId: scope.profileId,
                libraryId: scope.libraryId,
                gameId: scope.gameId,
                artifactType: scope.artifactType,
                configEntryId: scope.configEntryId,
                expiresAt: now + this.ttlMs
            });
            return {
                reference,
                name: String(row && row.name || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 512),
                date: String(row && row.date || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128),
                size: Number.isFinite(Number(row && row.size)) && Number(row.size) >= 0 ? Number(row.size) : null
            };
        }).filter(Boolean);
    }

    resolve(input, provider) {
        const reference = String(input && input.reference || '');
        if (!REFERENCE_PATTERN.test(reference)) throw new Error('The cloud version reference is invalid.');
        const record = this.records.get(reference);
        if (!record || record.expiresAt <= this.now()) {
            this.records.delete(reference);
            throw new Error('The cloud version reference is stale or unavailable.');
        }
        const scope = this.scope(input);
        if (record.provider !== provider || record.profileId !== scope.profileId || record.libraryId !== scope.libraryId
            || record.gameId !== scope.gameId || record.artifactType !== scope.artifactType
            || record.configEntryId !== scope.configEntryId) {
            throw new Error('The cloud version reference belongs to another profile, library, game, or artifact.');
        }
        this.records.delete(reference);
        return { ...record };
    }
}

module.exports = { LegacyCloudReferenceStore };
