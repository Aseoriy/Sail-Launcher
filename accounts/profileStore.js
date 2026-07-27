const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { portableSnapshot } = require('../sync/syncV2');

const PROFILE_SCHEMA_VERSION = 2;

function makeId() {
    return crypto.randomUUID();
}

function cleanName(value, fallback) {
    const text = String(value || '').trim().replace(/[\u0000-\u001f]/g, '').slice(0, 80);
    return text || fallback;
}

function defaultSettingsSnapshot(snapshot = {}) {
    return {
        globalSettings: snapshot.globalSettings && typeof snapshot.globalSettings === 'object'
            ? snapshot.globalSettings
            : {}
    };
}

function defaultLibrarySnapshot(snapshot = {}) {
    return {
        myGames: Array.isArray(snapshot.myGames) ? snapshot.myGames : [],
        customSections: Array.isArray(snapshot.customSections) ? snapshot.customSections : []
    };
}

function mergePortableGames(localGames, remoteGames) {
    const localById = new Map((Array.isArray(localGames) ? localGames : []).map(game => [game.id, game]));
    const deviceKeys = [
        'exePath', 'installFolder', 'localSave', 'driveSave', 'playDetectionPath',
        'companionApp', 'preLaunchScript', 'postLaunchScript', 'shortcutIcon'
    ];
    return (Array.isArray(remoteGames) ? remoteGames : []).map(remote => {
        const local = localById.get(remote.id);
        if (!local) return remote;
        const merged = { ...remote };
        for (const key of deviceKeys) {
            if (Object.prototype.hasOwnProperty.call(local, key)) merged[key] = local[key];
        }
        if (Array.isArray(remote.configSyncEntries) && Array.isArray(local.configSyncEntries)) {
            const localEntries = new Map(local.configSyncEntries.map(entry => [entry.id, entry]));
            merged.configSyncEntries = remote.configSyncEntries.map(entry => ({
                ...entry,
                localPath: localEntries.get(entry.id) && localEntries.get(entry.id).localPath || ''
            }));
        }
        return merged;
    });
}

function hashPin(pin, salt = crypto.randomBytes(16)) {
    const derived = crypto.scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1 });
    return { salt: salt.toString('base64'), verifier: derived.toString('base64') };
}

function verifyPin(pin, record) {
    if (!record || !record.pinVerifier || !record.pinSalt) return true;
    const actual = hashPin(pin, Buffer.from(record.pinSalt, 'base64')).verifier;
    const left = Buffer.from(actual, 'base64');
    const right = Buffer.from(record.pinVerifier, 'base64');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class ProfileStore {
    constructor(userDataPath) {
        this.userDataPath = userDataPath;
        this.root = path.join(userDataPath, 'SailProfiles');
        this.statePath = path.join(this.root, 'state.json');
        this.state = null;
        this.pinFailures = new Map();
    }

    atomicWrite(destination, value) {
        fs.ensureDirSync(path.dirname(destination));
        const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
        fs.writeJsonSync(temp, value, { spaces: 2 });
        fs.moveSync(temp, destination, { overwrite: true });
    }

    libraryPath(profileId, libraryId) {
        return path.join(this.root, 'profiles', profileId, 'libraries', `${libraryId}.json`);
    }

    presetPath(profileId, presetId) {
        return path.join(this.root, 'profiles', profileId, 'presets', `${presetId}.json`);
    }

    profilePath(profileId) {
        return path.join(this.root, 'profiles', profileId);
    }

    initialize(legacySnapshot = {}) {
        if (this.state) return this.getState();
        if (fs.existsSync(this.statePath)) {
            try {
                const loaded = fs.readJsonSync(this.statePath);
                if (loaded && loaded.schemaVersion === PROFILE_SCHEMA_VERSION && Array.isArray(loaded.profiles)) {
                    this.state = loaded;
                    return this.getState();
                }
            } catch (_) {}
        }

        const legacyPath = path.join(this.userDataPath, 'sail_library.json');
        if (fs.existsSync(legacyPath)) {
            const backupPath = path.join(this.root, 'migration-backups', `sail_library-${Date.now()}.json`);
            fs.ensureDirSync(path.dirname(backupPath));
            fs.copyFileSync(legacyPath, backupPath);
        }

        const profileId = makeId();
        const libraryId = makeId();
        const presetId = makeId();
        this.state = {
            schemaVersion: PROFILE_SCHEMA_VERSION,
            deviceId: makeId(),
            activeProfileId: profileId,
            activeLibraryId: libraryId,
            activePresetId: presetId,
            profiles: [{
                id: profileId,
                name: 'Default Profile',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                pinSalt: null,
                pinVerifier: null,
                localAvatarPath: null,
                conflictMode: 'prompt',
                libraries: [{ id: libraryId, name: 'Main Library', createdAt: new Date().toISOString() }],
                presets: [{ id: presetId, name: 'Default Settings', createdAt: new Date().toISOString() }]
            }]
        };
        this.atomicWrite(this.libraryPath(profileId, libraryId), defaultLibrarySnapshot(legacySnapshot));
        this.atomicWrite(this.presetPath(profileId, presetId), defaultSettingsSnapshot(legacySnapshot));
        this.saveState();
        return this.getState();
    }

    saveState() {
        this.atomicWrite(this.statePath, this.state);
    }

    activeProfile() {
        return this.state.profiles.find(profile => profile.id === this.state.activeProfileId) || null;
    }

    getState() {
        if (!this.state) return null;
        return {
            schemaVersion: this.state.schemaVersion,
            deviceId: this.state.deviceId,
            activeProfileId: this.state.activeProfileId,
            activeLibraryId: this.state.activeLibraryId,
            activePresetId: this.state.activePresetId,
            profiles: this.state.profiles.map(profile => ({
                id: profile.id,
                name: profile.name,
                createdAt: profile.createdAt,
                updatedAt: profile.updatedAt,
                locked: !!profile.pinVerifier,
                localAvatarPath: profile.localAvatarPath && fs.existsSync(profile.localAvatarPath)
                    ? profile.localAvatarPath
                    : null,
                conflictMode: profile.conflictMode || 'prompt',
                libraries: profile.libraries.map(item => ({ ...item })),
                presets: profile.presets.map(item => ({ ...item }))
            }))
        };
    }

    loadActiveSnapshot() {
        const profile = this.activeProfile();
        if (!profile) throw new Error('Active launcher profile is missing.');
        const library = fs.existsSync(this.libraryPath(profile.id, this.state.activeLibraryId))
            ? fs.readJsonSync(this.libraryPath(profile.id, this.state.activeLibraryId))
            : defaultLibrarySnapshot();
        const preset = fs.existsSync(this.presetPath(profile.id, this.state.activePresetId))
            ? fs.readJsonSync(this.presetPath(profile.id, this.state.activePresetId))
            : defaultSettingsSnapshot();
        return {
            myGames: Array.isArray(library.myGames) ? library.myGames : [],
            customSections: Array.isArray(library.customSections) ? library.customSections : [],
            globalSettings: preset.globalSettings && typeof preset.globalSettings === 'object'
                ? preset.globalSettings
                : {}
        };
    }

    captureActiveSnapshot(snapshot = {}) {
        const profile = this.activeProfile();
        if (!profile) return false;
        this.atomicWrite(
            this.libraryPath(profile.id, this.state.activeLibraryId),
            defaultLibrarySnapshot(snapshot)
        );
        this.atomicWrite(
            this.presetPath(profile.id, this.state.activePresetId),
            defaultSettingsSnapshot(snapshot)
        );
        profile.updatedAt = new Date().toISOString();
        this.saveState();
        return true;
    }

    exportControlPlane() {
        const profiles = [];
        const libraries = [];
        const presets = [];
        for (const profile of this.state.profiles) {
            profiles.push({
                id: profile.id,
                name: profile.name,
                pin_salt: profile.pinSalt,
                pin_verifier: profile.pinVerifier,
                conflict_mode: profile.conflictMode || 'prompt',
                created_at: profile.createdAt,
                updated_at: profile.updatedAt
            });
            for (const library of profile.libraries) {
                const snapshotPath = this.libraryPath(profile.id, library.id);
                const snapshot = fs.existsSync(snapshotPath)
                    ? fs.readJsonSync(snapshotPath)
                    : defaultLibrarySnapshot();
                const portable = portableSnapshot(snapshot);
                libraries.push({
                    id: library.id,
                    profile_id: profile.id,
                    name: library.name,
                    catalog: {
                        games: portable.myGames,
                        sections: portable.customSections
                    },
                    created_at: library.createdAt,
                    updated_at: profile.updatedAt
                });
            }
            for (const preset of profile.presets) {
                const snapshotPath = this.presetPath(profile.id, preset.id);
                const snapshot = fs.existsSync(snapshotPath)
                    ? fs.readJsonSync(snapshotPath)
                    : defaultSettingsSnapshot();
                const portable = portableSnapshot(snapshot);
                presets.push({
                    id: preset.id,
                    profile_id: profile.id,
                    name: preset.name,
                    settings: portable.globalSettings,
                    created_at: preset.createdAt,
                    updated_at: profile.updatedAt
                });
            }
        }
        return { profiles, libraries, presets };
    }

    mergeControlPlane(remote = {}) {
        const remoteProfiles = Array.isArray(remote.profiles) ? remote.profiles : [];
        const remoteLibraries = Array.isArray(remote.libraries) ? remote.libraries : [];
        const remotePresets = Array.isArray(remote.presets) ? remote.presets : [];

        for (const row of remoteProfiles) {
            let profile = this.state.profiles.find(item =>
                item.id === row.id || String(item.name).toLowerCase() === String(row.name).toLowerCase()
            );
            const remoteUpdated = Date.parse(row.updated_at || row.created_at || 0) || 0;
            const localUpdated = profile ? Date.parse(profile.updatedAt || 0) || 0 : 0;
            const shouldApplyRemote = !profile || profile.conflictMode !== 'local' && remoteUpdated >= localUpdated;
            if (!profile) {
                profile = {
                    id: row.id,
                    name: cleanName(row.name, 'Imported Profile'),
                    createdAt: row.created_at || new Date().toISOString(),
                    updatedAt: row.updated_at || new Date().toISOString(),
                    pinSalt: row.pin_salt || null,
                    pinVerifier: row.pin_verifier || null,
                    localAvatarPath: null,
                    conflictMode: ['prompt', 'newest', 'local'].includes(row.conflict_mode) ? row.conflict_mode : 'prompt',
                    libraries: [],
                    presets: []
                };
                this.state.profiles.push(profile);
            } else if (shouldApplyRemote) {
                profile.name = cleanName(row.name, profile.name);
                profile.updatedAt = row.updated_at || profile.updatedAt;
                profile.pinSalt = row.pin_salt || null;
                profile.pinVerifier = row.pin_verifier || null;
                profile.conflictMode = ['prompt', 'newest', 'local'].includes(row.conflict_mode)
                    ? row.conflict_mode
                    : profile.conflictMode;
            }

            for (const libraryRow of remoteLibraries.filter(item => item.profile_id === row.id)) {
                let library = profile.libraries.find(item => item.id === libraryRow.id);
                if (!library) {
                    library = {
                        id: libraryRow.id,
                        name: cleanName(libraryRow.name, 'Imported Library'),
                        createdAt: libraryRow.created_at || new Date().toISOString()
                    };
                    profile.libraries.push(library);
                } else if (shouldApplyRemote) {
                    library.name = cleanName(libraryRow.name, library.name);
                }
                if (shouldApplyRemote && libraryRow.catalog && typeof libraryRow.catalog === 'object') {
                    const existingPath = this.libraryPath(profile.id, library.id);
                    const existing = fs.existsSync(existingPath)
                        ? fs.readJsonSync(existingPath)
                        : defaultLibrarySnapshot();
                    this.atomicWrite(this.libraryPath(profile.id, library.id), {
                        myGames: mergePortableGames(existing.myGames, libraryRow.catalog.games),
                        customSections: Array.isArray(libraryRow.catalog.sections) ? libraryRow.catalog.sections : []
                    });
                }
            }

            for (const presetRow of remotePresets.filter(item => item.profile_id === row.id)) {
                let preset = profile.presets.find(item => item.id === presetRow.id);
                if (!preset) {
                    preset = {
                        id: presetRow.id,
                        name: cleanName(presetRow.name, 'Imported Settings'),
                        createdAt: presetRow.created_at || new Date().toISOString()
                    };
                    profile.presets.push(preset);
                } else if (shouldApplyRemote) {
                    preset.name = cleanName(presetRow.name, preset.name);
                }
                if (shouldApplyRemote) {
                    this.atomicWrite(this.presetPath(profile.id, preset.id), {
                        globalSettings: presetRow.settings && typeof presetRow.settings === 'object'
                            ? presetRow.settings
                            : {}
                    });
                }
            }

            if (!profile.libraries.length) {
                const library = { id: makeId(), name: 'Main Library', createdAt: new Date().toISOString() };
                profile.libraries.push(library);
                this.atomicWrite(this.libraryPath(profile.id, library.id), defaultLibrarySnapshot());
            }
            if (!profile.presets.length) {
                const preset = { id: makeId(), name: 'Default Settings', createdAt: new Date().toISOString() };
                profile.presets.push(preset);
                this.atomicWrite(this.presetPath(profile.id, preset.id), defaultSettingsSnapshot());
            }
        }

        this.saveState();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot() };
    }

    createProfile(name, pin = '', snapshot = {}) {
        const profileId = makeId();
        const libraryId = makeId();
        const presetId = makeId();
        const now = new Date().toISOString();
        const pinData = pin ? hashPin(pin) : null;
        const profile = {
            id: profileId,
            name: cleanName(name, `Profile ${this.state.profiles.length + 1}`),
            createdAt: now,
            updatedAt: now,
            pinSalt: pinData ? pinData.salt : null,
            pinVerifier: pinData ? pinData.verifier : null,
            localAvatarPath: null,
            conflictMode: 'prompt',
            libraries: [{ id: libraryId, name: 'Main Library', createdAt: now }],
            presets: [{ id: presetId, name: 'Default Settings', createdAt: now }]
        };
        this.state.profiles.push(profile);
        this.atomicWrite(this.libraryPath(profileId, libraryId), defaultLibrarySnapshot(snapshot));
        this.atomicWrite(this.presetPath(profileId, presetId), defaultSettingsSnapshot(snapshot));
        this.saveState();
        return this.getState();
    }

    setProfileAvatar(profileId, sourcePath) {
        const profile = this.state.profiles.find(item => item.id === profileId);
        if (!profile) throw new Error('Launcher profile was not found.');
        const source = path.resolve(String(sourcePath || ''));
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
            throw new Error('Choose an existing avatar image.');
        }
        const ext = path.extname(source).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
            throw new Error('Local avatars must be PNG, JPEG, or WebP images.');
        }
        if (fs.statSync(source).size > 2 * 1024 * 1024) {
            throw new Error('Local avatars must be 2 MB or smaller.');
        }

        const normalizedExt = ext === '.jpeg' ? '.jpg' : ext;
        const destination = path.join(this.profilePath(profile.id), `avatar${normalizedExt}`);
        fs.ensureDirSync(path.dirname(destination));
        if (path.normalize(source) !== path.normalize(destination)) {
            fs.copyFileSync(source, destination);
        }
        if (profile.localAvatarPath && path.normalize(profile.localAvatarPath) !== path.normalize(destination)) {
            fs.removeSync(profile.localAvatarPath);
        }
        profile.localAvatarPath = destination;
        profile.updatedAt = new Date().toISOString();
        this.saveState();
        return this.getState();
    }

    clearProfileAvatar(profileId) {
        const profile = this.state.profiles.find(item => item.id === profileId);
        if (!profile) throw new Error('Launcher profile was not found.');
        if (profile.localAvatarPath) fs.removeSync(profile.localAvatarPath);
        profile.localAvatarPath = null;
        profile.updatedAt = new Date().toISOString();
        this.saveState();
        return this.getState();
    }

    deleteProfile(profileId, pin = '') {
        if (this.state.profiles.length <= 1) {
            throw new Error('Create another launcher profile before deleting the last one.');
        }
        const index = this.state.profiles.findIndex(item => item.id === profileId);
        if (index < 0) throw new Error('Launcher profile was not found.');
        const profile = this.state.profiles[index];
        if (profile.pinVerifier) {
            const unlock = this.unlockProfile(profileId, pin);
            if (!unlock.success) {
                const seconds = Math.ceil((unlock.retryAfterMs || 0) / 1000);
                throw new Error(seconds
                    ? `Incorrect PIN. Try again in ${seconds} seconds.`
                    : 'Enter the correct profile PIN before deleting it.');
            }
        }

        this.state.profiles.splice(index, 1);
        this.pinFailures.delete(profileId);
        fs.removeSync(this.profilePath(profileId));
        if (this.state.activeProfileId === profileId) {
            const next = this.state.profiles[Math.min(index, this.state.profiles.length - 1)];
            this.state.activeProfileId = next.id;
            this.state.activeLibraryId = next.libraries[0].id;
            this.state.activePresetId = next.presets[0].id;
        }
        this.saveState();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot(), deletedProfile: { id: profile.id, name: profile.name } };
    }

    updateProfile(profileId, patch = {}) {
        const profile = this.state.profiles.find(item => item.id === profileId);
        if (!profile) throw new Error('Launcher profile was not found.');
        if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
            profile.name = cleanName(patch.name, profile.name);
        }
        if (['prompt', 'newest', 'local'].includes(patch.conflictMode)) {
            profile.conflictMode = patch.conflictMode;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'pin')) {
            const pinData = patch.pin ? hashPin(patch.pin) : null;
            profile.pinSalt = pinData ? pinData.salt : null;
            profile.pinVerifier = pinData ? pinData.verifier : null;
        }
        profile.updatedAt = new Date().toISOString();
        this.saveState();
        return this.getState();
    }

    unlockProfile(profileId, pin) {
        const profile = this.state.profiles.find(item => item.id === profileId);
        if (!profile) throw new Error('Launcher profile was not found.');
        const failure = this.pinFailures.get(profileId);
        if (failure && failure.retryAt > Date.now()) {
            return { success: false, retryAfterMs: failure.retryAt - Date.now() };
        }
        if (verifyPin(pin, profile)) {
            this.pinFailures.delete(profileId);
            return { success: true };
        }
        const attempts = (failure ? failure.attempts : 0) + 1;
        const retryAt = attempts >= 5 ? Date.now() + Math.min(300000, 1000 * (2 ** (attempts - 5))) : 0;
        this.pinFailures.set(profileId, { attempts, retryAt });
        return { success: false, retryAfterMs: Math.max(0, retryAt - Date.now()) };
    }

    switchProfile(profileId) {
        const profile = this.state.profiles.find(item => item.id === profileId);
        if (!profile) throw new Error('Launcher profile was not found.');
        this.state.activeProfileId = profile.id;
        this.state.activeLibraryId = profile.libraries[0].id;
        this.state.activePresetId = profile.presets[0].id;
        this.saveState();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot() };
    }

    createLibrary(name, snapshot = {}) {
        const profile = this.activeProfile();
        const library = { id: makeId(), name: cleanName(name, 'New Library'), createdAt: new Date().toISOString() };
        profile.libraries.push(library);
        this.atomicWrite(this.libraryPath(profile.id, library.id), defaultLibrarySnapshot(snapshot));
        profile.updatedAt = new Date().toISOString();
        this.saveState();
        return this.getState();
    }

    switchLibrary(libraryId) {
        const profile = this.activeProfile();
        if (!profile.libraries.some(item => item.id === libraryId)) throw new Error('Library was not found.');
        this.state.activeLibraryId = libraryId;
        this.saveState();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot() };
    }

    createPreset(name, snapshot = {}) {
        const profile = this.activeProfile();
        const preset = { id: makeId(), name: cleanName(name, 'New Settings'), createdAt: new Date().toISOString() };
        profile.presets.push(preset);
        this.atomicWrite(this.presetPath(profile.id, preset.id), defaultSettingsSnapshot(snapshot));
        profile.updatedAt = new Date().toISOString();
        this.saveState();
        return this.getState();
    }

    switchPreset(presetId) {
        const profile = this.activeProfile();
        if (!profile.presets.some(item => item.id === presetId)) throw new Error('Settings preset was not found.');
        this.state.activePresetId = presetId;
        this.saveState();
        return { state: this.getState(), snapshot: this.loadActiveSnapshot() };
    }
}

module.exports = {
    PROFILE_SCHEMA_VERSION,
    ProfileStore,
    hashPin,
    verifyPin
};
