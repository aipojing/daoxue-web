-- 画像提炼策略跟随账户级 AI 设置，控制当前账户 Key 的后台消耗。
ALTER TABLE user_ai_settings
  ADD COLUMN profile_refine_interval_minutes INTEGER NOT NULL DEFAULT 10
  CHECK (profile_refine_interval_minutes BETWEEN 1 AND 1440);

ALTER TABLE user_ai_settings
  ADD COLUMN profile_refine_daily_limit INTEGER NOT NULL DEFAULT 0
  CHECK (profile_refine_daily_limit BETWEEN 0 AND 1000);
