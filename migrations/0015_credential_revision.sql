ALTER TABLE user_ai_credentials ADD COLUMN credential_revision TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_user_ai_credentials_revision
  ON user_ai_credentials(user_id, provider_id, credential_revision);
