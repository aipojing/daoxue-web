import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
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
import {
  testConfiguredCapability,
  type BinaryTestResult,
  type ConnectionTestCapability,
} from './connection-tests';
import { ProviderCallError } from '../courseware/adapters/errors';

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

const emptyTestBodySchema = z.object({}).strict();
const speechTestBodySchema = z.object({
  purpose: z.enum(['teacher_tts', 'student_tts']),
}).strict();

async function readOptionalJsonBody(c: Context<AppContext>): Promise<unknown> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function safeProviderStatus(error: ProviderCallError): ContentfulStatusCode {
  const status = error.errorCode === 'invalid_credential' || error.errorCode === 'missing_credential'
    ? 401
    : error.errorCode === 'quota_exhausted'
      ? 402
      : error.errorCode === 'rate_limited'
        ? 429
        : error.errorCode === 'provider_timeout'
          ? 504
          : error.errorCode === 'model_unavailable' || error.errorCode === 'incompatible_voice'
            ? 422
            : 503;
  return status;
}

async function connectionTestResponse(
  c: Context<AppContext>,
  capability: ConnectionTestCapability,
) {
  try {
    const result = await testConfiguredCapability(c.env, c.get('user').id, capability);
    if (capability === 'text') return ok(c, { status: result.status });
    const media = result as BinaryTestResult;
    return new Response(media.bytes, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': media.contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ProviderCallError) {
      return err(c, error.message, safeProviderStatus(error));
    }
    throw error;
  }
}

coursewareAISettingsRoutes.post('/test/text', async (c) => {
  const parsed = emptyTestBodySchema.safeParse(await readOptionalJsonBody(c));
  if (!parsed.success) return err(c, '连接测试不接受自定义输入');
  return connectionTestResponse(c, 'text');
});

coursewareAISettingsRoutes.post('/test/speech', async (c) => {
  const parsed = speechTestBodySchema.safeParse(await readOptionalJsonBody(c));
  if (!parsed.success) return err(c, '试听参数不合法');
  return connectionTestResponse(c, parsed.data.purpose);
});

coursewareAISettingsRoutes.post('/test/image', async (c) => {
  const parsed = emptyTestBodySchema.safeParse(await readOptionalJsonBody(c));
  if (!parsed.success) return err(c, '图片测试不接受自定义输入');
  return connectionTestResponse(c, 'image');
});
