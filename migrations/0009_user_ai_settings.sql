-- 用户级 AI 服务配置：API Key 以 AES-256-GCM 密文保存，主密钥只存在于 Worker Secret。
-- vision_provider 白名单防止普通用户把请求指向任意地址（SSRF）。
CREATE TABLE user_ai_settings (
  user_id INTEGER PRIMARY KEY,
  deepseek_key_ciphertext TEXT,
  deepseek_key_iv TEXT,
  deepseek_key_tail TEXT NOT NULL DEFAULT '',
  vision_key_ciphertext TEXT,
  vision_key_iv TEXT,
  vision_key_tail TEXT NOT NULL DEFAULT '',
  vision_provider TEXT NOT NULL DEFAULT 'zhipu'
    CHECK (vision_provider IN ('zhipu', 'dashscope')),
  vision_model TEXT NOT NULL DEFAULT '',
  encryption_version INTEGER NOT NULL DEFAULT 1
    CHECK (encryption_version = 1),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (
    (deepseek_key_ciphertext IS NULL AND deepseek_key_iv IS NULL AND deepseek_key_tail = '') OR
    (deepseek_key_ciphertext IS NOT NULL AND deepseek_key_iv IS NOT NULL AND deepseek_key_tail <> '')
  ),
  CHECK (
    (vision_key_ciphertext IS NULL AND vision_key_iv IS NULL AND vision_key_tail = '') OR
    (vision_key_ciphertext IS NOT NULL AND vision_key_iv IS NOT NULL AND vision_key_tail <> '')
  )
);

-- 共享兜底初始开启，保证发布瞬间未配置个人 Key 的用户不中断；
-- 管理员完成迁移后在「AI 服务」页手动关闭，进入严格 BYOK。
INSERT INTO app_settings (key, value, updated_at)
VALUES ('shared_ai_fallback_enabled', '1', datetime('now'))
ON CONFLICT(key) DO NOTHING;
