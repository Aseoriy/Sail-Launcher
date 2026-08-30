'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
    DATANODES_BROWSER_TRANSFER_AUTHORITY,
    buzzHeavierPageCandidates,
    createGofileResolver,
    credentialFreeHttpsUrl,
    extractGofileWebsiteTokenSecret,
    extractBuzzHeavierEndpoint,
    extractDataNodesBrowserDownload,
    extractFuckingFastBrowserDownload,
    fileKeeperDownloadUrl,
    gofileDirectDownloadUrl,
    gofileShareDetails,
    gofileWebsiteToken,
    managedHostTransferRequest,
    megadbTokenDetails,
    extract1337xLinks,
    resolve1337xUrl,
    resolveAkiraBoxUrl,
    resolveBuzzHeavierUrl,
    resolveDataNodesUrl,
    resolveFileDitchUrl,
    resolveFileKeeperUrl,
    resolvePixeldrainUrl,
    resolveMegaDbUrl,
    resolveRootzUrl,
    resolveVikingFileUrl,
    rootzPageDetails,
    validateDataNodesBrowserTransfer
} = require('../runtime/downloadHostResolvers');

const UA = 'Sail resolver test';

test('download host resolver accepts only credential-free HTTPS URLs', () => {
    assert.equal(credentialFreeHttpsUrl('https://downloads.example/game.rar#fragment'), 'https://downloads.example/game.rar');
    assert.equal(credentialFreeHttpsUrl('http://downloads.example/game.rar'), '');
    assert.equal(credentialFreeHttpsUrl('https://user:pass@downloads.example/game.rar'), '');
    assert.equal(credentialFreeHttpsUrl('https://downloads.example:8443/game.rar'), '');
    assert.equal(credentialFreeHttpsUrl('https:\\downloads.example\\game.rar'), '');
});

test('Gofile share parsing separates safe folder pages from direct CDN files', () => {
    assert.deepEqual(gofileShareDetails('https://gofile.io/d/Abc_123#ignored'), {
        directUrl: '',
        contentId: 'Abc_123'
    });
    assert.deepEqual(gofileShareDetails('https://gofile.io/contents/Abc_123?ignored=1'), {
        directUrl: '',
        contentId: 'Abc_123'
    });
    assert.equal(gofileShareDetails('https://gofile.io/d/'), null);
    assert.equal(gofileShareDetails('https://ads.example/d/Abc_123'), null);
    assert.equal(
        gofileDirectDownloadUrl('https://store9.gofile.io/download/web/file-id/Game%20Part.rar'),
        'https://store9.gofile.io/download/web/file-id/Game%20Part.rar'
    );
    assert.equal(gofileDirectDownloadUrl('https://ads.example/download/web/file-id/Game.rar'), '');
});

test('Gofile website token uses the current language and rotating script secret', () => {
    const script = `function generateWT(token) {
        return _sha256(navigator.userAgent + '::' + navigator.language + '::' + token
            + '::' + Math.floor(Date.now() / 1000 / 14400) + '::12af056dacea0b');
    }`;
    assert.equal(extractGofileWebsiteTokenSecret(script), '12af056dacea0b');
    assert.equal(gofileWebsiteToken('12af056dacea0b', 'guest-token', {
        userAgent: UA,
        language: 'en-US',
        now: 1760000000000
    }), 'bcc66e8d2201b89774b295331669c715a5ecdf54f6dd7449b4d830689447149f');
    assert.throws(() => extractGofileWebsiteTokenSecret('<html>not JavaScript</html>'));
});

test('Gofile resolver authenticates once, paginates folders, and keeps only trusted file links', async () => {
    const calls = [];
    const wtScript = `function generateWT(token) {
        return _sha256(navigator.userAgent + '::' + navigator.language + '::' + token
            + '::' + Math.floor(Date.now() / 1000 / 14400) + '::fixture-secret');
    }`;
    const resolver = createGofileResolver({
        userAgent: UA,
        now: 1760000000000,
        wait: async () => {},
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            if (url === 'https://gofile.io/') return {
                status: 200,
                headers: {},
                body: '<script src="/js/wt.obf.js" defer></script>'
            };
            if (url === 'https://gofile.io/js/wt.obf.js') return { status: 200, headers: {}, body: wtScript };
            if (url === 'https://api.gofile.io/accounts') return {
                status: 200,
                headers: {},
                body: JSON.stringify({ status: 'ok', data: { token: 'fixture-account-token' } })
            };
            const parsed = new URL(url);
            const id = parsed.pathname.split('/').pop();
            const page = Number(parsed.searchParams.get('page'));
            if (id === 'Root123' && page === 1) return {
                status: 200,
                headers: {},
                body: JSON.stringify({
                    status: 'ok',
                    metadata: { totalPages: 2 },
                    data: {
                        type: 'folder',
                        children: {
                            first: { id: 'File1', type: 'file', name: 'Part 1.rar', link: 'https://store1.gofile.io/download/web/File1/Part%201.rar' },
                            nested: { id: 'Nested123', type: 'folder', name: 'Bonus' }
                        }
                    }
                })
            };
            if (id === 'Root123' && page === 2) return {
                status: 200,
                headers: {},
                body: JSON.stringify({
                    status: 'ok',
                    metadata: { totalPages: 2 },
                    data: {
                        type: 'folder',
                        children: {
                            second: { id: 'File2', type: 'file', name: 'Part 2.rar', link: 'https://store2.gofile.io/download/web/File2/Part%202.rar' }
                        }
                    }
                })
            };
            if (id === 'Nested123') return {
                status: 200,
                headers: {},
                body: JSON.stringify({
                    status: 'ok',
                    metadata: { totalPages: 1 },
                    data: {
                        type: 'folder',
                        children: {
                            bonus: { id: 'File3', type: 'file', name: 'Bonus.zip', link: 'https://cold3.gofile.io/download/web/File3/Bonus.zip' },
                            ad: { id: 'Ad1', type: 'file', name: 'Advertisement.exe', link: 'https://ads.example/download/Advertisement.exe' }
                        }
                    }
                })
            };
            throw new Error(`Unexpected request: ${method} ${url}`);
        }
    });

    const files = await resolver('https://gofile.io/d/Root123');
    assert.deepEqual(files.map(file => ({ url: file.url, name: file.name })), [
        { url: 'https://store1.gofile.io/download/web/File1/Part%201.rar', name: 'Part 1.rar' },
        { url: 'https://cold3.gofile.io/download/web/File3/Bonus.zip', name: 'Bonus.zip' },
        { url: 'https://store2.gofile.io/download/web/File2/Part%202.rar', name: 'Part 2.rar' }
    ]);
    assert.ok(files.every(file => file.headers.includes('Cookie: accountToken=fixture-account-token')));
    const accountCall = calls.find(call => call.url === 'https://api.gofile.io/accounts');
    assert.equal(accountCall.options.headers['X-BL'], 'en-US');
    assert.match(accountCall.options.headers['X-Website-Token'], /^[a-f0-9]{64}$/);
    const contentCalls = calls.filter(call => call.url.startsWith('https://api.gofile.io/contents/'));
    assert.equal(contentCalls.length, 3);
    assert.ok(contentCalls.every(call => call.options.headers.Authorization === 'Bearer fixture-account-token'));
    assert.ok(contentCalls.every(call => call.options.headers['X-BL'] === 'en-US'));
    assert.ok(contentCalls.every(call => new URL(call.url).searchParams.get('pageSize') === '1000'));
});

test('concurrent Gofile resolutions share one in-flight guest account creation', async () => {
    let accountCalls = 0;
    const resolver = createGofileResolver({
        userAgent: UA,
        allowWebsiteTokenFallback: true,
        request: async (method, url) => {
            if (url === 'https://gofile.io/') return { status: 503, headers: {}, body: '' };
            if (url === 'https://gofile.io/js/wt.obf.js') return { status: 503, headers: {}, body: '' };
            if (url === 'https://api.gofile.io/accounts') {
                accountCalls++;
                await new Promise(resolve => setTimeout(resolve, 5));
                return { status: 200, headers: {}, body: JSON.stringify({ status: 'ok', data: { token: 'shared-token' } }) };
            }
            const id = new URL(url).pathname.split('/').pop();
            return {
                status: 200,
                headers: {},
                body: JSON.stringify({
                    status: 'ok',
                    metadata: { totalPages: 1 },
                    data: { type: 'file', name: `${id}.zip`, link: `https://store1.gofile.io/download/web/${id}/${id}.zip` }
                })
            };
        }
    });
    const [first, second] = await Promise.all([
        resolver('https://gofile.io/d/First123'),
        resolver('https://gofile.io/d/Second123')
    ]);
    assert.equal(accountCalls, 1);
    assert.equal(first[0].name, 'First123.zip');
    assert.equal(second[0].name, 'Second123.zip');
});

test('Gofile direct download URLs obtain a guest cookie instead of saving the share redirect', async () => {
    let accountCalls = 0;
    const resolver = createGofileResolver({
        userAgent: UA,
        allowWebsiteTokenFallback: true,
        request: async (method, url) => {
            if (url === 'https://gofile.io/') return { status: 503, headers: {}, body: '' };
            if (url === 'https://gofile.io/js/wt.obf.js') return { status: 503, headers: {}, body: '' };
            if (url === 'https://api.gofile.io/accounts') {
                accountCalls++;
                return { status: 200, headers: {}, body: JSON.stringify({ status: 'ok', data: { token: 'direct-file-token' } }) };
            }
            throw new Error(`Unexpected request: ${method} ${url}`);
        }
    });

    const direct = 'https://store4.gofile.io/download/web/File123/Game%20Payload.rar';
    const files = await resolver(direct);
    assert.equal(accountCalls, 1);
    assert.equal(files[0].url, direct);
    assert.equal(files[0].name, 'Game Payload.rar');
    assert.ok(files[0].headers.includes('Cookie: accountToken=direct-file-token'));
    assert.ok(files[0].headers.includes('Origin: https://gofile.io'));
});

test('Gofile refreshes rejected guest tokens for every current authentication status', async () => {
    for (const rejectedStatus of ['error-wrongToken', 'error-notAuthenticated', 'error-badToken', 'error-notPremium']) {
        let accountCalls = 0;
        let contentCalls = 0;
        const resolver = createGofileResolver({
            userAgent: UA,
            allowWebsiteTokenFallback: true,
            request: async (method, url) => {
                if (url === 'https://gofile.io/') return { status: 503, headers: {}, body: '' };
                if (url === 'https://gofile.io/js/wt.obf.js') return { status: 503, headers: {}, body: '' };
                if (url === 'https://api.gofile.io/accounts') {
                    accountCalls++;
                    return {
                        status: 200,
                        headers: {},
                        body: JSON.stringify({ status: 'ok', data: { token: `token-${accountCalls}` } })
                    };
                }
                if (url.startsWith('https://api.gofile.io/contents/')) {
                    contentCalls++;
                    if (contentCalls === 1) return { status: 401, headers: {}, body: JSON.stringify({ status: rejectedStatus, data: {} }) };
                    return {
                        status: 200,
                        headers: {},
                        body: JSON.stringify({
                            status: 'ok',
                            metadata: { totalPages: 1 },
                            data: {
                                type: 'file',
                                name: 'Recovered.zip',
                                link: 'https://store1.gofile.io/download/web/Recovered/Recovered.zip'
                            }
                        })
                    };
                }
                throw new Error(`Unexpected request: ${method} ${url}`);
            }
        });

        const files = await resolver('https://gofile.io/d/Refresh123');
        assert.equal(accountCalls, 2, rejectedStatus);
        assert.equal(contentCalls, 2, rejectedStatus);
        assert.ok(files[0].headers.includes('Cookie: accountToken=token-2'), rejectedStatus);
    }
});

test('BuzzHeavier page candidates preserve the file id and endpoint parser keeps the primary transfer', () => {
    assert.deepEqual(buzzHeavierPageCandidates('https://bzzhr.to/u33dxmmaozb6?ignored=1'), [
        'https://bzzhr.to/u33dxmmaozb6',
        'https://buzzheavier.com/u33dxmmaozb6',
        'https://bzzhr.co/u33dxmmaozb6',
        'https://fuckingfast.net/u33dxmmaozb6'
    ]);
    assert.deepEqual(buzzHeavierPageCandidates('https://buzzheavier.com/d/1763962223843270656/test_holes.zip'), [
        'https://buzzheavier.com/d/1763962223843270656/test_holes.zip',
        'https://bzzhr.to/d/1763962223843270656/test_holes.zip',
        'https://bzzhr.co/d/1763962223843270656/test_holes.zip',
        'https://fuckingfast.net/d/1763962223843270656/test_holes.zip'
    ]);
    assert.equal(
        extractBuzzHeavierEndpoint('<a hx-get="/u33dxmmaozb6/download?t=abc123&amp;alt=false">Download</a>', 'https://bzzhr.to/u33dxmmaozb6'),
        'https://bzzhr.to/u33dxmmaozb6/download?t=abc123'
    );
});

test('BuzzHeavier legacy direct-download routes probe once, then use the managed session for HTML challenges', async () => {
    let requestCalls = 0;
    const pageUrl = 'https://buzzheavier.com/d/1763962223843270656/test_holes.zip';
    const result = await resolveBuzzHeavierUrl(pageUrl, {
        request: async () => {
            requestCalls++;
            return { status: 403, headers: { 'content-type': 'text/html' }, body: '<title>Just a moment</title>' };
        },
        userAgent: UA,
        browserResolve: async () => ({
            url: pageUrl,
            pageUrl,
            name: 'test_holes.zip',
            capturedDownload: true,
            headers: [`Referer: ${pageUrl}`, `User-Agent: ${UA}`, 'Cookie: cf_clearance=test']
        })
    });

    assert.equal(requestCalls, 1);
    assert.deepEqual(result, [{
        url: pageUrl,
        name: 'test_holes.zip',
        kind: 'http',
        maxConn: 1,
        headers: [`Referer: ${pageUrl}`, `User-Agent: ${UA}`, 'Cookie: cf_clearance=test'],
        resumeAcrossFreshUrl: true
    }]);
});

test('BuzzHeavier legacy and CDN transfers stay browser-free when a bounded probe confirms bytes', async () => {
    let browserCalls = 0;
    const pageUrl = 'https://buzzheavier.com/d/1763962223843270656/test_holes.zip';
    const result = await resolveBuzzHeavierUrl(pageUrl, {
        request: async (_method, _url, options) => {
            assert.equal(options.headers.Range, 'bytes=0-0');
            return {
                status: 206,
                headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="test_holes.zip"' },
                body: 'x'
            };
        },
        browserResolve: async () => { browserCalls++; return null; }
    });
    assert.equal(browserCalls, 0);
    assert.equal(result[0].url, pageUrl);
    assert.equal(result[0].maxConn, 1);

    const cdn = await resolveBuzzHeavierUrl('https://cdn.buzzheavier.com/files/game.rar?token=signed', {
        request: async () => { throw new Error('already-direct CDN URLs must not be fetched by the resolver'); },
        browserResolve: async () => { browserCalls++; return null; }
    });
    assert.equal(cdn[0].url, 'https://cdn.buzzheavier.com/files/game.rar?token=signed');
    assert.equal(browserCalls, 0);
});

test('BuzzHeavier resolver performs the token handshake and returns an aria2-ready file', async () => {
    const calls = [];
    const request = async (method, url, options) => {
        calls.push({ method, url, options });
        if (calls.length === 1) return {
            status: 200,
            headers: {},
            body: '<button hx-get="/u33dxmmaozb6/download?t=signed-token">Download</button>'
        };
        return {
            status: 204,
            headers: { 'hx-redirect': 'https://cdn.buzzheavier.com/files/Game%20Payload.rar?signature=ok' },
            body: ''
        };
    };

    const result = await resolveBuzzHeavierUrl('https://bzzhr.to/u33dxmmaozb6', {
        request,
        userAgent: UA,
        referer: 'https://steamrip.com/',
        acceptDirectUrl: url => !url.includes('ads.example')
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.Referer, 'https://steamrip.com/');
    assert.equal(calls[1].url, 'https://bzzhr.to/u33dxmmaozb6/download?t=signed-token');
    assert.equal(calls[1].options.follow, false);
    assert.equal(calls[1].options.headers['HX-Current-URL'], 'https://bzzhr.to/u33dxmmaozb6');
    assert.deepEqual(result, [{
        url: 'https://cdn.buzzheavier.com/files/Game%20Payload.rar?signature=ok',
        name: 'Game Payload.rar',
        kind: 'http',
        maxConn: 1,
        headers: ['Referer: https://bzzhr.to/u33dxmmaozb6', `User-Agent: ${UA}`],
        resumeAcrossFreshUrl: true
    }]);
});

test('BuzzHeavier resolver falls back to the managed Chromium session after HTTP challenges', async () => {
    let browserCalls = 0;
    const result = await resolveBuzzHeavierUrl('https://bzzhr.to/op1ye15r9ifp', {
        request: async () => ({ status: 403, headers: {}, body: 'challenge' }),
        userAgent: UA,
        referer: 'https://steamrip.com/',
        browserResolve: async (pageUrl, sourceReferer) => {
            browserCalls++;
            assert.equal(pageUrl, 'https://bzzhr.to/op1ye15r9ifp');
            assert.equal(sourceReferer, 'https://steamrip.com/');
            return { url: 'https://cdn.buzzheavier.com/files/meta-ghost.rar', pageUrl };
        }
    });

    assert.equal(browserCalls, 1);
    assert.equal(result[0].url, 'https://cdn.buzzheavier.com/files/meta-ghost.rar');
    assert.equal(result[0].name, 'meta-ghost.rar');
    assert.equal(result[0].resumeAcrossFreshUrl, true);
});

test('BuzzHeavier resolver rejects an unsafe browser redirect', async () => {
    const result = await resolveBuzzHeavierUrl('https://bzzhr.to/op1ye15r9ifp', {
        request: async () => ({ status: 403, headers: {}, body: '' }),
        browserResolve: async () => ({ url: 'http://ads.example/payload.rar' })
    });
    assert.equal(result, null);

    assert.equal(await resolveBuzzHeavierUrl('https://bzzhr.to/op1ye15r9ifp', {
        request: async () => ({ status: 403, headers: {}, body: '' }),
        browserResolve: async () => ({ url: 'https://ads.example/payload.rar' })
    }), null);

    const bounced = await resolveBuzzHeavierUrl('https://bzzhr.to/op1ye15r9ifp', {
        request: async () => ({ status: 403, headers: {}, body: '' }),
        browserResolve: async pageUrl => ({ url: `${pageUrl}/`, pageUrl })
    });
    assert.equal(bounced, null);
});

test('FileDitch resolver verifies its provider redirect before returning the file', async () => {
    const calls = [];
    const source = 'https://fileditchfiles.me/file.php?f=/alpha4/Cbpunk-2ksvenseven-SteamRIP.com.rar';
    const result = await resolveFileDitchUrl(source, {
        userAgent: UA,
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            if (calls.length === 1) return {
                status: 302,
                headers: { location: 'https://fileditchfiles.me/alpha4/Cbpunk-2ksvenseven-SteamRIP.com.rar' },
                body: ''
            };
            return {
                status: 206,
                headers: { 'content-type': 'application/octet-stream' },
                body: ''
            };
        }
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[0].options.follow, false);
    assert.equal(calls[0].options.headers.Range, 'bytes=0-0');
    assert.equal(calls[0].options.headersOnly, true);
    assert.equal(calls[1].url, 'https://fileditchfiles.me/alpha4/Cbpunk-2ksvenseven-SteamRIP.com.rar');
    assert.deepEqual(result, [{
        url: 'https://fileditchfiles.me/alpha4/Cbpunk-2ksvenseven-SteamRIP.com.rar',
        name: 'Cbpunk-2ksvenseven-SteamRIP.com.rar',
        kind: 'http',
        headers: ['Referer: https://fileditchfiles.me/', `User-Agent: ${UA}`]
    }]);
});

test('FileDitch resolver reports an expired file instead of saving its SteamRIP redirect as an archive', async () => {
    let calls = 0;
    await assert.rejects(resolveFileDitchUrl(
        'https://fileditchfiles.me/file.php?f=/alpha4/Cbpunk-2ksvenseven-SteamRIP.com.rar',
        {
            request: async () => {
                calls++;
                return calls === 1
                    ? { status: 302, headers: { location: 'https://fileditchfiles.me/alpha4/Cbpunk-2ksvenseven-SteamRIP.com.rar' }, body: '' }
                    : { status: 302, headers: { location: 'https://steamrip.com/' }, body: '' };
            }
        }
    ), error => {
        assert.equal(error.linkHealth, 'down');
        assert.equal(error.healthReason, 'fileditch-redirected-away');
        assert.match(error.message, /offline or expired/i);
        return true;
    });
    assert.equal(calls, 2);
});

test('FileDitch resolver reports unrelated redirect hosts as unusable', async () => {
    await assert.rejects(resolveFileDitchUrl('https://fileditchfiles.me/file.php?f=game.rar', {
        request: async () => ({ status: 302, headers: { location: 'https://ads.example/game.rar' }, body: '' })
    }), error => error.linkHealth === 'down' && error.healthReason === 'fileditch-redirected-away');
});

test('FileDitch server failures are reported immediately instead of opening a browser handoff', async () => {
    await assert.rejects(resolveFileDitchUrl('https://fileditchfiles.me/file.php?f=game.rar', {
        request: async () => ({ status: 502, headers: { 'content-type': 'text/html' }, body: '' })
    }), error => {
        assert.equal(error.linkHealth, 'down');
        assert.equal(error.healthReason, 'fileditch-http-502');
        assert.match(error.message, /unavailable right now/i);
        return true;
    });
});

test('MegaDB resolver preserves SteamRIP approval, waits out the host timer, and returns the signed CDN link', async () => {
    const calls = [];
    const waits = [];
    const pageUrl = 'https://megadb.net/l0ocjalalca4';
    const tokenUrl = pageUrl + '?pt=signed-page-token';
    const tokenScript = "<script>var seconds = 10; var finalDownloadUrl = '" + tokenUrl + "';</script>";
    assert.deepEqual(megadbTokenDetails(tokenScript, pageUrl), { url: tokenUrl, waitMs: 11000 });

    const result = await resolveMegaDbUrl(pageUrl, {
        userAgent: UA,
        referer: 'https://steamrip.com/',
        wait: async milliseconds => waits.push(milliseconds),
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            if (calls.length === 1) {
                return {
                    status: 200,
                    headers: { 'set-cookie': ['filehosting=session-value; Path=/; HttpOnly'] },
                    body: tokenScript
                };
            }
            return {
                status: 302,
                headers: { location: 'https://fs9.megadb.xyz/l0ocjalalca4/Discounty-SteamRIP.com.rar?download_token=signed' },
                body: ''
            };
        }
    });

    assert.deepEqual(waits, [11000]);
    assert.equal(calls[0].options.headers.Referer, 'https://steamrip.com/');
    assert.equal(calls[1].url, tokenUrl);
    assert.equal(calls[1].options.headers.Referer, pageUrl);
    assert.equal(calls[1].options.headers.Cookie, 'filehosting=session-value');
    assert.deepEqual(result, [{
        url: 'https://fs9.megadb.xyz/l0ocjalalca4/Discounty-SteamRIP.com.rar?download_token=signed',
        name: 'Discounty-SteamRIP.com.rar',
        kind: 'http',
        maxConn: 16,
        headers: ['Referer: ' + pageUrl, 'User-Agent: ' + UA]
    }]);
});

test('MegaDB resolver refuses missing source approval and unrelated redirects', async () => {
    let calls = 0;
    const request = async () => {
        calls++;
        return {
            status: calls === 1 ? 200 : 302,
            headers: calls === 1 ? {} : { location: 'https://ads.example/game.rar' },
            body: calls === 1
                ? "<script>var seconds = 0; var finalDownloadUrl = 'https://megadb.net/filecode?pt=token';</script>"
                : ''
        };
    };
    assert.equal(await resolveMegaDbUrl('https://megadb.net/filecode', { request }), null);
    assert.equal(calls, 0);
    assert.equal(await resolveMegaDbUrl('https://megadb.net/filecode', {
        request,
        referer: 'https://steamrip.com/',
        wait: async () => {}
    }), null);
});

test('MegaDB connection hints stay wired to aria2 segmented range transfers', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(main, /const conns = file\.maxConn \|\| 16;/);
    assert.match(main, /'--max-connection-per-server=' \+ conns/);
    assert.match(main, /'--split=' \+ conns/);
    assert.match(main, /'--min-split-size=1M'/);
});

test('PixelDrain resolver expands list files and keeps API links credential-free', async () => {
    const calls = [];
    const result = await resolvePixeldrainUrl('https://pixeldrain.com/l/abc12345', {
        userAgent: UA,
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            if (/\/api\/file\//.test(url)) return {
                status: 206,
                headers: { 'content-type': 'application/octet-stream' },
                body: 'x'
            };
            return {
                status: 200,
                headers: {},
                body: JSON.stringify({ files: [
                    { id: 'file0001', name: 'part one.rar' },
                    { id: 'file0002', name: 'part two.rar' }
                ] })
            };
        }
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'https://pixeldrain.com/api/list/abc12345');
    assert.deepEqual(result.map(file => ({ url: file.url, name: file.name, maxConn: file.maxConn })), [
        { url: 'https://pixeldrain.com/api/file/file0001?download', name: 'part one.rar', maxConn: 16 },
        { url: 'https://pixeldrain.com/api/file/file0002?download', name: 'part two.rar', maxConn: 16 }
    ]);
    const direct = await resolvePixeldrainUrl('https://pixeldrain.com/u/file0001');
    assert.equal(direct[0].url, 'https://pixeldrain.com/api/file/file0001?download');
});

test('PixelDrain resolver tries the direct API first, then configured Workers after a rate limit', async () => {
    const calls = [];
    const result = await resolvePixeldrainUrl('https://pixeldrain.com/u/file0001', {
        userAgent: UA,
        proxyUrls: ['https://worker-one.example', 'https://worker-two.example'],
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            if (url.startsWith('https://pixeldrain.com')) return { status: 429, headers: { 'content-type': 'application/json' }, body: '{"value":"rate_limit"}' };
            if (url.startsWith('https://worker-one.example')) return { status: 403, headers: { 'content-type': 'text/html' }, body: 'hotlink_detected' };
            return { status: 206, headers: { 'content-type': 'application/octet-stream' }, body: 'x' };
        }
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.url), [
        'https://pixeldrain.com/api/file/file0001?download',
        'https://worker-one.example/?url=https%3A%2F%2Fpixeldrain.com%2Fapi%2Ffile%2Ffile0001%3Fdownload',
        'https://worker-two.example/?url=https%3A%2F%2Fpixeldrain.com%2Fapi%2Ffile%2Ffile0001%3Fdownload'
    ]);
    assert.equal(calls.every(call => call.options.headers.Range === 'bytes=0-0'), true);
    assert.equal(result[0].url, 'https://worker-two.example/?url=https%3A%2F%2Fpixeldrain.com%2Fapi%2Ffile%2Ffile0001%3Fdownload');
});

test('PixelDrain disables a failed custom worker for the rest of a list and reports down/rate-limited files', async () => {
    const calls = [];
    const list = await resolvePixeldrainUrl('https://pixeldrain.com/l/abc12345', {
        proxyUrls: ['https://worker-one.example', 'https://worker-two.example'],
        request: async (_method, url) => {
            calls.push(url);
            if (/\/api\/list\//.test(url)) return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ files: [{ id: 'file0001' }, { id: 'file0002' }] })
            };
            if (url.startsWith('https://worker-one.example')) return {
                status: 403,
                headers: { 'content-type': 'application/json' },
                body: '{"value":"hotlink_detected"}'
            };
            if (url.startsWith('https://worker-two.example')) {
                return { status: 206, headers: { 'content-type': 'application/octet-stream' }, body: 'x' };
            }
            return { status: 429, headers: { 'content-type': 'application/json' }, body: '{"value":"rate_limit"}' };
        }
    });
    assert.equal(list.length, 2);
    assert.equal(calls.filter(url => url.startsWith('https://worker-one.example')).length, 1);

    await assert.rejects(resolvePixeldrainUrl('https://pixeldrain.com/u/file0001', {
        request: async () => ({ status: 404, headers: { 'content-type': 'application/json' }, body: '{"value":"not_found"}' })
    }), error => error && error.linkHealth === 'down');
    await assert.rejects(resolvePixeldrainUrl('https://pixeldrain.com/u/file0001', {
        request: async () => ({ status: 429, headers: { 'content-type': 'application/json' }, body: '{"value":"rate_limit"}' })
    }), error => error && error.providerRateLimited === true && error.needsBrowser === false);
    await assert.rejects(resolvePixeldrainUrl('https://pixeldrain.com/l/missing1', {
        request: async () => ({ status: 404, headers: { 'content-type': 'application/json' }, body: '{"value":"list_not_found"}' })
    }), error => error && error.linkHealth === 'down' && error.healthReason === 'pixeldrain-list-not-found');
    await assert.rejects(resolvePixeldrainUrl('https://pixeldrain.com/l/limited1', {
        request: async () => ({ status: 429, headers: { 'content-type': 'application/json' }, body: '{"value":"rate_limit"}' })
    }), error => error && error.providerRateLimited === true && error.needsBrowser === false);
});

test('FileKeeper resolver accepts only a provider redirect', async () => {
    const result = await resolveFileKeeperUrl('https://filekeeper.net/file/Abc12345', {
        userAgent: UA,
        request: async (method, url, options) => {
            assert.equal(method, 'POST');
            assert.equal(url, 'https://filekeeper.net/file/Abc12345');
            assert.match(options.body, /op=download2/);
            return { status: 302, headers: { location: 'https://dl.filekeeper.net/files/game.part1.rar' }, body: '' };
        }
    });
    assert.equal(result[0].url, 'https://dl.filekeeper.net/files/game.part1.rar');
    assert.equal(result[0].name, 'game.part1.rar');
    const tunnel = await resolveFileKeeperUrl('https://filekeeper.net/Abc12345/Game.part1.rar', {
        request: async () => ({ status: 302, headers: { location: 'https://tunnel3.dlproxy.uk/Abc12345' }, body: '' })
    });
    assert.equal(tunnel[0].name, 'Game.part1.rar');
    const current = await resolveFileKeeperUrl('https://filekeeper.net/Abc12345/Game.zip', {
        request: async () => ({
            status: 302,
            headers: { location: 'https://fs2.filekeeper.net:8443/d/abcdefghijklmnopqrstuvwxyz123456/Game.zip' },
            body: ''
        })
    });
    assert.equal(current[0].url, 'https://fs2.filekeeper.net:8443/d/abcdefghijklmnopqrstuvwxyz123456/Game.zip');
    assert.equal(current[0].name, 'Game.zip');
    assert.equal(fileKeeperDownloadUrl(
        'https://fs2.filekeeper.net:9443/d/abcdefghijklmnopqrstuvwxyz123456/Game.zip',
        'https://filekeeper.net/Abc12345/Game.zip',
        'filekeeper.net'
    ), '');
    assert.equal(fileKeeperDownloadUrl(
        'https://cdn.filekeeper.net:8443/d/abcdefghijklmnopqrstuvwxyz123456/Game.zip',
        'https://filekeeper.net/Abc12345/Game.zip',
        'filekeeper.net'
    ), '');
    assert.equal(await resolveFileKeeperUrl('https://filekeeper.net/file/Abc12345', {
        request: async () => ({ status: 302, headers: { location: 'https://ads.example/payload.exe' }, body: '' })
    }), null);
    assert.equal(await resolveFileKeeperUrl('https://filekeeper.net/file/Abc12345', {
        request: async () => ({ status: 200, headers: {}, body: '<a href="https://filekeeper.net/images/logo.png">Home</a>' })
    }), null);
});

test('DataNodes resolver accepts its signed off-site JSON handoff only after a bounded file probe', async () => {
    const component = '<download-countdown code="Abc12345" rand="nonce" referer="https://datanodes.to/Abc12345" :has-captcha="false" dl-token="token123"></download-countdown>';
    const calls = [];
    const result = await resolveDataNodesUrl('https://datanodes.to/Abc12345', {
        userAgent: UA,
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            if (calls.length === 1) return {
                status: 302,
                headers: { location: '/download', 'set-cookie': ['file_code=Abc12345; Path=/'] },
                body: ''
            };
            if (calls.length === 2) return { status: 200, headers: {}, body: component };
            if (calls.length === 3) return {
                status: 200,
                headers: {},
                body: JSON.stringify({ data: { url: 'https://storage.downloads.example/files/game.zip?token=signed' } })
            };
            return {
                status: 206,
                headers: {
                    'content-type': 'application/zip',
                    'content-disposition': 'attachment; filename="game.zip"'
                },
                body: ''
            };
        }
    });
    assert.equal(result[0].url, 'https://storage.downloads.example/files/game.zip?token=signed');
    assert.equal(result[0].maxConn, 1);
    assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), [
        'GET https://datanodes.to/Abc12345',
        'GET https://datanodes.to/download',
        'POST https://datanodes.to/download',
        'GET https://storage.downloads.example/files/game.zip?token=signed'
    ]);
    assert.match(calls[2].options.body, /dl_token=token123/);
    assert.equal(calls[2].options.headers['X-Dn-Dl'], '1');
    assert.equal(calls[2].options.headers.Cookie, 'file_code=Abc12345');
    assert.equal(calls[3].options.headers.Range, 'bytes=0-0');
    assert.equal(calls[3].options.headersOnly, true);
    assert.equal(calls[3].options.follow, false);
    assert.equal(calls[3].options.headers.Cookie, undefined);
    assert.equal(await resolveDataNodesUrl('https://datanodes.to/Abc12345', {
        request: async (method) => method === 'GET'
            ? ({ status: 200, headers: {}, body: component })
            : ({ status: 200, headers: {}, body: JSON.stringify({ url: 'https://ads.example/game.zip' }) })
    }), null);
    assert.equal(await resolveDataNodesUrl('https://datanodes.to/Abc12345', {
        request: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<img src="https://datanodes.to/images/logo.png">' })
    }), null);
});

test('DataNodes managed-browser response tags only the provider download JSON as transfer authority', () => {
    const source = 'https://datanodes.to/Abc12345';
    assert.deepEqual(extractDataNodesBrowserDownload({
        status: 200,
        url: 'https://datanodes.to/download',
        body: JSON.stringify({ data: { download_url: encodeURIComponent('https://cdn.datanodes.to/files/Game.part1.rar?token=signed') } })
    }, source), {
        url: 'https://cdn.datanodes.to/files/Game.part1.rar?token=signed',
        name: 'Game.part1.rar',
        pageUrl: 'https://datanodes.to/download',
        transferAuthority: DATANODES_BROWSER_TRANSFER_AUTHORITY
    });
    assert.deepEqual(extractDataNodesBrowserDownload({
        status: 200,
        url: 'https://datanodes.to/download',
        body: JSON.stringify({ url: 'https://storage.downloads.example/payload.rar?token=signed' })
    }, source), {
        url: 'https://storage.downloads.example/payload.rar?token=signed',
        name: 'payload.rar',
        pageUrl: 'https://datanodes.to/download',
        transferAuthority: DATANODES_BROWSER_TRANSFER_AUTHORITY
    });
    assert.equal(extractDataNodesBrowserDownload({
        status: 200,
        url: 'https://ads.example/download',
        body: JSON.stringify({ url: 'https://storage.downloads.example/payload.rar' })
    }, source), null);
    assert.equal(extractDataNodesBrowserDownload({
        status: 200,
        url: 'https://datanodes.to/download',
        body: '<html>not json</html>'
    }, source), null);
});

test('DataNodes browser transfer validation rejects ads, private hosts, HTML, and cookie leakage', async () => {
    const calls = [];
    const captured = {
        url: 'https://storage.files.example/signed/game.zip?token=one',
        name: 'game.zip',
        pageUrl: 'https://datanodes.to/download',
        userAgent: UA,
        cookieOrigin: 'https://datanodes.to',
        cookies: [{ name: 'file_code', value: 'Abc12345' }],
        transferAuthority: DATANODES_BROWSER_TRANSFER_AUTHORITY
    };
    const valid = await validateDataNodesBrowserTransfer(captured, {
        acceptUrl: value => !/malvertising\.example/i.test(value),
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            return {
                status: 206,
                headers: {
                    'content-type': 'application/zip',
                    'content-disposition': 'attachment; filename="game.zip"'
                },
                body: ''
            };
        }
    });
    assert.equal(valid.url, captured.url);
    assert.equal(valid.validatedTransfer, true);
    assert.deepEqual(valid.cookies, []);
    assert.equal(valid.headers, null);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].options.headers.Range, 'bytes=0-0');
    assert.equal(calls[0].options.headers.Cookie, undefined);
    assert.equal(calls[0].options.headersOnly, true);
    assert.equal(calls[0].options.follow, false);

    assert.equal(await validateDataNodesBrowserTransfer({ ...captured, transferAuthority: '' }, {
        request: async () => { throw new Error('must not request'); }
    }), null);
    assert.equal(await validateDataNodesBrowserTransfer({ ...captured, url: 'https://127.0.0.1/game.zip' }, {
        request: async () => { throw new Error('must not request'); }
    }), null);
    assert.equal(await validateDataNodesBrowserTransfer({ ...captured, url: 'https://malvertising.example/game.zip' }, {
        acceptUrl: value => !/malvertising\.example/i.test(value),
        request: async () => { throw new Error('must not request'); }
    }), null);
    assert.equal(await validateDataNodesBrowserTransfer(captured, {
        request: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '' })
    }), null);
});

test('FuckingFast managed-browser response accepts only the matching HX transfer', () => {
    const source = 'https://fuckingfast.co/f/Abc12345#Game.part1.rar';
    assert.deepEqual(extractFuckingFastBrowserDownload({
        status: 200,
        url: 'https://fuckingfast.co/f/Abc12345/go',
        headers: { 'HX-Redirect': '/dl/signed-transfer-token' },
        body: ''
    }, source), {
        url: 'https://fuckingfast.co/dl/signed-transfer-token',
        name: 'Game.part1.rar',
        pageUrl: 'https://fuckingfast.co/f/Abc12345/go'
    });
    assert.equal(extractFuckingFastBrowserDownload({
        status: 200,
        url: 'https://fuckingfast.co/f/Wrong123/go',
        headers: { 'hx-redirect': '/dl/signed-transfer-token' }
    }, source), null);
    assert.equal(extractFuckingFastBrowserDownload({
        status: 200,
        url: 'https://fuckingfast.co/f/Abc12345/go',
        headers: { 'hx-redirect': 'https://ads.example/payload.rar' }
    }, source), null);
    assert.equal(extractFuckingFastBrowserDownload({
        status: 200,
        url: 'https://fuckingfast.co/f/Abc12345/go',
        headers: { location: '/f/Abc12345' }
    }, source), null);
});

test('managed request capture accepts only provider transfer paths', () => {
    assert.equal(managedHostTransferRequest('datanodes',
        'https://s3.datanodes.to/d/signed-token', 'https://datanodes.to/Abc12345'), true);
    assert.equal(managedHostTransferRequest('datanodes',
        'https://datanodes.to/files/Game.part1.rar?token=signed', 'https://datanodes.to/Abc12345'), true);
    assert.equal(managedHostTransferRequest('datanodes',
        'https://datanodes.to/download', 'https://datanodes.to/Abc12345'), false);
    assert.equal(managedHostTransferRequest('datanodes',
        'https://datanodes.to/Abc12345', 'https://datanodes.to/Abc12345'), false);
    assert.equal(managedHostTransferRequest('datanodes',
        'https://cdn.datanodes.to/assets/logo.png', 'https://datanodes.to/Abc12345'), false);
    assert.equal(managedHostTransferRequest('datanodes',
        'https://ads.example/files/Game.rar', 'https://datanodes.to/Abc12345'), false);
    assert.equal(managedHostTransferRequest('fuckingfast',
        'https://fuckingfast.co/dl/signed-token', 'https://fuckingfast.co/f/Abc12345'), true);
    assert.equal(managedHostTransferRequest('fuckingfast',
        'https://fuckingfast.co/f/Abc12345/go', 'https://fuckingfast.co/f/Abc12345'), false);
});

test('managed browser wires provider response bodies into browser-context capture', async () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = main.indexOf('function managedHostResponseCapture(');
    const end = main.indexOf('async function resolveWithManagedHostBrowser(', start);
    const responseCapture = vm.runInNewContext(`(${main.slice(start, end).trim()}\n)`, {
        URL,
        DATANODES_HOST_RE: /(^|\.)datanodes\.(?:to|net)$/i,
        FUCKINGFAST_HOST_RE: /(^|\.)fuckingfast\.(?:co|com|net)$/i,
        extractDataNodesBrowserDownload,
        extractFuckingFastBrowserDownload,
        console: { warn() {} }
    });
    const source = 'https://fuckingfast.co/f/Abc12345#Game.rar';
    const capture = responseCapture('fuckingfast', source);
    assert.equal(capture.captureResponseUrl('https://fuckingfast.co/f/Abc12345/go'), true);
    assert.equal(capture.captureResponseUrl('https://fuckingfast.co/f/Wrong123/go'), true);
    const handled = await capture.handleResponse({
        status: 204,
        url: 'https://fuckingfast.co/f/Abc12345/go',
        headers: { 'hx-redirect': '/dl/signed-token' },
        body: ''
    });
    assert.deepEqual(JSON.parse(JSON.stringify(handled)), {
        attachBrowserContext: true,
        value: {
            url: 'https://fuckingfast.co/dl/signed-token',
            name: 'Game.rar',
            pageUrl: 'https://fuckingfast.co/f/Abc12345/go'
        }
    });
    assert.equal(await capture.handleResponse({
        status: 204,
        url: 'https://fuckingfast.co/f/Wrong123/go',
        headers: { 'hx-redirect': '/dl/signed-token' },
        body: ''
    }), null);

    const dataNodesSource = 'https://datanodes.to/Abc12345';
    const dataNodesCapture = responseCapture('datanodes', dataNodesSource);
    assert.equal(dataNodesCapture.captureResponseUrl('https://datanodes.to/download'), true);
    assert.equal(dataNodesCapture.captureResponseUrl('https://storage.files.example/game.zip'), false);
    const dataNodesHandled = await dataNodesCapture.handleResponse({
        status: 200,
        url: 'https://datanodes.to/download',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://storage.files.example/signed/game.zip?token=one' })
    });
    assert.deepEqual(JSON.parse(JSON.stringify(dataNodesHandled)), {
        attachBrowserContext: true,
        value: {
            url: 'https://storage.files.example/signed/game.zip?token=one',
            name: 'game.zip',
            pageUrl: 'https://datanodes.to/download',
            transferAuthority: DATANODES_BROWSER_TRANSFER_AUTHORITY
        }
    });
    assert.equal(await dataNodesCapture.handleResponse({
        status: 200,
        url: 'https://ads.example/download',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://storage.files.example/game.zip' })
    }), null);
});

test('Rootz resolver uses the page token and reports deleted files as down', async () => {
    const pageUrl = 'https://www.rootz.so/d/1OXKoy';
    const token = 'MU9YS295OjU5NTk4ODQ.BD44e8cPZnTGzuJrG3wyNfb3p4sIQRCc7OZKKbrGd-o';
    const page = `<script>self.__next_f.push([1,"{\\"pageToken\\":\\"${token}\\"}"])</script>`;
    assert.deepEqual(rootzPageDetails(page, pageUrl), { shortId: '1OXKoy', pageToken: token });

    const calls = [];
    const active = await resolveRootzUrl(pageUrl, {
        userAgent: UA,
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            if (calls.length === 1) return { status: 200, headers: {}, body: page };
            return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ success: true, data: {
                    fileName: 'Game.zip',
                    fileId: '653940d2-bd88-4752-ae3b-e33e78721b5c',
                    status: 'active',
                    downloadAllowed: true
                } })
            };
        }
    });
    assert.equal(calls[1].url, 'https://www.rootz.so/api/files/download-by-short?shortId=1OXKoy');
    assert.equal(calls[1].options.headers['X-Page-Token'], token);
    assert.deepEqual(active, [{
        url: 'https://www.rootz.so/api/files/proxy-download/653940d2-bd88-4752-ae3b-e33e78721b5c',
        name: 'Game.zip',
        kind: 'http',
        maxConn: 1,
        headers: [`Referer: ${pageUrl}`, `User-Agent: ${UA}`, `X-Page-Token: ${token}`]
    }]);

    await assert.rejects(() => resolveRootzUrl(pageUrl, {
        request: async (_method, _url, _options) => _url === pageUrl
            ? { status: 200, headers: {}, body: page }
            : { status: 200, headers: {}, body: JSON.stringify({ success: true, data: {
                status: 'deleted', downloadAllowed: false
            } }) }
    }), error => error && error.linkHealth === 'down' && /deleted/i.test(error.message));
});

test('VikingFile resolver follows only provider redirects and never accepts Telegram links', async () => {
    const pageUrl = 'https://vikingfile.com/f/Abc12345';
    const calls = [];
    await assert.rejects(() => resolveVikingFileUrl(pageUrl, {
        request: async (method, url, options) => {
            calls.push({ method, url, options });
            return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exist: false }) };
        }
    }), error => error && error.linkHealth === 'down');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://vikingfile.com/api/check-file');
    assert.equal(calls[0].options.body, 'hash=Abc12345');

    assert.equal(await resolveVikingFileUrl(pageUrl, {
        request: async (_method, url) => url.includes('/api/check-file')
            ? { status: 503, headers: {}, body: '' }
            : { status: 302, headers: { location: 'https://t.me/vikingfile_com' }, body: '' }
    }), null);

    const active = await resolveVikingFileUrl('https://vik1ngfile.site/f/Live1234', {
        userAgent: UA,
        request: async (_method, url) => url.includes('/api/check-file')
            ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exist: true, name: 'Game.zip' }) }
            : {
                status: 200,
                headers: { 'content-type': 'text/html' },
                body: '<script>window.file="https://vik1ngfile.site/download/Live1234/Game.zip"</script>'
            }
    });
    assert.equal(active[0].url, 'https://vik1ngfile.site/download/Live1234/Game.zip');
});

test('AkiraBox resolver reads the public status API without using owner link renewal', async () => {
    const calls = [];
    const result = await resolveAkiraBoxUrl('https://akirabox.to/Abc12345/file', {
        userAgent: UA,
        request: async (method, url) => {
            calls.push(url);
            assert.equal(method, 'GET');
            assert.match(url, /\/api\/files\?url=/);
            return { status: 200, headers: {}, body: JSON.stringify({ data: { downloadUrl: 'https://akirabox.com/download/Abc12345?token=public' } }) };
        }
    });
    assert.equal(result[0].url, 'https://akirabox.com/download/Abc12345?token=public');
    assert.deepEqual(calls, [
        'https://akirabox.to/api/files?url=https%3A%2F%2Fakirabox.to%2FAbc12345%2Ffile'
    ]);
    assert.equal(await resolveAkiraBoxUrl('https://akirabox.to/Abc12345/file', {
        request: async () => ({ status: 200, headers: {}, body: JSON.stringify({ data: { url: 'https://akirabox.com/Abc12345/file' } }) })
    }), null);
    assert.equal(await resolveAkiraBoxUrl('https://akirabox.to/Abc12345/file', {
        request: async () => ({ status: 200, headers: {}, body: JSON.stringify({ data: { url: 'https://ads.example/payload.zip' } }) })
    }), null);
});

test('AkiraBox canonical not-found can be superseded by a successful alternate API origin', async () => {
    const calls = [];
    const result = await resolveAkiraBoxUrl('https://akirabox.com/Abc12345/file', {
        request: async (_method, url) => {
            calls.push(url);
            if (url.startsWith('https://akirabox.to/')) {
                return { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 404 }) };
            }
            return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ data: { downloadUrl: 'https://akirabox.com/download/Abc12345?token=alternate' } })
            };
        }
    });
    assert.equal(result[0].url, 'https://akirabox.com/download/Abc12345?token=alternate');
    assert.deepEqual(calls, [
        'https://akirabox.to/api/files?url=https%3A%2F%2Fakirabox.to%2FAbc12345%2Ffile',
        'https://akirabox.com/api/files?url=https%3A%2F%2Fakirabox.to%2FAbc12345%2Ffile'
    ]);
});

test('AkiraBox resolver reports a removed share without opening verification', async () => {
    await assert.rejects(
        resolveAkiraBoxUrl('https://akirabox.to/Abc12345/file', {
            request: async () => ({
                status: 404,
                body: JSON.stringify({ status: 404, message: 'File not found' }),
                headers: { 'content-type': 'application/json' }
            })
        }),
        error => error && error.linkHealth === 'down' && error.healthReason === 'akirabox-api-not-found'
    );
});

test('1337x resolver extracts safe alternatives and queues only the preferred magnet', async () => {
    const html = '<a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Game">magnet</a>'
        + '<a href="/torrent/1/game.torrent">torrent</a><a href="https://ads.example/game.torrent">ad</a>';
    const links = extract1337xLinks(html, 'https://1337x.to/torrent/1/game');
    assert.equal(links.length, 2);
    assert.equal(links[0].kind, 'magnet');
    assert.equal(links[1].url, 'https://1337x.to/torrent/1/game.torrent');
    const result = await resolve1337xUrl('https://1337x.to/torrent/1/game', {
        request: async () => ({ status: 200, headers: {}, body: html })
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'magnet');
    const torrentOnly = await resolve1337xUrl('https://1337x.to/torrent/1/game', {
        request: async () => ({ status: 200, headers: {}, body: '<a href="/torrent/1/game.torrent">torrent</a>' })
    });
    assert.equal(torrentOnly.length, 1);
    assert.equal(torrentOnly[0].url, 'https://1337x.to/torrent/1/game.torrent');
    assert.equal(await resolve1337xUrl('https://1337x.to/torrent/1/game', {
        request: async () => ({ status: 403, headers: {}, body: 'Just a moment...' })
    }), null);
});

test('managed browser fallback stays provider-scoped while AkiraBox uses the working default browser', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = main.indexOf('function managedHostUrlAllowed(');
    const end = main.indexOf('function managedHostPageAllowed(', start);
    assert.ok(start >= 0 && end > start);
    const allowed = vm.runInNewContext(`(${main.slice(start, end)})`, {
        URL,
        AKIRABOX_HOST_RE: /(^|\.)akirabox\.(?:com|to)$/i,
        BUZZHEAVIER_HOST_RE: /(^|\.)(?:bzzhr\.to|bzzhr\.co|buzzheavier\.com|fuckingfast\.net)$/i,
        DATANODES_HOST_RE: /(^|\.)datanodes\.(?:to|net)$/i,
        FILEDITCH_HOST_RE: /(^|\.)fileditch(?:files)?\.(?:com|net|me)$/i,
        FILEKEEPER_HOST_RE: /(^|\.)filekeeper\.(?:net|me|org|io)$/i,
        PIXELDRAIN_HOST_RE: /(^|\.)pixeldrain\.(?:com|net|in|nl|biz|tech|dev)$/i,
        ROOTZ_HOST_RE: /^(?:www\.)?rootz\.so$/i,
        VIKINGFILE_HOST_RE: /^(?:www\.)?(?:vikingfile\.com|vik1ngfile\.site)$/i,
        X1337_HOST_RE: /(^|\.)1337x\.(?:to|st|gd|is|tw|ws)$/i,
        credentialFreeHttpsUrl,
        fileKeeperDownloadUrl
    });
    assert.equal(allowed('filekeeper', 'https://tunnel3.dlproxy.uk/token', 'https://filekeeper.net/code/file.rar'), true);
    assert.equal(allowed('filekeeper', 'https://fs2.filekeeper.net:8443/d/abcdefghijklmnopqrstuvwxyz123456/Game.zip', 'https://filekeeper.net/code/file.rar'), true);
    assert.equal(allowed('filekeeper', 'https://fs2.filekeeper.net:9443/d/abcdefghijklmnopqrstuvwxyz123456/Game.zip', 'https://filekeeper.net/code/file.rar'), false);
    assert.equal(allowed('filekeeper', 'https://cdn.filekeeper.net:8443/d/abcdefghijklmnopqrstuvwxyz123456/Game.zip', 'https://filekeeper.net/code/file.rar'), false);
    assert.equal(allowed('filekeeper', 'https://ads.example/token', 'https://filekeeper.net/code/file.rar'), false);
    assert.equal(allowed('datanodes', 'https://cdn.datanodes.to/file.rar', 'https://datanodes.to/code'), true);
    assert.equal(allowed('akirabox', 'https://akirabox.com/code/file?download=1', 'https://akirabox.to/code/file'), true);
    assert.equal(allowed('buzzheavier', 'https://cdn.buzzheavier.com/files/game.rar?token=signed', 'https://bzzhr.to/Abc12345'), true);
    assert.equal(allowed('buzzheavier', 'https://ads.example/game.rar', 'https://bzzhr.to/Abc12345'), false);
    assert.equal(allowed('fileditch', 'https://fileditchfiles.me/files/game.rar', 'https://fileditchfiles.me/file.php?f=game.rar'), true);
    assert.equal(allowed('fileditch', 'https://ads.example/files/game.rar', 'https://fileditchfiles.me/file.php?f=game.rar'), false);
    assert.equal(allowed('multiup', 'https://multiup.io/download/123/game.rar', 'https://multiup.io/download/123/game.rar'), true);
    assert.equal(allowed('multiup', 'https://cdn.datanodes.to/files/game.rar', 'https://multiup.io/download/123/game.rar'), true);
    assert.equal(allowed('multiup', 'https://cdn.buzzheavier.com/files/game.rar', 'https://multiup.io/download/123/game.rar'), true);
    assert.equal(allowed('multiup', 'https://fuckingfast.co/download/game.rar', 'https://multiup.io/download/123/game.rar'), true);
    assert.equal(allowed('multiup', 'https://ads.example/files/game.rar', 'https://multiup.io/download/123/game.rar'), false);
    assert.equal(allowed('1337x', 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', 'https://1337x.to/torrent/1/game'), true);
    assert.equal(allowed('1337x', 'https://ads.example/game.torrent', 'https://1337x.to/torrent/1/game'), false);
    assert.equal(allowed('pixeldrain', 'https://user:pass@pixeldrain.com/api/file/id?download', 'https://pixeldrain.com/u/id'), false);
    assert.equal(allowed('rootz', 'https://www.rootz.so/api/files/proxy-download/653940d2-bd88-4752-ae3b-e33e78721b5c', 'https://www.rootz.so/d/1OXKoy'), true);
    assert.equal(allowed('rootz', 'https://www.rootz.so/d/1OXKoy', 'https://www.rootz.so/d/1OXKoy'), false);
    assert.equal(allowed('vikingfile', 'https://vik1ngfile.site/download/Live1234/Game.zip', 'https://vikingfile.com/f/Live1234'), true);
    assert.equal(allowed('vikingfile', 'https://t.me/vikingfile_com', 'https://vikingfile.com/f/Live1234'), false);

    const initialStart = main.indexOf('function managedHostInitialLoad(');
    const initialEnd = main.indexOf('function managedHostResponseCapture(', initialStart);
    assert.ok(initialStart >= 0 && initialEnd > initialStart);
    const initialLoad = vm.runInNewContext(`(${main.slice(initialStart, initialEnd)})`, {
        URL
    });
    const dataNodesLoad = initialLoad('datanodes', 'https://datanodes.to/Abc12345', 'https://steamgg.net/game');
    assert.equal(dataNodesLoad.url, 'https://datanodes.to/Abc12345');
    assert.equal(dataNodesLoad.loadOptions.httpReferrer, 'https://steamgg.net/game');
    assert.equal(dataNodesLoad.loadOptions.postData, undefined);
    assert.equal(initialLoad('akirabox', 'https://akirabox.to/Abc12345/file', 'https://steamgg.net/game').url,
        'https://akirabox.to/Abc12345/file');
    assert.equal(initialLoad('akirabox', 'https://akirabox.com/Abc12345/file', 'https://steamgg.net/game').url,
        'https://akirabox.to/Abc12345/file');
    assert.match(main, /'#download-button'/);

    const resolverStart = main.indexOf('async function resolveDirectUrl(');
    const resolverEnd = main.indexOf('function buildUnresolvedError(', resolverStart);
    const resolver = main.slice(resolverStart, resolverEnd);
    for (const provider of ['filekeeper', 'datanodes', 'buzzheavier', 'fileditch', 'fuckingfast', 'multiup', '1337x', 'pixeldrain', 'rootz', 'vikingfile']) {
        assert.match(resolver, new RegExp(`resolveWithManagedHostBrowser\\(rawUrl, '${provider}'`));
    }
    assert.doesNotMatch(resolver, /resolveWithManagedHostBrowser\(rawUrl, 'akirabox'/);
    assert.doesNotMatch(resolver, /if \(\/akirabox.*return null|if \(\/1337x.*return null|if \(\/fuckingfast.*return null/);
    assert.match(main, /sess\.cookies\.get\(\{ url: fileUrl \}\)/);
    assert.match(main, /partition: humanVerification \? `sail-verification-\$\{crypto\.randomUUID\(\)\}` : SOURCES_PARTITION,[\s\S]{0,180}nodeIntegration: false/);
    assert.match(main, /browserUserAgent = String\(win\.webContents\.getUserAgent\(\)/);
    const interceptStart = main.indexOf('function interceptDownload(');
    const interceptEnd = main.indexOf('function managedHostUrlAllowed(', interceptStart);
    const intercept = main.slice(interceptStart, interceptEnd);
    assert.doesNotMatch(intercept, /win\.webContents\.setUserAgent/);
    assert.match(intercept, /humanVerification \? `sail-verification-\$\{crypto\.randomUUID\(\)\}` : SOURCES_PARTITION/);
    assert.match(intercept, /applyAdBlock\(sess\)/);
    assert.doesNotMatch(intercept, /if \(!humanVerification\) applyAdBlock\(sess\)/);
    assert.match(main, /User-Agent: \$\{browserUserAgent\}/);
    assert.match(main, /new URL\(h,location\.href\)\.origin!==location\.origin/);
    assert.match(main, /el\.__sailDownloadClickAttempts=attempts\+1/);
    assert.match(main, /el\.__sailDownloadClickedAt=now/);
    assert.match(main, /__sailHumanVerificationComplete/);
    assert.match(main, /aria-disabled/);
    assert.match(main, /captureResponseUrl[\s\S]{0,1200}X-Dn-Dl|captureResponseUrl[\s\S]{0,1200}downloadUrl/);
    assert.match(main, /minimizeOnVerification:\s*true/);
    assert.match(main, /start download/);
    assert.match(main, /revealAfterMs: \['datanodes', 'akirabox', 'buzzheavier', 'fileditch', 'fuckingfast', 'multiup', '1337x', 'rootz', 'vikingfile'\]\.includes\(provider\) \? 1200 : 0/);
    assert.ok(main.indexOf('revealTimer = setTimeout(', main.indexOf('function interceptDownload('))
        < main.indexOf('win.loadURL(url, loadOptions)', main.indexOf('function interceptDownload(')));
    assert.match(main, /const managedHandoffVisible = revealAfterMs > 0 \|\| DL_KNOWN_HOST\.test\(String\(url \|\| ''\)\)/);
    assert.match(main, /show: managedHandoffVisible/);
    assert.match(main, /parent: humanVerification && mainWindow && !mainWindow\.isDestroyed\(\)[\s\S]{0,180}\? mainWindow/);
    assert.match(main, /win\.webContents\.on\('close', event => \{[\s\S]{0,220}event\.preventDefault\(\);[\s\S]{0,120}revealVerificationWindow\(\)/);
    assert.match(main, /win\.loadURL\(url, loadOptions\)\.catch\(\(\) => \{[\s\S]{0,260}if \(!managedHandoffVisible\) return finish\(null\);[\s\S]{0,120}revealVerificationWindow\(\)/);
    assert.match(main, /if\(gate && !globalThis\.__sailHumanVerificationComplete && \(!token \|\| !String\(token\.value\|\|'\'\)\.trim\(\)\)\) return false/);
    assert.match(main, /maxConn: \['buzzheavier', 'fuckingfast', 'datanodes'\]\.includes\(provider\) \? 1 : 16/);
    assert.match(main, /managedFile\.resumeAcrossFreshUrl = true/);
    assert.match(main, /managedFile\.dnsServers = BUZZHEAVIER_FALLBACK_DNS\.slice\(\)/);
    assert.match(main, /shouldPreservePartialForRetry\(file, e\)/);
    assert.match(main, /mergeRefreshedDownload\(file, (?:next|nf)\)/);
    assert.match(main, /win\.show\(\);\s*win\.focus\(\)/);
    assert.match(main, /resolve1337xWithSystemBrowser\(rawUrl, 20000, referer, opts\.signal\)/);
    assert.match(main, /findSystemChromiumExecutable\(\)/);
    assert.match(main, /resolveWithSystemChromium\(initial\.url,[\s\S]{0,900}visible: true,[\s\S]{0,180}appMode: true,[\s\S]{0,180}captureDownloads: true/);
    assert.match(main, /observeVerification: true/);
    assert.match(main, /minimizeOnVerification: true/);
    assert.match(main, /hideOnVerification: true/);
    assert.match(main, /onBlockedPopup:/);
    assert.match(main, /onBlockedNavigation:/);
    assert.match(main, /blockedHosts: adBlockEnabled \? AD_BLOCK_HOSTS : \[\]/);
    assert.match(intercept, /width: humanVerification \? 680 : 1200/);
    const verificationAccepted = intercept.indexOf("if (!state || done || !win || win.isDestroyed()) return;");
    const verificationReported = intercept.indexOf('options.onVerificationComplete()', verificationAccepted);
    const postVerificationClick = intercept.indexOf('tryClick();', verificationReported);
    assert.ok(verificationAccepted >= 0 && verificationReported > verificationAccepted
        && postVerificationClick > verificationReported,
    'verification advances to the real host download control');
    assert.match(intercept, /const activated = result === true[\s\S]{0,180}activated && humanVerification && verificationReported[\s\S]{0,300}options\.hideOnVerification === true[\s\S]{0,300}win\.hide\(\)/);
    assert.match(intercept, /!state\.verified[\s\S]{0,500}verificationReported = false[\s\S]{0,500}win\.show\(\); win\.focus\(\)/);
    assert.match(main, /postVerificationControlActivated:true/);
    const systemBrowserResolver = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'systemBrowserResolver.js'), 'utf8');
    assert.match(systemBrowserResolver, /value && value\.postVerificationControlActivated === true[\s\S]{0,260}minimizeVerification\(\)/);
    assert.match(systemBrowserResolver, /restoreBrowserWindow\(client, options\.parentBounds\)[\s\S]{0,700}onVerificationNeedsAttention/);
    assert.match(main, /MANAGED_SYSTEM_BROWSER_CLICK_JS/);
    assert.match(main, /humanVerification: true/);
    assert.match(main, /if \(!allowMultiInstance\) \{[\s\S]{0,260}setAsDefaultProtocolClient\('sail-launcher'/);
    assert.match(main, /BUZZHEAVIER_TRANSFER_HOST_RE = \/\(\^\|\\\.\)\(\?:buzzheavier\\\.com\|bzzhr\\\.\(\?:to\|co\)\|fuckingfast\\\.net\)\$\/i/);
    const buzzStart = main.indexOf('async function scrapeBuzzheavier(');
    const buzzEnd = main.indexOf('async function scrapeFileditch(', buzzStart);
    assert.ok(buzzStart >= 0 && buzzEnd > buzzStart);
    assert.match(main.slice(buzzStart, buzzEnd), /browserResolve:[\s\S]{0,220}resolveBuzzheavierWithSystemBrowser[\s\S]{0,100}8000/);
});

test('BuzzHeavier Cloudflare failures reach one visible managed verification flow', async () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const resolverStart = main.indexOf('async function resolveDirectUrl(');
    const resolverEnd = main.indexOf('function buildUnresolvedError(', resolverStart);
    assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
    const calls = [];
    const resolveDirectUrl = vm.runInNewContext(`(${main.slice(resolverStart, resolverEnd).trim()}\n)`, {
        SOURCE_REFERER: { steamrip: 'https://steamrip.com/' },
        normalizeFileCryptContainerUrl: () => '',
        debridActive: () => false,
        DL_KNOWN_HOST: /gofile|buzzheavier|bzzhr/i,
        scrapeBuzzheavier: async (url, referer) => {
            calls.push({ stage: 'hidden', url, referer });
            return null;
        },
        resolveWithManagedHostBrowser: async (url, provider, referer) => {
            calls.push({ stage: 'visible', url, provider, referer });
            return [{ url: 'https://cdn.buzzheavier.com/files/game.rar', kind: 'http' }];
        }
    });

    const source = 'https://bzzhr.to/b5shoz850p7t';
    const result = await resolveDirectUrl(source, { sourceId: 'steamrip' });
    assert.equal(result[0].url, 'https://cdn.buzzheavier.com/files/game.rar');
    assert.deepEqual(calls, [
        { stage: 'hidden', url: source, referer: 'https://steamrip.com/' },
        { stage: 'visible', url: source, provider: 'buzzheavier', referer: 'https://steamrip.com/' }
    ]);
});

test('FuckingFast tries the current direct POST before its visible cookie-preserving handoff', async () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const resolverStart = main.indexOf('async function resolveDirectUrl(');
    const resolverEnd = main.indexOf('function buildUnresolvedError(', resolverStart);
    assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
    const calls = [];
    const resolveDirectUrl = vm.runInNewContext(`(${main.slice(resolverStart, resolverEnd).trim()}\n)`, {
        SOURCE_REFERER: { fitgirl: 'https://fitgirl-repacks.site/' },
        normalizeFileCryptContainerUrl: () => '',
        debridActive: () => false,
        DL_KNOWN_HOST: /fuckingfast/i,
        scrapeFuckingfast: async url => {
            calls.push({ stage: 'direct', url });
            return null;
        },
        resolveWithManagedHostBrowser: async (url, provider, referer) => {
            calls.push({ stage: 'visible', url, provider, referer });
            return [{ url: 'https://fuckingfast.co/dl/signed-file', kind: 'http', maxConn: 1 }];
        }
    });

    const source = 'https://fuckingfast.co/n5mu14cmarb1#Mall_Together.rar';
    const result = await resolveDirectUrl(source, { sourceId: 'fitgirl' });
    assert.equal(result[0].url, 'https://fuckingfast.co/dl/signed-file');
    assert.deepEqual(calls, [{
        stage: 'direct',
        url: source
    }, {
        stage: 'visible',
        url: source,
        provider: 'fuckingfast',
        referer: 'https://fitgirl-repacks.site/'
    }]);
});

test('FuckingFast skips the verification window when the current POST returns a file', async () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const resolverStart = main.indexOf('async function resolveDirectUrl(');
    const resolverEnd = main.indexOf('function buildUnresolvedError(', resolverStart);
    let browserCalls = 0;
    const direct = [{ url: 'https://fuckingfast.co/dl/signed-file', kind: 'http', maxConn: 1 }];
    const resolveDirectUrl = vm.runInNewContext(`(${main.slice(resolverStart, resolverEnd).trim()}\n)`, {
        SOURCE_REFERER: { fitgirl: 'https://fitgirl-repacks.site/' },
        normalizeFileCryptContainerUrl: () => '',
        debridActive: () => false,
        DL_KNOWN_HOST: /fuckingfast/i,
        scrapeFuckingfast: async () => direct,
        resolveWithManagedHostBrowser: async () => { browserCalls += 1; return null; }
    });
    assert.equal(await resolveDirectUrl('https://fuckingfast.co/f/Abc12345', { sourceId: 'fitgirl' }), direct);
    assert.equal(browserCalls, 0);
});

test('FileDitch and MultiUp failures enter their visible provider-scoped handoff', async () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const resolverStart = main.indexOf('async function resolveDirectUrl(');
    const resolverEnd = main.indexOf('function buildUnresolvedError(', resolverStart);
    const calls = [];
    const resolveDirectUrl = vm.runInNewContext(`(${main.slice(resolverStart, resolverEnd).trim()}\n)`, {
        SOURCE_REFERER: { fitgirl: 'https://fitgirl-repacks.site/' },
        normalizeFileCryptContainerUrl: () => '',
        debridActive: () => false,
        DL_KNOWN_HOST: /multiup|fileditch/i,
        scrapeFileditch: async () => null,
        resolveWithManagedHostBrowser: async (url, provider, referer) => {
            calls.push({ url, provider, referer });
            return [{ url: provider === 'fileditch'
                ? 'https://fileditchfiles.me/files/game.rar'
                : 'https://cdn.datanodes.to/files/game.rar', kind: 'http' }];
        }
    });

    await resolveDirectUrl('https://fileditchfiles.me/file.php?f=game.rar', { sourceId: 'fitgirl' });
    await resolveDirectUrl('https://multiup.io/download/123/game.rar', { sourceId: 'fitgirl' });
    assert.deepEqual(calls, [
        {
            url: 'https://fileditchfiles.me/file.php?f=game.rar',
            provider: 'fileditch',
            referer: 'https://fitgirl-repacks.site/'
        },
        {
            url: 'https://multiup.io/download/123/game.rar',
            provider: 'multiup',
            referer: 'https://fitgirl-repacks.site/'
        }
    ]);
});

test('confirmed offline FileDitch links never open a pointless verification window', async () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const resolverStart = main.indexOf('async function resolveDirectUrl(');
    const resolverEnd = main.indexOf('function buildUnresolvedError(', resolverStart);
    let browserCalls = 0;
    const offline = Object.assign(new Error('FileDitch reports that this file is offline or expired.'), {
        linkHealth: 'down',
        healthReason: 'fileditch-redirected-away'
    });
    const resolveDirectUrl = vm.runInNewContext(`(${main.slice(resolverStart, resolverEnd).trim()}\n)`, {
        SOURCE_REFERER: { steamrip: 'https://steamrip.com/' },
        normalizeFileCryptContainerUrl: () => '',
        debridActive: () => false,
        DL_KNOWN_HOST: /fileditch/i,
        HEALTH_STATES: { DOWN: 'down' },
        scrapeFileditch: async () => { throw offline; },
        resolveWithManagedHostBrowser: async () => { browserCalls++; return null; }
    });

    await assert.rejects(
        resolveDirectUrl('https://fileditchfiles.me/file.php?f=expired.rar', { sourceId: 'steamrip' }),
        error => error === offline
    );
    assert.equal(browserCalls, 0);
});

test('exhausted protected hosts fail closed except AkiraBox, which names the normal-browser handoff', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = main.indexOf('function buildUnresolvedError(');
    const end = main.indexOf('function buildLinkDownError(', start);
    assert.ok(start >= 0 && end > start);
    const buildUnresolvedError = vm.runInNewContext(`(${main.slice(start, end).trim()}\n)`, { URL });

    for (const host of ['datanodes.to', 'buzzheavier.com', 'fileditchfiles.me',
        'fuckingfast.co', 'multiup.io', 'pixeldrain.com', 'vikingfile.com']) {
        const error = buildUnresolvedError(`https://${host}/download/example`);
        assert.equal(error.needsBrowser, false, `${host} must not fall through to an unmanaged browser`);
        assert.doesNotMatch(error.message, /open in browser/i);
    }

    const akira = buildUnresolvedError('https://akirabox.to/download/example');
    assert.equal(akira.needsBrowser, true);
    assert.match(akira.message, /normal browser/i);
    assert.match(akira.message, /ad blocker/i);

    const unknown = buildUnresolvedError('https://downloads.example/game');
    assert.equal(unknown.needsBrowser, true);
});

test('managed auto-click waits for a completed human-verification token', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const match = main.match(/const INTERCEPT_CLICK_JS = `([\s\S]*?)`;/);
    assert.ok(match);
    const clickScript = vm.runInNewContext(`\`${match[1]}\``);
    let clicks = 0;
    const anchor = {
        href: 'https://datanodes.to/files/game.rar',
        offsetParent: {},
        getClientRects: () => [{}],
        click: () => { clicks += 1; }
    };
    const execute = (tokenValue, previouslyVerified = false) => vm.runInNewContext(clickScript, {
        URL,
        __sailHumanVerificationComplete: previouslyVerified,
        document: {
            querySelector(selector) {
                if (selector.includes('cf-turnstile-response')) return { value: tokenValue };
                if (selector.includes('cf-turnstile') || selector.includes('challenges.cloudflare.com')) return {};
                return null;
            },
            querySelectorAll(selector) {
                return selector === 'a[href]' ? [anchor] : [];
            }
        }
    });

    assert.equal(execute(''), false);
    assert.equal(clicks, 0);
    assert.equal(execute('', true), true);
    assert.equal(clicks, 1);
    assert.equal(execute('verified-token'), false);
    assert.equal(clicks, 1);
    anchor.__sailDownloadClickedAt = Date.now() - 9000;
    assert.equal(execute('verified-token'), true);
    assert.equal(clicks, 2);
    anchor.__sailDownloadClickedAt = Date.now() - 9000;
    anchor.disabled = true;
    assert.equal(execute('verified-token'), false);
    assert.equal(clicks, 2);
});

test('managed auto-click recognizes the DataNodes standard-speed download label', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const match = main.match(/const INTERCEPT_CLICK_JS = `([\s\S]*?)`;/);
    assert.ok(match);
    const clickScript = vm.runInNewContext(`\`${match[1]}\``);
    let clicks = 0;
    const button = {
        textContent: 'Free Download\nStandard speed',
        value: '',
        offsetParent: {},
        getClientRects: () => [{}],
        click: () => { clicks += 1; }
    };
    const result = vm.runInNewContext(clickScript, {
        URL,
        location: { href: 'https://datanodes.to/file-code', origin: 'https://datanodes.to' },
        document: {
            querySelector: () => null,
            querySelectorAll(selector) {
                if (selector === 'a[href]') return [];
                if (selector === 'a,button,input[type=button],input[type=submit]') return [button];
                return [];
            }
        }
    });
    assert.equal(result, true);
    assert.equal(clicks, 1);
});

test('DataNodes managed flow clicks each step-two control once', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const match = main.match(/const DATANODES_SYSTEM_BROWSER_CLICK_JS = `([\s\S]*?)`;/);
    assert.ok(match);
    const clickScript = vm.runInNewContext(`\`${match[1]}\``);
    const clicked = [];
    const control = textContent => ({
        innerText: textContent,
        textContent,
        value: '',
        offsetParent: {},
        getClientRects: () => [{}],
        getBoundingClientRect: () => ({ width: 220, height: 48 }),
        getAttribute: () => '',
        click: () => clicked.push(textContent)
    });
    const free = control('Free Download / Standard speed');
    const start = control('Start Download\nYour file is ready');
    let controls = [free];
    const context = vm.createContext({
        document: {
            body: { innerText: 'STEP 2 OF 2 Quick check to unlock your download' },
            querySelector: () => null,
            querySelectorAll: () => controls
        }
    });
    assert.equal(vm.runInContext(clickScript, context).postVerificationControlActivated, true);
    assert.equal(vm.runInContext(clickScript, context), null);
    controls = [free, start];
    assert.equal(vm.runInContext(clickScript, context).postVerificationControlActivated, true);
    assert.equal(vm.runInContext(clickScript, context), null);
    assert.deepEqual(clicked, ['Free Download / Standard speed', 'Start Download\nYour file is ready']);
    assert.match(match[1], /\[role="button"\]/);
});

test('DataNodes legacy first step submits its required form exactly once', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const match = main.match(/const DATANODES_SYSTEM_BROWSER_CLICK_JS = `([\s\S]*?)`;/);
    const clickScript = vm.runInNewContext(`\`${match[1]}\``);
    let submits = 0;
    let appended = null;
    const form = {
        querySelector: () => appended,
        appendChild: value => { appended = value; },
        submit: () => { submits += 1; }
    };
    const button = {
        form,
        offsetParent: {},
        getClientRects: () => [{}],
        getBoundingClientRect: () => ({ width: 180, height: 44 }),
        getAttribute: () => ''
    };
    const context = vm.createContext({
        document: {
            body: { innerText: 'Free download' },
            createElement: () => ({}),
            querySelector(selector) {
                if (selector.startsWith('#downloadForm')) return form;
                if (selector === '#downloadReveal') return {};
                if (selector.startsWith('#method_free')) return button;
                return null;
            },
            querySelectorAll: () => []
        },
        getComputedStyle: () => ({ pointerEvents: 'auto', visibility: 'visible', display: 'block', opacity: '1' })
    });
    assert.equal(vm.runInContext(clickScript, context).postVerificationControlActivated, true);
    assert.equal(vm.runInContext(clickScript, context), null);
    assert.equal(submits, 1);
    assert.equal(appended.name, 'method_free');
    assert.equal(appended.value, 'Free Download >>');
});

test('DataNodes waits for the provider to arm its collapsed first step', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const match = main.match(/const DATANODES_SYSTEM_BROWSER_CLICK_JS = `([\s\S]*?)`;/);
    const clickScript = vm.runInNewContext(`\`${match[1]}\``);
    let submits = 0;
    const form = {
        querySelector: () => null,
        appendChild: () => {},
        submit: () => { submits += 1; }
    };
    const button = {
        disabled: true,
        offsetParent: {},
        getClientRects: () => [{}],
        getBoundingClientRect: () => ({ width: 180, height: 44 }),
        getAttribute: () => ''
    };
    const context = vm.createContext({
        document: {
            body: { innerText: 'Free download' },
            createElement: () => ({}),
            querySelector(selector) {
                if (selector.startsWith('#downloadForm')) return form;
                if (selector === '#downloadReveal') return {};
                if (selector.startsWith('#method_free')) return button;
                return null;
            },
            querySelectorAll: () => []
        },
        getComputedStyle: () => ({ pointerEvents: 'none', visibility: 'visible', display: 'block', opacity: '0' })
    });
    assert.equal(vm.runInContext(clickScript, context), null);
    assert.equal(submits, 0);
    assert.equal(context.__sailDataNodesStep1Submitted, undefined);
});

test('FuckingFast managed flow keeps accepted verification for four spaced provider clicks', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const match = main.match(/const FUCKINGFAST_SYSTEM_BROWSER_CLICK_JS = `([\s\S]*?)`;/);
    assert.ok(match);
    const clickScript = vm.runInNewContext(`\`${match[1]}\``);
    let clicks = 0;
    const control = {
        offsetParent: {},
        getClientRects: () => [{}],
        getAttribute: () => '',
        click: () => { clicks += 1; }
    };
    const context = vm.createContext({
        Date,
        dlCleared: false,
        document: {
            querySelector(selector) {
                if (selector.startsWith('.cf-turnstile')) return {};
                if (selector.includes('cf-turnstile-response')) return { value: '', getAttribute: () => '' };
                if (selector === '[hx-post*="/go"]') return control;
                return null;
            }
        }
    });
    assert.equal(vm.runInContext(clickScript, context), null);
    assert.equal(clicks, 0);
    context.dlCleared = true;
    assert.equal(vm.runInContext(clickScript, context).postVerificationControlActivated, true);
    assert.equal(vm.runInContext(clickScript, context), null);
    context.dlCleared = false;
    context.__sailHumanVerificationComplete = true;
    context.__sailFuckingFastGoAt = Date.now() - 8100;
    assert.equal(vm.runInContext(clickScript, context).postVerificationControlActivated, true);
    context.__sailFuckingFastGoAt = Date.now() - 8100;
    assert.equal(vm.runInContext(clickScript, context).postVerificationControlActivated, true);
    context.__sailFuckingFastGoAt = Date.now() - 8100;
    assert.equal(vm.runInContext(clickScript, context).postVerificationControlActivated, true);
    context.__sailFuckingFastGoAt = Date.now() - 8100;
    assert.equal(vm.runInContext(clickScript, context), null);
    assert.equal(clicks, 4);
});

test('FuckingFast verification ignores a preceding Cloudflare interstitial', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const match = main.match(/const FUCKINGFAST_VERIFICATION_STATE_JS = `([\s\S]*?)`;/);
    assert.ok(match);
    const stateScript = vm.runInNewContext(`\`${match[1]}\``);
    const token = { value: 'accepted-token', getAttribute: () => 'accepted-token' };
    const context = vm.createContext({
        document: {
            body: { innerText: 'Checking your browser' },
            querySelector(selector) {
                if (selector === '[hx-post*="/go"]') return null;
                if (selector.startsWith('input[name="cf-turnstile-response"')) return token;
                if (selector.startsWith('.cf-turnstile')) return {};
                return null;
            }
        }
    });
    assert.equal(vm.runInContext(stateScript, context).verified, false);
    context.document.querySelector = selector => {
        if (selector === '[hx-post*="/go"]') return {};
        if (selector.startsWith('input[name="cf-turnstile-response"')) return token;
        if (selector.startsWith('.cf-turnstile')) return {};
        return null;
    };
    assert.equal(vm.runInContext(stateScript, context).verified, true);
    token.value = '';
    token.getAttribute = () => '';
    context.__sailHumanVerificationComplete = true;
    assert.equal(vm.runInContext(stateScript, context).verified, true);
});

test('FuckingFast does not open an Electron verification fallback after system Chrome', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = main.indexOf('async function resolveWithManagedHostBrowser(');
    const end = main.indexOf('\nfunction ', start + 20);
    const resolver = main.slice(start, end > start ? end : main.length);
    assert.match(resolver, /if \(provider === 'fuckingfast'\)[\s\S]{0,260}no second verification window was opened[\s\S]{0,120}return null/);
    assert.match(resolver, /\.\.\.managedHostVerificationOptions\(provider\)/);
});

test('FuckingFast preserves its one-use transfer for aria2 and never auto-reopens verification after failure', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(main, /interceptTransferRequests: provider === 'fuckingfast'/);
    assert.match(main, /provider === 'fuckingfast'[\s\S]{0,900}managedFile\.requiresFreshVerification = true/);
    assert.match(main, /provider === 'fuckingfast'[\s\S]{0,900}managedFile\.disableIpv6 = true/);
    assert.match(main, /provider === 'fuckingfast'[\s\S]{0,1100}managedFile\.dnsServers = BUZZHEAVIER_FALLBACK_DNS\.slice\(\)/);
    assert.match(main, /!BUZZHEAVIER_TRANSFER_HOST_RE\.test\(host\) && !FUCKINGFAST_HOST_RE\.test\(host\)/);
    assert.match(main, /if \(file\.disableIpv6 === true\) args\.push\('--disable-ipv6=true'\)/);
    const retryStart = main.indexOf('while (attempt < 3 && !ok)');
    const retryEnd = main.indexOf('if (!ok) throw lastErr', retryStart);
    const retry = main.slice(retryStart, retryEnd);
    assert.match(retry, /if \(file\.requiresFreshVerification === true\)[\s\S]{0,700}attempt = 3;[\s\S]{0,80}break;/);
    assert.ok(retry.indexOf('file.requiresFreshVerification === true') < retry.indexOf('e && e.aria2Code === 22'));
});

test('renderer keeps managed providers one-click and routes AkiraBox to the default browser', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const blockedHostBody = index.match(/function isCFBlockedHost\(host\) \{[\s\S]*?\n        \}/);
    const restrictedHostBody = index.match(/function isRestrictedHost\(host\) \{[\s\S]*?\n        \}/);
    assert.ok(blockedHostBody);
    assert.ok(restrictedHostBody);
    assert.doesNotMatch(blockedHostBody[0], /buzzheavier|bzzhr/i);
    assert.match(blockedHostBody[0], /isExternalBrowserOnlyHost/);
    assert.match(index, /function isExternalBrowserOnlyHost\(host\) \{[\s\S]{0,180}akirabox/);
    assert.match(index, /isExternalBrowserOnlyHost\(set && set\.host\)[\s\S]{0,180}openSourcesBrowser\(part\.url, true/);
    assert.match(restrictedHostBody[0], /return false/);
    assert.doesNotMatch(restrictedHostBody[0], /buzzheavier|bzzhr|gofile|datanodes|akirabox|fuckingfast|1337x/i);
    assert.match(index, /if \(\/fileditch\/i\.test\(host\)\) return 86/);
    assert.match(index, /if \(\/buzzheavier\|bzzhr\/i\.test\(host\)\) return 82/);
    assert.doesNotMatch(main, /if \(\/buzzheavier\|bzzhr\/i\.test\(rawUrl\)\) return null/);
    assert.match(main, /else if \(\/buzzheavier\|bzzhr\/i\.test\(rawUrl\)\) r = await scrapeBuzzheavier\(rawUrl, referer\)/);
    assert.match(main, /else if \(\/fileditch\(\?:files\)\?\/i\.test\(rawUrl\)\) r = await scrapeFileditch\(rawUrl\)/);
    assert.match(main, /steamrip:\s*'https:\/\/steamrip\.com\/'/);
    assert.match(main, /navigationReferrer:\s*sourceReferer/);
    assert.match(index, /webview\.loadURL\(safeUrl, loadOptions\)/);
    assert.match(index, /openDownloadInAppBrowser\(download\.url, download\.referrer\)/);
    assert.match(index, /restrictedDownloads: true/);
    for (const host of ['datanodes.to', 'akirabox.to', '1337x.to', 'fuckingfast.co', 'fuckingfast.com']) {
        assert.match(index, new RegExp(host.replace('.', '\\.')));
    }
    assert.match(main, /hostProbe\.buttons\.length === 9/);
    assert.match(main, /hostProbe\.browserOpens\.length === 1/);
    assert.match(main, /hostProbe\.browserOpens\[0\]\.system === true/);
    assert.match(main, /row\.host === 'fuckingfast' && row\.partCount === 2/);
});
