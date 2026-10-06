'use strict';

// Electron's safeStorage on Linux can silently fall back to a hard-coded key
// ("basic_text"), which protects nothing. Credentials are only stored when a real
// system keyring (KDE Wallet, GNOME Keyring or another libsecret service) backs it.
const WEAK_BACKENDS = new Set(['basic_text', 'unknown']);
const KEYRING_HELP = 'Sail needs a system keyring (KDE Wallet or GNOME Keyring) to store logins and tokens safely. Start or unlock your keyring and restart Sail.';

function assessProtectedStorage(safeStorage, platform = process.platform) {
    try {
        if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
            return { available: false, backend: '', reason: platform === 'linux' ? KEYRING_HELP : 'Secure credential storage is unavailable on this device.' };
        }
        if (platform === 'linux') {
            const backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? String(safeStorage.getSelectedStorageBackend()) : '';
            if (!backend || WEAK_BACKENDS.has(backend)) return { available: false, backend, reason: KEYRING_HELP };
            return { available: true, backend, reason: '' };
        }
        return { available: true, backend: '', reason: '' };
    } catch (_) {
        return { available: false, backend: '', reason: KEYRING_HELP };
    }
}

// Same interface as Electron's safeStorage, but reports "unavailable" whenever the
// backend is weak, so every existing "is encryption available" check fails closed.
function protectStorage(safeStorage, platform = process.platform) {
    return {
        isEncryptionAvailable: () => assessProtectedStorage(safeStorage, platform).available,
        encryptString: value => safeStorage.encryptString(value),
        decryptString: value => safeStorage.decryptString(value)
    };
}

module.exports = { assessProtectedStorage, protectStorage, KEYRING_HELP };
