import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DATA_DIR = process.env.CLAUDE_USAGE_HOME || path.join(os.homedir(), '.claude-usage');

export function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'usage.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      key            TEXT PRIMARY KEY,   -- requestId|messageId, dedupes resumed/forked sessions
      ts             INTEGER NOT NULL,   -- epoch ms
      account        TEXT NOT NULL DEFAULT 'default',
      model          TEXT,
      project        TEXT,
      session_id     TEXT,
      git_branch     TEXT,
      effort         TEXT,
      speed          TEXT,
      service_tier   TEXT,
      inference_geo  TEXT,
      is_sidechain   INTEGER NOT NULL DEFAULT 0,
      input          INTEGER NOT NULL DEFAULT 0,
      output         INTEGER NOT NULL DEFAULT 0,
      thinking       INTEGER NOT NULL DEFAULT 0,
      cache_read     INTEGER NOT NULL DEFAULT 0,
      cache_creation INTEGER NOT NULL DEFAULT 0,
      cache_5m       INTEGER NOT NULL DEFAULT 0,
      cache_1h       INTEGER NOT NULL DEFAULT 0,
      web_search     INTEGER NOT NULL DEFAULT 0,
      web_fetch      INTEGER NOT NULL DEFAULT 0,
      cost           REAL    NOT NULL DEFAULT 0,
      weight         REAL    NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_acct_ts  ON events(account, ts);
    CREATE INDEX IF NOT EXISTS idx_events_model_ts ON events(model, ts);
    CREATE INDEX IF NOT EXISTS idx_events_proj_ts  ON events(project, ts);

    -- Incremental scan bookkeeping: resume each transcript at the byte we stopped at.
    CREATE TABLE IF NOT EXISTS files (
      path     TEXT PRIMARY KEY,
      size     INTEGER NOT NULL,
      mtime    INTEGER NOT NULL,
      offset   INTEGER NOT NULL,
      scanned  INTEGER NOT NULL
    );

    -- Snapshots of the authoritative OAuth utilization endpoint.
    CREATE TABLE IF NOT EXISTS limit_snapshots (
      ts       INTEGER NOT NULL,
      account  TEXT NOT NULL DEFAULT 'default',
      window   TEXT NOT NULL,        -- five_hour | seven_day | seven_day_opus | seven_day_sonnet
      utilization REAL,
      resets_at   INTEGER,
      PRIMARY KEY (ts, account, window)
    );
    CREATE INDEX IF NOT EXISTS idx_snap_win ON limit_snapshots(account, window, ts);

    CREATE TABLE IF NOT EXISTS extra_usage (
      ts INTEGER PRIMARY KEY,
      account TEXT NOT NULL DEFAULT 'default',
      is_enabled INTEGER, monthly_limit REAL, used_credits REAL, utilization REAL
    );

    -- Fired notifications, so a threshold alerts once per window instance.
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, window TEXT, kind TEXT, detail TEXT
    );

    -- Window boundaries observed in the utilization series: a 'reset' is a drop
    -- (the window rolled over), a 'start' is 0 -> positive (a new 5-hour window
    -- opened). The confident flag marks ones pinned inside a short sampling gap.
    CREATE TABLE IF NOT EXISTS limit_events (
      account   TEXT    NOT NULL,
      window    TEXT    NOT NULL,
      kind      TEXT    NOT NULL,
      ts        INTEGER NOT NULL,
      confident INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, window, kind, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_levents ON limit_events(account, window, kind, ts);

    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
}

export function getMeta(db, k, fallback = null) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return r ? r.v : fallback;
}
export function setMeta(db, k, v) {
  db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
}
