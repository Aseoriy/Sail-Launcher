'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
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

test('FileCrypt visible status handles split tags/entities and stays conservative', () => {
    for (const body of [
        '<div>GoFile <b>0</b> <span>Online</span></div>',
        '<div>GoFile <span>0</span>&nbsp;<b>Online</b></div>'
    ]) {
        const value = classifyFileCryptResponse(response(200, body));
        assert.equal(value.status, HEALTH_STATES.DOWN);
        assert.equal(value.reason, 'container-reports-no-online-mirror');
    }
    assert.equal(classifyFileCryptResponse(response(200, '<div>Online</div>')).status, HEALTH_STATES.UNKNOWN);
    assert.equal(classifyFileCryptResponse(response(200, '<div>0 Online · 2 Online</div>')).status, HEALTH_STATES.UNKNOWN);
    assert.equal(classifyFileCryptResponse(response(200, '<div>0 Online</div><p>Just a moment...</p>')).status, HEALTH_STATES.VERIFICATION_REQUIRED);
});

test('FileCrypt filenames do not become offline status', () => {
    const value = classifyFileCryptResponse(response(200,
        '<title>Red Dead Redemption - Dead Island</title><div>GoFile download container</div>'));
    assert.equal(value.status, HEALTH_STATES.UNKNOWN);
});

test('FileCrypt 404 and challenge responses are distinguished from a dead mirror', () => {
    assert.equal(classifyFileCryptResponse(response(404)).status, HEALTH_STATES.DOWN);
    assert.equal(classifyFileCryptResponse(response(403, 'Just a moment...')).status, HEALTH_STATES.VERIFICATION_REQUIRED);
    assert.equal(classifyFileCryptResponse(response(200, '<form id="pow-captcha">Verification</form>')).status, HEALTH_STATES.VERIFICATION_REQUIRED);
});

test('FileCrypt generic HTML does not get falsely marked available or down', () => {
    const value = classifyFileCryptResponse(response(200, '<html><body>Download container</body></html>'));
    assert.equal(value.status, HEALTH_STATES.UNKNOWN);
    for (const name of ['Deleted.zip', 'Offline.zip', 'Removed.zip']) {
        assert.equal(classifyFileCryptResponse(response(200, `<h1>${name}</h1>`)).status, HEALTH_STATES.UNKNOWN);
        assert.equal(classifyFileCryptResponse(response(200, `<h1>${name}</h1><div>1 Online</div>`)).status, HEALTH_STATES.AVAILABLE);
    }
    assert.equal(classifyFileCryptResponse(response(200, '<p>This file was deleted.</p>')).status, HEALTH_STATES.DOWN);
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

test('BuzzHeavier lost-file pages are down while active token pages are available', async () => {
    const lost = await checkDownloadLinkHealth('https://buzzheavier.com/5bcb8b3od5f', {
        sourceId: 'steamgg',
        request: async (method, url, options) => {
            assert.equal(method, 'GET');
            assert.equal(url, 'https://buzzheavier.com/5bcb8b3od5f');
            assert.equal(options.headers.Range, 'bytes=0-0');
            return response(200,
                '<main><p>Whatever lived here has returned to the void.</p><p>Every file is given time. This one\'s ran out.</p></main>');
        }
    });
    assert.equal(lost.status, HEALTH_STATES.DOWN);
    assert.equal(lost.reason, 'buzzheavier-page-reports-down');

    const active = await checkDownloadLinkHealth('https://bzzhr.to/u33dxmmaozb6', {
        sourceId: 'steamrip',
        request: async () => response(200,
            '<button hx-get="/u33dxmmaozb6/download?t=signed-token">Download</button>')
    });
    assert.equal(active.status, HEALTH_STATES.AVAILABLE);
    assert.equal(active.reason, 'buzzheavier-token-available');

    let browserChecks = 0;
    const challengedLost = await checkDownloadLinkHealth('https://buzzheavier.com/tesckhb3od5f', {
        sourceId: 'steamgg',
        request: async () => response(403, '<title>Just a moment...</title>'),
        buzzHeavierBrowserCheck: async url => {
            browserChecks++;
            assert.equal(url, 'https://buzzheavier.com/tesckhb3od5f');
            return { status: HEALTH_STATES.DOWN, reason: 'buzzheavier-page-reports-down', sizeLabel: '53.1 GB', sizeBytes: 53100000000 };
        }
    });
    assert.equal(challengedLost.status, HEALTH_STATES.DOWN);
    assert.equal(challengedLost.reason, 'buzzheavier-page-reports-down');
    assert.equal(challengedLost.sizeLabel, undefined);
    assert.equal(challengedLost.sizeBytes, undefined);
    assert.equal(browserChecks, 1);

    const challengedActive = await checkDownloadLinkHealth('https://buzzheavier.com/tesckhb3od5f', {
        request: async () => response(403, '<title>Just a moment...</title>'),
        buzzHeavierBrowserCheck: async () => ({
            status: HEALTH_STATES.AVAILABLE, reason: 'buzzheavier-browser-active', sizeLabel: '53.1 GB'
        })
    });
    assert.equal(challengedActive.status, HEALTH_STATES.AVAILABLE);
    assert.equal(challengedActive.sizeLabel, '53.1 GB');
});

test('BuzzHeavier and FuckingFast expose only the host Download File page size in metadata mode', async () => {
    const buzz = await checkDownloadLinkHealth('https://buzzheavier.com/5bcb8b3od5f', {
        metadataOnly: true,
        request: async () => response(200,
            '<button hx-get="/download?t=signed-token">Download</button><div>Download File 53.1GB</div>')
    });
    assert.equal(buzz.status, HEALTH_STATES.AVAILABLE);
    assert.equal(buzz.sizeLabel, '53.1 GB');

    const calls = [];
    const fast = await checkDownloadLinkHealth('https://fuckingfast.com/2tz65s3zlmuu', {
        metadataOnly: true,
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            return calls.length === 1
                ? response(200, '<html>landing page</html>')
                : response(200, '<h1>Download File 9.0GB</h1>');
        }
    });
    assert.equal(fast.status, HEALTH_STATES.UNKNOWN);
    assert.equal(fast.sizeLabel, '9.0 GB');
    assert.equal(calls[1].options.metadataOnly, true);

    const fitgirl = await checkDownloadLinkHealth('https://fuckingfast.co/jypnrk04cbte', {
        metadataOnly: true,
        request: async (method) => method === 'HEAD'
            ? response(200, '<html>landing page</html>')
            : response(200, '<main>RDR2_Updated_Setup_Files.part1.rar<br>Size: 500.0MB | Downloads: 62793</main>')
    });
    assert.equal(fitgirl.status, HEALTH_STATES.UNKNOWN);
    assert.equal(fitgirl.sizeLabel, '500.0 MB');
    const unrelatedSize = await checkDownloadLinkHealth('https://fuckingfast.co/jypnrk04cbte', {
        metadataOnly: true,
        request: async () => response(200, '<main>Maximum File Size: 100 GB<br>Memory Size: 12 GB RAM</main>')
    });
    assert.equal(unrelatedSize.sizeLabel, undefined);
});

test('BuzzHeavier off-screen browser health script recognizes lost and active pages', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const scriptMatch = main.match(/const BUZZHEAVIER_BROWSER_HEALTH_JS = `([\s\S]*?)`;/);
    assert.ok(scriptMatch);
    const browserScript = vm.runInNewContext(`(() => { ${scriptMatch[0]} return BUZZHEAVIER_BROWSER_HEALTH_JS; })()`);
    const evaluate = (text, controls = []) => vm.runInNewContext(browserScript, {
        document: {
            body: { innerText: text },
            querySelectorAll: selector => selector === '[hx-get]' ? controls : []
        }
    });

    const lost = evaluate('Whatever lived here has returned to the void.');
    assert.equal(lost.status, HEALTH_STATES.DOWN);
    assert.equal(lost.reason, 'buzzheavier-page-reports-down');
    const active = evaluate('Ready — Download File 53.1GB', [{
        getAttribute: name => name === 'hx-get' ? '/u33dxmmaozb6/download?t=signed-token' : ''
    }]);
    assert.equal(active.status, HEALTH_STATES.AVAILABLE);
    assert.equal(active.reason, 'buzzheavier-token-available');
    assert.equal(active.sizeLabel, '53.1GB');
});

test('DataNodes follows its provider redirect and detects the not-found page', async () => {
    const calls = [];
    const value = await checkDownloadLinkHealth('https://datanodes.to/Expired123', {
        sourceId: 'steamgg',
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            return calls.length === 1
                ? response(302, '', { location: '/download', 'set-cookie': ['file_code=Expired123; Path=/'] })
                : response(200, '<h1>File Not Found</h1><p>The file you were looking for could not be found.</p><li>The file expired</li>');
        }
    });
    assert.equal(value.status, HEALTH_STATES.DOWN);
    assert.equal(value.reason, 'datanodes-page-reports-down');
    assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), [
        'GET https://datanodes.to/Expired123',
        'GET https://datanodes.to/download'
    ]);
    assert.equal(calls[1].options.headers.Cookie, 'file_code=Expired123');

    const active = await checkDownloadLinkHealth('https://datanodes.to/Active123', {
        sourceId: 'steamgg',
        request: async () => response(200, '<download-countdown code="Active123"></download-countdown>')
    });
    assert.equal(active.status, HEALTH_STATES.AVAILABLE);
    assert.equal(active.reason, 'datanodes-download-page-active');

    const challenged = await checkDownloadLinkHealth('https://datanodes.to/Expired123', {
        sourceId: 'steamgg',
        request: async () => response(403, '<title>Just a moment...</title>'),
        dataNodesBrowserCheck: async () => ({
            status: HEALTH_STATES.DOWN,
            reason: 'datanodes-page-reports-down'
        })
    });
    assert.equal(challenged.status, HEALTH_STATES.DOWN);
});

test('DataNodes active pages expose only the og:title host size and preserve cookies across redirects', async () => {
    const calls = [];
    const value = await checkDownloadLinkHealth('https://datanodes.to/Active123', {
        sourceId: 'steamgg',
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            return calls.length === 1
                ? response(302, '', { location: '/download', 'set-cookie': ['file_code=Active123; Path=/'] })
                : response(200, '<meta property="og:title" content="Red Dead Redemption 2 (113.8 GB)"><p>Memory: 12 GB RAM</p><download-countdown></download-countdown>');
        }
    });
    assert.equal(value.status, HEALTH_STATES.AVAILABLE);
    assert.equal(value.sizeLabel, '113.8 GB');
    assert.equal(value.sizeBytes, undefined);
    assert.equal(calls[1].options.headers.Cookie, 'file_code=Active123');
});

test('DataNodes keeps active-page size through captcha fallback but drops it for browser-down results', async () => {
    const page = '<meta property="og:title" content="Red Dead Redemption 2 (113.8 GB)"><download-countdown :has-captcha="true"></download-countdown>';
    const fallback = await checkDownloadLinkHealth('https://datanodes.to/Active123', {
        request: async () => response(200, page)
    });
    assert.equal(fallback.status, HEALTH_STATES.VERIFICATION_REQUIRED);
    assert.equal(fallback.sizeLabel, '113.8 GB');

    const browserAvailable = await checkDownloadLinkHealth('https://datanodes.to/Active123', {
        request: async () => response(200, page),
        dataNodesBrowserCheck: async () => ({ status: HEALTH_STATES.AVAILABLE, reason: 'browser-active' })
    });
    assert.equal(browserAvailable.status, HEALTH_STATES.AVAILABLE);
    assert.equal(browserAvailable.sizeLabel, '113.8 GB');

    const browserDown = await checkDownloadLinkHealth('https://datanodes.to/Active123', {
        request: async () => response(200, page),
        dataNodesBrowserCheck: async () => ({ status: HEALTH_STATES.DOWN, reason: 'browser-down', sizeLabel: '113.8 GB' })
    });
    assert.equal(browserDown.status, HEALTH_STATES.DOWN);
    assert.equal(browserDown.sizeLabel, undefined);
    assert.equal(browserDown.sizeBytes, undefined);
});

test('FitGirl metadata checks read landing-page status without submitting download controls', async () => {
    for (const host of ['filekeeper.net', 'fuckingfast.co', 'megadb.net', 'multiup.io', 'gofile.io', '1337x.to', 'rutor.info']) {
        const calls = [];
        const value = await checkDownloadLinkHealth(`https://${host}/Abcd1234`, {
            sourceId: 'fitgirl', metadataOnly: true,
            request: async (method, url, options) => {
                calls.push({ method, url, options });
                return method === 'HEAD' ? response(200) : response(200, '<h1>File Not Found</h1>');
            }
        });
        assert.equal(value.status, HEALTH_STATES.DOWN, host);
        assert.deepEqual(calls.map(call => call.method), ['HEAD', 'GET'], host);
        assert.ok(calls.every(call => call.options.metadataOnly && !call.options.follow && call.options.maxBodyBytes <= 256 * 1024));
    }
    const fast = await checkDownloadLinkHealth('https://fuckingfast.co/f/Abcd1234', {
        sourceId: 'fitgirl', metadataOnly: true,
        request: async method => method === 'HEAD' ? response(200)
            : response(200, '<button hx-post="/f/Abcd1234/go">Download</button><p>Size: 500 MB | Downloads: 3</p>')
    });
    assert.equal(fast.status, HEALTH_STATES.AVAILABLE);
    assert.equal(fast.sizeLabel, '500 MB');
    const verification = await checkDownloadLinkHealth('https://fuckingfast.co/f/Abcd1234', {
        metadataOnly: true,
        request: async method => method === 'HEAD' ? response(200)
            : response(200, '<button hx-post="/f/Abcd1234/go">Download</button><div class="cf-turnstile"></div>')
    });
    assert.equal(verification.status, HEALTH_STATES.VERIFICATION_REQUIRED);
    const filename = await checkDownloadLinkHealth('https://filekeeper.net/Abcd1234', {
        metadataOnly: true,
        request: async method => method === 'HEAD' ? response(200) : response(200, '<h1>File Not Found.zip</h1>')
    });
    assert.equal(filename.status, HEALTH_STATES.UNKNOWN);
});

test('FileKeeper metadata follows only existing approved transfer redirects using HEAD', async () => {
    const calls = [];
    const transfer = 'https://fs2.filekeeper.net:8443/d/abcdefghijklmnopqrstuvwxyz123456/archive.zip';
    const value = await checkDownloadLinkHealth('https://filekeeper.net/Abcd1234/archive.zip', {
        sourceId: 'fitgirl', metadataOnly: true,
        request: async (method, url) => {
            calls.push({ method, url });
            return calls.length === 1 ? response(302, '', { location: transfer })
                : response(200, '', { 'content-type': 'application/zip', 'content-length': '500' });
        }
    });
    assert.equal(value.status, HEALTH_STATES.AVAILABLE);
    assert.equal(value.sizeBytes, 500);
    assert.deepEqual(calls, [
        { method: 'HEAD', url: 'https://filekeeper.net/Abcd1234/archive.zip' },
        { method: 'HEAD', url: transfer }
    ]);
    for (const location of ['https://ads.example/archive.zip', transfer.replace(':8443', ':9443')]) {
        let count = 0;
        const rejected = await checkDownloadLinkHealth('https://filekeeper.net/Abcd1234', {
            metadataOnly: true,
            request: async () => { count++; return response(302, '', { location }); }
        });
        assert.equal(rejected.reason, 'unsafe-provider-redirect');
        assert.equal(count, 1);
    }
});

test('FitGirl checks do not open browser verification and DataNodes false captcha flag is not a challenge', async () => {
    let browserChecks = 0;
    const noBrowser = async () => { browserChecks++; return { status: HEALTH_STATES.AVAILABLE }; };
    for (const url of ['https://datanodes.to/Abcd1234', 'https://buzzheavier.com/Abcd1234']) {
        const value = await checkDownloadLinkHealth(url, {
            sourceId: 'fitgirl',
            request: async () => response(403, 'Just a moment'),
            dataNodesBrowserCheck: noBrowser, buzzHeavierBrowserCheck: noBrowser
        });
        assert.equal(value.status, HEALTH_STATES.VERIFICATION_REQUIRED);
    }
    const active = await checkDownloadLinkHealth('https://datanodes.to/Abcd1234', {
        sourceId: 'fitgirl', request: async () => response(200, '<download-countdown :has-captcha="false"></download-countdown>'),
        dataNodesBrowserCheck: noBrowser
    });
    assert.equal(active.status, HEALTH_STATES.AVAILABLE);
    assert.equal(browserChecks, 0);
});

test('health deadline aborts stalled requests and releases deduplicated callers', async () => {
    let calls = 0;
    let aborted = false;
    const check = createDownloadLinkHealthChecker({
        checkTimeoutMs: 20,
        request: (_method, _url, options) => {
            calls++;
            return new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(new Error('aborted'));
                }, { once: true });
            });
        }
    });
    const [first, second] = await Promise.all([
        check('https://filekeeper.net/Abcd1234#archive.zip', { sourceId: 'fitgirl' }),
        check('https://filekeeper.net/Abcd1234', { sourceId: 'fitgirl' })
    ]);
    assert.equal(first.reason, 'health-check-timeout');
    assert.strictEqual(first, second);
    assert.equal(calls, 1);
    assert.equal(aborted, true);
});

test('health cache is source scoped and rejects unsupported sources before cache lookup', async () => {
    let calls = 0;
    const check = createDownloadLinkHealthChecker({ request: async () => { calls++; return response(404); } });
    const url = 'https://filekeeper.net/Abcd1234';
    await check(url, { sourceId: 'fitgirl' });
    await check(url, { sourceId: 'steamrip' });
    await check(url + '#filename', { sourceId: 'fitgirl' });
    assert.equal(calls, 2);
    assert.equal((await check(url, { sourceId: 'other' })).reason, 'unsupported-health-target');
    assert.equal((await check('https://example.invalid/file', { sourceId: 'fitgirl' })).reason, 'unsupported-health-target');
    assert.equal(calls, 2);
});

test('expired health checks cannot start a later redirect request even if transport ignores abort', async () => {
    let release;
    let calls = 0;
    const check = createDownloadLinkHealthChecker({
        metadataOnly: true, checkTimeoutMs: 10,
        request: async () => {
            calls++;
            return new Promise(resolve => { release = resolve; });
        }
    });
    const value = await check('https://filekeeper.net/Abcd1234', { sourceId: 'fitgirl' });
    assert.equal(value.reason, 'health-check-timeout');
    release(response(302, '', { location: '/Other1234' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
});

test('file size metadata accepts Content-Length and complete Content-Range, never HTML or one-byte ranges', async () => {
    const contentLength = await checkDownloadLinkHealth('https://filekeeper.net/file/abc/archive.rar', {
        request: async () => response(200, '', { 'content-type': 'application/octet-stream', 'content-length': '123456789' })
    });
    assert.equal(contentLength.sizeBytes, 123456789);

    const completeRange = await checkDownloadLinkHealth('https://filekeeper.net/file/abc/archive.rar', {
        request: async method => method === 'HEAD'
            ? response(405)
            : response(206, 'x', { 'content-type': 'application/octet-stream', 'content-length': '1', 'content-range': 'bytes 0-0/987654321' })
    });
    assert.equal(completeRange.sizeBytes, 987654321);

    const partialRange = await checkDownloadLinkHealth('https://filekeeper.net/file/abc/archive.rar', {
        request: async method => method === 'HEAD'
            ? response(405)
            : response(206, 'x', { 'content-type': 'application/octet-stream', 'content-length': '1' })
    });
    assert.equal(partialRange.sizeBytes, undefined);

    const html = await checkDownloadLinkHealth('https://filekeeper.net/file/abc/archive.rar', {
        request: async () => response(200, '<html>12 GB RAM</html>', { 'content-length': '999999999' })
    });
    assert.equal(html.sizeBytes, undefined);
});

test('Pixeldrain metadata-only lookup uses documented file info size without reading a file', async () => {
    const calls = [];
    const value = await checkDownloadLinkHealth('https://pixeldrain.net/u/Abcd1234', {
        metadataOnly: true,
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            return url.includes('/api/file/')
                ? response(200, JSON.stringify({ id: 'Abcd1234', size: 123456789 }), { 'content-type': 'application/json' })
                : response(200, '<html>file page</html>');
        }
    });
    assert.equal(value.status, HEALTH_STATES.AVAILABLE);
    assert.equal(value.sizeBytes, 123456789);
    assert.equal(calls[1].method, 'GET');
    assert.match(calls[1].url, /\/api\/file\/Abcd1234\/info$/);
    assert.equal(calls[1].options.metadataOnly, true);
    assert.ok(calls[1].options.maxBodyBytes <= 256 * 1024);
});

test('Pixeldrain list metadata sums only when every listed file has a valid size', async () => {
    const list = await checkDownloadLinkHealth('https://pixeldrain.net/l/List1234', {
        metadataOnly: true,
        request: async (_method, url) => url.includes('/api/list/')
            ? response(200, JSON.stringify({ id: 'List1234', files: [{ id: 'Abcd1234', size: 10 }, { id: 'Efgh5678', size: 32 }] }), { 'content-type': 'application/json' })
            : response(200, '<html>list page</html>')
    });
    assert.equal(list.status, HEALTH_STATES.AVAILABLE);
    assert.equal(list.sizeBytes, 42);

    const partial = await checkDownloadLinkHealth('https://pixeldrain.net/l/List1234', {
        metadataOnly: true,
        request: async (_method, url) => url.includes('/api/list/')
            ? response(200, JSON.stringify({ id: 'List1234', files: [{ id: 'Abcd1234', size: 10 }, { id: 'Efgh5678' }] }), { 'content-type': 'application/json' })
            : response(200, '<html>list page</html>')
    });
    assert.equal(partial.sizeBytes, undefined);
});

test('cached health results retain size metadata', async () => {
    let calls = 0;
    const check = createDownloadLinkHealthChecker({
        request: async () => { calls++; return response(200, '', { 'content-type': 'application/octet-stream', 'content-length': '42' }); }
    });
    const first = await check('https://filekeeper.net/file/abc/archive.rar');
    const second = await check('https://filekeeper.net/file/abc/archive.rar');
    assert.equal(first.sizeBytes, 42);
    assert.strictEqual(first, second);
    assert.equal(calls, 1);
});

test('invalid file metadata cannot become a download size', async () => {
    const invalidResponses = [
        response(200, '{"success":true}', { 'content-type': 'application/json', 'content-length': '16' }),
        response(200, '', { 'content-type': 'application/octet-stream', 'content-length': 'Infinity' }),
        response(200, '', { 'content-type': 'application/octet-stream', 'content-length': true }),
        response(206, 'x', { 'content-type': 'application/octet-stream', 'content-length': '1', 'content-range': 'bytes 10-0/100' }),
        response(206, 'x', { 'content-type': 'application/octet-stream', 'content-length': '1', 'content-range': 'bytes 0-100/100' }),
        response(206, 'x', { 'content-type': 'application/octet-stream', 'content-length': '1', 'content-range': 'bytes 0-0/*' })
    ];
    for (const value of invalidResponses) {
        const checked = await checkDownloadLinkHealth('https://filekeeper.net/file/abc/archive.rar', {
            request: async () => value
        });
        assert.equal(checked.sizeBytes, undefined);
    }
});

test('DataNodes off-screen health and managed click scripts stop on lost files', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const extractScript = name => {
        const marker = `const ${name} = \``;
        const start = main.indexOf(marker);
        const end = main.indexOf('`;', start + marker.length);
        assert.ok(start >= 0 && end > start, name);
        const declaration = main.slice(start, end + 2);
        return vm.runInNewContext(`(() => { ${declaration} return ${name}; })()`);
    };
    const document = {
        body: { innerText: 'File Not Found. The file you were looking for could not be found. The file expired.' },
        querySelector: () => null,
        querySelectorAll: () => []
    };
    for (const name of ['DATANODES_BROWSER_HEALTH_JS', 'DATANODES_SYSTEM_BROWSER_CLICK_JS']) {
        const value = vm.runInNewContext(extractScript(name), { document });
        assert.equal(value.status || value.linkHealth, HEALTH_STATES.DOWN);
        assert.equal(value.reason || value.healthReason, 'datanodes-page-reports-down');
    }
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
    assert.match(main, /buzzHeavierBrowserCheck:[\s\S]{0,220}checkBuzzheavierWithSystemBrowser/);
    assert.match(main, /dataNodesBrowserCheck:[\s\S]{0,220}checkDatanodesWithSystemBrowser/);
    assert.match(main, /captured && captured\.linkHealth === HEALTH_STATES\.DOWN/);

    assert.match(index, /ipcRenderer\.invoke\('get-download-link-health'/);
    assert.match(index, /Offline — choose another mirror/);
    assert.match(index, /button\.dataset\.downloadHealthDisabled = 'true'/);
    assert.match(index, /if \(warnOfflineDownload\(set && set\.parts, sourceId\)\) return ''/);
    assert.match(index, /p\.linkHealth === 'down'[\s\S]{0,180}updateDownloadLinkHealth/);
});
