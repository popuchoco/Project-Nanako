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
  ThrottleCapacityError,
  THROTTLE_FAILURE_LIMIT,
  THROTTLE_WINDOW_MS,
} from '../src/throttle-store.mjs';

const SMALL_THROTTLE_CAP = { maxRows: 8, pruneThreshold: 0 };

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

test('an active login lockout survives expiration of its original failure window', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 10, 6);
  recordFailure(db, 'login', 'source\0admin', now, { maxRows: 1, pruneThreshold: 0 });
  for (let index = 1; index < THROTTLE_FAILURE_LIMIT; index += 1) {
    recordFailure(db, 'login', 'source\0admin', now + THROTTLE_WINDOW_MS - 1, { maxRows: 1, pruneThreshold: 0 });
  }

  const stillLocked = getThrottle(db, 'login', 'source\0admin', now + THROTTLE_WINDOW_MS, { maxRows: 1, pruneThreshold: 0 });
  assert.equal(stillLocked.lockedUntil, now + (2 * THROTTLE_WINDOW_MS) - 1);
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

test('throttle pruning clears expired rows and retains active lockouts even above the cap', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 10, 6);
  const insert = db.prepare(`
    INSERT INTO request_throttles(kind, throttle_key, failure_count, window_started_at, locked_until, updated_at)
    VALUES(?, ?, ?, ?, ?, ?)
  `);
  insert.run('login', 'expired-login', 1, now - THROTTLE_WINDOW_MS, 0, now - THROTTLE_WINDOW_MS);
  insert.run('vault_unlock', 'expired-vault', 0, now - THROTTLE_WINDOW_MS, now, now - THROTTLE_WINDOW_MS);
  for (let index = 0; index < 10; index += 1) {
    const kind = index % 2 === 0 ? 'login' : 'vault_unlock';
    const count = kind === 'login' ? THROTTLE_FAILURE_LIMIT : 0;
    const windowStartedAt = kind === 'login' ? now - THROTTLE_WINDOW_MS : now;
    insert.run(kind, `active-${index}`, count, windowStartedAt, now + THROTTLE_WINDOW_MS, now + index);
  }

  pruneExpiredThrottles(db, now, SMALL_THROTTLE_CAP);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n), 10);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles WHERE throttle_key LIKE \'expired-%\'').get().n), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles WHERE locked_until > ?').get(now).n), 10);
  db.close();
});

test('throttle pruning reclaims the oldest non-lockout rows before active lockouts', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 10, 6);
  const insert = db.prepare(`
    INSERT INTO request_throttles(kind, throttle_key, failure_count, window_started_at, locked_until, updated_at)
    VALUES('login', ?, 1, ?, 0, ?)
  `);
  for (let index = 0; index < 10; index += 1) insert.run(`unlocked-${index}`, now, now + index);
  pruneExpiredThrottles(db, now, SMALL_THROTTLE_CAP);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n), SMALL_THROTTLE_CAP.maxRows);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles WHERE throttle_key IN (?, ?)').get('unlocked-0', 'unlocked-1').n), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles WHERE throttle_key = ?').get('unlocked-9').n), 1);
  db.close();
});

test('flooding distinct throttle keys cannot evict active login or vault lockouts', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 10, 6);
  for (let index = 0; index < THROTTLE_FAILURE_LIMIT; index += 1) {
    recordFailure(db, 'login', 'active-login', now, SMALL_THROTTLE_CAP);
    recordFailure(db, 'vault_unlock', 'active-vault', now, SMALL_THROTTLE_CAP);
  }

  for (let index = 0; index < 24; index += 1) {
    const kind = index % 2 === 0 ? 'login' : 'vault_unlock';
    try {
      recordFailure(db, kind, `flood-${index}`, now, SMALL_THROTTLE_CAP);
    } catch (error) {
      assert.ok(error instanceof ThrottleCapacityError);
    }
  }
  assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n) <= SMALL_THROTTLE_CAP.maxRows);
  assert.equal(getThrottle(db, 'login', 'active-login', now, SMALL_THROTTLE_CAP).lockedUntil, now + THROTTLE_WINDOW_MS);
  assert.equal(getThrottle(db, 'vault_unlock', 'active-vault', now, SMALL_THROTTLE_CAP).lockedUntil, now + THROTTLE_WINDOW_MS);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles WHERE throttle_key IN (?, ?)').get('active-login', 'active-vault').n), 2);
  db.close();
});

test('a full table of active lockouts rejects new keys but preserves existing-key access', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 10, 6);
  for (let index = 0; index < SMALL_THROTTLE_CAP.maxRows; index += 1) {
    const kind = index % 2 === 0 ? 'login' : 'vault_unlock';
    for (let attempt = 0; attempt < THROTTLE_FAILURE_LIMIT; attempt += 1) {
      recordFailure(db, kind, `locked-${index}`, now, SMALL_THROTTLE_CAP);
    }
  }

  assert.throws(
    () => recordFailure(db, 'login', 'new-login', now, SMALL_THROTTLE_CAP),
    ThrottleCapacityError,
  );
  assert.throws(
    () => recordFailure(db, 'vault_unlock', 'new-vault', now, SMALL_THROTTLE_CAP),
    ThrottleCapacityError,
  );
  const existing = getThrottle(db, 'login', 'locked-0', now, SMALL_THROTTLE_CAP);
  assert.equal(existing.lockedUntil, now + THROTTLE_WINDOW_MS);
  assert.doesNotThrow(() => recordFailure(db, 'login', 'locked-0', now + 1, SMALL_THROTTLE_CAP));
  assert.equal(getThrottle(db, 'login', 'locked-0', now + 1, SMALL_THROTTLE_CAP).lockedUntil, now + 1 + THROTTLE_WINDOW_MS);
  db.close();
});

test('expired lockouts free capped rows for new throttle keys', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 10, 6);
  for (let index = 0; index < SMALL_THROTTLE_CAP.maxRows; index += 1) {
    const kind = index % 2 === 0 ? 'login' : 'vault_unlock';
    for (let attempt = 0; attempt < THROTTLE_FAILURE_LIMIT; attempt += 1) {
      recordFailure(db, kind, `locked-${index}`, now, SMALL_THROTTLE_CAP);
    }
  }

  const afterExpiry = now + THROTTLE_WINDOW_MS;
  const result = recordFailure(db, 'login', 'new-after-expiry', afterExpiry, SMALL_THROTTLE_CAP);
  assert.equal(result.count, 1);
  assert.equal(getThrottle(db, 'login', 'new-after-expiry', afterExpiry, SMALL_THROTTLE_CAP).count, 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n), 1);
  db.close();
});
