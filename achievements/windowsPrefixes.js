'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Proton/Wine games keep saves and emulator achievement files (Goldberg, CODEX...) inside
// the game's own prefix, which Sail made, so it's fine to search it.
const BACKEND_FOLDERS = ['prefixes', 'wine-prefixes'];
const SHARED_USERS = new Set(['public', 'all users', 'default', 'default user']);

function realDirectory(target, fileSystem) {
    try {
        if (fileSystem.lstatSync(target).isSymbolicLink()) return '';
        const real = fileSystem.realpathSync(target);
        return fileSystem.statSync(real).isDirectory() ? real : '';
    } catch (_) { return ''; }
}

// For one Windows drive_c, the Windows-style locations (APPDATA, Documents, ProgramData...) of each real user in it.
function driveEnvironments(driveC, fileSystem = fs) {
    const environments = [];
    const usersRoot = realDirectory(path.join(driveC, 'users'), fileSystem);
    let names = [];
    try { names = usersRoot ? fileSystem.readdirSync(usersRoot) : []; } catch (_) { names = []; }
    for (const name of names.slice(0, 16)) {
        if (SHARED_USERS.has(name.toLowerCase())) continue;
        const profile = realDirectory(path.join(usersRoot, name), fileSystem);
        if (!profile || path.dirname(profile) !== usersRoot) continue;
        environments.push({
            env: {
                APPDATA: path.join(profile, 'AppData', 'Roaming'),
                LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
                USERPROFILE: profile,
                PUBLIC: path.join(usersRoot, 'Public'),
                PROGRAMDATA: path.join(driveC, 'ProgramData')
            },
            documentsPath: path.join(profile, 'Documents')
        });
    }
    return environments;
}

// Returns the folders to approve and, for each Windows user in the environment, the Windows-style locations
// (APPDATA, Documents, ProgramData...) mapped into it.
function windowsPrefixLocations({ protonRoot, key, fileSystem = fs }) {
    const result = { roots: [], environments: [] };
    if (!protonRoot || !/^[0-9a-f]{64}$/.test(String(key || ''))) return result;
    for (const folder of BACKEND_FOLDERS) {
        const driveC = realDirectory(path.join(protonRoot, folder, key, 'drive_c'), fileSystem);
        if (!driveC) continue;
        const environments = driveEnvironments(driveC, fileSystem);
        result.environments.push(...environments);
        if (environments.length) result.roots.push({ kind: 'directory', path: driveC });
    }
    return result;
}

module.exports = { driveEnvironments, realDirectory, windowsPrefixLocations };
