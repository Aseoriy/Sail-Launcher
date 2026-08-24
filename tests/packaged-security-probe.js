'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const asar = require('@electron/asar');

const root = path.join(__dirname, '..');
const asarPath = process.argv[2] || path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const reviewedFiles = [
    'main.js',
    'index.html',
    'security/ipcAuthorization.js',
    'security/navigationPolicy.js',
    'security/remoteData.js',
    'security/remoteDataWorker.js',
    'runtime/downloadJobCleanup.js',
    'runtime/downloadIpc.js',
    'runtime/downloadQuarantine.js',
    'runtime/browserDownloadIntents.js',
    'runtime/downloadWorkCoordinator.js',
    'runtime/ownedChildProcess.js',
    'ui/downloadQuarantine.js',
    'ui/remoteJson.js',
    'accounts/ipc.js',
    'maintenance/ipc.js',
    'achievements/ipc.js'
];

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

const hashes = {};
for (const relativePath of reviewedFiles) {
    const source = fs.readFileSync(path.join(root, relativePath));
    const packed = asar.extractFile(asarPath, relativePath.replace(/\\/g, '/'));
    assert.equal(Buffer.compare(source, packed), 0, `${relativePath} differs from app.asar`);
    hashes[relativePath] = sha256(packed);
    if (relativePath.endsWith('.js')) new vm.Script(packed.toString('utf8'), { filename: `app.asar/${relativePath}` });
}

const packagedMain = asar.extractFile(asarPath, 'main.js').toString('utf8');
const packagedIndex = asar.extractFile(asarPath, 'index.html').toString('utf8');
assert.match(packagedMain, /registerRemoteDataIpc\(ipcMain, remoteDataService\)/);
assert.match(packagedMain, /registerDownloadCancellationIpc\(ipcMain,/);
assert.match(packagedMain, /registerDownloadQuarantineIpc\(ipcMain,/);
assert.match(packagedMain, /createBrowserWillDownloadHandler\(\{/);
assert.match(packagedMain, /createPrepareBrowserDownloadHandler\(\{/);
assert.doesNotMatch(packagedMain, /ipcMain\.handle\(['"]scrape-(?:fetch|render)['"]/);
assert.doesNotMatch(packagedIndex, /ipcRenderer\.invoke\(['"]scrape-(?:fetch|render)['"]/);
assert.match(packagedIndex, /createRemoteDataClient\(ipcRenderer\)/);
assert.match(packagedIndex, /DownloadQuarantineUi\.cancellationPresentation\(result\)/);
assert.match(packagedIndex, /if \(presentation\.completed\)/);
assert.doesNotMatch(packagedIndex, /cancel-download['"],\s*id,\s*\{[^}]*deleteFolder/);

let inlineScripts = 0;
for (const match of packagedIndex.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!match[1].trim()) continue;
    new vm.Script(match[1], { filename: `app.asar/index.html:inline-${++inlineScripts}` });
}
assert.ok(inlineScripts > 0, 'No packaged inline renderer scripts were checked.');

console.log(`SAIL_PACKAGED_SECURITY_PROBE ${JSON.stringify({ asarPath, inlineScripts, hashes })}`);
