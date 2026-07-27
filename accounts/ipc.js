const { AccountService } = require('./accountService');
const { ProfileStore } = require('./profileStore');

function messageOf(error) {
    return error && error.message ? error.message : String(error || 'Unknown error');
}

function registerAccountIpc({ app, ipcMain, safeStorage }) {
    const accountService = new AccountService({ app, safeStorage });
    const profileStore = new ProfileStore(app.getPath('userData'));

    const guarded = handler => async (_event, ...args) => {
        try {
            return { success: true, data: await handler(...args) };
        } catch (error) {
            console.error('Account IPC failed:', messageOf(error));
            return { success: false, error: messageOf(error) };
        }
    };

    ipcMain.handle('account-get-state', guarded(() => accountService.state()));
    ipcMain.handle('account-sign-in', guarded(payload => accountService.signIn(payload && payload.identifier, payload && payload.password)));
    ipcMain.handle('account-sign-up', guarded(payload => accountService.signUp(
        payload && payload.email,
        payload && payload.username,
        payload && payload.password
    )));
    ipcMain.handle('account-reset-password', guarded(payload => accountService.resetPassword(payload && payload.email)));
    ipcMain.handle('account-password-verification', guarded(() => accountService.requestPasswordChangeVerification()));
    ipcMain.handle('account-change-password', guarded(payload => accountService.changePassword(
        payload && payload.password,
        payload && payload.nonce
    )));
    ipcMain.handle('account-sign-out', guarded(() => accountService.signOut()));
    ipcMain.handle('account-alert-admin-state', guarded(() => accountService.alertAdminState()));
    ipcMain.handle('account-publish-alert', guarded(payload => accountService.publishAlert(payload)));
    ipcMain.handle('account-list-remote', guarded(() => accountService.listRemoteControlPlane()));
    ipcMain.handle('account-upsert-remote', guarded(payload => accountService.upsertControlPlane(payload)));
    ipcMain.handle('account-delete-remote-profile', guarded(payload => accountService.deleteRemoteProfile(
        payload && payload.profileId,
        payload && payload.profileName
    )));
    ipcMain.handle('account-upload-avatar', guarded(filePath => accountService.uploadAvatar(filePath)));
    ipcMain.handle('account-cloud-storage-status', guarded(() => accountService.storageStatus()));
    ipcMain.handle('account-cloud-list-files', guarded(() => accountService.listCloudFiles()));
    ipcMain.handle('account-cloud-delete-file', guarded(payload => accountService.deleteCloudFile(
        payload && payload.artifactId
    )));
    ipcMain.handle('account-cloud-upload-file', guarded(payload => accountService.uploadCloudFile(payload || {})));
    ipcMain.handle('account-cloud-list-versions', guarded(payload => accountService.listCloudVersions(payload || {})));
    ipcMain.handle('account-cloud-download-file', guarded(payload => accountService.downloadCloudFile(payload || {})));
    ipcMain.handle('account-cloud-link-start', guarded(provider => accountService.startCloudOAuth(provider)));
    ipcMain.handle('account-cloud-disconnect', guarded(provider => accountService.disconnectPortableCloud(provider)));

    ipcMain.handle('profiles-bootstrap', guarded(snapshot => {
        profileStore.initialize(snapshot || {});
        return { state: profileStore.getState(), snapshot: profileStore.loadActiveSnapshot() };
    }));
    ipcMain.handle('profiles-get-state', guarded(() => profileStore.getState()));
    ipcMain.handle('profiles-capture-active', guarded(snapshot => profileStore.captureActiveSnapshot(snapshot || {})));
    ipcMain.handle('profiles-export-control-plane', guarded(() => profileStore.exportControlPlane()));
    ipcMain.handle('profiles-merge-control-plane', guarded(payload => profileStore.mergeControlPlane(payload || {})));
    ipcMain.handle('profiles-create', guarded(payload => profileStore.createProfile(
        payload && payload.name,
        payload && payload.pin,
        payload && payload.snapshot
    )));
    ipcMain.handle('profiles-update', guarded(payload => profileStore.updateProfile(payload.profileId, payload.patch || {})));
    ipcMain.handle('profiles-set-avatar', guarded(payload => profileStore.setProfileAvatar(payload.profileId, payload.filePath)));
    ipcMain.handle('profiles-clear-avatar', guarded(payload => profileStore.clearProfileAvatar(payload.profileId)));
    ipcMain.handle('profiles-delete', guarded(payload => profileStore.deleteProfile(payload.profileId, payload.pin || '')));
    ipcMain.handle('profiles-unlock', guarded(payload => profileStore.unlockProfile(payload.profileId, payload.pin || '')));
    ipcMain.handle('profiles-switch', guarded(payload => profileStore.switchProfile(payload.profileId)));
    ipcMain.handle('profiles-create-library', guarded(payload => profileStore.createLibrary(payload.name, payload.snapshot || {})));
    ipcMain.handle('profiles-switch-library', guarded(payload => profileStore.switchLibrary(payload.libraryId)));
    ipcMain.handle('profiles-create-preset', guarded(payload => profileStore.createPreset(payload.name, payload.snapshot || {})));
    ipcMain.handle('profiles-switch-preset', guarded(payload => profileStore.switchPreset(payload.presetId)));

    return { accountService, profileStore };
}

module.exports = { registerAccountIpc };
