import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Ordered schema migrations. Append only; never edit a shipped entry.
 * The applied count is tracked in SQLite's `user_version`.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- The plex.tv account that signed in (v1: the server owner only).
  CREATE TABLE accounts (
    id          INTEGER PRIMARY KEY,          -- plex.tv user id
    uuid        TEXT NOT NULL UNIQUE,
    username    TEXT NOT NULL,
    thumb       TEXT,
    plex_token  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- Plex Home users of an account. Tokens are filled in when a profile is selected.
  CREATE TABLE profiles (
    uuid          TEXT PRIMARY KEY,           -- plex.tv home user uuid
    account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    plex_id       INTEGER NOT NULL,
    title         TEXT NOT NULL,
    thumb         TEXT,
    is_admin      INTEGER NOT NULL,
    is_protected  INTEGER NOT NULL,
    is_restricted INTEGER NOT NULL,
    plex_token    TEXT,                       -- plex.tv token for this profile
    server_token  TEXT,                       -- access token for the configured server
    updated_at    INTEGER NOT NULL
  );

  -- A sign-in in progress: a Plex PIN bound to the browser that requested it.
  CREATE TABLE pending_logins (
    id          TEXT PRIMARY KEY,             -- sha256 of the pending cookie
    pin_id      INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,           -- sha256 of the session cookie
    account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    profile_uuid  TEXT REFERENCES profiles(uuid) ON DELETE SET NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
  );
  CREATE INDEX sessions_expires ON sessions(expires_at);
  `,
  `
  -- Who asked for what ("Get it"), for history and, later, approvals/quotas.
  CREATE TABLE requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_uuid  TEXT NOT NULL,              -- not a FK: keep history if a profile leaves Plex Home
    profile_title TEXT NOT NULL,
    media_type    TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
    tmdb_id       INTEGER NOT NULL,
    title         TEXT NOT NULL,
    seasons       TEXT,                       -- JSON array for tv
    result        TEXT NOT NULL,              -- added | searching | already_have
    arr_id        INTEGER,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX requests_profile ON requests(profile_uuid, created_at);
  `,
];

export function openDb(dataDir: string | ":memory:"): Db {
  let path = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, "sofarr.db");
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  // Tighten files created by older versions (or under a looser umask).
  if (path !== ":memory:") {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(f)) chmodSync(f, 0o600);
    }
  }
  return db;
}

function migrate(db: Db): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
