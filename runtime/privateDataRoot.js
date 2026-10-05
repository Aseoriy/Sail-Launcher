'use strict';

const fs = require('node:fs');
const path = require('node:path');

function privateDataRoot({ root, packaged, supplied = process.env.SAIL_DEV_DATA_ROOT }) {
    if (!packaged && !supplied) return path.join(root, '.dev-data');
    if (!supplied || !path.isAbsolute(supplied)) throw new Error('Packaged preview requires an existing absolute SAIL_DEV_DATA_ROOT directory.');
    const target = path.resolve(supplied);
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target
        || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
        || target === root || target.startsWith(root + path.sep)) {
        throw new Error('Preview data root must be a private owned directory outside the application, with no symlinks.');
    }
    return target;
}

module.exports = { privateDataRoot };
