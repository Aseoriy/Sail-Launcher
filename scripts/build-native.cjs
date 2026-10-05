'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function buildNative() {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The native supervisor build currently requires Linux x64.');
    const root = path.resolve(__dirname, '..');
    const directory = path.join(root, 'native/linux/x64');
    fs.mkdirSync(directory, { recursive: true });
    const output = path.join(directory, 'sail-native');
    const result = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wformat=2',
        '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-Wl,-z,relro,-z,now',
        '-o', `${output}.tmp`, path.join(root, 'native/linux/sail-native.c')], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Native supervisor compilation failed (${result.status}).`);
    fs.chmodSync(`${output}.tmp`, 0o755);
    fs.renameSync(`${output}.tmp`, output);
    return output;
}
if (require.main === module) buildNative();
module.exports = { buildNative };
