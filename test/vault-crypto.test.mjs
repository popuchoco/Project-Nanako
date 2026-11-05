import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  createVaultKeyEnvelope,
  decryptVaultMetadata,
  decryptVaultStream,
  deriveVaultObjectKey,
  encryptVaultMetadata,
  encryptVaultStream,
  unlockVaultMasterKey,
  VAULT_CHUNK_BYTES,
} from '../src/vault-crypto.mjs';

const PASSWORD = 'nanako-vault-passphrase-2026';

async function encryptBuffer(value, key, objectId) {
  const chunks = [];
  const destination = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  const result = await encryptVaultStream(Readable.from([value]), destination, { key, objectId });
  return { bytes: Buffer.concat(chunks), result };
}

async function decryptBuffer(value, key, objectId) {
  const output = [];
  for await (const chunk of decryptVaultStream(Readable.from([value]), { key, objectId })) output.push(chunk);
  return Buffer.concat(output);
}

test('vault password envelope wraps a random master key and binds it to the local user', async () => {
  const userId = randomUUID();
  const { envelope, masterKey } = await createVaultKeyEnvelope(PASSWORD, userId);
  const unlocked = await unlockVaultMasterKey(envelope, PASSWORD, userId);
  assert.deepEqual(unlocked, masterKey);
  assert.notEqual(envelope.wrap.ciphertext, masterKey.toString('base64url'));

  await assert.rejects(unlockVaultMasterKey(envelope, 'wrong-password-2026', userId), { code: 'vault_unlock_failed' });
  await assert.rejects(unlockVaultMasterKey(envelope, PASSWORD, randomUUID()), { code: 'vault_unlock_failed' });
  masterKey.fill(0); unlocked.fill(0);
});

test('vault key envelope rejects unsupported KDF parameters and malformed authentication data', async () => {
  const { envelope, masterKey } = await createVaultKeyEnvelope(PASSWORD, randomUUID());
  const edited = structuredClone(envelope);
  edited.kdf.N = 2 ** 25;
  await assert.rejects(unlockVaultMasterKey(edited, PASSWORD, randomUUID()), { code: 'invalid_vault_config' });
  const malformed = structuredClone(envelope);
  malformed.wrap.tag = 'not-base64url';
  await assert.rejects(unlockVaultMasterKey(malformed, PASSWORD, randomUUID()), { code: 'invalid_vault_config' });
  masterKey.fill(0);
});

test('vault object keys and metadata are separated by user and opaque object ID', async () => {
  const userId = randomUUID();
  const objectId = randomUUID();
  const otherObjectId = randomUUID();
  const masterKey = randomBytes(32);
  const objectKey = deriveVaultObjectKey(masterKey, userId, objectId);
  const otherKey = deriveVaultObjectKey(masterKey, userId, otherObjectId);
  const metadata = { name: '私人檔案名稱.txt', relativePath: '工作/私人檔案名稱.txt', size: 42 };
  const envelope = encryptVaultMetadata(metadata, masterKey, userId, objectId);
  assert.notEqual(envelope.ciphertext.includes('私人檔案名稱'), true);
  assert.deepEqual(decryptVaultMetadata(envelope, masterKey, userId, objectId), metadata);
  assert.notDeepEqual(objectKey, otherKey);
  assert.throws(() => decryptVaultMetadata(envelope, masterKey, randomUUID(), objectId), { code: 'vault_integrity_failed' });
  assert.throws(() => decryptVaultMetadata(envelope, masterKey, userId, otherObjectId), { code: 'vault_integrity_failed' });
  const tampered = { ...envelope, ciphertext: Buffer.from('altered').toString('base64url') };
  assert.throws(() => decryptVaultMetadata(tampered, masterKey, userId, objectId), { code: 'vault_integrity_failed' });
  objectKey.fill(0); otherKey.fill(0); masterKey.fill(0);
});

test('vault object stream encrypts multiple bounded chunks and round-trips binary bytes', async () => {
  const key = randomBytes(32);
  const objectId = randomUUID();
  const plaintext = randomBytes(VAULT_CHUNK_BYTES * 2 + 137);
  const { bytes, result } = await encryptBuffer(plaintext, key, objectId);
  assert.equal(result.plaintextBytes, plaintext.length);
  assert.equal(result.chunks, 3);
  assert.deepEqual(await decryptBuffer(bytes, key, objectId), plaintext);
  key.fill(0);
});

test('vault object stream handles empty content and authenticates its terminal record', async () => {
  const key = randomBytes(32);
  const objectId = randomUUID();
  const { bytes, result } = await encryptBuffer(Buffer.alloc(0), key, objectId);
  assert.deepEqual(result, { plaintextBytes: 0, chunks: 0 });
  assert.equal((await decryptBuffer(bytes, key, objectId)).length, 0);
  await assert.rejects(decryptBuffer(bytes.subarray(0, -1), key, objectId), { code: 'vault_truncated' });
  await assert.rejects(decryptBuffer(Buffer.concat([bytes, Buffer.from([1])]), key, objectId), { code: 'vault_trailing_data' });
  key.fill(0);
});

test('vault object stream fails closed for wrong keys, cross-object substitution and tampering', async () => {
  const key = randomBytes(32);
  const objectId = randomUUID();
  const { bytes } = await encryptBuffer(Buffer.from('驗證後才可讀取的內容'), key, objectId);
  const tampered = Buffer.from(bytes);
  tampered[16] ^= 0x40;
  await assert.rejects(decryptBuffer(tampered, key, objectId), { code: 'vault_integrity_failed' });
  await assert.rejects(decryptBuffer(bytes, randomBytes(32), objectId), { code: 'vault_integrity_failed' });
  await assert.rejects(decryptBuffer(bytes, key, randomUUID()), { code: 'vault_integrity_failed' });
  key.fill(0);
});

