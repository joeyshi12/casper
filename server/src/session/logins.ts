import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Logger } from '../util/logger.js';

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

// Only persist a lastSeen bump if it advanced by at least this much, so an
// active device doesn't rewrite the file on every request.
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Persistent device-login store (~/.casper/logins.json). Each login gets an
 * opaque random token (the cookie value); the server keeps only its hash keyed
 * by hash, so a leaked file can't be used to authenticate. Enables per-device
 * revocation, a device list, and log-out-everywhere - and survives restarts,
 * which a random per-process signing secret did not.
 */
export class LoginStore {
  private byHash = new Map<string, LoginRecord>();
  private readonly file: string;
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
    this.file = path.join(config.casperDataDir, 'logins.json');
    this.load();
  }

  private load(): void {
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LoginRecord[];
      for (const r of arr) this.byHash.set(r.hash, r);
    } catch {
      this.byHash.clear();
    }
    this.pruneExpired();
  }

  private persist(): void {
    try {
      fs.mkdirSync(config.casperDataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify([...this.byHash.values()], null, 2));
    } catch (err) {
      this.log.warn({ err }, 'logins: could not persist');
    }
  }

  private ttlMs(): number {
    return config.sessionTtlSeconds * 1000;
  }

  private isExpired(r: LoginRecord, now: number): boolean {
    return now - Date.parse(r.lastSeenAt) > this.ttlMs();
  }

  // Drop expired records. Returns true if anything was removed.
  private pruneExpired(now = Date.now()): boolean {
    let changed = false;
    for (const [hash, r] of this.byHash) {
      if (this.isExpired(r, now)) {
        this.byHash.delete(hash);
        changed = true;
      }
    }
    return changed;
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
    this.byHash.set(record.hash, record);
    this.persist();
    return { token, record };
  }

  /**
   * Verify a raw token. Returns the record (sliding its expiry forward) or null
   * if unknown/expired. Persists the lastSeen bump at most once a minute.
   */
  verify(token: string | undefined): LoginRecord | null {
    if (!token) return null;
    const now = Date.now();
    const record = this.byHash.get(sha256(token));
    if (!record) return null;
    if (this.isExpired(record, now)) {
      this.byHash.delete(record.hash);
      this.persist();
      return null;
    }
    if (now - Date.parse(record.lastSeenAt) >= LAST_SEEN_WRITE_INTERVAL_MS) {
      record.lastSeenAt = new Date().toISOString();
      this.persist();
    }
    return record;
  }

  /** List all active devices, marking the one owning `currentToken`. */
  list(currentToken?: string): DeviceInfo[] {
    if (this.pruneExpired()) this.persist();
    const currentHash = currentToken ? sha256(currentToken) : undefined;
    return [...this.byHash.values()]
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        userAgent: r.userAgent,
        current: r.hash === currentHash,
      }));
  }

  /** Revoke the device holding this token (used on logout). */
  revokeToken(token: string | undefined): void {
    if (!token) return;
    if (this.byHash.delete(sha256(token))) this.persist();
  }

  /** Revoke a device by its public id. */
  revokeId(id: string): boolean {
    for (const [hash, r] of this.byHash) {
      if (r.id === id) {
        this.byHash.delete(hash);
        this.persist();
        return true;
      }
    }
    return false;
  }

  /** Log out every device. */
  revokeAll(): void {
    this.byHash.clear();
    this.persist();
  }
}
