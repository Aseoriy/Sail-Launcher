'use strict';
const path = require('node:path');
const METHOD = 'pe-image-v1';
function validateGameTracking(value) {
    if (value === undefined) return undefined;
    const wine = value?.backend === 'wine';
    if (!value || Object.keys(value).sort().join(',') !== (wine ? 'backend,loaders,prefix,protonRoot,target' : 'prefix,protonRoot,target')
        || !value.target || ['realPath', 'dev', 'ino', 'size', 'mtimeMs'].some(k => value.target[k] === undefined)) throw Error('Invalid Windows image tracking binding.');
    for (const name of ['prefix', 'protonRoot']) {
        if (typeof value[name] !== 'string' || !path.isAbsolute(value[name]) || path.resolve(value[name]) !== value[name]
            || /[\u0000-\u001f\u007f]/.test(value[name]) || Buffer.byteLength(value[name]) > 4096) throw Error('Invalid Windows image tracking path.');
    }
    const target = {};
    if (typeof value.target.realPath !== 'string' || !path.isAbsolute(value.target.realPath)
        || path.resolve(value.target.realPath) !== value.target.realPath || /[\u0000-\u001f\u007f]/.test(value.target.realPath)
        || Buffer.byteLength(value.target.realPath) > 4096) throw Error('Invalid Windows image path.');
    target.realPath = value.target.realPath;
    for (const k of ['dev', 'ino', 'size', 'mtimeMs']) {
        const n = value.target[k];
        if (!Number.isSafeInteger(Number(n)) || Number(n) < 0 || !/^\d+$/.test(String(n))) throw Error('Invalid Windows image identity.');
        target[k] = String(n);
    }
    if (wine) {
        if (!Array.isArray(value.loaders) || !value.loaders.length || value.loaders.length > 24) throw Error('Invalid Wine image loader binding.');
        const seen = new Set(), loaders = value.loaders.map(item => {
            const identity = validateGameTracking({ target: item, prefix: value.prefix, protonRoot: value.protonRoot }).target;
            if (!require('../native/protocol').withinRoot(identity.realPath, value.protonRoot) || seen.has(identity.realPath)) throw Error('Invalid Wine loader path.');
            seen.add(identity.realPath); return identity;
        });
        return { backend: 'wine', target, prefix: value.prefix, protonRoot: value.protonRoot, loaders };
    }
    return { target, prefix: value.prefix, protonRoot: value.protonRoot };
}
function validGameReceipt(value, previous, binding, receipt) {
    if (!binding) return value === undefined;
    if (!value || Object.keys(value).sort().join(',') !== 'activeProcesses,confirmed,elapsedMs,error,method,startOffsetMs,targetDev,targetIno' || value.method !== (binding.backend === 'wine' ? 'pe-image-wine-v1' : METHOD) || value.targetDev !== binding.target.dev || value.targetIno !== binding.target.ino
        || typeof value.confirmed !== 'boolean' || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0
        || !Number.isSafeInteger(value.startOffsetMs) || value.startOffsetMs < 0
        || !Number.isSafeInteger(value.activeProcesses) || value.activeProcesses < 0 || value.activeProcesses > 4096
        || !Number.isSafeInteger(value.error) || value.error < 0
        || value.startOffsetMs + value.elapsedMs > receipt.elapsedMs
        || (!value.confirmed && (value.elapsedMs || value.startOffsetMs || value.activeProcesses))
        || (value.error && value.activeProcesses)
        || (!receipt.execSucceeded && value.confirmed) || (receipt.terminal && value.activeProcesses)
        || (previous && (value.elapsedMs < previous.elapsedMs || previous.confirmed && !value.confirmed
            || previous.confirmed && value.startOffsetMs !== previous.startOffsetMs || previous.error && (value.error !== previous.error || value.elapsedMs !== previous.elapsedMs)))) return false;
    return true;
}
function confirmedGame(session, receipt = session?.native?.receipt) {
    if (!require('./wine').windowsBackend(session?.native?.launchMetadata?.backend) || session.native.launchMetadata.activity !== 'game') return false;
    try {
        const binding = validateGameTracking(session.native.gameTracking);
        return !!binding && (binding.backend === 'wine') === (session.native.launchMetadata.backend === 'wine')
            && validGameReceipt(receipt?.game, null, binding, receipt) && receipt.game.confirmed && !receipt.game.error;
    } catch (_) { return false; }
}
module.exports = { METHOD, validateGameTracking, validGameReceipt, confirmedGame };
