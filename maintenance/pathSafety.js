'use strict';

const fs = require('fs');
const path = require('path');

function normalizeAbsolute(input) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('A non-empty path is required.');
    return path.resolve(input.trim());
}

function isWithin(root, candidate, allowRoot = true) {
    const safeRoot = normalizeAbsolute(root);
    const safeCandidate = normalizeAbsolute(candidate);
    const relative = path.relative(safeRoot, safeCandidate);
    if (!relative) return allowRoot;
    return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function toRelative(root, candidate) {
    if (!isWithin(root, candidate, true)) throw new Error('Path escapes the installation root.');
    const relative = path.relative(normalizeAbsolute(root), normalizeAbsolute(candidate));
    return relative.split(path.sep).join('/');
}

function resolveWithin(root, relativePath, allowRoot = false) {
    if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
        throw new Error('Expected a relative path.');
    }
    const normalizedRelative = relativePath.replace(/[\\/]+/g, path.sep);
    const resolved = path.resolve(normalizeAbsolute(root), normalizedRelative);
    if (!isWithin(root, resolved, allowRoot)) throw new Error('Path traversal outside the installation root was blocked.');
    return resolved;
}

async function ensureNoLinkEscape(root, candidate) {
    const safeRoot = normalizeAbsolute(root);
    const safeCandidate = normalizeAbsolute(candidate);
    if (!isWithin(safeRoot, safeCandidate, true)) throw new Error('Path escapes the allowed root.');

    const relative = path.relative(safeRoot, safeCandidate);
    let current = safeRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        let stat;
        try { stat = await fs.promises.lstat(current); } catch (error) {
            if (error.code === 'ENOENT') break;
            throw error;
        }
        if (stat.isSymbolicLink()) throw new Error(`Symbolic link traversal was blocked: ${current}`);
    }
    return safeCandidate;
}

function safeId(value) {
    const id = String(value || '').trim();
    if (!id) throw new Error('A game ID is required.');
    return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
}

module.exports = { ensureNoLinkEscape, isWithin, normalizeAbsolute, resolveWithin, safeId, toRelative };
