'use strict';
const fs = require('node:fs');
const path = require('node:path');
const native = require('../native/protocol');
const { fileIdentity } = require('../../security/capabilityStore');

function validateProtonInstallation(selected, options = {}) {
    const root = fs.realpathSync(selected);
    native.assertFixturePath(root, options.fixtureRoot);
    const rootIdentity = fileIdentity(root, 'directory');
    const protonIdentity = native.validateNativeExecutable(path.join(root, 'proton'), { ...options, allowScripts: true });
    if (protonIdentity.realPath !== path.join(root, 'proton')) throw Error('Choose the Proton installation containing its own executable.');
    // Steam-distributed Proton has toolmanifest.vdf; custom compatibility tools
    // additionally provide compatibilitytool.vdf. It is not required by UMU.
    for (const name of ['toolmanifest.vdf', 'compatibilitytool.vdf']) {
        let fd;
        try { fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
        catch (error) { if (name === 'compatibilitytool.vdf' && error.code === 'ENOENT') continue; throw error; }
        try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 64 * 1024) throw Error('Invalid Proton installation manifest.'); }
        finally { fs.closeSync(fd); }
    }
    return { root, rootIdentity, protonIdentity };
}
module.exports = { validateProtonInstallation };
