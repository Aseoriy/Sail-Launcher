const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { SailCloudClient, sha256 } = require('./sailCloud');
const {
    PORTABLE_SCHEMA,
    admitPortableArtifact,
    canonicalPortableBytes,
    serializePortableArtifact,
    validatePortableArtifact
} = require('../sync/portableArtifactV3');

const SAIL_SUPABASE_URL = 'https://vglpzpffejwgttlqrums.supabase.co';
const SAIL_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_BaNykIu4jFs-B1hVAd2Y1A_71t1BK2e';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUD_UUID_NAMESPACE = Buffer.from('8b55b75f4acb4f14a856d9ace2b8df53', 'hex');

// Sail's SQL routing columns are UUIDs. Keep legacy launcher IDs in portable
// content and logical keys, while deriving stable UUIDv5 routing metadata.
function cloudUuid(kind, value, scope = '') {
    const clean = String(value || '').trim();
    if (!clean) return null;
    if (UUID_PATTERN.test(clean)) return clean.toLowerCase();
    const hash = crypto.createHash('sha1')
        .update(CLOUD_UUID_NAMESPACE)
        .update(Buffer.from(`${scope}:${kind}:${clean}`, 'utf8'))
        .digest();
    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function emptyRemoteIdentityAliases() {
    return {
        accountId: null,
        profiles: new Map(),
        libraries: new Map(),
        presets: new Map()
    };
}

function canonicalControlPlaneArtifact(input) {
    const admitted = admitPortableArtifact(input, { kindHint: 'control-plane' });
    if (admitted.artifact.kind !== 'control-plane') {
        throw new Error('A PortableArtifactV3 control plane is required.');
    }
    return admitted.artifact;
}

function isProfileNotFoundError(error) {
    const marker = String(error && (error.code || error.message) || '')
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_');
    return marker === 'PROFILE_NOT_FOUND';
}

function identityNameKey(parentId, name) {
    return `${String(parentId || '')}\u0000${String(name || '')}`;
}

function identityTimestamp(row) {
    return Date.parse(row && (row.updatedAt || row.createdAt) || '') || 0;
}

function selectIdentityCandidate(candidates, targetId, sourceId, row) {
    const candidate = { sourceId: String(sourceId), row };
    const current = candidates.get(targetId);
    if (!current
        || identityTimestamp(candidate.row) > identityTimestamp(current.row)
        || identityTimestamp(candidate.row) === identityTimestamp(current.row)
            && candidate.sourceId.toLowerCase() === targetId
            && current.sourceId.toLowerCase() !== targetId) {
        candidates.set(targetId, candidate);
    }
}

function reconcilePortableIdentities(artifact, remoteRows, accountId, previousAliases = null) {
    artifact = canonicalControlPlaneArtifact(artifact);
    const aliases = emptyRemoteIdentityAliases();
    aliases.accountId = accountId;
    const previous = previousAliases && previousAliases.accountId === accountId
        ? previousAliases
        : emptyRemoteIdentityAliases();

    const remoteProfiles = Array.isArray(remoteRows.profiles) ? remoteRows.profiles : [];
    const remoteProfileById = new Map(remoteProfiles.map(row => [String(row.id).toLowerCase(), row]));
    const profileTargetByName = new Map(remoteProfiles.map(row => [String(row.name), String(row.id).toLowerCase()]));
    const profileCandidates = new Map();
    for (const row of artifact.profiles) {
        const proposedId = cloudUuid('profile', row.id, accountId);
        const knownId = previous.profiles.get(row.id);
        const targetId = knownId && remoteProfileById.has(knownId)
            ? knownId
            : remoteProfileById.has(proposedId) ? proposedId : profileTargetByName.get(row.name) || proposedId;
        if (!profileTargetByName.has(row.name)) profileTargetByName.set(row.name, targetId);
        aliases.profiles.set(row.id, targetId);
        aliases.profiles.set(targetId, targetId);
        selectIdentityCandidate(profileCandidates, targetId, row.id, { ...row, id: targetId });
    }

    const remoteLibraries = Array.isArray(remoteRows.libraries) ? remoteRows.libraries : [];
    const remoteLibraryById = new Map(remoteLibraries.map(row => [String(row.id).toLowerCase(), row]));
    const libraryTargetByName = new Map(remoteLibraries.map(row => [
        identityNameKey(String(row.profile_id).toLowerCase(), row.name),
        String(row.id).toLowerCase()
    ]));
    const libraryCandidates = new Map();
    for (const row of artifact.libraries) {
        const profileId = aliases.profiles.get(row.profileId);
        const proposedId = cloudUuid('library', row.id, accountId);
        const exact = remoteLibraryById.get(proposedId);
        const knownId = previous.libraries.get(row.id);
        const known = knownId && remoteLibraryById.get(knownId);
        const nameKey = identityNameKey(profileId, row.name);
        const targetId = known && String(known.profile_id).toLowerCase() === profileId
            ? knownId
            : exact && String(exact.profile_id).toLowerCase() === profileId
            ? proposedId
            : libraryTargetByName.get(nameKey) || proposedId;
        if (!libraryTargetByName.has(nameKey)) libraryTargetByName.set(nameKey, targetId);
        aliases.libraries.set(row.id, targetId);
        aliases.libraries.set(targetId, targetId);
        selectIdentityCandidate(libraryCandidates, targetId, row.id, {
            ...row,
            id: targetId,
            profileId
        });
    }

    const remotePresets = Array.isArray(remoteRows.presets) ? remoteRows.presets : [];
    const remotePresetById = new Map(remotePresets.map(row => [String(row.id).toLowerCase(), row]));
    const presetTargetByName = new Map(remotePresets.map(row => [
        identityNameKey(String(row.profile_id).toLowerCase(), row.name),
        String(row.id).toLowerCase()
    ]));
    const presetCandidates = new Map();
    for (const row of artifact.presets) {
        const profileId = aliases.profiles.get(row.profileId);
        const proposedId = cloudUuid('preset', row.id, accountId);
        const exact = remotePresetById.get(proposedId);
        const knownId = previous.presets.get(row.id);
        const known = knownId && remotePresetById.get(knownId);
        const nameKey = identityNameKey(profileId, row.name);
        const targetId = known && String(known.profile_id).toLowerCase() === profileId
            ? knownId
            : exact && String(exact.profile_id).toLowerCase() === profileId
            ? proposedId
            : presetTargetByName.get(nameKey) || proposedId;
        if (!presetTargetByName.has(nameKey)) presetTargetByName.set(nameKey, targetId);
        aliases.presets.set(row.id, targetId);
        aliases.presets.set(targetId, targetId);
        selectIdentityCandidate(presetCandidates, targetId, row.id, {
            ...row,
            id: targetId,
            profileId
        });
    }

    return {
        artifact: validatePortableArtifact({
            ...artifact,
            profiles: [...profileCandidates.values()].map(candidate => candidate.row),
            libraries: [...libraryCandidates.values()].map(candidate => candidate.row),
            presets: [...presetCandidates.values()].map(candidate => candidate.row)
        }),
        aliases
    };
}

function emptyPortableControlPlane() {
    return {
        schema: PORTABLE_SCHEMA,
        kind: 'control-plane',
        exportedAt: new Date().toISOString(),
        profiles: [], libraries: [], presets: []
    };
}

function portablePresentation(artifact, extras = {}) {
    const canonical = canonicalControlPlaneArtifact(artifact);
    return {
        artifact: canonical,
        profiles: canonical.profiles.map(profile => ({
            id: profile.id,
            name: profile.name,
            conflict_mode: profile.conflictMode,
            created_at: profile.createdAt || null,
            updated_at: profile.updatedAt || null
        })),
        libraries: canonical.libraries.map(library => ({
            id: library.id,
            profile_id: library.profileId,
            name: library.name,
            catalog: { games: library.games, sections: library.sections },
            created_at: library.createdAt || null,
            updated_at: library.updatedAt || null
        })),
        presets: canonical.presets.map(preset => ({
            id: preset.id,
            profile_id: preset.profileId,
            name: preset.name,
            settings: preset.settings,
            created_at: preset.createdAt || null,
            updated_at: preset.updatedAt || null
        })),
        ...extras
    };
}

function componentArtifact(artifact, type, id) {
    const profileId = type === 'library'
        ? artifact.libraries.find(item => item.id === id)?.profileId
        : artifact.presets.find(item => item.id === id)?.profileId;
    const profile = artifact.profiles.find(item => item.id === profileId);
    if (!profile) throw new Error(`Portable ${type} references an unknown profile.`);
    return validatePortableArtifact({
        schema: PORTABLE_SCHEMA,
        kind: 'control-plane',
        exportedAt: artifact.exportedAt,
        profiles: [profile],
        libraries: type === 'library' ? artifact.libraries.filter(item => item.id === id) : [],
        presets: type === 'preset' ? artifact.presets.filter(item => item.id === id) : []
    });
}

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
        if (!this.isEncryptionAvailable()) return {};
        // A refresh-token rotation can be interrupted while the session is
        // being written. Prefer a complete pending replacement, then the
        // primary file, and finally the previous committed file.
        for (const filePath of [
            `${this.filePath}.tmp`,
            this.filePath,
            `${this.filePath}.bak`
        ]) {
            const loaded = this.readEncryptedFile(filePath);
            if (loaded) {
                this.cache = loaded;
                return this.cache;
            }
        }
        this.cache = {};
        return this.cache;
    }

    readEncryptedFile(filePath) {
        if (!fs.existsSync(filePath)) return null;
        try {
            const payload = fs.readJsonSync(filePath);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
            const loaded = {};
            for (const [key, encoded] of Object.entries(payload)) {
                const encrypted = Buffer.from(String(encoded), 'base64');
                loaded[key] = this.safeStorage.decryptString(encrypted);
            }
            return loaded;
        } catch (_) {
            return null;
        }
    }

    persist() {
        if (!this.isEncryptionAvailable()) return;
        fs.ensureDirSync(path.dirname(this.filePath));
        const output = {};
        for (const [key, value] of Object.entries(this.cache || {})) {
            const encrypted = this.safeStorage.encryptString(String(value));
            output[key] = encrypted.toString('base64');
        }
        const temporaryPath = `${this.filePath}.tmp`;
        const backupPath = `${this.filePath}.bak`;
        let descriptor;
        try {
            descriptor = fs.openSync(temporaryPath, 'w');
            fs.writeFileSync(descriptor, JSON.stringify(output, null, 2), 'utf8');
            fs.fsyncSync(descriptor);
        } finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
        }

        // Keep the old complete file available until the replacement has
        // itself been fully written and renamed. If the process stops between
        // these renames, load() can recover either complete snapshot.
        if (fs.existsSync(this.filePath)) {
            if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
            fs.renameSync(this.filePath, backupPath);
        }
        fs.renameSync(temporaryPath, this.filePath);
        try { fs.unlinkSync(backupPath); } catch (_) {}
    }

    isEncryptionAvailable() {
        try {
            return !!this.safeStorage.isEncryptionAvailable();
        } catch (_) {
            return false;
        }
    }

    async waitForEncryption(timeoutMs = 2500) {
        const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
        do {
            if (this.isEncryptionAvailable()) return true;
            if (Date.now() >= deadline) return false;
            await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        return this.isEncryptionAvailable();
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
        this.artifactCachePath = path.join(app.getPath('userData'), 'sail_cloud_artifact_cache');
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
        this.remoteControlPlaneInFlight = new Map();
        this.artifactBytesCache = new Map();
        this.remoteIdentityAliases = emptyRemoteIdentityAliases();
        this.remoteIdentityInFlight = new Map();
    }

    resetCloudRequestState() {
        this.remoteControlPlaneInFlight = new Map();
        this.artifactBytesCache = new Map();
        this.remoteIdentityAliases = emptyRemoteIdentityAliases();
        this.remoteIdentityInFlight = new Map();
    }

    async accessToken() {
        const session = await this.session();
        return session && session.access_token || null;
    }

    async session() {
        let session;
        let retryAfterStorageReady = false;
        try {
            const result = await this.client.auth.getSession();
            session = result && result.data && result.data.session;
        } catch (error) {
            if (!this.storage || !await this.storage.waitForEncryption()) throw error;
            retryAfterStorageReady = true;
        }
        if (!retryAfterStorageReady && (session || !this.storage || this.storage.isEncryptionAvailable())) return session || null;
        if (!await this.storage.waitForEncryption()) return null;
        const result = await this.client.auth.getSession();
        return result && result.data && result.data.session || null;
    }

    async state() {
        const session = await this.session();
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
        if (this.storage && !this.storage.isEncryptionAvailable()) await this.storage.waitForEncryption();
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
        this.resetCloudRequestState();
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
        this.resetCloudRequestState();
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

    async listRemoteControlPlane(options = {}) {
        const account = await this.state();
        if (!account.signedIn) return portablePresentation(emptyPortableControlPlane(), { connections: [], policies: [], storage: null });
        if (!this.remoteControlPlaneInFlight) this.remoteControlPlaneInFlight = new Map();
        const accountId = account.user.id;
        const includeStorage = options.includeStorage !== false;
        const requestKey = `${accountId}:${includeStorage ? 'with-storage' : 'metadata-only'}`;
        if (this.remoteControlPlaneInFlight.has(requestKey)) {
            return this.remoteControlPlaneInFlight.get(requestKey);
        }
        const operation = this.loadRemoteControlPlane(account, { includeStorage });
        this.remoteControlPlaneInFlight.set(requestKey, operation);
        try {
            return await operation;
        } finally {
            if (this.remoteControlPlaneInFlight.get(requestKey) === operation) {
                this.remoteControlPlaneInFlight.delete(requestKey);
            }
        }
    }

    artifactCacheKey(accountId, artifactId, revision) {
        return `${accountId}:${artifactId}:${revision}`;
    }

    artifactCacheFile(accountId, artifactId, revision) {
        if (!this.artifactCachePath) return null;
        const accountScope = sha256(Buffer.from(String(accountId), 'utf8'));
        const artifactScope = sha256(Buffer.from(String(artifactId), 'utf8'));
        return path.join(this.artifactCachePath, accountScope, `${artifactScope}-${Number(revision)}.json`);
    }

    readArtifactCache(accountId, artifact) {
        const filePath = this.artifactCacheFile(accountId, artifact.id, artifact.revision);
        if (!filePath || !artifact.content_hash || !fs.existsSync(filePath)) return null;
        try {
            const bytes = fs.readFileSync(filePath);
            if (sha256(bytes) !== String(artifact.content_hash).toLowerCase()) {
                fs.unlinkSync(filePath);
                return null;
            }
            return bytes;
        } catch (_) {
            return null;
        }
    }

    writeArtifactCache(accountId, artifactId, revision, bytes) {
        const filePath = this.artifactCacheFile(accountId, artifactId, revision);
        if (!filePath) return;
        const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        try {
            fs.ensureDirSync(path.dirname(filePath));
            fs.writeFileSync(temporary, bytes);
            fs.moveSync(temporary, filePath, { overwrite: true });
        } catch (_) {
            try { fs.unlinkSync(temporary); } catch (_) {}
        }
    }

    cacheArtifactBytes(accountId, artifactId, revision, bytes) {
        if (!artifactId || !Number.isSafeInteger(Number(revision))) return;
        if (!this.artifactBytesCache) this.artifactBytesCache = new Map();
        this.artifactBytesCache.set(
            this.artifactCacheKey(accountId, artifactId, Number(revision)),
            Buffer.from(bytes)
        );
        this.writeArtifactCache(accountId, artifactId, revision, bytes);
    }

    async artifactBytes(accountId, artifact) {
        const key = this.artifactCacheKey(accountId, artifact.id, Number(artifact.revision));
        if (!this.artifactBytesCache) this.artifactBytesCache = new Map();
        if (this.artifactBytesCache.has(key)) return this.artifactBytesCache.get(key);
        const cached = this.readArtifactCache(accountId, artifact);
        if (cached) {
            this.artifactBytesCache.set(key, cached);
            return cached;
        }
        const { bytes } = await this.sailCloud.downloadArtifact(artifact.id, artifact.revision);
        this.cacheArtifactBytes(accountId, artifact.id, artifact.revision, bytes);
        return bytes;
    }

    pruneArtifactBytes(accountId, activeArtifacts) {
        if (!this.artifactBytesCache) this.artifactBytesCache = new Map();
        const prefix = `${accountId}:`;
        const activeKeys = new Set(activeArtifacts.map(artifact =>
            this.artifactCacheKey(accountId, artifact.id, Number(artifact.revision))
        ));
        for (const key of this.artifactBytesCache.keys()) {
            if (key.startsWith(prefix) && !activeKeys.has(key)) this.artifactBytesCache.delete(key);
        }
        if (!this.artifactCachePath) return;
        const activeFiles = new Set(activeArtifacts.map(artifact =>
            path.basename(this.artifactCacheFile(accountId, artifact.id, artifact.revision))
        ));
        const accountPath = path.dirname(this.artifactCacheFile(accountId, 'artifact', 0));
        try {
            for (const name of fs.readdirSync(accountPath)) {
                if (!activeFiles.has(name)) fs.unlinkSync(path.join(accountPath, name));
            }
        } catch (_) {}
    }

    async loadRemoteControlPlane(account, { includeStorage = true } = {}) {
        const accountId = account.user.id;
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
            const bytes = await this.artifactBytes(accountId, artifact);
            let value;
            try { value = JSON.parse(bytes.toString('utf8')); } catch (_) {
                throw new Error(`The cloud ${type} payload is not valid JSON.`);
            }
            if (value && value.schema === PORTABLE_SCHEMA) {
                const admitted = admitPortableArtifact(value, { kindHint: 'control-plane' }).artifact;
                value = type === 'library'
                    ? admitted.libraries.find(item => item.id === row.id)
                    : admitted.presets.find(item => item.id === row.id);
                value = type === 'library'
                    ? value && { games: value.games, sections: value.sections }
                    : value && value.settings;
                if (!value) throw new Error(`The cloud ${type} artifact does not contain its declared item.`);
            }
            return { ...row, [field]: value || emptyValue, sail_artifact: artifact };
        };
        const hydratedLibraries = await Promise.all((libraries.data || []).map(row =>
            hydrate(row, 'library', 'catalog', { games: [], sections: [] })
        ));
        const hydratedPresets = await Promise.all((presets.data || []).map(row =>
            hydrate(row, 'preset', 'settings', {})
        ));
        this.pruneArtifactBytes(accountId, artifactRows);
        let storage = null;
        if (includeStorage) {
            try {
                storage = await this.sailCloud.status();
            } catch (error) {
                storage = {
                    unavailable: true,
                    error: error && error.message ? error.message : 'Sail Cloud is temporarily unavailable.'
                };
            }
        }
        const admitted = admitPortableArtifact({
            profiles: profiles.data || [],
            libraries: hydratedLibraries,
            presets: hydratedPresets
        }, { kindHint: 'control-plane' });
        return portablePresentation(admitted.artifact, {
            diagnostics: admitted.diagnostics,
            policies: policies.data || [],
            connections: connections.data || [],
            storage
        });
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

    async uploadJsonArtifactIfChanged(accountId, payload, value, current) {
        const bytes = Buffer.from(serializePortableArtifact(value), 'utf8');
        const digest = sha256(bytes);
        if (current && current.content_hash === digest) {
            this.cacheArtifactBytes(accountId, current.id, current.revision, bytes);
            return {
                artifact_id: current.id,
                revision: current.revision,
                unchanged: true
            };
        }
        const result = await this.sailCloud.uploadBytes({
            ...payload,
            expectedRevision: current ? current.revision : 0,
            contentType: 'application/json; charset=utf-8'
        }, bytes);
        this.cacheArtifactBytes(accountId, result.artifact_id, result.revision, bytes);
        return result;
    }

    controlPlaneArtifact(payload) {
        const canonical = canonicalControlPlaneArtifact(payload);
        return validatePortableArtifact(JSON.parse(serializePortableArtifact(canonical)));
    }

    resolveCloudIdentity(kind, value) {
        const clean = String(value || '').trim();
        if (!clean) return null;
        const aliases = this.remoteIdentityAliases || emptyRemoteIdentityAliases();
        const aliasMap = aliases[kind];
        if (aliasMap && aliasMap.has(clean)) return aliasMap.get(clean);
        const scopedKinds = new Set(['profiles', 'libraries', 'presets']);
        const singular = {
            profiles: 'profile', libraries: 'library', presets: 'preset',
            games: 'game', configEntries: 'config-entry'
        }[kind] || kind;
        return cloudUuid(singular, clean, scopedKinds.has(kind) ? aliases.accountId || '' : '');
    }

    remoteIdentityReady(accountId, profileId, libraryId) {
        const aliases = this.remoteIdentityAliases;
        return !!aliases && aliases.accountId === accountId
            && aliases.profiles.has(String(profileId || ''))
            && (!libraryId || aliases.libraries.has(String(libraryId)));
    }

    async writeControlPlaneIdentities(account, artifact) {
        const [profilesResult, librariesResult, presetsResult] = await Promise.all([
            this.client.from('launcher_profiles').select('id,name'),
            this.client.from('launcher_libraries').select('id,profile_id,name'),
            this.client.from('launcher_presets').select('id,profile_id,name')
        ]);
        for (const result of [profilesResult, librariesResult, presetsResult]) {
            if (result.error) throw result.error;
        }
        const reconciled = reconcilePortableIdentities(artifact, {
            profiles: profilesResult.data,
            libraries: librariesResult.data,
            presets: presetsResult.data
        }, account.user.id, this.remoteIdentityAliases);
        const remoteArtifact = reconciled.artifact;
        const profiles = remoteArtifact.profiles.map(row => ({
            id: row.id,
            user_id: account.user.id,
            name: row.name,
            conflict_mode: row.conflictMode,
            ...(row.createdAt ? { created_at: row.createdAt } : {}),
            ...(row.updatedAt ? { updated_at: row.updatedAt } : {})
        }));
        const libraries = remoteArtifact.libraries.map(row => ({
            id: row.id,
            profile_id: row.profileId,
            user_id: account.user.id,
            name: row.name,
            catalog: { games: [], sections: [] },
            ...(row.createdAt ? { created_at: row.createdAt } : {}),
            ...(row.updatedAt ? { updated_at: row.updatedAt } : {})
        }));
        const presets = remoteArtifact.presets.map(row => ({
            id: row.id,
            profile_id: row.profileId,
            user_id: account.user.id,
            name: row.name,
            settings: {},
            ...(row.createdAt ? { created_at: row.createdAt } : {}),
            ...(row.updatedAt ? { updated_at: row.updatedAt } : {})
        }));
        if (profiles.length) {
            const { error } = await this.client.from('launcher_profiles').upsert(profiles, { onConflict: 'id' });
            if (error) throw error;
        }
        if (libraries.length) {
            const { error } = await this.client.from('launcher_libraries').upsert(libraries, { onConflict: 'id' });
            if (error) throw error;
        }
        if (presets.length) {
            const { error } = await this.client.from('launcher_presets').upsert(presets, { onConflict: 'id' });
            if (error) throw error;
        }
        this.remoteIdentityAliases = reconciled.aliases;
        return { artifact: remoteArtifact, profiles, libraries, presets };
    }

    async reconcileControlPlaneIdentities(account, artifact) {
        if (!this.remoteIdentityInFlight) this.remoteIdentityInFlight = new Map();
        const accountId = account.user.id;
        if (this.remoteIdentityInFlight.has(accountId)) return this.remoteIdentityInFlight.get(accountId);
        const operation = this.writeControlPlaneIdentities(account, artifact);
        this.remoteIdentityInFlight.set(accountId, operation);
        try {
            return await operation;
        } finally {
            if (this.remoteIdentityInFlight.get(accountId) === operation) {
                this.remoteIdentityInFlight.delete(accountId);
            }
        }
    }

    async ensureControlPlaneIdentity(payload, expected = {}, account = null) {
        const currentAccount = account || await this.state();
        if (!currentAccount.signedIn) throw new Error('Sign in to sync launcher profiles.');
        if (!this.remoteIdentityReady(currentAccount.user.id, expected.profileId, expected.libraryId)) {
            await this.reconcileControlPlaneIdentities(currentAccount, this.controlPlaneArtifact(payload));
        }
        if (!this.remoteIdentityReady(currentAccount.user.id, expected.profileId, expected.libraryId)) {
            throw new Error('The active launcher profile could not be prepared for Sail Cloud.');
        }
        return {
            profileId: this.resolveCloudIdentity('profiles', expected.profileId),
            libraryId: expected.libraryId ? this.resolveCloudIdentity('libraries', expected.libraryId) : null
        };
    }

    async upsertControlPlane(payload = {}) {
        const account = await this.state();
        if (!account.signedIn) throw new Error('Sign in to sync launcher profiles.');
        const reconciled = await this.reconcileControlPlaneIdentities(account, this.controlPlaneArtifact(payload));
        const { artifact, libraries, presets } = reconciled;
        for (const library of libraries) {
            const current = await this.findArtifact(library.profile_id, `library:${library.id}`);
            await this.uploadJsonArtifactIfChanged(account.user.id, {
                profileId: library.profile_id,
                libraryId: library.id,
                artifactType: 'library',
                logicalKey: `library:${library.id}`,
                maxVersions: 1
            }, componentArtifact(artifact, 'library', library.id), current);
        }
        for (const preset of presets) {
            const current = await this.findArtifact(preset.profile_id, `preset:${preset.id}`);
            await this.uploadJsonArtifactIfChanged(account.user.id, {
                profileId: preset.profile_id,
                artifactType: 'preset',
                logicalKey: `preset:${preset.id}`,
                maxVersions: 1
            }, componentArtifact(artifact, 'preset', preset.id), current);
        }
        return this.listRemoteControlPlane();
    }

    async findArtifact(profileId, logicalKey) {
        const remoteProfileId = this.resolveCloudIdentity('profiles', profileId);
        const { data, error } = await this.client
            .from('sync_artifacts')
            .select('id,profile_id,library_id,game_id,config_entry_id,artifact_type,logical_key,revision,content_hash,updated_at')
            .eq('profile_id', remoteProfileId)
            .eq('logical_key', logicalKey)
            .maybeSingle();
        if (error) throw error;
        return data || null;
    }

    async findArtifactById(profileId, artifactId) {
        const remoteProfileId = this.resolveCloudIdentity('profiles', profileId);
        const { data, error } = await this.client
            .from('sync_artifacts')
            .select('id,profile_id,library_id,game_id,config_entry_id,artifact_type,logical_key,revision,content_hash,updated_at')
            .eq('profile_id', remoteProfileId)
            .eq('id', artifactId)
            .maybeSingle();
        if (error) throw error;
        return data || null;
    }

    storageStatus() {
        return this.sailCloud.status();
    }

    async listCloudFiles() {
        const rows = await this.sailCloud.files();
        const types = new Set(['launcher-config', 'game-save', 'game-config', 'library', 'preset']);
        const timestamp = value => {
            const parsed = Date.parse(String(value || ''));
            return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
        };
        return (Array.isArray(rows) ? rows : []).slice(0, 500).map(row => {
            if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
            const id = String(row.id || '');
            const profileId = String(row.profile_id || '');
            const logicalKey = String(row.logical_key || '');
            const artifactType = String(row.artifact_type || '');
            const revision = Number(row.revision);
            const sizeBytes = Number(row.size_bytes);
            const versionCount = Number(row.version_count);
            if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profileId)
                || !types.has(artifactType) || !logicalKey || logicalKey.length > 300
                || /[\u0000-\u001f\u007f<>"'\\]/.test(logicalKey)
                || !Number.isSafeInteger(revision) || revision < 1
                || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0
                || !Number.isSafeInteger(versionCount) || versionCount < 1 || versionCount > 2500) {
                return null;
            }
            return {
                id,
                profile_id: profileId,
                artifact_type: artifactType,
                logical_key: logicalKey,
                revision,
                updated_at: timestamp(row.updated_at),
                size_bytes: sizeBytes,
                version_count: versionCount,
                latest_created_at: timestamp(row.latest_created_at)
            };
        }).filter(Boolean);
    }

    async deleteCloudFile(artifactId) {
        const result = await this.sailCloud.deleteArtifact(artifactId);
        if (this.artifactBytesCache) {
            const marker = `:${artifactId}:`;
            for (const key of this.artifactBytesCache.keys()) {
                if (key.includes(marker)) this.artifactBytesCache.delete(key);
            }
        }
        return result;
    }

    async uploadCloudFile(payload = {}) {
        const account = await this.state();
        if (!account.signedIn) throw new Error('Sign in to use Sail Cloud.');
        const logicalKey = String(payload.logicalKey || '');
        const resolved = path.resolve(payload.filePath || '');
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) throw new Error('The Sail Cloud upload source must be a file.');
        let bytes = fs.readFileSync(resolved);
        if (payload.artifactType === 'launcher-config') {
            bytes = canonicalPortableBytes(bytes, {
                kindHint: 'launcher-snapshot',
                expectedKind: 'launcher-snapshot'
            }).bytes;
        }
        const controlPlane = payload.controlPlane ? this.controlPlaneArtifact(payload.controlPlane) : null;
        if (controlPlane) {
            await this.ensureControlPlaneIdentity(controlPlane, {
                profileId: payload.profileId,
                libraryId: payload.libraryId
            }, account);
        }
        const digest = sha256(bytes);
        const prepareUpload = async () => {
            const route = {
                profileId: this.resolveCloudIdentity('profiles', payload.profileId),
                libraryId: this.resolveCloudIdentity('libraries', payload.libraryId),
                gameId: this.resolveCloudIdentity('games', payload.gameId),
                configEntryId: this.resolveCloudIdentity('configEntries', payload.configEntryId)
            };
            const current = await this.findArtifact(route.profileId, logicalKey);
            if (current && current.content_hash === digest) {
                return {
                    unchanged: {
                        artifact_id: current.id,
                        revision: current.revision,
                        unchanged: true
                    }
                };
            }
            return {
                request: {
                    ...route,
                    artifactType: payload.artifactType,
                    logicalKey,
                    expectedRevision: payload.expectedRevision === undefined
                        ? (current ? current.revision : 0)
                        : payload.expectedRevision,
                    maxVersions: payload.maxVersions,
                    contentType: payload.contentType || 'application/zip'
                }
            };
        };
        let prepared = await prepareUpload();
        if (prepared.unchanged) return prepared.unchanged;
        try {
            return await this.sailCloud.uploadBytes(prepared.request, bytes);
        } catch (error) {
            if (!controlPlane || !isProfileNotFoundError(error)) throw error;
        }

        this.remoteIdentityAliases = emptyRemoteIdentityAliases();
        await this.reconcileControlPlaneIdentities(account, controlPlane);
        prepared = await prepareUpload();
        if (prepared.unchanged) return prepared.unchanged;
        return this.sailCloud.uploadBytes(prepared.request, bytes);
    }

    async listCloudVersions(payload = {}) {
        const profileId = this.resolveCloudIdentity('profiles', payload.profileId);
        const libraryId = this.resolveCloudIdentity('libraries', payload.libraryId);
        const gameId = payload.gameId === 'launcher-portable'
            ? null
            : this.resolveCloudIdentity('games', payload.gameId);
        const artifact = await this.findArtifact(profileId, payload.logicalKey);
        if (!artifact) return [];
        if (payload.expectedArtifactType && artifact.artifact_type !== payload.expectedArtifactType) {
            throw new Error('That Sail Cloud item has the wrong artifact type.');
        }
        if (libraryId && artifact.library_id && artifact.library_id !== libraryId) {
            throw new Error('That Sail Cloud item belongs to another launcher library.');
        }
        if (gameId && artifact.game_id && artifact.game_id !== gameId) {
            throw new Error('That Sail Cloud item belongs to another game.');
        }
        return this.sailCloud.versions(artifact.id);
    }

    async downloadCloudFile(payload = {}) {
        const profileId = this.resolveCloudIdentity('profiles', payload.profileId);
        const libraryId = this.resolveCloudIdentity('libraries', payload.libraryId);
        const gameId = payload.gameId === 'launcher-portable'
            ? null
            : this.resolveCloudIdentity('games', payload.gameId);
        const artifact = payload.artifactId
            ? await this.findArtifactById(profileId, payload.artifactId)
            : await this.findArtifact(profileId, payload.logicalKey);
        if (!artifact) throw new Error('That Sail Cloud item has no uploaded version.');
        if (payload.expectedArtifactType && artifact.artifact_type !== payload.expectedArtifactType) {
            throw new Error('That Sail Cloud item has the wrong artifact type.');
        }
        if (payload.logicalKey && artifact.logical_key !== payload.logicalKey) {
            throw new Error('That Sail Cloud item does not match the requested data type.');
        }
        if (libraryId && artifact.library_id && artifact.library_id !== libraryId) {
            throw new Error('That Sail Cloud item belongs to another launcher library.');
        }
        if (payload.gameId === 'launcher-portable') {
            if (artifact.logical_key !== 'launcher-config:portable') {
                throw new Error('That Sail Cloud item is not a portable launcher configuration.');
            }
        } else if (payload.gameId) {
            const gamePrefix = `game-config:${payload.gameId}:`;
            if (artifact.game_id && artifact.game_id !== gameId
                || artifact.logical_key !== `game-save:${payload.gameId}` && !artifact.logical_key.startsWith(gamePrefix)) {
                throw new Error('That Sail Cloud item belongs to another game.');
            }
        }
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
        if (this.artifactBytesCache) this.artifactBytesCache.clear();
        this.remoteIdentityAliases = emptyRemoteIdentityAliases();
        this.remoteIdentityInFlight = new Map();
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
