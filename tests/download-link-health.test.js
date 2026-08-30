'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    HEALTH_STATES,
    classifyFileCryptResponse,
    checkDownloadLinkHealth,
    createDownloadLinkHealthChecker,
    isHealthTargetAllowed,
    providerForUrl
} = require('../runtime/downloadLinkHealth');

function response(status, body = '', headers = {}) {
    return { status, body, headers: { 'content-type': 'text/html', ...headers } };
}

test('FileCrypt explicit 0 Online status is reported as down', () => {
    const value = classifyFileCryptResponse(response(200, '<div>GoFile <b>0 Online</b></div>'));
    assert.equal(value.status, HEALTH_STATES.DOWN);
    assert.equal(value.reason, 'container-reports-no-online-mirror');
});

test('FileCrypt 404 and challenge responses are distinguished from a dead mirror', () => {
    assert.equal(classifyFileCryptResponse(response(404)).status, HEALTH_STATES.DOWN);
    assert.equal(classifyFileCryptResponse(response(403, 'Just a moment...')).status, HEALTH_STATES.VERIFICATION_REQUIRED);
    assert.equal(classifyFileCryptResponse(response(200, '<form id="pow-captcha">Verification</form>')).status, HEALTH_STATES.VERIFICATION_REQUIRED);
});

test('FileCrypt generic HTML does not get falsely marked available or down', () => {
    const value = classifyFileCryptResponse(response(200, '<html><body>Download container</body></html>'));
    assert.equal(value.status, HEALTH_STATES.UNKNOWN);
});

test('provider allowlist accepts supported HTTPS hosts and rejects arbitrary URLs', () => {
    assert.equal(providerForUrl('https://www.filecrypt.cc/Container/ABCDEF1234.html'), 'filecrypt');
    assert.equal(providerForUrl('https://fileditchfiles.me/file.php?f=archive.rar'), 'fileditch');
    assert.equal(providerForUrl('https://bzzhr.to/abc123'), 'buzzheavier');
    assert.equal(providerForUrl('https://datanodes.net/abc123'), 'datanodes');
    assert.equal(providerForUrl('https://pixeldrain.net/u/abc123'), 'pixeldrain');
    assert.equal(providerForUrl('https://www.rootz.so/d/1OXKoy'), 'rootz');
    assert.equal(providerForUrl('https://vik1ngfile.site/f/NyB3N6FNcm'), 'vikingfile');
    assert.equal(providerForUrl('https://store1.gofile.io/download/a/file.rar'), '');
    assert.equal(isHealthTargetAllowed('https://www.filecrypt.cc/Container/ABCDEF1234.html', 'steamrip'), true);
    assert.equal(isHealthTargetAllowed('http://www.filecrypt.cc/Container/ABCDEF1234.html', 'steamrip'), false);
    assert.equal(isHealthTargetAllowed('https://evil.example/file.rar', 'steamrip'), false);
    assert.equal(isHealthTargetAllowed('https://www.filecrypt.cc/Container/ABCDEF1234.html', 'other'), false);
});

test('Rootz metadata distinguishes active files from deleted shares', async () => {
    const pageUrl = 'https://www.rootz.so/d/1OXKoy';
    const token = 'MU9YS295OjU5NTk4ODQ.BD44e8cPZnTGzuJrG3wyNfb3p4sIQRCc7OZKKbrGd-o';
    const page = `<script>self.__next_f.push([1,"{\\"pageToken\\":\\"${token}\\"}"])</script>`;
    const activeCalls = [];
    const active = await checkDownloadLinkHealth(pageUrl, {
        sourceId: 'steamgg',
        request: async (method, url, options) => {
            activeCalls.push({ method, url, options });
            return activeCalls.length === 1
                ? response(200, page)
                : response(200, JSON.stringify({ success: true, data: {
                    status: 'active',
                    downloadAllowed: true,
                    fileId: '653940d2-bd88-4752-ae3b-e33e78721b5c'
                } }), { 'content-type': 'application/json' });
        }
    });
    assert.equal(active.status, HEALTH_STATES.AVAILABLE);
    assert.equal(activeCalls[0].method, 'GET');
    assert.equal(activeCalls[1].options.headers['X-Page-Token'], token);

    const deleted = await checkDownloadLinkHealth(pageUrl, {
        sourceId: 'steamgg',
        request: async (_method, url) => url === pageUrl
            ? response(200, page)
            : response(200, JSON.stringify({ success: true, data: {
                status: 'deleted', downloadAllowed: false
            } }), { 'content-type': 'application/json' })
    });
    assert.equal(deleted.status, HEALTH_STATES.DOWN);
    assert.equal(deleted.reason, 'rootz-deleted');
});

test('VikingFile health uses the official status API and keeps unsafe redirects unknown', async () => {
    const calls = [];
    const value = await checkDownloadLinkHealth('https://vikingfile.com/f/NyB3N6FNcm', {
        sourceId: 'steamgg',
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            return response(200, JSON.stringify({ exist: false }), { 'content-type': 'application/json' });
        }
    });
    assert.equal(value.status, HEALTH_STATES.DOWN);
    assert.equal(value.reason, 'vikingfile-api-not-found');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://vikingfile.com/api/check-file');
    assert.equal(calls[0].options.body, 'hash=NyB3N6FNcm');

    const unsafe = await checkDownloadLinkHealth('https://vikingfile.com/f/NyB3N6FNcm', {
        sourceId: 'steamgg',
        request: async (_method, url) => url.includes('/api/check-file')
            ? response(503)
            : response(302, '', { location: 'https://t.me/vikingfile_com' })
    });
    assert.equal(unsafe.status, HEALTH_STATES.UNKNOWN);
    assert.equal(unsafe.reason, 'unsafe-provider-redirect');
});

test('FileDitch follows its own transfer redirect and marks source-homepage expiry as down', async () => {
    const calls = [];
    const value = await checkDownloadLinkHealth('https://fileditchfiles.me/file.php?f=/alpha4/game.rar', {
        sourceId: 'steamrip',
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            return calls.length === 1
                ? response(302, '', { location: '/f/alpha4/game.rar' })
                : response(302, '', { location: 'https://steamrip.com/' });
        }
    });
    assert.equal(value.status, HEALTH_STATES.DOWN);
    assert.equal(value.reason, 'fileditch-redirected-away');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].options.headers.Range, 'bytes=0-0');
});

test('AkiraBox public API distinguishes active files from removed shares', async () => {
    const activeCalls = [];
    const active = await checkDownloadLinkHealth('https://akirabox.to/Abc12345/file', {
        sourceId: 'steamgg',
        request: async (_method, url) => {
            activeCalls.push(url);
            return response(200, JSON.stringify({
                status: 200,
                name: 'Game.rar',
                url: 'https://akirabox.com/Abc12345/file'
            }), { 'content-type': 'application/json' });
        }
    });
    assert.equal(active.status, HEALTH_STATES.AVAILABLE);
    assert.equal(active.reason, 'akirabox-api-active');
    assert.deepEqual(activeCalls, [
        'https://akirabox.to/api/files?url=https%3A%2F%2Fakirabox.to%2FAbc12345%2Ffile'
    ]);

    const alternateCalls = [];
    const alternate = await checkDownloadLinkHealth('https://akirabox.com/Abc12345/file', {
        sourceId: 'steamgg',
        request: async (_method, url) => {
            alternateCalls.push(url);
            return url.startsWith('https://akirabox.to/')
                ? response(404, JSON.stringify({ status: 404 }), { 'content-type': 'application/json' })
                : response(200, JSON.stringify({ status: 200, url: 'https://akirabox.com/Abc12345/file' }), {
                    'content-type': 'application/json'
                });
        }
    });
    assert.equal(alternate.status, HEALTH_STATES.AVAILABLE);
    assert.deepEqual(alternateCalls, [
        'https://akirabox.to/api/files?url=https%3A%2F%2Fakirabox.to%2FAbc12345%2Ffile',
        'https://akirabox.com/api/files?url=https%3A%2F%2Fakirabox.to%2FAbc12345%2Ffile'
    ]);

    const removed = await checkDownloadLinkHealth('https://akirabox.com/Abc12345/file', {
        sourceId: 'steamgg',
        request: async () => response(404, JSON.stringify({ status: 404, message: 'File not found' }), {
            'content-type': 'application/json'
        })
    });
    assert.equal(removed.status, HEALTH_STATES.DOWN);
    assert.equal(removed.reason, 'akirabox-api-not-found');
});

test('provider filename fragments are stripped before the health request', async () => {
    const requests = [];
    const value = await checkDownloadLinkHealth('https://fuckingfast.co/abc123#Game.part1.rar', {
        sourceId: 'fitgirl',
        request: async (method, url) => {
            requests.push({ method, url });
            return response(403, 'Just a moment...');
        }
    });
    assert.equal(value.status, HEALTH_STATES.VERIFICATION_REQUIRED);
    assert.deepEqual(requests, [{ method: 'HEAD', url: 'https://fuckingfast.co/abc123' }]);
});

test('known provider 404 is down while 403, redirects, and 5xx remain non-down', async () => {
    const requests = [];
    const request = async (method, url, options) => {
        requests.push({ method, url, options });
        return response(404, '', { 'content-type': 'application/octet-stream' });
    };
    const value = await checkDownloadLinkHealth('https://fileditch.com/file/abc/archive.rar', { sourceId: 'fitgirl', request });
    assert.equal(value.status, HEALTH_STATES.DOWN);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].options.headers.Range, 'bytes=0-0');

    const statuses = [403, 302, 503];
    for (const status of statuses) {
        const result = await checkDownloadLinkHealth('https://fileditch.com/file/abc/archive.rar', {
            request: async () => response(status, '', status === 302 ? { location: 'https://ads.example/track' } : { 'content-type': 'application/octet-stream' })
        });
        assert.notEqual(result.status, HEALTH_STATES.DOWN);
    }
});

test('HTML landing pages and challenge bodies are not treated as files', async () => {
    const page = await checkDownloadLinkHealth('https://buzzheavier.com/file/abc', {
        request: async () => response(200, '<html>Download page</html>', { 'content-type': 'text/html' })
    });
    assert.equal(page.status, HEALTH_STATES.UNKNOWN);
    const challenge = await checkDownloadLinkHealth('https://datanodes.to/file/abc', {
        request: async () => response(200, 'Checking your browser before accessing this site', { 'content-type': 'text/html' })
    });
    assert.equal(challenge.status, HEALTH_STATES.VERIFICATION_REQUIRED);
});

test('unsafe provider redirects fail closed', async () => {
    const value = await checkDownloadLinkHealth('https://fileditch.com/file/abc/archive.rar', {
        request: async () => response(302, '', { location: 'https://evil.example/archive.rar' })
    });
    assert.equal(value.status, HEALTH_STATES.UNKNOWN);
    assert.equal(value.reason, 'unsafe-provider-redirect');
});

test('HEAD 405 uses a bounded one-byte GET and can report a file available', async () => {
    const calls = [];
    const value = await checkDownloadLinkHealth('https://filekeeper.net/file/abc/archive.rar', {
        request: async (method, _url, options) => {
            calls.push({ method, options });
            return method === 'HEAD'
                ? response(405)
                : response(206, 'x', { 'content-type': 'application/octet-stream' });
        }
    });
    assert.equal(value.status, HEALTH_STATES.AVAILABLE);
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].options.headers.Range, 'bytes=0-0');
});

test('health checker caches short-lived results without caching invalid targets', async () => {
    let now = 1000;
    let calls = 0;
    const check = createDownloadLinkHealthChecker({
        now: () => now,
        ttlMs: 5000,
        request: async () => { calls++; return response(404, '', { 'content-type': 'application/octet-stream' }); }
    });
    const first = await check('https://fileditch.com/file/abc/archive.rar', { sourceId: 'fitgirl' });
    const second = await check('https://fileditch.com/file/abc/archive.rar', { sourceId: 'fitgirl' });
    assert.equal(first.status, HEALTH_STATES.DOWN);
    assert.strictEqual(first, second);
    assert.equal(calls, 1);
    now += 5001;
    await check('https://fileditch.com/file/abc/archive.rar', { sourceId: 'fitgirl' });
    assert.equal(calls, 2);
    await check('https://evil.example/file.rar', { sourceId: 'fitgirl' });
    assert.equal(calls, 2);
});

test('production download flow reports and blocks confirmed offline links', () => {
    const root = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

    assert.match(main, /fitgirl:\s*'https:\/\/fitgirl-repacks\.site\/'/);
    assert.match(main, /const containerHealth = classifyFileCryptResponse\(/);
    assert.match(main, /throw buildLinkDownError\(containerUrl, containerHealth\.reason\)/);
    assert.match(main, /e\.aria2Code === 3[\s\S]{0,240}e\.linkHealth = HEALTH_STATES\.DOWN/);
    assert.match(main, /linkHealth: err\.linkHealth === HEALTH_STATES\.DOWN/);

    assert.match(index, /ipcRenderer\.invoke\('get-download-link-health'/);
    assert.match(index, /Offline — choose another mirror/);
    assert.match(index, /button\.dataset\.downloadHealthDisabled = 'true'/);
    assert.match(index, /if \(warnOfflineDownload\(set && set\.parts, sourceId\)\) return ''/);
    assert.match(index, /p\.linkHealth === 'down'[\s\S]{0,180}updateDownloadLinkHealth/);
});
