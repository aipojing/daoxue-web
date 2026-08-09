import { getVisionConfig, type VisionConfig } from '../chat/vision';

export const SETTING_KEYS = {
  deepseekApiKey: 'deepseek_api_key',
  visionApiKey: 'vision_api_key',
  visionApiUrl: 'vision_api_url',
  visionModel: 'vision_model',
  profileRefineIntervalMinutes: 'profile_refine_interval_minutes',
  profileRefineDailyLimit: 'profile_refine_daily_limit',
  /** 管理员显式控制的站点共享兜底开关；'1' 允许无个人 Key 的用户使用共享服务 */
  sharedAIFallbackEnabled: 'shared_ai_fallback_enabled',
} as const;

export interface AIConfig {
  deepseekKey: string;
  vision: VisionConfig | null;
  deepseekFromDb: boolean;
  visionFromDb: boolean;
}

interface EnvLike {
  DEEPSEEK_API_KEY?: string;
  VISION_API_KEY?: string;
  VISION_API_URL?: string;
  VISION_MODEL?: string;
}

/**
 * 只解析"站点共享" AI 配置（管理员写入 D1 的设置 + Worker 环境变量兜底）。
 * 用户请求的最终配置必须经 resolveUserAIConfig()：个人 Key 优先，
 * 且受 sharedAIFallbackEnabled 开关控制，不能直接拿这里的值作为个人请求的 Key。
 */
export function mergeAIConfig(settings: Record<string, string>, env: EnvLike): AIConfig {
  const dbDeepseek = settings[SETTING_KEYS.deepseekApiKey] ?? '';
  const dbVisionKey = settings[SETTING_KEYS.visionApiKey] ?? '';

  const deepseekKey = dbDeepseek || env.DEEPSEEK_API_KEY || '';
  const visionKey = dbVisionKey || env.VISION_API_KEY || '';
  const visionUrl = settings[SETTING_KEYS.visionApiUrl] || env.VISION_API_URL;
  const visionModel = settings[SETTING_KEYS.visionModel] || env.VISION_MODEL;

  return {
    deepseekKey,
    vision: getVisionConfig({
      VISION_API_KEY: visionKey || undefined,
      VISION_API_URL: visionUrl,
      VISION_MODEL: visionModel,
    }),
    deepseekFromDb: !!dbDeepseek,
    visionFromDb: !!dbVisionKey,
  };
}

export async function getSettings(db: D1Database): Promise<Record<string, string>> {
  try {
    const { results } = await db.prepare('SELECT key, value FROM app_settings').all<{
      key: string;
      value: string;
    }>();
    return Object.fromEntries(results.map((r) => [r.key, r.value]));
  } catch (e) {
    console.error('read app_settings failed:', e);
    return {};
  }
}

export async function resolveAIConfig(db: D1Database, env: EnvLike): Promise<AIConfig> {
  return mergeAIConfig(await getSettings(db), env);
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  if (!value) {
    await db.prepare('DELETE FROM app_settings WHERE key = ?').bind(key).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .bind(key, value)
    .run();
}

export function maskTail(value: string): string {
  if (!value) return '';
  return value.length <= 8 ? '****' : value.slice(-4);
}
