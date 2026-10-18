const { AccountService, SafeStorageAdapter } = require('./accountService');
const { ProfileStore, extractProtectedLocalSettings } = require('./profileStore');
const { serializePortableArtifact } = require('../sync/portableArtifactV3');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { fileIdentity, identityMatches, parseArgumentString } = require('../security/capabilityStore');

function messageOf(error) {
    return error && error.message ? error.message : String(error || 'Unknown error');
}

function exactPayload(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} has an unsupported prototype.`);
    for (const key of Object.keys(value)) {
        if (!keys.includes(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
            const error = new Error(`${label}.${key} is not allowed.`);
            error.code = 'SAIL_GATE_A_INVALID_PAYLOAD';
            throw error;
        }
    }
    return value;
}

async function chooseFile(dialog, options) {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], ...options });
    return result.canceled ? null : result.filePaths[0];
}

// A suggested starting folder for a picker. It is only where the picker opens; the person still chooses.
function pickerStart(value) {
    if (value === undefined || value === '') return {};
    if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || /[\u0000-\u001f]/.test(value)) {
        throw new TypeError('The suggested folder must be an absolute local path.');
    }
    return { defaultPath: path.normalize(value) };
}

async function chooseDirectory(dialog, options) {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], ...options });
    return result.canceled ? null : result.filePaths[0];
}

function formatLaunchArguments(argv) {
    return (argv || []).map(value => /[\s"]/.test(value) || !value
        ? '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
        : value).join(' ');
}

function registerAccountIpc({ app, ipcMain, safeStorage, authorizeIpcEvent, dialog, validateSteamAppId, onSessionChanged, localOnly = false, nativeSetup = null, assertProfileMutationAllowed = null }) {
    if (typeof authorizeIpcEvent !== 'function') throw new TypeError('Account IPC requires sender authorization.');
    if (!dialog || typeof dialog.showOpenDialog !== 'function' || typeof dialog.showMessageBox !== 'function') {
        throw new TypeError('Account IPC requires main-process native dialogs.');
    }
    const accountService = localOnly ? null : new AccountService({ app, safeStorage });
    const profileStore = new ProfileStore(app.getPath('userData'), { assertMutationAllowed: assertProfileMutationAllowed });
    const pendingExecutionSelections = new Map();
    const executionSelectionTtlMs = 30 * 60 * 1000;
    const maxPendingExecutionSelections = 32;
    // Save folders Sail found itself (Ludusavi or a scan). Kept apart so a scan never evicts a picked selection.
    const offeredSaveSelections = new Map();
    const maxOfferedSaveSelections = 64;

    const executionSelectionError = message => {
        const error = new Error(message);
        error.code = 'SAIL_GATE_A_INVALID_PAYLOAD';
        return error;
    };
    const executionSelectionSenderId = event => {
        const senderId = Number(event && event.sender && event.sender.id);
        if (!Number.isSafeInteger(senderId) || senderId < 0) {
            throw executionSelectionError('The executable selection is not bound to a trusted window.');
        }
        return senderId;
    };
    const pruneExecutionSelections = () => {
        const cutoff = Date.now() - executionSelectionTtlMs;
        for (const [selectionId, selection] of pendingExecutionSelections) {
            if (!selection || selection.createdAt < cutoff) pendingExecutionSelections.delete(selectionId);
        }
        while (pendingExecutionSelections.size >= maxPendingExecutionSelections) {
            const oldest = pendingExecutionSelections.keys().next().value;
            if (!oldest) break;
            pendingExecutionSelections.delete(oldest);
        }
        for (const [selectionId, selection] of offeredSaveSelections) {
            if (!selection || selection.createdAt < cutoff) offeredSaveSelections.delete(selectionId);
        }
        while (offeredSaveSelections.size >= maxOfferedSaveSelections) offeredSaveSelections.delete(offeredSaveSelections.keys().next().value);
    };
    const consumeExecutionSelection = (event, selectionIdInput, expected = {}) => {
        const selectionId = String(selectionIdInput || '');
        if (!/^[0-9a-f-]{36}$/i.test(selectionId)) {
            throw executionSelectionError('The executable selection reference is invalid.');
        }
        pruneExecutionSelections();
        const selections = pendingExecutionSelections.has(selectionId) ? pendingExecutionSelections : offeredSaveSelections;
        const selection = selections.get(selectionId);
        if (!selection || selection.senderId !== executionSelectionSenderId(event)) {
            throw executionSelectionError('The executable selection is no longer available. Choose it again.');
        }
        if (expected.purpose && selection.purpose !== expected.purpose) {
            throw executionSelectionError('That selection is for a different setup field. Choose it again.');
        }
        if (expected.gameId && selection.gameId && selection.gameId !== String(expected.gameId)) {
            throw executionSelectionError('That selection belongs to a different game. Choose it again.');
        }
        const scope = expected.gameId ? profileStore.authorityScope(expected.gameId) : profileStore.activeScope();
        if (selection.profileId !== scope.profileId || selection.libraryId !== scope.libraryId) {
            throw executionSelectionError('That selection belongs to a different profile or library. Choose it again.');
        }
        const identityKind = ['save', 'working-directory'].includes(selection.purpose) ? 'directory' : 'file';
        const currentIdentity = fileIdentity(selection.selectedPath, identityKind);
        if (!identityMatches(selection.selectedIdentity, currentIdentity)) {
            selections.delete(selectionId);
            throw executionSelectionError('The selected executable changed. Choose it again.');
        }
        selections.delete(selectionId);
        return selection.selectedPath;
    };
    // Main-process scans call this for folders they found, so choosing one works like choosing it in the
    // picker. The renderer only ever gets the ID back; it cannot name a path of its own.
    const offerSaveSelection = (event, { gameId = '', folder }) => {
        let selectedIdentity;
        try { selectedIdentity = fileIdentity(folder, 'directory'); } catch (_) { return ''; }
        const scope = gameId ? profileStore.authorityScope(gameId) : profileStore.activeScope();
        pruneExecutionSelections();
        const selectionId = crypto.randomUUID();
        offeredSaveSelections.set(selectionId, {
            senderId: executionSelectionSenderId(event), selectedPath: selectedIdentity.realPath, selectedIdentity, purpose: 'save',
            gameId: gameId ? String(gameId) : '', profileId: scope.profileId, libraryId: scope.libraryId, createdAt: Date.now()
        });
        return selectionId;
    };
    const protectedSettingsStorage = localOnly ? null : new SafeStorageAdapter(
        path.join(app.getPath('userData'), 'sail_local_settings.json'),
        safeStorage
    );
    let protectedSettingsCache = null;
    let protectedSettingsPromise = null;
    let pendingProtectedSettings = {};
    let pendingProtectedSettingsClear = false;
    const loadProtectedSettings = async () => {
        if (localOnly) return {};
        if (protectedSettingsCache) return protectedSettingsCache;
        if (!protectedSettingsStorage.isEncryptionAvailable()) return { ...pendingProtectedSettings };
        if (!protectedSettingsPromise) {
            protectedSettingsPromise = (async () => {
                const stored = await protectedSettingsStorage.getItem('settings-v1');
                if (!protectedSettingsStorage.isEncryptionAvailable()) return null;
                let loaded = null;
                let storedValid = false;
                if (stored) {
                    try {
                        const payload = JSON.parse(stored);
                        if (payload && payload.schemaVersion === 1) {
                            loaded = extractProtectedLocalSettings(payload.settings || {});
                            storedValid = true;
                        }
                    } catch (_) {}
                }
                if (!loaded) {
                    loaded = {};
                    const legacyPath = path.join(app.getPath('userData'), 'sail_library.json');
                    try {
                        const stat = fs.statSync(legacyPath);
                        if (stat.isFile() && stat.size <= 16 * 1024 * 1024) {
                            const legacy = fs.readJsonSync(legacyPath);
                            loaded = extractProtectedLocalSettings(legacy && legacy.globalSettings || {});
                        }
                    } catch (_) {}
                }
                const next = pendingProtectedSettingsClear
                    ? { ...pendingProtectedSettings }
                    : { ...loaded, ...pendingProtectedSettings };
                if (!storedValid || pendingProtectedSettingsClear || Object.keys(pendingProtectedSettings).length) {
                    if (!protectedSettingsStorage.isEncryptionAvailable()) return null;
                    await protectedSettingsStorage.setItem('settings-v1', JSON.stringify({
                        schemaVersion: 1,
                        settings: next
                    }));
                }
                pendingProtectedSettings = {};
                pendingProtectedSettingsClear = false;
                return next;
            })();
        }
        try {
            const loaded = await protectedSettingsPromise;
            if (!loaded) return { ...pendingProtectedSettings };
            protectedSettingsCache = loaded;
            return loaded;
        } finally {
            protectedSettingsPromise = null;
        }
    };
    const saveProtectedSettings = async settings => {
        const extracted = extractProtectedLocalSettings(settings || {});
        if (localOnly) {
            const hasValue = value => typeof value === 'string' ? !!value.trim()
                : value && typeof value === 'object' ? Object.values(value).some(hasValue) : false;
            if (Object.values(extracted).some(hasValue)) throw new Error('Protected credentials are unavailable in the offline development profile.');
            return {};
        }
        if (!protectedSettingsStorage.isEncryptionAvailable()) {
            pendingProtectedSettings = { ...pendingProtectedSettings, ...extracted };
            return { ...pendingProtectedSettings };
        }
        const current = await loadProtectedSettings();
        const next = { ...current, ...extracted };
        if (!protectedSettingsStorage.isEncryptionAvailable()) {
            pendingProtectedSettings = { ...pendingProtectedSettings, ...extracted };
            protectedSettingsCache = null;
            return next;
        }
        await protectedSettingsStorage.setItem('settings-v1', JSON.stringify({
            schemaVersion: 1,
            settings: next
        }));
        protectedSettingsCache = next;
        return next;
    };
    const clearProtectedSettings = async () => {
        if (localOnly) return {};
        const next = {};
        pendingProtectedSettings = {};
        protectedSettingsCache = null;
        if (!protectedSettingsStorage.isEncryptionAvailable()) {
            pendingProtectedSettingsClear = true;
            return next;
        }
        await protectedSettingsStorage.setItem('settings-v1', JSON.stringify({ schemaVersion: 1, settings: next }));
        pendingProtectedSettingsClear = false;
        protectedSettingsCache = next;
        return next;
    };
    const withProtectedSettings = async result => {
        if (!result || !result.snapshot) return result;
        const protectedSettings = await loadProtectedSettings();
        result.snapshot.globalSettings = {
            ...(result.snapshot.globalSettings || {}),
            ...protectedSettings
        };
        return result;
    };
    const transferRoot = path.join(app.getPath('userData'), 'SailGateATransfers');
    const transferPath = extension => {
        fs.ensureDirSync(transferRoot);
        return path.join(transferRoot, `${crypto.randomUUID()}${extension}`);
    };
    const validateCloudScope = (gameIdInput, logicalKeyInput) => {
        const gameId = String(gameIdInput || '');
        const logicalKey = String(logicalKeyInput || '');
        if (gameId === 'launcher-portable') {
            if (logicalKey !== 'launcher-config:portable') throw new Error('The cloud item is not a portable launcher configuration.');
            return { gameId, logicalKey, configEntryId: '', artifactType: 'launcher-config' };
        }
        const metadata = profileStore.activeGameMetadata(gameId);
        if (logicalKey === `game-save:${gameId}`) return { gameId, logicalKey, configEntryId: '', artifactType: 'game-save' };
        const prefix = `game-config:${gameId}:`;
        const configEntryId = logicalKey.startsWith(prefix) ? logicalKey.slice(prefix.length) : '';
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configEntryId)
            || !(metadata.configSyncEntries || []).some(entry => String(entry.id) === configEntryId)) {
            throw new Error('The cloud item does not match an active local game configuration.');
        }
        return { gameId, logicalKey, configEntryId, artifactType: 'game-config' };
    };

    const guarded = (channel, handler) => async (event, ...args) => {
        try {
            authorizeIpcEvent(event, channel);
            return { success: true, data: await handler(event, ...args) };
        } catch (error) {
            if (!error || error.code !== 'SAIL_IPC_FORBIDDEN') {
                console.error('Account IPC failed:', messageOf(error));
            }
            return {
                success: false,
                error: error && error.code === 'SAIL_IPC_FORBIDDEN' ? 'This account request is not allowed.' : messageOf(error),
                ...(error && error.code ? { code: error.code } : {})
            };
        }
    };

    const profileGuarded = (channel, handler) => guarded(channel, async (event, ...args) => {
        profileStore.initialize();
        await loadProtectedSettings();
        return handler(event, ...args);
    });

    const notifySessionChanged = () => {
        if (typeof onSessionChanged !== 'function') return;
        Promise.resolve().then(() => onSessionChanged()).catch(error => {
            console.error('Account session change notification failed:', messageOf(error));
        });
    };

    ipcMain.handle('account-get-state', guarded('account-get-state', () => localOnly
        ? { signedIn: false, user: null, profile: null, unavailableReason: 'Accounts are unavailable in this offline development profile.' }
        : accountService.state()));
    ipcMain.handle('account-sign-in', guarded('account-sign-in', async (_event, payload) => {
        const result = await accountService.signIn(payload && payload.identifier, payload && payload.password);
        notifySessionChanged();
        return result;
    }));
    ipcMain.handle('account-sign-up', guarded('account-sign-up', (_event, payload) => accountService.signUp(
        payload && payload.email,
        payload && payload.username,
        payload && payload.password
    )));
    ipcMain.handle('account-reset-password', guarded('account-reset-password', (_event, payload) => accountService.resetPassword(payload && payload.email)));
    ipcMain.handle('account-password-verification', guarded('account-password-verification', () => accountService.requestPasswordChangeVerification()));
    ipcMain.handle('account-change-password', guarded('account-change-password', (_event, payload) => accountService.changePassword(
        payload && payload.password,
        payload && payload.nonce
    )));
    ipcMain.handle('account-sign-out', guarded('account-sign-out', async () => {
        const result = await accountService.signOut();
        notifySessionChanged();
        return result;
    }));
    ipcMain.handle('account-alert-admin-state', guarded('account-alert-admin-state', () => accountService.alertAdminState()));
    ipcMain.handle('account-publish-alert', guarded('account-publish-alert', (_event, payload) => accountService.publishAlert(payload)));
    ipcMain.handle('account-list-remote', guarded('account-list-remote', () => accountService.listRemoteControlPlane()));
    ipcMain.handle('account-upsert-remote', guarded('account-upsert-remote', () => {
        profileStore.initialize();
        return accountService.upsertControlPlane(profileStore.exportControlPlane());
    }));
    ipcMain.handle('account-delete-remote-profile', guarded('account-delete-remote-profile', (_event, payload) => accountService.deleteRemoteProfile(
        payload && payload.profileId,
        payload && payload.profileName
    )));
    ipcMain.handle('account-upload-avatar', guarded('account-upload-avatar', async () => {
        const selected = await chooseFile(dialog, { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
        return selected ? accountService.uploadAvatar(selected) : { canceled: true };
    }));
    ipcMain.handle('account-cloud-storage-status', guarded('account-cloud-storage-status', () => accountService.storageStatus()));
    ipcMain.handle('account-cloud-list-files', guarded('account-cloud-list-files', () => accountService.listCloudFiles()));
    ipcMain.handle('account-cloud-delete-file', guarded('account-cloud-delete-file', (_event, payload) => accountService.deleteCloudFile(
        payload && payload.artifactId
    )));
    ipcMain.handle('account-cloud-upload-file', guarded('account-cloud-upload-file', async (_event, payload) => {
        const input = exactPayload(payload, [
            'capabilityId', 'expectedRevision', 'gameId',
            'configEntryId', 'artifactType', 'logicalKey', 'expectedRemoteRevision',
            'maxVersions', 'contentType'
        ], 'Sail Cloud upload');
        const gameId = String(input.gameId || '');
        const artifactType = String(input.artifactType || '');
        const logicalKey = String(input.logicalKey || '');
        const configEntryId = String(input.configEntryId || '');
        const scope = validateCloudScope(gameId, logicalKey);
        if (artifactType !== scope.artifactType) throw new Error('The upload artifact type does not match its active local scope.');
        const validPortable = scope.gameId === 'launcher-portable' && artifactType === 'launcher-config' && !configEntryId;
        const validSave = scope.gameId !== 'launcher-portable' && artifactType === 'game-save' && !scope.configEntryId && !configEntryId;
        const validConfig = scope.gameId !== 'launcher-portable' && artifactType === 'game-config'
            && scope.configEntryId === configEntryId;
        if (!validPortable && !validSave && !validConfig) throw new Error('The upload metadata does not match its active local scope.');
        if (!['application/zip', 'application/json', 'application/json; charset=utf-8'].includes(String(input.contentType || ''))) {
            throw new Error('The upload content type is not allowed.');
        }
        if (input.maxVersions !== undefined && (!Number.isSafeInteger(input.maxVersions) || input.maxVersions < 1 || input.maxVersions > 50)) {
            throw new Error('The cloud version count is outside its allowed range.');
        }
        const resolved = profileStore.resolveTransferCapability({
            capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision,
            gameId: input.gameId,
            operation: 'transfer-read'
        });
        try {
            return await accountService.uploadCloudFile({
                profileId: profileStore.getState().activeProfileId,
                libraryId: profileStore.getState().activeLibraryId,
                gameId: gameId === 'launcher-portable' ? null : gameId,
                configEntryId: configEntryId || null,
                artifactType,
                logicalKey,
                expectedRevision: input.expectedRemoteRevision,
                maxVersions: input.maxVersions,
                contentType: input.contentType,
                filePath: resolved.details.targetPath,
                controlPlane: profileStore.exportControlPlane()
            });
        } finally {
            try { fs.unlinkSync(resolved.details.targetPath); } catch (_) {}
        }
    }));
    ipcMain.handle('account-cloud-list-versions', guarded('account-cloud-list-versions', (_event, payload) => {
        const input = exactPayload(payload, ['gameId', 'logicalKey'], 'Sail Cloud versions');
        const { gameId, logicalKey, artifactType } = validateCloudScope(input.gameId, input.logicalKey);
        return accountService.listCloudVersions({
            profileId: profileStore.getState().activeProfileId,
            libraryId: profileStore.getState().activeLibraryId,
            gameId,
            logicalKey,
            expectedArtifactType: artifactType
        });
    }));
    ipcMain.handle('account-cloud-download-file', guarded('account-cloud-download-file', async (_event, payload) => {
        const input = exactPayload(payload, [
            'capabilityId', 'expectedRevision', 'gameId', 'artifactId',
            'logicalKey', 'revision'
        ], 'Sail Cloud download');
        const scope = validateCloudScope(input.gameId, input.logicalKey);
        if (input.artifactId !== undefined && (typeof input.artifactId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.artifactId))) {
            throw new Error('The cloud artifact ID is invalid.');
        }
        const resolved = profileStore.resolveTransferCapability({
            capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision,
            gameId: input.gameId,
            operation: 'transfer-write'
        });
        const result = await accountService.downloadCloudFile({
            profileId: profileStore.getState().activeProfileId,
            libraryId: profileStore.getState().activeLibraryId,
            gameId: scope.gameId,
            artifactId: input.artifactId,
            logicalKey: scope.logicalKey,
            expectedArtifactType: scope.artifactType,
            revision: input.revision,
            destinationPath: resolved.details.targetPath
        });
        const transfer = scope.gameId === 'launcher-portable'
            ? profileStore.createLauncherTransferCapability(resolved.details.targetPath, 'transfer-read')
            : profileStore.createTransferCapability(scope.gameId, resolved.details.targetPath, 'transfer-read');
        return { result, transfer };
    }));
    ipcMain.handle('account-cloud-link-start', guarded('account-cloud-link-start', (_event, provider) => accountService.startCloudOAuth(provider)));
    ipcMain.handle('account-cloud-disconnect', guarded('account-cloud-disconnect', (_event, provider) => accountService.disconnectPortableCloud(provider)));

    ipcMain.handle('profiles-bootstrap', profileGuarded('profiles-bootstrap', () => withProtectedSettings({
        state: profileStore.getState(), snapshot: profileStore.loadActiveSnapshot()
    })));
    ipcMain.handle('profiles-get-state', profileGuarded('profiles-get-state', () => profileStore.getState()));
    ipcMain.handle('profiles-load-active', profileGuarded('profiles-load-active', () => withProtectedSettings({
        state: profileStore.getState(),
        snapshot: profileStore.loadActiveSnapshot()
    })));
    // Keep protected-setting awaits and durable snapshots in request order, even
    // if a renderer reloads while an earlier capture is still in flight.
    let captureInFlight = Promise.resolve();
    ipcMain.handle('profiles-capture-active', profileGuarded('profiles-capture-active', (_event, snapshot) => {
        const operation = captureInFlight.catch(() => {}).then(async () => {
            await saveProtectedSettings(snapshot && snapshot.globalSettings || {});
            return withProtectedSettings(profileStore.captureActiveSnapshot(snapshot || {}));
        });
        captureInFlight = operation;
        return operation;
    }));
    ipcMain.handle('profiles-remove-game', profileGuarded('profiles-remove-game', (_event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'Remove game from library');
        return withProtectedSettings(profileStore.removeGameFromActiveLibrary(input.gameId));
    }));
    ipcMain.handle('profiles-clear-protected-settings', profileGuarded('profiles-clear-protected-settings', () => clearProtectedSettings()));
    ipcMain.handle('profiles-export-control-plane', profileGuarded('profiles-export-control-plane', () => profileStore.exportControlPlane()));
    ipcMain.handle('profiles-merge-control-plane', profileGuarded('profiles-merge-control-plane', (_event, payload) => withProtectedSettings(
        profileStore.mergeControlPlane(payload && payload.artifact || payload || {})
    )));
    ipcMain.handle('profiles-export-portable-file', profileGuarded('profiles-export-portable-file', async () => {
        const result = await dialog.showSaveDialog({
            defaultPath: 'sail-portable-v3.json',
            filters: [{ name: 'Sail Portable Artifact', extensions: ['json'] }]
        });
        if (result.canceled || !result.filePath) return { canceled: true };
        const serialized = serializePortableArtifact(profileStore.exportActivePortable());
        fs.writeFileSync(result.filePath, `${serialized}\n`, { encoding: 'utf8', flag: 'w' });
        return { canceled: false };
    }));
    ipcMain.handle('profiles-import-portable-file', profileGuarded('profiles-import-portable-file', async () => {
        const selected = await chooseFile(dialog, { filters: [{ name: 'Sail Portable Artifact', extensions: ['json'] }] });
        if (!selected) return { canceled: true };
        const stat = fs.statSync(selected);
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
            const error = new Error('Portable artifacts must be JSON files no larger than 16 MiB.');
            error.code = 'SAIL_PORTABLE_TOO_LARGE';
            throw error;
        }
        const result = await withProtectedSettings(profileStore.importActivePortable(fs.readFileSync(selected)));
        return { canceled: false, ...result };
    }));
    ipcMain.handle('profiles-export-local-backup-file', profileGuarded('profiles-export-local-backup-file', async () => {
        const result = await dialog.showSaveDialog({
            defaultPath: 'sail-launcher-backup.json',
            filters: [{ name: 'Sail Launcher Backup', extensions: ['json'] }]
        });
        if (result.canceled || !result.filePath) return { canceled: true };
        fs.writeFileSync(result.filePath, `${JSON.stringify(profileStore.exportActiveLocalBackup(), null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'w'
        });
        return { canceled: false };
    }));
    ipcMain.handle('profiles-import-local-backup-file', profileGuarded('profiles-import-local-backup-file', async () => {
        const selected = await chooseFile(dialog, { filters: [{ name: 'Sail Launcher Backup', extensions: ['json'] }] });
        if (!selected) return { canceled: true };
        const stat = fs.statSync(selected);
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
            const error = new Error('Local backups must be JSON files no larger than 16 MiB.');
            error.code = 'SAIL_LOCAL_BACKUP_TOO_LARGE';
            throw error;
        }
        const imported = profileStore.importActiveLocalBackup(fs.readFileSync(selected));
        await saveProtectedSettings(imported.protectedSettings || {});
        delete imported.protectedSettings;
        return { canceled: false, ...await withProtectedSettings(imported) };
    }));
    ipcMain.handle('profiles-create-portable-upload-transfer', profileGuarded('profiles-create-portable-upload-transfer', () => {
        const destination = transferPath('.json');
        fs.writeFileSync(destination, `${serializePortableArtifact(profileStore.exportActivePortable())}\n`, 'utf8');
        return profileStore.createLauncherTransferCapability(destination, 'transfer-read');
    }));
    ipcMain.handle('profiles-create-portable-download-transfer', profileGuarded('profiles-create-portable-download-transfer', () => {
        const destination = transferPath('.json');
        return profileStore.createLauncherTransferCapability(destination, 'transfer-write');
    }));
    ipcMain.handle('profiles-import-portable-transfer', profileGuarded('profiles-import-portable-transfer', (_event, payload) => {
        const input = exactPayload(payload, ['capabilityId', 'expectedRevision'], 'Portable transfer import');
        const resolved = profileStore.resolveTransferCapability({
            capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision,
            gameId: 'launcher-portable',
            operation: 'transfer-read'
        });
        try {
            const stat = fs.statSync(resolved.details.targetPath);
            if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Portable artifact is too large.');
            return withProtectedSettings(profileStore.importActivePortable(fs.readFileSync(resolved.details.targetPath)));
        } finally {
            try { fs.unlinkSync(resolved.details.targetPath); } catch (_) {}
        }
    }));
    ipcMain.handle('profiles-create', profileGuarded('profiles-create', (_event, payload) => profileStore.createProfile(
        payload && payload.name,
        payload && payload.pin,
        payload && payload.snapshot
    )));
    ipcMain.handle('profiles-update', profileGuarded('profiles-update', (_event, payload) => profileStore.updateProfile(payload.profileId, payload.patch || {})));
    ipcMain.handle('profiles-set-avatar', profileGuarded('profiles-set-avatar', async (_event, payload) => {
        const input = exactPayload(payload, ['profileId'], 'Profile avatar');
        const selected = await chooseFile(dialog, { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
        return selected ? profileStore.setProfileAvatar(input.profileId, selected) : profileStore.getState();
    }));
    ipcMain.handle('profiles-clear-avatar', profileGuarded('profiles-clear-avatar', (_event, payload) => profileStore.clearProfileAvatar(payload.profileId)));
    ipcMain.handle('profiles-delete', profileGuarded('profiles-delete', (_event, payload) => withProtectedSettings(
        profileStore.deleteProfile(payload.profileId, payload.pin || '')
    )));
    ipcMain.handle('profiles-unlock', profileGuarded('profiles-unlock', (_event, payload) => profileStore.unlockProfile(payload.profileId, payload.pin || '')));
    ipcMain.handle('profiles-switch', profileGuarded('profiles-switch', (_event, payload) => withProtectedSettings(profileStore.switchProfile(payload.profileId))));
    ipcMain.handle('profiles-create-library', profileGuarded('profiles-create-library', (_event, payload) => profileStore.createLibrary(payload.name, payload.snapshot || {})));
    ipcMain.handle('profiles-switch-library', profileGuarded('profiles-switch-library', (_event, payload) => withProtectedSettings(profileStore.switchLibrary(payload.libraryId))));
    ipcMain.handle('profiles-create-preset', profileGuarded('profiles-create-preset', (_event, payload) => profileStore.createPreset(payload.name, payload.snapshot || {})));
    ipcMain.handle('profiles-switch-preset', profileGuarded('profiles-switch-preset', (_event, payload) => withProtectedSettings(profileStore.switchPreset(payload.presetId))));

    ipcMain.handle('authority-get-game-status', guarded('authority-get-game-status', (_event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'Authority status');
        return profileStore.authorityStatus(input.gameId);
    }));
    ipcMain.handle('authority-get-execution-settings', guarded('authority-get-execution-settings', (_event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'Launch settings');
        const authority = profileStore.authorityStatus(input.gameId).execution;
        if (!authority || authority.state !== 'active') return { state: authority && authority.state || 'missing' };
        const { details } = profileStore.validateExecutionCapability({
            gameId: input.gameId, capabilityId: authority.capabilityId,
            expectedRevision: authority.revision, operation: 'reveal'
        });
        return {
            state: 'active', capabilityId: authority.capabilityId, revision: authority.revision,
            argumentProposal: formatLaunchArguments(details.argv),
            runAsAdmin: details.runAsAdmin === true, highPriority: details.highPriority === true,
            companionName: path.basename(details.companionPath || ''),
            preLaunchName: path.basename(details.preLaunchScript || ''),
            postLaunchName: path.basename(details.postLaunchScript || '')
        };
    }));
    ipcMain.handle('downloaded-game-uninstall-status', guarded('downloaded-game-uninstall-status', (_event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'Downloaded game uninstall status');
        return profileStore.downloadedGameUninstallStatus(input.gameId);
    }));
    ipcMain.handle('authority-select-executable', guarded('authority-select-executable', async (event, payload) => {
        const input = exactPayload(payload || {}, ['purpose', 'gameId'], 'Executable selection');
        const purpose = input.purpose === undefined ? 'base' : input.purpose;
        if (!['base', 'tracking'].includes(purpose)) throw executionSelectionError('The executable selection purpose is invalid.');
        const scope = input.gameId ? profileStore.authorityScope(input.gameId) : profileStore.activeScope();
        if (nativeSetup && purpose !== 'base') throw executionSelectionError('Native process-name tracking is unavailable; the supervisor owns the selected game session.');
        let selectedPath = await chooseFile(dialog, {
            title: purpose === 'tracking' ? 'Choose a process tracking executable' : 'Choose this game’s local executable',
            ...(nativeSetup ? {} : { filters: [{ name: purpose === 'tracking' ? 'Executables' : 'Executables and shortcuts', extensions: purpose === 'tracking' ? ['exe'] : ['exe', 'lnk', 'bat', 'cmd'] }] })
        });
        if (!selectedPath) return { canceled: true };
        let backend;
        if (nativeSetup) {
            const selected = require('../runtime/proton/executable').selectLocalExecutable(selectedPath, nativeSetup);
            backend = selected.backend;
            const canonical = selected.identity.realPath;
            if (canonical !== path.resolve(selectedPath)) {
                const decision = await dialog.showMessageBox({ type: 'question', buttons: ['Use this target', 'Cancel'], defaultId: 1, cancelId: 1,
                    message: 'Use the executable this link points to?', detail: canonical });
                if (decision.response !== 0) return { canceled: true };
            }
            selectedPath = canonical;
        }
        pruneExecutionSelections();
        const selectionId = crypto.randomUUID();
        pendingExecutionSelections.set(selectionId, {
            senderId: executionSelectionSenderId(event),
            selectedPath,
            selectedIdentity: fileIdentity(selectedPath, 'file'),
            purpose,
            gameId: input.gameId ? String(input.gameId) : '',
            profileId: scope && scope.profileId || '',
            libraryId: scope && scope.libraryId || '',
            createdAt: Date.now()
        });
        const name = path.basename(selectedPath).slice(0, 160);
        return { canceled: false, selectionId, label: purpose === 'tracking' ? `Play detection: ${name}` : 'Executable selected', name, ...(backend ? { backend } : {}) };
    }));
    ipcMain.handle('authority-select-filesystem', guarded('authority-select-filesystem', async (event, payload) => {
        const input = exactPayload(payload || {}, ['kind', 'pathKind', 'gameId', 'defaultPath'], 'Filesystem selection');
        if (input.kind !== 'save' || input.pathKind !== 'folder') {
            throw executionSelectionError('Only game save-folder selection is supported.');
        }
        const scope = input.gameId ? profileStore.authorityScope(input.gameId) : profileStore.activeScope();
        const selectedPath = await chooseDirectory(dialog, { title: 'Choose the local save folder', ...pickerStart(input.defaultPath) });
        if (!selectedPath) return { canceled: true };
        pruneExecutionSelections();
        const selectionId = crypto.randomUUID();
        pendingExecutionSelections.set(selectionId, {
            senderId: executionSelectionSenderId(event), selectedPath,
            selectedIdentity: fileIdentity(selectedPath, 'directory'), purpose: 'save',
            gameId: input.gameId ? String(input.gameId) : '', profileId: scope.profileId, libraryId: scope.libraryId,
            createdAt: Date.now()
        });
        const name = path.basename(selectedPath).slice(0, 160);
        return { canceled: false, selectionId, label: `Save folder: ${name}`, name };
    }));
    ipcMain.handle('proton-list-runtimes', guarded('proton-list-runtimes', (_event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'Proton versions');
        if (input.gameId !== undefined) profileStore.authorityScope(input.gameId);
        if (!nativeSetup?.protonManager) throw new Error('Proton setup is unavailable.');
        return nativeSetup.protonManager.installedStatus();
    }));
    const compatibility = () => {
        if (!nativeSetup?.protonManager?.downloads) throw Error('Compatibility management is unavailable.');
        return nativeSetup.protonManager.downloads;
    };
    ipcMain.handle('proton-launch-log', guarded('proton-launch-log', (_event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'Compatibility launch log');
        const scope = profileStore.authorityScope(input.gameId);
        if (!nativeSetup?.launchLog) throw Error('Compatibility launch logs are unavailable.');
        return nativeSetup.launchLog({ libraryKey: `${scope.profileId}:${scope.libraryId}`, gameId: String(input.gameId) })
            || { available: false, text: '', hint: 'Compatibility monitoring is not ready yet.' };
    }));
    ipcMain.handle('compatibility-status', guarded('compatibility-status', async (_event, payload) => {
        exactPayload(payload, [], 'Compatibility status');
        const downloads = compatibility(), manager = downloads.manager;
        const [runtime, system] = await Promise.all([manager.installedStatus(), downloads.requirements.inspect()]);
        const setup = require('../runtime/proton/requirements').setupStatus({ system, ...runtime,
            readiness: nativeSetup.getReadiness?.(), noticeDismissed: manager.setupNoticeDismissed() });
        return { ...runtime, ...downloads.status(), setup };
    }));
    ipcMain.handle('compatibility-check', guarded('compatibility-check', async (_event, payload) => {
        exactPayload(payload, [], 'Compatibility requirements');
        return compatibility().requirements.inspect(true);
    }));
    ipcMain.handle('compatibility-setup', guarded('compatibility-setup', (_event, payload) => {
        exactPayload(payload, [], 'Windows gaming setup');
        const readiness = nativeSetup.getReadiness?.();
        if (!readiness?.available || !readiness.scriptsAvailable || !readiness.windowsTrackingAvailable) throw Error('The installed launcher cannot track Windows games. Update Sail before setting up Windows gaming.');
        return compatibility().startSetup();
    }));
    ipcMain.handle('compatibility-dismiss-setup', guarded('compatibility-dismiss-setup', (_event, payload) => {
        exactPayload(payload, [], 'Windows gaming setup notice');
        return compatibility().manager.dismissSetupNotice();
    }));
    ipcMain.handle('compatibility-releases', guarded('compatibility-releases', (_event, payload) => {
        exactPayload(payload, [], 'Compatibility releases'); return compatibility().refresh();
    }));
    ipcMain.handle('compatibility-install', guarded('compatibility-install', (_event, payload) => {
        const input = exactPayload(payload, ['releaseId'], 'Compatibility installation');
        if (typeof input.releaseId !== 'string' || !/^(umu|proton):[0-9]{1,20}$/.test(input.releaseId)) throw Error('Invalid compatibility release.');
        return compatibility().start(input.releaseId);
    }));
    ipcMain.handle('compatibility-cancel', guarded('compatibility-cancel', (_event, payload) => {
        const input = exactPayload(payload, ['jobId'], 'Compatibility download');
        if (!require('../runtime/native/protocol').UUID.test(input.jobId)) throw Error('Invalid compatibility download.');
        return compatibility().cancel(input.jobId);
    }));
    ipcMain.handle('compatibility-default', guarded('compatibility-default', (_event, payload) => {
        const input = exactPayload(payload, ['runtimeId'], 'Default compatibility version');
        if (input.runtimeId !== '' && (typeof input.runtimeId !== 'string' || !require('../runtime/native/protocol').UUID.test(input.runtimeId))) throw Error('Invalid compatibility version.');
        return compatibility().manager.setDefaultRuntime(input.runtimeId);
    }));
    ipcMain.handle('compatibility-remove', guarded('compatibility-remove', async (_event, payload) => {
        const input = exactPayload(payload, ['installedId'], 'Managed compatibility removal');
        if (typeof input.installedId !== 'string' || !/^(umu|proton):[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.installedId)) throw Error('Invalid managed compatibility version.');
        const downloads = compatibility(), installed = downloads.status().installed.find(item => item.id === input.installedId);
        if (!installed || !installed.removable) throw Error(installed?.reason || 'This Sail-managed version is unavailable.');
        const decision = await dialog.showMessageBox({ type: 'question', buttons: ['Remove version', 'Cancel'], defaultId: 1, cancelId: 1,
            message: `Remove ${installed.tag}?`, detail: 'This removes the unused version downloaded by Sail. Game files and Windows save folders are kept.' });
        if (decision.response !== 0) return { canceled: true };
        return downloads.remove(input.installedId);
    }));
    ipcMain.handle('proton-environment-status', guarded('proton-environment-status', (_event, payload) => {
        const input = exactPayload(payload, ['gameId', 'runtimeId'], 'Windows environment status');
        const scope = profileStore.authorityScope(input.gameId);
        if (!nativeSetup?.protonManager) throw new Error('Proton setup is unavailable.');
        return nativeSetup.protonManager.environmentStatus({ scope: { ...scope, gameId: String(input.gameId) },
            runtimeId: input.runtimeId, snapshot: nativeSetup.runtimeSnapshot?.() });
    }));
    function protonSaveContext(gameId) {
        if (!nativeSetup?.protonManager) throw Error('Proton save import is unavailable.');
        const metadata = profileStore.activeGameMetadata(gameId), scope = profileStore.authorityScope(gameId);
        const details = profileStore.localExecutionSetup(gameId).details;
        if (!require('../runtime/proton/wine').windowsBackend(details.linuxRuntime?.backend) || profileStore.authorityStatus(gameId).execution.state !== 'active') {
            throw Error('Save this game’s Proton launch setup before checking for saves.');
        }
        return { metadata, scope, details, manager: nativeSetup.protonManager };
    }
    function assertSaveImportIdle(context) {
        const current = protonSaveContext(context.scope.gameId);
        if (JSON.stringify(current.scope) !== JSON.stringify(context.scope) || current.metadata.steamAppId !== context.metadata.steamAppId
            || current.details.executablePath !== context.details.executablePath || JSON.stringify(current.details.linuxRuntime) !== JSON.stringify(context.details.linuxRuntime)) throw Error('The game setup changed. Reopen its settings.');
        const snapshot = nativeSetup.runtimeSnapshot?.() || {};
        const work = [...Object.values(snapshot.activeSessions || {}), ...(snapshot.completedSessions || [])];
        if (work.some(item => item.gameId === context.scope.gameId && item.libraryKey === `${context.scope.profileId}:${context.scope.libraryId}`)) {
            throw Error('Close the game in Sail and finish saving its playtime before importing a save.');
        }
        assertProfileMutationAllowed?.({ type: 'remove-game', scope: context.scope });
    }
    async function protonSaveDiscovery(context) {
        return require('../runtime/proton/saves').discoverSaves({ appId: context.metadata.steamAppId,
            executable: context.details.executablePath, discoveryOptions: context.manager.discoveryOptions });
    }
    ipcMain.handle('proton-save-status', guarded('proton-save-status', async (_event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'Proton saves');
        const context = protonSaveContext(input.gameId), status = await protonSaveDiscovery(context);
        const current = protonSaveContext(input.gameId);
        if (JSON.stringify(context.scope) !== JSON.stringify(current.scope)) throw Error('The active library changed.');
        let busy = false;
        try { assertSaveImportIdle(context); } catch (_) { busy = true; }
        return { ...status, busy, candidates: status.candidates.map(({ id, label, busy }) => ({ id, label, busy })) };
    }));
    ipcMain.handle('proton-import-save', guarded('proton-import-save', async (_event, payload) => {
        const input = exactPayload(payload, ['gameId', 'candidateId'], 'Steam save import');
        if (typeof input.candidateId !== 'string' || !/^[a-f0-9]{64}$/.test(input.candidateId)) throw Error('Choose a detected Steam save.');
        const context = protonSaveContext(input.gameId); assertSaveImportIdle(context);
        const status = await protonSaveDiscovery(context);
        const candidate = status.candidates.find(item => item.id === input.candidateId);
        if (!candidate) throw Error('The Steam save changed or disappeared. Check for saves again.');
        const decision = await dialog.showMessageBox({ type: 'question', buttons: ['Import Steam save', 'Cancel'], defaultId: 1, cancelId: 1,
            message: 'Import your Geometry Dash save from Steam?',
            detail: `Close Geometry Dash in Steam and Sail first. Progress, account state and Geode settings from this folder will replace Sail’s copy. Sail keeps a backup of its previous save; Steam’s files stay untouched. This is a one-time copy, not ongoing synchronization.\n\nSource: ${candidate.folder}` });
        if (decision.response !== 0) return { canceled: true };
        assertSaveImportIdle(context);
        return require('../runtime/proton/saves').importSave({ prefix: context.manager.savePrefix(context.scope, context.details.linuxRuntime.runtimeId),
            executable: context.details.executablePath, backend: context.details.linuxRuntime.backend, candidate, assertIdle: () => assertSaveImportIdle(context) });
    }));
    ipcMain.handle('wine-register-runtime', guarded('wine-register-runtime', async (event, payload) => {
        const input = exactPayload(payload, ['gameId', 'discoveryId'], 'Installed Wine registration');
        if (!nativeSetup?.protonManager) throw Error('Compatibility setup is unavailable.');
        const initialScope = input.gameId !== undefined ? profileStore.authorityScope(input.gameId) : profileStore.activeScope();
        const manager = nativeSetup.protonManager, status = await manager.installedStatus();
        let selected, label = '';
        if (input.discoveryId !== undefined) {
            if (typeof input.discoveryId !== 'string' || !/^[a-f0-9]{64}$/.test(input.discoveryId)) throw Error('Invalid detected Wine version.');
            const candidate = status.discovery.wine.find(item => item.id === input.discoveryId && item.available);
            if (!candidate) throw Error('The detected Wine installation changed. Refresh Compatibility and select it again.');
            selected = candidate.path; label = [candidate.label, candidate.version].filter(Boolean).join(' ');
        } else selected = await chooseFile(dialog, { title: 'Choose an installed Wine executable (wine or wine64)' });
        if (!selected) return { canceled: true };
        const wine = require('../runtime/proton/wine'), before = wine.validateWineInstallation(selected, nativeSetup);
        const decision = await dialog.showMessageBox({ type: 'question', buttons: ['Add this version', 'Cancel'], defaultId: 1, cancelId: 1,
            message: 'Use this Wine installation for Windows games?',
            detail: `Wine: ${before.winePath}\nLoader: ${before.loaderPath}\nServer: ${before.serverPath}\n\nEach game uses its own Wine environment, separate from Proton and your existing Wine prefix. Games and installers run as your user. ${manager.wineLaunchReadiness().reason}` });
        if (decision.response !== 0) return { canceled: true };
        authorizeIpcEvent(event, 'wine-register-runtime');
        const currentScope = input.gameId !== undefined ? profileStore.authorityScope(input.gameId) : profileStore.activeScope();
        if (initialScope.profileId !== currentScope.profileId || initialScope.libraryId !== currentScope.libraryId) throw Error('The active library changed during approval. Open Compatibility again.');
        const current = wine.validateWineInstallation(before.winePath, { ...nativeSetup, expected: before.wineIdentity });
        if (wine.installationId(before) !== wine.installationId(current)) throw Error('The Wine installation changed during approval. Choose it again.');
        const registered = manager.registerWineRuntime(before.winePath, label);
        return { canceled: false, ...await manager.installedStatus(), registeredRuntimeId: registered.registeredRuntimeId };
    }));
    ipcMain.handle('proton-register-runtime', guarded('proton-register-runtime', async (_event, payload) => {
        const input = exactPayload(payload, ['gameId', 'discoveryId'], 'Installed Proton registration');
        if (input.gameId !== undefined) profileStore.authorityScope(input.gameId);
        if (!nativeSetup?.protonManager) throw new Error('Proton setup is unavailable.');
        const manager = nativeSetup.protonManager;
        const status = await manager.installedStatus();
        let proton;
        if (input.discoveryId !== undefined) {
            if (typeof input.discoveryId !== 'string' || !/^[a-f0-9]{64}$/.test(input.discoveryId)) throw Error('Invalid detected Proton version.');
            const candidate = status.discovery.proton.find(item => item.id === input.discoveryId && item.available);
            if (!candidate) throw Error('The detected Proton version changed or disappeared. Reopen Compatibility and choose it again.');
            proton = candidate.path;
        } else proton = await chooseDirectory(dialog, { title: 'Choose an installed UMU-compatible Proton version' });
        if (!proton) return { canceled: true };
        const selectedInstallation = require('../runtime/proton/installation').validateProtonInstallation(proton, nativeSetup);
        let umu = status.discovery.umu[0]?.path;
        if (!umu) {
            const explain = await dialog.showMessageBox({ type: 'info', buttons: ['Choose umu-run', 'Cancel'], defaultId: 0, cancelId: 1,
                message: 'Proton needs the UMU launcher to run outside Steam.',
                detail: 'Choose the separate umu-run executable. It is not the proton file inside a Proton installation. If UMU is not installed, cancel and install it first, or select an existing umu-run download.' });
            if (explain.response !== 0) return { canceled: true };
            umu = await chooseFile(dialog, { title: 'Choose umu-run (separate from the Proton folder)' });
            if (!umu) return { canceled: true };
        }
        if (path.basename(umu) !== 'umu-run') throw Error('Choose the separate umu-run launcher, not the proton or wine executable.');
        const approvedUmu = require('../runtime/native/protocol').validateNativeExecutable(umu, { ...nativeSetup, allowScripts: true });
        const decision = await dialog.showMessageBox({ type: 'question', buttons: ['Add this version', 'Cancel'], defaultId: 1, cancelId: 1,
            message: 'Use these installed compatibility tools for Windows games?', detail: `UMU: ${umu}\nProton: ${proton}` });
        if (decision.response !== 0) return { canceled: true };
        require('../runtime/native/protocol').validateNativeExecutable(umu, { ...nativeSetup, allowScripts: true, expected: approvedUmu });
        const currentInstallation = require('../runtime/proton/installation').validateProtonInstallation(proton, nativeSetup);
        if (require('../runtime/proton/discovery').installationId(currentInstallation) !== require('../runtime/proton/discovery').installationId(selectedInstallation)) throw Error('The Proton version changed during approval. Choose it again.');
        const registered = manager.registerRuntime(umu, proton);
        return { canceled: false, ...await manager.installedStatus(), registeredRuntimeId: registered.registeredRuntimeId };
    }));
    ipcMain.handle('authority-get-native-setup', guarded('authority-get-native-setup', (_event, payload) => {
        if (!nativeSetup) throw new Error('Native setup is unavailable on this platform.');
        const input = exactPayload(payload, ['gameId'], 'Native setup');
        const saved = profileStore.localExecutionSetup(input.gameId);
        let reason = '';
        try {
            const native = require('../runtime/native/protocol');
            native.assertNativeOptions(saved.details); native.assertNativeOptions(saved.proposals);
            if (saved.details.executablePath) require('../runtime/proton/executable').selectLocalExecutable(saved.details.executablePath, { ...nativeSetup, expected: saved.details.executableIdentity });
        }
        catch (error) { reason = error.message; }
        if (!reason && saved.details.linuxRuntime?.backend === 'wine') reason = nativeSetup.protonManager?.wineLaunchReadiness().reason || '';
        return { argv: saved.details.argv || [], workingDirectory: saved.details.workingDirectory || '',
            executable: saved.details.executablePath || '', runtimeId: saved.details.linuxRuntime?.runtimeId || '',
            backend: saved.details.linuxRuntime?.backend || 'native', dllOverrides: saved.details.linuxRuntime?.dllOverrides || '', reason };
    }));
    ipcMain.handle('authority-select-working-directory', guarded('authority-select-working-directory', async (event, payload) => {
        if (!nativeSetup) throw new Error('Native working-directory selection is unavailable on this platform.');
        const input = exactPayload(payload || {}, ['gameId'], 'Working-directory selection');
        const scope = input.gameId ? profileStore.authorityScope(input.gameId) : profileStore.activeScope();
        const selected = await chooseDirectory(dialog, { title: 'Approve this native game’s working directory' });
        if (!selected) return { canceled: true };
        const identity = require('../runtime/native/protocol').validateWorkingDirectory(selected, nativeSetup);
        pruneExecutionSelections(); const selectionId = crypto.randomUUID();
        pendingExecutionSelections.set(selectionId, { senderId: executionSelectionSenderId(event), selectedPath: identity.realPath,
            selectedIdentity: identity, purpose: 'working-directory', gameId: input.gameId ? String(input.gameId) : '',
            profileId: scope.profileId, libraryId: scope.libraryId, createdAt: Date.now() });
        return { canceled: false, selectionId, label: identity.realPath };
    }));
    ipcMain.handle('authority-configure-execution', guarded('authority-configure-execution', async (event, payload) => {
        const input = exactPayload(payload, [
            'gameId', 'argumentProposal', 'requestPreLaunchScript', 'requestPostLaunchScript',
            'requestCompanion', 'requestElevation', 'requestHighPriority', 'requestTrackingExecutable',
            'requestRom', 'useSteamInstallation', 'baseSelectionId', 'capabilityId', 'expectedRevision', ...(nativeSetup ? ['argv', 'workingDirectorySelectionId', 'runtimeId', 'dllOverrides'] : [])
        ], 'Execution setup');
        const metadata = profileStore.activeGameMetadata(input.gameId);
        if (nativeSetup) {
            const native = require('../runtime/native/protocol');
            if (Object.entries(input).some(([key, value]) => (key.startsWith('request') || key === 'useSteamInstallation' || key === 'argumentProposal') && value)) {
                throw new Error('Native setup requires literal argument arrays. Steam, ROM, scripts, companion, elevation, priority and process-name tracking are unavailable.');
            }
            const saved = profileStore.localExecutionSetup(input.gameId);
            native.assertNativeOptions(saved.details); native.assertNativeOptions(saved.proposals);
            const argv = native.validateArgv(input.argv || []);
            let approved = null;
            let keptWorkingDirectory = '';
            const reference = profileStore.authorityStatus(input.gameId).execution;
            if (reference.state === 'active' && input.baseSelectionId && !input.workingDirectorySelectionId) {
                // A newly chosen executable replaces the old one, which may no longer match (a restored or updated
                // game). Only the working folder carries over, and it is checked against its own approval.
                const kept = native.validateWorkingDirectory(saved.details.workingDirectory, { ...nativeSetup, expected: saved.details.workingDirectoryIdentity });
                keptWorkingDirectory = kept.realPath;
            } else if (reference.state === 'active' && !(input.baseSelectionId && input.workingDirectorySelectionId)) {
                approved = profileStore.resolveExecutionCapability({ gameId: input.gameId, capabilityId: reference.capabilityId,
                    expectedRevision: reference.revision, operation: 'launch' }, { consume: false }).details;
                require('../runtime/proton/executable').selectLocalExecutable(approved.executablePath, { ...nativeSetup, expected: approved.executableIdentity });
                native.validateWorkingDirectory(approved.workingDirectory, { ...nativeSetup, expected: approved.workingDirectoryIdentity });
            }
            // Main-owned picker receipts or still-valid active permission only.
            const executablePath = input.baseSelectionId
                ? consumeExecutionSelection(event, input.baseSelectionId, { purpose: 'base', gameId: input.gameId })
                : approved?.executablePath || await chooseFile(dialog, { title: 'Choose this game’s executable' });
            if (!executablePath) return { canceled: true };
            const selected = require('../runtime/proton/executable').selectLocalExecutable(executablePath, nativeSetup);
            const executable = selected.identity;
            let linuxRuntime;
            if (selected.backend === 'proton-umu') {
                if (!nativeSetup.protonManager) throw new Error('Proton setup is unavailable.');
                const runtime = nativeSetup.protonManager.runtime(input.runtimeId);
                linuxRuntime = { backend: require('../runtime/proton/wine').runtimeBackend(runtime), runtimeId: runtime.id, dllOverrides: require('../runtime/proton/environment').validateDllOverrides(input.dllOverrides) };
            } else if (input.runtimeId || input.dllOverrides) throw new Error('Proton and Wine DLL overrides apply only to a Windows executable.');
            if (!input.baseSelectionId && executable.realPath !== path.resolve(executablePath)) {
                const decision = await dialog.showMessageBox({ type: 'question', buttons: ['Use this target', 'Cancel'], defaultId: 1, cancelId: 1,
                    message: 'Use the executable this link points to?', detail: executable.realPath });
                if (decision.response !== 0) return { canceled: true };
            }
            const workingDirectory = input.workingDirectorySelectionId
                ? consumeExecutionSelection(event, input.workingDirectorySelectionId, { purpose: 'working-directory', gameId: input.gameId })
                : approved?.workingDirectory || keptWorkingDirectory || (linuxRuntime ? path.dirname(executable.realPath)
                    : await chooseDirectory(dialog, { title: 'Approve this native game’s working directory' }));
            if (linuxRuntime && !approved && !keptWorkingDirectory && !input.workingDirectorySelectionId) {
                const decision = await dialog.showMessageBox({ type: 'question', buttons: ['Save launch setup', 'Cancel'], defaultId: 0, cancelId: 1,
                    message: 'Save this Windows game’s launch setup?', detail: `Executable: ${executable.realPath}\nWorking folder: ${workingDirectory}\nYou can change the working folder in Manage Game.` });
                if (decision.response !== 0) return { canceled: true };
            }
            if (!workingDirectory) return { canceled: true };
            const cwd = native.validateWorkingDirectory(workingDirectory, nativeSetup);
            require('../runtime/proton/executable').selectLocalExecutable(executable.realPath, { ...nativeSetup, expected: executable });
            if (linuxRuntime) nativeSetup.protonManager.runtime(linuxRuntime.runtimeId);
            if (approved) profileStore.resolveExecutionCapability({ gameId: input.gameId, capabilityId: reference.capabilityId, expectedRevision: reference.revision, operation: 'launch' }, { consume: false });
            native.validateWorkingDirectory(cwd.realPath, { ...nativeSetup, expected: cwd });
            const currentScope = profileStore.authorityScope(input.gameId);
            if (currentScope.profileId !== metadata.profileId || currentScope.libraryId !== metadata.libraryId) throw executionSelectionError('The active profile or library changed while saving setup. Open the game again.');
            return profileStore.createExecutionCapability(input.gameId, { executablePath: executable.realPath, argv, workingDirectory: cwd.realPath, ...(linuxRuntime ? { linuxRuntime } : {}) });
        }
        const currentReference = input.capabilityId || input.expectedRevision !== undefined ? {
            gameId: input.gameId, capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision, operation: 'reveal'
        } : null;
        const current = currentReference ? profileStore.validateExecutionCapability(currentReference).details : null;
        let steamAppId = '';
        let executablePath = '';
        if (current) {
            if (input.baseSelectionId) throw executionSelectionError('Launch-option edits cannot replace the base executable.');
            executablePath = current.executablePath || '';
            steamAppId = current.steamAppId || '';
        } else if (input.useSteamInstallation) {
            if (input.baseSelectionId) throw executionSelectionError('A local executable selection cannot be combined with Steam installation setup.');
            steamAppId = String(metadata.steamAppId || '');
            if (!steamAppId || typeof validateSteamAppId !== 'function' || !await validateSteamAppId(steamAppId)) {
                throw new Error('This Steam game is not installed in a locally detected Steam library.');
            }
        } else {
            executablePath = input.baseSelectionId
                ? consumeExecutionSelection(event, input.baseSelectionId, { purpose: 'base', gameId: input.gameId })
                : await chooseFile(dialog, {
                    title: input.requestRom ? 'Choose the local emulator executable' : 'Choose this game’s local executable',
                    filters: [{ name: 'Executables and shortcuts', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
                });
            if (!executablePath) return { canceled: true };
        }
        const romPath = input.requestRom && !current ? await chooseFile(dialog, { title: 'Choose the local ROM image' }) : '';
        if (input.requestRom && !current && !romPath) return { canceled: true };
        const argumentProposal = input.argumentProposal === undefined && current
            ? formatLaunchArguments(current.argv) : String(input.argumentProposal || '');
        let argv = current && argumentProposal === formatLaunchArguments(current.argv)
            ? current.argv : parseArgumentString(argumentProposal);
        if (input.requestRom && !current) {
            argv = argv.length ? argv.map(argument => argument.replace(/%rom%/g, romPath)) : [romPath];
            if (!argv.some(argument => argument.includes(romPath))) argv.push(romPath);
        }
        const scriptFilters = [{ name: 'Local scripts', extensions: ['ps1', 'bat', 'cmd', 'exe'] }];
        const preLaunchScript = input.requestPreLaunchScript ? await chooseFile(dialog, { title: 'Approve a pre-launch script', filters: scriptFilters }) : current && current.preLaunchScript || '';
        if (input.requestPreLaunchScript && !preLaunchScript) return { canceled: true };
        const postLaunchScript = input.requestPostLaunchScript ? await chooseFile(dialog, { title: 'Approve a post-exit script', filters: scriptFilters }) : current && current.postLaunchScript || '';
        if (input.requestPostLaunchScript && !postLaunchScript) return { canceled: true };
        const companionPath = input.requestCompanion ? await chooseFile(dialog, { title: 'Approve a companion application', filters: [{ name: 'Applications', extensions: ['exe', 'lnk'] }] }) : current && current.companionPath || '';
        if (input.requestCompanion && !companionPath) return { canceled: true };
        const playDetectionPath = input.requestTrackingExecutable ? await chooseFile(dialog, { title: 'Approve a process tracking executable', filters: [{ name: 'Executables', extensions: ['exe'] }] }) : current && current.playDetectionPath || '';
        if (input.requestTrackingExecutable && !playDetectionPath) return { canceled: true };
        const runAsAdmin = input.requestElevation === undefined && current ? current.runAsAdmin === true : input.requestElevation === true;
        const highPriority = input.requestHighPriority === undefined && current ? current.highPriority === true : input.requestHighPriority === true;
        // A picker can outlive a profile switch or another settings save.
        if (currentReference) profileStore.validateExecutionCapability(currentReference);
        return profileStore.createExecutionCapability(input.gameId, {
            executablePath, argv, workingDirectory: current ? current.workingDirectory : executablePath ? path.dirname(executablePath) : '',
            preLaunchScript: preLaunchScript || '', postLaunchScript: postLaunchScript || '',
            companionPath: companionPath || '', runAsAdmin, highPriority,
            playDetectionPath: playDetectionPath || '', steamAppId
        });
    }));
    ipcMain.handle('authority-configure-steam', guarded('authority-configure-steam', async (_event, payload) => {
        const input = exactPayload(payload, ['gameId', 'steamAppId'], 'Steam execution setup');
        const metadata = profileStore.activeGameMetadata(input.gameId);
        const steamAppId = String(input.steamAppId || '');
        if (!/^[1-9]\d{0,9}$/.test(steamAppId) || String(metadata.steamAppId || '') !== steamAppId) {
            throw new Error('The Steam AppID does not match the active game metadata.');
        }
        if (typeof validateSteamAppId !== 'function' || !await validateSteamAppId(steamAppId)) {
            throw new Error('That Steam game is not installed in a locally detected Steam library.');
        }
        return profileStore.createExecutionCapability(input.gameId, {
            executablePath: '', argv: [], workingDirectory: '', preLaunchScript: '',
            postLaunchScript: '', companionPath: '', runAsAdmin: false,
            highPriority: false, playDetectionPath: '', steamAppId
        });
    }));
    ipcMain.handle('authority-review-execution', guarded('authority-review-execution', async (_event, payload) => {
        const input = exactPayload(payload, ['gameId', 'capabilityId', 'expectedRevision', 'component'], 'Execution review');
        const pending = profileStore.pendingExecutionReview(input);
        const steamBase = input.component === 'base' && !!pending.steamAppId;
        const pathComponent = !steamBase && ['base', 'preLaunchScript', 'postLaunchScript', 'companion', 'tracking'].includes(input.component);
        const baseComponent = input.component === 'base';
        let buttons;
        let defaultId;
        let cancelId;
        let approveIndex = 0;
        let bulkIndex = -1;
        let replaceIndex = -1;
        let discardIndex = -1;
        let cancelIndex = -1;
        if (steamBase) {
            buttons = ['Approve installed Steam game', 'Approve all', 'Discard', 'Cancel'];
            defaultId = 0;
            cancelId = 3;
            bulkIndex = 1;
            discardIndex = 2;
            cancelIndex = 3;
        } else if (pathComponent && baseComponent) {
            buttons = ['Approve existing', 'Approve all', 'Choose replacement', 'Discard'];
            defaultId = 0;
            cancelId = 3;
            bulkIndex = 1;
            replaceIndex = 2;
            discardIndex = 3;
        } else if (pathComponent) {
            buttons = ['Approve existing', 'Choose replacement', 'Discard'];
            defaultId = 1;
            cancelId = 2;
            replaceIndex = 1;
            discardIndex = 2;
        } else {
            buttons = ['Approve', 'Discard', 'Cancel'];
            defaultId = 1;
            cancelId = 2;
            discardIndex = 1;
            cancelIndex = 2;
        }
        const decision = await dialog.showMessageBox({
            type: input.component === 'elevation' ? 'warning' : 'question',
            buttons,
            defaultId,
            cancelId,
            message: `Review local ${input.component.replace(/([A-Z])/g, ' $1').toLowerCase()}`,
            detail: `${String(pending.value || 'No value').slice(0, 8192)}${baseComponent
                ? '\n\nApprove all applies only to base game executables and locally validated Steam installations for this profile. Arguments, scripts, companions, elevation, priority, tracking, saves, and config folders remain separately unapproved.'
                : ''}`
        });
        if (bulkIndex >= 0 && decision.response === bulkIndex) {
            return {
                bulk: true,
                ...await profileStore.approveAllPendingExecutionBases(validateSteamAppId)
            };
        }
        if (cancelIndex >= 0 && decision.response === cancelIndex) return { canceled: true };
        let selectedPath = '';
        let accept = decision.response === approveIndex;
        if (steamBase && decision.response === 0) {
            accept = typeof validateSteamAppId === 'function' && await validateSteamAppId(pending.steamAppId);
            if (!accept) throw new Error('That Steam AppID is not installed on this PC.');
        } else if (pathComponent && decision.response === replaceIndex) {
            const extensions = input.component === 'base' ? ['exe', 'lnk', 'bat', 'cmd']
                : input.component === 'companion' ? ['exe', 'lnk']
                    : input.component === 'tracking' ? ['exe'] : ['ps1', 'bat', 'cmd', 'exe'];
            selectedPath = await chooseFile(dialog, { filters: [{ name: 'Local file', extensions }] });
            if (!selectedPath) return { canceled: true };
            accept = true;
        } else if (decision.response === discardIndex) {
            accept = false;
        }
        return profileStore.reviewPendingExecution(input, {
            accept,
            selectedPath,
            ...(steamBase && accept ? { steamAppId: pending.steamAppId } : {})
        });
    }));
    ipcMain.handle('authority-configure-filesystem', guarded('authority-configure-filesystem', async (_event, payload) => {
        const input = exactPayload(payload, ['gameId', 'kind', 'entryId', 'pathKind', 'selectionId', 'defaultPath'], 'Filesystem setup');
        if (!['save', 'config'].includes(input.kind)) throw new Error('Unsupported filesystem capability kind.');
        if (input.selectionId && (input.kind !== 'save' || input.pathKind !== 'folder')) {
            throw executionSelectionError('A save-folder selection can only configure a save folder.');
        }
        const selectedPath = input.selectionId
            ? consumeExecutionSelection(_event, input.selectionId, { purpose: 'save', gameId: input.gameId })
            : input.kind === 'config' && input.pathKind === 'file'
                ? await chooseFile(dialog, { title: 'Choose the local configuration file' })
                : await chooseDirectory(dialog, { title: input.kind === 'save' ? 'Choose the local save folder' : 'Choose the local configuration folder', ...pickerStart(input.defaultPath) });
        if (!selectedPath) return { canceled: true };
        return profileStore.createFilesystemCapability(input.gameId, input.kind, selectedPath, input.entryId || '');
    }));
    ipcMain.handle('authority-configure-tracking', guarded('authority-configure-tracking', async (event, payload) => {
        const input = exactPayload(payload, ['gameId', 'selectionId'], 'Tracking setup');
        const authority = profileStore.authorityStatus(input.gameId).execution;
        if (!authority || authority.state !== 'active' || !authority.capabilityId || !Number.isSafeInteger(authority.revision)) {
            throw new Error('The game does not have active execution authority. Configure its executable first.');
        }
        const current = profileStore.validateExecutionCapability({
            gameId: input.gameId, capabilityId: authority.capabilityId,
            expectedRevision: authority.revision, operation: 'reveal'
        }).details;
        const selectedPath = consumeExecutionSelection(event, input.selectionId, { purpose: 'tracking', gameId: input.gameId });
        return profileStore.createExecutionCapability(input.gameId, {
            executablePath: current.executablePath || '', argv: Array.isArray(current.argv) ? current.argv : [],
            workingDirectory: current.workingDirectory || '', preLaunchScript: current.preLaunchScript || '',
            postLaunchScript: current.postLaunchScript || '', companionPath: current.companionPath || '',
            runAsAdmin: current.runAsAdmin === true, highPriority: current.highPriority === true,
            playDetectionPath: selectedPath, steamAppId: current.steamAppId || ''
        });
    }));
    ipcMain.handle('authority-review-filesystem', guarded('authority-review-filesystem', async (_event, payload) => {
        const input = exactPayload(payload, ['gameId', 'capabilityId', 'expectedRevision'], 'Filesystem review');
        const pending = profileStore.pendingFilesystemReview(input);
        const decision = await dialog.showMessageBox({
            type: 'question', buttons: ['Approve existing', 'Choose replacement', 'Cancel'], defaultId: 1, cancelId: 2,
            message: `Review this local ${pending.kind} path`, detail: pending.value
        });
        if (decision.response === 2) return { canceled: true };
        let selectedPath = '';
        if (decision.response === 1) {
            selectedPath = pending.kind === 'config' && fs.existsSync(pending.value) && fs.statSync(pending.value).isFile()
                ? await chooseFile(dialog, { title: 'Choose the local configuration file' })
                : await chooseDirectory(dialog, { title: `Choose the local ${pending.kind} folder` });
            if (!selectedPath) return { canceled: true };
        }
        return profileStore.reviewPendingFilesystem(input, selectedPath);
    }));

    return { accountService, profileStore, offerSaveSelection };
}

module.exports = { registerAccountIpc };
