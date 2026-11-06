export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const THROTTLE_FAILURE_LIMIT = 5;

const THROTTLE_KINDS = new Set(['login', 'vault_unlock']);
export const THROTTLE_STORE_DEFAULT_OPTIONS = Object.freeze({
  pruneThreshold: 2048,
  maxRows: 4096,
});

export class ThrottleCapacityError extends Error {
  constructor() {
    super('Throttle store is at capacity');
    this.name = 'ThrottleCapacityError';
  }
}

function resolveOptions(options = {}) {
  const pruneThreshold = options.pruneThreshold ?? THROTTLE_STORE_DEFAULT_OPTIONS.pruneThreshold;
  const maxRows = options.maxRows ?? THROTTLE_STORE_DEFAULT_OPTIONS.maxRows;
  if (!Number.isSafeInteger(pruneThreshold) || pruneThreshold < 0) {
    throw new RangeError('pruneThreshold must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new RangeError('maxRows must be a positive safe integer');
  }
  return { pruneThreshold, maxRows };
}

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
 * Remove expired attempts after the table grows beyond the cleanup threshold.
 * If the hard cap is exceeded, reclaim the oldest non-lockout rows first;
 * active lockouts are never removed, even if they alone exceed the cap.
 */
export function pruneExpiredThrottles(db, now = Date.now(), options = {}) {
  const { pruneThreshold, maxRows } = resolveOptions(options);
  const rowCount = Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n);
  if (rowCount <= pruneThreshold && rowCount < maxRows) return 0;

  const expired = db.prepare(`
    DELETE FROM request_throttles
    WHERE (kind = 'login' AND locked_until <= ? AND window_started_at <= ?)
       OR (kind = 'vault_unlock' AND (
         (locked_until > 0 AND locked_until <= ?)
         OR (locked_until = 0 AND updated_at <= ?)
       ))
  `).run(now, now - THROTTLE_WINDOW_MS, now, now - THROTTLE_WINDOW_MS);
  const remaining = Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n);
  let removed = Number(expired.changes);
  if (remaining > maxRows) {
    const reclaimed = db.prepare(`
      DELETE FROM request_throttles
      WHERE rowid IN (
        SELECT rowid FROM request_throttles
        WHERE locked_until <= ?
        ORDER BY updated_at ASC, kind, throttle_key
        LIMIT ?
      )
    `).run(now, remaining - maxRows);
    removed += Number(reclaimed.changes);
  }
  return removed;
}

export function getThrottle(db, kind, key, now = Date.now(), options = {}) {
  assertKind(kind);
  pruneExpiredThrottles(db, now, options);
  const row = db.prepare(`
    SELECT failure_count, window_started_at, locked_until, updated_at
    FROM request_throttles WHERE kind = ? AND throttle_key = ?
  `).get(kind, key);
  if (!row) return null;

  const expired = kind === 'login'
    ? Number(row.locked_until) <= now && now - Number(row.window_started_at) >= THROTTLE_WINDOW_MS
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

export function recordFailure(db, kind, key, now = Date.now(), options = {}) {
  assertKind(kind);
  const attempt = getThrottle(db, kind, key, now, options);
  if (!attempt) {
    const { maxRows } = resolveOptions(options);
    let rowCount = Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n);
    if (rowCount >= maxRows) {
      // Free oldest non-lockout rows before refusing a brand-new key; never touch active lockouts.
      const overflow = rowCount - maxRows + 1;
      db.prepare(`
        DELETE FROM request_throttles
        WHERE rowid IN (
          SELECT rowid FROM request_throttles
          WHERE locked_until <= ?
          ORDER BY updated_at ASC, kind, throttle_key
          LIMIT ?
        )
      `).run(now, overflow);
      rowCount = Number(db.prepare('SELECT COUNT(*) AS n FROM request_throttles').get().n);
      if (rowCount >= maxRows) throw new ThrottleCapacityError();
    }
  }
  const nextAttempt = attempt || {
    count: 0,
    windowStartedAt: now,
    lockedUntil: 0,
    updatedAt: now,
  };
  nextAttempt.count += 1;
  nextAttempt.updatedAt = now;

  if (nextAttempt.count >= THROTTLE_FAILURE_LIMIT) {
    nextAttempt.lockedUntil = now + THROTTLE_WINDOW_MS;
    if (kind === 'vault_unlock') nextAttempt.count = 0;
  }

  db.prepare(`
    INSERT INTO request_throttles(kind, throttle_key, failure_count, window_started_at, locked_until, updated_at)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, throttle_key) DO UPDATE SET
      failure_count = excluded.failure_count,
      window_started_at = excluded.window_started_at,
      locked_until = excluded.locked_until,
      updated_at = excluded.updated_at
  `).run(kind, key, nextAttempt.count, nextAttempt.windowStartedAt, nextAttempt.lockedUntil, now);
  pruneExpiredThrottles(db, now, options);
  return nextAttempt;
}

export function clearThrottle(db, kind, key) {
  assertKind(kind);
  db.prepare('DELETE FROM request_throttles WHERE kind = ? AND throttle_key = ?').run(kind, key);
}
