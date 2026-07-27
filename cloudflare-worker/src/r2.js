import { AwsClient } from 'aws4fetch';

function client(env) {
  return new AwsClient({
    service: 's3',
    region: 'auto',
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY
  });
}

function endpoint(env, bucket, key) {
  const path = String(key).split('/').map(encodeURIComponent).join('/');
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${path}`;
}

export function hexToBase64(hex) {
  const bytes = new Uint8Array(String(hex).match(/.{2}/g).map(value => Number.parseInt(value, 16)));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function bytesToBase64(value) {
  if (!value) return '';
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function presign(env, { bucket, key, method, contentType, sha256, expires }) {
  const url = new URL(endpoint(env, bucket, key));
  url.searchParams.set('X-Amz-Expires', String(expires));
  const headers = new Headers();
  if (contentType) headers.set('Content-Type', contentType);
  if (sha256) headers.set('x-amz-checksum-sha256', hexToBase64(sha256));
  const signed = await client(env).sign(new Request(url, { method, headers }), {
    aws: { signQuery: true }
  });
  return signed.url.toString();
}

export async function deleteKeys(bucket, keys) {
  const deleted = [];
  for (const key of keys || []) {
    await bucket.delete(key);
    deleted.push(key);
  }
  return deleted;
}

export async function purgePrefix(bucket, prefix) {
  let cursor;
  let deleted = 0;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map(object => object.key);
    if (keys.length) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
