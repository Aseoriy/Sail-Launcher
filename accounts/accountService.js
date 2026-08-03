const fs = require('fs-extra');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { SailCloudClient } = require('./sailCloud');

const SAIL_SUPABASE_URL = 'https://vglpzpffejwgttlqrums.supabase.co';
const SAIL_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_BaNykIu4jFs-B1hVAd2Y1A_71t1BK2e';

async function functionErrorMessage(error, fallback) {
    const response = error && error.context;
    if (response && typeof response.clone === 'function') {
        try {
            const payload = await response.clone().json();
            const message = payload && (payload.error || payload.message);
            if (typeof message === 'string' && message.trim()) return message.trim();
        } catch (_) {}
    }
    return error && typeof error.message === 'string' && error.message.trim()
        ? error.message
        : fallback;
}

class SafeStorageAdapter {
    constructor(filePath, safeStorage) {
        this.filePath = filePath;
        this.safeStorage = safeStorage;
        this.cache = null;
    }

    load() {
        if (this.cache) return this.cache;
        // Do not cache an empty result while secure storage is temporarily
        // unavailable. Electron can report this during startup, and caching
        // the empty result would hide an existing session for the rest of the
        // process.
        if (!this.safeStorage.isEncryptionAvailable()) return {};
        this.cache = {};
        if (!fs.existsSync(this.filePath)) return this.cache;
        try {
            const payload = fs.readJsonSync(this.filePath);
            for (const [key, encoded] of Object.entries(payload || {})) {
                const encrypted = Buffer.from(String(encoded), 'base64');
                this.cache[key] = this.safeStorage.decryptString(encrypted);
            }
        } catch (_) {
            this.cache = {};
        }
        return this.cache;
    }

    persist() {
        if (!this.safeStorage.isEncryptionAvailable()) return;
        fs.ensureDirSync(path.dirname(this.filePath));
        const output = {};
        for (const [key, value] of Object.entries(this.cache || {})) {
            const encrypted = this.safeStorage.encryptString(String(value));
            output[key] = encrypted.toString('base64');
        }
        fs.writeJsonSync(this.filePath, output, { spaces: 2 });
    }

    async getItem(key) {
        return this.load()[key] || null;
    }

    async setItem(key, value) {
        const cache = this.load();
        cache[key] = String(value);
        this.cache = cache;
        this.persist();
    }

    async removeItem(key) {
        const cache = this.load();
        delete cache[key];
        this.cache = cache;
        this.persist();
    }
}

class AccountService {
    constructor({ app, safeStorage }) {
        this.storage = new SafeStorageAdapter(
            path.join(app.getPath('userData'), 'sail_account_session.json'),
            safeStorage
        );
        this.client = createClient(SAIL_SUPABASE_URL, SAIL_SUPABASE_PUBLISHABLE_KEY, {
            realtime: {
                transport: WebSocket
            },
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false,
                storage: this.storage,
                flowType: 'pkce'
            }
        });
        this.passwordChallenge = null;
        this.sailCloud = new SailCloudClient({
            getAccessToken: () => this.accessToken()
        });
    }

    async accessToken() {
        const { data: { session } } = await this.client.auth.getSession();
        return session && session.access_token || null;
    }

    async state() {
        const { data: { session } } = await this.client.auth.getSession();
        if (!session || !session.user) return { signedIn: false, user: null, profile: null };
        const { data: profile } = await this.client
            .from('profiles')
            .select('id,username,avatar_url,created_at')
            .eq('id', session.user.id)
            .maybeSingle();
        return {
            signedIn: true,
            user: { id: session.user.id, email: session.user.email || '' },
            profile: profile || {
                id: session.user.id,
                username: session.user.user_metadata && session.user.user_metadata.username || session.user.email || 'Sail User',
                avatar_url: null
            }
        };
    }

    async signIn(identifier, password) {
        const value = String(identifier || '').trim();
        if (!value || !password) throw new Error('Email or username and password are required.');
        let data;
        let error;
        if (value.includes('@')) {
            ({ data, error } = await this.client.auth.signInWithPassword({ email: value, password }));
        } else {
            let result;
            try {
                result = await this.client.functions.invoke('account-login', {
                    body: { identifier: value, password }
                });
            } catch (invokeError) {
                throw new Error(await functionErrorMessage(
                    invokeError,
                    'Unable to sign in right now.'
                ));
            }
            if (result.error) {
                throw new Error(await functionErrorMessage(
                    result.error,
                    'Unable to sign in right now.'
                ));
            }
            if (!result.data || !result.data.session) throw new Error('Invalid email, username, or password.');
            ({ data, error } = await this.client.auth.setSession({
                access_token: result.data.session.access_token,
                refresh_token: result.data.session.refresh_token
            }));
        }
        if (error) throw error;
        return this.state();
    }

    async signUp(email, username, password) {
        const cleanUsername = String(username || '').trim();
        if (!cleanUsername || cleanUsername.length < 3) throw new Error('Username must be at least 3 characters.');
        if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');
        const { error } = await this.client.auth.signUp({
            email: String(email || '').trim(),
            password,
            options: { data: { username: cleanUsername } }
        });
        if (error) throw error;
        return { success: true, message: 'Check your email to verify the new Sail account.' };
    }

    async resetPassword(email) {
        const { error } = await this.client.auth.resetPasswordForEmail(String(email || '').trim(), {
            redirectTo: 'https://sail-launcher.sailhub.fyi/auth'
        });
        if (error) throw error;
        return { success: true };
    }

    async requestPasswordChangeVerification() {
        const account = await this.state();
        if (!account.signedIn) throw new Error('Sign in before changing your password.');
        this.passwordChallenge = null;
        const { error } = await this.client.auth.signInWithOtp({
            email: account.user.email,
            options: { shouldCreateUser: false }
        });
        if (error) throw error;
        this.passwordChallenge = {
            userId: account.user.id,
            email: account.user.email,
            requestedAt: Date.now(),
            attempts: 0
        };
        return { success: true, message: 'An 8-digit verification code was sent to your account email.' };
    }

    async changePassword(password, nonce) {
        const nextPassword = String(password || '');
        const verificationCode = String(nonce || '').trim();
        if (nextPassword.length < 8) throw new Error('The new password must be at least 8 characters.');
        if (!/^\d{8}$/.test(verificationCode)) throw new Error('Enter all 8 digits from the code in your email.');
        const challenge = this.passwordChallenge;
        if (!challenge) throw new Error('Email a verification code before changing your password.');
        if (Date.now() - challenge.requestedAt > 10 * 60 * 1000) {
            this.passwordChallenge = null;
            throw new Error('That verification code expired. Email a new code and try again.');
        }
        if (challenge.attempts >= 5) {
            this.passwordChallenge = null;
            throw new Error('Too many incorrect attempts. Email a new verification code.');
        }

        challenge.attempts += 1;
        const { data: verified, error: verificationError } = await this.client.auth.verifyOtp({
            email: challenge.email,
            token: verificationCode,
            type: 'email'
        });
        if (verificationError) throw new Error('That verification code is incorrect or expired.');
        if (!verified || !verified.user || verified.user.id !== challenge.userId) {
            this.passwordChallenge = null;
            throw new Error('The verification code did not match this Sail account.');
        }

        // Consume the challenge before the update so a successful OTP cannot be replayed.
        this.passwordChallenge = null;
        const { error } = await this.client.auth.updateUser({ password: nextPassword });
        if (error) throw error;
        return { success: true };
    }

    async signOut() {
        this.passwordChallenge = null;
        await this.client.auth.signOut({ scope: 'local' });
        return { signedIn: false, user: null, profile: null };
    }

    async alertAdminState() {
        const { data, error } = await this.client.auth.getUser();
        if (error || !data || !data.user) {
            return { signedIn: false, authorized: false, email: '' };
        }
        const user = data.user;
        return {
            signedIn: true,
            authorized: !!(user.app_metadata && user.app_metadata.alert_admin === true),
            email: user.email || ''
        };
    }

    async publishAlert(payload = {}) {
        const admin = await this.alertAdminState();
        if (!admin.signedIn) throw new Error('Sign in to your Sail Hub account before using Alerts Manager.');
        if (!admin.authorized) throw new Error('This Sail Hub account is not authorized to publish launcher alerts.');

        const audience = payload.audience === 'specific' ? 'specific' : 'all';
        const row = {
            message: String(payload.message || '').trim(),
            type: ['info', 'warning', 'critical'].includes(payload.type) ? payload.type : 'info',
            active: payload.active !== false,
            action_text: payload.actionText ? String(payload.actionText).trim() : null,
            action_url: payload.actionUrl ? String(payload.actionUrl).trim() : null
        };
        if (!row.message) throw new Error('Enter an alert message.');
        if (audience === 'specific') {
            row.target_versions = Array.isArray(payload.targetVersions)
                ? payload.targetVersions.map(version => String(version))
                : [];
            if (!row.target_versions.length) throw new Error('Add at least one target version.');
        }

        const table = audience === 'specific' ? 'version_alerts' : 'alerts';
        const { error } = await this.client.from(table).insert(row);
        if (error) throw error;
        return { published: true, audience, email: admin.email };
    }

    async listRemoteControlPlane() {
        const account = await this.state();
        if (!account.signedIn) return { profiles: [], connections: [] };
        const [profiles, libraries, presets, policies, connections, artifacts] = await Promise.all([
            this.client.from('launcher_profiles').select('*').order('created_at'),
            this.client.from('launcher_libraries').select('*').order('created_at'),
            this.client.from('launcher_presets').select('*').order('created_at'),
            this.client.from('sync_policies').select('*'),
            this.client.from('cloud_connections').select('id,provider,provider_account_label,status,last_verified_at,created_at'),
            this.client.from('sync_artifacts')
                .select('id,profile_id,library_id,artifact_type,logical_key,revision,content_hash,updated_at')
                .in('artifact_type', ['library', 'preset'])
        ]);
        for (const result of [profiles, libraries, presets, policies, connections, artifacts]) {
            if (result.error) throw result.error;
        }
        const artifactRows = artifacts.data || [];
        const hydrate = async (row, type, field, emptyValue) => {
            const artifact = artifactRows.find(item =>
                item.artifact_type === type
                && item.profile_id === row.profile_id
                && item.logical_key === `${type}:${row.id}`
            );
            if (!artifact) return row;
            const { bytes } = await this.sailCloud.downloadArtifact(artifact.id);
            let value;
            try { value = JSON.parse(bytes.toString('utf8')); } catch (_) {
                throw new Error(`The cloud ${type} payload is not valid JSON.`);
            }
            return { ...row, [field]: value || emptyValue, sail_artifact: artifact };
        };
        const hydratedLibraries = await Promise.all((libraries.data || []).map(row =>
            hydrate(row, 'library', 'catalog', { games: [], sections: [] })
        ));
        const hydratedPresets = await Promise.all((presets.data || []).map(row =>
            hydrate(row, 'preset', 'settings', {})
        ));
        let storage;
        try {
            storage = await this.sailCloud.status();
        } catch (error) {
            storage = {
                unavailable: true,
                error: error && error.message ? error.message : 'Sail Cloud is temporarily unavailable.'
            };
        }
        return {
            profiles: profiles.data || [],
            libraries: hydratedLibraries,
            presets: hydratedPresets,
            policies: policies.data || [],
            connections: connections.data || [],
            storage
        };
    }

    async startCloudOAuth(provider) {
        const account = await this.state();
        if (!account.signedIn) throw new Error('Sign in to make a cloud connection portable.');
        if (!['google', 'dropbox'].includes(provider)) {
            throw new Error(provider === 'onedrive'
                ? 'OneDrive requires a custom app and remains local to this PC.'
                : 'This provider uses its local connection flow.');
        }
        const { data, error } = await this.client.functions.invoke('cloud-oauth-start', {
            body: { provider }
        });
        if (error) throw error;
        if (!data || !data.url) throw new Error('Cloud authorization URL was not returned.');
        return { provider, url: data.url };
    }

    async portableCloudAccess(provider) {
        const account = await this.state();
        if (!account.signedIn) return null;
        const { data, error } = await this.client.functions.invoke('cloud-access-token', {
            body: { provider }
        });
        if (error) throw error;
        return data && data.access_token ? data : null;
    }

    async disconnectPortableCloud(provider) {
        const { data, error } = await this.client.functions.invoke('cloud-disconnect', {
            body: { provider }
        });
        if (error) throw error;
        return data || { success: true };
    }

    async upsertControlPlane(payload = {}) {
        const account = await this.state();
        if (!account.signedIn) throw new Error('Sign in to sync launcher profiles.');
        const existing = await this.listRemoteControlPlane();
        const profileIdMap = new Map();
        const profiles = (Array.isArray(payload.profiles) ? payload.profiles : []).map(row => {
            const match = existing.profiles.find(item => String(item.name).toLowerCase() === String(row.name).toLowerCase());
            const id = match ? match.id : row.id;
            profileIdMap.set(row.id, id);
            return { ...row, id, user_id: account.user.id };
        });
        if (profiles.length) {
            const { error } = await this.client.from('launcher_profiles').upsert(profiles, { onConflict: 'id' });
            if (error) throw error;
        }

        const normalizeChildren = (rows, current) => (Array.isArray(rows) ? rows : []).map(row => {
            const profileId = profileIdMap.get(row.profile_id) || row.profile_id;
            const match = current.find(item =>
                item.profile_id === profileId &&
                String(item.name).toLowerCase() === String(row.name).toLowerCase()
            );
            return {
                ...row,
                id: match ? match.id : row.id,
                profile_id: profileId,
                user_id: account.user.id
            };
        });
        const libraries = normalizeChildren(payload.libraries, existing.libraries);
        const presets = normalizeChildren(payload.presets, existing.presets);
        if (libraries.length) {
            const { error } = await this.client.from('launcher_libraries').upsert(libraries, { onConflict: 'id' });
            if (error) throw error;
        }
        if (presets.length) {
            const { error } = await this.client.from('launcher_presets').upsert(presets, { onConflict: 'id' });
            if (error) throw error;
        }
        const policies = (Array.isArray(payload.policies) ? payload.policies : []).map(row => ({
            ...row,
            profile_id: profileIdMap.get(row.profile_id) || row.profile_id,
            user_id: account.user.id
        }));
        if (policies.length) {
            const { error } = await this.client.from('sync_policies').upsert(policies, { onConflict: 'profile_id,category' });
            if (error) throw error;
        }
        for (const library of libraries) {
            const current = await this.findArtifact(library.profile_id, `library:${library.id}`);
            await this.sailCloud.uploadJson({
                profileId: library.profile_id,
                libraryId: library.id,
                artifactType: 'library',
                logicalKey: `library:${library.id}`,
                expectedRevision: current ? current.revision : 0,
                maxVersions: 1
            }, library.catalog || { games: [], sections: [] });
            const { error } = await this.client
                .from('launcher_libraries')
                .update({ catalog: { games: [], sections: [] } })
                .eq('id', library.id);
            if (error) throw error;
        }
        for (const preset of presets) {
            const current = await this.findArtifact(preset.profile_id, `preset:${preset.id}`);
            await this.sailCloud.uploadJson({
                profileId: preset.profile_id,
                artifactType: 'preset',
                logicalKey: `preset:${preset.id}`,
                expectedRevision: current ? current.revision : 0,
                maxVersions: 1
            }, preset.settings || {});
            const { error } = await this.client
                .from('launcher_presets')
                .update({ settings: {} })
                .eq('id', preset.id);
            if (error) throw error;
        }
        return this.listRemoteControlPlane();
    }

    async findArtifact(profileId, logicalKey) {
        const { data, error } = await this.client
            .from('sync_artifacts')
            .select('id,profile_id,library_id,artifact_type,logical_key,revision,content_hash,updated_at')
            .eq('profile_id', profileId)
            .eq('logical_key', logicalKey)
            .maybeSingle();
        if (error) throw error;
        return data || null;
    }

    storageStatus() {
        return this.sailCloud.status();
    }

    listCloudFiles() {
        return this.sailCloud.files();
    }

    deleteCloudFile(artifactId) {
        return this.sailCloud.deleteArtifact(artifactId);
    }

    async uploadCloudFile(payload = {}) {
        const account = await this.state();
        if (!account.signedIn) throw new Error('Sign in to use Sail Cloud.');
        const profileId = String(payload.profileId || '');
        const logicalKey = String(payload.logicalKey || '');
        const current = await this.findArtifact(profileId, logicalKey);
        return this.sailCloud.uploadFile({
            profileId,
            libraryId: payload.libraryId || null,
            gameId: payload.gameId || null,
            configEntryId: payload.configEntryId || null,
            artifactType: payload.artifactType,
            logicalKey,
            expectedRevision: payload.expectedRevision === undefined
                ? (current ? current.revision : 0)
                : payload.expectedRevision,
            maxVersions: payload.maxVersions,
            contentType: payload.contentType || 'application/zip'
        }, payload.filePath);
    }

    async listCloudVersions(payload = {}) {
        const artifact = await this.findArtifact(payload.profileId, payload.logicalKey);
        if (!artifact) return [];
        return this.sailCloud.versions(artifact.id);
    }

    async downloadCloudFile(payload = {}) {
        const artifact = payload.artifactId
            ? { id: payload.artifactId }
            : await this.findArtifact(payload.profileId, payload.logicalKey);
        if (!artifact) throw new Error('That Sail Cloud item has no uploaded version.');
        return this.sailCloud.downloadArtifactToFile(artifact.id, payload.destinationPath, payload.revision || null);
    }

    async deleteRemoteProfile(profileId, profileName) {
        const account = await this.state();
        if (!account.signedIn) return { deleted: false };
        const { data, error } = await this.client
            .from('launcher_profiles')
            .select('id,name');
        if (error) throw error;
        const target = (data || []).find(item =>
            item.id === profileId ||
            String(item.name || '').toLowerCase() === String(profileName || '').toLowerCase()
        );
        if (!target) return { deleted: false };
        await this.sailCloud.deleteProfile(target.id);
        return { deleted: true };
    }

    async uploadAvatar(filePath) {
        const account = await this.state();
        if (!account.signedIn) throw new Error('Sign in before changing the public avatar.');
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
        if (!contentTypes[ext]) throw new Error('Avatar must be a PNG, JPEG, or WebP image.');
        const stat = fs.statSync(filePath);
        if (stat.size > 2 * 1024 * 1024) throw new Error('Avatar must be 2 MB or smaller.');
        const objectPath = `${account.user.id}/avatar${ext === '.jpeg' ? '.jpg' : ext}`;
        const bytes = fs.readFileSync(filePath);
        const { error } = await this.client.storage.from('avatars').upload(objectPath, bytes, {
            contentType: contentTypes[ext],
            upsert: true
        });
        if (error) throw error;
        const { data } = this.client.storage.from('avatars').getPublicUrl(objectPath);
        const avatarUrl = `${data.publicUrl}?v=${Date.now()}`;
        const { error: updateError } = await this.client.from('profiles').update({ avatar_url: avatarUrl }).eq('id', account.user.id);
        if (updateError) throw updateError;
        return this.state();
    }
}

module.exports = {
    AccountService,
    SafeStorageAdapter,
    SAIL_SUPABASE_URL,
    SAIL_SUPABASE_PUBLISHABLE_KEY
};
