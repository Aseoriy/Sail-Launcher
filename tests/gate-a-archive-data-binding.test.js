'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const {
    createArchivePowerShellInvocation,
    legacyLocalArtifactStem,
    scopedArtifactStem,
    scopedArtifactStems
} = require('../security/archiveDataBinding');

test('archive PowerShell binding treats imported-name syntax as literal path data', t => {
    if (process.platform !== 'win32') return t.skip('PowerShell archive binding is Windows-only.');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-gate-a-archive-binding-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'Source$(Write-Output changed)`literal');
    const archive = path.join(root, 'Archive$(Write-Output changed)`literal.zip');
    const destination = path.join(root, 'Restore$(Write-Output changed)`literal');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'save.txt'), 'portable metadata stays data');

    const compress = createArchivePowerShellInvocation('compress', source, archive);
    assert.equal(compress.args.join(' ').includes(source), false);
    assert.equal(compress.options.env.SAIL_ARCHIVE_SOURCE, source);
    const compressed = spawnSync(compress.file, compress.args, compress.options);
    assert.equal(compressed.status, 0, compressed.stderr && compressed.stderr.toString());
    assert.equal(fs.existsSync(archive), true);

    const expand = createArchivePowerShellInvocation('expand', archive, destination);
    assert.equal(expand.args.join(' ').includes(destination), false);
    const expanded = spawnSync(expand.file, expand.args, expand.options);
    assert.equal(expanded.status, 0, expanded.stderr && expanded.stderr.toString());
    assert.equal(fs.readFileSync(path.join(destination, 'save.txt'), 'utf8'), 'portable metadata stays data');
});

test('archive storage stems are stable, scoped and independent of product names', () => {
    const base = { profileId: 'profile-a', libraryId: 'library-a', gameId: 'game-a' };
    const stem = scopedArtifactStem(base);
    assert.match(stem, /^sail-[0-9a-f]{24}$/);
    assert.equal(scopedArtifactStem({ ...base }), stem);
    assert.notEqual(scopedArtifactStem({ ...base, gameId: 'game-b' }), stem);
    assert.throws(() => scopedArtifactStem({ ...base, gameId: 'bad\nname' }));
    assert.deepEqual(scopedArtifactStems(base, 'Old Local Game'), [stem, 'Old Local Game']);
    assert.deepEqual(scopedArtifactStems(base, 'C:\\Remote\\Game'), [stem, 'CRemoteGame']);
    assert.equal(legacyLocalArtifactStem('../escape'), null);
    assert.equal(legacyLocalArtifactStem(' trailing'), null);
});
