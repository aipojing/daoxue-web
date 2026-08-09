import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import { requireAuth } from '../auth/middleware';
import { getUserAISettingsStatus, saveUserAISettings } from '../lib/user-ai-settings';

/** 省略 = 不修改；非空字符串 = 覆盖；null = 清除。空字符串拒绝，防止误删。 */
const keyValue = z.string().trim().min(1, 'Key 不能为空字符串').max(500).nullable();

const userAISettingsSchema = z
  .object({
    deepseekApiKey: keyValue.optional(),
    visionApiKey: keyValue.optional(),
    // 个人视觉服务只允许白名单 provider，禁止任意 URL（SSRF）
    visionProvider: z.enum(['zhipu', 'dashscope']).optional(),
    visionModel: z.string().trim().max(100).optional(),
    profileRefineIntervalMinutes: z.number().int().min(1).max(1440).optional(),
    profileRefineDailyLimit: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '没有需要保存的配置');

export const userAISettingsRoutes = new Hono<AppContext>();
userAISettingsRoutes.use('*', requireAuth);

userAISettingsRoutes.get('/', async (c) => {
  return ok(c, await getUserAISettingsStatus(c.env.DB, c.env, c.get('user').id));
});

userAISettingsRoutes.put('/', async (c) => {
  const parsed = userAISettingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  const writesNewKey =
    typeof parsed.data.deepseekApiKey === 'string' || typeof parsed.data.visionApiKey === 'string';
  if (writesNewKey && !c.env.AI_SETTINGS_ENCRYPTION_KEY) {
    return err(c, '服务器尚未配置 AI 设置加密服务', 503);
  }
  // owner 只来自 session，绝不接收 body/query 中的 userId
  await saveUserAISettings(c.env.DB, c.env.AI_SETTINGS_ENCRYPTION_KEY ?? '', c.get('user').id, parsed.data);
  return ok(c, await getUserAISettingsStatus(c.env.DB, c.env, c.get('user').id));
});
