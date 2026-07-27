import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupLegacyHubStorage,
  handle,
  LEGACY_HUB_STORAGE_CLEANUP_AT
} from '../src/index.js';

test('health endpoint is public and does not expose bindings', async () => {
  const response = await handle(new Request('https://storage-api.sailhub.fyi/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'sail-cloud-storage' });
});

test('account storage endpoints require a Sail bearer token', async () => {
  const response = await handle(
    new Request('https://storage-api.sailhub.fyi/v1/account-storage/status'),
    { ALLOWED_ORIGINS: '' }
  );
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Sign in/);
});

test('unknown authenticated API paths fail closed', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('/auth/v1/user')) {
      return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const response = await handle(
      new Request('https://storage-api.sailhub.fyi/v1/not-real', {
        headers: { Authorization: 'Bearer test-session' }
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'publishable',
        ALLOWED_ORIGINS: ''
      }
    );
    assert.equal(response.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account file listing groups retained versions by artifact', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) {
      return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    }
    if (target.includes('/rest/v1/sync_artifacts?')) {
      return Response.json([{
        id: '22222222-2222-4222-8222-222222222222',
        profile_id: '33333333-3333-4333-8333-333333333333',
        artifact_type: 'game-save',
        logical_key: 'game-save:demo',
        revision: 2,
        updated_at: '2026-07-27T00:00:00Z'
      }]);
    }
    if (target.includes('/rest/v1/sync_artifact_objects?')) {
      return Response.json([
        {
          artifact_id: '22222222-2222-4222-8222-222222222222',
          revision: 2,
          size_bytes: 2048,
          content_type: 'application/zip',
          sha256: 'a'.repeat(64),
          created_at: '2026-07-27T00:00:00Z'
        },
        {
          artifact_id: '22222222-2222-4222-8222-222222222222',
          revision: 1,
          size_bytes: 1024,
          content_type: 'application/zip',
          sha256: 'b'.repeat(64),
          created_at: '2026-07-26T00:00:00Z'
        }
      ]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const response = await handle(
      new Request('https://storage-api.sailhub.fyi/v1/account-storage/files', {
        headers: { Authorization: 'Bearer test-session' }
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'publishable',
        SUPABASE_SERVICE_ROLE_KEY: 'service',
        ALLOWED_ORIGINS: ''
      }
    );
    assert.equal(response.status, 200);
    const files = await response.json();
    assert.equal(files.length, 1);
    assert.equal(files[0].size_bytes, 3072);
    assert.equal(files[0].version_count, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account artifact deletion removes R2 objects before metadata', async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) {
      return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    }
    if (target.includes('/rest/v1/sync_artifacts?') && options.method !== 'DELETE') {
      return Response.json([{ id: '22222222-2222-4222-8222-222222222222' }]);
    }
    if (target.includes('/rest/v1/sync_artifact_objects?')) {
      return Response.json([{ object_key: 'users/test/file.bin', size_bytes: 4096 }]);
    }
    if (target.includes('/rest/v1/sync_artifacts?') && options.method === 'DELETE') {
      events.push('metadata');
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const response = await handle(
      new Request('https://storage-api.sailhub.fyi/v1/account-storage/artifacts/22222222-2222-4222-8222-222222222222', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-session' }
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'publishable',
        SUPABASE_SERVICE_ROLE_KEY: 'service',
        ACCOUNT_BUCKET: {
          async delete(key) {
            events.push(`r2:${key}`);
          }
        },
        ALLOWED_ORIGINS: ''
      }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      deleted: true,
      objects_deleted: 1,
      bytes_deleted: 4096
    });
    assert.deepEqual(events, ['r2:users/test/file.bin', 'metadata']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy Supabase Hub cleanup respects the seven-day rollback window', async () => {
  const originalFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    throw new Error('Cleanup must not access the network before its deadline.');
  };
  try {
    const result = await cleanupLegacyHubStorage({}, LEGACY_HUB_STORAGE_CLEANUP_AT - 1);
    assert.equal(result.pending, true);
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy Supabase Hub cleanup fails safe while an item still references it', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async url => {
    requests += 1;
    if (String(url).includes('/rest/v1/items')) {
      return Response.json([{
        file_url: 'https://vglpzpffejwgttlqrums.supabase.co/storage/v1/object/public/files/user/package.zip',
        preview_url: null
      }]);
    }
    throw new Error(`Unexpected destructive request: ${url}`);
  };
  try {
    const result = await cleanupLegacyHubStorage({
      SUPABASE_URL: 'https://vglpzpffejwgttlqrums.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key'
    }, LEGACY_HUB_STORAGE_CLEANUP_AT);
    assert.deepEqual(result, { pending: true, blocked: 'legacy-references-remain' });
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
