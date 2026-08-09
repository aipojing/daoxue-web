-- 客户端为每次发送生成稳定 request ID；断线重试时复用它，数据库唯一索引兜底防止重复扣费和落库。
ALTER TABLE messages ADD COLUMN client_request_id TEXT;

CREATE UNIQUE INDEX idx_messages_client_request_user
ON messages(conversation_id, client_request_id)
WHERE role = 'user' AND client_request_id IS NOT NULL;

CREATE INDEX idx_messages_client_request
ON messages(conversation_id, client_request_id)
WHERE client_request_id IS NOT NULL;
