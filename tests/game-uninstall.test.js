'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
    removeOwnedInstallDirectory,
    strictChildPath
} = require('../runtime/gameUninstall');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-uninstall-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const game = path.join(root, 'Example Game');
    fs.mkdirSync(path.join(game, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(game, 'bin', 'game.exe'), 'game');
    return { root, game };
}

test('owned install removal moves and deletes only the approved game directory', async t => {
    const f = fixture(t);
    const sibling = path.join(f.root, 'Keep Me');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'save.txt'), 'keep');

    const result = await removeOwnedInstallDirectory(f.game, {
        protectedRoots: [f.root],
        idFactory: () => 'fixture'
    });

    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(f.game), false);
    assert.equal(fs.readFileSync(path.join(sibling, 'save.txt'), 'utf8'), 'keep');
});

test('owned install removal rejects roots, protected folders, and linked install folders', async t => {
    const f = fixture(t);
    await assert.rejects(() => removeOwnedInstallDirectory(path.parse(f.root).root), /drive root/i);
    await assert.rejects(() => removeOwnedInstallDirectory(f.root, { protectedRoots: [f.root] }), /protected/i);

    const link = path.join(f.root, 'linked-game');
    try {
        fs.symlinkSync(f.game, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        t.skip(`Directory links are unavailable: ${error.message}`);
        return;
    }
    await assert.rejects(() => removeOwnedInstallDirectory(link), /changed|link/i);
    assert.equal(fs.existsSync(path.join(f.game, 'bin', 'game.exe')), true);
});

test('owned install removal unlinks nested directory links without deleting their targets', async t => {
    const f = fixture(t);
    const outside = path.join(f.root, 'outside-saves');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.sav'), 'keep');
    try {
        fs.symlinkSync(outside, path.join(f.game, 'linked-saves'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        t.skip(`Directory links are unavailable: ${error.message}`);
        return;
    }
    await removeOwnedInstallDirectory(f.game, { idFactory: () => 'nested-link' });
    assert.equal(fs.readFileSync(path.join(outside, 'keep.sav'), 'utf8'), 'keep');
});

test('strict child checks reject equality and parent escapes', () => {
    const root = path.resolve('C:\\SailDownloads');
    assert.equal(strictChildPath(root, path.join(root, 'Game')), true);
    assert.equal(strictChildPath(root, root), false);
    assert.equal(strictChildPath(root, path.dirname(root)), false);
});

test('owned install removal retries transient Windows folder locks', async t => {
    const f = fixture(t);
    let attempts = 0;
    const result = await removeOwnedInstallDirectory(f.game, {
        idFactory: () => 'retry-lock',
        retryDelaysMs: [0, 0],
        wait: async () => {},
        rename: async (source, destination) => {
            attempts++;
            if (attempts < 3) {
                const error = new Error('operation not permitted');
                error.code = 'EPERM';
                throw error;
            }
            await fs.promises.rename(source, destination);
        }
    });
    assert.equal(result.removed, true);
    assert.equal(attempts, 3);
    assert.equal(fs.existsSync(f.game), false);
});

test('persistent Windows folder locks return a path-free useful error', async t => {
    const f = fixture(t);
    await assert.rejects(() => removeOwnedInstallDirectory(f.game, {
        idFactory: () => 'persistent-lock',
        retryDelaysMs: [0, 0],
        wait: async () => {},
        rename: async () => {
            const error = new Error(`EPERM rename '${f.game}'`);
            error.code = 'EPERM';
            throw error;
        }
    }), error => error
        && error.code === 'SAIL_GAME_FOLDER_IN_USE'
        && /Windows is still using this game folder/i.test(error.message)
        && !error.message.includes(f.game));
    assert.equal(fs.existsSync(f.game), true);
});
