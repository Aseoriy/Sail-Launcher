'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const native = require('./native/protocol');
const { selectLocalExecutable } = require('./proton/executable');
const { fileIdentity, identityMatches } = require('../security/capabilityStore');
const { runOwnedWorker } = require('./ownedWorker');
const { spawn } = require('node:child_process');
const EXCLUDE = /(?:unins|uninstall|redist|dxsetup|directx|dotnet|oalinst|crash|report|helper|quicksfv|notification|benchmark|prereq)/i;
const INSTALLER = /(?:^|[ _.-])(?:setup|install|installer)(?:[ _.-].*)?\.exe$/i;
function archiveKind(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), bytes = Buffer.alloc(8);
    try { fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
    if (bytes.subarray(0, 2).toString() === 'PK') return 'zip';
    if (bytes.subarray(0, 4).toString() === 'Rar!') return 'rar';
    if (bytes.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
    return '';
}
function scan(roots, { fixtureRoot = null, allowScripts = true, prefixRoots = [] } = {}) {
    const games = [], installers = [], archives = [], seen = new Set(); let entries = 0, truncated = false;
    for (const selected of roots) {
        if (!fs.existsSync(selected)) continue;
        const root = native.validateWorkingDirectory(selected, { fixtureRoot }).realPath;
        const prefix = prefixRoots.includes(root), builtins = new Set();
        if (prefix) {
            let fd;
            try {
                fd = fs.openSync(path.join(path.dirname(root), 'tracked_files'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                const stat = fs.fstatSync(fd);
                if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
                    for (const item of fs.readFileSync(fd, 'utf8').split('\n')) {
                        const relative = item.replace(/\\/g, '/');
                        if (relative.length <= 4096 && relative.startsWith('drive_c/') && /\.exe$/i.test(relative)
                            && !relative.split('/').includes('..')) builtins.add(path.join(root, relative.slice(8)));
                    }
                }
            } catch (_) { /* Older runtimes may not record their builtin files. */ }
            finally { if (fd !== undefined) fs.closeSync(fd); }
        }
        const walk = (folder, depth) => {
            if (depth > 12 || entries >= 40000) { truncated = true; return; }
            if (fs.realpathSync(folder) !== folder) return;
            const dir = fs.opendirSync(folder);
            try {
                let entry;
                while ((entry = dir.readSync())) {
                    if (++entries > 40000) { truncated = true; break; }
                    const file = path.join(folder, entry.name);
                    if (entry.isSymbolicLink()) continue;
                    if (entry.isDirectory()) { if (!/^(?:windows|_?commonredist|_?redist|redistributables|md5)$/i.test(entry.name)
                        && (prefix || !/^users$/i.test(entry.name))) walk(file, depth + 1); continue; }
                    if (!entry.isFile() || seen.has(file)) continue;
                    seen.add(file);
                    if (/\.(?:zip|rar|7z)(?:\.001)?$/i.test(entry.name) && !/\.part(?!0*1\.)\d+\.rar$/i.test(entry.name)) {
                        if (archives.length < 32 && archiveKind(file)) archives.push(file);
                    }
                    if (EXCLUDE.test(entry.name) || builtins.has(file) || prefix && /^(?:Program Files(?: \(x86\))?)\/(?:Internet Explorer|Windows Media Player|Windows NT\/Accessories)\//i.test(path.relative(root, file))) continue;
                    if (games.length + installers.length >= 64) { truncated = true; continue; }
                    const stat = fs.lstatSync(file);
                    if (!/\.exe$/i.test(entry.name) && !(stat.mode & 0o111)) continue;
                    try {
                        const selected = selectLocalExecutable(file, { fixtureRoot, allowScripts });
                        if (selected.identity.realPath !== file) continue;
                        const candidate = { id: crypto.createHash('sha256').update(file).digest('hex'), label: path.relative(root, file), root,
                            executable: selected.identity, backend: selected.backend, cwd: native.validateWorkingDirectory(path.dirname(file), { fixtureRoot }) };
                        (INSTALLER.test(entry.name) ? installers : games).push(candidate);
                    } catch (_) { /* Assets and unsupported binaries are not launch targets. */ }
                }
            } finally { dir.closeSync(); }
        };
        walk(root, 0);
    }
    return { games, installers, archives, truncated };
}
function validate(candidate, options = {}) {
    const result = selectLocalExecutable(candidate.executable.realPath, { allowScripts: true, ...options, expected: candidate.executable });
    native.validateWorkingDirectory(candidate.cwd.realPath, { ...options, expected: candidate.cwd });
    if (result.backend !== candidate.backend || !native.withinRoot(result.identity.realPath, candidate.root)) throw Error('The detected executable changed. Scan the game again.');
    return candidate;
}
async function extract(archive, destination, work, microsoftRedist = false) {
    const expected = fileIdentity(archive, 'file');
    fs.mkdirSync(destination, { mode: 0o700 });
    const rootIdentity = fileIdentity(destination, 'directory');
    const kind = microsoftRedist ? '7z' : archiveKind(archive);
    if (kind === 'rar') {
        let timer;
        await runOwnedWorker(path.join(__dirname, 'linuxRarExtractWorker.js'), { archive, destination }, {
            checkpoint: work.checkpoint,
            setStop: async stop => { clearTimeout(timer); if (stop) timer = setTimeout(stop, 7200000); await work.setStop(stop); }
        });
    } else if (kind === 'zip' || kind === '7z') {
        const bundled = path.join(path.dirname(require.resolve('7zip-bin', { paths: [path.dirname(require.resolve('7zip-min'))] })), 'linux', 'x64', '7za').replace(/app\.asar(?=\/)/, 'app.asar.unpacked');
        const program = fs.readFileSync(path.join(__dirname, 'linuxGameExtract.py'), 'utf8');
        let child, stopping = false, errors = '';
        try {
            await work.setStop(() => { stopping = true; child?.kill('SIGTERM'); });
            await work.checkpoint(); if (stopping) throw Error('Cancelled');
            await new Promise((resolve, reject) => {
                child = spawn('/usr/bin/python3', ['-I', '-c', program, archive, destination, bundled, ...(microsoftRedist ? ['microsoft-redist'] : [])], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
                child.stdout.resume(); child.stderr.on('data', bytes => { errors += bytes.toString().slice(0, Math.max(0, 2048 - errors.length)); });
                child.once('error', reject);
                child.once('close', code => code === 0 ? resolve() : reject(Error(stopping ? 'Cancelled' : 'Archive extraction failed: ' + errors.trim().split('\n').at(-1))));
            });
        } finally { await work.setStop(null).catch(() => {}); }
    } else throw Error('Choose a ZIP, RAR, or 7z archive.');
    await work.checkpoint();
    if (!identityMatches(expected, fileIdentity(archive, 'file')) || !identityMatches(rootIdentity, fileIdentity(destination, 'directory'))) throw Error('The archive or extraction folder changed.');
}
async function extractMicrosoftRedist(archive, destination, work) {
    const packages = require('./proton/prerequisitePackages'), item = packages.recipe('directx-june2010');
    if (packages.hashFile(archive, item.size) !== item.sha256) throw Error('Only the pinned Microsoft DirectX archive can use this extraction recipe.');
    await extract(archive, destination, work, true);
    packages.verifyPayload(destination, item);
}
module.exports = { scan, validate, archiveKind, extract, extractMicrosoftRedist, INSTALLER };
