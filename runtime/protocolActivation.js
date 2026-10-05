'use strict';

const crypto = require('node:crypto');

function parseProtocolUrl(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8192 || /[\u0000-\u0020\u007f\\]/.test(raw)
        || !/^sail-launcher:\/\//i.test(raw) || /%(?![a-f0-9]{2})/i.test(raw)) return null;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'sail-launcher:' || parsed.username || parsed.password || parsed.port || parsed.hash
            || (parsed.pathname !== '' && parsed.pathname !== '/')) return null;
        const action = parsed.hostname;
        const allowed = action === 'open' ? [] : ['install-theme', 'install-plugin'].includes(action) ? ['url']
            : action === 'cloud-callback' ? ['success', 'provider', 'error'] : null;
        if (!allowed) return null;
        const values = Object.create(null);
        for (const [key, value] of parsed.searchParams) {
            if (!allowed.includes(key) || Object.hasOwn(values, key) || /[\u0000-\u001f\u007f\ufffd]/.test(value)) return null;
            values[key] = value;
        }
        if (action === 'open') return { action };
        if (action === 'cloud-callback') {
            if (!['0', '1'].includes(values.success) || (values.provider || '').length > 64 || (values.error || '').length > 512) return null;
            return { action, success: values.success === '1', provider: values.provider || '', error: values.error || '' };
        }
        if (!values.url || /[\s\\]/.test(values.url)) return null;
        if (/[\u0000-\u001f\u007f]/.test(decodeURIComponent(values.url))) return null;
        const file = new URL(values.url);
        if (file.protocol !== 'https:' || file.username || file.password || file.hash || (file.port && file.port !== '443')) return null;
        return { action, fileUrl: file.href };
    } catch (_) { return null; }
}

function createProtocolActivation({ getWindow, focus, getSupport }) {
    let ready = false;
    let pending = null;
    const seen = new Map();
    const awaitingAcknowledgment = new Set();

    function dispatch() {
        const window = getWindow();
        if (!ready || !pending || !window || window.isDestroyed() || window.webContents.isDestroyed()) return;
        focus();
        const request = pending;
        const feature = request.action === 'cloud-callback' ? 'accounts'
            : request.action === 'install-plugin' ? 'plugins' : request.action === 'install-theme' ? 'remoteContent' : null;
        const support = getSupport();
        const message = feature && !support.features[feature].available ? {
            requestId: request.requestId, action: 'unavailable', message: support.features[feature].reason
        } : request;
        // Remove only after send succeeds. Consumed actions are never replayed
        // on a renderer reload, including actions whose outcome is unknown.
        try { window.webContents.send('desktop-protocol-activation', message); }
        catch (_) { ready = false; return; }
        pending = null;
        awaitingAcknowledgment.add(request.requestId);
        if (awaitingAcknowledgment.size > 32) awaitingAcknowledgment.delete(awaitingAcknowledgment.values().next().value);
    }

    return {
        receive(raw) {
            if (getSupport().isolated) return false;
            const parsed = parseProtocolUrl(raw);
            if (!parsed) return false;
            const now = Date.now();
            for (const [key, at] of seen) if (now - at > 5000) seen.delete(key);
            const fingerprint = crypto.createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
            if (seen.has(fingerprint)) { focus(); return true; }
            seen.set(fingerprint, now);
            if (seen.size > 32) seen.delete(seen.keys().next().value);
            pending = { ...parsed, requestId: crypto.randomUUID() };
            dispatch();
            return true;
        },
        receiveArguments(args) {
            for (const value of args) {
                if (typeof value === 'string' && /^sail-launcher:/i.test(value)) {
                    this.receive(value);
                    return true;
                }
            }
            return false;
        },
        rendererReady() { ready = true; dispatch(); return true; },
        resetRenderer() { ready = false; awaitingAcknowledgment.clear(); },
        acknowledge(id) { return typeof id === 'string' && awaitingAcknowledgment.delete(id); }
    };
}

module.exports = { parseProtocolUrl, createProtocolActivation };
