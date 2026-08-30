'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const VERIFICATION_BINDING = '__sailVerificationComplete';
const POPUP_BINDING = '__sailPopupRequested';
const DEFAULT_VERIFICATION_RESOURCE_HOSTS = Object.freeze([
    'challenges.cloudflare.com',
    'hcaptcha.com',
    'newassets.hcaptcha.com',
    'imgs.hcaptcha.com',
    'recaptcha.net',
    'www.google.com',
    'www.gstatic.com'
]);

const VERIFICATION_STATE_EXPRESSION = `(function(){
    var token=document.querySelector('input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"],input[name="h-captcha-response"],textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"]');
    var gate=document.querySelector('.cf-turnstile,iframe[src*="challenges.cloudflare.com"],.h-captcha,.g-recaptcha,[data-sitekey]');
    var providerReady=globalThis.dlCleared===true||(typeof globalThis.turnstileToken==='string'&&!!globalThis.turnstileToken.trim());
    var verified=providerReady||!!(token&&String(token.value||token.getAttribute('value')||'').trim());
    var text=String(document.body&&document.body.innerText||'').slice(0,20000);
    var failed=/\\bverification failed\\b|\\bchallenge failed\\b|\\bverification expired\\b/i.test(text);
    if(gate&&!verified&&!window.__sailVerificationCentered){
        window.__sailVerificationCentered=true;
        try{gate.scrollIntoView({block:'center',inline:'center',behavior:'auto'});}catch(e){}
    }
    return {gatePresent:!!gate,verified:verified,failed:failed};
})()`;

const VERIFICATION_OBSERVER_SOURCE = `(function(){
    if(window.__sailVerificationObserverInstalled)return;
    window.__sailVerificationObserverInstalled=true;
    var timer=0;
    function check(){
        var token=document.querySelector('input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"],input[name="h-captcha-response"],textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"]');
        var gate=document.querySelector('.cf-turnstile,iframe[src*="challenges.cloudflare.com"],.h-captcha,.g-recaptcha,[data-sitekey]');
        var providerReady=globalThis.dlCleared===true||(typeof globalThis.turnstileToken==='string'&&!!globalThis.turnstileToken.trim());
        var verified=providerReady||!!(token&&String(token.value||token.getAttribute('value')||'').trim());
        if(gate&&!verified&&!window.__sailVerificationCentered){
            window.__sailVerificationCentered=true;
            try{gate.scrollIntoView({block:'center',inline:'center',behavior:'auto'});}catch(e){}
        }
        if(!verified)return;
        if(timer)clearInterval(timer);
        try{window[${JSON.stringify(VERIFICATION_BINDING)}]('verified');}catch(e){}
    }
    document.addEventListener('DOMContentLoaded',check,{once:true});
    timer=setInterval(check,125);
    check();
})()`;

// Provider pages sometimes attach an unrelated advertising target to their real
// download control. Keep those targets from becoming a second browser page. The
// Node side still decides whether an HTTPS URL belongs to the active provider;
// this script only reports the requested navigation and never clicks anything.
const POPUP_GUARD_SOURCE = `(function(){
    if(window.__sailPopupGuardInstalled)return;
    window.__sailPopupGuardInstalled=true;
    function report(value){
        try{
            var next=new URL(String(value||''),location.href);
            if(next.protocol!=='https:')return;
            window[${JSON.stringify(POPUP_BINDING)}](next.href);
        }catch(e){}
    }
    try{window.open=function(url){report(url);return null;};}catch(e){}
    document.addEventListener('click',function(event){
        var node=event&&event.target;
        var anchor=node&&typeof node.closest==='function'?node.closest('a[target]'):null;
        if(!anchor||String(anchor.target||'').toLowerCase()!=='_blank')return;
        event.preventDefault();
        event.stopImmediatePropagation();
        report(anchor.href||anchor.getAttribute('href'));
    },true);
    document.addEventListener('submit',function(event){
        var form=event&&event.target;
        if(!form||String(form.target||'').toLowerCase()!=='_blank')return;
        event.preventDefault();
        event.stopImmediatePropagation();
        report(form.action||location.href);
    },true);
})()`;

function systemChromiumCandidates(env = process.env) {
    const local = String(env.LOCALAPPDATA || '');
    const programFiles = String(env.ProgramFiles || env.PROGRAMFILES || '');
    const programFilesX86 = String(env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || '');
    return [...new Set([
        local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        programFiles && path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        programFilesX86 && path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        programFilesX86 && path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        programFiles && path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        local && path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        programFiles && path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        local && path.join(local, 'Vivaldi', 'Application', 'vivaldi.exe'),
        programFiles && path.join(programFiles, 'Vivaldi', 'Application', 'vivaldi.exe')
    ].filter(Boolean))];
}

function findSystemChromiumExecutable(options = {}) {
    const existsSync = options.existsSync || fs.existsSync;
    return systemChromiumCandidates(options.env).find(candidate => {
        try { return existsSync(candidate); } catch (_) { return false; }
    }) || '';
}

function isLoopbackDebuggerUrl(value, expectedPort, targetType = '') {
    let parsed;
    try { parsed = new URL(String(value || '')); } catch (_) { return false; }
    const validPath = targetType === 'browser'
        ? /^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(parsed.pathname)
        : /^\/devtools\/(?:page|worker)\/[A-Za-z0-9._-]+$/.test(parsed.pathname);
    return parsed.protocol === 'ws:' && LOOPBACK_HOSTS.has(parsed.hostname)
        && Number(parsed.port) === Number(expectedPort) && validPath;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function abortError() {
    return Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
}

function delayWithSignal(ms, signal) {
    if (!signal) return delay(ms);
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function requestJson(port, requestPath, timeoutMs = 1200) {
    return new Promise((resolve, reject) => {
        const req = http.get({
            hostname: '127.0.0.1',
            port,
            path: requestPath,
            headers: { Host: `127.0.0.1:${port}` }
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
                if (body.length > 1024 * 1024) req.destroy(new Error('Debugger response was too large.'));
            });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`Debugger returned HTTP ${response.statusCode}.`));
                    return;
                }
                try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('Debugger returned invalid JSON.')); }
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('Debugger request timed out.')));
        req.on('error', reject);
    });
}

function connectCdp(webSocketUrl, options = {}) {
    const WebSocketImpl = options.WebSocketImpl || WebSocket;
    return new Promise((resolve, reject) => {
        const socket = new WebSocketImpl(webSocketUrl, { perMessageDeflate: false });
        let settled = false;
        const fail = error => {
            if (settled) return;
            settled = true;
            try { socket.close(); } catch (_) {}
            reject(error instanceof Error ? error : new Error(String(error || 'Debugger connection failed.')));
        };
        const timer = setTimeout(() => fail(new Error('Debugger connection timed out.')), options.timeoutMs || 3000);
        socket.once('error', fail);
        socket.once('open', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            let nextId = 1;
            const pending = new Map();
            const eventListeners = new Map();
            const rejectPending = error => {
                for (const item of pending.values()) {
                    clearTimeout(item.timer);
                    item.reject(error);
                }
                pending.clear();
            };
            socket.on('message', raw => {
                let message;
                try { message = JSON.parse(raw.toString()); } catch (_) { return; }
                if (!message.id) {
                    const listeners = eventListeners.get(message.method);
                    if (listeners) for (const listener of listeners) {
                        try { listener(message.params || {}); } catch (_) {}
                    }
                    return;
                }
                if (!pending.has(message.id)) return;
                const item = pending.get(message.id);
                pending.delete(message.id);
                clearTimeout(item.timer);
                if (message.error) item.reject(new Error(message.error.message || 'Debugger command failed.'));
                else item.resolve(message.result || {});
            });
            socket.on('close', () => rejectPending(new Error('Debugger connection closed.')));
            socket.on('error', error => rejectPending(error));
            resolve({
                send(method, params = {}, timeoutMs = 5000) {
                    return new Promise((commandResolve, commandReject) => {
                        if (socket.readyState !== WebSocketImpl.OPEN) {
                            commandReject(new Error('Debugger connection is not open.'));
                            return;
                        }
                        const id = nextId++;
                        const commandTimer = setTimeout(() => {
                            pending.delete(id);
                            commandReject(new Error(`Debugger command ${method} timed out.`));
                        }, timeoutMs);
                        pending.set(id, { resolve: commandResolve, reject: commandReject, timer: commandTimer });
                        socket.send(JSON.stringify({ id, method, params }), error => {
                            if (!error) return;
                            const item = pending.get(id);
                            if (!item) return;
                            pending.delete(id);
                            clearTimeout(item.timer);
                            item.reject(error);
                        });
                    });
                },
                close() {
                    try { socket.close(); } catch (_) {}
                },
                on(method, listener) {
                    if (typeof listener !== 'function') return;
                    if (!eventListeners.has(method)) eventListeners.set(method, new Set());
                    eventListeners.get(method).add(listener);
                },
                off(method, listener) {
                    const listeners = eventListeners.get(method);
                    if (listeners) listeners.delete(listener);
                }
            });
        });
    });
}

function reserveLoopbackPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            server.close(error => {
                if (error) reject(error);
                else if (!port) reject(new Error('Could not reserve a browser debugger port.'));
                else resolve(port);
            });
        });
    });
}

async function waitForPageTarget(port, deadline, signal = null) {
    while (Date.now() < deadline) {
        throwIfAborted(signal);
        try {
            const targets = await requestJson(port, '/json/list');
            const page = Array.isArray(targets) && targets.find(target => target && target.type === 'page');
            if (page && isLoopbackDebuggerUrl(page.webSocketDebuggerUrl, port, 'page')) return page.webSocketDebuggerUrl;
        } catch (_) {}
        await delayWithSignal(100, signal);
    }
    throw new Error('System browser page target did not start in time.');
}

function safeRemoveProfile(root, profileDirectory) {
    try {
        const relative = path.relative(path.resolve(root), path.resolve(profileDirectory));
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
        fs.rmSync(profileDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (_) {}
}

function normalizeHost(value) {
    const host = String(value || '').trim().toLowerCase().replace(/^\*\./, '');
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : '';
}

function verificationWindowBounds(parentBounds = {}) {
    const parentWidth = Number(parentBounds.width);
    const parentHeight = Number(parentBounds.height);
    const parentLeft = Number(parentBounds.x ?? parentBounds.left);
    const parentTop = Number(parentBounds.y ?? parentBounds.top);
    if (![parentWidth, parentHeight, parentLeft, parentTop].every(Number.isFinite)
        || parentWidth < 420 || parentHeight < 420) {
        return { left: 80, top: 80, width: 680, height: 560 };
    }
    const width = Math.max(420, Math.min(680, Math.round(parentWidth - 64)));
    const height = Math.max(420, Math.min(560, Math.round(parentHeight - 80)));
    return {
        left: Math.round(parentLeft + (parentWidth - width) / 2),
        top: Math.round(parentTop + (parentHeight - height) / 2),
        width,
        height
    };
}

function verificationNeedsAttention(state, verificationReported) {
    return verificationReported === true && !!state && state.verified !== true && state.failed === true;
}

function systemChromiumBlockPatterns(blockedHosts = [], allowedHosts = DEFAULT_VERIFICATION_RESOURCE_HOSTS) {
    const allowed = new Set((Array.isArray(allowedHosts) ? allowedHosts : []).map(normalizeHost).filter(Boolean));
    const blocked = new Set((Array.isArray(blockedHosts) ? blockedHosts : []).map(normalizeHost).filter(Boolean));
    for (const host of allowed) blocked.delete(host);
    const patterns = [];
    for (const host of allowed) {
        patterns.push({ urlPattern: `*://${host}:*/*`, block: false });
        patterns.push({ urlPattern: `*://*.${host}:*/*`, block: false });
    }
    for (const host of blocked) {
        patterns.push({ urlPattern: `*://${host}:*/*`, block: true });
        patterns.push({ urlPattern: `*://*.${host}:*/*`, block: true });
    }
    return patterns;
}

function systemChromiumLaunchArgs(debugPort, profileDirectory, options = {}) {
    const visible = options.visible === true;
    const bounds = visible ? verificationWindowBounds(options.parentBounds) : {
        left: -2400,
        top: 0,
        width: 1200,
        height: 850
    };
    return [
        '--remote-debugging-port=' + debugPort,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profileDirectory}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        `--window-position=${bounds.left},${bounds.top}`,
        `--window-size=${bounds.width},${bounds.height}`,
        options.appMode === true ? '--app=about:blank' : 'about:blank'
    ];
}

async function minimizeBrowserWindow(client) {
    if (!client || typeof client.send !== 'function') return false;
    const result = await client.send('Browser.getWindowForTarget', {}, 3000);
    const windowId = Number(result && result.windowId);
    if (!Number.isInteger(windowId) || windowId < 0) return false;
    await client.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' }
    }, 3000);
    return true;
}

async function restoreBrowserWindow(client, parentBounds = {}) {
    if (!client || typeof client.send !== 'function') return false;
    const result = await client.send('Browser.getWindowForTarget', {}, 3000);
    const windowId = Number(result && result.windowId);
    if (!Number.isInteger(windowId) || windowId < 0) return false;
    const bounds = verificationWindowBounds(parentBounds);
    await client.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' }
    }, 3000);
    await client.send('Browser.setWindowBounds', { windowId, bounds }, 3000);
    await client.send('Page.bringToFront', {}, 3000).catch(() => {});
    return true;
}

async function closeBrowser(client, child, secondaryClient = null) {
    if (secondaryClient) {
        try { await secondaryClient.send('Browser.close', {}, 1500); } catch (_) {}
        try { secondaryClient.close(); } catch (_) {}
    } else if (client) {
        try { await client.send('Browser.close', {}, 1500); } catch (_) {}
    }
    if (client) {
        try { client.close(); } catch (_) {}
    }
    const stopAt = Date.now() + 1800;
    while (child && child.exitCode === null && Date.now() < stopAt) await delay(60);
    try { if (child && child.exitCode === null) child.kill(); } catch (_) {}
}

async function clickPageSelector(client, selector, deadline, signal = null) {
    const source = String(selector || '');
    if (!source || source.length > 512 || /[\u0000-\u001f\u007f]/.test(source)) {
        throw new Error('System browser click selector is invalid.');
    }
    const expression = `(function(){
        if(document.readyState!=='complete')return null;
        var element=document.querySelector(${JSON.stringify(source)});
        if(!element)return null;
        var rect=element.getBoundingClientRect();
        if(!rect||rect.width<1||rect.height<1)return null;
        return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
    })()`;
    while (Date.now() < deadline) {
        throwIfAborted(signal);
        try {
            const evaluated = await client.send('Runtime.evaluate', {
                expression,
                returnByValue: true
            }, Math.min(3000, Math.max(1000, deadline - Date.now())));
            const point = evaluated && evaluated.result && evaluated.result.value;
            if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved', x: point.x, y: point.y
                }, 3000);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
                }, 3000);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
                }, 3000);
                return true;
            }
        } catch (_) {}
        await delayWithSignal(100, signal);
    }
    return false;
}

async function resolveWithSystemChromium(rawUrl, expression, options = {}) {
    const signal = options.signal || null;
    throwIfAborted(signal);
    const parsed = new URL(String(rawUrl || ''));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port && parsed.port !== '443') {
        throw new Error('System browser resolution requires a credential-free HTTPS URL.');
    }
    if (typeof options.isAllowedUrl === 'function' && !options.isAllowedUrl(parsed)) {
        throw new Error('System browser resolution refused this host.');
    }
    let navigationReferrer = '';
    if (options.navigationReferrer) {
        const candidate = new URL(String(options.navigationReferrer));
        if (candidate.protocol !== 'https:' || candidate.username || candidate.password
            || candidate.port && candidate.port !== '443') {
            throw new Error('System browser resolution received an invalid referrer.');
        }
        candidate.hash = '';
        navigationReferrer = candidate.href;
    }
    let script = String(expression || '');
    if (!script || script.length > 100000) throw new Error('System browser resolution script is invalid.');
    const executablePath = options.executablePath || findSystemChromiumExecutable(options);
    if (!executablePath) return null;

    const timeoutMs = Math.max(5000, Math.min(Number(options.timeoutMs) || 20000, 6 * 60 * 1000));
    const tempRoot = path.resolve(options.tempRoot || path.join(process.cwd(), '.sail-host-browser'));
    fs.mkdirSync(tempRoot, { recursive: true });
    const profileDirectory = fs.mkdtempSync(path.join(tempRoot, 'profile-'));
    const spawnImpl = options.spawn || spawn;
    let child = null, client = null, browserClient = null;
    let verificationMinimized = false;
    let verificationMinimizedAt = 0;
    let verificationMinimizePromise = null;
    let verificationReported = false;
    let abortCloseRequested = false;
    const capturedResponses = [];
    const capturedDownloads = [];
    const pendingResponseBodies = new Map();
    let initialPageTargetId = '';
    const requestAbortClose = () => {
        if (abortCloseRequested) return;
        abortCloseRequested = true;
        try {
            const closer = browserClient || client;
            if (closer) closer.send('Browser.close', {}, 1000).catch(() => {});
        } catch (_) {}
        try { if (child && child.exitCode === null) child.kill(); } catch (_) {}
    };
    if (signal) signal.addEventListener('abort', requestAbortClose, { once: true });
    try {
        throwIfAborted(signal);
        // Chromium reports navigator.webdriver=true when the debugger port is zero.
        // Reserve a random fixed loopback port so the host sees an ordinary browser.
        const debugPort = await reserveLoopbackPort();
        throwIfAborted(signal);
        child = spawnImpl(executablePath, systemChromiumLaunchArgs(debugPort, profileDirectory, options), {
            stdio: 'ignore',
            windowsHide: options.visible !== true
        });
        const deadline = Date.now() + timeoutMs;
        const pageDebuggerUrl = await waitForPageTarget(debugPort, deadline, signal);
        try { initialPageTargetId = decodeURIComponent(new URL(pageDebuggerUrl).pathname.split('/').pop() || ''); } catch (_) {}
        throwIfAborted(signal);
        client = await connectCdp(pageDebuggerUrl, { timeoutMs: Math.min(3000, timeoutMs) });
        await Promise.all([
            client.send('Page.enable'),
            client.send('Runtime.enable')
        ]);
        const frameTree = await client.send('Page.getFrameTree', {}, 3000).catch(() => ({}));
        const mainFrameId = String(frameTree && frameTree.frameTree && frameTree.frameTree.frame
            && frameTree.frameTree.frame.id || '');
        const reportBlockedPopup = value => {
            if (typeof options.onBlockedPopup !== 'function') return;
            try { options.onBlockedPopup(new URL(String(value || '')).hostname.toLowerCase()); } catch (_) {}
        };
        const routePopupUrl = async value => {
            let candidate;
            try { candidate = new URL(String(value || ''), parsed.href); } catch (_) { return false; }
            if (candidate.protocol !== 'https:' || candidate.username || candidate.password
                || candidate.port && candidate.port !== '443') {
                reportBlockedPopup(candidate.href);
                return false;
            }
            let allowed = false;
            try { allowed = typeof options.isAllowedUrl === 'function' && !!options.isAllowedUrl(candidate); } catch (_) {}
            if (!allowed) {
                reportBlockedPopup(candidate.href);
                return false;
            }
            await client.send('Page.navigate', { url: candidate.href }, 10000).catch(() => {});
            return true;
        };
        const guardPopups = options.captureDownloads === true && options.guardPopups !== false;
        if (guardPopups) {
            await client.send('Runtime.addBinding', { name: POPUP_BINDING }, 3000);
            await client.send('Page.addScriptToEvaluateOnNewDocument', {
                source: POPUP_GUARD_SOURCE
            }, 3000);
            await client.send('Runtime.evaluate', {
                expression: POPUP_GUARD_SOURCE,
                returnByValue: true
            }, 3000).catch(() => {});
            client.on('Runtime.bindingCalled', params => {
                if (!params || params.name !== POPUP_BINDING) return;
                routePopupUrl(params.payload).catch(() => {});
            });
            const allowedSubframeHosts = new Set((Array.isArray(options.allowedResourceHosts)
                ? options.allowedResourceHosts : DEFAULT_VERIFICATION_RESOURCE_HOSTS)
                .map(normalizeHost).filter(Boolean));
            const allowedSubframeUrl = candidate => {
                const host = candidate.hostname.toLowerCase();
                for (const allowedHost of allowedSubframeHosts) {
                    if (host === allowedHost || host.endsWith(`.${allowedHost}`)) return true;
                }
                return false;
            };
            client.on('Fetch.requestPaused', params => {
                const requestId = String(params && params.requestId || '');
                const requestUrl = String(params && params.request && params.request.url || '');
                if (!requestId) return;
                let candidate = null;
                try { candidate = new URL(requestUrl); } catch (_) {}
                // Some providers issue a one-use transfer URL. When explicitly
                // enabled, capture that approved request before Chromium sends it;
                // otherwise cancelling the browser download can consume the token
                // before the caller gets a chance to use it.
                let interceptedTransfer = false;
                if (options.interceptTransferRequests === true && candidate
                    && candidate.protocol === 'https:' && !candidate.username && !candidate.password
                    && (!candidate.port || candidate.port === '443')
                    && typeof options.captureRequestUrl === 'function') {
                    try { interceptedTransfer = !!options.captureRequestUrl(requestUrl, params.request); } catch (_) {}
                }
                if (interceptedTransfer) {
                    if (!capturedDownloads.some(item => item.url === requestUrl)) {
                        capturedDownloads.push({ guid: '', url: requestUrl, name: '' });
                    }
                    client.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, 3000).catch(() => {});
                    return;
                }
                let allowed = false;
                if (candidate && candidate.protocol === 'https:' && !candidate.username && !candidate.password
                    && (!candidate.port || candidate.port === '443')) {
                    try { allowed = typeof options.isAllowedUrl === 'function' && !!options.isAllowedUrl(candidate); } catch (_) {}
                    if (!allowed && String(params && params.frameId || '') !== mainFrameId) {
                        allowed = allowedSubframeUrl(candidate);
                    }
                }
                if (allowed) {
                    client.send('Fetch.continueRequest', { requestId }, 3000).catch(() => {});
                    return;
                }
                reportBlockedPopup(requestUrl);
                client.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, 3000).catch(() => {});
            });
            await client.send('Fetch.enable', {
                patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }]
            }, 3000);
        }
        const blockedPatterns = Array.isArray(options.blockedHosts) && options.blockedHosts.length
            ? systemChromiumBlockPatterns(options.blockedHosts, options.allowedResourceHosts)
            : [];
        if (blockedPatterns.length) {
            await client.send('Network.enable', {}, 3000);
            try {
                await client.send('Network.setBlockedURLs', { urlPatterns: blockedPatterns }, 3000);
            } catch (_) {
                await client.send('Network.setBlockedURLs', {
                    urls: blockedPatterns.filter(pattern => pattern.block).map(pattern => pattern.urlPattern)
                }, 3000);
            }
        }
        const reportVerification = () => {
            if (verificationReported) return;
            verificationReported = true;
            if (typeof options.onVerificationComplete === 'function') {
                try { options.onVerificationComplete(); } catch (_) {}
            }
        };
        const minimizeVerification = () => {
            if (verificationMinimized) return Promise.resolve(true);
            if (verificationMinimizePromise) return verificationMinimizePromise;
            verificationMinimizePromise = minimizeBrowserWindow(client).then(minimized => {
                if (minimized) {
                    verificationMinimized = true;
                    verificationMinimizedAt = Date.now();
                }
                return minimized;
            }).catch(() => false).finally(() => {
                if (!verificationMinimized) verificationMinimizePromise = null;
            });
            return verificationMinimizePromise;
        };
        const observeVerification = options.observeVerification === true || options.minimizeOnVerification === true;
        const verificationStateExpression = String(options.verificationStateExpression || VERIFICATION_STATE_EXPRESSION);
        const installVerificationObserver = observeVerification && options.installVerificationObserver !== false;
        if (installVerificationObserver) {
            await client.send('Runtime.addBinding', { name: VERIFICATION_BINDING }, 3000);
            await client.send('Page.addScriptToEvaluateOnNewDocument', {
                source: VERIFICATION_OBSERVER_SOURCE
            }, 3000);
            client.on('Runtime.bindingCalled', params => {
                if (!params || params.name !== VERIFICATION_BINDING || params.payload !== 'verified') return;
                reportVerification();
            });
        }
        if (options.captureDownloads === true) {
            const version = await requestJson(debugPort, '/json/version');
            if (!version || !isLoopbackDebuggerUrl(version.webSocketDebuggerUrl, debugPort, 'browser')) {
                throw new Error('System browser returned an invalid browser debugger target.');
            }
            browserClient = await connectCdp(version.webSocketDebuggerUrl, {
                timeoutMs: Math.min(3000, timeoutMs)
            });
            if (guardPopups) {
                const closeExtraPage = params => {
                    const info = params && params.targetInfo || params;
                    const targetId = String(info && info.targetId || '');
                    if (!targetId || targetId === initialPageTargetId || String(info && info.type || '') !== 'page') return;
                    const targetUrl = String(info && info.url || '');
                    if (targetUrl && targetUrl !== 'about:blank') routePopupUrl(targetUrl).catch(() => {});
                    else reportBlockedPopup(targetUrl);
                    browserClient.send('Target.closeTarget', { targetId }, 3000).catch(() => {});
                };
                browserClient.on('Target.targetCreated', closeExtraPage);
                browserClient.on('Target.targetInfoChanged', closeExtraPage);
                await browserClient.send('Target.setDiscoverTargets', { discover: true }, 3000);
            }
            const rememberDownload = params => {
                const url = String(params && params.url || '');
                if (!url || capturedDownloads.some(item => item.url === url && item.guid === params.guid)) return;
                capturedDownloads.push({
                    guid: String(params && params.guid || ''),
                    url,
                    name: String(params && params.suggestedFilename || '').slice(0, 512)
                });
                if (params && params.guid) {
                    browserClient.send('Browser.cancelDownload', { guid: params.guid }, 3000).catch(() => {});
                }
            };
            browserClient.on('Browser.downloadWillBegin', rememberDownload);
            client.on('Page.downloadWillBegin', rememberDownload);
            const capturedDownloadDirectory = path.join(profileDirectory, 'captured-downloads');
            fs.mkdirSync(capturedDownloadDirectory, { recursive: true });
            try {
                await browserClient.send('Browser.setDownloadBehavior', {
                    // Allow only long enough for downloadWillBegin to expose the
                    // signed URL, then cancel by guid before the large payload is
                    // written. The isolated profile is deleted in finally.
                    behavior: 'allow',
                    downloadPath: capturedDownloadDirectory,
                    eventsEnabled: true
                }, 3000);
            } catch (_) {
                await client.send('Page.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: capturedDownloadDirectory
                }, 3000);
            }
        }
        if (typeof options.captureResponseUrl === 'function'
            || typeof options.captureRequestUrl === 'function'
            || options.captureDownloads === true) {
            await client.send('Network.enable', {}, 3000);
            if (typeof options.captureRequestUrl === 'function') {
                client.on('Network.requestWillBeSent', params => {
                    const request = params && params.request;
                    const url = String(request && request.url || '');
                    if (!url) return;
                    let accepted = false;
                    try { accepted = !!options.captureRequestUrl(url, request); } catch (_) {}
                    if (!accepted || capturedDownloads.some(item => item.url === url)) return;
                    capturedDownloads.push({ guid: '', url, name: '' });
                });
            }
            const captureResponseBody = requestId => {
                const response = pendingResponseBodies.get(requestId);
                if (!response) return;
                pendingResponseBodies.delete(requestId);
                client.send('Network.getResponseBody', { requestId }, 5000).then(result => {
                    const rawBody = result && result.body || '';
                    const encoded = !!(result && result.base64Encoded);
                    if (Buffer.byteLength(rawBody, encoded ? 'base64' : 'utf8') > 1024 * 1024) return;
                    const body = encoded ? Buffer.from(rawBody, 'base64').toString('utf8') : rawBody;
                    capturedResponses.push({
                        url: response.url,
                        status: response.status,
                        headers: response.headers || {},
                        body,
                        base64Encoded: false
                    });
                }).catch(() => {});
            };
            client.on('Network.responseReceived', params => {
                const response = params && params.response;
                const requestId = params && params.requestId;
                if (!response || !requestId) return;
                if (options.captureDownloads === true) {
                    const headers = response.headers || {};
                    const contentDisposition = String(headers['content-disposition'] || headers['Content-Disposition'] || '');
                    const mimeType = String(response.mimeType || headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
                    const looksLikeTransfer = /\battachment\b/i.test(contentDisposition)
                        || /^(?:application\/(?:octet-stream|zip|x-7z-compressed|x-rar-compressed|vnd\.rar|x-bittorrent)|binary\/octet-stream)\b/i.test(mimeType);
                    if (looksLikeTransfer) capturedDownloads.push({
                        guid: '',
                        url: String(response.url || ''),
                        name: String((contentDisposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i) || [])[1] || '').trim().slice(0, 512)
                    });
                }
                if (typeof options.captureResponseUrl !== 'function' || !options.captureResponseUrl(response.url)) return;
                const responseHeaders = response.headers || {};
                const redirectHeader = responseHeaders['hx-redirect'] || responseHeaders['HX-Redirect']
                    || responseHeaders.location || responseHeaders.Location;
                if (redirectHeader) {
                    // Htmx download endpoints can finish with an empty/204 response,
                    // for which Chromium refuses getResponseBody. Preserve the signed
                    // redirect immediately instead of waiting for a body that may not exist.
                    capturedResponses.push({
                        url: response.url,
                        status: response.status,
                        headers: responseHeaders,
                        body: '',
                        base64Encoded: false
                    });
                    return;
                }
                pendingResponseBodies.set(requestId, response);
            });
            client.on('Network.loadingFinished', params => captureResponseBody(params && params.requestId));
            client.on('Network.loadingFailed', params => pendingResponseBodies.delete(params && params.requestId));
        }
        await client.send('Page.bringToFront', {}, 3000);
        const navigation = { url: parsed.href };
        if (navigationReferrer) {
            navigation.referrer = navigationReferrer;
            navigation.referrerPolicy = 'strictOriginWhenCrossOrigin';
        }
        await client.send('Page.navigate', navigation, 10000);
        throwIfAborted(signal);

        if (options.clickSelector) {
            const clickDeadline = Math.min(deadline, Date.now() + Math.max(
                1000,
                Math.min(Number(options.clickTimeoutMs) || 15000, 30000)
            ));
            const clicked = await clickPageSelector(client, options.clickSelector, clickDeadline, signal);
            if (!clicked) throw new Error('System browser could not find the requested control.');
        }

        const attachBrowserContext = async value => {
            if (!value || typeof value !== 'object' || !value.url) return value;
            const evaluated = await client.send('Runtime.evaluate', {
                expression: '({pageUrl:location.href,userAgent:navigator.userAgent})',
                returnByValue: true
            }, 3000).catch(() => ({}));
            const page = evaluated && evaluated.result && evaluated.result.value || {};
            const transferUrl = String(value.url || '');
            const urls = /^https:\/\//i.test(transferUrl) ? [transferUrl] : [];
            const cookieResult = urls.length
                ? await client.send('Network.getCookies', { urls }, 3000).catch(() => ({ cookies: [] }))
                : { cookies: [] };
            let cookieOrigin = '';
            try { cookieOrigin = new URL(transferUrl).origin; } catch (_) {}
            return Object.assign({}, value, {
                pageUrl: String(value.pageUrl || page.pageUrl || parsed.href),
                userAgent: String(value.userAgent || page.userAgent || ''),
                cookieOrigin,
                cookies: Array.isArray(cookieResult.cookies) ? cookieResult.cookies.map(cookie => ({
                    name: String(cookie.name || ''),
                    value: String(cookie.value || '')
                })).filter(cookie => cookie.name) : []
            });
        };

        while (Date.now() < deadline) {
            throwIfAborted(signal);
            if (child.exitCode !== null) throw new Error('System browser exited during resolution.');
            try {
                if (observeVerification) {
                    const stateResult = await client.send('Runtime.evaluate', {
                        expression: verificationStateExpression,
                        returnByValue: true
                    }, 3000);
                    const state = stateResult && stateResult.result && stateResult.result.value;
                    if (state && state.verified && !verificationReported) {
                        // Challenge components commonly disappear before their newly
                        // enabled download control is rendered. Keep that accepted
                        // state in the page so the generic clicker can advance it.
                        await client.send('Runtime.evaluate', {
                            expression: 'globalThis.__sailHumanVerificationComplete=true;true',
                            returnByValue: true
                        }, 3000).catch(() => {});
                        reportVerification();
                    }
                    // Providers commonly leave the completed challenge frame mounted
                    // while preparing the signed URL. Its mere presence is not a new
                    // failure and must not reopen the handoff in a verification loop.
                    if (verificationMinimized && Date.now() - verificationMinimizedAt >= 600
                        && verificationNeedsAttention(state, verificationReported)) {
                        const restored = await restoreBrowserWindow(client, options.parentBounds).catch(() => false);
                        if (restored) {
                            verificationMinimized = false;
                            verificationMinimizedAt = 0;
                            verificationMinimizePromise = null;
                            verificationReported = false;
                            await client.send('Runtime.evaluate', {
                                expression: 'globalThis.__sailHumanVerificationComplete=false;true',
                                returnByValue: true
                            }, 3000).catch(() => {});
                            if (typeof options.onVerificationNeedsAttention === 'function') {
                                try { options.onVerificationNeedsAttention(); } catch (_) {}
                            }
                        }
                    }
                }
                while (capturedDownloads.length) {
                    const download = capturedDownloads.shift();
                    let accepted = false;
                    try {
                        accepted = typeof options.acceptDownloadUrl !== 'function'
                            || !!options.acceptDownloadUrl(download.url);
                    } catch (_) {}
                    if (!accepted) continue;
                    const evaluated = await client.send('Runtime.evaluate', {
                        expression: '({pageUrl:location.href,userAgent:navigator.userAgent})',
                        returnByValue: true
                    }, 3000);
                    const page = evaluated && evaluated.result && evaluated.result.value || {};
                    const cookieResult = await client.send('Network.getCookies', {
                        urls: [download.url]
                    }, 3000).catch(() => ({ cookies: [] }));
                    const value = {
                        url: download.url,
                        name: download.name,
                        pageUrl: String(page.pageUrl || parsed.href),
                        userAgent: String(page.userAgent || ''),
                        cookies: Array.isArray(cookieResult.cookies) ? cookieResult.cookies.map(cookie => ({
                            name: String(cookie.name || ''),
                            value: String(cookie.value || '')
                        })).filter(cookie => cookie.name) : []
                    };
                    if (typeof options.handleDownload === 'function') {
                        const handled = await options.handleDownload(value);
                        if (handled && Object.prototype.hasOwnProperty.call(handled, 'value')) return handled.value;
                    }
                    return value;
                }
                if (capturedResponses.length && typeof options.handleResponse === 'function') {
                    const handled = await options.handleResponse(capturedResponses.shift());
                    if (handled && typeof handled.expression === 'string') {
                        if (!handled.expression || handled.expression.length > 100000) {
                            throw new Error('System browser response script is invalid.');
                        }
                        script = handled.expression;
                    } else if (handled && Object.prototype.hasOwnProperty.call(handled, 'value')) {
                        return handled.attachBrowserContext === true
                            ? await attachBrowserContext(handled.value)
                            : handled.value;
                    }
                }
                const evaluationTimeoutMs = Math.max(1000, Math.min(
                    Number(options.evaluationTimeoutMs) || 6000,
                    timeoutMs
                ));
                const evaluated = await client.send('Runtime.evaluate', {
                    expression: script,
                    awaitPromise: true,
                    returnByValue: true
                }, Math.min(evaluationTimeoutMs, Math.max(1000, deadline - Date.now())));
                const value = evaluated && evaluated.result && evaluated.result.value;
                if (value && value.postVerificationControlActivated === true
                    && verificationReported && options.minimizeOnVerification === true
                    && !verificationMinimized) {
                    await minimizeVerification();
                }
                if (value && typeof options.handleValue === 'function') {
                    const handled = await options.handleValue(value);
                    if (handled && typeof handled.expression === 'string') {
                        if (!handled.expression || handled.expression.length > 100000) {
                            throw new Error('System browser follow-up script is invalid.');
                        }
                        script = handled.expression;
                        continue;
                    }
                    if (handled && Object.prototype.hasOwnProperty.call(handled, 'value')) return handled.value;
                }
                if (value && (typeof options.acceptResult !== 'function' || options.acceptResult(value))) return value;
            } catch (error) {
                if (error && error.name === 'AbortError') throw error;
            }
            await delayWithSignal(observeVerification ? 250 : 500, signal);
        }
        return null;
    } finally {
        if (signal) signal.removeEventListener('abort', requestAbortClose);
        await closeBrowser(client, child, browserClient);
        safeRemoveProfile(tempRoot, profileDirectory);
    }
}

module.exports = {
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
};
