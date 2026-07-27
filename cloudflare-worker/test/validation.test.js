import test from 'node:test';
import assert from 'node:assert/strict';
import { accountUpload, hubUpload, requireUuid } from '../src/validation.js';
import { hexToBase64 } from '../src/r2.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const sha = 'a'.repeat(64);

test('account uploads enforce routing types, size, and retention', () => {
  const value = accountUpload({
    profileId: uuid,
    artifactType: 'launcher-config',
    logicalKey: 'profile/settings',
    sizeBytes: 1024,
    contentType: 'application/json',
    sha256: sha,
    maxVersions: 99
  });
  assert.equal(value.maxVersions, 5);
  const save = accountUpload({ ...value, artifactType: 'game-save', maxVersions: 99 });
  assert.equal(save.maxVersions, 5);
  assert.throws(() => accountUpload({ ...value, artifactType: 'not-a-real-type' }), /Unsupported/);
  assert.throws(() => accountUpload({ ...value, sizeBytes: 500 * 1024 * 1024 + 1 }), /500 MB/);
});

test('hub uploads preserve current package and preview limits', () => {
  assert.equal(hubUpload({
    itemId: uuid, kind: 'package', sizeBytes: 100 * 1024 * 1024,
    contentType: 'application/zip', sha256: sha
  }).extension, 'zip');
  assert.equal(hubUpload({
    itemId: uuid, kind: 'preview', sizeBytes: 5 * 1024 * 1024,
    contentType: 'image/webp', sha256: sha
  }).extension, 'webp');
  assert.throws(() => hubUpload({
    itemId: uuid, kind: 'preview', sizeBytes: 5 * 1024 * 1024 + 1,
    contentType: 'image/webp', sha256: sha
  }), /5 MB/);
});

test('UUID validation rejects path injection', () => {
  assert.equal(requireUuid(uuid), uuid);
  assert.throws(() => requireUuid('../other-user'), /invalid/);
});

test('R2 checksum header is the base64 form of SHA-256 bytes', () => {
  assert.equal(hexToBase64('00'.repeat(32)), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
});
