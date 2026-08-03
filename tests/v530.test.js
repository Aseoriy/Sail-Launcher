'use strict';

const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccountService, SafeStorageAdapter } = require('../accounts/accountService');
const { registerAccountIpc } = require('../accounts/ipc');
const { ProfileStore } = require('../accounts/profileStore');
const {
    decideConflict,
    normalizeConfigEntry,
    normalizeSyncSettings,
    portableSnapshot
} = require('../sync/syncV2');

test('profile store migrates a legacy snapshot and never exposes PIN verifiers', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-profile-test-'));
    t.after(() => fs.removeSync(root));
    const store = new ProfileStore(root);
    const initial = store.initialize({
        myGames: [{ id: 'one', name: 'Test Game' }],
        customSections: [{ name: 'Test' }],
        globalSettings: { theme: 'theme-midnight' }
    });
    assert.equal(initial.profiles.length, 1);
    assert.equal(store.loadActiveSnapshot().myGames[0].name, 'Test Game');
    const withPin = store.createProfile('Locked', '2468', {});
    const locked = withPin.profiles.find(profile => profile.name === 'Locked');
    assert.equal(locked.locked, true);
    assert.equal(Object.hasOwn(locked, 'pinVerifier'), false);
    assert.equal(store.unlockProfile(locked.id, '0000').success, false);
    assert.equal(store.unlockProfile(locked.id, '2468').success, true);
});

test('remote library merges preserve this PC device paths', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-profile-merge-'));
    t.after(() => fs.removeSync(root));
    const store = new ProfileStore(root);
    const state = store.initialize({
        myGames: [{
            id: 'game-one',
            name: 'Old Name',
            exePath: 'C:\\Games\\game.exe',
            localSave: 'C:\\Saves\\game'
        }]
    });
    const profile = state.profiles[0];
    const library = profile.libraries[0];
    store.mergeControlPlane({
        profiles: [{
            id: profile.id,
            name: profile.name,
            conflict_mode: 'newest',
            updated_at: new Date(Date.now() + 1000).toISOString()
        }],
        libraries: [{
            id: library.id,
            profile_id: profile.id,
            name: library.name,
            catalog: { games: [{ id: 'game-one', name: 'Cloud Name' }], sections: [] }
        }]
    });
    const game = store.loadActiveSnapshot().myGames[0];
    assert.equal(game.name, 'Cloud Name');
    assert.equal(game.exePath, 'C:\\Games\\game.exe');
    assert.equal(game.localSave, 'C:\\Saves\\game');
});

test('portable account snapshots exclude device paths and secrets', () => {
    const result = portableSnapshot({
        myGames: [{
            id: 'one',
            name: 'Game',
            exePath: 'C:\\Games\\game.exe',
            localSave: 'C:\\Users\\Me\\save',
            configSyncEntries: [{ id: 'cfg', name: 'Config', localPath: 'C:\\secret', enabled: true }]
        }],
        globalSettings: {
            theme: 'theme-midnight',
            steamApiKey: 'secret',
            discordToken: 'secret',
            customCloudKeysData: { dropbox: { clientSecret: 'secret' } },
            localLauncherAvatar: 'C:\\avatar.png',
            accountSyncEnabled: false
        }
    });
    assert.equal(result.myGames[0].exePath, undefined);
    assert.equal(result.myGames[0].localSave, undefined);
    assert.equal(result.myGames[0].configSyncEntries[0].localPath, undefined);
    assert.equal(result.globalSettings.steamApiKey, undefined);
    assert.equal(result.globalSettings.customCloudKeysData, undefined);
    assert.equal(result.globalSettings.localLauncherAvatar, undefined);
    assert.equal(result.globalSettings.accountSyncEnabled, undefined);
    assert.equal(result.globalSettings.theme, 'theme-midnight');
});

test('account session storage retries after secure storage becomes available', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-session-storage-'));
    t.after(() => fs.removeSync(root));
    const filePath = path.join(root, 'sail_account_session.json');
    let encryptionAvailable = false;
    const safeStorage = {
        isEncryptionAvailable: () => encryptionAvailable,
        encryptString: value => Buffer.from(String(value), 'utf8'),
        decryptString: value => Buffer.from(value).toString('utf8')
    };

    const writer = new SafeStorageAdapter(filePath, safeStorage);
    encryptionAvailable = true;
    await writer.setItem('supabase.auth.token', 'test-session');

    const reader = new SafeStorageAdapter(filePath, safeStorage);
    encryptionAvailable = false;
    assert.equal(await reader.getItem('supabase.auth.token'), null);
    encryptionAvailable = true;
    assert.equal(await reader.getItem('supabase.auth.token'), 'test-session');
});

test('username sign-in surfaces the Edge Function response message', async () => {
    const service = Object.create(AccountService.prototype);
    service.client = {
        functions: {
            invoke: async () => ({
                data: null,
                error: {
                    message: 'Edge Function returned a non-2xx status code',
                    context: {
                        clone: () => ({
                            json: async () => ({ error: 'Invalid email, username, or password.' })
                        })
                    }
                }
            })
        }
    };

    await assert.rejects(
        () => service.signIn('Aseoriy', 'not-the-password'),
        /Invalid email, username, or password\./
    );
});

test('password changes require an issued challenge and a server-verified 8-digit email code', async () => {
    const service = Object.create(AccountService.prototype);
    const calls = [];
    service.passwordChallenge = null;
    service.state = async () => ({
        signedIn: true,
        user: { id: 'user-1', email: 'sailor@example.com' }
    });
    service.client = {
        auth: {
            signInWithOtp: async payload => {
                calls.push(['send', payload]);
                return { error: null };
            },
            verifyOtp: async payload => {
                calls.push(['verify', payload]);
                if (payload.token !== '65100908') return { data: null, error: new Error('invalid') };
                return { data: { user: { id: 'user-1' } }, error: null };
            },
            updateUser: async payload => {
                calls.push(['update', payload]);
                return { error: null };
            }
        }
    };

    await assert.rejects(
        () => service.changePassword('different-password', '65100908'),
        /email a verification code/i
    );
    await service.requestPasswordChangeVerification();
    await assert.rejects(
        () => service.changePassword('different-password', '651009'),
        /all 8 digits/i
    );
    await assert.rejects(
        () => service.changePassword('different-password', '77777777'),
        /incorrect or expired/i
    );
    await service.changePassword('different-password', '65100908');
    assert.equal(calls[0][0], 'send');
    assert.equal(calls.find(call => call[0] === 'verify')[1].type, 'email');
    assert.deepEqual(calls.at(-1), ['update', { password: 'different-password' }]);
    assert.equal(service.passwordChallenge, null);
});

test('alerts manager reuses the verified Sail Hub admin session', async () => {
    const inserted = [];
    const service = Object.create(AccountService.prototype);
    service.client = {
        auth: {
            getUser: async () => ({
                data: {
                    user: {
                        email: 'admin@example.com',
                        app_metadata: { alert_admin: true }
                    }
                },
                error: null
            })
        },
        from: table => ({
            insert: async row => {
                inserted.push({ table, row });
                return { error: null };
            }
        })
    };

    assert.deepEqual(await service.alertAdminState(), {
        signedIn: true,
        authorized: true,
        email: 'admin@example.com'
    });
    await service.publishAlert({
        audience: 'specific',
        message: 'Update available',
        type: 'warning',
        active: true,
        targetVersions: ['5.3.0']
    });
    assert.equal(inserted[0].table, 'version_alerts');
    assert.deepEqual(inserted[0].row.target_versions, ['5.3.0']);

    service.client.auth.getUser = async () => ({
        data: { user: { email: 'user@example.com', app_metadata: {} } },
        error: null
    });
    await assert.rejects(
        () => service.publishAlert({ message: 'Nope' }),
        /not authorized/i
    );
});

test('account IPC registers alerts and Sail Cloud file handlers', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-account-ipc-'));
    t.after(() => fs.removeSync(root));
    const handlers = new Map();
    const ipcMain = {
        handle: (channel, handler) => handlers.set(channel, handler)
    };
    registerAccountIpc({
        app: { getPath: () => root },
        ipcMain,
        safeStorage: {
            isEncryptionAvailable: () => false,
            encryptString: () => Buffer.alloc(0),
            decryptString: () => ''
        }
    });
    assert.equal(typeof handlers.get('account-alert-admin-state'), 'function');
    assert.equal(typeof handlers.get('account-publish-alert'), 'function');
    assert.equal(typeof handlers.get('account-cloud-list-files'), 'function');
    assert.equal(typeof handlers.get('account-cloud-delete-file'), 'function');
});

test('sync schedules, paths, and conflict decisions are normalized', () => {
    const settings = normalizeSyncSettings({
        configChangeMode: 'immediate',
        configIntervalMinutes: 10,
        sailCloudSingleSaveCopy: true,
        sailCloudExcludedGameSaveKeys: ['game-save:one', 'invalid', 'game-save:one'],
        destinations: { config: ['google', 'google', 'unknown'], saves: ['sailcloud'], gameConfigs: ['dropbox'] }
    });
    assert.equal(settings.configChangeMode, 'immediate');
    assert.equal(settings.configIntervalMinutes, 10);
    assert.deepEqual(settings.destinations.config, ['google']);
    assert.deepEqual(settings.destinations.saves, ['sailcloud']);
    assert.deepEqual(settings.destinations.gameConfigs, ['dropbox']);
    assert.equal(settings.sailCloudSingleSaveCopy, true);
    assert.deepEqual(settings.sailCloudExcludedGameSaveKeys, ['game-save:one']);
    const entry = normalizeConfigEntry({ kind: 'file', localPath: 'C:\\game.ini', intervalMinutes: 15 });
    assert.equal(entry.kind, 'file');
    assert.equal(entry.intervalMinutes, 15);
    assert.equal(decideConflict({ mode: 'local', localChanged: true, remoteChanged: true }), 'upload');
    assert.equal(decideConflict({ mode: 'newest', localChanged: true, remoteChanged: true, localTime: 1, remoteTime: 2 }), 'download');
    assert.equal(decideConflict({ mode: 'prompt', localChanged: true, remoteChanged: true }), 'prompt');
});

test('Dropbox built-in credentials remain server-side environment references', () => {
    const root = path.join(__dirname, '..');
    const start = fs.readFileSync(path.join(root, 'supabase', 'functions', 'cloud-oauth-start', 'index.ts'), 'utf8');
    const callback = fs.readFileSync(path.join(root, 'supabase', 'functions', 'cloud-oauth-callback', 'index.ts'), 'utf8');
    const cloudSync = fs.readFileSync(path.join(root, 'cloudSync.js'), 'utf8');
    assert.match(start, /Deno\.env\.get\('DROPBOX_CLIENT_ID'\)/);
    assert.match(callback, /Deno\.env\.get\('DROPBOX_CLIENT_SECRET'\)/);
    assert.match(cloudSync, /dropbox:\s*\{\s*clientId:\s*'',\s*clientSecret:\s*''\s*\}/);
});

test('launcher profiles can be renamed, given separate local avatars, and deleted', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-profile-manage-'));
    t.after(() => fs.removeSync(root));
    const firstAvatar = path.join(root, 'first.png');
    const secondAvatar = path.join(root, 'second.webp');
    fs.writeFileSync(firstAvatar, Buffer.from('first-avatar'));
    fs.writeFileSync(secondAvatar, Buffer.from('second-avatar'));

    const store = new ProfileStore(root);
    const initial = store.initialize({});
    const firstId = initial.activeProfileId;
    const afterCreate = store.createProfile('Second Profile', '2468', {});
    const secondId = afterCreate.profiles.find(profile => profile.id !== firstId).id;

    store.setProfileAvatar(firstId, firstAvatar);
    store.setProfileAvatar(secondId, secondAvatar);
    const withAvatars = store.getState();
    const firstStoredAvatar = withAvatars.profiles.find(profile => profile.id === firstId).localAvatarPath;
    const secondStoredAvatar = withAvatars.profiles.find(profile => profile.id === secondId).localAvatarPath;
    assert.notEqual(firstStoredAvatar, secondStoredAvatar);
    assert.equal(fs.readFileSync(firstStoredAvatar, 'utf8'), 'first-avatar');
    assert.equal(fs.readFileSync(secondStoredAvatar, 'utf8'), 'second-avatar');

    store.updateProfile(firstId, { name: 'Renamed Profile' });
    assert.equal(store.getState().profiles.find(profile => profile.id === firstId).name, 'Renamed Profile');
    assert.throws(() => store.deleteProfile(secondId, '0000'), /PIN|Try again/i);
    const deleted = store.deleteProfile(secondId, '2468');
    assert.equal(deleted.deletedProfile.id, secondId);
    assert.equal(fs.existsSync(store.profilePath(secondId)), false);
    assert.throws(() => store.deleteProfile(firstId), /last one/i);
});

test('Sail Hub account management uses server-enforced verified-email actions', () => {
    const root = path.join(__dirname, '..');
    const page = fs.readFileSync(path.join(root, 'Website', 'Main', 'manage-account.html'), 'utf8');
    const verification = fs.readFileSync(
        path.join(root, 'supabase', 'functions', '_shared', 'verification.ts'),
        'utf8'
    );
    const updatePassword = fs.readFileSync(
        path.join(root, 'supabase', 'functions', 'account-update-password', 'index.ts'),
        'utf8'
    );
    assert.match(page, /account-update-username/);
    assert.match(page, /account-update-password/);
    assert.match(page, /account-delete/);
    assert.match(page, /passwordVerificationSent/);
    assert.match(page, /usernameVerificationCode/);
    assert.match(page, /deleteVerificationCode/);
    assert.match(page, /verifyOtp/);
    assert.match(page, /Code Sent — Resend in/);
    assert.match(updatePassword, /requireFreshEmailVerification/);
    assert.match(updatePassword, /admin\.updateUserById/);
    assert.match(verification, /method === 'otp'/);
    assert.doesNotMatch(verification, /magiclink|recovery/);
});

test('embedded Sail Hub navigation and upload manager stay compact', () => {
    const root = path.join(__dirname, '..');
    const launcher = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const plugins = fs.readFileSync(path.join(root, 'Website', 'Main', 'plugins.html'), 'utf8');
    const manager = fs.readFileSync(path.join(root, 'Website', 'Main', 'manage-account.html'), 'utf8');
    assert.match(launcher, /plugins\?launcher=1/);
    assert.match(plugins, /sail-launcher-embedded/);
    assert.match(plugins, /launcher-public-nav/);
    assert.match(manager, /data-view="tiles"/);
    assert.match(manager, /setUploadView\('details'\)/);
    assert.match(manager, /Recently updated/);
    assert.match(manager, /Package:/);
    assert.match(manager, /upload-preview/);
    assert.match(launcher, /sail-secret-toggle/);
    assert.match(launcher, /id="launcherProfilePin"[^>]*data-no-secret-toggle/);
    assert.match(launcher, /\.sail-secret-toggle:hover[\s\S]*transform:\s*translateY\(-50%\)/);
    assert.match(launcher, /button\.style\.setProperty\('transform',\s*'translateY\(-50%\)',\s*'important'\)/);
    assert.match(launcher, /button:not\(\.outline\):not\(\.titlebar-btn\):not\(\.sail-secret-toggle\):hover/);
});

test('launcher account UI is tabbed, titlebar-safe, and uses device-only sync state', () => {
    const root = path.join(__dirname, '..');
    const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const verificationTemplate = fs.readFileSync(
        path.join(root, 'supabase', 'templates', 'sail_verification.html'),
        'utf8'
    );
    assert.match(page, /id="accountSectionTabOverview"/);
    assert.match(page, /id="accountSectionTabSecurity"/);
    assert.match(page, /#accountModal\s*\{[^}]*top:\s*45px/s);
    assert.match(page, /id="accountPasswordNonce"[^>]*maxlength="8"/);
    assert.match(page, /id="accountPasswordVerificationStatus"/);
    assert.match(page, /id="accountPasswordChangeButton"[^>]*disabled/);
    assert.match(page, /id="startupScreen"/);
    assert.match(page, /settingsTabTransitionToken/);
    assert.match(main, /buttons:\s*\[\{\s*label:\s*'Sail Launcher',\s*url:\s*SAIL_WEBSITE_URL/);
    assert.match(main, /win\.once\('ready-to-show'/);
    assert.match(verificationTemplate, /\{\{\s*\.Token\s*\}\}/);
    assert.match(verificationTemplate, /\{\{\s*\.ConfirmationURL\s*\}\}/);
    assert.match(page, /sailAccountSyncEnabledV2/);
    assert.doesNotMatch(page, /globalSettings\.accountSyncEnabled\s*===\s*false/);
});
