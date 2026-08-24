'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const syncMigration = fs.readFileSync(
    path.join(root, 'supabase', 'migrations', '20260801010000_secure_sync_ownership_and_download_rpc.sql'),
    'utf8'
);
const downloadCounterMigration = fs.readFileSync(
    path.join(root, 'supabase', 'migrations', '20260801020000_secure_download_counter_advisor_cleanup.sql'),
    'utf8'
);
const restoredDownloadCounterMigration = fs.readFileSync(
    path.join(root, 'supabase', 'migrations', '20260823120534_restore_marketplace_download_counts.sql'),
    'utf8'
);

test('sync policies and artifacts require ownership of their parent profile', () => {
    assert.match(syncMigration, /drop policy if exists "Owners manage sync policies"/i);
    assert.match(syncMigration, /drop policy if exists "Owners manage sync artifacts"/i);
    assert.match(syncMigration, /on public\.sync_policies[\s\S]*?exists \([\s\S]*?from public\.launcher_profiles/i);
    assert.match(syncMigration, /on public\.sync_artifacts[\s\S]*?exists \([\s\S]*?from public\.launcher_profiles/i);
    assert.match(syncMigration, /libraries\.profile_id = public\.sync_artifacts\.profile_id/);
});

test('download counter history established signed-in deduplication before anonymous counting was restored', () => {
    assert.match(syncMigration, /create table if not exists public\.item_download_events/i);
    assert.match(syncMigration, /primary key \(item_id, user_id\)/i);
    assert.match(syncMigration, /if caller_id is null then/i);
    assert.match(syncMigration, /on conflict \(item_id, user_id\) do nothing/i);
    assert.match(syncMigration, /revoke execute on function public\.increment_downloads\(uuid\) from public, anon/i);
    assert.match(syncMigration, /grant execute on function public\.increment_downloads\(uuid\) to authenticated/i);
});

test('download counter follow-up denied direct event access and isolated privileged work', () => {
    assert.match(downloadCounterMigration, /create policy "No direct access to download events"/i);
    assert.match(downloadCounterMigration, /using \(false\)/i);
    assert.match(downloadCounterMigration, /with check \(false\)/i);
    assert.match(downloadCounterMigration, /create index if not exists item_download_events_user_idx/i);
    assert.match(downloadCounterMigration, /create schema if not exists private/i);
    assert.match(downloadCounterMigration, /create or replace function private\.increment_downloads\(item_id uuid\)[\s\S]*?security definer/i);
    assert.match(downloadCounterMigration, /create or replace function public\.increment_downloads\(item_id uuid\)[\s\S]*?security invoker/i);
    assert.match(downloadCounterMigration, /revoke execute on function private\.increment_downloads\(uuid\) from public, anon/i);
});

test('download counter restoration grants only the bounded RPC and returns the authoritative count', () => {
    assert.match(restoredDownloadCounterMigration, /create function private\.increment_downloads\(item_id uuid\)[\s\S]*?returns integer[\s\S]*?security invoker/i);
    assert.match(restoredDownloadCounterMigration, /on conflict on constraint item_download_events_pkey do nothing/i);
    assert.match(restoredDownloadCounterMigration, /least\(coalesce\(catalog_items\.downloads, 0\)::bigint \+ 1, 2147483647\)::integer/i);
    assert.match(restoredDownloadCounterMigration, /create function public\.increment_downloads\(item_id uuid\)[\s\S]*?returns integer[\s\S]*?security definer[\s\S]*?set search_path = ''/i);
    assert.match(restoredDownloadCounterMigration, /revoke all on function private\.increment_downloads\(uuid\) from public, anon, authenticated, service_role/i);
    assert.match(restoredDownloadCounterMigration, /grant execute on function public\.increment_downloads\(uuid\) to anon, authenticated, service_role/i);
});
