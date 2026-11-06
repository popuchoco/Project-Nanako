import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  clearThrottle,
  ensureThrottleSchema,
  getThrottle,
  pruneExpiredThrottles,
  recordFailure,
  THROTTLE_FAILURE_LIMIT,
  THROTTLE_WINDOW_MS,
} from '../src/throttle-store.mjs';

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  ensureThrottleSchema(db);
  return db;
}

test('throttle schema is safe to initialize repeatedly', () => {
  const db = createDatabase();
  assert.doesNotThrow(() => ensureThrottleSchema(db));
  assert.deepEqual(db.prepare('PRAGMA table_info(request_throttles)').all().map((column) => column.name), [
    'kind', 'throttle_key', 'failure_count', 'window_started_at', 'locked_until', 'updated_at',
  ]);
  db.close();
});

test('login throttle expires its failure window and clear removes the key', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 10, 6);
  for (let index = 0; index < THROTTLE_FAILURE_LIMIT; index += 1) recordFailure(db, 'login', 'source\0admin', now);
  assert.deepEqual(getThrottle(db, 'login', 'source\0admin', now), {
    count: THROTTLE_FAILURE_LIMIT,
    windowStartedAt: now,
    lockedUntil: now + THROTTLE_WINDOW_MS,
    updatedAt: now,
  });
  assert.equal(getThrottle(db, 'login', 'source\0admin', now + THROTTLE_WINDOW_MS), null);
  recordFailure(db, 'login', 'source\0admin', now + THROTTLE_WINDOW_MS);
  clearThrottle(db, 'login', 'source\0admin');
  assert.equal(getThrottle(db, 'login', 'source\0admin', now + THROTTLE_WINDOW_MS), null);
  db.close();
});

test('vault throttle resets the count at lockout and expires the lock', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 10, 6);
  for (let index = 0; index < THROTTLE_FAILURE_LIMIT; index += 1) recordFailure(db, 'vault_unlock', 'source\0user-id', now);
  assert.deepEqual(getThrottle(db, 'vault_unlock', 'source\0user-id', now), {
    count: 0,
    windowStartedAt: now,
    lockedUntil: now + THROTTLE_WINDOW_MS,
    updatedAt: now,
  });
  assert.equal(getThrottle(db, 'vault_unlock', 'source\0user-id', now + THROTTLE_WINDOW_MS), null);
  db.close();
});

test('unexpired throttle rows survive reopening the SQLite database', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nanako-throttle-test-'));
  const databasePath = path.join(directory, 'metadata.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.UTC(2026, 10, 6);
  let db = new DatabaseSync(databasePath);
  ensureThrottleSchema(db);
  for (let index = 0; index < THROTTLE_FAILURE_LIMIT; index += 1) recordFailure(db, 'login', 'source\0admin', now);
  db.close();

  db = new DatabaseSync(databasePath);
  ensureThrottleSchema(db);
  assert.equal(getThrottle(db, 'login', 'source\0admin', now).lockedUntil, now + THROTTLE_WINDOW_MS);
  db.close();
});

test('login and vault throttles use separate rows for the same key', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 10, 6);
  recordFailure(db, 'login', 'source\0admin', now);
  recordFailure(db, 'vault_unlock', 'source\0admin', now);
  assert.equal(getThrottle(db, 'login', 'source\0admin', now).count, 1);
  assert.equal(getThrottle(db, 'vault_unlock', 'source\0admin', now).count, 1);
  db.close();
});

test('throttle pruning deletes expired rows and caps retained rows at 4096', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 10, 6);
  const insert = db.prepare(`
    INSERT INTO request_throttles(kind, throttle_key, failure_count, window_started_at, locked_until, updated_at)
    VALUES(?, ?, 1, ?, 0, ?)
  `);
  insert.run('login', 'expired-login', now - THROTTLE_WINDOW_MS, now - THROTTLE_WINDOW_MS);
  insert.run('vault_unlock', 'expired-vault', now - THROTTLE_WINDOW_MS, now - THROTTLE_WINDOW_MS);
  for (let index = 0; index < 4100; index += 1) insert.run('login', `active-${index}`, now, now);

  pruneExpiredThrottles(db, now);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n), 4096);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles WHERE throttle_key LIKE \'expired-%\'').get().n), 0);
  db.close();
});
