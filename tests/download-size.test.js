const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { aggregateDownloadSizes, estimateDownloadTime, formatBytes, parseSize, sourceDownloadSize, torboxSizeWarning, downloadSizeBytes, downloadSizeMismatch } = require('../ui/downloadSizeLogic');

test('formatBytes uses honest binary unit labels and distinguishes unknown from zero', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1024), '1.0 KiB');
    assert.equal(formatBytes(1024 ** 3), '1.0 GiB');
    assert.equal(formatBytes(-1), 'Unknown');
    assert.equal(formatBytes(NaN), 'Unknown');
    assert.equal(formatBytes(undefined), 'Unknown');
    assert.equal(formatBytes(true), 'Unknown');
    assert.equal(formatBytes('   '), 'Unknown');
    assert.equal(formatBytes(1), '1 B');
});

test('parseSize accepts decimal SI units and explicit binary units', () => {
    assert.equal(parseSize('1.2 TB').bytes, 1.2e12);
    assert.equal(parseSize('1.2 GiB').bytes, 1.2 * 1024 ** 3);
    assert.equal(parseSize('12.5 MB').bytes, 12.5e6);
    assert.equal(parseSize('1,234.5 GB').bytes, 1234.5e9);
    assert.equal(parseSize('not a size'), null);
    assert.equal(parseSize('Infinity GB'), null);
    assert.equal(parseSize('-2 GB'), null);
    assert.equal(parseSize('9007199254740993 B'), null);
});

test('small-download confirmation uses strictly below 75 percent, not multipart piece sizes or unknowns', () => {
    assert.deepEqual(downloadSizeMismatch(1000, 749), { reportedBytes: 1000, actualBytes: 749 });
    assert.equal(downloadSizeMismatch(1000, 750), null);
    assert.equal(downloadSizeMismatch(1000, 751), null);
    assert.equal(downloadSizeMismatch(1000, 1200), null);
    for (const invalid of [null, undefined, false, true, '', 'unknown', '4-6 GB', 0, -1, NaN, Infinity]) {
        assert.equal(downloadSizeMismatch(invalid, 100), null);
        assert.equal(downloadSizeMismatch(1000, invalid), null);
    }
    assert.equal(downloadSizeBytes({ bytes: null, label: '68.4 GB', kind: 'Game Size' }), 68.4e9);
    assert.equal(downloadSizeBytes({ bytes: null, label: '~2.0 GiB' }), 2 * 1024 ** 3);
    assert.equal(downloadSizeBytes({ bytes: null, label: '4-6 GB' }), null);
    assert.equal(downloadSizeMismatch(68.4e9, 200e6, 200e6), null);
    assert.equal(downloadSizeMismatch(68.4e9, 201e6, 200e6), null);
    assert.notEqual(downloadSizeMismatch(68.4e9, 20e6, 200e6), null);
});

test('sourceDownloadSize ignores RDR2 memory/storage text and reads explicit download size', () => {
    assert.equal(sourceDownloadSize('Memory: 12 GB RAM\nStorage: 120 GB'), null);
    assert.equal(sourceDownloadSize('Download Size: 113.8 GB').bytes, 113.8e9);
    assert.equal(sourceDownloadSize('Download Size: 123'), null);
    assert.equal(sourceDownloadSize('Download Size: 12 GB RAM'), null);
});

test('sourceDownloadSize preserves ranges/from values without inventing bytes', () => {
    assert.deepEqual(sourceDownloadSize('Download Size: 4.5-6 GB'), { bytes: null, label: '4.5-6 GB', kind: 'Download Size' });
    assert.deepEqual(sourceDownloadSize('Repack Size: from 4.5 GB'), { bytes: null, label: 'from 4.5 GB', kind: 'Repack Size' });
    assert.deepEqual(sourceDownloadSize('Repack Size: ~4.5 GB'), { bytes: null, label: '~4.5 GB', kind: 'Repack Size' });
    assert.deepEqual(sourceDownloadSize('Repack Size: 4.5 GB - 6 GB'), { bytes: null, label: '4.5 GB - 6 GB', kind: 'Repack Size' });
});

test('sourceDownloadSize prioritizes repack/download labels over original or final size', () => {
    const result = sourceDownloadSize('Original Size: 149 GB\nFinal Size: 149 GB\nRepack Size: 78.5 GB');
    assert.equal(result.bytes, 78.5e9);
});

test('sourceDownloadSize accepts explicit table/inline labels and annotated repack sizes', () => {
    assert.equal(sourceDownloadSize('Genre: Action | Download Size: 25 GB').label, '25 GB');
    assert.equal(sourceDownloadSize('Repack Size\n78.5 GB (selective download)').label, '78.5 GB (selective download)');
    assert.equal(sourceDownloadSize('Repack Size: 78.5 GB (selective download)').bytes, null);
    assert.equal(sourceDownloadSize('Download Size: 12 GB (RAM)'), null);
    assert.equal(sourceDownloadSize('Repack Size: 113 GB (installed)'), null);
});

test('SteamRIP Game Size is opt-in source metadata, never required storage or exact mirror bytes', () => {
    const text = 'Memory: 8 GB RAM\nStorage: 150 GB available space\nGame Size: 116 GB';
    assert.equal(sourceDownloadSize(text), null);
    assert.deepEqual(sourceDownloadSize(text, { allowGameSize: true }), { bytes: null, label: '116 GB', kind: 'Game Size' });
    assert.equal(sourceDownloadSize(text + '\nDownload Size: 113 GB', { allowGameSize: true }).kind, 'Download Size');
});

test('estimateDownloadTime requires an exact finite byte count', () => {
    assert.equal(estimateDownloadTime({ bytes: null }), '');
    assert.match(estimateDownloadTime({ bytes: 100e6 }), /10 MB\/s/);
});

test('aggregateDownloadSizes sums complete sets and labels rounded totals as estimates', () => {
    assert.equal(aggregateDownloadSizes([]), null);
    assert.equal(aggregateDownloadSizes([{ sizeBytes: 1000 }, undefined]), null);
    assert.equal(aggregateDownloadSizes([{ status: 'down', sizeBytes: 1000 }]), null);
    assert.equal(aggregateDownloadSizes([{ sizeBytes: true }]), null);
    assert.equal(aggregateDownloadSizes([{ sizeBytes: Number.MAX_SAFE_INTEGER }, { sizeBytes: 1 }]), null);
    assert.deepEqual(aggregateDownloadSizes([{ sizeBytes: 1000 }, { sizeBytes: 2000 }]), { bytes: 3000, label: '2.9 KiB' });
    assert.deepEqual(aggregateDownloadSizes([{ sizeBytes: 1000 }, { sizeLabel: '2 GB' }]), { bytes: null, label: '~1.9 GiB', hostReported: true });
    assert.deepEqual(aggregateDownloadSizes([{ sizeLabel: '2 GB' }, { sizeLabel: '1 GB' }]), { bytes: null, label: '~2.8 GiB', hostReported: true });
    assert.equal(aggregateDownloadSizes([{ sizeLabel: '2 GB' }, { sizeLabel: '' }]), null);
    assert.deepEqual(aggregateDownloadSizes([{ sizeLabel: '78.5 GB' }]), { bytes: null, label: '78.5 GB', hostReported: true });
    assert.equal(aggregateDownloadSizes([{ sizeLabel: '4.5-6 GB' }]), null);
});

test('torboxSizeWarning applies the 100 GiB web limit per supported link', () => {
    const limit = 100 * 1024 ** 3;
    assert.equal(torboxSizeWarning('torbox', [{ url: 'https://datanodes.to/file', sizeBytes: limit }]), '');
    assert.match(torboxSizeWarning('torbox', [{ url: 'https://datanodes.to/file', sizeBytes: limit + 1 }]), /over 100 GB/i);
    assert.match(torboxSizeWarning('torbox', [{ url: 'https://datanodes.to/file', sizeLabel: '113.8 GB' }]), /over 100 GB/i);
    assert.equal(torboxSizeWarning('realdebrid', [{ url: 'https://datanodes.to/file', sizeBytes: limit + 1 }]), '');
    assert.equal(torboxSizeWarning('torbox', [{ url: 'https://datanodes.to/file', sizeLabel: 'unknown' }]), '');
    assert.equal(torboxSizeWarning('torbox', [{ url: 'https://datanodes.to/file', sizeBytes: -1 }]), '');
    assert.equal(torboxSizeWarning('torbox', [{ url: 'https://datanodes.to/file', status: 'down', sizeBytes: limit + 1 }]), '');
    assert.equal(torboxSizeWarning('torbox', [{ url: 'magnet:?xt=urn:btih:test', sizeBytes: limit + 1 }]), '');
    assert.equal(torboxSizeWarning('torbox', [{ url: 'https://example.test/file.torrent', sizeBytes: limit + 1 }]), '');
    assert.equal(torboxSizeWarning('torbox', [{ url: 'https://datanodes.to/a', sizeBytes: 60 * 1024 ** 3 }, { url: 'https://datanodes.to/b', sizeBytes: 60 * 1024 ** 3 }]), '');
    assert.match(torboxSizeWarning('torbox', [{ url: 'https://datanodes.to/folder', sizeLabel: '113.8 GB' }]), /over 100 GB/i);
});

test('production multipart progress keeps percentages, bytes, and ETA scoped to the current file', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = main.indexOf("const progressState = p.phase === 'starting'");
    const end = main.indexOf('\n                            });', start);
    assert.ok(start >= 0 && end > start);
    const events = [];
    const callback = vm.runInNewContext(`p => { ${main.slice(start, end)} }); }`, {
        wc: { send: (channel, value) => events.push({ channel, value }) }, id: 'test',
        sourceTotal: 3, sourceIndex: 1, sourceFiles: [{}, {}], resolvedIndex: 0,
        expandedLabel: 'Part 2/3', attempt: 1, file: {}
    });
    callback({ phase: 'downloading', percent: 10, downloaded: '1GiB', total: '10GiB', speed: '1MiB', eta: '9m' });
    const progress = events[0].value;
    assert.equal(progress.percent, 10);
    assert.equal(progress.progressScope, 'file');
    assert.equal(progress.part, 2);
    assert.equal(progress.partCount, 3);
    assert.equal(progress.file, 1);
    assert.equal(progress.fileCount, 2);
    assert.equal(progress.downloaded, '1GiB');
    assert.equal(progress.total, '10GiB');
    assert.equal(progress.eta, '9m');
});
