'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A Windows game run through Proton or Wine keeps its saves, and the achievement files that Steam emulators
// (Goldberg, CODEX and others in repacks) write, inside the game's own Windows environment: a private folder
// Sail creates per game. That folder is Sail's own, so it can safely be searched for those files without asking
// for access to anything else on the PC.
const BACKEND_FOLDERS = ['prefixes', 'wine-prefixes'];
const SHARED_USERS = new Set(['public', 'all users', 'default', 'default user']);

function realDirectory(target, fileSystem) {
    try {
        if (fileSystem.lstatSync(target).isSymbolicLink()) return '';
        const real = fileSystem.realpathSync(target);
        return fileSystem.statSync(real).isDirectory() ? real : '';
    } catch (_) { return ''; }
}

// Returns the folders to approve and, for each Windows user in the environment, the Windows-style locations
// (APPDATA, Documents, ProgramData...) mapped into it.
function windowsPrefixLocations({ protonRoot, key, fileSystem = fs }) {
    const result = { roots: [], environments: [] };
    if (!protonRoot || !/^[0-9a-f]{64}$/.test(String(key || ''))) return result;
    for (const folder of BACKEND_FOLDERS) {
        const driveC = realDirectory(path.join(protonRoot, folder, key, 'drive_c'), fileSystem);
        if (!driveC) continue;
        const usersRoot = realDirectory(path.join(driveC, 'users'), fileSystem);
        let names = [];
        try { names = usersRoot ? fileSystem.readdirSync(usersRoot) : []; } catch (_) { names = []; }
        let used = false;
        for (const name of names.slice(0, 16)) {
            if (SHARED_USERS.has(name.toLowerCase())) continue;
            const profile = realDirectory(path.join(usersRoot, name), fileSystem);
            if (!profile || path.dirname(profile) !== usersRoot) continue;
            used = true;
            result.environments.push({
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
        if (used) result.roots.push({ kind: 'directory', path: driveC });
    }
    return result;
}

module.exports = { windowsPrefixLocations };
