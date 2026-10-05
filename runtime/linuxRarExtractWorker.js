'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs'), path = require('node:path');
const { createExtractorFromFile } = require('node-unrar-js');
const native = require('./native/protocol');

(async () => {
    const { archive, destination } = workerData;
    native.validateWorkingDirectory(destination);
    if (fs.readdirSync(destination).length) throw Error('Extraction requires an empty folder.');
    const members = new Map(); let bytes = 0, written = 0;
    const name = value => {
        const parts = String(value).replace(/\\/g, '/').split('/');
        if (!value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f:]/.test(value)
            || parts[0] === '' || parts.includes('..') || parts.length > 32) throw Error('Invalid RAR member path.');
        const clean = parts.filter(part => part && part !== '.').join('/');
        if (!clean) throw Error('Empty RAR member path.');
        return clean;
    };
    const extractor = await createExtractorFromFile({ filepath: archive, targetPath: destination });
    const originalOpen = extractor.open.bind(extractor);
    extractor.open = file => {
        const resolved = path.resolve(file), parent = path.dirname(archive);
        if (!native.withinRoot(resolved, parent) || fs.realpathSync(resolved) !== resolved || !fs.lstatSync(resolved).isFile()) throw Error('RAR volume is outside the archive folder.');
        return originalOpen(resolved);
    };
    for (const header of extractor.getFileList().fileHeaders) {
        const key = name(header.name);
        if (members.has(key) || members.size >= 200000 || header.flags.encrypted || !Number.isSafeInteger(header.unpSize)
            || header.unpSize < 0 || (bytes += header.unpSize) > 512 * 1024 ** 3) throw Error('Encrypted, duplicate, or excessive RAR members.');
        members.set(key, header);
    }
    const free = fs.statfsSync(destination); if (!members.size || free.bavail * free.bsize < bytes + 128 * 1024 ** 2) throw Error('Not enough space to extract this archive.');
    for (const key of members.keys()) {
        let parent = path.posix.dirname(key);
        while (parent !== '.') {
            if (members.has(parent) && !members.get(parent).flags.directory) throw Error('A RAR parent is not a directory.');
            parent = path.posix.dirname(parent);
        }
    }
    // Override the library's permissive path/open callbacks. Output is only
    // regular, exclusive files under the empty private extraction directory.
    extractor.create = file => {
        const key = name(file), header = members.get(key);
        if (!header || header.flags.directory) throw Error('RAR tried to write an unlisted file.');
        const target = path.join(destination, key);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        native.validateWorkingDirectory(path.dirname(target));
        const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        extractor.fileMap[fd] = { size: 0, pos: 0, name: key, limit: header.unpSize };
        return fd;
    };
    const originalWrite = extractor.write.bind(extractor);
    extractor.write = (fd, buffer, size) => {
        const item = extractor.fileMap[fd];
        if (!item || item.pos + size > item.limit || (written += size) > 512 * 1024 ** 3) throw Error('RAR exceeds its declared size.');
        return originalWrite(fd, buffer, size);
    };
    let count = 0;
    for (const result of extractor.extract().files) {
        const header = members.get(name(result.fileHeader.name));
        if (!header || result.extraction !== undefined) throw Error('Unexpected RAR extraction result.');
        if (!header.flags.directory && fs.statSync(path.join(destination, name(header.name))).size !== header.unpSize) throw Error('RAR member is incomplete.');
        count++;
    }
    if (count !== members.size) throw Error('RAR extraction is incomplete.');
    parentPort.postMessage({ ok: true, result: { count, bytes } });
})().catch(error => parentPort.postMessage({ ok: false, error: { message: String(error.message || error) } }));
