'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Provider paths describe a torrent's layout, never a destination outside its job.
function torrentDownloadTarget(root, relativePath, { createDirectories = false } = {}) {
    if (typeof relativePath !== 'string' || !relativePath || path.win32.isAbsolute(relativePath)) {
        throw new Error('The debrid service returned an invalid torrent file path.');
    }
    const parts = relativePath.replace(/\\/g, '/').split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.length > 255
        || /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw new Error('The debrid service returned a torrent file path that cannot be saved safely on Windows.');
    }
    const base = path.resolve(root);
    const target = path.resolve(base, ...parts);
    const relative = path.relative(base, target);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('The torrent file must stay inside its download folder.');
    }
    let current = base;
    for (let index = -1; index < parts.length; index++) {
        if (index >= 0) current = path.join(current, parts[index]);
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const directory = index < parts.length - 1;
        if (stat && (stat.isSymbolicLink() || directory && !stat.isDirectory()
            || !directory && !stat.isFile())) {
            throw new Error('The torrent destination contains a link or an unexpected file.');
        }
        if (!stat && directory && createDirectories) fs.mkdirSync(current);
    }
    // aria2 stores its resume metadata beside the payload, so guard that path too.
    try {
        const control = fs.lstatSync(target + '.aria2');
        if (control.isSymbolicLink() || !control.isFile()) throw new Error('The torrent resume file is not a regular file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { path: target, directory: path.dirname(target), name: parts[parts.length - 1] };
}

module.exports = { torrentDownloadTarget };
