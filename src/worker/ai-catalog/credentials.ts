import type { Env } from '../env';
import { UserFacingError } from '../lib/errors';
import { decryptSecret, encryptSecret } from '../lib/secrets';
import { maskTail } from '../lib/settings';
import { resolvePersonalDeepSeekKey } from '../lib/user-ai-settings';

function credentialAAD(userId: number, providerId: number): string {
  return `courseware-ai:v1:${userId}:${providerId}`;
}

export async function saveCredential(
  db: D1Database,
  env: Env,
  userId: number,
  providerId: number,
  apiKey: string | null,
): Promise<void> {
  if (apiKey !== null && !env.AI_SETTINGS_ENCRYPTION_KEY) {
    throw new UserFacingError('服务器尚未配置 AI 设置加密服务', 503);
  }
  if (apiKey === null) {
    await db
      .prepare('DELETE FROM user_ai_credentials WHERE user_id = ? AND provider_id = ?')
      .bind(userId, providerId)
      .run();
    return;
  }

  const encrypted = await encryptSecret(
    env.AI_SETTINGS_ENCRYPTION_KEY as string,
    apiKey,
    credentialAAD(userId, providerId),
  );
  await db
    .prepare(
      `INSERT INTO user_ai_credentials
       (user_id, provider_id, key_ciphertext, key_iv, key_tail, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, provider_id) DO UPDATE SET
         key_ciphertext = excluded.key_ciphertext,
         key_iv = excluded.key_iv,
         key_tail = excluded.key_tail,
         health_status = 'unknown',
         health_checked_at = NULL,
         last_error_code = '',
         updated_at = datetime('now')`,
    )
    .bind(userId, providerId, encrypted.ciphertext, encrypted.iv, maskTail(apiKey))
    .run();
}

export async function resolveCredential(
  db: D1Database,
  env: Env,
  userId: number,
  providerId: number,
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT key_ciphertext, key_iv
       FROM user_ai_credentials
       WHERE user_id = ? AND provider_id = ?`,
    )
    .bind(userId, providerId)
    .first<{ key_ciphertext: string | null; key_iv: string | null }>();

  if (!row?.key_ciphertext || !row.key_iv) {
    const provider = await db
      .prepare('SELECT slug FROM ai_providers WHERE id = ?')
      .bind(providerId)
      .first<{ slug: string }>();
    return provider?.slug === 'deepseek' ? resolvePersonalDeepSeekKey(db, env, userId) : '';
  }
  if (!env.AI_SETTINGS_ENCRYPTION_KEY) {
    throw new UserFacingError('个人课件 AI 配置无法读取，请重新保存 Key', 503);
  }
  try {
    return await decryptSecret(
      env.AI_SETTINGS_ENCRYPTION_KEY,
      { ciphertext: row.key_ciphertext, iv: row.key_iv },
      credentialAAD(userId, providerId),
    );
  } catch {
    throw new UserFacingError('个人课件 AI 配置无法读取，请重新保存 Key', 503);
  }
}
