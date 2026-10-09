import { DatabaseSync } from 'node:sqlite';

export const PLAN_DEFAULTS = [
  { id: 'free', name: 'Free', dailyLimit: 1 },
  { id: 'bronze', name: 'Bronze', dailyLimit: 3 },
  { id: 'silver', name: 'Silver', dailyLimit: 5 },
  { id: 'gold', name: 'Gold', dailyLimit: 10 },
];

export function initializeDatabase(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      daily_limit INTEGER NOT NULL CHECK (daily_limit > 0)
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      plan_id TEXT NOT NULL REFERENCES plans(id),
      status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'expired')),
      starts_at TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS subscriptions_user_current
      ON subscriptions(user_id, status, starts_at, expires_at);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      thumbnail_url TEXT NOT NULL,
      media_path TEXT,
      mime_type TEXT,
      file_size_bytes INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT NOT NULL,
      device_name TEXT,
      browser TEXT,
      is_registered INTEGER NOT NULL DEFAULT 1 CHECK (is_registered IN (0, 1)),
      last_seen TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_devices_unique
      ON user_devices(user_id, device_id);

    CREATE TABLE IF NOT EXISTS download_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      video_id TEXT NOT NULL REFERENCES videos(id),
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
      plan_id TEXT NOT NULL REFERENCES plans(id),
      downloaded_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'duplicate')),
      is_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (is_duplicate IN (0, 1)),
      ip_address TEXT NOT NULL,
      device_information TEXT NOT NULL,
      browser TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      failure_reason TEXT,
      transfer_started_at TEXT,
      transfer_heartbeat_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS download_user_timestamp
      ON download_records(user_id, downloaded_at);
    CREATE INDEX IF NOT EXISTS download_user_video_timestamp
      ON download_records(user_id, video_id, downloaded_at);

    CREATE TABLE IF NOT EXISTS download_history (
      id TEXT PRIMARY KEY,
      download_id TEXT NOT NULL REFERENCES download_records(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS download_history_download_idx
      ON download_history(download_id, event_at);

    CREATE TABLE IF NOT EXISTS download_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      video_id TEXT REFERENCES videos(id),
      download_id TEXT REFERENCES download_records(id),
      attempted_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      device_information TEXT NOT NULL,
      browser TEXT NOT NULL,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS download_attempts_user_timestamp
      ON download_attempts(user_id, attempted_at);
  `);

  const downloadColumns = new Set(
    db.prepare('PRAGMA table_info(download_records)').all().map((column) => column.name),
  );
  if (!downloadColumns.has('transfer_started_at')) {
    db.exec('ALTER TABLE download_records ADD COLUMN transfer_started_at TEXT');
  }
  if (!downloadColumns.has('completed_at')) {
    db.exec('ALTER TABLE download_records ADD COLUMN completed_at TEXT');
  }
  if (!downloadColumns.has('transfer_heartbeat_at')) {
    db.exec('ALTER TABLE download_records ADD COLUMN transfer_heartbeat_at TEXT');
  }

  const insertPlan = db.prepare(
    'INSERT OR IGNORE INTO plans (id, name, daily_limit) VALUES (?, ?, ?)',
  );
  for (const plan of PLAN_DEFAULTS) {
    insertPlan.run(plan.id, plan.name, plan.dailyLimit);
  }
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  return db;
}
