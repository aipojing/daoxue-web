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
import { ignoreCancelFailure } from '../lib/outbound-url';

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
const MAX_CONNECTION_TEST_BODY_BYTES = 1024;
const BODY_TOO_LARGE_MESSAGE = '连接测试请求体过大';

type ConnectionTestBodyRead =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; message: string };

async function cancelRequestBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  await ignoreCancelFailure(body ? () => body.cancel() : undefined);
}

export async function readBoundedConnectionTestBody(
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | undefined,
): Promise<ConnectionTestBodyRead> {
  contentLength = contentLength?.trim();
  if (contentLength && /^\d+$/.test(contentLength)) {
    try {
      if (BigInt(contentLength) > BigInt(MAX_CONNECTION_TEST_BODY_BYTES)) {
        await cancelRequestBody(body);
        return { ok: false, status: 413, message: BODY_TOO_LARGE_MESSAGE };
      }
    } catch {
      // Invalid or forged lengths are treated as unknown and bounded while streaming below.
    }
  }

  if (!body) return { ok: true, value: {} };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CONNECTION_TEST_BODY_BYTES) {
        await ignoreCancelFailure(() => reader.cancel());
        return { ok: false, status: 413, message: BODY_TOO_LARGE_MESSAGE };
      }
      chunks.push(next.value);
    }
  } catch {
    await ignoreCancelFailure(() => reader.cancel());
    return { ok: false, status: 400, message: '连接测试请求体无效' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, status: 400, message: '连接测试请求体无效' };
  }
}

async function readOptionalJsonBody(c: Context<AppContext>): Promise<ConnectionTestBodyRead> {
  return readBoundedConnectionTestBody(
    c.req.raw.body,
    c.req.header('content-length'),
  );
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
  const body = await readOptionalJsonBody(c);
  if (!body.ok) return err(c, body.message, body.status);
  const parsed = emptyTestBodySchema.safeParse(body.value);
  if (!parsed.success) return err(c, '连接测试不接受自定义输入');
  return connectionTestResponse(c, 'text');
});

coursewareAISettingsRoutes.post('/test/speech', async (c) => {
  const body = await readOptionalJsonBody(c);
  if (!body.ok) return err(c, body.message, body.status);
  const parsed = speechTestBodySchema.safeParse(body.value);
  if (!parsed.success) return err(c, '试听参数不合法');
  return connectionTestResponse(c, parsed.data.purpose);
});

coursewareAISettingsRoutes.post('/test/image', async (c) => {
  const body = await readOptionalJsonBody(c);
  if (!body.ok) return err(c, body.message, body.status);
  const parsed = emptyTestBodySchema.safeParse(body.value);
  if (!parsed.success) return err(c, '图片测试不接受自定义输入');
  return connectionTestResponse(c, 'image');
});
