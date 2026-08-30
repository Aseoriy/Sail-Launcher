'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
    FILECRYPT_CHALLENGE_EXPRESSION,
    fileCryptLinkCandidates,
    fileCryptSubmitExpression,
    normalizeFileCryptContainerUrl,
    solveFileCryptProof
} = require('../runtime/fileCryptResolver');

test('FileCrypt browser results include bounded status text for offline-mirror detection', () => {
    assert.match(FILECRYPT_CHALLENGE_EXPRESSION, /statusText/);
    assert.match(FILECRYPT_CHALLENGE_EXPRESSION, /slice\(0,65536\)/);
    assert.match(fileCryptSubmitExpression({ challenge: { id: 'abcdef123456' } }, { nonce: 1, elapsed: 1000, pauses: 1 }), /statusText/);
});

function leadingZeroBits(buffer) {
    let count = 0;
    for (const value of buffer) {
        if (value === 0) { count += 8; continue; }
        return count + Math.clz32(value) - 24;
    }
    return count;
}

test('FileCrypt wrapper validation accepts only exact HTTPS container pages', () => {
    assert.equal(
        normalizeFileCryptContainerUrl('https://www.filecrypt.cc/Container/E779AE4ECB.html'),
        'https://www.filecrypt.cc/Container/E779AE4ECB.html'
    );
    assert.equal(normalizeFileCryptContainerUrl('http://www.filecrypt.cc/Container/E779AE4ECB.html'), '');
    assert.equal(normalizeFileCryptContainerUrl('https://filecrypt.cc/Link/E779AE4ECB.html'), '');
    assert.equal(normalizeFileCryptContainerUrl('https://ads.example/Container/E779AE4ECB.html'), '');
});

test('FileCrypt link extraction keeps only same-origin link controls', () => {
    const container = 'https://www.filecrypt.cc/Container/E779AE4ECB.html';
    assert.deepEqual(fileCryptLinkCandidates([
        { href: '/Link/ABCDEF1234.html', onclick: '' },
        { href: '', onclick: "openLink('1234567890', this, true)" },
        { href: 'https://ads.example/Link/AAAAAAAAAA.html', onclick: '' },
        { href: '/Link/ABCDEF1234.html?ad=1', onclick: '' }
    ], container), [
        'https://www.filecrypt.cc/Link/ABCDEF1234.html',
        'https://www.filecrypt.cc/Link/1234567890.html'
    ]);
});

test('FileCrypt proof solver returns a nonce satisfying the host challenge', async () => {
    const challenge = '0123456789abcdef0123456789abcdef';
    const difficulty = 12;
    const result = await solveFileCryptProof({ challenge, difficulty }, { workers: 2, timeoutMs: 10000 });
    assert.ok(Number.isSafeInteger(result.nonce));
    assert.ok(result.elapsed >= 1);
    const digest = crypto.createHash('sha1').update(`${challenge}:${result.nonce}`, 'latin1').digest();
    assert.ok(leadingZeroBits(digest) >= difficulty);
});

test('FileCrypt submit script binds only validated proof fields into the protected form', () => {
    const expression = fileCryptSubmitExpression({
        challenge: { id: 'ABCDEF1234' }
    }, { nonce: 123, elapsed: 30000, pauses: 0 });
    assert.match(expression, /pow_nonce/);
    assert.match(expression, /signals\.collect/);
    assert.match(expression, /__sailGoFilePhase='submitted'/);
    assert.throws(() => fileCryptSubmitExpression({ challenge: { id: '../unsafe' } }, {
        nonce: 1,
        elapsed: 30000
    }));
});
