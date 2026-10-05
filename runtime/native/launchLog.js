'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { UUID } = require('./protocol');
const { privateDirectory, privateRead, save } = require('../proton/manager');
const key = scope => crypto.createHash('sha256').update(JSON.stringify([scope.libraryKey, scope.gameId])).digest('hex');
class LaunchLogs {
    constructor(root) { this.root = root; this.file = path.join(root, 'launch-logs.json'); }
    readIndex() {
        privateDirectory(this.root);
        if (!fs.existsSync(this.file)) return { protocol: 1, entries: [] };
        const value = JSON.parse(privateRead(this.file, 131072));
        if (value.protocol !== 1 || !Array.isArray(value.entries) || value.entries.length > 256
            || value.entries.some(item => !/^[a-f0-9]{64}$/.test(item.key) || !UUID.test(item.sessionId))) throw Error('Invalid launch log index.');
        return value;
    }
    bind(session) {
        const index = this.readIndex(), binding = key(session), previous = index.entries.filter(item => item.key === binding);
        index.entries = index.entries.filter(item => item.key !== binding);
        index.entries.push({ key: binding, sessionId: session.sessionId });
        const obsolete = [...previous, ...index.entries.splice(0, Math.max(0, index.entries.length - 256))];
        save(this.file, JSON.stringify(index) + '\n');
        for (const item of obsolete) {
            if (item.sessionId === session.sessionId) continue;
            try {
                const directory = path.join(this.root, item.sessionId); privateDirectory(directory);
                for (const name of ['launch.log', 'launch.log.1']) fs.rmSync(path.join(directory, name), { force: true });
            } catch (_) { /* Log retention never changes process ownership. */ }
        }
    }
    read(scope) {
        const binding = this.readIndex().entries.find(item => item.key === key(scope));
        if (!binding) return { available: false, text: '', hint: 'Launch this game to capture a compatibility log.' };
        const directory = path.join(this.root, binding.sessionId); privateDirectory(directory); const blocks = [];
        for (const name of ['launch.log.1', 'launch.log']) {
            const file = path.join(directory, name); let fd;
            try {
                fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const stat = fs.fstatSync(fd);
                if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.nlink !== 1 || stat.size > 1024 * 1024) throw Error('Invalid private launch log.');
                const bytes = Buffer.alloc(Math.min(stat.size, 128 * 1024));
                const size = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length)); blocks.push(bytes.subarray(0, size).toString('utf8'));
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            finally { if (fd !== undefined) fs.closeSync(fd); }
        }
        const text = blocks.join('\n').slice(-128 * 1024).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
        const hint = /No space left|ENOSPC/i.test(text) ? 'The Windows environment ran out of disk space.'
            : /vulkan.*(?:fail|error)|failed.*vulkan|DXVK.*(?:fail|error)/i.test(text) ? 'The compatibility runner reported a graphics initialization error. Check that both 64-bit and 32-bit Vulkan drivers are installed.'
            : /No module named|ModuleNotFoundError|python.*not found/i.test(text) ? 'UMU could not load its Python dependencies. Try the UMU version downloaded by Sail.'
            : /network.*(?:error|unreachable)|could not resolve|NameResolutionError|connection.*(?:failed|refused)/i.test(text) ? 'The compatibility runner reported a network error. Check your connection and the launch log.'
            : text ? 'Recent output from this game’s compatibility launcher.' : 'No output captured. Retry with the current Sail build.';
        return { available: !!blocks.length, text, hint, limited: true };
    }
}
module.exports = { LaunchLogs };
