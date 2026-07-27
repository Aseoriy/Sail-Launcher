const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sha256 } = require('../accounts/sailCloud');

const root = path.join(__dirname, '..');

test('signed-in launcher data uses Sail Cloud with opt-in game saves', () => {
    const renderer = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(renderer, /artifactType:\s*'launcher-config'/);
    assert.match(renderer, /artifactType:\s*'game-config'/);
    assert.match(renderer, /artifactType:\s*'game-save'/);
    assert.match(renderer, /artifactType:\s*'theme'/);
    assert.match(renderer, /accountUiState\.signedIn && category !== 'saves'/);
    assert.match(renderer, /selectedSyncProviders\('saves'/);
    assert.match(renderer, /id="sailCloudGameSaveToggle"/);
    assert.match(renderer, /role="switch"/);
    assert.match(renderer, /Sync game saves to Sail Cloud/);
    assert.match(renderer, /id="sailCloudGameSaveGames"/);
    assert.match(renderer, /Games using Sail Cloud/);
    assert.match(renderer, /id="sailCloudSingleSaveCopyToggle"/);
    assert.match(renderer, /Keep only 1 Sail Cloud copy per game/);
    assert.match(renderer, /maxVersions:\s*sailCloudGameSaveMaxVersions\(\)/);
    assert.match(renderer, /Existing uploaded copies remain until you delete them/);
    assert.match(renderer, /setSailCloudGameSaveSelection/);
    assert.match(renderer, /sailCloudExcludedGameSaveKeys/);
    assert.match(renderer, /sailCloudGameSaveEnabledFor\(game\)/);
    assert.match(renderer, /your quota will fill up faster then usual/);
    assert.match(renderer, /uploadAllLinkedGameSavesToSailCloud\(\{ force: true \}\)/);
    assert.match(renderer, /if \(accountUiState\.signedIn\) queueSailCloudGameSaveBackfillIfNeeded\(\)/);
    assert.match(renderer, /allLinkedGames\.filter\(game => sailCloudGameSaveEnabledFor\(game\)\)/);
    assert.match(renderer, /account-cloud-list-files/);
    assert.match(renderer, /existingSaveKeys\.has\(sailCloudGameSaveKey\(game\)\)/);
    assert.match(renderer, /Uploading linked game saves \$\{index \+ 1\} of \$\{pendingGames\.length\}/);
    assert.match(renderer, /Initial Sail Cloud game-save upload finished/);
    assert.match(renderer, /await refreshSailCloudStorage\(false\)/);
    assert.match(renderer, /id="accountImportGameSavesButton"/);
    assert.match(renderer, /id="accountGameSaveImportModal"/);
    assert.match(renderer, /openSailCloudGameSaveImport/);
    assert.match(renderer, /useConfiguredSailCloudSaveDestinations/);
    assert.match(renderer, /importSelectedSailCloudGameSaves/);
    assert.match(renderer, /account-cloud-download-file/);
    assert.match(renderer, /dialog-select-folder/);
    assert.match(renderer, /zip-save-to-drive/);
    assert.match(renderer, /cloud-extract-zip/);
    assert.match(renderer, /makePortableSnapshot\(\{ myGames, customSections, globalSettings \}\)/);
});

test('Sail Hub packages and previews no longer write to Supabase Storage', () => {
    for (const name of ['plugins.html', 'item.html', 'manage-account.html']) {
        const html = fs.readFileSync(path.join(root, 'Website', 'Main', name), 'utf8');
        assert.doesNotMatch(html, /storage\.from\(['"](?:files|previews)['"]\)\.upload/);
        assert.match(html, /SailHubAssets\.(?:stage|remove)/);
    }
    const helper = fs.readFileSync(path.join(root, 'Website', 'Main', 'sail-cloud-assets.js'), 'utf8');
    assert.match(helper, /storage-api\.sailhub\.fyi/);
    assert.match(helper, /crypto\.subtle\.digest\('SHA-256'/);
    assert.match(helper, /\/v1\/hub-assets\/migrate-legacy/);
    const listing = fs.readFileSync(path.join(root, 'Website', 'Main', 'plugins.html'), 'utf8');
    assert.match(listing, /ownedLegacyItems/);
    assert.match(listing, /SailHubAssets\.migrateLegacy/);
});

test('Sail Cloud SHA-256 is deterministic', () => {
    assert.equal(
        sha256(Buffer.from('sail-cloud')),
        'd5ec49b938557703e7a6c1bd371a03030c941189606061d06c672c96e6473a98'
    );
});

test('account deletion fails closed until private and public R2 prefixes are purged', () => {
    const source = fs.readFileSync(
        path.join(root, 'supabase', 'functions', 'account-delete', 'index.ts'),
        'utf8'
    );
    const purgeAt = source.indexOf('/v1/internal/purge-user');
    const deleteAt = source.indexOf('admin.auth.admin.deleteUser');
    assert.ok(purgeAt > 0);
    assert.ok(deleteAt > purgeAt);
    assert.match(source, /Your account was not deleted/);
});

test('external save-provider status survives a temporary Sail Cloud outage', () => {
    const source = fs.readFileSync(path.join(root, 'accounts', 'accountService.js'), 'utf8');
    const statusCall = source.indexOf('storage = await this.sailCloud.status()');
    const unavailable = source.indexOf('unavailable: true', statusCall);
    const connectionResult = source.indexOf('connections: connections.data || []', unavailable);
    assert.ok(statusCall > 0);
    assert.ok(unavailable > statusCall);
    assert.ok(connectionResult > unavailable);
});

test('Sail Cloud storage can be refreshed, inspected, and deleted safely', () => {
    const renderer = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'accounts', 'sailCloud.js'), 'utf8');
    const worker = fs.readFileSync(path.join(root, 'cloudflare-worker', 'src', 'index.js'), 'utf8');
    assert.match(renderer, /refreshSailCloudStorage/);
    assert.match(renderer, /View Uploaded Files/);
    assert.match(renderer, /Delete "\$\{label\}" from Sail Cloud/);
    const fileRenderer = renderer.slice(
        renderer.indexOf('function renderSailCloudFiles'),
        renderer.indexOf('function renderAccountUi')
    );
    assert.match(fileRenderer, /escapeHtml\(label\)/);
    assert.match(fileRenderer, /escapeHtml\(message\)/);
    assert.doesNotMatch(fileRenderer, /\besc\(/);
    assert.match(renderer, /value < 1024 \* 1024/);
    assert.match(client, /\/v1\/account-storage\/files/);
    assert.match(client, /deleteArtifact/);
    const objectDelete = worker.indexOf('await deleteKeys(env.ACCOUNT_BUCKET');
    const metadataDelete = worker.indexOf("serviceWrite(env, 'sync_artifacts'", objectDelete);
    assert.ok(objectDelete > 0);
    assert.ok(metadataDelete > objectDelete);
});

test('cloud provider secret fields stay inside their cards', () => {
    const renderer = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(renderer, /\.sail-secret-field[\s\S]*max-width:\s*100%/);
    assert.match(renderer, /\.sail-secret-field > input[\s\S]*box-sizing:\s*border-box/);
    assert.match(renderer, /mediafire-credentials-row/);
});
