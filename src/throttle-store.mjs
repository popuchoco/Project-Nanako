export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const THROTTLE_FAILURE_LIMIT = 5;

const THROTTLE_KINDS = new Set(['login', 'vault_unlock']);
const PRUNE_THRESHOLD = 2048;
const MAX_THROTTLE_ROWS = 4096;

function assertKind(kind) {
  if (!THROTTLE_KINDS.has(kind)) throw new TypeError(`Unsupported throttle kind: ${kind}`);
}

export function ensureThrottleSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_throttles (
      kind TEXT NOT NULL CHECK(kind IN ('login', 'vault_unlock')),
      throttle_key TEXT NOT NULL,
      failure_count INTEGER NOT NULL CHECK(failure_count >= 0),
      window_started_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(kind, throttle_key)
    );
    CREATE INDEX IF NOT EXISTS request_throttles_updated_at_idx
      ON request_throttles(updated_at);
  `);
}

/**
 * Remove expired attempts after the table grows beyond the old in-memory
 * cleanup threshold. Keep at most 4096 rows if all remaining keys are active.
 */
export function pruneExpiredThrottles(db, now = Date.now()) {
  const rowCount = Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n);
  if (rowCount <= PRUNE_THRESHOLD) return 0;

  const expired = db.prepare(`
    DELETE FROM request_throttles
    WHERE (kind = 'login' AND window_started_at <= ?)
       OR (kind = 'vault_unlock' AND (
         (locked_until > 0 AND locked_until <= ?)
         OR (locked_until = 0 AND updated_at <= ?)
       ))
  `).run(now - THROTTLE_WINDOW_MS, now, now - THROTTLE_WINDOW_MS);
  const remaining = Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n);
  if (remaining > MAX_THROTTLE_ROWS) {
    db.prepare(`
      DELETE FROM request_throttles
      WHERE rowid IN (
        SELECT rowid FROM request_throttles
        ORDER BY updated_at DESC, kind, throttle_key
        LIMIT -1 OFFSET ?
      )
    `).run(MAX_THROTTLE_ROWS);
  }
  return Number(expired.changes);
}

export function getThrottle(db, kind, key, now = Date.now()) {
  assertKind(kind);
  pruneExpiredThrottles(db, now);
  const row = db.prepare(`
    SELECT failure_count, window_started_at, locked_until, updated_at
    FROM request_throttles WHERE kind = ? AND throttle_key = ?
  `).get(kind, key);
  if (!row) return null;

  const expired = kind === 'login'
    ? now - Number(row.window_started_at) >= THROTTLE_WINDOW_MS
    : Number(row.locked_until) > 0 && Number(row.locked_until) <= now;
  if (expired) {
    clearThrottle(db, kind, key);
    return null;
  }
  return {
    count: Number(row.failure_count),
    windowStartedAt: Number(row.window_started_at),
    lockedUntil: Number(row.locked_until),
    updatedAt: Number(row.updated_at),
  };
}

export function recordFailure(db, kind, key, now = Date.now()) {
  assertKind(kind);
  const attempt = getThrottle(db, kind, key, now) || {
    count: 0,
    windowStartedAt: now,
    lockedUntil: 0,
    updatedAt: now,
  };
  attempt.count += 1;
  attempt.updatedAt = now;

  if (attempt.count >= THROTTLE_FAILURE_LIMIT) {
    attempt.lockedUntil = now + THROTTLE_WINDOW_MS;
    if (kind === 'vault_unlock') attempt.count = 0;
  }

  db.prepare(`
    INSERT INTO request_throttles(kind, throttle_key, failure_count, window_started_at, locked_until, updated_at)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, throttle_key) DO UPDATE SET
      failure_count = excluded.failure_count,
      window_started_at = excluded.window_started_at,
      locked_until = excluded.locked_until,
      updated_at = excluded.updated_at
  `).run(kind, key, attempt.count, attempt.windowStartedAt, attempt.lockedUntil, now);
  pruneExpiredThrottles(db, now);
  return attempt;
}

export function clearThrottle(db, kind, key) {
  assertKind(kind);
  db.prepare('DELETE FROM request_throttles WHERE kind = ? AND throttle_key = ?').run(kind, key);
}
