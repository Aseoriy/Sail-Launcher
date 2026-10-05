'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { discoverSteamInstallations } = require('../steamDiscovery');
const LIMIT = 256 * 1024 * 1024;
const JOURNAL = '.sail-gd-import.json';
const PRIMARY = ['CCGameManager.dat', 'CCLocalLevels.dat'];
const fdPath = (fd, name = '') => `/proc/self/fd/${fd}${name ? '/' + name : ''}`;
const present = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function namesIn(fd) {
    const dir = fs.opendirSync(fdPath(fd)), names = [];
    try {
        let entry;
        while ((entry = dir.readSync())) {
            if (names.length >= 4096) throw Error('The save folder has too many entries.');
            names.push(entry.name);
        }
        return names.sort();
    } finally { dir.closeSync(); }
}

// Open each component through its retained parent; linked ancestors and files
// are rejected. Copies and renames use retained directory descriptors as well.
function directory(file) {
    if (!path.isAbsolute(file) || path.resolve(file) !== file) throw Error('Invalid save directory.');
    let fd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
        for (const part of file.split('/').filter(Boolean)) {
            const next = fs.openSync(fdPath(fd, part), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            fs.closeSync(fd); fd = next;
        }
        return fd;
    } catch (error) { fs.closeSync(fd); throw error; }
}

function tree(fd, copyTo = null, budget = { bytes: 0, entries: 0 }, depth = 0) {
    if (depth > 12) throw Error('The save folder is nested too deeply.');
    if (fs.fstatSync(fd).uid !== process.getuid()) throw Error('Foreign-owned save folders cannot be imported.');
    const before = identity(fs.fstatSync(fd)), names = namesIn(fd), manifest = [];
    for (const name of names) {
        if (++budget.entries > 4096 || /[\u0000-\u001f\u007f]/.test(name)) throw Error('The save folder has too many or unsupported entries.');
        const file = fdPath(fd, name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('Linked or foreign-owned save files cannot be imported.');
        if (stat.isDirectory()) {
            const child = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            try {
                if (stat.dev !== fs.fstatSync(child).dev || stat.ino !== fs.fstatSync(child).ino) throw Error('The save folder changed.');
                if (copyTo) fs.mkdirSync(path.join(copyTo, name), { mode: 0o700 });
                manifest.push([name, tree(child, copyTo && path.join(copyTo, name), budget, depth + 1)]);
            } finally { fs.closeSync(child); }
        } else {
            if (!stat.isFile() || stat.size > LIMIT || (budget.bytes += stat.size) > LIMIT) throw Error('The save folder is unsupported or exceeds 256 MiB.');
            const input = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
                if (identity(stat) !== identity(fs.fstatSync(input))) throw Error('A save file changed.');
                // A writer may grow a file after stat; never allocate/read beyond
                // the captured size, even if the source is concurrently changing.
                const bytes = Buffer.alloc(stat.size);
                let count = 0;
                while (count < bytes.length) {
                    const read = fs.readSync(input, bytes, count, bytes.length - count, count);
                    if (!read) throw Error('A save file changed during the copy.');
                    count += read;
                }
                if (bytes.length !== stat.size || identity(stat) !== identity(fs.fstatSync(input))) throw Error('A save file changed during the copy. Close the game first.');
                if (copyTo) {
                    const output = fs.openSync(path.join(copyTo, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
                    try { fs.writeFileSync(output, bytes); fs.fsyncSync(output); } finally { fs.closeSync(output); }
                }
                manifest.push([name, identity(stat), hash(bytes)]);
            } finally { fs.closeSync(input); }
        }
    }
    if (identity(fs.fstatSync(fd)) !== before || JSON.stringify(namesIn(fd)) !== JSON.stringify(names)) throw Error('The save folder changed during the copy.');
    if (copyTo) { const out = fs.openSync(copyTo, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(out); } finally { fs.closeSync(out); } }
    return manifest;
}

function recovery(parent, destination) {
    const file = fdPath(parent, JOURNAL);
    if (!present(file)) return;
    const input = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let record;
    try {
        const stat = fs.fstatSync(input);
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 4096) throw Error('Invalid save import recovery record.');
        record = JSON.parse(fs.readFileSync(input, 'utf8'));
    } finally { fs.closeSync(input); }
    if (record.destination !== destination || !/^\.sail-gd-stage-[a-f0-9-]{36}$/.test(record.stage)
        || !/^GeometryDash\.sail-backup-[a-f0-9-]{36}$/.test(record.backup)) throw Error('Invalid save import recovery paths.');
    const dest = fdPath(parent, destination), stage = fdPath(parent, record.stage), backup = fdPath(parent, record.backup);
    if (!present(dest) && present(backup)) fs.renameSync(backup, dest);
    if (!present(dest) && !present(stage)) throw Error('Save import recovery needs attention; retained files were not removed.');
    if (present(stage)) fs.rmSync(stage, { recursive: true });
    fs.unlinkSync(file); fs.fsyncSync(parent);
}

function sourceBusy(prefix) {
    for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
        try {
            const env = fs.readFileSync(`/proc/${pid}/environ`);
            if (env.length < 1024 * 1024 && env.toString().split('\0').some(value => {
                const match = /^(STEAM_COMPAT_DATA_PATH|WINEPREFIX)=(\/[^\0]{1,4096})$/.exec(value);
                if (!match) return false;
                try { return fs.realpathSync(match[2]) === (match[1] === 'WINEPREFIX' ? prefix + '/pfx' : prefix); }
                catch (_) { return false; }
            })) return true;
        } catch (_) { /* Other users' process metadata is not accessible. */ }
    }
    return false;
}

function rule(appId, executable, backend = 'proton-umu') {
    if (String(appId) !== '322170') return null;
    const name = path.basename(executable || '', path.extname(executable || ''));
    if (!/^[A-Za-z0-9 _-]{1,80}$/.test(name)) return null;
    const user = backend === 'wine' ? require('node:os').userInfo().username : 'steamuser';
    if (!/^[A-Za-z0-9 _.-]{1,80}$/.test(user) || ['.', '..'].includes(user)) return null;
    return { destination: name, relative: `drive_c/users/${user}/AppData/Local` };
}

async function discoverSaves({ appId, executable, discoveryOptions = {} }) {
    const mapping = rule(appId, executable);
    if (!mapping) return { supported: false, candidates: [], reason: 'Automatic Steam save import is currently available for Geometry Dash.' };
    const { libraries, issueCount } = await discoverSteamInstallations(discoveryOptions), candidates = [];
    for (const library of libraries) {
        const prefix = path.join(library, 'steamapps', 'compatdata', String(appId));
        const folder = path.join(prefix, 'pfx', mapping.relative, 'GeometryDash');
        let fd;
        try {
            fd = directory(folder);
            if (!PRIMARY.every(name => { const s = fs.lstatSync(fdPath(fd, name)); return s.isFile() && s.size > 0 && s.size <= LIMIT; })) continue;
            const stat = fs.fstatSync(fd);
            const id = hash(JSON.stringify([folder, stat.dev, stat.ino]));
            candidates.push({ id, folder, prefix, label: `Steam save · ${library}`, busy: sourceBusy(prefix) });
        } catch (_) { /* Missing or linked save folders are not valid candidates. */ }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    return { supported: true, candidates, issueCount, reason: candidates.length ? 'Steam saves found. Close the game in Steam and Sail before importing.' : 'No Geometry Dash save found in the detected Steam libraries.' };
}

function importSave({ prefix, executable, backend = 'proton-umu', candidate, assertIdle = () => {}, checkpoint = () => {} }) {
    const mapping = rule('322170', executable, backend);
    if (!mapping) throw Error('The game executable has an unsupported save folder name.');
    assertIdle();
    if (sourceBusy(candidate.prefix)) throw Error('Close Geometry Dash in Steam before importing its save.');
    const parentPath = path.join(prefix, mapping.relative);
    let parent;
    try { parent = directory(parentPath); } catch (_) { throw Error('Launch this game once through Sail, then close it before importing the Steam save.'); }
    let source;
    const stageName = '.sail-gd-stage-' + crypto.randomUUID(), backupName = 'GeometryDash.sail-backup-' + crypto.randomUUID();
    const stage = fdPath(parent, stageName), dest = fdPath(parent, mapping.destination), backup = fdPath(parent, backupName);
    let journalWritten = false;
    try {
        recovery(parent, mapping.destination);
        source = directory(candidate.folder);
        const st = fs.fstatSync(source);
        if (hash(JSON.stringify([candidate.folder, st.dev, st.ino])) !== candidate.id) throw Error('The Steam save folder changed. Scan again.');
        if (!PRIMARY.every(name => { const s = fs.lstatSync(fdPath(source, name)); return s.isFile() && s.size > 0 && s.size <= LIMIT; })) throw Error('The Steam save is incomplete.');
        fs.mkdirSync(stage, { mode: 0o700 });
        const copied = tree(source, stage);
        if (JSON.stringify(copied) !== JSON.stringify(tree(source))) throw Error('The Steam save changed during import. Close the game and retry.');
        if (fs.realpathSync(fdPath(source)) !== candidate.folder || fs.realpathSync(fdPath(parent)) !== parentPath) throw Error('A save directory moved during import. Scan again.');
        if (present(dest)) { const current = directory(path.join(parentPath, mapping.destination)); try { tree(current); } finally { fs.closeSync(current); } }
        assertIdle();
        if (sourceBusy(candidate.prefix)) throw Error('Close Geometry Dash in Steam before importing its save.');
        const record = { destination: mapping.destination, stage: stageName, backup: backupName };
        const journal = fs.openSync(fdPath(parent, JOURNAL), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(journal, JSON.stringify(record)); fs.fsyncSync(journal); } finally { fs.closeSync(journal); }
        fs.fsyncSync(parent); journalWritten = true; checkpoint('prepared');
        const hadSave = present(dest);
        if (hadSave) fs.renameSync(dest, backup);
        fs.fsyncSync(parent); checkpoint('backed-up');
        fs.renameSync(stage, dest); fs.fsyncSync(parent); checkpoint('installed');
        fs.unlinkSync(fdPath(parent, JOURNAL)); fs.fsyncSync(parent);
        return { imported: true, backup: hadSave ? path.join(parentPath, backupName) : '', reason: 'Steam save imported. Your next Sail launch will use it.' };
    } catch (error) {
        if (journalWritten) recovery(parent, mapping.destination);
        else if (present(stage)) fs.rmSync(stage, { recursive: true });
        throw error;
    } finally { if (source !== undefined) fs.closeSync(source); fs.closeSync(parent); }
}

function recoverSaveImport(prefix, executable, backend = 'proton-umu') {
    const mapping = rule('322170', executable, backend);
    if (!mapping) return;
    let parent;
    try { parent = directory(path.join(prefix, mapping.relative)); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try { recovery(parent, mapping.destination); } finally { fs.closeSync(parent); }
}

module.exports = { discoverSaves, importSave, recoverSaveImport };
