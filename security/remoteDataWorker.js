'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const zlib = require('node:zlib');

function workerError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

function checkDeadline() {
    if (!Number.isFinite(workerData.deadline) || Date.now() >= workerData.deadline) throw workerError('TIMEOUT');
}

function stageDelay(stage) {
    const value = Number(workerData.stageDelays && workerData.stageDelays[stage]);
    if (!Number.isFinite(value) || value <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, value);
}

function decode() {
    checkDeadline();
    stageDelay('decode');
    checkDeadline();
    const compressed = Buffer.from(workerData.compressed);
    const maximum = workerData.maxDecodedBytes;
    let decoded;
    try {
        switch (String(workerData.encoding || '').trim().toLowerCase()) {
            case '':
            case 'identity': decoded = compressed; break;
            case 'gzip': decoded = zlib.gunzipSync(compressed, { maxOutputLength: maximum }); break;
            case 'deflate': decoded = zlib.inflateSync(compressed, { maxOutputLength: maximum }); break;
            case 'br': decoded = zlib.brotliDecompressSync(compressed, { maxOutputLength: maximum }); break;
            default: throw workerError('UNSUPPORTED_ENCODING');
        }
    } catch (error) {
        if (error && error.code === 'UNSUPPORTED_ENCODING') throw error;
        if (error && (error.code === 'ERR_BUFFER_TOO_LARGE' || /larger than|output length/i.test(error.message || ''))) {
            throw workerError('RESPONSE_TOO_LARGE');
        }
        throw workerError('INVALID_RESPONSE_ENCODING');
    }
    if (decoded.length > maximum) throw workerError('RESPONSE_TOO_LARGE');
    checkDeadline();
    return decoded.toString('utf8');
}

function run() {
    const body = decode();
    if (workerData.expectedType === 'json') {
        stageDelay('json');
        checkDeadline();
        let data;
        try { data = JSON.parse(body); } catch (_) { throw workerError('INVALID_JSON'); }
        checkDeadline();
        return { data };
    }
    checkDeadline();
    return { html: body };
}

try {
    parentPort.postMessage({ ok: true, result: run() });
} catch (error) {
    parentPort.postMessage({ ok: false, code: error && error.code ? error.code : 'INVALID_RESPONSE_ENCODING' });
}
