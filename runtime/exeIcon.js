'use strict';

const fs = require('fs');

// Reads a Windows .exe's main icon (the first icon group, which is what Explorer shows) straight from
// its resources, so it works on Linux too and isn't limited to the 32 px icon app.getFileIcon gives.
// Returns a one-image .ico Buffer (Chromium can draw it), or null when the file has no usable icon.
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;

function readAt(fd, position, length) {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, position);
    return read === length ? buffer : null;
}

function resourceSection(fd) {
    const dos = readAt(fd, 0, 64);
    if (!dos || dos.readUInt16LE(0) !== 0x5a4d) return null;
    const peOffset = dos.readUInt32LE(0x3c);
    const coff = readAt(fd, peOffset, 24);
    if (!coff || coff.readUInt32LE(0) !== 0x00004550) return null;
    const sectionCount = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    const optional = readAt(fd, peOffset + 24, optionalSize);
    if (!optional || optionalSize < 2) return null;
    const magic = optional.readUInt16LE(0);
    const directories = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
    if (directories < 0 || optionalSize < directories + 3 * 8) return null;
    const resourceRva = optional.readUInt32LE(directories + 2 * 8);
    if (!resourceRva) return null;
    const sections = readAt(fd, peOffset + 24 + optionalSize, sectionCount * 40);
    if (!sections) return null;
    for (let index = 0; index < sectionCount; index++) {
        const base = index * 40;
        const virtualAddress = sections.readUInt32LE(base + 12);
        const virtualSize = Math.max(sections.readUInt32LE(base + 8), sections.readUInt32LE(base + 16));
        if (resourceRva < virtualAddress || resourceRva >= virtualAddress + virtualSize) continue;
        const rawSize = sections.readUInt32LE(base + 16);
        if (!rawSize || rawSize > MAX_RESOURCE_BYTES) return null;
        const data = readAt(fd, sections.readUInt32LE(base + 20), rawSize);
        return data ? { data, virtualAddress, rootOffset: resourceRva - virtualAddress } : null;
    }
    return null;
}

// Entries of one resource directory: [{ id, offset, isDirectory }].
function directoryEntries(section, offset) {
    const { data } = section;
    if (offset + 16 > data.length) return [];
    const count = data.readUInt16LE(offset + 12) + data.readUInt16LE(offset + 14);
    const entries = [];
    for (let index = 0; index < count && offset + 16 + index * 8 + 8 <= data.length; index++) {
        const base = offset + 16 + index * 8;
        const name = data.readUInt32LE(base);
        const target = data.readUInt32LE(base + 4);
        entries.push({
            id: name & 0x80000000 ? null : name,
            offset: section.rootOffset + (target & 0x7fffffff),
            isDirectory: !!(target & 0x80000000)
        });
    }
    return entries;
}

// The data of the first language of a resource (type -> name -> language -> data entry).
function firstLeafData(section, entry) {
    let current = entry;
    for (let depth = 0; current && current.isDirectory && depth < 4; depth++) current = directoryEntries(section, current.offset)[0];
    if (!current || current.isDirectory || current.offset + 8 > section.data.length) return null;
    const start = section.data.readUInt32LE(current.offset) - section.virtualAddress;
    const size = section.data.readUInt32LE(current.offset + 4);
    if (start < 0 || !size || start + size > section.data.length) return null;
    return section.data.subarray(start, start + size);
}

function typeEntries(section, type) {
    const root = directoryEntries(section, section.rootOffset).find(entry => entry.id === type && entry.isDirectory);
    return root ? directoryEntries(section, root.offset) : [];
}

function exeIcon(filePath) {
    let fd;
    try {
        fd = fs.openSync(String(filePath || ''), 'r');
        const section = resourceSection(fd);
        if (!section) return null;
        const group = typeEntries(section, RT_GROUP_ICON)[0];
        const groupData = group && firstLeafData(section, group);
        if (!groupData || groupData.length < 6) return null;
        const count = groupData.readUInt16LE(4);
        let best = null;
        for (let index = 0; index < count && 6 + index * 14 + 14 <= groupData.length; index++) {
            const base = 6 + index * 14;
            const item = {
                width: groupData[base] || 256,
                height: groupData[base + 1] || 256,
                colors: groupData[base + 2],
                planes: groupData.readUInt16LE(base + 4),
                bits: groupData.readUInt16LE(base + 6),
                id: groupData.readUInt16LE(base + 12)
            };
            if (!best || item.width > best.width || (item.width === best.width && item.bits > best.bits)) best = item;
        }
        if (!best) return null;
        const iconEntry = typeEntries(section, RT_ICON).find(entry => entry.id === best.id);
        const image = iconEntry && firstLeafData(section, iconEntry);
        if (!image) return null;
        const header = Buffer.alloc(22);
        header.writeUInt16LE(1, 2);
        header.writeUInt16LE(1, 4);
        header[6] = best.width >= 256 ? 0 : best.width;
        header[7] = best.height >= 256 ? 0 : best.height;
        header[8] = best.colors;
        header.writeUInt16LE(best.planes, 10);
        header.writeUInt16LE(best.bits, 12);
        header.writeUInt32LE(image.length, 14);
        header.writeUInt32LE(22, 18);
        return Buffer.concat([header, image]);
    } catch (_) {
        return null;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }
}

module.exports = { exeIcon };
