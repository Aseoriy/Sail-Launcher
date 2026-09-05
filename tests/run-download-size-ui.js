'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The Node parent removes only its own profile, after Electron releases it.
if (!process.versions.electron) {
    const { spawn } = require('node:child_process');
    const tempParent = fs.realpathSync(os.tmpdir());
    const tempRoot = fs.mkdtempSync(path.join(tempParent, 'sail-size-ui-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, '--size-ui-child', tempRoot], {
        cwd: path.join(__dirname, '..'), env, stdio: 'inherit', windowsHide: true
    });
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 30000);
    child.once('error', error => { failed = true; console.error(error); });
    child.once('close', code => {
        clearTimeout(timer);
        try {
            const resolved = fs.realpathSync(tempRoot);
            assert.equal(resolved, path.resolve(tempRoot));
            assert.equal(path.dirname(resolved), tempParent);
            assert.ok(path.basename(resolved).startsWith('sail-size-ui-'));
            fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch (error) { failed = true; console.error(error); }
        process.exitCode = failed || code !== 0 ? 1 : 0;
    });
    return;
}
const { app, BrowserWindow } = require('electron');

const rootArg = process.argv.indexOf('--size-ui-child');
assert.ok(rootArg >= 0, 'Run with node tests/run-download-size-ui.js');
const tempUserData = fs.realpathSync(process.argv[rootArg + 1]);
assert.equal(path.dirname(tempUserData), fs.realpathSync(os.tmpdir()));
assert.ok(path.basename(tempUserData).startsWith('sail-size-ui-'));
app.setPath('userData', tempUserData);

function extractFunction(source, name) {
    const plain = source.indexOf(`function ${name}(`);
    const asyncStart = source.indexOf(`async function ${name}(`);
    const start = asyncStart >= 0 && (plain < 0 || asyncStart < plain) ? asyncStart : plain;
    if (start < 0) throw new Error(`Could not find ${name}`);
    const body = source.indexOf('{', start);
    let depth = 0;
    for (let index = body; index < source.length; index++) {
        if (source[index] === '{') depth++;
        else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Could not extract ${name}`);
}
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const rendererFunctions = ['scrapeMeta', 'estTime', 'downloadSetSizeInfo', 'downloadSetSourceSize', 'downloadSetSizeText', 'buildDownloadSizeIndicator', 'renderDownloadSetSize', 'renderDownloadSizeMeta', 'selectDownloadSizeSet', 'downloadLinkHealthKey', 'downloadSetHealthTargets', 'checkDownloadHealthTarget', 'pumpDownloadLinkHealthQueue', 'requestDownloadLinkHealth', 'updateDownloadLinkHealth', 'downloadHealthPresentation', 'renderDownloadHealthIndicator', 'buildDownloadHealthIndicator', 'configurePrimaryDownloadButton', 'refreshPrimaryDownloadChoice', 'buildSetRow', 'groupDownloadSets', 'dlHostScore', 'cachedBadge', 'fmtState', 'dlIsIndeterminate', 'formatCacheBytes', 'downloadSizeWarning', 'renderDownloadSizeWarning', 'refreshDownloadSizeWarnings', 'buildDownloadRow', 'buildDownloadActions', 'patchActiveRow', 'dlIsBusy', 'handleDownloadSizeWarning'];
const extracted = Object.fromEntries(rendererFunctions.map(name => [name, extractFunction(rendererSource, name)]));
const dialogsSource = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dialogs.js'), 'utf8');
const openDetailStart = rendererSource.indexOf('window.openDownloadDetail = async function (');
const openDetailEnd = rendererSource.indexOf('// A grouped host set:', openDetailStart);
assert.ok(openDetailStart > 0 && openDetailEnd > openDetailStart);
const openDetailFunction = rendererSource.slice(openDetailStart, openDetailEnd).trim().replace(/^window\.openDownloadDetail = /, '').replace(/;$/, '');
const dockStyleAt = rendererSource.indexOf('.dl-dock-row {');
const dockStyleStart = rendererSource.lastIndexOf('<style>', dockStyleAt);
const dockStyleEnd = rendererSource.indexOf('</style>', dockStyleAt);
assert.ok(dockStyleStart >= 0 && dockStyleEnd > dockStyleStart);
const dockStyles = rendererSource.slice(dockStyleStart + '<style>'.length, dockStyleEnd);

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
        (_details, callback) => callback({ cancel: true }));
    try {
        await win.loadURL('data:text/html,<html><body></body></html>');
        const result = await win.webContents.executeJavaScript(`(async () => {
            const assert = require('node:assert/strict');
            const DownloadSizeLogic = require(${JSON.stringify(path.join(__dirname, '..', 'ui', 'downloadSizeLogic.js'))});
            const SafeDom = require(${JSON.stringify(path.join(__dirname, '..', 'ui', 'safeDom.js'))});
            const DownloadManagerLogic = require(${JSON.stringify(path.join(__dirname, '..', 'ui', 'downloadManagerLogic.js'))});
            const DownloadSourceLogic = require(${JSON.stringify(path.join(__dirname, '..', 'ui', 'downloadSourceLogic.js'))});
            const screenshotImages = () => [];
            const screenshotRecord = () => null;
            const downloadLinkHealthState = new Map();
            const downloadLinkHealthRequests = new Map();
            const downloadLinkHealthQueue = [];
            let downloadLinkHealthActive = 0;
            let dlDetailToken = 1;
            const ipcRenderer = {};
            const dlQueue = new Map();
            const downloadCategoryBadgeElement = () => document.createElement('span');
            const renderDock = () => {};
            const resumeCalls = [];
            window.resumeDownload = id => resumeCalls.push(id);
            let dlCurrent = null;
            const dlSetHostLabel = set => String(set && set.host || 'Download');
            const restrictedDownloadsEnabled = () => false;
            const isRestrictedHost = () => false;
            const isCFBlockedHost = host => /akirabox/i.test(host);
            const startedDownloads = [];
            const startGameDownloadSet = (item, set, sourceId) => startedDownloads.push({ item, set, sourceId });
            const startRestrictedBrowserDownload = () => { throw new Error('Unexpected browser download'); };
            const buildLinkRow = () => document.createElement('div');
            let dlDetailReturnFocus = null;
            let dlScreenshotItems = [];
            ${extracted.scrapeMeta}
            ${extracted.estTime}
            ${extracted.downloadLinkHealthKey}
            ${extracted.downloadSetSizeInfo}
            ${extracted.downloadSetSourceSize}
            ${extracted.downloadSetSizeText}
            ${extracted.buildDownloadSizeIndicator}
            ${extracted.renderDownloadSetSize}
            ${extracted.renderDownloadSizeMeta}
            ${extracted.selectDownloadSizeSet}
            ${extracted.updateDownloadLinkHealth}
            ${extracted.downloadHealthPresentation}
            ${extracted.renderDownloadHealthIndicator}
            ${extracted.buildDownloadHealthIndicator}
            ${extracted.configurePrimaryDownloadButton}
            ${extracted.refreshPrimaryDownloadChoice}
            ${extracted.buildSetRow}
            ${extracted.groupDownloadSets}
            ${extracted.dlHostScore}
            ${extracted.downloadSetHealthTargets}
            ${extracted.checkDownloadHealthTarget}
            ${extracted.pumpDownloadLinkHealthQueue}
            ${extracted.requestDownloadLinkHealth}
            ${extracted.cachedBadge}
            ${extracted.fmtState}
            ${extracted.dlIsIndeterminate}
            ${extracted.formatCacheBytes}
            ${extracted.downloadSizeWarning}
            ${extracted.renderDownloadSizeWarning}
            ${extracted.refreshDownloadSizeWarnings}
            ${extracted.buildDownloadRow}
            ${extracted.buildDownloadActions}
            ${extracted.patchActiveRow}
            ${extracted.dlIsBusy}
            ${extracted.handleDownloadSizeWarning}
            ${dialogsSource}
            const fail = (message) => { throw new Error(message); };
            const assertText = (actual, expected, label) => { if (actual !== expected) fail(label + ': ' + actual + ' !== ' + expected); };
            const host = document.createElement('div');
            host.innerHTML = '<div id="ddpMeta"></div>';
            document.body.appendChild(host);
            const doc = document.implementation.createHTMLDocument('size');
            doc.body.innerHTML = '<article>Memory: 12 GB RAM<br>Storage: 120 GB</article>';
            const ram = scrapeMeta(doc, 'https://example.test/game');
            assertText(ram.sizeInfo, null, 'RAM/storage ignored');
            dlCurrent = { meta: ram, selectedSet: null, id: 'steamgg', src: { name: 'Test' } };
            renderDownloadSizeMeta();
            assert.ok(document.getElementById('ddpMeta').textContent.includes('Download SizeNot provided by source'));
            assert.ok(!/12 GB|120 GB|Est. Time/.test(document.getElementById('ddpMeta').textContent));
            doc.body.innerHTML = '<article>Repack Size: 78.5 GB<br>Original Size: 149 GB</article>';
            const meta = scrapeMeta(doc, 'https://example.test/game');
            assertText(meta.sizeInfo.kind, 'Repack Size', 'repack kind');
            assertText(meta.sizeInfo.label, '78.5 GB', 'repack label');
            const sourceDoc = document.implementation.createHTMLDocument('size');
            sourceDoc.body.innerHTML = '<article>Download Size: 113.8 GB</article>';
            const sourceMeta = scrapeMeta(sourceDoc, 'https://example.test/game');
            assertText(sourceMeta.sizeInfo.label, '113.8 GB', 'download size');
            const selected = { kind: 'host', group: 'main', host: 'datanodes.to', parts: [{ url: 'https://datanodes.to/a', sizeLabel: '113.8 GB' }] };
            dlCurrent = { meta, selectedSet: selected, id: 'steamgg', src: { name: 'Test' } };
            renderDownloadSizeMeta();
            assert.ok(document.getElementById('ddpMeta').textContent.includes('Download Size78.5 GB (source repack)'));
            assert.ok(buildDownloadSizeIndicator(selected, 'steamgg').textContent.includes('78.5 GB (source repack; mirror unconfirmed)'));
            updateDownloadLinkHealth(selected.parts[0].url, 'steamgg', { status: 'available', sizeLabel: '113.8 GB' });
            const metaText = document.getElementById('ddpMeta').textContent;
            if (!metaText.includes('113.8 GB (host reported)')) fail('host-reported selected size missing');
            assert.ok(!/78.5 GB|149 GB|Est. Time/.test(metaText));
            const indicator = document.createElement('div');
            indicator.className = 'download-set-size';
            indicator._downloadSizeSet = selected; indicator._downloadSizeSourceId = 'steamgg';
            document.body.appendChild(indicator);
            renderDownloadSetSize(indicator);
            assertText(indicator.textContent, 'Download size: 113.8 GB (host reported)', 'host indicator');
            const partial = { kind: 'host', parts: [1, 2, 3, 4, 5].map((n) => ({ url: 'https://host.test/' + n })) };
            [1, 2, 3, 4].forEach((n) => downloadLinkHealthState.set(downloadLinkHealthKey('https://host.test/' + n, 'steamgg'), { sizeBytes: 1000 }));
            const partialInfo = downloadSetSizeInfo(partial, 'steamgg');
            assertText(partialInfo, null, 'partial set not treated as complete');
            dlCurrent = { meta: { sizeInfo: null }, selectedSet: partial, id: 'steamgg', src: { name: 'Test' } };
            renderDownloadSizeMeta();
            if (!document.getElementById('ddpMeta').textContent.includes('Checking… (4/5 file sizes)')) fail('partial lookup progress not shown');
            updateDownloadLinkHealth('https://host.test/5', 'steamgg', { status: 'available', sizeBytes: 2000 });
            assertText(downloadSetSizeInfo(partial, 'steamgg').bytes, 6000, 'complete uneven multipart total');
            dlCurrent.selectedSet = selected;
            updateDownloadLinkHealth(selected.parts[0].url, 'steamgg', { status: 'available', sizeLabel: '<img src=x onerror=alert(1)>', sizeBytes: true });
            if (document.getElementById('ddpMeta').innerHTML.includes('<img')) fail('size label allowed HTML');
            assertText(indicator.textContent, 'Download size: Not provided by host', 'unsafe size rejected in mirror row');
            assert.ok(document.getElementById('ddpMeta').textContent.includes('Download SizeNot provided by host'));
            updateDownloadLinkHealth(selected.parts[0].url, 'steamgg', { status: 'available', sizeLabel: '113.8 GB' });
            const staleMirror = { kind: 'host', parts: [{ url: 'https://host.test/stale' }] };
            dlCurrent.item = { url: 'https://example.test/game' };
            selectDownloadSizeSet(dlCurrent.item, staleMirror, 'steamgg');
            updateDownloadLinkHealth(staleMirror.parts[0].url, 'steamgg', { status: 'available', sizeLabel: '149 GB' });
            assert.ok(document.getElementById('ddpMeta').textContent.includes('149 GB'));
            selectDownloadSizeSet(dlCurrent.item, selected, 'steamgg');
            updateDownloadLinkHealth(staleMirror.parts[0].url, 'steamgg', { status: 'available', sizeLabel: '150 GB' });
            if (!document.getElementById('ddpMeta').textContent.includes('113.8 GB')) fail('late stale mirror replaced selected size');

            const unreported = { kind: 'http', host: 'gofile.io', parts: [{ url: 'https://gofile.io/d/none' }] };
            dlCurrent.sets = [unreported, selected];
            dlCurrent.selectedSet = unreported;
            updateDownloadLinkHealth(unreported.parts[0].url, 'steamgg', { status: 'unknown' });
            assert.ok(document.getElementById('ddpMeta').textContent.includes('Download Size113.8 GB'));
            assert.ok(document.getElementById('ddpMeta').textContent.includes('Size fromdatanodes.to — selected mirror unconfirmed'));
            assert.ok(!document.getElementById('ddpMeta').textContent.includes('Est. Time'));
            assert.ok(buildDownloadSizeIndicator(unreported, 'steamgg').textContent.includes('Not provided by host'));
            dlCurrent.meta = meta;
            assert.ok(buildDownloadSizeIndicator(unreported, 'steamgg').textContent.includes('source repack; mirror unconfirmed'));
            const languages = { ...unreported, group: 'languages' };
            dlCurrent.sets.push(languages);
            dlCurrent.selectedSet = languages;
            renderDownloadSizeMeta();
            assert.ok(!/78.5 GB|113.8 GB/.test(document.getElementById('ddpMeta').textContent), 'language pack must not borrow game sizes');

            doc.body.innerHTML = '<article>Other text<div><strong>Download Size:</strong></div><p>45.2 GB</p><div>Storage: 120 GB</div></article>';
            assert.equal(scrapeMeta(doc, 'https://example.test/game').sizeInfo.label, '45.2 GB');
            doc.body.innerHTML = '<article><ul><li><strong>Storage:</strong> 150 GB available space</li><li><strong>Game Size: </strong>116 GB</li></ul></article>';
            assert.equal(scrapeMeta(doc, 'https://steamrip.com/game/').sizeInfo.label, '116 GB');
            assert.equal(scrapeMeta(doc, 'https://steamgg.net/game/').sizeInfo, null);

            const lookupSet = { kind: 'http', parts: Array.from({ length: 9 }, (_, i) => ({ url: 'https://host.test/lookup' + i })) };
            const targets = downloadSetHealthTargets(lookupSet, 'steamgg');
            assert.equal(targets.length, 9, 'every part gets a metadata lookup');
            const calls = [];
            const completions = [];
            ipcRenderer.invoke = (_channel, args) => {
                calls.push(args.url);
                return new Promise(resolve => completions.push(resolve));
            };
            const flushLookups = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
            targets.forEach(requestDownloadLinkHealth);
            const alternate = downloadSetHealthTargets({ kind: 'http', parts: [{ url: 'https://other.test/lookup' }] }, 'steamgg')[0];
            requestDownloadLinkHealth(alternate);
            await flushLookups();
            assert.equal(calls.length, 4, 'only four lookups run at once');
            assert.ok(calls.includes(alternate.url), 'another mirror is checked before a long first mirror finishes');
            while (completions.length) {
                completions.shift()({ status: 'available', sizeBytes: 1024 });
                await flushLookups();
                assert.ok(downloadLinkHealthActive <= 4);
            }
            assert.equal(calls.length, 10);
            assert.equal(downloadSetSizeInfo(lookupSet, 'steamgg').bytes, 9 * 1024);
            requestDownloadLinkHealth(targets[0]);
            await flushLookups();
            assert.equal(calls.length, 10, 'fresh metadata is reused');
            downloadLinkHealthState.get(targets[0].key).checkedAt = Date.now() - 61000;
            requestDownloadLinkHealth(targets[0]);
            await flushLookups();
            assert.equal(calls.length, 11, 'old metadata can be refreshed');
            completions.shift()({ status: 'unknown' });
            await flushLookups();
            const stale = downloadSetHealthTargets({ kind: 'http', parts: [{ url: 'https://old.test/queued' }] }, 'steamgg')[0];
            requestDownloadLinkHealth(stale);
            dlDetailToken++;
            await flushLookups();
            assert.ok(!calls.includes(stale.url), 'queued lookups for old pages are skipped');
            assert.equal(downloadLinkHealthRequests.size, 0);
            const unknownState = { state: 'downloading', downloaded: '4.2 GiB', total: '', percent: 0, eta: '1m' };
            const unknown = fmtState(unknownState);
            if (!unknown.includes('4.2 GiB downloaded (total unknown)') || unknown.includes('ETA')) fail('unknown transfer formatting incorrect');
            assert.ok(!unknown.includes('0%'));
            assertText(dlIsIndeterminate(unknownState), true, 'unknown total has indeterminate bar');
            const knownState = { state: 'downloading', downloaded: '4.2 GiB', total: '10 GiB', percent: 42, eta: '1m' };
            const known = fmtState(knownState);
            if (!known.includes('42%') || !known.includes('ETA 1m')) fail('known transfer formatting incorrect');
            assertText(dlIsIndeterminate(knownState), false, 'known total has determinate bar');
            const partState = { ...knownState, progressScope: 'file', part: 2, partCount: 3, file: 1, fileCount: 2 };
            const partText = fmtState(partState);
            assert.ok(partText.includes('part 2/3') && partText.includes('file 1/2'));
            assert.ok(partText.includes('42% of current file') && partText.includes('File ETA 1m'));
            assert.ok(fmtState({ ...partState, state: 'paused' }).includes('42% of current file'));
            assertText(formatCacheBytes(1024 ** 3), '1.0 GiB', 'cache binary units');

            // Exercise the actual themed confirmation dialog and warning handler
            // with no network or launcher profile involved.
            const warningDownload = { id: 'warning-download', state: 'paused', resumeOpts: {} };
            dlQueue.set(warningDownload.id, warningDownload);
            const warningPromise = handleDownloadSizeWarning(warningDownload, { reportedBytes: 1000, actualBytes: 500 });
            for (let i = 0; i < 20 && !document.querySelector('.sail-dialog-layer'); i++) await new Promise(resolve => setTimeout(resolve, 0));
            const warningDialog = document.querySelector('.sail-dialog-layer');
            assert.ok(warningDialog, 'size warning dialog is shown');
            assert.ok(warningDialog.textContent.includes('Reported game size: 1000 B'));
            assert.ok(warningDialog.textContent.includes('Actual download size: 500 B'));
            assert.equal(warningDialog.querySelector('.sail-dialog-title').textContent, 'Download size warning');
            assert.equal(warningDialog.querySelector('.sail-dialog-primary').textContent, 'Download anyway');
            assert.equal(warningDialog.querySelector('.sail-dialog-cancel').textContent, 'Keep paused');
            warningDialog.querySelector('.sail-dialog-primary').click();
            await warningPromise;
            assert.equal(warningDownload.resumeOpts.approvedDownloadSizeBytes, 500);
            assert.deepEqual(resumeCalls, ['warning-download']);

            const keepPaused = { id: 'keep-paused', state: 'paused', resumeOpts: {} };
            dlQueue.set(keepPaused.id, keepPaused);
            const keepPromise = handleDownloadSizeWarning(keepPaused, { reportedBytes: 1000, actualBytes: 500 });
            for (let i = 0; i < 20 && !document.querySelector('.sail-dialog-layer'); i++) await new Promise(resolve => setTimeout(resolve, 0));
            document.querySelector('.sail-dialog-cancel').click();
            await keepPromise;
            assert.equal(keepPaused.resumeOpts.approvedDownloadSizeBytes, undefined);
            assert.deepEqual(resumeCalls, ['warning-download']);

            const styles = document.createElement('style');
            styles.textContent = ${JSON.stringify(dockStyles)};
            document.head.append(styles);
            document.documentElement.style.setProperty('--text-color', '#fafafa');
            const waiting = { id: 'size-warning-test', state: 'resolving', name: 'Size warning test',
                sourceId: 'steamgg', requestedDebridService: 'TorBox',
                resumeOpts: { url: 'https://datanodes.to/late-size' } };
            dlQueue.set(waiting.id, waiting);
            const dockRow = buildDownloadRow(waiting);
            const pageRow = buildDownloadRow(waiting, true);
            document.body.append(dockRow, pageRow);
            const notice = dockRow.querySelector('.dl-size-warning');
            assert.equal(notice.hidden, true, 'unknown size must not claim an oversized link');
            updateDownloadLinkHealth(waiting.resumeOpts.url, 'steamgg', { status: 'verification-required', sizeLabel: '113.8 GB' });
            assert.equal(notice.hidden, false, 'late metadata updates an existing popup');
            assert.ok(notice.textContent.includes('TorBox doesn’t support web links over 100 GB'));
            assert.equal(pageRow.querySelector('.dl-size-warning').textContent, notice.textContent);
            assert.equal(notice.getAttribute('role'), 'note');
            assert.equal(dockRow.querySelector('button').disabled, false, 'notice does not disable download controls');
            dockRow.style.width = '260px';
            assert.equal(getComputedStyle(notice).whiteSpace, 'normal');
            assert.ok(notice.scrollWidth <= notice.clientWidth, 'notice must wrap in a small popup');
            waiting.state = 'error';
            refreshDownloadSizeWarnings();
            assert.equal(notice.hidden, false, 'limit explanation remains readable after rejection');
            waiting.requestedDebridService = '';
            refreshDownloadSizeWarnings();
            assert.equal(notice.hidden, true, 'direct retry clears the TorBox warning');
            waiting.debridService = 'TorBox';
            waiting.state = 'downloading';
            waiting.total = '120 GiB';
            updateDownloadLinkHealth(waiting.resumeOpts.url, 'steamgg', { status: 'unknown' });
            patchActiveRow(waiting.id);
            assert.equal(notice.hidden, false, 'real transfer metadata also supplies the size');
            waiting.state = 'done';
            refreshDownloadSizeWarnings();
            assert.equal(notice.hidden, true, 'completed downloads do not retain the warning');
            waiting.state = 'resolving';
            waiting.browserCapture = true;
            refreshDownloadSizeWarnings();
            assert.equal(notice.hidden, true, 'browser downloads do not use TorBox');

            // Run the actual page-opening function with inert source fixtures and
            // deferred IPC, proving preflights begin without any download click.
            const detailFixture = document.createElement('div');
            detailFixture.innerHTML = '<div id="downloadSearchPanel"></div><div id="downloadDetailPanel"></div><div id="mainScroller"></div><button id="downloadDetailBackButton">Back</button><img id="ddpHero"><h1 id="ddpTitle"></h1><span id="ddpSource"></span><div id="ddpDescription"></div><div id="ddpScreensWrap"><div id="ddpScreens"></div></div><div id="ddpDownloadArea"></div>';
            document.body.append(detailFixture);
            const gofileUrl = 'https://www.filecrypt.cc/Container/ABCDEF1234.html';
            const buzzUrl = 'https://buzzheavier.com/working-mirror';
            let sourceLinks = [
                { url: gofileUrl, label: 'GoFile', resolverHost: 'gofile.io', type: 'web' },
                { url: buzzUrl, label: 'BuzzHeavier', type: 'web' }
            ];
            const DL_SOURCES = { steamrip: { name: 'SteamRIP', color: '#32aaff', detail: () => sourceLinks } };
            const pageDoc = document.implementation.createHTMLDocument('preflight');
            pageDoc.body.innerHTML = '<article><p>Game Size: 7.1 GB</p></article>';
            const dlFetchDoc = async () => ({ doc: pageDoc });
            const openDownloadDetail = (${openDetailFunction});
            const pageChecks = new Map();
            ipcRenderer.invoke = (channel, args) => {
                assert.equal(channel, 'get-download-link-health');
                return new Promise(resolve => pageChecks.set(args.url, resolve));
            };
            const item = { name: 'Preflight fixture', url: 'https://steamrip.com/preflight/', reference: 'test-reference' };
            await openDownloadDetail('steamrip', item);
            await flushLookups();
            assert.equal(pageChecks.size, 2, 'both mirrors are checked when the page opens');
            const primary = document.querySelector('#ddpDownloadArea > .dl-ddl-btn');
            assert.equal(primary.disabled, true, 'one-click waits until a mirror can be selected');
            assert.ok(primary.textContent.includes('Checking download links'));
            assert.equal(startedDownloads.length, 0, 'preflights never start a download');
            pageChecks.get(buzzUrl)({ status: 'available', sizeLabel: '7.1 GB' });
            await flushLookups();
            assert.ok(primary.textContent.includes('1-Click') && primary.textContent.includes('buzzheavier.com'));
            assert.equal(primary.disabled, false, 'confirmed alternative becomes usable immediately');
            assert.equal(document.querySelector('#ddpDownloadArea > .download-set-size').textContent, 'Download size: 7.1 GB (host reported)');
            assert.ok(document.getElementById('ddpMeta').textContent.includes('Mirrorbuzzheavier.com'));
            primary.focus();
            const activeChoice = dlCurrent.primarySet;
            primary.click();
            assert.equal(startedDownloads.length, 1);
            assert.equal(startedDownloads[0].set.parts[0].url, buzzUrl, 'click uses the newly displayed mirror, not stale GoFile');
            updateDownloadLinkHealth(gofileUrl, 'steamrip', { status: 'down', reason: 'download-reported-offline' });
            pageChecks.get(gofileUrl)({ status: 'available' });
            await flushLookups();
            assert.equal(downloadLinkHealthState.get(downloadLinkHealthKey(gofileUrl, 'steamrip')).status, 'down', 'late preflight cannot erase fresher offline evidence');
            assert.equal(document.activeElement, primary, 'promotion updates the existing button without losing focus');
            assert.equal(startedDownloads[0].set, activeChoice, 'background selection does not change an existing download');
            const gofileRow = dlCurrent.primaryUi.rows.find(row => row._downloadSet.host === 'gofile.io');
            const buzzRow = dlCurrent.primaryUi.rows.find(row => row._downloadSet.host === 'buzzheavier.com');
            assert.equal(gofileRow.hidden, false);
            assert.equal(gofileRow.querySelector('button').disabled, true);
            assert.equal(buzzRow.hidden, true, 'primary mirror is not duplicated under alternatives');
            updateDownloadLinkHealth(buzzUrl, 'steamrip', { status: 'down' });
            assert.equal(primary.disabled, true);
            assert.ok(primary.textContent.includes('No working 1-click downloads found'));
            updateDownloadLinkHealth(gofileUrl, 'steamrip', { status: 'unknown' });
            assert.equal(primary.disabled, false, 'unconfirmed mirrors remain manually usable');
            assert.ok(primary.textContent.includes('unconfirmed') && !primary.textContent.includes('1-Click'));
            updateDownloadLinkHealth(buzzUrl, 'steamrip', { status: 'available', sizeBytes: 7 * 1024 ** 3 });
            assert.ok(primary.textContent.includes('buzzheavier.com'));
            updateDownloadLinkHealth(gofileUrl, 'steamrip', { status: 'available' });
            assert.equal(dlCurrent.primarySet.parts[0].url, buzzUrl, 'later high-priority success does not jump a working button');
            assert.equal(startedDownloads.length, 1, 'changing primary never auto-retries the failed download');

            sourceLinks = [{ url: 'https://datanodes.to/newpage123', label: 'DataNodes', type: 'web' }];
            await openDownloadDetail('steamrip', { ...item, url: 'https://steamrip.com/next-game/' });
            await flushLookups();
            const nextPrimary = document.querySelector('#ddpDownloadArea > .dl-ddl-btn');
            updateDownloadLinkHealth(buzzUrl, 'steamrip', { status: 'available', sizeLabel: '999 GB' });
            assert.equal(nextPrimary.disabled, true, 'old page results cannot select a mirror on the new page');
            assert.ok(!document.getElementById('ddpMeta').textContent.includes('999 GB'));
            pageChecks.get(sourceLinks[0].url)({ status: 'available', sizeLabel: '7.0 GB' });
            await flushLookups();
            assert.equal(nextPrimary.disabled, false);
            assert.ok(nextPrimary.textContent.includes('datanodes.to'));

            // A healthy AkiraBox result must not displace an unconfirmed direct
            // mirror, and remains manual even when every other mirror is down.
            const akiraUrl = 'https://akirabox.com/manual-only';
            const dataUrl = 'https://datanodes.to/akira-alternative';
            sourceLinks = [
                { url: akiraUrl, label: 'AkiraBox', type: 'web' },
                { url: dataUrl, label: 'DataNodes', type: 'web' }
            ];
            await openDownloadDetail('steamrip', { ...item, url: 'https://steamrip.com/manual-mirror-fixture/' });
            await flushLookups();
            const noAkiraPrimary = document.querySelector('#ddpDownloadArea > .dl-ddl-btn');
            pageChecks.get(akiraUrl)({ status: 'available' });
            await flushLookups();
            assert.equal(noAkiraPrimary.disabled, true, 'AkiraBox is not promoted while other mirrors are checking');
            pageChecks.get(dataUrl)({ status: 'verification-required', sizeLabel: '82.6 GB' });
            await flushLookups();
            assert.ok(noAkiraPrimary.textContent.includes('datanodes.to') && noAkiraPrimary.textContent.includes('unconfirmed'));
            assert.ok(document.getElementById('ddpMeta').textContent.includes('Mirrordatanodes.to'));
            const akiraRow = dlCurrent.primaryUi.rows.find(row => row._downloadSet.host === 'akirabox.com');
            assert.equal(akiraRow.hidden, false, 'AkiraBox remains listed for manual use');
            assert.ok(akiraRow.querySelector('button').textContent.includes('Open in Browser'));
            updateDownloadLinkHealth(dataUrl, 'steamrip', { status: 'down' });
            assert.equal(noAkiraPrimary.disabled, true, 'an offline alternative does not promote AkiraBox as a fallback');
            assert.equal(dlCurrent.primarySet, null);
            assert.ok(!noAkiraPrimary.textContent.includes('akirabox'));

            sourceLinks = [{ url: akiraUrl, label: 'AkiraBox', type: 'web' }];
            await openDownloadDetail('steamrip', { ...item, url: 'https://steamrip.com/only-manual-fixture/' });
            assert.equal(dlCurrent.primarySet, null);
            assert.equal(dlCurrent.primaryUi.button.disabled, true);
            assert.equal(dlCurrent.primaryUi.button.textContent, 'Choose a download option below');
            assert.equal(dlCurrent.primaryUi.rows[0].hidden, false);

            for (const finish of pageChecks.values()) finish({ status: 'unknown' });
            await flushLookups();
            pageChecks.clear();
            const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
            sourceLinks = [{ url: magnet, label: 'Magnet / Torrent', type: 'magnet' }];
            for (const host of ['filekeeper.net', 'fuckingfast.co', 'datanodes.to']) {
                for (let part = 0; part < 259; part++) sourceLinks.push({ url: 'https://' + host + '/fitgirl-part-' + part, label: host, type: 'web' });
            }
            DL_SOURCES.fitgirl = { name: 'FitGirl', color: '#ec4899', detail: () => sourceLinks };
            await openDownloadDetail('fitgirl', { ...item, url: 'https://fitgirl-repacks.site/fixture/' });
            await flushLookups();
            const fitgirlPrimary = dlCurrent.primaryUi.button;
            assert.equal(fitgirlPrimary.disabled, false);
            assert.ok(fitgirlPrimary.textContent.includes('1-Click') && fitgirlPrimary.textContent.includes('Magnet / Torrent'));
            assert.equal(dlCurrent.primarySet.parts[0].url, magnet);
            assert.equal(pageChecks.size, 4, 'large mirror sets retain the concurrency limit');
            const filekeeperRow = dlCurrent.primaryUi.rows.find(row => row._downloadSet.host === 'filekeeper.net');
            assert.ok(filekeeperRow.querySelector('.download-link-health').textContent.includes('0/259 checked'));
            pageChecks.get('https://filekeeper.net/fitgirl-part-0')({ status: 'available' });
            await flushLookups();
            assert.ok(filekeeperRow.querySelector('.download-link-health').textContent.includes('1/259 checked'));
            assert.equal(fitgirlPrimary.disabled, false);
            assert.equal(dlCurrent.primarySet.parts[0].url, magnet);
            return 'ok';
        })()`);
        assert.equal(result, 'ok');
        console.log('download-size-ui: PASS');
    } finally {
        if (!win.isDestroyed()) win.destroy();
    }
}

main().then(() => app.exit(0), error => {
    console.error('download-size-ui: FAIL', error && error.stack || error);
    app.exit(1);
});
