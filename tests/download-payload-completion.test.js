'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function extractFunction(source, marker) {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `Missing production function: ${marker}`);
    // postProcessDownloadBody is immediately followed by this stable section marker. Using it
    // avoids treating brace characters in regular-expression literals as function delimiters.
    const sectionEnd = source.indexOf('// Generic repair bundles are not game payloads.', start);
    if (sectionEnd > start) return source.slice(start, sectionEnd).trim();
    const brace = source.indexOf('{', start);
    assert.ok(brace >= 0, `Missing function body: ${marker}`);
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = brace; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }
        if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    assert.fail(`Unterminated production function: ${marker}`);
}

const postProcessSource = extractFunction(mainSource, 'async function postProcessDownloadBody(');

function fixture(t, { initialFiles, extractedFiles = [], extractedExePath = '', extractionErrors = [] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-download-payload-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const archivePaths = [];
    for (const file of initialFiles || []) {
        const full = path.join(dir, file.name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, file.contents || 'archive');
        if (file.archive) archivePaths.push(full);
    }

    const scanDownloadedPayload = async (scanDir) => {
        if (path.resolve(scanDir) === path.resolve(dir)) {
            return {
                files: (initialFiles || []).map(file => ({
                    name: file.name,
                    full: path.join(dir, file.name),
                    size: file.size == null ? Buffer.byteLength(file.contents || 'archive') : file.size
                })),
                archives: archivePaths.slice(),
                exePath: ''
            };
        }
        return {
            files: extractedFiles.map(file => ({
                name: file.name,
                full: path.join(dir, '_game', file.name),
                size: file.size == null ? Buffer.byteLength(file.contents || '') : file.size
            })),
            archives: [],
            exePath: extractedExePath ? path.join(dir, '_game', extractedExePath) : ''
        };
    };

    const extractionErrorsByPath = new Set(extractionErrors.map(name => path.join(dir, name)));
    const extractArchive = async (archive, destination) => {
        if (extractionErrorsByPath.has(archive)) throw new Error('fixture extraction failed');
        fs.mkdirSync(destination, { recursive: true });
        for (const file of extractedFiles) {
            const full = path.join(destination, file.name);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, file.contents || 'payload');
        }
        return destination;
    };

    const preparationOperations = [];
    const runDownloadPreparation = async (operation, operationDir) => {
        preparationOperations.push(operation);
        if (operation === 'delete-archive-sources') {
            for (const archive of archivePaths) {
                try { fs.unlinkSync(archive); } catch (_) {}
            }
        }
        return { directory: operationDir };
    };

    const context = vm.createContext({
        console: { error() {} },
        fs,
        path,
        scanDownloadedPayload,
        runDownloadPreparation,
        extractArchive
    });
    const postProcessDownloadBody = vm.runInContext(
        `(() => { ${postProcessSource}; return postProcessDownloadBody; })()`,
        context
    );
    const work = { checkpoint: async () => {} };
    return { dir, archivePaths, preparationOperations, run: opts => postProcessDownloadBody(dir, opts, work) };
}

function archive(name = 'download.zip') {
    return { name, archive: true, size: 200 * 1024 * 1024, contents: 'valid zip fixture' };
}

test('website/assets-only extraction is not usable and retains the source archive', async t => {
    const env = fixture(t, {
        initialFiles: [archive()],
        extractedFiles: [
            { name: 'INDEX.md', size: 200 * 1024 * 1024 },
            { name: 'RIVAAN-Website-Offline.html', size: 4 * 1024 * 1024 },
            { name: 'Website-Folder/assets/logo.png', size: 20 * 1024 * 1024 },
            { name: 'Instagram-Posts/post-01.png', size: 40 * 1024 * 1024 },
            { name: 'Products/catalog.pdf', size: 80 * 1024 * 1024 }
        ]
    });

    const result = await env.run({ gameName: 'Elden Ring', autoExtract: true, autoAdd: true });

    assert.equal(result.extracted, true);
    assert.equal(result.usable, false);
    assert.equal(result.exePath, '');
    assert.equal(fs.existsSync(env.archivePaths[0]), true, 'invalid payload must retain its archive');
    assert.equal(env.preparationOperations.includes('delete-archive-sources'), false);
});

test('a small extracted Windows game is valid without a size threshold', async t => {
    const env = fixture(t, {
        initialFiles: [archive()],
        extractedFiles: [{ name: 'TinyGame.exe', size: 32 }],
        extractedExePath: 'TinyGame.exe'
    });

    const result = await env.run({ gameName: 'Tiny Game', autoExtract: true, autoAdd: true });

    assert.equal(result.usable, true);
    assert.equal(result.exePath, path.join(env.dir, '_game', 'TinyGame.exe'));
    assert.equal(fs.existsSync(env.archivePaths[0]), false, 'validated payload may remove its source archive');
    assert.equal(env.preparationOperations.includes('delete-archive-sources'), true);
});

test('FitGirl setup and bin payload is valid installer evidence', async t => {
    const env = fixture(t, {
        initialFiles: [archive('fitgirl.rar')],
        extractedFiles: [
            { name: 'setup.exe', size: 32 * 1024 * 1024 },
            { name: 'fg-01.bin', size: 8 }
        ]
    });

    const result = await env.run({ gameName: 'Example Game', autoExtract: true, autoAdd: true });

    assert.equal(result.usable, true);
    assert.equal(result.needsInstall, true);
    assert.equal(result.exePath, path.join(env.dir, '_game', 'setup.exe'));
    assert.equal(fs.existsSync(env.archivePaths[0]), false);
});

test('explicit manual archive mode remains usable and retains its archive', async t => {
    const env = fixture(t, { initialFiles: [archive()] });

    const result = await env.run({ gameName: 'Manual Game', autoExtract: false, autoAdd: true });

    assert.equal(result.extracted, false);
    assert.equal(result.usable, true);
    assert.equal(fs.existsSync(env.archivePaths[0]), true);
    assert.equal(env.preparationOperations.includes('normalize-archives'), false);
    assert.equal(env.preparationOperations.includes('delete-archive-sources'), false);
});

test('partial extraction failure is not usable and retains every source archive', async t => {
    const env = fixture(t, {
        initialFiles: [archive('part-one.zip'), archive('part-two.zip')],
        extractedFiles: [{ name: 'PartialGame.exe', size: 1024 }],
        extractedExePath: 'PartialGame.exe',
        extractionErrors: ['part-two.zip']
    });

    const result = await env.run({ gameName: 'Partial Game', autoExtract: true, autoAdd: true });

    assert.equal(result.extracted, true);
    assert.equal(result.usable, false);
    assert.match(result.warning, /Auto-extract failed/);
    assert.equal(env.archivePaths.every(file => fs.existsSync(file)), true);
    assert.equal(env.preparationOperations.includes('delete-archive-sources'), false);
});
