'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    normalizeSyncConfidence,
    recordSyncConfidence,
    safeSyncErrorMessage,
    syncConfidenceStateForError
} = require('../sync/syncV2');
const {
    clearCompletedHistory,
    countActiveDownloadSlots,
    isBulkRetryableDownload,
    matchesDownloadSearch,
    planBulkRetry,
    removeCompletedQueueEntries,
    safeDownloadErrorMessage
} = require('../ui/downloadManagerLogic');
const mainSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'main.js'),
    'utf8'
);
const rendererSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'index.html'),
    'utf8'
);

test('sync confidence keeps the last successful time after a failed attempt', () => {
    const success = recordSyncConfidence({}, null, 'success', { timestamp: 1000 });
    const failed = recordSyncConfidence(success, null, 'failed', {
        timestamp: 2000,
        error: new Error('network timeout while contacting https://private.example/token')
    });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.lastSuccessfulAt, 1000);
    assert.equal(failed.lastFailedAt, 2000);
    assert.equal(failed.error, 'Offline or temporarily unavailable. Check your connection and try again.');
    assert.equal(syncConfidenceStateForError(new Error('ECONNRESET')), 'unavailable');
});

test('sync confidence supports syncing, success, failed, paused, and unavailable states per category', () => {
    let state = normalizeSyncConfidence({});
    state = recordSyncConfidence(state, 'saves', 'syncing', { timestamp: 10 });
    assert.equal(state.categories.saves.state, 'syncing');
    state = recordSyncConfidence(state, 'saves', 'success', { timestamp: 20 });
    assert.equal(state.categories.saves.lastSuccessfulAt, 20);
    state = recordSyncConfidence(state, 'saves', 'paused', { timestamp: 30 });
    assert.equal(state.categories.saves.state, 'paused');
    assert.equal(state.categories.saves.lastSuccessfulAt, 20);
    state = recordSyncConfidence(state, 'saves', 'unavailable', {
        timestamp: 40,
        error: 'The account service did not respond in time.'
    });
    assert.equal(state.categories.saves.state, 'unavailable');
    assert.equal(state.categories.saves.lastSuccessfulAt, 20);
    assert.equal(state.categories.saves.lastFailedAt, 40);
    assert.match(safeSyncErrorMessage('upload failed'), /upload failed/i);
});

test('bulk retry starts only retryable failed downloads within the concurrent limit', () => {
    const downloads = [
        { id: 'active', state: 'downloading' },
        { id: 'retry-one', state: 'error', resumeOpts: { id: 'retry-one' } },
        { id: 'retry-two', state: 'error', resumeOpts: { id: 'retry-two' } },
        { id: 'browser', state: 'error', resumeOpts: { id: 'browser' }, needsBrowser: true },
        { id: 'paused', state: 'paused', resumeOpts: { id: 'paused' } }
    ];
    assert.equal(countActiveDownloadSlots(downloads), 1);
    assert.equal(isBulkRetryableDownload(downloads[1]), true);
    assert.equal(isBulkRetryableDownload(downloads[3]), false);
    const plan = planBulkRetry(downloads, 2);
    assert.deepEqual(plan.start.map(item => item.id), ['retry-one']);
    assert.deepEqual(plan.queued.map(item => item.id), ['retry-two']);
    assert.deepEqual(plan.skipped.map(item => item.id), ['browser']);
});

test('bulk clear removes completed history and done queue rows only', () => {
    const history = [
        { id: 'completed-one' },
        { id: 'completed-two' }
    ];
    assert.deepEqual(clearCompletedHistory(history), []);
    const queue = [
        { id: 'done', state: 'done' },
        { id: 'active', state: 'downloading' },
        { id: 'paused', state: 'paused' },
        { id: 'failed', state: 'error' }
    ];
    assert.deepEqual(removeCompletedQueueEntries(queue).map(item => item.id), ['active', 'paused', 'failed']);
});

test('download search and error guidance avoid exposing private links or credentials', () => {
    assert.equal(matchesDownloadSearch({ name: 'Hades', category: 'game' }, 'hades'), true);
    assert.equal(matchesDownloadSearch({ name: 'Hades', category: 'game' }, 'mods'), false);
    const error = safeDownloadErrorMessage({
        error: 'GET https://private.example/file?access_token=secret failed at C:\\Users\\Me\\file.zip; Authorization: Bearer another-secret'
    });
    assert.doesNotMatch(error, /private\.example|secret|C:\\Users/i);

    const torboxError = safeDownloadErrorMessage({
        error: 'TorBox could not accept this file: network timeout.'
    });
    assert.match(torboxError, /^TorBox could not accept this file:/);
    assert.doesNotMatch(torboxError, /^The connection was interrupted/);
});

test('cloud save compression waits for the 7-Zip callback before checking the archive', () => {
    const handlerStart = mainSource.indexOf("ipcMain.handle('cloud-zip-folder'");
    const handlerEnd = mainSource.indexOf("ipcMain.handle('cloud-extract-zip'", handlerStart);
    assert.ok(handlerStart >= 0);
    assert.ok(handlerEnd > handlerStart);
    const handler = mainSource.slice(handlerStart, handlerEnd);
    assert.match(handler, /await new Promise\(\(resolve, reject\) =>/);
    assert.match(handler, /_7z\.cmd\([\s\S]*?\(error\) => error \? reject\(error\) : resolve\(\)/);
    assert.doesNotMatch(handler, /await _7z\.cmd\(/);
    assert.match(handler, /createCloudZipWithPowerShell\(localSavePath, zipPath\)/);
    assert.ok(
        handler.indexOf('createCloudZipWithPowerShell(localSavePath, zipPath)')
            < handler.indexOf('await new Promise((resolve, reject) =>'),
        'PowerShell compression should be attempted before the 7-Zip fallback'
    );
    assert.match(mainSource, /Get-ChildItem -LiteralPath \$source -Force/);
    assert.match(mainSource, /Compress-Archive -LiteralPath \$entries\.FullName/);
});

test('Sail Hub webview and account restore use persistent startup-safe storage', async () => {
    assert.match(rendererSource, /partition="persist:sailhub-mods"/);
    assert.match(mainSource, /session\.fromPartition\('persist:sailhub-mods'\)/);
    assert.match(rendererSource, /showContinuePlaying: true, showModsPage: true/);
    assert.match(rendererSource, /globalSettings\.showModsPage = true/);
    assert.match(mainSource, /onSailLauncherProtocol: handleProtocolUrl/);
    assert.match(mainSource, /const SAIL_HUB_MODS_ORIGIN = SAIL_WEBSITE_URL/);
    assert.match(mainSource, /client\.auth\.setSession\(launcherSession\)/);
    assert.match(mainSource, /onSessionChanged: notifySailHubGuestAuthChange/);

    const { AccountService } = require('../accounts/accountService');
    const service = Object.create(AccountService.prototype);
    let ready = false;
    let calls = 0;
    service.storage = {
        isEncryptionAvailable: () => ready,
        waitForEncryption: async () => {
            ready = true;
            return true;
        }
    };
    service.client = {
        auth: {
            getSession: async () => ({ data: { session: calls++ === 0 ? null : { user: { id: 'restored-session' } } } })
        }
    };
    const session = await service.session();
    assert.equal(session.user.id, 'restored-session');
    assert.equal(calls, 2);
});

test('account page can force selected local categories through existing Sail Cloud flows', () => {
    assert.match(rendererSource, /id="accountReplaceLauncherFiles"/);
    assert.match(rendererSource, /id="accountReplaceGameSaves"/);
    assert.match(rendererSource, /class="account-cloud-replace-options"/);
    assert.match(rendererSource, /class="account-cloud-replace-option"/);
    assert.match(rendererSource, /class="account-actions account-cloud-replace-actions"/);
    assert.match(rendererSource, /id="accountSyncToggleButton"/);
    assert.match(rendererSource, /window\.toggleAccountSyncOnThisPc/);
    assert.match(rendererSource, /accountSyncToggleButton\.textContent = syncPaused \? 'Resume Syncing' : 'Pause on This PC'/);
    assert.match(rendererSource, /accountSyncPausedPulse/);
    assert.match(rendererSource, /window\.replaceSailCloudWithLocal/);
    assert.match(rendererSource, /syncConfigToCloud\('replace', \{ replaceCloud: true \}\)/);
    assert.match(rendererSource, /syncLocalAccountControlPlane\(true, \{ force: true \}\)/);
    assert.match(rendererSource, /uploadAllLinkedGameSavesToSailCloud\(\{ force: true, replaceExisting: true \}\)/);
    assert.match(rendererSource, /const maxVersions = replaceExisting \? 1/);
    assert.match(rendererSource, /replaceExisting\s*\?\s*1/);
});
