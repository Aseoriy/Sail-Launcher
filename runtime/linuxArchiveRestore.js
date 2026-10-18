'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { createArchiveSevenZipInvocation } = require('../security/archiveDataBinding');
const { runOwnedChildProcess } = require('./ownedChildProcess');

// Restoring a backup on Linux writes back only the files that differ from it. Rewriting an unchanged file
// would give it a new identity, and an approved game executable with a new identity must be chosen again.

function listEntries(binaryPath, archivePath) {
    return new Promise((resolve, reject) => {
        const child = spawn(binaryPath, ['l', '-slt', '-ba', '-spd', '-sccUTF-8', '--', archivePath], { stdio: ['ignore', 'pipe', 'ignore'] });
        const entries = [];
        let current = null;
        const finishEntry = () => { if (current && current.path !== undefined) entries.push(current); current = null; };
        readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
            const match = /^(Path|Folder|Size|CRC|Attributes) = (.*)$/.exec(line);
            if (!match) return;
            if (match[1] === 'Path') { finishEntry(); current = { path: match[2] }; return; }
            if (!current) return;
            if (match[1] === 'Folder') current.folder = match[2] === '+';
            else if (match[1] === 'Size') current.size = Number(match[2]);
            else if (match[1] === 'CRC') current.crc = match[2];
            else if (match[1] === 'Attributes' && /^D/.test(match[2])) current.folder = true;
        }).on('close', () => finishEntry());
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve(entries) : reject(new Error('The backup archive could not be read.')));
    });
}

function safeRelative(entryPath) {
    const parts = String(entryPath).split('/');
    if (!entryPath || entryPath.startsWith('/') || /[\u0000\r\n]/.test(entryPath) || parts.some(part => part === '..')) {
        throw new Error('The backup archive contains an unsafe path.');
    }
    return parts.filter(part => part && part !== '.').join(path.sep);
}

async function crc32(file) {
    let value = 0;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) value = zlib.crc32(chunk, value);
    return value >>> 0;
}

async function unchanged(target, entry) {
    let stat;
    try { stat = fs.lstatSync(target); } catch (_) { return false; }
    if (!stat.isFile() || stat.size !== entry.size) return false;
    if (entry.size === 0) return true;
    if (!/^[0-9A-Fa-f]{8}$/.test(String(entry.crc || ''))) return false;
    return await crc32(target) === parseInt(entry.crc, 16);
}

async function restoreChangedEntries(archivePath, destination, binaryPath, options = {}) {
    const root = fs.realpathSync(destination);
    const entries = await listEntries(binaryPath, archivePath);
    const changed = [];
    for (const entry of entries) {
        const relative = safeRelative(entry.path);
        if (!relative) continue;
        const target = path.join(root, relative);
        // A linked folder inside the game could point anywhere; never write through it.
        let parent = path.dirname(target);
        while (!fs.existsSync(parent)) parent = path.dirname(parent);
        const realParent = fs.realpathSync(parent);
        if (realParent !== root && !realParent.startsWith(root + path.sep)) throw new Error('The restore target leaves the game folder through a link.');
        if (entry.folder) { fs.mkdirSync(target, { recursive: true }); continue; }
        if (await unchanged(target, entry)) continue;
        try { if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target); } catch (_) { /* Missing files are simply restored. */ }
        changed.push(entry.path);
    }
    if (!changed.length) return { restored: 0, unchanged: entries.length };
    const scratch = fs.mkdtempSync(path.join(options.tempRoot || os.tmpdir(), 'sail-restore-'));
    try {
        const listFile = path.join(scratch, 'entries.txt');
        fs.writeFileSync(listFile, changed.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
        const invocation = createArchiveSevenZipInvocation('expand', archivePath, root, binaryPath, { listFile });
        await runOwnedChildProcess(invocation.file, invocation.args, null, { spawnOptions: { stdio: ['ignore', 'ignore', 'pipe'] } });
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    return { restored: changed.length, unchanged: entries.length - changed.length };
}

module.exports = { restoreChangedEntries };
