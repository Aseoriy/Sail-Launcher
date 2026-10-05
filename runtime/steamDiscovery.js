'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_LIBRARY_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_LIBRARIES = 32;
const MAX_MANIFESTS = 5000;
const MAX_ISSUES = 32;
const APP_ID = /^[1-9]\d{0,9}$/;

function parseKeyValues(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_LIBRARY_BYTES) throw new Error('Steam metadata is too large.');
    let offset = 0;
    let tokens = 0;
    function next() {
        while (offset < text.length) {
            if (/\s/.test(text[offset])) { offset++; continue; }
            if (text.startsWith('//', offset)) {
                const end = text.indexOf('\n', offset + 2);
                offset = end < 0 ? text.length : end + 1;
                continue;
            }
            break;
        }
        if (offset === text.length) return null;
        if (++tokens > 50000) throw new Error('Too many Steam metadata tokens.');
        const first = text[offset++];
        if (first === '{' || first === '}') return { kind: first };
        let value = '';
        if (first === '"') {
            let closed = false;
            while (offset < text.length) {
                const character = text[offset++];
                if (character === '"') { closed = true; break; }
                if (character === '\\' && offset < text.length && ['\\', '"'].includes(text[offset])) {
                    value += text[offset++];
                } else {
                    value += character;
                }
                if (value.length > 4096) throw new Error('Steam metadata token is too long.');
            }
            if (!closed) throw new Error('Unterminated Steam metadata string.');
        } else {
            value = first;
            while (offset < text.length && !/[\s{}]/.test(text[offset])) {
                if (text[offset] === '"') throw new Error('Invalid Steam metadata token.');
                value += text[offset++];
                if (value.length > 4096) throw new Error('Steam metadata token is too long.');
            }
        }
        if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid Steam metadata token.');
        return { kind: 'text', value };
    }
    let lookahead = next();
    function take() { const value = lookahead; lookahead = next(); return value; }
    function object(depth, nested) {
        if (depth > 16) throw new Error('Steam metadata nesting is too deep.');
        const result = Object.create(null);
        const keys = new Set();
        while (lookahead !== null && lookahead.kind !== '}') {
            const key = take();
            if (key.kind !== 'text' || !key.value || lookahead === null || lookahead.kind === '}') throw new Error('Invalid Steam metadata pair.');
            if (keys.has(key.value.toLowerCase())) throw new Error('Duplicate Steam metadata key.');
            keys.add(key.value.toLowerCase());
            if (lookahead.kind === '{') { take(); result[key.value] = object(depth + 1, true); }
            else result[key.value] = take().value;
        }
        if (nested) {
            if (lookahead === null || lookahead.kind !== '}') throw new Error('Unclosed Steam metadata object.');
            take();
        } else if (lookahead !== null) throw new Error('Unexpected Steam metadata close.');
        return result;
    }
    return object(0, false);
}

async function readMetadata(filePath, limit) {
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('Steam metadata file is invalid or too large.');
        const bytes = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < bytes.length) {
            const result = await handle.read(bytes, length, bytes.length - length, length);
            if (!result.bytesRead) break;
            length += result.bytesRead;
        }
        if (length > limit) throw new Error('Steam metadata file changed or is too large.');
        return parseKeyValues(bytes.toString('utf8', 0, length).replace(/^\uFEFF/, ''));
    } finally { await handle.close(); }
}

async function steamAppsPath(library) {
    const apps = path.join(library, 'steamapps');
    if (await fs.promises.realpath(apps) !== apps) throw new Error('Linked Steam metadata directory is outside its library.');
    return apps;
}

function field(object, name) {
    if (!object || typeof object !== 'object') return undefined;
    const key = Object.keys(object).find(item => item.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : object[key];
}

async function discoverSteamInstallations({ home = os.homedir(), roots } = {}) {
    const issues = [];
    let issueCount = 0;
    const issue = message => { issueCount++; if (issues.length < MAX_ISSUES) issues.push(message); };
    const candidates = roots || [path.join(home, '.steam', 'steam'), path.join(home, '.steam', 'root'),
        path.join(home, '.local', 'share', 'Steam'), path.join(home, '.steam', 'debian-installation'),
        path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam')];
    const libraries = new Set();
    const dataRoots = new Set();
    async function addLibrary(candidate) {
        if (!path.isAbsolute(candidate) || libraries.size >= MAX_LIBRARIES) { issue('A Steam library path is invalid or exceeds the scan limit.'); return; }
        try {
            const real = await fs.promises.realpath(candidate);
            if (!(await fs.promises.stat(real)).isDirectory()) throw new Error();
            libraries.add(real);
        } catch (error) { issue('A configured Steam library is unavailable.'); }
    }
    for (const candidate of candidates.slice(0, MAX_LIBRARIES)) {
        try {
            const real = await fs.promises.realpath(candidate);
            if (!(await fs.promises.stat(real)).isDirectory() || dataRoots.has(real)) continue;
            dataRoots.add(real);
            await addLibrary(real);
            let entries;
            try { entries = field(await readMetadata(path.join(await steamAppsPath(real), 'libraryfolders.vdf'), MAX_LIBRARY_BYTES), 'libraryfolders'); }
            catch (error) { if (error.code !== 'ENOENT') issue('Steam library configuration could not be read.'); continue; }
            if (!entries || typeof entries !== 'object') { issue('Steam library configuration is malformed.'); continue; }
            for (const [index, value] of Object.entries(entries)) {
                if (!/^\d{1,3}$/.test(index)) continue;
                const configured = typeof value === 'string' ? value : field(value, 'path');
                if (typeof configured !== 'string') { issue('A configured Steam library has no path.'); continue; }
                await addLibrary(configured);
            }
        } catch (error) { if (error.code !== 'ENOENT') issue('A Steam data root is unavailable.'); }
    }
    return { libraries: [...libraries], dataRootsFound: dataRoots.size, issues, issueCount };
}

async function discoverSteamLibraries(options = {}) {
    const discovery = await discoverSteamInstallations(options);
    const { libraries, issues, dataRootsFound } = discovery;
    let issueCount = discovery.issueCount;
    const issue = message => { issueCount++; if (issues.length < MAX_ISSUES) issues.push(message); };
    const games = [];
    const seen = new Set();
    let manifestCount = 0;
    for (const library of libraries) {
        let apps;
        try { apps = await steamAppsPath(library); }
        catch (error) { issue('A Steam library metadata directory is unavailable or linked elsewhere.'); continue; }
        let directory;
        try { directory = await fs.promises.opendir(apps); }
        catch (error) { issue('A Steam library cannot be enumerated.'); continue; }
        let entryCount = 0;
        try {
            for await (const entry of directory) {
                if (++entryCount > 20000) { issue('A Steam library has too many entries.'); break; }
                const match = /^appmanifest_([1-9]\d{0,9})\.acf$/.exec(entry.name);
                if (!match) continue;
                if (++manifestCount > MAX_MANIFESTS) { issue('Steam manifest scan limit reached.'); break; }
                if (!entry.isFile()) { issue('A Steam manifest is not a regular file.'); continue; }
                try {
                    const state = field(await readMetadata(path.join(apps, entry.name), MAX_MANIFEST_BYTES), 'AppState');
                    const appId = field(state, 'appid');
                    const name = field(state, 'name');
                    const installDir = field(state, 'installdir');
                    if (appId !== match[1] || !APP_ID.test(appId) || typeof name !== 'string' || !name.trim()
                        || typeof installDir !== 'string' || !installDir || installDir === '.' || installDir === '..'
                        || /[/\\\u0000-\u001f\u007f]/.test(installDir)) throw new Error('Invalid Steam app metadata.');
                    const common = path.join(apps, 'common');
                    const commonStat = await fs.promises.lstat(common);
                    if (!commonStat.isDirectory()) throw new Error('Steam app directory is linked or unavailable.');
                    const installed = await fs.promises.lstat(path.join(common, installDir));
                    if (!installed.isDirectory()) throw new Error('Steam app files are unavailable.');
                    if (seen.has(appId) || appId === '228980') continue;
                    seen.add(appId);
                    games.push({ name: name.trim().slice(0, 160), steamAppId: appId, platform: 'steam' });
                } catch (error) { issue('A Steam app manifest is malformed or its install directory is unavailable.'); }
            }
        } catch (error) { issue('A Steam library scan was interrupted.'); }
        if (manifestCount > MAX_MANIFESTS) break;
    }
    return { games, issues, issueCount, dataRootsFound };
}

module.exports = { parseKeyValues, discoverSteamLibraries, discoverSteamInstallations };
