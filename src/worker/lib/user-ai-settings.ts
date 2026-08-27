import type { Env } from '../env';
import { UserFacingError } from './errors';
import { decryptSecret, encryptSecret } from './secrets';
import { getSettings, maskTail, mergeAIConfig, SETTING_KEYS } from './settings';
import {
  getPersonalVisionConfig,
  type PersonalVisionProvider,
  type VisionConfig,
} from '../chat/vision';

export type AIConfigSource = 'personal' | 'shared' | 'none';

export interface UserAISettingsPatch {
  /** 省略 = 不修改；非空字符串 = 覆盖；null = 清除 */
  deepseekApiKey?: string | null;
  /** 省略 = 不修改；非空字符串 = 覆盖；null = 清除 */
  visionApiKey?: string | null;
  visionProvider?: PersonalVisionProvider;
  visionModel?: string;
  profileRefineIntervalMinutes?: number;
  profileRefineDailyLimit?: number;
}

export interface ProfileRefineSettings {
  intervalMinutes: number;
  dailyLimit: number;
}

export interface UserAISettingsStatus {
  personal: {
    deepseekKeySet: boolean;
    deepseekKeyTail: string;
    visionKeySet: boolean;
    visionKeyTail: string;
    visionProvider: PersonalVisionProvider;
    visionModel: string;
    profileRefineIntervalMinutes: number;
    profileRefineDailyLimit: number;
  };
  sharedFallbackEnabled: boolean;
  effective: {
    deepseekConfigured: boolean;
    deepseekSource: AIConfigSource;
    visionEnabled: boolean;
    visionSource: AIConfigSource;
  };
}

export interface ResolvedUserAIConfig {
  deepseekKey: string;
  vision: VisionConfig | null;
  deepseekSource: AIConfigSource;
  visionSource: AIConfigSource;
  profileRefine: ProfileRefineSettings;
}

interface PersonalRow {
  user_id: number;
  deepseek_key_ciphertext: string | null;
  deepseek_key_iv: string | null;
  deepseek_key_tail: string;
  vision_key_ciphertext: string | null;
  vision_key_iv: string | null;
  vision_key_tail: string;
  vision_provider: PersonalVisionProvider;
  vision_model: string;
  profile_refine_interval_minutes: number;
  profile_refine_daily_limit: number;
}

type PersonalKeyService = 'deepseek' | 'vision';

const DECRYPT_FAILED_MESSAGE = '个人 AI 配置无法读取，请在「AI 服务」页重新保存 Key';
const DEFAULT_PROFILE_REFINE_INTERVAL_MINUTES = 10;
const DEFAULT_PROFILE_REFINE_DAILY_LIMIT = 0;

function resolveProfileRefineSettings(row: PersonalRow | null): ProfileRefineSettings {
  const interval = row?.profile_refine_interval_minutes;
  const dailyLimit = row?.profile_refine_daily_limit;
  return {
    intervalMinutes:
      Number.isInteger(interval) && interval! >= 1 && interval! <= 1440
        ? interval!
        : DEFAULT_PROFILE_REFINE_INTERVAL_MINUTES,
    dailyLimit:
      Number.isInteger(dailyLimit) && dailyLimit! >= 0 && dailyLimit! <= 1000
        ? dailyLimit!
        : DEFAULT_PROFILE_REFINE_DAILY_LIMIT,
  };
}

/** AAD 绑定用户与服务类型，防止密文被跨用户或跨服务替换。 */
function secretAAD(userId: number, service: PersonalKeyService): string {
  return `user-ai:v1:${userId}:${service}`;
}

async function readPersonalRow(db: D1Database, userId: number): Promise<PersonalRow | null> {
  return db
    .prepare('SELECT * FROM user_ai_settings WHERE user_id = ?')
    .bind(userId)
    .first<PersonalRow>();
}

async function decryptPresentKey(
  env: Env,
  row: PersonalRow | null,
  userId: number,
  service: PersonalKeyService,
): Promise<string> {
  const ciphertext = service === 'deepseek' ? row?.deepseek_key_ciphertext : row?.vision_key_ciphertext;
  const iv = service === 'deepseek' ? row?.deepseek_key_iv : row?.vision_key_iv;
  if (!ciphertext || !iv) return '';
  // 存在密文但没有主密钥：fail closed，绝不静默改用共享 Key
  if (!env.AI_SETTINGS_ENCRYPTION_KEY) {
    console.error(`user AI ${service} key present but master key missing for user ${userId}`);
    throw new UserFacingError(DECRYPT_FAILED_MESSAGE, 503);
  }
  try {
    return await decryptSecret(
      env.AI_SETTINGS_ENCRYPTION_KEY,
      { ciphertext, iv },
      secretAAD(userId, service),
    );
  } catch (e) {
    // 只记录事件本身，绝不记录密文或明文
    console.error(`decrypt user AI ${service} key failed for user ${userId}:`, e);
    throw new UserFacingError(DECRYPT_FAILED_MESSAGE, 503);
  }
}

/**
 * 仅解析旧设置中的个人 DeepSeek Key，供课件目录兼容使用。
 * 此路径不读取站点设置或环境中的共享服务 Key。
 */
export async function resolvePersonalDeepSeekKey(
  db: D1Database,
  env: Env,
  userId: number,
): Promise<string> {
  return (await resolvePersonalDeepSeekCredential(db, env, userId)).apiKey;
}

export interface ResolvedPersonalCredential {
  apiKey: string;
  ciphertext: string;
  iv: string;
}

export async function resolvePersonalDeepSeekCredential(
  db: D1Database,
  env: Env,
  userId: number,
): Promise<ResolvedPersonalCredential> {
  const personal = await readPersonalRow(db, userId);
  const ciphertext = personal?.deepseek_key_ciphertext ?? '';
  const iv = personal?.deepseek_key_iv ?? '';
  return {
    apiKey: await decryptPresentKey(env, personal, userId, 'deepseek'),
    ciphertext,
    iv,
  };
}

/**
 * 共享兜底只有管理员显式写入 '1' 才开启（fail closed）：
 * 记录被误删、读取异常返回空配置等任何"取值不确定"的情况都按关闭处理，
 * 避免在管理员不知情时消耗站点共享 Key 的费用。
 * 生产首启不断流：migration 0009 会种子写入 '1'。
 */
export function isSharedFallbackEnabled(settings: Record<string, string>): boolean {
  return settings[SETTING_KEYS.sharedAIFallbackEnabled] === '1';
}

function resolveFromParts(
  env: Env,
  personal: PersonalRow | null,
  settings: Record<string, string>,
  personalDeepseek: string,
  personalVision: string,
): ResolvedUserAIConfig {
  const shared = mergeAIConfig(settings, env);
  const fallbackEnabled = isSharedFallbackEnabled(settings);

  return {
    deepseekKey: personalDeepseek || (fallbackEnabled ? shared.deepseekKey : ''),
    deepseekSource: personalDeepseek
      ? 'personal'
      : fallbackEnabled && shared.deepseekKey
        ? 'shared'
        : 'none',
    // 视觉配置整段取个人（白名单固定地址）或整段取共享，不做字段级混搭
    vision:
      personalVision && personal
        ? getPersonalVisionConfig(personal.vision_provider, personalVision, personal.vision_model)
        : fallbackEnabled
          ? shared.vision
          : null,
    visionSource: personalVision
      ? 'personal'
      : fallbackEnabled && shared.vision
        ? 'shared'
        : 'none',
    profileRefine: resolveProfileRefineSettings(personal),
  };
}

/**
 * 解析某次用户请求实际使用的 AI 凭据：个人配置 → 管理员明确开启的站点共享配置 → 未配置。
 * 个人密文损坏或主密钥不匹配时抛出 UserFacingError（fail closed），不回退共享 Key。
 * 调用方若已读取过 app_settings，可通过可选参数复用，避免重复查询。
 */
export async function resolveUserAIConfig(
  db: D1Database,
  env: Env,
  userId: number,
  appSettings?: Record<string, string>,
): Promise<ResolvedUserAIConfig> {
  const settings = appSettings ?? (await getSettings(db));
  const personal = await readPersonalRow(db, userId);
  const personalDeepseek = await decryptPresentKey(env, personal, userId, 'deepseek');
  const personalVision = await decryptPresentKey(env, personal, userId, 'vision');
  return resolveFromParts(env, personal, settings, personalDeepseek, personalVision);
}

/** 只返回是否已配置、尾号掩码和生效来源；任何响应都不包含密文、IV 或完整 Key。 */
export async function getUserAISettingsStatus(
  db: D1Database,
  env: Env,
  userId: number,
): Promise<UserAISettingsStatus> {
  const settings = await getSettings(db);
  const personal = await readPersonalRow(db, userId);
  const personalDeepseek = await decryptPresentKey(env, personal, userId, 'deepseek');
  const personalVision = await decryptPresentKey(env, personal, userId, 'vision');
  const resolved = resolveFromParts(env, personal, settings, personalDeepseek, personalVision);

  return {
    personal: {
      deepseekKeySet: !!personal?.deepseek_key_ciphertext,
      deepseekKeyTail: personal?.deepseek_key_tail ?? '',
      visionKeySet: !!personal?.vision_key_ciphertext,
      visionKeyTail: personal?.vision_key_tail ?? '',
      visionProvider: personal?.vision_provider ?? 'zhipu',
      visionModel: personal?.vision_model ?? '',
      profileRefineIntervalMinutes: resolved.profileRefine.intervalMinutes,
      profileRefineDailyLimit: resolved.profileRefine.dailyLimit,
    },
    sharedFallbackEnabled: isSharedFallbackEnabled(settings),
    effective: {
      deepseekConfigured: resolved.deepseekSource !== 'none',
      deepseekSource: resolved.deepseekSource,
      visionEnabled: resolved.visionSource !== 'none',
      visionSource: resolved.visionSource,
    },
  };
}

/**
 * 保存个人 AI 设置。先 INSERT ... ON CONFLICT DO NOTHING 建行，
 * 再只 UPDATE patch 中实际出现的字段，两条语句同批执行；
 * 不做"整行读改写"，两个并发局部保存互不覆盖。
 */
export async function saveUserAISettings(
  db: D1Database,
  masterKeyBase64: string,
  userId: number,
  patch: UserAISettingsPatch,
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO user_ai_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING')
      .bind(userId),
  ];
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (patch.deepseekApiKey === null) {
    sets.push('deepseek_key_ciphertext = NULL', 'deepseek_key_iv = NULL', "deepseek_key_tail = ''");
  } else if (typeof patch.deepseekApiKey === 'string') {
    const encrypted = await encryptSecret(
      masterKeyBase64,
      patch.deepseekApiKey,
      secretAAD(userId, 'deepseek'),
    );
    sets.push('deepseek_key_ciphertext = ?', 'deepseek_key_iv = ?', 'deepseek_key_tail = ?');
    binds.push(encrypted.ciphertext, encrypted.iv, maskTail(patch.deepseekApiKey));
  }

  if (patch.visionApiKey === null) {
    sets.push('vision_key_ciphertext = NULL', 'vision_key_iv = NULL', "vision_key_tail = ''");
  } else if (typeof patch.visionApiKey === 'string') {
    const encrypted = await encryptSecret(
      masterKeyBase64,
      patch.visionApiKey,
      secretAAD(userId, 'vision'),
    );
    sets.push('vision_key_ciphertext = ?', 'vision_key_iv = ?', 'vision_key_tail = ?');
    binds.push(encrypted.ciphertext, encrypted.iv, maskTail(patch.visionApiKey));
  }

  if (patch.visionProvider !== undefined) {
    sets.push('vision_provider = ?');
    binds.push(patch.visionProvider);
  }
  if (patch.visionModel !== undefined) {
    sets.push('vision_model = ?');
    binds.push(patch.visionModel);
  }
  if (patch.profileRefineIntervalMinutes !== undefined) {
    sets.push('profile_refine_interval_minutes = ?');
    binds.push(patch.profileRefineIntervalMinutes);
  }
  if (patch.profileRefineDailyLimit !== undefined) {
    sets.push('profile_refine_daily_limit = ?');
    binds.push(patch.profileRefineDailyLimit);
  }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  statements.push(
    db
      .prepare(`UPDATE user_ai_settings SET ${sets.join(', ')} WHERE user_id = ?`)
      .bind(...binds, userId),
  );
  await db.batch(statements);
}
