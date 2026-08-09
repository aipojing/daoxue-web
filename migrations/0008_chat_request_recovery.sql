-- 记录逻辑聊天请求当前是否占用额度，使失败恢复既不会双扣，也不会漏扣。
ALTER TABLE messages ADD COLUMN quota_charged INTEGER NOT NULL DEFAULT 0
  CHECK (quota_charged IN (0, 1));

-- 恢复请求发生极端竞态时，数据库仍保证一个 request ID 最多只有一条 assistant。
CREATE UNIQUE INDEX idx_messages_client_request_assistant
ON messages(conversation_id, client_request_id)
WHERE role = 'assistant' AND client_request_id IS NOT NULL;
