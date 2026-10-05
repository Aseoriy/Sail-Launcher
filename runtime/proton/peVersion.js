'use strict';
const fs = require('node:fs');
const { fileIdentity, identityMatches } = require('../../security/capabilityStore');

// Read RT_VERSION/VS_FIXEDFILEINFO as bounded data; never load the executable.
// https://learn.microsoft.com/en-us/windows/win32/menurc/vs-versioninfo
function fileVersion(file, { expected = null } = {}) {
    if (fs.realpathSync(file) !== file) throw Error('A component file or folder changed.');
    const identity = fileIdentity(file, 'file');
    if (expected && !identityMatches(expected, identity)) throw Error('The component identity changed.');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || (process.getuid && before.uid !== process.getuid()) || !identityMatches(identity, {
            ...identity, dev: String(before.dev), ino: String(before.ino), birthtimeMs: Math.round(before.birthtimeMs || 0),
            size: before.size, mtimeMs: Math.round(before.mtimeMs || 0) })) throw Error('The component changed before reading.');
        let budget = 2 * 1024 ** 2;
        const read = (offset, size) => {
            if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0
                || offset + size > before.size || size > budget) throw Error('Component version data exceeds its bounds.');
            budget -= size; const bytes = Buffer.alloc(size);
            if (fs.readSync(fd, bytes, 0, size, offset) !== size) throw Error('Component version data is incomplete.');
            return bytes;
        };
        const head = read(0, Math.min(4096, before.size));
        if (head.length < 64 || head.readUInt16LE(0) !== 0x5a4d) throw Error('Invalid component image.');
        const peOffset = head.readUInt32LE(60);
        if (peOffset < 64 || peOffset > 16 * 1024 ** 2) throw Error('Invalid component header.');
        const pe = read(peOffset, 24), count = pe.readUInt16LE(6), size = pe.readUInt16LE(20);
        if (pe.readUInt32LE(0) !== 0x4550 || !count || count > 96 || size < 96 || size > 4096) throw Error('Invalid component sections.');
        const optional = read(peOffset + 24, size), magic = optional.readUInt16LE(0), x64 = magic === 0x20b;
        if (![0x10b, 0x20b].includes(magic) || pe.readUInt16LE(4) !== (x64 ? 0x8664 : 0x14c)) throw Error('Invalid component architecture.');
        const dirs = x64 ? 112 : 96, numOffset = x64 ? 108 : 92;
        if (size < dirs) throw Error('Incomplete component directories.');
        const num = optional.readUInt32LE(numOffset);
        if (num > 16 || dirs + num * 8 > size) throw Error('Invalid component directories.');
        const raw = read(peOffset + 24 + size, count * 40), sections = [];
        for (let i = 0; i < count; i++) {
            const s = { rva: raw.readUInt32LE(i * 40 + 12), size: raw.readUInt32LE(i * 40 + 16), offset: raw.readUInt32LE(i * 40 + 20) };
            if (s.offset + s.size > before.size) throw Error('A component section exceeds its image.');
            sections.push(s);
        }
        const map = (rva, length) => {
            const matches = sections.filter(s => rva >= s.rva && rva + length <= s.rva + s.size);
            if (!rva || rva + length > 0x100000000 || matches.length !== 1) throw Error('Ambiguous component resource address.');
            return matches[0].offset + rva - matches[0].rva;
        };
        let version = '';
        if (num > 2) {
            const rva = optional.readUInt32LE(dirs + 16), length = optional.readUInt32LE(dirs + 20);
            if (!!rva !== !!length || length > 1024 ** 2) throw Error('Invalid component resource directory.');
            if (rva) {
                const base = map(rva, length), seen = new Set(); let entries = 0;
                const resource = (offset, amount) => {
                    if (offset + amount > length) throw Error('Incomplete component resource.');
                    return read(base + offset, amount);
                };
                const directory = offset => {
                    if (seen.has(offset)) throw Error('Repeated component resource directory.');
                    seen.add(offset); const header = resource(offset, 16), n = header.readUInt16LE(12) + header.readUInt16LE(14);
                    if ((entries += n) > 256) throw Error('Too many component resources.');
                    const table = resource(offset + 16, n * 8);
                    return Array.from({ length: n }, (_, i) => ({ id: table.readUInt32LE(i * 8), target: table.readUInt32LE(i * 8 + 4) }));
                };
                const types = directory(0).filter(entry => entry.id === 16), versions = new Set();
                if (types.length > 1) throw Error('Ambiguous component version resource.');
                for (const type of types) {
                    if (!(type.target & 0x80000000)) throw Error('Invalid version resource type.');
                    const names = directory(type.target & 0x7fffffff).filter(entry => entry.id === 1);
                    if (names.length > 1) throw Error('Ambiguous component version name.');
                    for (const name of names) {
                        if (!(name.target & 0x80000000)) throw Error('Invalid version resource name.');
                        const languages = directory(name.target & 0x7fffffff);
                        if (new Set(languages.map(entry => entry.id)).size !== languages.length || languages.some(entry => entry.id > 0xffff)) throw Error('Invalid version languages.');
                        // VC 2010 has a neutral package version and a localized
                        // setup-engine version. Use the neutral file record.
                        const neutral = languages.filter(entry => entry.id === 0);
                        for (const language of neutral.length ? neutral : languages) {
                            if (language.target & 0x80000000) throw Error('Invalid version resource language.');
                            const data = resource(language.target, 16), amount = data.readUInt32LE(4);
                            if (amount < 92 || amount > 65536) throw Error('Invalid fixed version size.');
                            const bytes = read(map(data.readUInt32LE(0), amount), amount);
                            if (bytes.readUInt16LE(0) > amount || bytes.readUInt16LE(0) < 92 || bytes.readUInt16LE(2) !== 52
                                || bytes.readUInt16LE(4) !== 0 || bytes.subarray(6, 38).toString('utf16le') !== 'VS_VERSION_INFO\0'
                                || bytes.readUInt32LE(40) !== 0xfeef04bd || bytes.readUInt32LE(44) !== 0x10000) throw Error('Invalid fixed version record.');
                            const ms = bytes.readUInt32LE(48), ls = bytes.readUInt32LE(52);
                            versions.add([ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.'));
                        }
                    }
                }
                if (versions.size > 1) throw Error('Conflicting component file versions.');
                version = [...versions][0] || '';
            }
        }
        const after = fs.fstatSync(fd);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || fs.realpathSync(file) !== file || !identityMatches(identity, fileIdentity(file, 'file'))) throw Error('The component changed during reading.');
        return { version, arch: x64 ? 'x64' : 'x86', dll: !!(pe.readUInt16LE(22) & 0x2000), builtin: /wine builtin dll/i.test(head.toString('latin1')) };
    } finally { fs.closeSync(fd); }
}
module.exports = { fileVersion };
