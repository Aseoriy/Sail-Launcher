'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function samePath(left, right) {
    return path.resolve(String(left || '')).toLocaleLowerCase('en-US')
        === path.resolve(String(right || '')).toLocaleLowerCase('en-US');
}

function strictChildPath(parentPath, candidatePath) {
    const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertOwnedInstallRoot(rootPath, options = {}) {
    const fsImpl = options.fs || fs;
    if (!path.isAbsolute(String(rootPath || ''))) throw new Error('The approved game install folder is invalid.');
    const requested = path.resolve(rootPath);
    const volumeRoot = path.parse(requested).root;
    if (samePath(requested, volumeRoot)) throw new Error('Sail will not uninstall a drive root.');
    for (const protectedRoot of options.protectedRoots || []) {
        if (protectedRoot && samePath(requested, protectedRoot)) {
            throw new Error('Sail will not uninstall a protected launcher folder.');
        }
    }
    const stats = fsImpl.lstatSync(requested);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('The approved game install folder changed and can no longer be uninstalled safely.');
    }
    const resolver = fsImpl.realpathSync.native || fsImpl.realpathSync;
    const realPath = path.resolve(resolver.call(fsImpl.realpathSync, requested));
    if (!samePath(requested, realPath)) {
        throw new Error('The approved game install folder now resolves through a link.');
    }
    return requested;
}

const WINDOWS_LOCK_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function installFolderInUseError(error) {
    const wrapped = new Error(
        'Windows is still using this game folder. Close the game, its installer or crash reporter, '
        + 'and any terminal or File Explorer window opened inside the game folder, then try again.'
    );
    wrapped.code = 'SAIL_GAME_FOLDER_IN_USE';
    wrapped.cause = error;
    return wrapped;
}

async function removeOwnedInstallDirectory(rootPath, options = {}) {
    const fsImpl = options.fs || fs;
    const requested = assertOwnedInstallRoot(rootPath, options);
    const parent = path.dirname(requested);
    const quarantineName = `.sail-uninstall-${path.basename(requested).slice(0, 80)}-${
        (options.idFactory || (() => crypto.randomUUID()))()
    }`;
    const quarantine = path.join(parent, quarantineName);
    if (!strictChildPath(parent, quarantine) || fsImpl.existsSync(quarantine)) {
        throw new Error('Sail could not prepare a safe uninstall location.');
    }

    const rename = options.rename || ((source, destination) => fsImpl.promises.rename(source, destination));
    const remove = options.remove || (target => fsImpl.promises.rm(target, {
        recursive: true,
        force: false,
        maxRetries: 5,
        retryDelay: 200
    }));
    const retryDelaysMs = Array.isArray(options.retryDelaysMs)
        ? options.retryDelaysMs.filter(value => Number.isInteger(value) && value >= 0).slice(0, 10)
        : [80, 180, 350, 700, 1200];
    const sleep = options.wait || wait;
    let renameError = null;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
        try {
            assertOwnedInstallRoot(requested, options);
            await rename(requested, quarantine);
            renameError = null;
            break;
        } catch (error) {
            renameError = error;
            if (!WINDOWS_LOCK_CODES.has(String(error && error.code || '')) || attempt >= retryDelaysMs.length) break;
            await sleep(retryDelaysMs[attempt]);
        }
    }
    if (renameError) {
        if (WINDOWS_LOCK_CODES.has(String(renameError.code || ''))) throw installFolderInUseError(renameError);
        const wrapped = new Error('Sail could not prepare this game folder for a safe uninstall. Try again.');
        wrapped.cause = renameError;
        throw wrapped;
    }

    try {
        const moved = fsImpl.lstatSync(quarantine);
        if (!moved.isDirectory() || moved.isSymbolicLink()) {
            throw new Error('The game folder changed while uninstalling.');
        }
        await remove(quarantine);
        if (fsImpl.existsSync(quarantine)) throw new Error('Some game files could not be removed.');
        return { removed: true, originalPath: requested };
    } catch (error) {
        try {
            if (fsImpl.existsSync(quarantine) && !fsImpl.existsSync(requested)) await rename(quarantine, requested);
        } catch (_) {}
        const wrapped = new Error('Sail could not remove every game file. Close the game and any open files, then try again.');
        wrapped.cause = error;
        throw wrapped;
    }
}

module.exports = {
    assertOwnedInstallRoot,
    removeOwnedInstallDirectory,
    samePath,
    strictChildPath
};
