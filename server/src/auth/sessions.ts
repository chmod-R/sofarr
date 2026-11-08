import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db.js";

export const SESSION_COOKIE = "sofarr_session";
export const PENDING_COOKIE = "sofarr_pending";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Random cookie value; only its hash is stored, so a DB leak can't be replayed. */
export function newSecret(): { value: string; hash: string } {
  const value = randomBytes(32).toString("base64url");
  return { value, hash: hashSecret(value) };
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface SessionRow {
  id: string;
  account_id: number;
  profile_uuid: string | null;
  last_seen_at: number;
  expires_at: number;
}

export function createSession(db: Db, accountId: number, now = Date.now()): string {
  const { value, hash } = newSecret();
  db.prepare(
    `INSERT INTO sessions (id, account_id, profile_uuid, created_at, last_seen_at, expires_at)
     VALUES (?, ?, NULL, ?, ?, ?)`,
  ).run(hash, accountId, now, now, now + SESSION_TTL_MS);
  return value;
}

/** Look up a session by cookie value; slides expiry forward (at most every 5 minutes). */
export function getSession(db: Db, cookie: string, now = Date.now()): SessionRow | undefined {
  const id = hashSecret(cookie);
  const row = db
    .prepare(
      "SELECT id, account_id, profile_uuid, last_seen_at, expires_at FROM sessions WHERE id = ?",
    )
    .get(id) as SessionRow | undefined;
  if (!row) return undefined;
  if (row.expires_at <= now) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return undefined;
  }
  if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
      now,
      now + SESSION_TTL_MS,
      id,
    );
  }
  return row;
}

export function setSessionProfile(db: Db, sessionId: string, profileUuid: string | null): void {
  db.prepare("UPDATE sessions SET profile_uuid = ? WHERE id = ?").run(profileUuid, sessionId);
}

export function deleteSession(db: Db, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function pruneExpired(db: Db, now = Date.now()): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM pending_logins WHERE expires_at <= ?").run(now);
}
