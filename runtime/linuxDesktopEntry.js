'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRY_BYTES = 64 * 1024;

function desktopString(value) {
    if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        throw new Error('The desktop entry contains an invalid value.');
    }
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function desktopArgument(value) {
    if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error('The launcher path contains unsupported control characters.');
    }
    // Desktop strings are unescaped before Exec quoting and field expansion.
    const quoted = value.replace(/["`$\\]/g, character => `\\${character}`).replace(/%/g, '%%');
    return desktopString(`"${quoted}"`);
}

function launcherCommand({ executablePath, sourcePath }, args) {
    if (!path.isAbsolute(executablePath) || executablePath.includes('=')) {
        throw new Error('The launcher executable path cannot be used in a desktop entry.');
    }
    // GIO checks the executable before expanding literal %% codes. Put percent
    // paths in an argument to env so that check and expansion both remain valid.
    const command = executablePath.includes('%')
        ? [desktopArgument('/usr/bin/env'), '--', desktopArgument(executablePath)]
        : [desktopArgument(executablePath)];
    if (sourcePath) {
        if (!path.isAbsolute(sourcePath)) throw new Error('The launcher source path must be absolute.');
        command.push(desktopArgument(sourcePath));
    }
    return command.concat(args.map(desktopArgument)).join(' ');
}

function parseDesktopEntry(text) {
    if (Buffer.byteLength(text) > MAX_ENTRY_BYTES || text.includes('\0')) throw new Error('The desktop entry is invalid or too large.');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const values = Object.create(null);
    const indices = new Map();
    const groups = new Set();
    let group = '';
    let groupEnd = lines.length;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        const header = /^\[([^\]]+)\]$/.exec(line);
        if (header) {
            if (group === 'Desktop Entry') groupEnd = index;
            group = header[1];
            if (groups.has(group)) throw new Error('The desktop entry has duplicate groups.');
            groups.add(group);
            continue;
        }
        const pair = /^([A-Za-z0-9-]+(?:\[[^\]]+\])?)=(.*)$/.exec(line);
        if (!pair || !group) throw new Error('The desktop entry is malformed.');
        if (group === 'Desktop Entry') {
            if (indices.has(pair[1])) throw new Error('The desktop entry has duplicate keys.');
            values[pair[1]] = pair[2];
            indices.set(pair[1], index);
        }
    }
    if (!groups.has('Desktop Entry')) throw new Error('The desktop entry has no application group.');
    return { lines, values, indices, groupEnd };
}

function updateDesktopEntry(text, updates) {
    const { lines, indices, groupEnd } = parseDesktopEntry(text);
    const added = [];
    for (const [key, value] of Object.entries(updates)) {
        const line = `${key}=${value}`;
        if (indices.has(key)) lines[indices.get(key)] = line;
        else added.push(line);
    }
    lines.splice(groupEnd, 0, ...added);
    return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

async function readDesktopFile(filePath) {
    let file;
    try {
        file = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES) throw new Error('The desktop entry is not a bounded regular file.');
        const bytes = Buffer.alloc(MAX_ENTRY_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
            const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > MAX_ENTRY_BYTES) throw new Error('The desktop entry is too large.');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
        return { text, stat, ...parseDesktopEntry(text) };
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    } finally {
        if (file) await file.close();
    }
}

async function writeDesktopFile(filePath, content, { mode = 0o600, previous = null } = {}) {
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(directory, `.sail-desktop-${crypto.randomUUID()}.tmp`);
    let file;
    try {
        file = await fs.promises.open(temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        await file.writeFile(content, 'utf8');
        await file.chmod(mode);
        await file.sync();
        await file.close();
        file = null;
        if (previous) {
            const current = await readDesktopFile(filePath);
            if (!current || current.stat.dev !== previous.stat.dev || current.stat.ino !== previous.stat.ino || current.text !== previous.text) {
                throw new Error('The desktop entry changed while saving. Please try again.');
            }
            await fs.promises.rename(temporaryPath, filePath);
        } else {
            // Publish a complete entry without replacing an existing file or link.
            await fs.promises.link(temporaryPath, filePath);
        }
        const folder = await fs.promises.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try { await folder.sync(); } finally { await folder.close(); }
    } finally {
        try { if (file) await file.close(); }
        finally { await fs.promises.unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
}

module.exports = { desktopString, launcherCommand, readDesktopFile, updateDesktopEntry, writeDesktopFile };
