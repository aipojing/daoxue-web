import type { Env } from '../env';
import { UserFacingError } from '../lib/errors';
import { decryptSecret, encryptSecret } from '../lib/secrets';
import { maskTail } from '../lib/settings';
import { resolvePersonalDeepSeekCredential } from '../lib/user-ai-settings';

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
       (user_id, provider_id, key_ciphertext, key_iv, key_tail, credential_revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, provider_id) DO UPDATE SET
         key_ciphertext = excluded.key_ciphertext,
         key_iv = excluded.key_iv,
         key_tail = excluded.key_tail,
         credential_revision = excluded.credential_revision,
         health_status = 'unknown',
         health_checked_at = NULL,
         last_error_code = '',
         updated_at = datetime('now')`,
    )
    .bind(userId, providerId, encrypted.ciphertext, encrypted.iv, maskTail(apiKey), crypto.randomUUID())
    .run();
}

export type CredentialRevision =
  | { source: 'catalog'; revision: string }
  | { source: 'legacy_deepseek'; revision: string; ciphertext: string; iv: string };

export interface ResolvedCredential {
  apiKey: string;
  healthStatus: 'unknown' | 'valid' | 'invalid' | 'quota_exhausted';
  revision: CredentialRevision;
}

async function legacyRevision(ciphertext: string, iv: string): Promise<string> {
  const bytes = new TextEncoder().encode(`legacy-deepseek\0${ciphertext}\0${iv}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function resolveCredentialWithRevision(
  db: D1Database,
  env: Env,
  userId: number,
  providerId: number,
): Promise<ResolvedCredential | null> {
  const row = await db.prepare(
    `SELECT key_ciphertext, key_iv, credential_revision, health_status
     FROM user_ai_credentials WHERE user_id = ? AND provider_id = ?`,
  ).bind(userId, providerId).first<{
    key_ciphertext: string | null;
    key_iv: string | null;
    credential_revision: string;
    health_status: ResolvedCredential['healthStatus'];
  }>();
  if (row?.key_ciphertext && row.key_iv) {
    if (!env.AI_SETTINGS_ENCRYPTION_KEY) {
      throw new UserFacingError('个人课件 AI 配置暂时无法读取', 503);
    }
    const apiKey = await decryptSecret(
      env.AI_SETTINGS_ENCRYPTION_KEY,
      { ciphertext: row.key_ciphertext, iv: row.key_iv },
      credentialAAD(userId, providerId),
    );
    return {
      apiKey,
      healthStatus: row.health_status,
      revision: { source: 'catalog', revision: row.credential_revision },
    };
  }
  const provider = await db.prepare('SELECT slug FROM ai_providers WHERE id = ?')
    .bind(providerId).first<{ slug: string }>();
  if (provider?.slug !== 'deepseek') return null;
  const personal = await resolvePersonalDeepSeekCredential(db, env, userId);
  if (!personal.apiKey || !personal.ciphertext || !personal.iv) return null;
  const revision = await legacyRevision(personal.ciphertext, personal.iv);
  return {
    apiKey: personal.apiKey,
    healthStatus: row?.credential_revision === revision ? row.health_status : 'unknown',
    revision: {
      source: 'legacy_deepseek', revision, ciphertext: personal.ciphertext, iv: personal.iv,
    },
  };
}

export async function resolveCredential(
  db: D1Database,
  env: Env,
  userId: number,
  providerId: number,
): Promise<string> {
  try {
    return (await resolveCredentialWithRevision(db, env, userId, providerId))?.apiKey ?? '';
  } catch {
    throw new UserFacingError('个人课件 AI 配置无法读取，请重新保存 Key', 503);
  }
}
