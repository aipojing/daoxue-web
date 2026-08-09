import { getVisionConfig, type VisionConfig } from '../chat/vision';

export const SETTING_KEYS = {
  deepseekApiKey: 'deepseek_api_key',
  visionApiKey: 'vision_api_key',
  visionApiUrl: 'vision_api_url',
  visionModel: 'vision_model',
  profileRefineIntervalMinutes: 'profile_refine_interval_minutes',
  profileRefineDailyLimit: 'profile_refine_daily_limit',
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
  return value ? value.slice(-4) : '';
}
