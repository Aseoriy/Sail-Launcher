const ACCOUNT_TYPES = new Set([
  'launcher-config',
  'library',
  'preset',
  'theme',
  'game-save',
  'game-config'
]);
const ACCOUNT_OBJECT_MAX_BYTES = 500 * 1024 * 1024;

const PACKAGE_TYPES = new Map([
  ['application/json', 'json'],
  ['application/zip', 'zip'],
  ['application/x-zip-compressed', 'zip'],
  ['application/x-rar-compressed', 'rar'],
  ['application/vnd.rar', 'rar'],
  ['application/x-7z-compressed', '7z'],
  ['application/octet-stream', null]
]);

const PREVIEW_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp']
]);

export function requireSha256(value) {
  const clean = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(clean)) throw new HttpError(400, 'A lowercase SHA-256 hash is required.');
  return clean;
}

export function requireUuid(value, name = 'ID') {
  const clean = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clean)) {
    throw new HttpError(400, `${name} is invalid.`);
  }
  return clean;
}

export function accountUpload(input = {}) {
  const artifactType = String(input.artifactType || '');
  const sizeBytes = Number(input.sizeBytes);
  const maxVersions = ['launcher-config', 'game-save', 'game-config'].includes(artifactType)
    ? Math.max(1, Math.min(Number(input.maxVersions) || 1, 5))
    : 1;
  if (!ACCOUNT_TYPES.has(artifactType)) throw new HttpError(400, 'Unsupported Sail Cloud artifact type.');
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > ACCOUNT_OBJECT_MAX_BYTES) {
    throw new HttpError(413, 'Sail Cloud objects must be between 1 byte and 500 MB.');
  }
  const logicalKey = String(input.logicalKey || '').trim().slice(0, 300);
  if (!logicalKey) throw new HttpError(400, 'A logical key is required.');
  return {
    profileId: requireUuid(input.profileId, 'Profile ID'),
    artifactType,
    logicalKey,
    sizeBytes,
    contentType: String(input.contentType || 'application/octet-stream').slice(0, 200),
    sha256: requireSha256(input.sha256),
    expectedRevision: Math.max(0, Number(input.expectedRevision) || 0),
    maxVersions,
    libraryId: input.libraryId ? requireUuid(input.libraryId, 'Library ID') : null,
    gameId: input.gameId ? requireUuid(input.gameId, 'Game ID') : null,
    configEntryId: input.configEntryId ? requireUuid(input.configEntryId, 'Configuration entry ID') : null
  };
}

export function hubUpload(input = {}) {
  const kind = input.kind === 'preview' ? 'preview' : input.kind === 'package' ? 'package' : '';
  if (!kind) throw new HttpError(400, 'Asset kind must be package or preview.');
  const sizeBytes = Number(input.sizeBytes);
  const limit = kind === 'preview' ? 5 * 1024 * 1024 : 100 * 1024 * 1024;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > limit) {
    throw new HttpError(413, `${kind === 'preview' ? 'Preview' : 'Package'} exceeds the ${limit / 1024 / 1024} MB limit.`);
  }
  const contentType = String(input.contentType || 'application/octet-stream').toLowerCase().slice(0, 200);
  const suppliedExtension = String(input.extension || '').replace(/^\./, '').toLowerCase();
  const allowed = kind === 'preview' ? PREVIEW_TYPES : PACKAGE_TYPES;
  if (!allowed.has(contentType)) throw new HttpError(415, `Unsupported ${kind} content type.`);
  const inferred = allowed.get(contentType);
  const extension = suppliedExtension || inferred;
  const extensions = kind === 'preview' ? ['png', 'jpg', 'jpeg', 'webp'] : ['json', 'zip', 'rar', '7z'];
  if (!extensions.includes(extension)) throw new HttpError(415, `Unsupported ${kind} file extension.`);
  return {
    itemId: requireUuid(input.itemId, 'Item ID'),
    kind,
    sizeBytes,
    contentType,
    sha256: requireSha256(input.sha256),
    extension
  };
}

export class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
