'use strict';

const crypto = require('crypto');
const { AchievementService } = require('./achievementService');

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalid(message) {
    const error = new Error(message);
    error.code = 'SAIL_GATE_A_INVALID_PAYLOAD';
    throw error;
}

function exactObject(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(`${label} has an unsupported prototype.`);
    for (const key of Object.keys(value)) {
        if (PROTOTYPE_KEYS.has(key) || !allowed.has(key)) invalid(`${label}.${key} is not allowed.`);
    }
    return value;
}

function boundedString(value, label, max, pattern = null) {
    if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label} is invalid.`);
    if (pattern && !pattern.test(value)) invalid(`${label} is invalid.`);
    return value;
}

function gameRequests(value) {
    if (!Array.isArray(value) || value.length > 5000) invalid('Achievement games must be a bounded array.');
    const seen = new Set();
    return value.map((item, index) => {
        const input = exactObject(item, new Set(['id', 'steamAppId']), `games[${index}]`);
        const id = boundedString(String(input.id || ''), `games[${index}].id`, 128, ID_PATTERN);
        if (seen.has(id)) invalid('Achievement game IDs must be unique.');
        seen.add(id);
        const steamAppId = input.steamAppId === undefined || input.steamAppId === ''
            ? ''
            : boundedString(String(input.steamAppId), `games[${index}].steamAppId`, 10, /^[1-9]\d{0,9}$/);
        return { id, steamAppId };
    });
}

function sourceView(record) {
    return {
        id: record.entryId || record.capabilityId,
        kind: record.kind === 'achievement-folder' ? 'folder' : 'file',
        label: String(record.label || 'Achievement source').slice(0, 256),
        capabilityId: record.capabilityId,
        expectedRevision: record.revision,
        state: record.state,
        enabled: record.state === 'active'
    };
}

function localSourceViews(status) {
    return (status && Array.isArray(status.filesystems) ? status.filesystems : [])
        .filter(record => record.kind === 'achievement-file' || record.kind === 'achievement-folder')
        .map(sourceView);
}

function localAuthorityVersion(status) {
    const execution = status && status.execution || {};
    const filesystems = status && Array.isArray(status.filesystems) ? status.filesystems : [];
    return JSON.stringify({
        execution: [
            String(execution.capabilityId || ''),
            Number.isSafeInteger(execution.revision) ? execution.revision : 0,
            String(execution.state || '')
        ],
        achievementSources: filesystems
            .filter(record => ['achievement-file', 'achievement-folder'].includes(record.kind))
            .map(record => [
                String(record.capabilityId || ''),
                Number.isSafeInteger(record.revision) ? record.revision : 0,
                String(record.state || ''),
                String(record.kind || '')
            ])
            .sort((left, right) => left.join(':').localeCompare(right.join(':')))
    });
}

function registerAchievementIpc({ app, ipcMain, BrowserWindow, Notification, dialog, authorizeIpcEvent, profileStore, resolveSteamInstallation }) {
    if (typeof authorizeIpcEvent !== 'function') throw new TypeError('Achievement IPC requires sender authorization.');
    if (!profileStore || typeof profileStore.activeGameMetadata !== 'function') throw new TypeError('Achievement IPC requires the main-owned profile store.');
    const handle = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
        authorizeIpcEvent(event, channel);
        return handler(event, ...args);
    });
    const activeLibraryKey = () => {
        const state = profileStore.getState();
        return `${state.activeProfileId}:${state.activeLibraryId}`;
    };
    const isCurrentLibrary = libraryKey => String(libraryKey || '') === activeLibraryKey();
    const hydrate = requests => {
        const games = [];
        for (const request of requests) {
            const metadata = profileStore.activeGameMetadata(request.id);
            const status = profileStore.authorityStatus(request.id);
            const localScanConfigured = status.execution.state === 'active'
                && status.execution.operations.includes('achievement-read')
                || status.filesystems.some(record => record.state === 'active'
                    && record.operations.includes('achievement-read')
                    && ['achievement-file', 'achievement-folder'].includes(record.kind));
            games.push({
                id: metadata.id,
                name: metadata.name,
                steamAppId: metadata.steamAppId || '',
                steamImageUrl: metadata.steamImageUrl || '',
                achievementData: metadata.achievementData || null,
                localAuthorityVersion: localAuthorityVersion(status),
                localScanConfigured
            });
        }
        const localSources = Object.fromEntries(requests.map(request => [request.id, localSourceViews(profileStore.authorityStatus(request.id))]));
        return { games, localSources };
    };
    const resolveLocalAuthority = ({ gameId, libraryKey }) => {
        if (!isCurrentLibrary(libraryKey)) invalid('The active achievement library changed.');
        const approvedRoots = [];
        const achievementSources = [];
        let exePath = '';
        let installFolder = '';
        let allowSteamData = false;
        let steamRoot = '';
        let steamAppId = '';
        const status = profileStore.authorityStatus(gameId);
        if (status.execution.state === 'active' && status.execution.operations.includes('achievement-read')) {
            const resolved = profileStore.validateExecutionCapability({
                gameId,
                capabilityId: status.execution.capabilityId,
                expectedRevision: status.execution.revision,
                operation: 'achievement-read'
            });
            const details = resolved.details;
            exePath = details.executableIdentity && details.executableIdentity.realPath || '';
            installFolder = details.workingDirectoryIdentity && details.workingDirectoryIdentity.realPath || '';
            if (details.workingDirectoryIdentity) {
                approvedRoots.push({ ...details.workingDirectoryIdentity, path: details.workingDirectoryIdentity.realPath });
            }
            if (details.executableIdentity) {
                approvedRoots.push({ ...details.executableIdentity, path: details.executableIdentity.realPath });
            }
            if (details.steamAppId && typeof resolveSteamInstallation === 'function') {
                steamAppId = details.steamAppId;
                const installation = resolveSteamInstallation(details.steamAppId);
                if (installation && typeof installation === 'object' && typeof installation.then !== 'function'
                    && installation.rootIdentity && installation.rootIdentity.realPath) {
                    steamRoot = installation.rootIdentity.realPath;
                    approvedRoots.push({
                        ...installation.rootIdentity,
                        path: installation.rootIdentity.realPath
                    });
                    allowSteamData = true;
                }
            }
        }
        for (const source of status.filesystems.filter(record => record.state === 'active'
            && record.operations.includes('achievement-read')
            && ['achievement-file', 'achievement-folder'].includes(record.kind))) {
            const resolved = profileStore.validateFilesystemCapability({
                gameId,
                capabilityId: source.capabilityId,
                expectedRevision: source.revision,
                operation: 'achievement-read'
            });
            const details = resolved.details;
            const identity = details.rootIdentity;
            if (!identity) continue;
            achievementSources.push({
                id: details.entryId || source.entryId || source.capabilityId,
                kind: details.kind === 'achievement-folder' ? 'folder' : 'file',
                path: identity.realPath,
                enabled: true
            });
            approvedRoots.push({ ...identity, path: identity.realPath });
        }
        return { exePath, installFolder, achievementSources, approvedRoots, allowSteamData, steamRoot, steamAppId };
    };
    const service = new AchievementService({
        app, BrowserWindow, Notification, dialog, resolveLocalAuthority
    });

    handle('achievements-set-library', async (_event, payload) => {
        const input = exactObject(payload || {}, new Set([
            'games', 'notificationsEnabled', 'trackingEnabled', 'libraryKey', 'forceScan'
        ]), 'Achievement library request');
        if (!isCurrentLibrary(input.libraryKey)) return { updates: [], errors: [], unmatched: [], stale: true };
        const requests = gameRequests(input.games || []);
        const trusted = hydrate(requests);
        const result = await service.setLibrary({
            games: trusted.games,
            notificationsEnabled: input.notificationsEnabled !== false,
            trackingEnabled: input.trackingEnabled !== false,
            libraryKey: activeLibraryKey(),
            forceScan: input.forceScan === true
        });
        return { ...result, localSources: trusted.localSources };
    });
    handle('achievements-refresh-local', async (_event, payload) => {
        const input = exactObject(payload || {}, new Set(['gameId', 'libraryKey']), 'Achievement refresh request');
        if (!isCurrentLibrary(input.libraryKey)) return { changed: false, data: null, newlyUnlocked: [], errors: [], stale: true };
        const requests = gameRequests([{ id: input.gameId }]);
        const trusted = hydrate(requests);
        const result = await service.refreshLocal({ gameId: requests[0].id, game: trusted.games[0], libraryKey: activeLibraryKey() });
        return { ...result, localSources: trusted.localSources };
    });
    handle('achievements-read-artwork', (_event, payload) => {
        const input = exactObject(payload || {}, new Set([
            'gameId', 'itemId', 'variant', 'libraryKey'
        ]), 'Achievement artwork request');
        if (!isCurrentLibrary(input.libraryKey)) return { available: false, stale: true };
        const gameId = boundedString(String(input.gameId || ''), 'gameId', 128, ID_PATTERN);
        profileStore.activeGameMetadata(gameId);
        const itemId = boundedString(String(input.itemId || ''), 'itemId', 512);
        if (!['locked', 'unlocked'].includes(input.variant)) invalid('Achievement artwork variant is invalid.');
        return service.readLocalArtwork({ gameId, itemId, variant: input.variant });
    });
    handle('achievements-import-steam', async (_event, payload) => {
        const input = exactObject(payload || {}, new Set([
            'games', 'gameIds', 'libraryKey', 'steamApiKey', 'steamId', 'language'
        ]), 'Steam achievement import');
        if (!isCurrentLibrary(input.libraryKey)) return { updates: [], errors: [], unmatched: [], stale: true };
        const requests = gameRequests(input.games || []);
        const trusted = hydrate(requests);
        return service.importSteam({
            games: trusted.games,
            gameIds: Array.isArray(input.gameIds) ? input.gameIds.map(String) : null,
            libraryKey: activeLibraryKey(),
            steamApiKey: input.steamApiKey,
            steamId: input.steamId,
            language: input.language
        });
    });
    handle('achievements-import-steam-schema', async (_event, payload) => {
        const input = exactObject(payload || {}, new Set([
            'games', 'gameIds', 'libraryKey', 'steamApiKey', 'language'
        ]), 'Steam achievement schema import');
        if (!isCurrentLibrary(input.libraryKey)) return { updates: [], errors: [], unmatched: [], stale: true };
        const requests = gameRequests(input.games || []);
        const trusted = hydrate(requests);
        return service.importSteamSchema({
            games: trusted.games,
            gameIds: Array.isArray(input.gameIds) ? input.gameIds.map(String) : null,
            libraryKey: activeLibraryKey(),
            steamApiKey: input.steamApiKey,
            language: input.language
        });
    });
    handle('achievements-pick-source', async (_event, payload) => {
        const input = exactObject(payload || {}, new Set(['gameId', 'kind']), 'Achievement source selection');
        const gameId = boundedString(String(input.gameId || ''), 'gameId', 128, ID_PATTERN);
        profileStore.activeGameMetadata(gameId);
        if (!['file', 'folder'].includes(input.kind)) invalid('Achievement source kind is invalid.');
        const picked = await service.pickSource({ kind: input.kind });
        if (!picked || picked.canceled) return picked || { canceled: true };
        const capability = profileStore.createFilesystemCapability(
            gameId,
            input.kind === 'folder' ? 'achievement-folder' : 'achievement-file',
            picked.path,
            crypto.randomUUID()
        );
        return { canceled: false, source: sourceView(capability) };
    });
    handle('achievements-review-source', async (_event, payload) => {
        const input = exactObject(payload || {}, new Set(['gameId', 'capabilityId', 'expectedRevision']), 'Achievement source review');
        const pending = profileStore.pendingFilesystemReview(input);
        if (!['achievement-file', 'achievement-folder'].includes(pending.kind)) invalid('Only achievement sources can use this review handler.');
        const decision = await dialog.showMessageBox({
            type: 'question', buttons: ['Approve existing', 'Choose replacement', 'Cancel'], defaultId: 1, cancelId: 2,
            message: 'Review this local achievement source', detail: String(pending.value || '').slice(0, 32767)
        });
        if (decision.response === 2) return { canceled: true };
        let selectedPath = '';
        if (decision.response === 1) {
            const selected = await service.pickSource({ kind: pending.kind === 'achievement-folder' ? 'folder' : 'file' });
            if (!selected || selected.canceled) return { canceled: true };
            selectedPath = selected.path;
        }
        return { canceled: false, source: sourceView(profileStore.reviewPendingFilesystem(input, selectedPath)) };
    });
    handle('achievements-remove-source', (_event, payload) => {
        const input = exactObject(payload || {}, new Set(['gameId', 'capabilityId', 'expectedRevision']), 'Achievement source removal');
        const status = profileStore.authorityStatus(input.gameId);
        const source = status.filesystems.find(record => record.capabilityId === input.capabilityId);
        if (!source || !['achievement-file', 'achievement-folder'].includes(source.kind)) invalid('Achievement source capability was not found.');
        const result = profileStore.revokeFilesystemCapability(input);
        service.invalidateLocalAuthority(input.gameId);
        return result;
    });
    handle('achievements-set-preferences', (_event, payload) => {
        const input = exactObject(payload || {}, new Set(['notificationsEnabled', 'trackingEnabled']), 'Achievement preferences');
        return service.setPreferences(input);
    });
    return service;
}

module.exports = { registerAchievementIpc };
