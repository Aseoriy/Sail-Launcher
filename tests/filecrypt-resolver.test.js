'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { normalizeSteamRipGofileContainerUrl } = require('../ui/downloadSourceLogic');
const {
    FILECRYPT_CHALLENGE_EXPRESSION,
    fileCryptLinkCandidates,
    fileCryptNavigationExpression,
    fileCryptPageAllowed,
    fileCryptResolutionError,
    fileCryptSubmitExpression,
    normalizeFileCryptContainerUrl,
    solveFileCryptProof
} = require('../runtime/fileCryptResolver');
const { gofileShareDetails } = require('../runtime/downloadHostResolvers');
const { classifyFileCryptResponse, HEALTH_STATES } = require('../runtime/downloadLinkHealth');

const containerUrl = 'https://www.filecrypt.cc/Container/C9D9F3E419.html';
const shareUrl = 'https://gofile.io/d/UIM5QR';

function loadContainerResolver(overrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = source.indexOf('async function scrapeSteamRipGofileContainer(');
    const end = source.indexOf('async function scrapePixeldrain(', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
        URL, path,
        ...require('../runtime/fileCryptResolver'),
        gofileShareDetails, classifyFileCryptResponse, HEALTH_STATES,
        findSystemChromiumExecutable: () => 'browser-test-stub',
        app: { getPath: () => 'unused-test-temp' },
        mainWindow: null,
        adBlockEnabled: true,
        AD_BLOCK_HOSTS: ['ads.example'],
        HUMAN_VERIFICATION_RESOURCE_HOSTS: ['challenges.cloudflare.com'],
        managedVerificationCoordinator: { run: (_key, work, options) => work(options.signal) },
        buildLinkDownError: (url, reason) => Object.assign(new Error('Mirror is offline'), {
            linkHealth: 'down', downloadUrl: url, healthReason: reason
        }),
        ...overrides
    });
}

test('FileCrypt keeps native verification, link navigation and GoFile capture in one browser session', async () => {
    const controller = new AbortController();
    const files = [{ url: 'https://store1.gofile.io/download/web/example/game.zip', sizeBytes: 120000000 }];
    const resolvedShares = [];
    const progress = [];
    const resolve = loadContainerResolver({
        resolveWithSystemChromium: async (url, expression, options) => {
            assert.equal(url, containerUrl);
            assert.equal(expression, FILECRYPT_CHALLENGE_EXPRESSION);
            assert.equal(options.visible, true);
            assert.equal(options.appMode, true);
            assert.equal(options.signal, controller.signal);
            assert.equal(options.clickSelector, undefined, 'an already-open container needs no checkbox');
            assert.equal(options.handleResponse, undefined, 'native verification must not race a second proof submission');
            assert.equal(options.interceptTransferRequests, true);
            assert.equal(options.captureDownloads, true);
            assert.ok(options.blockedHosts.includes('ads.example'));
            assert.equal(options.handleValue({ stage: 'verification', location: url, statusText: 'Please verify' }), null);
            assert.equal(options.handleValue({ stage: 'container', location: url, links: [], statusText: 'Just a moment...' }), null);
            assert.equal(options.acceptResult({ stage: 'container' }), false);
            const directPage = 'https://filecrypt.cc/Container/C9D9F3E419';
            assert.equal(options.isAllowedUrl(new URL(directPage)), true, 'www redirects stay within FileCrypt');
            const next = options.handleValue({ stage: 'container', location: directPage,
                links: [{ href: 'https://filecrypt.cc/Link/ABCDEF1234' }], statusText: '1 Online' });
            assert.match(next.expression, /location\.assign/);
            assert.match(next.expression, /\/Link\/ABCDEF1234\.html/);
            for (const page of ['https://filecrypt.cc/Link/ABCDEF1234',
                'https://filecrypt.cc/Go/' + 'a'.repeat(40), shareUrl]) {
                assert.equal(options.isAllowedUrl(new URL(page)), true);
            }
            for (const rejected of ['https://ads.example/Link/ABCDEF1234',
                'https://filecrypt.cc/Container/AAAAAAAAAA', 'https://filecrypt.cc/settings',
                'https://gofile.io.evil.example/d/UIM5QR', 'https://user:password@gofile.io/d/UIM5QR',
                'https://store1.gofile.io/download/web/example/game.zip']) {
                assert.equal(options.isAllowedUrl(new URL(rejected)), false, rejected);
                assert.equal(options.captureRequestUrl(rejected), false, rejected);
                assert.equal(options.acceptDownloadUrl(rejected), false, rejected);
            }
            assert.equal(options.captureRequestUrl(shareUrl), true);
            assert.equal(options.acceptDownloadUrl(shareUrl), true);
            return { url: shareUrl };
        }
    });
    assert.equal(await resolve(containerUrl, 'https://steamrip.com/', async url => {
        resolvedShares.push(url);
        return files;
    }, { signal: controller.signal, onProgress: label => progress.push(label) }), files);
    assert.deepEqual(resolvedShares, [shareUrl]);
    assert.ok(progress.some(label => /Complete the FileCrypt check/.test(label)));
});

test('FileCrypt accepts an already-unlocked share without requiring a verification control', async () => {
    const files = [{ url: 'https://store1.gofile.io/download/web/file/archive.zip' }];
    const resolve = loadContainerResolver({
        resolveWithSystemChromium: async (_url, _expression, options) => options.handleValue({
            stage: 'container', location: containerUrl, links: [{ href: shareUrl }], statusText: 'GoFile 1 Online'
        }).value
    });
    assert.equal(await resolve(containerUrl, 'https://steamrip.com/', async () => files), files);
});

test('FileCrypt errors distinguish verification, browser, offline mirror and GoFile failures', async () => {
    const run = (overrides, onShare = async () => []) => loadContainerResolver(overrides)(containerUrl, 'https://steamrip.com/', onShare);
    await assert.rejects(run({ findSystemChromiumExecutable: () => '' }), error => error.fileCryptStage === 'browser-unavailable');
    await assert.rejects(run({ resolveWithSystemChromium: async () => null }), error => error.fileCryptStage === 'verification-incomplete');
    await assert.rejects(run({ resolveWithSystemChromium: async () => { throw new Error('private provider details'); } }),
        error => error.fileCryptStage === 'browser-failed' && !error.message.includes('private provider details'));
    const aborted = Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    await assert.rejects(run({ resolveWithSystemChromium: async () => { throw aborted; } }), error => error === aborted);
    await assert.rejects(run({ resolveWithSystemChromium: async (_url, _script, options) => options.handleValue({
        stage: 'container', location: containerUrl, links: [], statusText: 'GoFile 0 Online'
    }).value }), error => error.linkHealth === 'down' && error.downloadUrl === containerUrl);
    const revealed = { resolveWithSystemChromium: async () => ({ url: shareUrl }) };
    await assert.rejects(run(revealed), error => error.fileCryptStage === 'gofile-empty');
    await assert.rejects(run(revealed, async () => { throw Object.assign(new Error('gone'), { gofileStatus: 'error-notFound' }); }),
        error => error.linkHealth === 'down' && error.downloadUrl === shareUrl);
    await assert.rejects(run(revealed, async () => { throw new Error('private API response'); }),
        error => error.fileCryptStage === 'gofile-failed' && !error.message.includes('private API response'));
    for (const upstream of [aborted, Object.assign(new Error('rate limited'), { providerRateLimited: true }),
        Object.assign(new Error('TorBox rejected the share'), { debridResolutionFatal: true })]) {
        await assert.rejects(run(revealed, async () => { throw upstream; }), error => error === upstream);
    }
    assert.doesNotMatch(fileCryptResolutionError('link-missing').message, /refresh|offline/i);
});

test('FileCrypt browser inspection waits during loading and never submits verification forms', () => {
    const document = {
        readyState: 'loading', body: { innerHTML: '<form></form>', innerText: 'Please verify' },
        querySelector: () => ({}), querySelectorAll: () => []
    };
    const context = { document, location: { href: containerUrl } };
    assert.equal(vm.runInNewContext(FILECRYPT_CHALLENGE_EXPRESSION, context), null);
    document.readyState = 'complete';
    assert.equal(vm.runInNewContext(FILECRYPT_CHALLENGE_EXPRESSION, context).stage, 'verification');
    document.querySelector = () => null;
    assert.equal(vm.runInNewContext(FILECRYPT_CHALLENGE_EXPRESSION, context).stage, 'container');
    assert.doesNotMatch(FILECRYPT_CHALLENGE_EXPRESSION, /submit\(|document\.cookie|pow_nonce/);
});

test('FileCrypt internal links accept extensionless Link and relative Go routes without replaying navigation', () => {
    const goPath = '/Go/' + 'a'.repeat(40);
    assert.deepEqual(fileCryptLinkCandidates([{ href: '/Link/ABCDEF1234' }, { href: goPath }], containerUrl), [
        'https://www.filecrypt.cc/Link/ABCDEF1234.html', `https://www.filecrypt.cc${goPath}.html`
    ]);
    const assigned = [];
    const context = {
        location: { href: containerUrl, assign: url => assigned.push(url) },
        sessionStorage: {},
        document: { readyState: 'loading' }
    };
    const expression = fileCryptNavigationExpression(containerUrl, '/Link/ABCDEF1234', containerUrl);
    vm.runInNewContext(expression, context);
    vm.runInNewContext(expression, context);
    assert.deepEqual(assigned, ['https://www.filecrypt.cc/Link/ABCDEF1234.html']);
    for (const rejected of ['https://ads.example/Link/ABCDEF1234', 'javascript:alert(1)', '/settings']) {
        assert.throws(() => fileCryptNavigationExpression(containerUrl, rejected, containerUrl));
    }
    assert.equal(fileCryptPageAllowed('http://filecrypt.cc/Link/ABCDEF1234', containerUrl), false);
});

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

test('SteamRIP and the resolver normalize extensionless FileCrypt containers consistently', () => {
    for (const normalize of [normalizeSteamRipGofileContainerUrl, normalizeFileCryptContainerUrl]) {
        for (const hostname of ['filecrypt.cc', 'www.filecrypt.cc']) {
            const canonical = `https://${hostname}/Container/C9D9F3E419.html`;
            assert.equal(normalize(`https://${hostname}/Container/C9D9F3E419`), canonical);
            assert.equal(normalize(canonical), canonical);
        }
        for (const invalid of [
            'http://filecrypt.cc/Container/C9D9F3E419',
            'https://filecrypt.cc.evil.example/Container/C9D9F3E419',
            'https://user:password@filecrypt.cc/Container/C9D9F3E419',
            'https://filecrypt.cc:444/Container/C9D9F3E419',
            'https://filecrypt.cc/Link/C9D9F3E419',
            'https://filecrypt.cc/Container/C9D9F3E419?redirect=1',
            'https://filecrypt.cc/Container/C9D9F3E419#fragment',
            'https://filecrypt.cc/Container/C9D9F3E419/',
            'https://filecrypt.cc/Container/C9D9F3E419.exe',
            'https://filecrypt.cc/Container/short',
            'https://filecrypt.cc/Container/ZZZZZZZZZZ'
        ]) assert.equal(normalize(invalid), '', invalid);
    }
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
