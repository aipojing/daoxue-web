// 上游请求最多 120 秒；额外缓冲避免边缘运行时抖动导致旧请求未结束时租约过期。
const CHAT_LEASE_MINUTES = 5;

export async function tryAcquireConversationChatLease(
  db: D1Database,
  conversationId: number,
  leaseToken: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO conversation_chat_leases (conversation_id, lease_token, expires_at)
       VALUES (?, ?, datetime('now', '+${CHAT_LEASE_MINUTES} minutes'))
       ON CONFLICT(conversation_id) DO UPDATE SET
         lease_token = excluded.lease_token,
         expires_at = excluded.expires_at
       WHERE conversation_chat_leases.expires_at <= datetime('now')
       RETURNING lease_token`,
    )
    .bind(conversationId, leaseToken)
    .first<{ lease_token: string }>();
  return row?.lease_token === leaseToken;
}

export async function releaseConversationChatLease(
  db: D1Database,
  conversationId: number,
  leaseToken: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM conversation_chat_leases
       WHERE conversation_id = ? AND lease_token = ?`,
    )
    .bind(conversationId, leaseToken)
    .run();
}
