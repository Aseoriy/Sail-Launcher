'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { driveEnvironments, realDirectory, windowsPrefixLocations } = require('../achievements/windowsPrefixes');

const STEAM_APP_ID = /^[1-9]\d{0,9}$/;

// A Windows game on Linux writes its saves inside a Windows environment: the private prefix Sail made for it,
// or Steam's compatdata prefix when Steam's Proton ran it. These are only places to look; the save folder a
// game uses is still approved by the person in the folder picker.
function windowsSaveEnvironments({ protonRoot = '', scope = null, steamAppId = '', steamLibraries = [], fileSystem = fs } = {}) {
    const environments = [];
    const add = (label, list) => {
        for (const item of list) {
            const profile = item.env.USERPROFILE;
            environments.push({
                label,
                env: { ...item.env, USERNAME: path.basename(profile) },
                homePath: profile,
                documentsPath: item.documentsPath,
                savedGamesPath: path.join(profile, 'Saved Games')
            });
        }
    };
    if (protonRoot && scope) {
        const { scopeKey } = require('./proton/manager');
        add('Proton prefix', windowsPrefixLocations({ protonRoot, key: scopeKey(scope), fileSystem }).environments);
    }
    if (STEAM_APP_ID.test(String(steamAppId || ''))) {
        for (const library of steamLibraries.slice(0, 32)) {
            const driveC = realDirectory(path.join(library, 'steamapps', 'compatdata', String(steamAppId), 'pfx', 'drive_c'), fileSystem);
            if (driveC) add('Steam Proton prefix', driveEnvironments(driveC, fileSystem));
        }
    }
    return environments;
}

// The folders Windows games commonly keep saves in, mapped into one environment.
function windowsCommonSaveRoots(environment) {
    const { APPDATA, LOCALAPPDATA } = environment.env;
    return [
        environment.savedGamesPath,
        path.join(environment.documentsPath, 'My Games'),
        environment.documentsPath,
        APPDATA,
        LOCALAPPDATA,
        path.join(path.dirname(LOCALAPPDATA), 'LocalLow')
    ];
}

function xdgFolders({ env = process.env, home = os.homedir() } = {}) {
    const absolute = value => typeof value === 'string' && path.isAbsolute(value) ? value : '';
    return {
        data: absolute(env.XDG_DATA_HOME) || path.join(home, '.local', 'share'),
        config: absolute(env.XDG_CONFIG_HOME) || path.join(home, '.config')
    };
}

// Native Linux games keep saves under the XDG data and config folders.
function nativeCommonSaveRoots(options = {}) {
    const xdg = xdgFolders(options);
    return [xdg.data, xdg.config];
}

module.exports = { nativeCommonSaveRoots, windowsCommonSaveRoots, windowsSaveEnvironments, xdgFolders };
