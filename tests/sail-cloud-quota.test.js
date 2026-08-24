'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
    path.join(root, 'supabase', 'migrations', '20260824050659_reduce_sail_cloud_quotas.sql'),
    'utf8'
);
const renderer = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const workerValidation = fs.readFileSync(path.join(root, 'cloudflare-worker', 'src', 'validation.js'), 'utf8');

test('Sail Cloud quota migration sets 50 MiB included and 500 MiB plus tiers', () => {
    assert.match(migration, /alter column quota_bytes set default 52428800/i);
    assert.match(migration, /when plan = 'plus' then 524288000[\s\S]*else 52428800/i);
    assert.match(migration, /check \(quota_bytes between 0 and 524288000\)/i);
    assert.doesNotMatch(migration, /delete\s+from\s+public\.sync_artifact_objects/i);
});

test('Account UI uses the new quota names', () => {
    assert.match(renderer, /Sail%20Cloud%20500%20MB%20upgrade/);
    assert.match(renderer, />Ask about the 500 MB upgrade<\/a>/);
    assert.match(renderer, /storage\.plan === 'plus' \? '500 MB upgrade' : 'included'/);
    assert.doesNotMatch(renderer, /Ask about the 1 GB upgrade/);
});

test('Worker keeps a 500 MB object ceiling for the 500 MB upgrade tier', () => {
    assert.match(workerValidation, /const ACCOUNT_OBJECT_MAX_BYTES = 500 \* 1024 \* 1024;/);
    assert.match(workerValidation, /sizeBytes > ACCOUNT_OBJECT_MAX_BYTES/);
    assert.match(workerValidation, /between 1 byte and 500 MB/);
});
