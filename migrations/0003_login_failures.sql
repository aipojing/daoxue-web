-- 登录失败记录，用于限制暴力破解
CREATE TABLE login_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_login_failures_email ON login_failures(email, created_at);

-- 邮箱统一小写，避免大小写变体形成重复账号 / 登录失败
UPDATE users SET email = lower(email) WHERE email <> lower(email);
