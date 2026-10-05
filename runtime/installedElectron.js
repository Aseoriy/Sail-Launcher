'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ELECTRON_VERSION } = require('./runtimeRequirements');

function installedElectron(packageFile = require.resolve('electron/package.json')) {
    // Electron 44's package entry installs missing binaries on require(). Never
    // import it from a launcher: dependency acquisition is a separate operation.
    const root = path.dirname(packageFile);
    const error = () => new Error(`Install the locked dependencies and Electron ${ELECTRON_VERSION} explicitly before launching Sail (npm run install:electron).`);
    try {
        if (JSON.parse(fs.readFileSync(packageFile, 'utf8')).version !== ELECTRON_VERSION) throw error();
        const relative = fs.readFileSync(path.join(root, 'path.txt'), 'utf8').trim();
        const dist = path.join(root, 'dist');
        const binary = path.resolve(dist, relative);
        if (!relative || !binary.startsWith(dist + path.sep)) throw error();
        if (fs.readFileSync(path.join(dist, 'version'), 'utf8').trim().replace(/^v/, '') !== ELECTRON_VERSION) throw error();
        fs.accessSync(binary, fs.constants.X_OK);
        if (process.platform === 'linux') {
            const fd = fs.openSync(binary, 'r');
            try {
                const header = Buffer.alloc(4);
                if (fs.readSync(fd, header, 0, 4, 0) !== 4 || !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw error();
            } finally { fs.closeSync(fd); }
        }
        return binary;
    } catch (_) { throw error(); }
}

module.exports = { installedElectron };
