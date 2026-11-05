import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const VAULT_CHUNK_BYTES = 128 * 1024;
// Continue reading 1 MiB records written by earlier v1 development builds.
const VAULT_MAX_CHUNK_BYTES = 1024 * 1024;
export const VAULT_FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const NONCE_PREFIX_BYTES = 4;
const TAG_BYTES = 16;
const MAGIC = Buffer.from('NKVLT01\0', 'ascii');
const KDF = Object.freeze({ name: 'scrypt', N: 32_768, r: 8, p: 1 });
const KDF_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function vaultError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw vaultError('invalid_vault_identifier', `${label}不正確。`);
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw vaultError('invalid_vault_key', '加密金鑰格式不正確。');
}

function deriveSubkey(masterKey, userId, objectId, purpose) {
  assertKey(masterKey);
  assertUuid(userId, '使用者識別碼');
  assertUuid(objectId, '物件識別碼');
  if (!['content', 'metadata'].includes(purpose)) throw vaultError('invalid_vault_purpose', '加密用途不正確。');
  return Buffer.from(hkdfSync(
    'sha256',
    masterKey,
    Buffer.from(`Project Nanako vault user v${VAULT_FORMAT_VERSION}:${userId}`, 'utf8'),
    Buffer.from(`Project Nanako vault ${purpose} v${VAULT_FORMAT_VERSION}:${objectId}`, 'utf8'),
    KEY_BYTES,
  ));
}

/** Derive an independent key per immutable object; do not reuse a file key for another object. */
export function deriveVaultObjectKey(masterKey, userId, objectId) {
  return deriveSubkey(masterKey, userId, objectId, 'content');
}

function aadForMetadata(userId, objectId) {
  return Buffer.from(`Project Nanako vault metadata v${VAULT_FORMAT_VERSION}:${userId}:${objectId}`, 'utf8');
}

/** Encrypt names and other sensitive index fields; only the opaque object ID stays in SQLite. */
export function encryptVaultMetadata(value, masterKey, userId, objectId) {
  const metadataKey = deriveSubkey(masterKey, userId, objectId, 'metadata');
  try {
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    if (plaintext.length > 64 * 1024) throw vaultError('vault_metadata_too_large', '加密空間中繼資料過大。');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', metadataKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadForMetadata(userId, objectId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      formatVersion: VAULT_FORMAT_VERSION,
      nonce: encodeBase64Url(nonce),
      ciphertext: encodeBase64Url(ciphertext),
      tag: encodeBase64Url(cipher.getAuthTag()),
    };
  } finally {
    metadataKey.fill(0);
  }
}

/** Verify and decrypt metadata only for the owning user and object. */
export function decryptVaultMetadata(envelope, masterKey, userId, objectId) {
  if (!envelope || envelope.formatVersion !== VAULT_FORMAT_VERSION) throw vaultError('invalid_vault_config', '加密空間中繼資料格式不支援。');
  const nonce = decodeBase64Url(envelope.nonce, NONCE_BYTES, '中繼資料 nonce');
  const ciphertext = decodeBase64Url(envelope.ciphertext, null, '加密中繼資料', 64 * 1024);
  const tag = decodeBase64Url(envelope.tag, TAG_BYTES, '中繼資料驗證標記');
  const metadataKey = deriveSubkey(masterKey, userId, objectId, 'metadata');
  try {
    const decipher = createDecipheriv('aes-256-gcm', metadataKey, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadForMetadata(userId, objectId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > 64 * 1024) throw vaultError('invalid_vault_config', '加密空間中繼資料過大。');
    try {
      const value = JSON.parse(plaintext.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid metadata');
      return value;
    } catch {
      throw vaultError('invalid_vault_config', '加密空間中繼資料已損毀。');
    }
  } catch (error) {
    if (error.code === 'invalid_vault_config') throw error;
    throw vaultError('vault_integrity_failed', '加密空間中繼資料驗證失敗。');
  } finally {
    metadataKey.fill(0);
  }
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw vaultError('invalid_vault_password', '加密空間密碼需為 12 至 256 個字元。');
  }
}

function aadForEnvelope(userId) {
  return Buffer.from(`Project Nanako vault key envelope v${VAULT_FORMAT_VERSION}:${userId}`, 'utf8');
}

function aadForRecoveryEnvelope(userId) {
  return Buffer.from(`Project Nanako vault recovery envelope v${VAULT_FORMAT_VERSION}:${userId}`, 'utf8');
}

function encodeBase64Url(value) { return value.toString('base64url'); }

function decodeBase64Url(value, expectedBytes, label, maximumBytes = expectedBytes) {
  if (typeof value !== 'string' || (maximumBytes !== null && value.length > Math.ceil(maximumBytes * 4 / 3) + 4)
    || !/^[A-Za-z0-9_-]+$/u.test(value)) throw vaultError('invalid_vault_config', `${label}格式不正確。`);
  const decoded = Buffer.from(value, 'base64url');
  if ((expectedBytes !== null && decoded.length !== expectedBytes) || decoded.length > maximumBytes || decoded.toString('base64url') !== value) throw vaultError('invalid_vault_config', `${label}格式不正確。`);
  return decoded;
}

async function deriveWrappingKey(password, salt) {
  return scrypt(password, salt, KEY_BYTES, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: KDF_MAX_MEMORY_BYTES,
  });
}

function recoveryCodeBytes(recoveryCode) {
  if (typeof recoveryCode !== 'string') throw vaultError('invalid_recovery_code', '復原金鑰格式不正確。');
  const normalized = recoveryCode.replace(/[\s-]/gu, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw vaultError('invalid_recovery_code', '復原金鑰格式不正確。');
  return normalized;
}

/** Generate a one-time, 256-bit recovery key. Display it once and never persist the plaintext. */
export function createVaultRecoveryCode() {
  return randomBytes(32).toString('hex');
}

/** Wrap the existing master key under an independent recovery key. */
export async function createVaultRecoveryEnvelope(recoveryCode, masterKey, userId) {
  const secret = recoveryCodeBytes(recoveryCode);
  assertKey(masterKey);
  assertUuid(userId, '使用者識別碼');
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  let wrappingKey;
  try {
    wrappingKey = await deriveWrappingKey(secret, salt);
    const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadForRecoveryEnvelope(userId));
    const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
    return {
      formatVersion: VAULT_FORMAT_VERSION,
      kdf: { ...KDF, salt: encodeBase64Url(salt) },
      wrap: {
        cipher: 'aes-256-gcm',
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(ciphertext),
        tag: encodeBase64Url(cipher.getAuthTag()),
      },
    };
  } finally { wrappingKey?.fill(0); }
}

/** Unlock the same master key using the separately stored recovery envelope. */
export async function unlockVaultWithRecoveryCode(envelope, recoveryCode, userId) {
  const secret = recoveryCodeBytes(recoveryCode);
  assertUuid(userId, '使用者識別碼');
  if (!envelope || envelope.formatVersion !== VAULT_FORMAT_VERSION
    || envelope.kdf?.name !== KDF.name || envelope.kdf.N !== KDF.N || envelope.kdf.r !== KDF.r || envelope.kdf.p !== KDF.p
    || envelope.wrap?.cipher !== 'aes-256-gcm') {
    throw vaultError('invalid_vault_config', '加密空間復原金鑰資料格式不支援或已損毀。');
  }
  const salt = decodeBase64Url(envelope.kdf.salt, SALT_BYTES, '復原金鑰鹽值');
  const nonce = decodeBase64Url(envelope.wrap.nonce, NONCE_BYTES, '復原金鑰包覆 nonce');
  const ciphertext = decodeBase64Url(envelope.wrap.ciphertext, KEY_BYTES, '復原包覆金鑰');
  const tag = decodeBase64Url(envelope.wrap.tag, TAG_BYTES, '復原金鑰驗證標記');
  const wrappingKey = await deriveWrappingKey(secret, salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadForRecoveryEnvelope(userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw vaultError('vault_recovery_failed', '復原金鑰不正確，或加密空間復原資料已損毀。');
  } finally { wrappingKey.fill(0); }
}

async function wrapMasterKey(password, masterKey, userId) {
  assertPassword(password);
  assertKey(masterKey);
  assertUuid(userId, '使用者識別碼');
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  let wrappingKey;
  try {
    wrappingKey = await deriveWrappingKey(password, salt);
    const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadForEnvelope(userId));
    const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
    const envelope = {
      formatVersion: VAULT_FORMAT_VERSION,
      kdf: { ...KDF, salt: encodeBase64Url(salt) },
      wrap: {
        cipher: 'aes-256-gcm',
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(ciphertext),
        tag: encodeBase64Url(cipher.getAuthTag()),
      },
    };
    return envelope;
  } finally { wrappingKey?.fill(0); }
}

/** Create a password-wrapped random vault master key. Caller must clear masterKey after locking. */
export async function createVaultKeyEnvelope(password, userId) {
  const masterKey = randomBytes(KEY_BYTES);
  try { return { envelope: await wrapMasterKey(password, masterKey, userId), masterKey }; }
  catch (error) { masterKey.fill(0); throw error; }
}

/** Re-wrap an existing master key with a new password without re-encrypting vault objects. */
export async function rewrapVaultMasterKey(password, masterKey, userId) {
  return wrapMasterKey(password, masterKey, userId);
}

/** Unlock a master key only for the user identity bound into its authenticated envelope. */
export async function unlockVaultMasterKey(envelope, password, userId) {
  assertPassword(password);
  assertUuid(userId, '使用者識別碼');
  if (!envelope || envelope.formatVersion !== VAULT_FORMAT_VERSION
    || envelope.kdf?.name !== KDF.name || envelope.kdf.N !== KDF.N || envelope.kdf.r !== KDF.r || envelope.kdf.p !== KDF.p
    || envelope.wrap?.cipher !== 'aes-256-gcm') {
    throw vaultError('invalid_vault_config', '加密空間格式不支援或已損毀。');
  }
  const salt = decodeBase64Url(envelope.kdf.salt, SALT_BYTES, '金鑰鹽值');
  const nonce = decodeBase64Url(envelope.wrap.nonce, NONCE_BYTES, '金鑰包覆 nonce');
  const ciphertext = decodeBase64Url(envelope.wrap.ciphertext, KEY_BYTES, '包覆金鑰');
  const tag = decodeBase64Url(envelope.wrap.tag, TAG_BYTES, '金鑰驗證標記');
  const wrappingKey = await deriveWrappingKey(password, salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadForEnvelope(userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw vaultError('vault_unlock_failed', '密碼不正確，或加密空間金鑰資料已損毀。');
  } finally {
    wrappingKey.fill(0);
  }
}

function nonceFor(prefix, counter) {
  const nonce = Buffer.alloc(NONCE_BYTES);
  prefix.copy(nonce, 0);
  nonce.writeBigUInt64BE(counter, NONCE_PREFIX_BYTES);
  return nonce;
}

function aadForChunk(objectId, prefix, counter, length) {
  const context = Buffer.from(`Project Nanako vault object v${VAULT_FORMAT_VERSION}:${objectId}`, 'utf8');
  const fields = Buffer.alloc(NONCE_PREFIX_BYTES + 8 + 4);
  prefix.copy(fields, 0);
  fields.writeBigUInt64BE(counter, NONCE_PREFIX_BYTES);
  fields.writeUInt32BE(length, NONCE_PREFIX_BYTES + 8);
  return Buffer.concat([context, fields]);
}

async function writeChunk(destination, value) {
  await new Promise((resolve, reject) => {
    destination.write(value, (error) => error ? reject(error) : resolve());
  });
}

async function encryptRecord(destination, key, objectId, prefix, counter, plaintext) {
  const length = plaintext.length;
  const cipher = createCipheriv('aes-256-gcm', key, nonceFor(prefix, counter), { authTagLength: TAG_BYTES });
  cipher.setAAD(aadForChunk(objectId, prefix, counter, length));
  const recordHeader = Buffer.alloc(4);
  recordHeader.writeUInt32BE(length);
  await writeChunk(destination, recordHeader);
  const ciphertext = cipher.update(plaintext);
  if (ciphertext.length) await writeChunk(destination, ciphertext);
  const final = cipher.final();
  if (final.length) await writeChunk(destination, final);
  await writeChunk(destination, cipher.getAuthTag());
}

/**
 * Encrypt an AsyncIterable/Readable into a Writable using independent authenticated chunks.
 * The caller owns both streams and must discard a partially written destination on errors.
 */
export async function encryptVaultStream(source, destination, { key, objectId }) {
  assertKey(key);
  assertUuid(objectId, '物件識別碼');
  const prefix = randomBytes(NONCE_PREFIX_BYTES);
  await writeChunk(destination, Buffer.concat([MAGIC, prefix]));

  // Reuse a fixed-size staging buffer. Repeated Buffer.concat on each incoming
  // stream chunk creates quadratic transient allocations for large files.
  const pending = Buffer.allocUnsafe(VAULT_CHUNK_BYTES);
  let pendingLength = 0;
  let counter = 0n;
  let plaintextBytes = 0;
  for await (const value of source) {
    const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(VAULT_CHUNK_BYTES - pendingLength, input.length - offset);
      input.copy(pending, pendingLength, offset, offset + take);
      pendingLength += take;
      offset += take;
      if (pendingLength === VAULT_CHUNK_BYTES) {
        if (counter === 0xffff_ffff_ffff_ffffn) throw vaultError('vault_stream_too_large', '加密空間物件超過格式容量上限。');
        await encryptRecord(destination, key, objectId, prefix, counter, pending);
        plaintextBytes += pendingLength;
        counter += 1n;
        pendingLength = 0;
      }
    }
  }
  if (pendingLength > 0) {
    await encryptRecord(destination, key, objectId, prefix, counter, pending.subarray(0, pendingLength));
    plaintextBytes += pendingLength;
    counter += 1n;
  }
  // An authenticated empty terminal record detects both truncation and trailing data.
  await encryptRecord(destination, key, objectId, prefix, counter, Buffer.alloc(0));
  return { plaintextBytes, chunks: Number(counter) };
}

class AsyncByteReader {
  constructor(source) {
    this.iterator = source[Symbol.asyncIterator]();
    this.chunks = [];
    this.bufferedBytes = 0;
    this.ended = false;
  }

  async readExactly(length) {
    while (this.bufferedBytes < length && !this.ended) {
      const { value, done } = await this.iterator.next();
      if (done) { this.ended = true; break; }
      const next = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (next.length) {
        this.chunks.push(next);
        this.bufferedBytes += next.length;
      }
    }
    if (this.bufferedBytes < length) throw vaultError('vault_truncated', '加密空間物件不完整。');
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const head = this.chunks[0];
      const take = Math.min(head.length, length - written);
      head.copy(result, written, 0, take);
      written += take;
      this.bufferedBytes -= take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    return result;
  }

  async assertEnd() {
    if (this.bufferedBytes) throw vaultError('vault_trailing_data', '加密空間物件包含多餘資料。');
    while (!this.ended) {
      const { value, done } = await this.iterator.next();
      this.ended = done;
      if (!done && Buffer.from(value).length) throw vaultError('vault_trailing_data', '加密空間物件包含多餘資料。');
    }
  }
}

/** Yield plaintext only after each individual chunk's GCM tag has been verified. */
export async function* decryptVaultStream(source, { key, objectId }) {
  assertKey(key);
  assertUuid(objectId, '物件識別碼');
  const reader = new AsyncByteReader(source);
  const header = await reader.readExactly(MAGIC.length + NONCE_PREFIX_BYTES);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw vaultError('vault_format_invalid', '加密空間物件格式不支援。');
  const prefix = header.subarray(MAGIC.length);
  let counter = 0n;
  let sawTerminal = false;
  while (!sawTerminal) {
    const recordHeader = await reader.readExactly(4);
    const length = recordHeader.readUInt32BE(0);
    if (length > VAULT_MAX_CHUNK_BYTES) throw vaultError('vault_format_invalid', '加密空間物件區塊大小不正確。');
    const ciphertext = await reader.readExactly(length);
    const tag = await reader.readExactly(TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(prefix, counter), { authTagLength: TAG_BYTES });
      decipher.setAAD(aadForChunk(objectId, prefix, counter, length));
      decipher.setAuthTag(tag);
      const plaintext = decipher.update(ciphertext);
      decipher.final();
      if (length === 0) sawTerminal = true;
      else yield plaintext;
    } catch {
      throw vaultError('vault_integrity_failed', '加密空間物件驗證失敗，內容可能已損毀或遭到修改。');
    }
    if (counter === 0xffff_ffff_ffff_ffffn && !sawTerminal) throw vaultError('vault_stream_too_large', '加密空間物件超過格式容量上限。');
    counter += 1n;
  }
  await reader.assertEnd();
}
