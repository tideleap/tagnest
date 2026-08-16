-- B-7 Y2: WebDAV / S3 backup push.
-- backup_targets: user-configured remote destinations; the secret (WebDAV
-- password or S3 secret key) is stored encrypted via crypto.encryptField and
-- is NEVER returned in plaintext by the API.
CREATE TABLE backup_targets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- 'webdav' | 's3'
  endpoint TEXT NOT NULL,             -- WebDAV base URL or S3 virtual-host endpoint
  bucket TEXT,                        -- S3 bucket name (null for webdav)
  username TEXT,                      -- WebDAV/S3 access key id
  encrypted_secret TEXT,              -- encryptField(password | secret_key); plaintext never persisted
  remote_path TEXT NOT NULL DEFAULT '/',
  enabled INTEGER NOT NULL DEFAULT 1,
  frequency TEXT NOT NULL DEFAULT 'off', -- 'off' | 'daily' | 'weekly'
  last_run_at TEXT,
  last_status TEXT,                   -- 'ok' | 'failed' | NULL
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_backup_targets_user ON backup_targets(user_id, kind);

-- backup_runs: per-push history so a user can verify each backup landed.
CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,               -- 'ok' | 'failed'
  bytes INTEGER,
  sha256 TEXT,
  error TEXT
);
CREATE INDEX idx_backup_runs_user ON backup_runs(user_id, started_at DESC);
