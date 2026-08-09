-- 学科画像提炼日志与全局配置

-- 记录每次画像提炼，用于按日上限控制
CREATE TABLE profile_refine_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_profile_refine_log_lookup
  ON profile_refine_log(student_id, subject, created_at);
