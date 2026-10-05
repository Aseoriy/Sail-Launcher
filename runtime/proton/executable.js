'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileIdentity, identityMatches } = require('../../security/capabilityStore');
const native = require('../native/protocol');

function validateWindowsExecutable(selected, { expected = null, fixtureRoot = null } = {}) {
    const canonical = fs.realpathSync(selected);
    native.assertFixturePath(canonical, fixtureRoot);
    const identity = fileIdentity(canonical, 'file');
    if (expected && (!identityMatches(expected, identity) || path.resolve(selected) !== canonical)) {
        throw native.nativeError('SAIL_CAPABILITY_PATH_CHANGED', 'The approved Windows executable changed. Choose it again.');
    }
    fs.accessSync(canonical, fs.constants.R_OK);
    const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const dos = Buffer.alloc(64), pe = Buffer.alloc(26);
        if (fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') {
            throw native.nativeError('SAIL_PROTON_FORMAT', 'Choose a Windows game executable in PE format.');
        }
        const offset = dos.readUInt32LE(60);
        if (offset < 64 || offset > 16 * 1024 * 1024 || fs.readSync(fd, pe, 0, pe.length, offset) !== pe.length
            || pe.readUInt32LE(0) !== 0x4550 || ![0x14c, 0x8664].includes(pe.readUInt16LE(4))
            || !(pe.readUInt16LE(22) & 2) || (pe.readUInt16LE(22) & 0x2000)
            || ![0x10b, 0x20b].includes(pe.readUInt16LE(24))) {
            throw native.nativeError('SAIL_PROTON_FORMAT', 'Choose a Windows x86 or x64 game executable, rather than a DLL or another file.');
        }
    } finally { fs.closeSync(fd); }
    return identity;
}

function selectLocalExecutable(selected, options = {}) {
    const fd = fs.openSync(selected, 'r'), magic = Buffer.alloc(2);
    try { fs.readSync(fd, magic, 0, magic.length, 0); } finally { fs.closeSync(fd); }
    if (magic.toString('ascii') === 'MZ') return { backend: 'proton-umu', identity: validateWindowsExecutable(selected, options) };
    return { backend: 'native', identity: native.validateNativeExecutable(selected, options) };
}
module.exports = { validateWindowsExecutable, selectLocalExecutable };
