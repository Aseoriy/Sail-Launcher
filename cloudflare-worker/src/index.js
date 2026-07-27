import { accountUpload, hubUpload, HttpError, requireUuid } from './validation.js';
import { authenticate, rpc, selectRows, serviceWrite } from './supabase.js';
import { bytesToBase64, deleteKeys, hexToBase64, presign, purgePrefix } from './r2.js';

export const LEGACY_HUB_STORAGE_CLEANUP_AT = Date.parse('2026-08-03T05:50:00.000Z');

const LEGACY_HUB_STORAGE_OBJECTS = Object.freeze({
  files: Object.freeze([
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1777324490062_My Custom Theme.json',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1777332074893_hw-monitor.rar',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1777332843628_edit_hw-monitor.rar',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1777333115723_edit_hw-monitor.rar',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1777333963533_edit_hw-monitor.rar',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1777610436624_edit_hw-monitor.7z',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1782047276227_Candy Theme.json',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1783393644895_edit_Candy Theme.json',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1784782516348_edit_hw-monitor.zip'
  ]),
  previews: Object.freeze([
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1777324490062_Sail_Launcher_550xtVKe7W.png',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1777332074893_Sail_Launcher_SqnY1BJw7z.png',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1782047276227_Sail_Launcher_jZRw8N9XbR.jpg',
    '69e49da2-c41a-44f9-a6f3-3d0b7eb82580/1783393644895_edit_Sail_Launcher_FDOfbclXyJ.jpg'
  ])
});

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
});

function cors(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '7200',
    Vary: 'Origin'
  };
}

async function bodyOf(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'A JSON request body is required.'); }
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function accountStatus(request, env, user) {
  return firstRow(await rpc(env, 'sail_storage_status', { p_user_id: user.id }));
}

async function reserveAccount(request, env, user) {
  const input = accountUpload(await bodyOf(request));
  const row = firstRow(await rpc(env, 'reserve_sail_account_upload', {
    p_user_id: user.id,
    p_profile_id: input.profileId,
    p_artifact_type: input.artifactType,
    p_logical_key: input.logicalKey,
    p_size_bytes: input.sizeBytes,
    p_content_type: input.contentType,
    p_sha256: input.sha256,
    p_expected_revision: input.expectedRevision,
    p_max_versions: input.maxVersions,
    p_library_id: input.libraryId,
    p_game_id: input.gameId,
    p_config_entry_id: input.configEntryId
  }));
  return {
    ...row,
    upload_url: await presign(env, {
      bucket: env.ACCOUNT_BUCKET_NAME,
      key: row.object_key,
      method: 'PUT',
      contentType: input.contentType,
      sha256: input.sha256,
      expires: 900
    }),
    upload_headers: {
      'Content-Type': input.contentType,
      'x-amz-checksum-sha256': hexToBase64(input.sha256)
    }
  };
}

async function completeAccount(request, env, user, reservationId) {
  requireUuid(reservationId, 'Reservation ID');
  const body = await bodyOf(request);
  const reservations = await selectRows(
    env,
    'storage_upload_reservations',
    `select=object_key,size_bytes,sha256,content_type,status&user_id=eq.${user.id}&id=eq.${reservationId}&scope=eq.account&limit=1`
  );
  const reservation = reservations[0];
  if (!reservation) throw new HttpError(404, 'Upload reservation was not found.');
  const object = await env.ACCOUNT_BUCKET.head(reservation.object_key);
  if (!object) throw new HttpError(409, 'The R2 upload has not finished.');
  if (object.size !== Number(reservation.size_bytes)) {
    await env.ACCOUNT_BUCKET.delete(reservation.object_key);
    await rpc(env, 'cancel_sail_upload', { p_user_id: user.id, p_reservation_id: reservationId });
    throw new HttpError(422, 'Uploaded byte count did not match the reservation.');
  }
  const uploadedSha = bytesToBase64(object.checksums?.sha256);
  if (uploadedSha !== hexToBase64(reservation.sha256) || body.sha256 !== reservation.sha256) {
    await env.ACCOUNT_BUCKET.delete(reservation.object_key);
    await rpc(env, 'cancel_sail_upload', { p_user_id: user.id, p_reservation_id: reservationId });
    throw new HttpError(422, 'Uploaded SHA-256 did not match the reservation.');
  }
  const result = firstRow(await rpc(env, 'commit_sail_account_upload', {
    p_user_id: user.id,
    p_reservation_id: reservationId,
    p_etag: object.etag || ''
  }));
  const deleted = await deleteKeys(env.ACCOUNT_BUCKET, result.delete_keys);
  if (deleted.length) {
    await rpc(env, 'mark_sail_objects_deleted', { p_user_id: user.id, p_object_keys: deleted });
  }
  return result;
}

async function accountDownload(request, env, user, artifactId) {
  requireUuid(artifactId, 'Artifact ID');
  const input = await bodyOf(request);
  const revision = Number(input.revision);
  const revisionFilter = Number.isSafeInteger(revision) && revision > 0
    ? `&revision=eq.${revision}`
    : '';
  const rows = await selectRows(
    env,
    'sync_artifact_objects',
    `select=id,artifact_id,object_key,revision,size_bytes,content_type,sha256,created_at&user_id=eq.${user.id}&artifact_id=eq.${artifactId}&deleted_at=is.null${revisionFilter}&order=revision.desc&limit=1`
  );
  const object = rows[0];
  if (!object) throw new HttpError(404, 'Cloud artifact was not found.');
  return {
    ...object,
    download_url: await presign(env, {
      bucket: env.ACCOUNT_BUCKET_NAME,
      key: object.object_key,
      method: 'GET',
      expires: 300
    })
  };
}

async function accountVersions(env, user, artifactId) {
  requireUuid(artifactId, 'Artifact ID');
  return selectRows(
    env,
    'sync_artifact_objects',
    `select=id,artifact_id,revision,size_bytes,content_type,sha256,state,created_at&user_id=eq.${user.id}&artifact_id=eq.${artifactId}&deleted_at=is.null&order=revision.desc`
  );
}

async function accountFiles(env, user) {
  const [artifacts, objects] = await Promise.all([
    selectRows(
      env,
      'sync_artifacts',
      `select=id,profile_id,artifact_type,logical_key,revision,updated_at&user_id=eq.${user.id}&order=updated_at.desc&limit=500`
    ),
    selectRows(
      env,
      'sync_artifact_objects',
      `select=artifact_id,revision,size_bytes,content_type,sha256,created_at&user_id=eq.${user.id}&state=eq.active&deleted_at=is.null&order=created_at.desc&limit=2500`
    )
  ]);
  const versionsByArtifact = new Map();
  for (const object of objects) {
    if (!versionsByArtifact.has(object.artifact_id)) versionsByArtifact.set(object.artifact_id, []);
    versionsByArtifact.get(object.artifact_id).push(object);
  }
  return artifacts.flatMap(artifact => {
    const versions = versionsByArtifact.get(artifact.id) || [];
    if (!versions.length) return [];
    return [{
      ...artifact,
      size_bytes: versions.reduce((total, version) => total + Number(version.size_bytes || 0), 0),
      version_count: versions.length,
      latest_created_at: versions[0].created_at,
      latest_content_type: versions[0].content_type,
      latest_sha256: versions[0].sha256
    }];
  });
}

async function deleteAccountArtifact(env, user, artifactId) {
  requireUuid(artifactId, 'Artifact ID');
  const artifacts = await selectRows(
    env,
    'sync_artifacts',
    `select=id&user_id=eq.${user.id}&id=eq.${artifactId}&limit=1`
  );
  if (!artifacts.length) throw new HttpError(404, 'Cloud artifact was not found.');
  const objects = await selectRows(
    env,
    'sync_artifact_objects',
    `select=object_key,size_bytes&user_id=eq.${user.id}&artifact_id=eq.${artifactId}&deleted_at=is.null`
  );
  await deleteKeys(env.ACCOUNT_BUCKET, objects.map(row => row.object_key));
  await serviceWrite(env, 'sync_artifacts', {
    method: 'DELETE',
    query: `id=eq.${artifactId}&user_id=eq.${user.id}`,
    prefer: 'return=minimal'
  });
  return {
    deleted: true,
    objects_deleted: objects.length,
    bytes_deleted: objects.reduce((total, row) => total + Number(row.size_bytes || 0), 0)
  };
}

async function deleteProfile(env, user, profileId) {
  requireUuid(profileId, 'Profile ID');
  const profiles = await selectRows(env, 'launcher_profiles', `select=id&user_id=eq.${user.id}&id=eq.${profileId}&limit=1`);
  if (!profiles.length) throw new HttpError(404, 'Launcher profile was not found.');
  const artifacts = await selectRows(env, 'sync_artifacts', `select=id&user_id=eq.${user.id}&profile_id=eq.${profileId}`);
  const ids = artifacts.map(row => row.id);
  if (ids.length) {
    const encoded = encodeURIComponent(`(${ids.join(',')})`);
    const objects = await selectRows(env, 'sync_artifact_objects', `select=object_key&user_id=eq.${user.id}&artifact_id=in.${encoded}&deleted_at=is.null`);
    await deleteKeys(env.ACCOUNT_BUCKET, objects.map(row => row.object_key));
  }
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/launcher_profiles?id=eq.${profileId}&user_id=eq.${user.id}`, {
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal'
    }
  });
  if (!response.ok) throw new HttpError(500, 'Unable to remove the launcher profile metadata.');
  return { deleted: true, objects_deleted: ids.length };
}

async function reserveHub(request, env, user) {
  const input = hubUpload(await bodyOf(request));
  const row = firstRow(await rpc(env, 'reserve_sail_hub_upload', {
    p_user_id: user.id,
    p_item_id: input.itemId,
    p_kind: input.kind,
    p_size_bytes: input.sizeBytes,
    p_content_type: input.contentType,
    p_sha256: input.sha256,
    p_extension: input.extension
  }));
  return {
    ...row,
    upload_url: await presign(env, {
      bucket: env.HUB_BUCKET_NAME,
      key: row.object_key,
      method: 'PUT',
      contentType: input.contentType,
      sha256: input.sha256,
      expires: 900
    }),
    upload_headers: {
      'Content-Type': input.contentType,
      'x-amz-checksum-sha256': hexToBase64(input.sha256)
    }
  };
}

async function completeHub(request, env, user, reservationId) {
  requireUuid(reservationId, 'Reservation ID');
  const body = await bodyOf(request);
  const rows = await selectRows(
    env,
    'storage_upload_reservations',
    `select=object_key,size_bytes,sha256&user_id=eq.${user.id}&id=eq.${reservationId}&scope=eq.hub&limit=1`
  );
  const reservation = rows[0];
  if (!reservation) throw new HttpError(404, 'Upload reservation was not found.');
  const object = await env.HUB_BUCKET.head(reservation.object_key);
  if (!object) throw new HttpError(409, 'The R2 upload has not finished.');
  if (
    object.size !== Number(reservation.size_bytes)
    || bytesToBase64(object.checksums?.sha256) !== hexToBase64(reservation.sha256)
    || body.sha256 !== reservation.sha256
  ) {
    await env.HUB_BUCKET.delete(reservation.object_key);
    await rpc(env, 'cancel_sail_upload', { p_user_id: user.id, p_reservation_id: reservationId });
    throw new HttpError(422, 'The uploaded Sail Hub asset did not match its reservation.');
  }
  const result = firstRow(await rpc(env, 'commit_sail_hub_upload', {
    p_user_id: user.id,
    p_reservation_id: reservationId,
    p_etag: object.etag || ''
  }));
  const deleted = await deleteKeys(env.HUB_BUCKET, result.delete_keys);
  if (deleted.length) {
    await rpc(env, 'mark_sail_hub_objects_deleted', { p_user_id: user.id, p_object_keys: deleted });
  }
  return result;
}

async function deleteHubAssets(env, user, itemId, kind) {
  requireUuid(itemId, 'Item ID');
  if (!['package', 'preview'].includes(kind)) throw new HttpError(400, 'Asset kind is invalid.');
  const items = await selectRows(env, 'items', `select=id&author_id=eq.${user.id}&id=eq.${itemId}&limit=1`);
  if (!items.length) throw new HttpError(404, 'Sail Hub item was not found.');
  const rows = await selectRows(
    env,
    'hub_asset_objects',
    `select=object_key&user_id=eq.${user.id}&item_id=eq.${itemId}&kind=eq.${kind}&deleted_at=is.null`
  );
  await deleteKeys(env.HUB_BUCKET, rows.map(row => row.object_key));
  return { deleted: rows.length };
}

function legacyAsset(url, expectedBucket) {
  if (!url) return null;
  const parsed = new URL(url);
  const prefix = `/storage/v1/object/public/${expectedBucket}/`;
  if (parsed.origin !== 'https://vglpzpffejwgttlqrums.supabase.co' || !parsed.pathname.startsWith(prefix)) {
    return null;
  }
  return parsed;
}

async function migrateLegacyHubAssets(env, user, itemId) {
  requireUuid(itemId, 'Item ID');
  const rows = await selectRows(
    env,
    'items',
    `select=id,author_id,file_url,preview_url&author_id=eq.${user.id}&id=eq.${itemId}&limit=1`
  );
  const item = rows[0];
  if (!item) throw new HttpError(404, 'Sail Hub item was not found.');
  const migrated = {};
  for (const [kind, bucketName, column] of [
    ['package', 'files', 'file_url'],
    ['preview', 'previews', 'preview_url']
  ]) {
    const source = legacyAsset(item[column], bucketName);
    if (!source) continue;
    const response = await fetch(source);
    if (!response.ok) throw new HttpError(502, `Unable to read the legacy ${kind}.`);
    const bytes = await response.arrayBuffer();
    const limit = kind === 'package' ? 100 * 1024 * 1024 : 5 * 1024 * 1024;
    if (!bytes.byteLength || bytes.byteLength > limit) throw new HttpError(413, `Legacy ${kind} is outside the supported size limit.`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    const sourceName = decodeURIComponent(source.pathname.split('/').pop() || '');
    const extension = (sourceName.split('.').pop() || (kind === 'preview' ? 'png' : 'zip'))
      .toLowerCase().replace(/[^a-z0-9]/g, '');
    const versionId = crypto.randomUUID();
    const objectKey = `authors/${user.id}/items/${itemId}/${versionId}/${kind}.${extension}`;
    const publicUrl = `${env.HUB_PUBLIC_ORIGIN}/${objectKey}`;
    const contentType = response.headers.get('Content-Type')?.split(';')[0]
      || (kind === 'preview' ? 'image/png' : 'application/octet-stream');
    const object = await env.HUB_BUCKET.put(objectKey, bytes, {
      httpMetadata: {
        contentType,
        cacheControl: 'public, max-age=31536000, immutable'
      },
      customMetadata: { sha256: sha, migratedFrom: bucketName }
    });
    await serviceWrite(env, 'hub_asset_objects', {
      body: {
        item_id: itemId,
        user_id: user.id,
        kind,
        version_id: versionId,
        object_key: objectKey,
        public_url: publicUrl,
        size_bytes: bytes.byteLength,
        content_type: contentType,
        sha256: sha,
        etag: object.etag,
        active: true
      }
    });
    await serviceWrite(env, 'items', {
      method: 'PATCH',
      query: `id=eq.${itemId}&author_id=eq.${user.id}`,
      body: { [column]: publicUrl },
      prefer: 'return=minimal'
    });
    migrated[kind] = { url: publicUrl, size_bytes: bytes.byteLength, sha256: sha };
  }
  return { item_id: itemId, migrated };
}

async function purgeUser(request, env) {
  const body = await bodyOf(request);
  const userId = requireUuid(body.userId, 'User ID');
  const suppliedSecret = request.headers.get('X-Sail-Internal-Secret');
  if (!suppliedSecret || suppliedSecret !== env.INTERNAL_PURGE_SECRET) {
    const user = await authenticate(request, env);
    if (user.id !== userId) throw new HttpError(403, 'You may only purge your own Sail Cloud data.');
  }
  const [account, hub] = await Promise.all([
    purgePrefix(env.ACCOUNT_BUCKET, `users/${userId}/`),
    purgePrefix(env.HUB_BUCKET, `authors/${userId}/`)
  ]);
  return { purged: true, account_objects: account, hub_objects: hub };
}

async function legacyStorageRequest(env, path, options = {}) {
  const response = await fetch(`${env.SUPABASE_URL}/storage/v1${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body
  });
  if (!response.ok) {
    throw new Error(`Supabase legacy storage cleanup failed (${response.status}).`);
  }
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

export async function cleanupLegacyHubStorage(env, now = Date.now()) {
  if (now < LEGACY_HUB_STORAGE_CLEANUP_AT) {
    return { pending: true, cleanup_at: new Date(LEGACY_HUB_STORAGE_CLEANUP_AT).toISOString() };
  }

  const items = await selectRows(env, 'items', 'select=file_url,preview_url');
  if ((items || []).some(item =>
    legacyAsset(item.file_url, 'files') || legacyAsset(item.preview_url, 'previews')
  )) {
    return { pending: true, blocked: 'legacy-references-remain' };
  }

  let removed = 0;
  for (const [bucket, prefixes] of Object.entries(LEGACY_HUB_STORAGE_OBJECTS)) {
    const current = await legacyStorageRequest(env, `/bucket/${bucket}`);
    if (current?.public === false) continue;
    await legacyStorageRequest(env, `/object/${bucket}`, {
      method: 'DELETE',
      body: { prefixes }
    });
    await legacyStorageRequest(env, `/bucket/${bucket}`, {
      method: 'PUT',
      body: { id: bucket, name: bucket, public: false }
    });
    removed += prefixes.length;
  }
  return { pending: false, removed, buckets_private: true };
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const headers = cors(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (path === '/health') return json({ ok: true, service: 'sail-cloud-storage' }, 200, headers);

  try {
    if (path === '/v1/internal/purge-user' && request.method === 'POST') {
      return json(await purgeUser(request, env), 200, headers);
    }
    const user = await authenticate(request, env);
    if (path === '/v1/account-storage/status' && request.method === 'GET') {
      return json(await accountStatus(request, env, user), 200, headers);
    }
    if (path === '/v1/account-storage/files' && request.method === 'GET') {
      return json(await accountFiles(env, user), 200, headers);
    }
    if (path === '/v1/account-storage/uploads' && request.method === 'POST') {
      return json(await reserveAccount(request, env, user), 201, headers);
    }
    let match = path.match(/^\/v1\/account-storage\/uploads\/([^/]+)\/complete$/);
    if (match && request.method === 'POST') return json(await completeAccount(request, env, user, match[1]), 200, headers);
    match = path.match(/^\/v1\/account-storage\/artifacts\/([^/]+)\/download$/);
    if (match && request.method === 'POST') return json(await accountDownload(request, env, user, match[1]), 200, headers);
    match = path.match(/^\/v1\/account-storage\/artifacts\/([^/]+)\/versions$/);
    if (match && request.method === 'GET') return json(await accountVersions(env, user, match[1]), 200, headers);
    match = path.match(/^\/v1\/account-storage\/artifacts\/([^/]+)$/);
    if (match && request.method === 'DELETE') return json(await deleteAccountArtifact(env, user, match[1]), 200, headers);
    match = path.match(/^\/v1\/account-storage\/profiles\/([^/]+)$/);
    if (match && request.method === 'DELETE') return json(await deleteProfile(env, user, match[1]), 200, headers);
    if (path === '/v1/hub-assets/uploads' && request.method === 'POST') {
      return json(await reserveHub(request, env, user), 201, headers);
    }
    if (path === '/v1/hub-assets/migrate-legacy' && request.method === 'POST') {
      const body = await bodyOf(request);
      return json(await migrateLegacyHubAssets(env, user, body.itemId), 200, headers);
    }
    match = path.match(/^\/v1\/hub-assets\/uploads\/([^/]+)\/complete$/);
    if (match && request.method === 'POST') return json(await completeHub(request, env, user, match[1]), 200, headers);
    match = path.match(/^\/v1\/hub-assets\/items\/([^/]+)\/(package|preview)$/);
    if (match && request.method === 'DELETE') return json(await deleteHubAssets(env, user, match[1], match[2]), 200, headers);
    throw new HttpError(404, 'Endpoint not found.');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);
    return json({
      error: error instanceof Error ? error.message : 'Unexpected storage error.',
      code: error instanceof HttpError ? error.code : null
    }, status, headers);
  }
}

export default {
  fetch: handle,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const expired = await rpc(env, 'expire_sail_upload_reservations', {});
      const accountKeys = (expired || []).filter(row => row.scope === 'account').map(row => row.object_key);
      const hubKeys = (expired || []).filter(row => row.scope === 'hub').map(row => row.object_key);
      await Promise.all([
        deleteKeys(env.ACCOUNT_BUCKET, accountKeys),
        deleteKeys(env.HUB_BUCKET, hubKeys)
      ]);
      await cleanupLegacyHubStorage(env);
    })());
  }
};
