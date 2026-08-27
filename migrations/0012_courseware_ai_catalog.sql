CREATE TABLE ai_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ai_provider_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('structured_text', 'speech_synthesis', 'image_generation')),
  adapter_type TEXT NOT NULL CHECK (adapter_type IN ('openai_text', 'token_plan_tts', 'token_plan_image')),
  base_url TEXT NOT NULL CHECK (base_url LIKE 'https://%'),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider_id, capability, adapter_type)
);

CREATE TABLE ai_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL REFERENCES ai_provider_endpoints(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('structured_text', 'speech_synthesis', 'image_generation')),
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  voices_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(voices_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  recommended INTEGER NOT NULL DEFAULT 0 CHECK (recommended IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (endpoint_id, model_id)
);

CREATE TABLE user_ai_credentials (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  key_ciphertext TEXT,
  key_iv TEXT,
  key_tail TEXT NOT NULL DEFAULT '',
  encryption_version INTEGER NOT NULL DEFAULT 1 CHECK (encryption_version = 1),
  health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'valid', 'invalid', 'quota_exhausted')),
  health_checked_at TEXT,
  last_error_code TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider_id),
  CHECK (
    (key_ciphertext IS NULL AND key_iv IS NULL AND key_tail = '') OR
    (key_ciphertext IS NOT NULL AND key_iv IS NOT NULL AND key_tail <> '')
  )
);

CREATE TABLE user_model_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('courseware_text', 'courseware_image', 'teacher_tts', 'student_tts')),
  endpoint_id INTEGER NOT NULL REFERENCES ai_provider_endpoints(id) ON DELETE RESTRICT,
  model_catalog_id INTEGER REFERENCES ai_models(id) ON DELETE RESTRICT,
  custom_model_id TEXT NOT NULL DEFAULT '',
  voice_id TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, purpose),
  CHECK (
    (model_catalog_id IS NOT NULL AND custom_model_id = '') OR
    (model_catalog_id IS NULL AND custom_model_id <> '')
  )
);

CREATE TABLE ai_connection_test_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  utc_date TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count BETWEEN 0 AND 20),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, utc_date)
);

CREATE INDEX idx_ai_endpoints_provider ON ai_provider_endpoints(provider_id, capability, enabled);
CREATE INDEX idx_ai_models_endpoint ON ai_models(endpoint_id, capability, enabled, sort_order);
CREATE INDEX idx_ai_connection_usage_date ON ai_connection_test_usage(utc_date);

INSERT INTO ai_providers (slug, display_name) VALUES
  ('bailian-token-plan', '阿里云百炼 Token Plan'),
  ('deepseek', 'DeepSeek');

INSERT INTO ai_provider_endpoints
  (provider_id, capability, adapter_type, base_url, config_json)
SELECT id, 'structured_text', 'openai_text',
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  '{"allowCustomModelId":true}'
FROM ai_providers WHERE slug = 'bailian-token-plan';

INSERT INTO ai_provider_endpoints
  (provider_id, capability, adapter_type, base_url, config_json)
SELECT id, 'structured_text', 'openai_text',
  'https://api.deepseek.com',
  '{"allowCustomModelId":true}'
FROM ai_providers WHERE slug = 'deepseek';

INSERT INTO ai_provider_endpoints
  (provider_id, capability, adapter_type, base_url, config_json)
SELECT id, 'speech_synthesis', 'token_plan_tts',
  'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
  '{"formats":["mp3"],"sampleRates":[24000]}'
FROM ai_providers WHERE slug = 'bailian-token-plan';

INSERT INTO ai_provider_endpoints
  (provider_id, capability, adapter_type, base_url, config_json)
SELECT id, 'image_generation', 'token_plan_image',
  'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  '{"sizes":["1024*1024","1280*720"],"mediaHostSuffixes":["aliyuncs.com"]}'
FROM ai_providers WHERE slug = 'bailian-token-plan';

INSERT INTO ai_models
  (endpoint_id, capability, model_id, display_name, recommended, sort_order)
SELECT id, 'structured_text', 'qwen3.7-plus', '千问 3.7 Plus', 1, 10
FROM ai_provider_endpoints
WHERE provider_id = (SELECT id FROM ai_providers WHERE slug = 'bailian-token-plan')
  AND adapter_type = 'openai_text';

INSERT INTO ai_models
  (endpoint_id, capability, model_id, display_name, recommended, sort_order)
SELECT id, 'structured_text', 'deepseek-chat', 'DeepSeek Chat', 1, 10
FROM ai_provider_endpoints
WHERE provider_id = (SELECT id FROM ai_providers WHERE slug = 'deepseek')
  AND adapter_type = 'openai_text';

INSERT INTO ai_models
  (endpoint_id, capability, model_id, display_name, recommended, sort_order)
SELECT id, 'structured_text', 'deepseek-reasoner', 'DeepSeek Reasoner', 0, 20
FROM ai_provider_endpoints
WHERE provider_id = (SELECT id FROM ai_providers WHERE slug = 'deepseek')
  AND adapter_type = 'openai_text';

INSERT INTO ai_models
  (endpoint_id, capability, model_id, display_name, config_json, voices_json, recommended, sort_order)
SELECT id, 'speech_synthesis', 'qwen-audio-3.0-tts-plus', 'Qwen Audio 3.0 TTS Plus',
  '{"format":"mp3","sampleRate":24000}',
  '[{"id":"longanlingxin","name":"温暖女声","recommendedRole":"teacher"},{"id":"longanlufeng","name":"明亮男声","recommendedRole":"student"}]',
  1, 10
FROM ai_provider_endpoints WHERE adapter_type = 'token_plan_tts';

INSERT INTO ai_models
  (endpoint_id, capability, model_id, display_name, config_json, recommended, sort_order)
SELECT id, 'image_generation', 'qwen-image-3.0-pro', 'Qwen Image 3.0 Pro',
  '{"size":"1024*1024"}', 1, 10
FROM ai_provider_endpoints WHERE adapter_type = 'token_plan_image';
