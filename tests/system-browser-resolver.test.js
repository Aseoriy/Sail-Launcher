'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const {
    DEFAULT_VERIFICATION_RESOURCE_HOSTS,
    POPUP_GUARD_SOURCE,
    VERIFICATION_OBSERVER_SOURCE,
    VERIFICATION_STATE_EXPRESSION,
    findSystemChromiumExecutable,
    isLoopbackDebuggerUrl,
    minimizeBrowserWindow,
    restoreBrowserWindow,
    resolveWithSystemChromium,
    systemChromiumBlockPatterns,
    systemChromiumLaunchArgs,
    systemChromiumCandidates,
    verificationNeedsAttention,
    verificationWindowBounds
} = require('../runtime/systemBrowserResolver');

const env = {
    LOCALAPPDATA: 'C:\\Users\\Pookie\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)'
};

test('system Chromium discovery prefers an isolated-capable Chrome and keeps Edge/Vivaldi fallbacks', () => {
    const candidates = systemChromiumCandidates(env);
    assert.equal(candidates[0], path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    assert.ok(candidates.includes(path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
    assert.ok(candidates.includes(path.join(env.LOCALAPPDATA, 'Vivaldi', 'Application', 'vivaldi.exe')));

    const edge = path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    assert.equal(findSystemChromiumExecutable({ env, existsSync: candidate => candidate === edge }), edge);
    assert.equal(findSystemChromiumExecutable({ env, existsSync: () => false }), '');
});

test('DevTools websocket validation is loopback-only and type-specific', () => {
    assert.equal(isLoopbackDebuggerUrl('ws://127.0.0.1:49152/devtools/page/abc-123', 49152, 'page'), true);
    assert.equal(isLoopbackDebuggerUrl('ws://localhost:49152/devtools/browser/abc-123', 49152, 'browser'), true);
    assert.equal(isLoopbackDebuggerUrl('ws://example.com:49152/devtools/page/abc-123', 49152, 'page'), false);
    assert.equal(isLoopbackDebuggerUrl('ws://127.0.0.1:49153/devtools/page/abc-123', 49152, 'page'), false);
    assert.equal(isLoopbackDebuggerUrl('wss://127.0.0.1:49152/devtools/page/abc-123', 49152, 'page'), false);
    assert.equal(isLoopbackDebuggerUrl('ws://127.0.0.1:49152/devtools/browser/abc-123', 49152, 'page'), false);
});

test('interactive verification uses a compact app-mode Chromium window centered over Sail', () => {
    const parentBounds = { x: 100, y: 50, width: 1400, height: 900 };
    assert.deepEqual(verificationWindowBounds(parentBounds), {
        left: 460,
        top: 220,
        width: 680,
        height: 560
    });
    const visible = systemChromiumLaunchArgs(49152, 'C:\\Temp\\SailProfile', {
        visible: true,
        appMode: true,
        parentBounds
    });
    assert.ok(visible.includes('--window-position=460,220'));
    assert.ok(visible.includes('--window-size=680,560'));
    assert.ok(visible.includes('--app=about:blank'));
    assert.ok(!visible.includes('about:blank'));
    assert.ok(!visible.includes('--window-position=-2400,0'));
    assert.ok(visible.includes('--remote-debugging-port=49152'));
    assert.ok(!visible.some(value => /enable-automation|headless/i.test(value)));

    const hidden = systemChromiumLaunchArgs(49152, 'C:\\Temp\\SailProfile');
    assert.ok(hidden.includes('--window-position=-2400,0'));
});

test('verification ad blocking keeps challenge resources exempt and blocks ad networks', () => {
    const patterns = systemChromiumBlockPatterns([
        'doubleclick.net',
        'googlesyndication.com',
        'challenges.cloudflare.com',
        'not a host'
    ], DEFAULT_VERIFICATION_RESOURCE_HOSTS);
    assert.ok(patterns.some(pattern => pattern.urlPattern === '*://doubleclick.net:*/*' && pattern.block));
    assert.ok(patterns.some(pattern => pattern.urlPattern === '*://*.googlesyndication.com:*/*' && pattern.block));
    assert.ok(patterns.some(pattern => pattern.urlPattern === '*://challenges.cloudflare.com:*/*' && !pattern.block));
    assert.ok(!patterns.some(pattern => pattern.urlPattern.includes('challenges.cloudflare.com') && pattern.block));
    assert.ok(!patterns.some(pattern => pattern.urlPattern.includes('not a host')));
});

test('verification observer only detects completed challenge tokens and never clicks them', () => {
    assert.match(VERIFICATION_OBSERVER_SOURCE, /cf-turnstile-response/);
    assert.match(VERIFICATION_OBSERVER_SOURCE, /h-captcha-response/);
    assert.match(VERIFICATION_OBSERVER_SOURCE, /g-recaptcha-response/);
    assert.match(VERIFICATION_OBSERVER_SOURCE, /scrollIntoView/);
    assert.doesNotMatch(VERIFICATION_OBSERVER_SOURCE, /\.click\s*\(/);
});

test('verification state distinguishes a rejected challenge from accepted provider clearance', () => {
    const evaluate = ({ token = '', gate = true, text = '', dlCleared = false } = {}) => JSON.parse(JSON.stringify(vm.runInNewContext(VERIFICATION_STATE_EXPRESSION, {
        dlCleared,
        document: {
            body: { innerText: text },
            querySelector(selector) {
                if (selector.includes('cf-turnstile-response')) return { value: token, getAttribute: () => token };
                if (selector.includes('.cf-turnstile')) return gate ? { scrollIntoView() {} } : null;
                return null;
            }
        },
        window: {}
    })));
    assert.deepEqual(evaluate({ token: 'accepted-token' }), {
        gatePresent: true,
        verified: true,
        failed: false
    });
    assert.deepEqual(evaluate({ dlCleared: true }), {
        gatePresent: true,
        verified: true,
        failed: false
    });
    assert.deepEqual(evaluate({ text: 'Verification failed' }), {
        gatePresent: true,
        verified: false,
        failed: true
    });
});

test('completed challenge markup does not reopen a verified handoff unless failure is explicit', () => {
    assert.equal(verificationNeedsAttention({ gatePresent: true, verified: false, failed: false }, true), false);
    assert.equal(verificationNeedsAttention({ gatePresent: true, verified: true, failed: false }, true), false);
    assert.equal(verificationNeedsAttention({ gatePresent: true, verified: false, failed: true }, true), true);
    assert.equal(verificationNeedsAttention({ gatePresent: true, verified: false, failed: true }, false), false);
});

test('system browser can defer verification reporting to a provider-specific state expression', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'systemBrowserResolver.js'), 'utf8');
    assert.match(source, /verificationStateExpression = String\(options\.verificationStateExpression \|\| VERIFICATION_STATE_EXPRESSION\)/);
    assert.match(source, /installVerificationObserver = observeVerification && options\.installVerificationObserver !== false/);
    assert.match(source, /expression: verificationStateExpression/);
});

test('provider popup guard reports target-blank navigation without clicking or opening it', () => {
    assert.match(POPUP_GUARD_SOURCE, /window\.open=function\(url\)\{report\(url\);return null;/);
    assert.match(POPUP_GUARD_SOURCE, /closest\('a\[target\]'\)/);
    assert.match(POPUP_GUARD_SOURCE, /preventDefault\(\)/);
    assert.match(POPUP_GUARD_SOURCE, /stopImmediatePropagation\(\)/);
    assert.doesNotMatch(POPUP_GUARD_SOURCE, /\.click\s*\(/);
});

test('verified handoff is minimized through its existing DevTools target', async () => {
    const calls = [];
    const client = {
        async send(method, params) {
            calls.push({ method, params });
            if (method === 'Browser.getWindowForTarget') return { windowId: 42 };
            return {};
        }
    };
    assert.equal(await minimizeBrowserWindow(client), true);
    assert.deepEqual(calls.map(call => call.method), [
        'Browser.getWindowForTarget',
        'Browser.setWindowBounds'
    ]);
    assert.deepEqual(calls[1].params, {
        windowId: 42,
        bounds: { windowState: 'minimized' }
    });
});

test('a rejected verification restores the same compact handoff window', async () => {
    const calls = [];
    const client = {
        async send(method, params) {
            calls.push({ method, params });
            if (method === 'Browser.getWindowForTarget') return { windowId: 42 };
            return {};
        }
    };
    assert.equal(await restoreBrowserWindow(client, { x: 100, y: 50, width: 1400, height: 900 }), true);
    assert.deepEqual(calls.map(call => call.method), [
        'Browser.getWindowForTarget',
        'Browser.setWindowBounds',
        'Browser.setWindowBounds',
        'Page.bringToFront'
    ]);
    assert.deepEqual(calls[1].params, { windowId: 42, bounds: { windowState: 'normal' } });
    assert.deepEqual(calls[2].params, {
        windowId: 42,
        bounds: { left: 460, top: 220, width: 680, height: 560 }
    });
});

test('system Chromium navigation rejects an unsafe referrer before starting a browser', async () => {
    await assert.rejects(
        resolveWithSystemChromium('https://bzzhr.to/file-code', 'true', {
            navigationReferrer: 'http://steamrip.com/'
        }),
        /invalid referrer/
    );
});

test('captured JSON responses are read only after DevTools reports the body complete', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'systemBrowserResolver.js'), 'utf8');
    assert.match(source, /pendingResponseBodies\.set\(requestId, response\)/);
    assert.match(source, /responseHeaders\['hx-redirect'\][\s\S]{0,500}capturedResponses\.push/);
    assert.match(source, /Network\.requestWillBeSent[\s\S]{0,700}options\.captureRequestUrl\(url, request\)[\s\S]{0,400}capturedDownloads\.push/);
    assert.match(source, /Network\.loadingFinished[^\n]+captureResponseBody/);
    assert.match(source, /Network\.loadingFailed[^\n]+pendingResponseBodies\.delete/);
    assert.match(source, /handled\.attachBrowserContext === true[\s\S]{0,120}attachBrowserContext\(handled\.value\)/);
    assert.match(source, /const transferUrl = String\(value\.url \|\| ''\);[\s\S]{0,220}Network\.getCookies', \{ urls \}/);
    assert.match(source, /cookieOrigin,/);
    assert.doesNotMatch(source, /new Set\(\[String\(value\.url[\s\S]{0,160}pageUrl/);
    assert.match(source, /__sailHumanVerificationComplete=true/);
    assert.match(source, /Target\.setDiscoverTargets/);
    assert.match(source, /Target\.closeTarget/);
    assert.match(source, /typeof options\.isAllowedUrl === 'function'[\s\S]{0,220}Page\.navigate/);
    assert.match(source, /Fetch\.enable[\s\S]{0,180}resourceType: 'Document'/);
    assert.match(source, /Fetch\.requestPaused[\s\S]{0,1800}Fetch\.failRequest/);
    assert.match(source, /options\.interceptTransferRequests === true[\s\S]{0,900}capturedDownloads\.push[\s\S]{0,500}Fetch\.failRequest/);
    assert.match(source, /String\(params && params\.frameId \|\| ''\) !== mainFrameId/);
});
