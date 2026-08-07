import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { db } from './db.js';

/** A logged-in device. The cookie holds the raw token; we store only its hash. */
export interface LoginRecord {
  /** Stable id used to revoke this device (safe to expose to the client). */
  id: string;
  /** SHA-256 of the session token. The raw token lives only in the cookie. */
  hash: string;
  createdAt: string;
  lastSeenAt: string;
  /** User-Agent at login, for the device list. */
  userAgent?: string;
}

/** Public view of a device (no hash), for the "logged-in devices" list. */
export interface DeviceInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent?: string;
  /** True for the device making the request. */
  current: boolean;
}

// Only write a lastSeen bump if it advanced by at least this much, so an active
// device doesn't touch the database on every request.
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** A row from `logins`, read defensively - the driver hands back loose values. */
type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const toRecord = (r: Row): LoginRecord => ({
  id: str(r.id),
  hash: str(r.hash),
  createdAt: str(r.created_at),
  lastSeenAt: str(r.last_seen_at),
  userAgent: typeof r.user_agent === 'string' ? r.user_agent : undefined,
});

/**
 * Device logins, in the `logins` table.
 *
 * Each login gets an opaque random token (the cookie value) and only its hash is
 * stored, so the database can't be used to authenticate. That enables per-device
 * revocation, a device list, and log-out-everywhere, and it survives restarts -
 * which a random per-process signing secret did not.
 */
export class LoginStore {
  constructor() {
    this.pruneExpired();
  }

  private ttlMs(): number {
    return config.sessionTtlSeconds * 1000;
  }

  /** Drop logins whose last activity is older than the TTL. */
  private pruneExpired(now = Date.now()): void {
    const cutoff = new Date(now - this.ttlMs()).toISOString();
    db().prepare('DELETE FROM logins WHERE last_seen_at < ?').run(cutoff);
  }

  /** Create a login. Returns the raw token to set as the cookie value. */
  create(userAgent?: string): { token: string; record: LoginRecord } {
    const token = randomBytes(32).toString('base64url');
    const nowIso = new Date().toISOString();
    const record: LoginRecord = {
      id: randomBytes(9).toString('base64url'),
      hash: sha256(token),
      createdAt: nowIso,
      lastSeenAt: nowIso,
      userAgent,
    };
    db()
      .prepare(
        `INSERT INTO logins (id, hash, created_at, last_seen_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.hash, nowIso, nowIso, userAgent ?? null);
    return { token, record };
  }

  /**
   * Verify a raw token. Returns the record (sliding its expiry forward) or null
   * if unknown/expired. Writes the lastSeen bump at most once a minute.
   */
  verify(token: string | undefined): LoginRecord | null {
    if (!token) return null;
    const now = Date.now();
    const row = db().prepare('SELECT * FROM logins WHERE hash = ?').get(sha256(token));
    if (!row) return null;
    const record = toRecord(row);

    if (now - Date.parse(record.lastSeenAt) > this.ttlMs()) {
      db().prepare('DELETE FROM logins WHERE id = ?').run(record.id);
      return null;
    }
    if (now - Date.parse(record.lastSeenAt) >= LAST_SEEN_WRITE_INTERVAL_MS) {
      record.lastSeenAt = new Date(now).toISOString();
      db()
        .prepare('UPDATE logins SET last_seen_at = ? WHERE id = ?')
        .run(record.lastSeenAt, record.id);
    }
    return record;
  }

  /** List all active devices, marking the one owning `currentToken`. */
  list(currentToken?: string): DeviceInfo[] {
    this.pruneExpired();
    const currentHash = currentToken ? sha256(currentToken) : undefined;
    const rows = db().prepare('SELECT * FROM logins ORDER BY last_seen_at DESC').all();
    return rows.map(toRecord).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      userAgent: r.userAgent,
      current: currentHash !== undefined && sameHash(r.hash, currentHash),
    }));
  }

  /** Revoke the device holding this token (used on logout). */
  revokeToken(token: string | undefined): void {
    if (!token) return;
    db().prepare('DELETE FROM logins WHERE hash = ?').run(sha256(token));
  }

  /** Revoke a device by its public id. Returns false if there was no such device. */
  revokeId(id: string): boolean {
    const res = db().prepare('DELETE FROM logins WHERE id = ?').run(id);
    return res.changes > 0;
  }

  /** Log out every device. */
  revokeAll(): void {
    db().prepare('DELETE FROM logins').run();
  }
}

/** Compare two hex hashes without leaking position through timing. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
