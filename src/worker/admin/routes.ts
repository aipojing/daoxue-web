import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import { beijingToday } from '../chat/quota';
import { getSettings, setSetting, maskTail, SETTING_KEYS, mergeAIConfig } from '../lib/settings';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const createInviteSchema = z.object({
  note: z.string().trim().max(50).default(''),
  maxUses: z.number().int().min(1).max(1000).default(1),
});

const updateUserSchema = z.object({
  dailyMessageLimit: z.number().int().min(1).max(10000),
});

const settingsSchema = z.object({
  deepseekApiKey: z.string().trim().max(200).optional(),
  visionApiKey: z.string().trim().max(200).optional(),
  visionApiUrl: z.string().trim().max(300).optional(),
  visionModel: z.string().trim().max(100).optional(),
});

export const adminRoutes = new Hono<AppContext>();
adminRoutes.get('/settings', async (c) => {
  const settings = await getSettings(c.env.DB);
  const ai = mergeAIConfig(settings, c.env);
  return ok(c, {
    deepseekKeySet: !!ai.deepseekKey,
    deepseekKeyTail: maskTail(settings[SETTING_KEYS.deepseekApiKey] ?? ''),
    deepseekFromEnv: !!ai.deepseekKey && !ai.deepseekFromDb,
    visionKeySet: !!ai.vision,
    visionKeyTail: maskTail(settings[SETTING_KEYS.visionApiKey] ?? ''),
    visionFromEnv: !!ai.vision && !ai.visionFromDb,
    visionApiUrl: settings[SETTING_KEYS.visionApiUrl] ?? '',
    visionModel: settings[SETTING_KEYS.visionModel] ?? '',
  });
});

adminRoutes.put('/settings', async (c) => {
  const body = settingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(c, '输入不合法');
  const { deepseekApiKey, visionApiKey, visionApiUrl, visionModel } = body.data;

  if (deepseekApiKey !== undefined) await setSetting(c.env.DB, SETTING_KEYS.deepseekApiKey, deepseekApiKey);
  if (visionApiKey !== undefined) await setSetting(c.env.DB, SETTING_KEYS.visionApiKey, visionApiKey);
  if (visionApiUrl !== undefined) await setSetting(c.env.DB, SETTING_KEYS.visionApiUrl, visionApiUrl);
  if (visionModel !== undefined) await setSetting(c.env.DB, SETTING_KEYS.visionModel, visionModel);

  return ok(c, { saved: true });
});

adminRoutes.get('/invite-codes', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, code, note, max_uses, used_count, disabled, created_at FROM invite_codes ORDER BY id DESC',
  ).all();
  return ok(c, results);
});

adminRoutes.post('/invite-codes', async (c) => {
  const user = c.get('user');
  const body = createInviteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(c, '输入不合法');
  const row = await c.env.DB.prepare(
    `INSERT INTO invite_codes (code, note, max_uses, created_by) VALUES (?, ?, ?, ?)
     RETURNING id, code, note, max_uses, used_count, disabled, created_at`,
  )
    .bind(generateInviteCode(), body.data.note, body.data.maxUses, user.id)
    .first();
  return ok(c, row);
});

adminRoutes.put('/invite-codes/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) return err(c, '邀请码不存在', 404);
  const body = (await c.req.json().catch(() => ({}))) as { disabled?: unknown };
  if (typeof body.disabled !== 'boolean') return err(c, '参数不合法');
  const result = await c.env.DB.prepare('UPDATE invite_codes SET disabled = ? WHERE id = ?')
    .bind(body.disabled ? 1 : 0, id)
    .run();
  if (!result.meta.changes) return err(c, '邀请码不存在', 404);
  return ok(c, { saved: true });
});

adminRoutes.get('/users', async (c) => {
  const today = beijingToday();
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.is_admin, u.daily_message_limit, u.created_at,
            COALESCE(ul.message_count, 0) AS today_used,
            (SELECT COUNT(*) FROM students s WHERE s.user_id = u.id) AS student_count
     FROM users u LEFT JOIN usage_log ul ON ul.user_id = u.id AND ul.date = ?
     ORDER BY u.id ASC`,
  )
    .bind(today)
    .all();
  return ok(c, results);
});

adminRoutes.put('/users/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) return err(c, '用户不存在', 404);
  const body = updateUserSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(c, '每日上限需为 1-10000 的整数');
  const result = await c.env.DB.prepare('UPDATE users SET daily_message_limit = ? WHERE id = ?')
    .bind(body.data.dailyMessageLimit, id)
    .run();
  if (!result.meta.changes) return err(c, '用户不存在', 404);
  return ok(c, { saved: true });
});
