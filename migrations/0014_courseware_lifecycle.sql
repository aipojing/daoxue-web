ALTER TABLE coursewares ADD COLUMN enqueue_token TEXT;
ALTER TABLE coursewares ADD COLUMN enqueue_kind TEXT
  CHECK (enqueue_kind IS NULL OR enqueue_kind IN ('create', 'full_retry', 'image_retry'));
ALTER TABLE coursewares ADD COLUMN enqueue_expires_at TEXT;

CREATE INDEX idx_coursewares_enqueue_expiry
  ON coursewares(enqueue_expires_at, id)
  WHERE enqueue_token IS NOT NULL;

CREATE TABLE courseware_media_tombstones (
  object_key TEXT PRIMARY KEY,
  last_error_code TEXT NOT NULL DEFAULT 'storage_failed',
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE courseware_student_tombstones (
  user_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, student_id)
);

CREATE INDEX idx_courseware_student_tombstones_user
  ON courseware_student_tombstones(user_id, student_id);
