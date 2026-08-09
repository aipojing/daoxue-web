-- 跨请求的短期租约：防止同一画像重复提炼、同一会话同时生成两个回复。
-- expires_at 让 Worker 异常终止后能自动恢复，lease_token 防止旧持有者释放新租约。
CREATE TABLE profile_refine_leases (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (student_id, subject)
);

CREATE TABLE conversation_chat_leases (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 登录时会按时间窗口全局清理过期失败记录；单独索引避免数据量大时全表扫描。
CREATE INDEX idx_login_failures_created_at ON login_failures(created_at);
