'use strict';

const path = require('node:path');
const { nativeError } = require('../native/protocol');

function validateDllOverrides(value = '') {
    if (typeof value !== 'string' || value.length > 2048
        || value && !/^[A-Za-z0-9_.*-]+(?:,[A-Za-z0-9_.*-]+)*=(?:[nb](?:,[nb])?)?(?:;[A-Za-z0-9_.*-]+(?:,[A-Za-z0-9_.*-]+)*=(?:[nb](?:,[nb])?)?)*$/.test(value)) {
        throw nativeError('SAIL_PROTON_DLL_OVERRIDES', 'Use Wine DLL overrides such as xinput1_4=n,b; separate entries with semicolons.');
    }
    return value;
}

// Main owns these fields. No shell expansion, renderer-supplied variables, or
// general purpose environment forwarding is available through this boundary.
function validateUmuEnvironment(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['activity', 'prefix', 'proton', 'dllOverrides'].includes(key))
        || !['preparation', 'game', 'installation'].includes(value.activity)) {
        throw nativeError('SAIL_PROTON_ENVIRONMENT', 'Invalid UMU environment binding.');
    }
    for (const key of ['prefix', 'proton']) {
        if (typeof value[key] !== 'string' || !path.isAbsolute(value[key]) || path.resolve(value[key]) !== value[key]
            || /[\u0000-\u001f\u007f]/.test(value[key]) || Buffer.byteLength(value[key]) > 4096) {
            throw nativeError('SAIL_PROTON_ENVIRONMENT', 'UMU requires canonical private prefix and installed runtime paths.');
        }
    }
    return { activity: value.activity, prefix: value.prefix, proton: value.proton,
        ...(value.dllOverrides === undefined ? {} : { dllOverrides: validateDllOverrides(value.dllOverrides) }) };
}

function umuEnvironmentVariables(value) {
    if (value?.backend === 'wine') {
        const binding = validateWineEnvironment(value);
        return { WINEPREFIX: binding.prefix, WINELOADER: binding.loader, WINESERVER: binding.server, WINEARCH: 'win64',
            WINEDLLOVERRIDES: ['winemenubuilder.exe=d', binding.dllOverrides || ''].filter(Boolean).join(';') };
    }
    const binding = validateUmuEnvironment(value);
    if (!binding) return {};
    return { WINEPREFIX: binding.prefix, PROTONPATH: binding.proton, GAMEID: 'umu-default', STORE: 'none',
        PROTON_VERB: 'waitforexitandrun', UMU_RUNTIME_UPDATE: binding.activity === 'game' ? '0' : '1',
        ...(binding.dllOverrides ? { WINEDLLOVERRIDES: binding.dllOverrides } : {}) };
}

function validateWineEnvironment(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['backend', 'activity', 'prefix', 'root', 'loader', 'server', 'dllOverrides'].includes(key))
        || value.backend !== undefined && value.backend !== 'wine' || !['game', 'installation'].includes(value.activity)) throw nativeError('SAIL_WINE_ENVIRONMENT', 'Invalid Wine environment binding.');
    for (const key of ['prefix', 'root', 'loader', 'server']) {
        if (typeof value[key] !== 'string' || !path.isAbsolute(value[key]) || path.resolve(value[key]) !== value[key]
            || /[\u0000-\u001f\u007f]/.test(value[key]) || Buffer.byteLength(value[key]) > 4096) throw nativeError('SAIL_WINE_ENVIRONMENT', 'Wine requires canonical private prefix and installed runtime paths.');
    }
    if (!require('../native/protocol').withinRoot(value.loader, value.root) || !require('../native/protocol').withinRoot(value.server, value.root)) throw nativeError('SAIL_WINE_ENVIRONMENT', 'Wine loaders and server must belong to this installed version.');
    return { backend: 'wine', activity: value.activity, prefix: value.prefix, root: value.root, loader: value.loader, server: value.server,
        ...(value.dllOverrides === undefined ? {} : { dllOverrides: validateDllOverrides(value.dllOverrides) }) };
}
function launchEnvironment(details) {
    if (details.umuEnvironment !== undefined && details.wineEnvironment !== undefined) throw nativeError('SAIL_WINE_ENVIRONMENT', 'Choose one compatibility environment.');
    return details.wineEnvironment === undefined ? validateUmuEnvironment(details.umuEnvironment) : validateWineEnvironment(details.wineEnvironment);
}

module.exports = { validateDllOverrides, validateUmuEnvironment, validateWineEnvironment, launchEnvironment, umuEnvironmentVariables };
