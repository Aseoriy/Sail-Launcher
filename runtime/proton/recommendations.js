'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { fileIdentity, identityMatches } = require('../../security/capabilityStore');
const native = require('../native/protocol');
const { validateWindowsExecutable } = require('./executable');
const { discover } = require('./prerequisites');
const { parseKeyValues } = require('../steamDiscovery');

function openedMatches(identity, stat) {
    return stat.isFile() && identityMatches(identity, { ...identity, dev: String(stat.dev), ino: String(stat.ino),
        birthtimeMs: Math.round(stat.birthtimeMs || 0), size: stat.size, mtimeMs: Math.round(stat.mtimeMs || 0) });
}

// Read PE import names as data. Never load a game DLL or execute installscript
// commands. Layout: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
function imports(file, options) {
    const identity = validateWindowsExecutable(file, options), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(fd); let budget = 2 * 1024 ** 2;
        if (!openedMatches(identity, before)) throw Error('The executable changed while checking components.');
        const read = (offset, length) => {
            if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > before.size || length < 0 || length > budget) throw Error('Import data is incomplete or too large.');
            budget -= length; const bytes = Buffer.alloc(length);
            if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw Error('Import data changed while reading.');
            return bytes;
        };
        const peOffset = read(0, 64).readUInt32LE(60), header = read(peOffset, 24);
        const count = header.readUInt16LE(6), size = header.readUInt16LE(20);
        if (!count || count > 96 || size < 96 || size > 4096) throw Error('Unsupported import header.');
        const optional = read(peOffset + 24, size), x64 = optional.readUInt16LE(0) === 0x20b;
        if (header.readUInt16LE(4) !== (x64 ? 0x8664 : 0x14c)) throw Error('The image architecture is inconsistent.');
        const dirs = x64 ? 112 : 96, numOffset = x64 ? 108 : 92;
        if (size < dirs || optional.readUInt32LE(numOffset) > 16) throw Error('Unsupported import directories.');
        const dirCount = optional.readUInt32LE(numOffset), headerSize = optional.readUInt32LE(60);
        if (dirs + dirCount * 8 > size || headerSize > before.size) throw Error('Import directories are incomplete.');
        const sectionBytes = read(peOffset + 24 + size, count * 40), sections = [];
        for (let i = 0; i < count; i++) {
            const start = i * 40, section = { rva: sectionBytes.readUInt32LE(start + 12), size: sectionBytes.readUInt32LE(start + 16), offset: sectionBytes.readUInt32LE(start + 20) };
            if (section.offset + section.size > before.size) throw Error('An import section exceeds the image.');
            sections.push(section);
        }
        const mapped = (rva, length) => {
            if (!Number.isSafeInteger(rva) || rva <= 0 || rva + length > 0x100000000) throw Error('Invalid import address.');
            const matches = sections.filter(s => rva >= s.rva && rva + length <= s.rva + s.size);
            if (rva + length <= headerSize) matches.push({ rva: 0, offset: 0, size: headerSize });
            if (matches.length !== 1) throw Error('An import address cannot be mapped unambiguously.');
            return { offset: matches[0].offset + rva - matches[0].rva, remaining: matches[0].size - (rva - matches[0].rva) };
        };
        const directory = index => index < dirCount ? { rva: optional.readUInt32LE(dirs + index * 8), size: optional.readUInt32LE(dirs + index * 8 + 4) } : { rva: 0, size: 0 };
        const names = new Set();
        for (const [index, width, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
            const table = directory(index); if (!table.rva && !table.size) continue;
            if (!table.rva || table.size < width || table.size > 129 * width) throw Error('Too many or incomplete DLL imports.');
            const bytes = read(mapped(table.rva, table.size).offset, table.size); let ended = false;
            for (let i = 0; i + width <= bytes.length; i += width) {
                const entry = bytes.subarray(i, i + width);
                if (entry.every(byte => byte === 0)) { ended = true; break; }
                if (names.size >= 128) throw Error('Too many imported DLL names.');
                let rva = entry.readUInt32LE(nameOffset);
                if (index === 13) {
                    const attributes = entry.readUInt32LE(0); if (attributes & ~1) throw Error('Unsupported delayed import attributes.');
                    if (!(attributes & 1)) {
                        const imageBase = x64 ? optional.readBigUInt64LE(24) : BigInt(optional.readUInt32LE(28));
                        const relative = BigInt(rva) - imageBase; if (relative <= 0n || relative > 0xffffffffn) throw Error('Unsupported delayed import pointer.');
                        rva = Number(relative);
                    }
                }
                const location = mapped(rva, 1), name = read(location.offset, Math.min(256, location.remaining));
                const end = name.indexOf(0); if (end < 1) throw Error('An imported DLL name is incomplete.');
                const value = name.toString('latin1', 0, end).toLowerCase();
                if (!/^[a-z0-9_.+-]+\.dll$/.test(value)) throw Error('An imported DLL name is unsupported.');
                names.add(value);
            }
            if (!ended) throw Error('The DLL import table is incomplete.');
        }
        const after = fs.fstatSync(fd);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || !identityMatches(identity, fileIdentity(file, 'file'))) throw Error('The executable changed while checking components.');
        return { arch: x64 ? 'x64' : 'x86', names: [...names].sort(), managed: directory(14).rva !== 0 };
    } finally { fs.closeSync(fd); }
}

function recommendations(details, options = {}, extraRoots = []) {
    const reasons = new Map(), warnings = [], evidence = [], guidance = new Map(), add = (id, reason) => {
        if (!reasons.has(id)) reasons.set(id, new Set()); reasons.get(id).add(reason);
    };
    const advise = (id, title, detail) => { if (!guidance.has(id)) guidance.set(id, { id, title, detail }); };
    const dotnet = () => advise('dotnet', '.NET setup', 'Check the game’s instructions for the required .NET version. Sail cannot install it automatically yet. A compatible official Windows installer can be selected with Run Windows installer for this game; installing .NET on Linux does not add it to this Windows environment.');
    const legacyHint = value => {
        // Generic vcredist names occur in several incompatible generations.
        // Require an explicit year directory in local metadata for this hint.
        if (/^(?:https?:|[a-z]+:\/\/)/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
        const match = /(?:^|[\\/])(?:vcredist|vc|visualc\+\+)[\\/](2010|2012|2013)[\\/](?:[^\\/]+[\\/])*vcredist[_\.](x86|x64)\.exe$/i.exec(value)
            || /(?:^|[\\/])vcredist[_-](2010|2012|2013)[\\/](?:[^\\/]+[\\/])*vcredist[_\.](x86|x64)\.exe$/i.exec(value);
        if (match) { add(`vcrun${match[1]}-${match[2].toLowerCase()}`, `Local installation metadata lists Visual C++ ${match[1]} (${match[2].toLowerCase()}).`); return true; }
        return false;
    };
    let image = null;
    try {
        image = imports(details.executablePath, { ...options, expected: details.executableIdentity });
        evidence.push({ image });
        for (const name of image.names) {
            if (/^(?:msvcp140(?:_\d+|_atomic_wait|_codecvt_ids)?|vcruntime140(?:_\d+)?|concrt140|vcomp140)\.dll$/.test(name)) add('vcrun-' + image.arch, 'The executable imports Visual C++ v14 DLLs.');
            if (/^(?:d3dx(?:9_\d+|10_\d+|11_\d+)|d3dcompiler_(?:3[3-9]|4[0-3])|xinput1_[1-3]|xaudio2_[0-7]|xapofx1_[0-5])\.dll$/.test(name)) add('directx-june2010', 'The executable imports legacy DirectX DLLs.');
            const legacy = /^(?:msvcr|msvcp|vcomp|vcamp|vccorlib|mfc)(100|110|120)(?:u)?\.dll$/.exec(name);
            if (legacy) add(`vcrun${{ 100: 2010, 110: 2012, 120: 2013 }[legacy[1]]}-${image.arch}`, `The executable imports Visual C++ ${{ 100: 2010, 110: 2012, 120: 2013 }[legacy[1]]} DLLs.`);
            if (/^(?:msvcr|msvcp|vcomp|mfc)(?:7\d|8\d|9\d)(?:u)?\.dll$/.test(name)) {
                warnings.push('Visual C++ 2008 or earlier needs manual setup.');
                advise('older-vc', 'Older Visual C++', 'Use the exact runtime version requested by the game. Visual C++ v14 does not replace Visual C++ 2008 or earlier. Sail does not automate these versions yet; use Run Windows installer with a compatible official Microsoft package.');
            }
            if (/^openal32\.dll$/.test(name)) advise('openal', 'OpenAL audio', 'The game imports OpenAL. If audio or startup fails, check its bundled setup or instructions and select a compatible Windows OpenAL installer with Run Windows installer. Sail does not automate this component yet.');
            if (/^physx(?:loader|3|3common|3cooking|3characterkinematic)(?:_x(?:86|64))?\.dll$/.test(name)) advise('physx', 'PhysX', 'Check the game’s bundled PhysX installer or instructions for the required version. Use Run Windows installer for compatible Windows packages; Sail does not automate PhysX setup yet.');
        }
        if (image.managed || image.names.includes('mscoree.dll')) { warnings.push('.NET dependencies need manual setup.'); dotnet(); }
    } catch (_) { warnings.push('Some executable dependencies could not be read. You can choose components in Manage Game.'); evidence.push({ importsUnavailable: true }); }
    const roots = [...new Set([path.dirname(details.executablePath), details.workingDirectory, ...extraRoots])];
    for (const root of roots.slice(0, 4)) {
        native.validateWorkingDirectory(root, options);
        const bundled = discover({ executablePath: details.executablePath, workingDirectory: root, fixtureRoot: options.fixtureRoot });
        for (const item of bundled.candidates) {
            const name = path.basename(item.executable.realPath).toLowerCase();
            const id = item.recipeId || (item.kind === 'directx' ? 'directx-june2010' : 'vcrun-' + (name.includes('x86') ? 'x86' : 'x64'));
            add(id, 'A supported bundled installer was found; Sail can obtain the component from Microsoft.');
            evidence.push({ bundled: item.executable });
        }
        if (bundled.truncated || bundled.issues.length) warnings.push('Some bundled setup files could not be checked.');
        const file = path.join(root, 'installscript.vdf');
        if (!fs.existsSync(file)) continue;
        try {
            if (fs.realpathSync(file) !== file) throw Error('Linked install metadata.');
            const identity = fileIdentity(file, 'file'), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); let bytes;
            try {
                const before = fs.fstatSync(fd); if (!openedMatches(identity, before) || before.size > 65536) throw Error('Changed or oversized install metadata.');
                bytes = Buffer.alloc(before.size + 1); const count = fs.readSync(fd, bytes, 0, bytes.length, 0); if (count !== before.size) throw Error('Install metadata changed.');
                bytes = bytes.subarray(0, count); const after = fs.fstatSync(fd);
                if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !identityMatches(identity, fileIdentity(file, 'file'))) throw Error('Install metadata changed.');
            } finally { fs.closeSync(fd); }
            const metadata = parseKeyValues(bytes.toString('utf8')); let visited = 0;
            const walk = value => {
                if (++visited > 512) throw Error('Too many install metadata fields.');
                if (value && typeof value === 'object') { for (const [key, child] of Object.entries(value)) { walk(key); walk(child); } }
                else if (typeof value === 'string') {
                    if (legacyHint(value)) return;
                    if (/(?:^|[\\/])vc_redist\.x86\.exe$/i.test(value)) add('vcrun-x86', 'Local installation metadata lists Visual C++ (x86).');
                    if (/(?:^|[\\/])vc_redist\.x64\.exe$/i.test(value)) add('vcrun-x64', 'Local installation metadata lists Visual C++ (x64).');
                    if (/(?:^|[\\/])dxsetup\.exe$/i.test(value)) add('directx-june2010', 'Local installation metadata lists legacy DirectX.');
                    if (/(?:^|[\\/])(?:dotnetfx[^\\/]*|ndp\d[^\\/]*|dotnet-runtime-[^\\/]+|windowsdesktop-runtime-[^\\/]+)\.exe$/i.test(value)) dotnet();
                    if (/(?:^|[\\/])vcredist[_\.](x86|x64)\.exe$/i.test(value)) advise('ambiguous-vc', 'Unidentified Visual C++ installer', 'Local metadata lists a generic vcredist installer without a supported version. Sail cannot choose a runtime from that name alone. Check the game’s instructions or choose the installer manually.');
                }
            };
            walk(metadata); evidence.push({ metadata: identity, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
        } catch (_) { warnings.push('Local installation metadata could not be checked.'); evidence.push({ metadataUnavailable: file }); }
    }
    return { reasons: Object.fromEntries([...reasons].map(([id, values]) => [id, [...values]])), warnings: [...new Set(warnings)], guidance: [...guidance.values()], evidence };
}
module.exports = { imports, recommendations };
