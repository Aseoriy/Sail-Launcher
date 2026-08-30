'use strict';

const os = require('node:os');
const { Worker } = require('node:worker_threads');

const FILECRYPT_CONTAINER_RE = /^\/Container\/([A-Fa-f0-9]{10,64})\.html$/;
const FILECRYPT_LINK_RE = /^\/Link\/([A-Fa-f0-9]{10,64})\.html$/;

function normalizeFileCryptContainerUrl(value) {
    let parsed;
    try { parsed = new URL(String(value || '').trim()); } catch (_) { return ''; }
    if (parsed.protocol !== 'https:' || !/^(?:www\.)?filecrypt\.cc$/i.test(parsed.hostname)
        || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
        || !FILECRYPT_CONTAINER_RE.test(parsed.pathname)) return '';
    return parsed.href;
}

function fileCryptLinkCandidates(links, containerUrl) {
    const container = normalizeFileCryptContainerUrl(containerUrl);
    if (!container || !Array.isArray(links)) return [];
    const origin = new URL(container).origin;
    const output = [];
    const seen = new Set();
    const add = value => {
        let parsed;
        try { parsed = new URL(String(value || ''), origin); } catch (_) { return; }
        if (parsed.origin !== origin || parsed.username || parsed.password || parsed.port
            || parsed.search || parsed.hash || !FILECRYPT_LINK_RE.test(parsed.pathname)) return;
        if (!seen.has(parsed.href)) {
            seen.add(parsed.href);
            output.push(parsed.href);
        }
    };
    for (const item of links.slice(0, 256)) {
        if (!item || typeof item !== 'object') continue;
        add(item.href);
        const onclick = String(item.onclick || '');
        for (const match of onclick.matchAll(/\bopenLink\s*\(\s*(["'])([A-Fa-f0-9]{10,64})\1/gi)) {
            add(`/Link/${match[2]}.html`);
        }
    }
    return output.slice(0, 16);
}

const POW_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const buf = new Uint8Array(256);
const w = new Int32Array(80);
function sha1lz(str) {
    const len = str.length;
    const total = (len + 72) & ~63;
    buf.fill(0, 0, total);
    for (let i = 0; i < len; i++) buf[i] = str.charCodeAt(i) & 255;
    buf[len] = 128;
    const bitLen = len * 8;
    buf[total - 4] = (bitLen >>> 24) & 255;
    buf[total - 3] = (bitLen >>> 16) & 255;
    buf[total - 2] = (bitLen >>> 8) & 255;
    buf[total - 1] = bitLen & 255;
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    for (let offset = 0; offset < total; offset += 64) {
        for (let i = 0; i < 16; i++) {
            const j = offset + i * 4;
            w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
        }
        for (let i = 16; i < 80; i++) {
            const value = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (value << 1) | (value >>> 31);
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4;
        for (let i = 0; i < 80; i++) {
            let f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            const next = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
            e = d; d = c; c = ((b << 30) | (b >>> 2)) | 0; b = a; a = next;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    for (const [value, offset] of [[h0, 0], [h1, 32], [h2, 64], [h3, 96], [h4, 128]]) {
        const unsigned = value >>> 0;
        if (unsigned) return offset + Math.clz32(unsigned);
    }
    return 160;
}
const prefix = workerData.challenge + ':';
for (let nonce = workerData.start; ; nonce += workerData.step) {
    if (sha1lz(prefix + nonce) >= workerData.difficulty) {
        parentPort.postMessage({ nonce });
        break;
    }
}
`;

function solveFileCryptProof(challenge, options = {}) {
    const value = challenge && typeof challenge === 'object' ? challenge : {};
    const prefix = String(value.challenge || '');
    const difficulty = Math.trunc(Number(value.difficulty));
    if (!/^[A-Fa-f0-9]{16,128}$/.test(prefix) || difficulty < 1 || difficulty > 30) {
        return Promise.reject(new Error('FileCrypt proof challenge is invalid.'));
    }
    const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 2;
    const workerCount = Math.max(1, Math.min(
        Math.trunc(Number(options.workers)) || Math.max(2, cpuCount - 1),
        8
    ));
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 5 * 60 * 1000, 6 * 60 * 1000));
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const workers = [];
        let settled = false;
        const finish = (error, nonce) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            for (const worker of workers) worker.terminate().catch(() => {});
            if (error) reject(error);
            else resolve({ nonce, elapsed: Math.max(1, Date.now() - startedAt), pauses: 0 });
        };
        const timer = setTimeout(() => finish(new Error('FileCrypt proof timed out.')), timeoutMs);
        for (let index = 0; index < workerCount; index++) {
            const worker = new Worker(POW_WORKER_SOURCE, {
                eval: true,
                workerData: { challenge: prefix, difficulty, start: index, step: workerCount }
            });
            workers.push(worker);
            worker.once('message', message => {
                const nonce = message && Number(message.nonce);
                if (!Number.isSafeInteger(nonce) || nonce < 0) {
                    finish(new Error('FileCrypt proof worker returned an invalid result.'));
                    return;
                }
                finish(null, nonce);
            });
            worker.once('error', finish);
            worker.once('exit', code => {
                if (!settled && code !== 0) finish(new Error(`FileCrypt proof worker exited with code ${code}.`));
            });
        }
    });
}

const FILECRYPT_CHALLENGE_EXPRESSION = `(function(){
    if(document.readyState==='loading'||!document.body||!document.body.innerHTML)return null;
    var captcha=document.querySelector('#pow-captcha');
    var links=function(){return Array.from(document.querySelectorAll('a[href],[onclick],button[onclick]')).slice(0,256).map(function(element){return{href:element.href||'',text:(element.textContent||'').trim().slice(0,256),onclick:(element.getAttribute('onclick')||'').slice(0,1024)}})};
    var statusText=function(){return String(document.body&&document.body.innerText||'').slice(0,65536)};
    if(!captcha)return{stage:'container',location:location.href,cookie:document.cookie,ua:navigator.userAgent,links:links(),statusText:statusText()};
    if(sessionStorage.__sailGoFilePhase==='submitted')return{stage:'rejected'};
    return null;
})()`;

function fileCryptSubmitExpression(challengeResult, proof) {
    const challenge = challengeResult && challengeResult.challenge || {};
    const fields = {
        pow_id: String(challenge.id || ''),
        pow_nonce: String(proof && proof.nonce),
        pow_elapsed: String(proof && proof.elapsed),
        pow_pauses: String(Math.max(1, Number(proof && proof.pauses) || 0)),
        pow_data: '',
        pow_x: String(challengeResult && challengeResult.extension || '')
    };
    if (!/^[A-Fa-f0-9]{6,128}$/.test(fields.pow_id) || !/^\d+$/.test(fields.pow_nonce)
        || !/^\d+$/.test(fields.pow_elapsed) || fields.pow_data.length > 20000 || fields.pow_x.length > 20000) {
        throw new Error('FileCrypt proof result is invalid.');
    }
    return `(async function(){
        if(document.readyState==='loading'||!document.body||!document.body.innerHTML)return null;
        var captcha=document.querySelector('#pow-captcha');
        var links=function(){return Array.from(document.querySelectorAll('a[href],[onclick],button[onclick]')).slice(0,256).map(function(element){return{href:element.href||'',text:(element.textContent||'').trim().slice(0,256),onclick:(element.getAttribute('onclick')||'').slice(0,1024)}})};
        var statusText=function(){return String(document.body&&document.body.innerText||'').slice(0,65536)};
        if(!captcha)return{stage:'container',location:location.href,cookie:document.cookie,ua:navigator.userAgent,links:links(),statusText:statusText()};
        if(sessionStorage.__sailGoFilePhase==='submitted')return{stage:'rejected'};
        var fields=${JSON.stringify(fields)};
        if(!fields.pow_x){
            try{
                var extensionModule=await import(new URL(captcha.dataset.ext,location.href).href);
                var readExtension=extensionModule&&(extensionModule.R||(extensionModule.default&&extensionModule.default.R));
                if(readExtension)fields.pow_x=await readExtension()||'';
            }catch(_error){}
        }
        try{
            var signalModule=await import(new URL(captcha.dataset.sig,location.href).href);
            var signals=signalModule&&(signalModule.S||(signalModule.default&&signalModule.default.S));
            if(signals&&signals.collect)fields.pow_data=signals.collect()||'';
        }catch(_error){}
        Object.keys(fields).forEach(function(name){var input=captcha.querySelector('[name="'+name+'"]');if(input)input.value=fields[name]});
        captcha.setAttribute('data-state','done');
        sessionStorage.__sailGoFilePhase='submitted';
        var form=captcha.closest('form')||document.querySelector('#cform');
        if(!form)return{stage:'error',error:'form'};
        await new Promise(function(resolve){setTimeout(resolve,850)});
        form.submit();
        await new Promise(function(resolve){setTimeout(resolve,3000)});
        return null;
    })()`;
}

module.exports = {
    FILECRYPT_CHALLENGE_EXPRESSION,
    fileCryptLinkCandidates,
    fileCryptSubmitExpression,
    normalizeFileCryptContainerUrl,
    solveFileCryptProof
};
