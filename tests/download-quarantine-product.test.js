'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DownloadJobDirectoryRegistry } = require('../runtime/downloadJobCleanup');
const { createDownloadCancellationHandler } = require('../runtime/downloadIpc');
const {
    DownloadQuarantineCatalog,
    registerDownloadQuarantineIpc
} = require('../runtime/downloadQuarantine');
const DownloadQuarantineUi = require('../ui/downloadQuarantine');

function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-quarantine-product-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const catalogPath = path.join(root, 'userData', 'download-quarantine-roots.json');
    const catalog = new DownloadQuarantineCatalog({ catalogPath, ...(options.catalogOptions || {}) });
    const registry = new DownloadJobDirectoryRegistry({ quarantineCatalog: catalog, ...(options.registryOptions || {}) });
    return { root, catalogPath, catalog, registry, downloadRoot: path.join(root, 'downloads') };
}

function cancellationHandler(registry) {
    return createDownloadCancellationHandler({
        registry,
        activeDownloads: new Map(),
        pendingBrowserDownloads: new Map(),
        retryDelays: []
    });
}

test('production cancellation reports clean only when no staging data was created', async t => {
    const env = fixture(t);
    const job = env.registry.begin('clean-status', { gameName: 'Clean Status', defaultRoot: env.downloadRoot });
    const result = await cancellationHandler(env.registry)({}, job.id, { deleteFolder: true, path: env.root });
    assert.deepEqual(result, { status: 'cancelled_clean', retained: false });
    assert.equal(fs.existsSync(job.directory), false);
    assert.equal(DownloadQuarantineUi.cancellationMessage(result), 'Download cancelled. No temporary files were created.');
});

test('production cancellation reports retained quarantine truthfully', async t => {
    const env = fixture(t);
    const job = env.registry.begin('retained-status', { gameName: 'Retained Status', defaultRoot: env.downloadRoot });
    await env.registry.ensureDirectory(job);
    await env.registry.setState(job, 'downloading');
    fs.writeFileSync(path.join(job.directory, 'partial.bin'), Buffer.alloc(257));

    const result = await cancellationHandler(env.registry)({}, job.id);
    assert.deepEqual(result, { status: 'cancelled_quarantined', retained: true });
    assert.equal(DownloadQuarantineUi.cancellationMessage(result), 'Download cancelled. Temporary files were retained in quarantine for safety.');
    assert.equal(fs.existsSync(job.quarantinePath), true);
    assert.equal(fs.existsSync(job.directory), false);
});

test('retained quarantine remains discoverable after restart without reconstructing a job', async t => {
    const env = fixture(t);
    const job = env.registry.begin('restart-retained', { gameName: 'Restart Retained', defaultRoot: env.downloadRoot });
    await env.registry.ensureDirectory(job);
    await env.registry.setState(job, 'processing');
    fs.writeFileSync(path.join(job.directory, 'partial.bin'), Buffer.alloc(4096));
    await cancellationHandler(env.registry)({}, job.id);

    const restarted = new DownloadQuarantineCatalog({ catalogPath: env.catalogPath });
    const summary = restarted.summarize();
    assert.equal(summary.itemCount, 1);
    assert.equal(summary.totalBytes, 4096);
    assert.equal(typeof summary.latestAt, 'string');
    assert.equal(fs.existsSync(job.quarantinePath), true);
    assert.equal(new DownloadJobDirectoryRegistry().get(job.id), null);
});

test('production quarantine IPC opens only a current opaque canonical-root token', async t => {
    const env = fixture(t);
    const job = env.registry.begin('open-root', { gameName: 'Open Root', defaultRoot: env.downloadRoot });
    await env.registry.ensureDirectory(job);
    await env.registry.setState(job, 'paused');
    fs.writeFileSync(path.join(job.directory, 'partial.bin'), 'keep');
    await cancellationHandler(env.registry)({}, job.id);

    const handlers = new Map();
    const opened = [];
    registerDownloadQuarantineIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
        catalog: env.catalog,
        shell: { openPath: async target => { opened.push(target); return ''; } }
    });
    const summary = await handlers.get('get-download-quarantine-summary')({}, { path: env.root });
    assert.equal(summary.itemCount, 1);
    assert.equal(await handlers.get('open-download-quarantine')({}, env.root).then(result => result.status), 'open_refused');
    assert.equal(await handlers.get('open-download-quarantine')({}, job.quarantinePath).then(result => result.status), 'open_refused');
    assert.equal(opened.length, 0);
    assert.equal(await handlers.get('open-download-quarantine')({}, summary.roots[0].id).then(result => result.status), 'opened');
    assert.deepEqual(opened, [fs.realpathSync.native(job.quarantineRoot)]);
});

test('bounded quarantine enumeration tolerates inaccessible entries and never follows links', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-quarantine-bounded-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const quarantineRoot = path.join(root, 'downloads', '.sail-staging', 'quarantine');
    const item = path.join(quarantineRoot, `quarantine-${'a'.repeat(48)}`);
    const locked = path.join(item, 'locked');
    fs.mkdirSync(locked, { recursive: true });
    for (let index = 0; index < 20; index += 1) fs.writeFileSync(path.join(item, `file-${index}.bin`), Buffer.alloc(10));

    const wrappedFs = Object.create(fs);
    let lockedReads = 0;
    wrappedFs.opendirSync = target => {
        if (path.resolve(target) === path.resolve(locked)) {
            lockedReads += 1;
            const error = new Error('locked');
            error.code = 'EACCES';
            throw error;
        }
        return fs.opendirSync(target);
    };
    const catalogPath = path.join(root, 'catalog.json');
    const writer = new DownloadQuarantineCatalog({ catalogPath });
    writer.recordRoot(quarantineRoot);
    const tolerant = new DownloadQuarantineCatalog({ catalogPath, fs: wrappedFs, maxEntries: 100, maxDepth: 3 });
    const tolerantSummary = tolerant.summarize();
    assert.equal(tolerantSummary.itemCount, 1);
    assert.equal(tolerantSummary.partial, true);
    assert.equal(lockedReads, 1);
    assert.equal(tolerantSummary.totalBytes, 200);

    const bounded = new DownloadQuarantineCatalog({ catalogPath, maxEntries: 8, maxDepth: 3 });
    const boundedSummary = bounded.summarize();
    assert.equal(boundedSummary.itemCount, 1);
    assert.equal(boundedSummary.partial, true);
    assert.ok(boundedSummary.totalBytes < 200);
});

test('UI copy never equates retained quarantine with deletion or cleanup success', () => {
    const retained = DownloadQuarantineUi.cancellationMessage({ status: 'cancelled_quarantined', retained: true });
    const refused = DownloadQuarantineUi.cancellationMessage({ status: 'cleanup_refused', retained: true });
    assert.match(retained, /retained in quarantine for safety/i);
    assert.match(refused, /left untouched/i);
    assert.doesNotMatch(`${retained} ${refused}`, /deleted|cleanup succeeded|cleanup completed/i);
});

test('download quarantine production modules contain no recursive pathname deletion call', () => {
    for (const relative of ['runtime/downloadJobCleanup.js', 'runtime/downloadIpc.js', 'runtime/downloadQuarantine.js']) {
        const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
        assert.doesNotMatch(source, /(?:rmSync|rm)\s*\([^)]*recursive\s*:\s*true/s, relative);
    }
});
