'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

function sniffArchiveExt(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(8);
        const n = fs.readSync(fd, buf, 0, 8, 0);
        if (n < 4) return '';
        if (buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
        if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return 'rar';
        if (buf[0] === 0x37 && buf[1] === 0x7A && buf[2] === 0xBC && buf[3] === 0xAF) return '7z';
        return '';
    } catch (_) {
        return '';
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
    }
}

function normalizeArchiveExtensions(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!entry.name.startsWith('_')) normalizeArchiveExtensions(path.join(dir, entry.name), depth + 1);
            continue;
        }
        if (!entry.isFile()) continue;
        const name = entry.name;
        if (/^_cover\./i.test(name)) continue;
        if (/\.(zip|rar|7z|bin|iso|exe|msi|cab|pkg|001|002|003|004|005|part\d+|r\d{2}|z\d{2}|aria2|tmp)$/i.test(name)) continue;
        const full = path.join(dir, name);
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_) { continue; }
        if (size < 1024) continue;
        const ext = sniffArchiveExt(full);
        if (!ext) continue;
        const target = full + '.' + ext;
        try { if (!fs.existsSync(target)) fs.renameSync(full, target); } catch (_) {}
    }
}

function findArchives(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
    const primaries = [];
    for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('_')) {
            primaries.push(...findArchives(path.join(dir, entry.name)));
            continue;
        }
        if (!entry.isFile()) continue;
        const name = entry.name;
        const lower = name.toLowerCase();
        if (/\.part(?!0*1\.)\d+\.rar$/i.test(name)) continue;
        if (/\.part(?!0*1\.)\d+\.zip$/i.test(name)) continue;
        if (/\.(r\d{2}|z\d{2})$/i.test(name)) continue;
        if (/\.\d{3}$/.test(name) && !/\.001$/.test(name)) continue;
        if (/\.(zip|rar|7z)$/i.test(lower) || /\.7z\.001$/i.test(lower) || /\.zip\.001$/i.test(lower)) {
            primaries.push(path.join(dir, name));
        }
    }
    return primaries;
}

function findGameExe(dir, gameName) {
    const hardExclude = /(unins|setup|vc_?redist|vcredist|dxsetup|directx|dotnet|dotnetfx|oalinst|redist|crashreport|crashhandler|uninstall|launcher_settings|notification_helper|quicksfv|sfv|installer)/i;
    const softExclude = /(config|settings|editor|server|benchmark|cleanup|dxdiag|prereq|helper|report)/i;
    const executables = [];
    const walk = (current, depth) => {
        if (depth > 10) return;
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) { walk(full, depth + 1); continue; }
            if (!entry.name.toLowerCase().endsWith('.exe')) continue;
            if (/[\\/]md5[\\/]/i.test(full)) continue;
            let size = 0;
            try { size = fs.statSync(full).size; } catch (_) {}
            executables.push({ name: entry.name, full, size, hard: hardExclude.test(entry.name), soft: softExclude.test(entry.name) });
        }
    };
    walk(dir, 0);
    if (!executables.length) return null;
    const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = normalize(gameName);
    const pool = executables.filter(entry => !entry.hard);
    if (!pool.length) return null;
    pool.sort((left, right) => {
        const leftMatch = target && normalize(left.name).includes(target) ? 1 : 0;
        const rightMatch = target && normalize(right.name).includes(target) ? 1 : 0;
        if (leftMatch !== rightMatch) return rightMatch - leftMatch;
        if (left.soft !== right.soft) return left.soft ? 1 : -1;
        return right.size - left.size;
    });
    return pool[0].full;
}

function payloadFiles(dir, depth = 0, output = []) {
    if (depth > 6) return output;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return output; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { payloadFiles(full, depth + 1, output); continue; }
        if (!entry.isFile() || /^_cover\./i.test(entry.name)) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_) {}
        output.push({ name: entry.name, full, size });
    }
    return output;
}

function dirSizeBytes(dir, depth = 0) {
    if (depth > 8) return 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
    let total = 0;
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += dirSizeBytes(full, depth + 1);
        else {
            try { total += fs.statSync(full).size; } catch (_) {}
        }
    }
    return total;
}

function deleteArchiveSources(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    const archive = /\.(zip|rar|7z|iso)$|\.(zip|7z)\.\d{3}$|\.part\d+\.rar$|\.r\d{2}$|\.z\d{2}$|\.\d{3}$/i;
    for (const entry of entries) {
        if (!entry.isFile() || /^_cover\./i.test(entry.name)) continue;
        if (archive.test(entry.name)) {
            try { fs.unlinkSync(path.join(dir, entry.name)); } catch (_) {}
        }
    }
}

function cleanExtractedJunk(root, skipRedist) {
    const walk = (dir, depth) => {
        if (depth > 4) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (skipRedist && /^_?(common[ _-]?)?redist$/i.test(entry.name)) {
                    try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) {}
                    continue;
                }
                walk(full, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            if (/\.url$/i.test(entry.name)) {
                try { fs.unlinkSync(full); } catch (_) {}
                continue;
            }
            if (/\.txt$/i.test(entry.name) && /(read[ _-]?me|steamrip|instruction)/i.test(entry.name)) {
                try { fs.unlinkSync(full); } catch (_) {}
            }
        }
    };
    walk(root, 0);
}

function cleanRepackSource(dir, keepDir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (full === keepDir || /^_cover\./i.test(entry.name)) continue;
        try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) {}
    }
}

function execute(input) {
    const operation = String(input && input.operation || '');
    const dir = String(input && (input.dir || input.directory) || '');
    if (!dir) throw new Error('Preparation worker received an incomplete directory request.');
    if (operation === 'normalize-archives') {
        normalizeArchiveExtensions(dir, 0);
        return { directory: dir };
    }
    if (operation === 'scan-payload') {
        const files = payloadFiles(dir);
        return { files, archives: findArchives(dir), exePath: findGameExe(dir, input.gameName) || '' };
    }
    if (operation === 'directory-size') return { bytes: dirSizeBytes(dir, 0) };
    if (operation === 'delete-archive-sources') {
        deleteArchiveSources(dir);
        return { directory: dir };
    }
    if (operation === 'clean-extracted-junk') {
        cleanExtractedJunk(dir, input.skipRedist !== false);
        return { directory: dir };
    }
    if (operation === 'clean-repack-source') {
        cleanRepackSource(dir, String(input.keepDir || ''));
        return { directory: dir };
    }
    throw new Error('Unknown preparation worker operation.');
}

try {
    parentPort.postMessage({ ok: true, result: execute(workerData || {}) });
} catch (error) {
    parentPort.postMessage({
        ok: false,
        error: {
            name: error && error.name || 'Error',
            message: error && error.message || String(error),
            code: error && error.code
        }
    });
}
