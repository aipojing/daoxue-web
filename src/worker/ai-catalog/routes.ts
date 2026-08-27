import { Hono } from 'hono';
import type { AppContext } from '../env';
import { requireAuth } from '../auth/middleware';
import { ok, err } from '../lib/envelope';
import { credentialPatchSchema, preferenceListSchema } from './validation';
import {
  getPublicCatalog,
  getUserCoursewareAISettings,
  saveUserModelPreferences,
} from './repository';
import { saveCredential } from './credentials';

export const aiCatalogRoutes = new Hono<AppContext>();
export const coursewareAISettingsRoutes = new Hono<AppContext>();

aiCatalogRoutes.use('*', requireAuth);
coursewareAISettingsRoutes.use('*', requireAuth);

aiCatalogRoutes.get('/', async (c) => ok(c, await getPublicCatalog(c.env.DB)));

coursewareAISettingsRoutes.get('/', async (c) =>
  ok(c, await getUserCoursewareAISettings(c.env.DB, c.env, c.get('user').id)),
);

coursewareAISettingsRoutes.put('/credentials/:providerId', async (c) => {
  const providerId = Number(c.req.param('providerId'));
  if (!Number.isInteger(providerId) || providerId < 1) return err(c, '服务商不存在', 404);
  const parsed = credentialPatchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');

  const provider = await c.env.DB.prepare(
    'SELECT id FROM ai_providers WHERE id = ? AND enabled = 1',
  )
    .bind(providerId)
    .first<{ id: number }>();
  if (!provider) return err(c, '服务商不存在', 404);

  const userId = c.get('user').id;
  await saveCredential(c.env.DB, c.env, userId, providerId, parsed.data.apiKey);
  return ok(c, await getUserCoursewareAISettings(c.env.DB, c.env, userId));
});

coursewareAISettingsRoutes.put('/preferences', async (c) => {
  const parsed = preferenceListSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');

  const userId = c.get('user').id;
  await saveUserModelPreferences(c.env.DB, userId, parsed.data);
  return ok(c, await getUserCoursewareAISettings(c.env.DB, c.env, userId));
});
