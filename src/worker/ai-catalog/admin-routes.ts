import { Hono } from 'hono';
import { z } from 'zod';
import type { AICapability, AIVoiceOption } from '../../shared/ai-catalog';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import {
  adminEndpointSchema,
  adminModelConfigSchema,
  validateModelConfig,
} from './validation';
import { COMPILED_ADAPTER_TYPES } from '../courseware/adapters/registry';
import { getCoursewareFeatureStatus, setCoursewareFeatureEnabled } from './feature-settings';

const providerCreateSchema = z
  .object({
    slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    displayName: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
  })
  .strict();

const providerUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
  })
  .strict();

const coursewareFeatureStatusSchema = z.object({
  enabled: z.boolean(),
}).strict();

const voiceSchema = z
  .object({
    id: z.string().trim().min(1).max(150),
    name: z.string().trim().min(1).max(150),
    recommendedRole: z.enum(['teacher', 'student']).optional(),
  })
  .strict();

const modelSchema = z
  .object({
    endpointId: z.number().int().positive(),
    modelId: z.string().trim().min(1).max(150),
    displayName: z.string().trim().min(1).max(150),
    config: adminModelConfigSchema.default({}),
    voices: z.array(voiceSchema).max(100).default([]),
    recommended: z.boolean(),
    enabled: z.boolean(),
    sortOrder: z.number().int().min(-10000).max(10000),
  })
  .strict();

const ADAPTER_CAPABILITY = {
  openai_text: 'structured_text',
  token_plan_tts: 'speech_synthesis',
  token_plan_image: 'image_generation',
} as const satisfies Record<(typeof COMPILED_ADAPTER_TYPES)[number], AICapability>;

interface ProviderRow {
  id: number;
  slug: string;
  display_name: string;
  enabled: number;
}

interface EndpointRow {
  id: number;
  provider_id: number;
  capability: AICapability;
  adapter_type: keyof typeof ADAPTER_CAPABILITY;
  base_url: string;
  config_json: string;
  enabled: number;
}

interface ModelRow {
  id: number;
  endpoint_id: number;
  model_id: string;
  display_name: string;
  config_json: string;
  voices_json: string;
  recommended: number;
  enabled: number;
  sort_order: number;
}

const UNIQUE_CONFLICT = Symbol('unique-conflict');

function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      if (
        current.message.includes('UNIQUE constraint failed') ||
        current.message.includes('SQLITE_CONSTRAINT_UNIQUE')
      ) {
        return true;
      }
      current = current.cause;
    } else {
      return false;
    }
  }
  return false;
}

async function catalogWrite<T>(operation: () => Promise<T>): Promise<T | typeof UNIQUE_CONFLICT> {
  try {
    return await operation();
  } catch (error) {
    if (isUniqueConstraintError(error)) return UNIQUE_CONFLICT;
    throw error;
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseVoices(value: string): AIVoiceOption[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as AIVoiceOption[]) : [];
  } catch {
    return [];
  }
}

function resourceId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

interface EndpointProtocol {
  capability: AICapability;
  adapterType: keyof typeof ADAPTER_CAPABILITY;
}

async function endpointProtocol(
  db: D1Database,
  endpointId: number,
): Promise<EndpointProtocol | null> {
  const endpoint = await db
    .prepare('SELECT capability, adapter_type FROM ai_provider_endpoints WHERE id = ?')
    .bind(endpointId)
    .first<{
      capability: AICapability;
      adapter_type: keyof typeof ADAPTER_CAPABILITY;
    }>();
  return endpoint
    ? { capability: endpoint.capability, adapterType: endpoint.adapter_type }
    : null;
}

export const adminAICatalogRoutes = new Hono<AppContext>();
export const coursewareAdminRoutes = new Hono<AppContext>();

coursewareAdminRoutes.get('/status', async (c) =>
  ok(c, await getCoursewareFeatureStatus(c.env.DB)),
);

coursewareAdminRoutes.put('/status', async (c) => {
  const parsed = coursewareFeatureStatusSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  await setCoursewareFeatureEnabled(c.env.DB, parsed.data.enabled);
  return ok(c, await getCoursewareFeatureStatus(c.env.DB));
});

adminAICatalogRoutes.get('/providers', async (c) => {
  const [providersResult, endpointsResult, modelsResult] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, slug, display_name, enabled FROM ai_providers ORDER BY id',
    ).all<ProviderRow>(),
    c.env.DB.prepare(
      `SELECT id, provider_id, capability, adapter_type, base_url, config_json, enabled
       FROM ai_provider_endpoints ORDER BY id`,
    ).all<EndpointRow>(),
    c.env.DB.prepare(
      `SELECT id, endpoint_id, model_id, display_name, config_json, voices_json,
              recommended, enabled, sort_order
       FROM ai_models ORDER BY sort_order, id`,
    ).all<ModelRow>(),
  ]);

  const modelsByEndpoint = new Map<number, ReturnType<typeof renderModel>[]>();
  for (const model of modelsResult.results) {
    const models = modelsByEndpoint.get(model.endpoint_id) ?? [];
    models.push(renderModel(model));
    modelsByEndpoint.set(model.endpoint_id, models);
  }
  const endpointsByProvider = new Map<number, ReturnType<typeof renderEndpoint>[]>();
  for (const endpoint of endpointsResult.results) {
    const endpoints = endpointsByProvider.get(endpoint.provider_id) ?? [];
    endpoints.push(renderEndpoint(endpoint, modelsByEndpoint.get(endpoint.id) ?? []));
    endpointsByProvider.set(endpoint.provider_id, endpoints);
  }

  return ok(
    c,
    providersResult.results.map((provider) => ({
      id: provider.id,
      slug: provider.slug,
      displayName: provider.display_name,
      enabled: provider.enabled === 1,
      endpoints: endpointsByProvider.get(provider.id) ?? [],
    })),
  );
});

function renderEndpoint(endpoint: EndpointRow, models: ReturnType<typeof renderModel>[]) {
  return {
    id: endpoint.id,
    providerId: endpoint.provider_id,
    capability: endpoint.capability,
    adapterType: endpoint.adapter_type,
    baseUrl: endpoint.base_url,
    config: parseObject(endpoint.config_json),
    enabled: endpoint.enabled === 1,
    models,
  };
}

function renderModel(model: ModelRow) {
  return {
    id: model.id,
    endpointId: model.endpoint_id,
    modelId: model.model_id,
    displayName: model.display_name,
    config: parseObject(model.config_json),
    voices: parseVoices(model.voices_json),
    recommended: model.recommended === 1,
    enabled: model.enabled === 1,
    sortOrder: model.sort_order,
  };
}

adminAICatalogRoutes.post('/providers', async (c) => {
  const parsed = providerCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  const provider = await catalogWrite(() =>
    c.env.DB.prepare(
      `INSERT INTO ai_providers (slug, display_name, enabled)
       VALUES (?, ?, ?) RETURNING id`,
    )
      .bind(parsed.data.slug, parsed.data.displayName, parsed.data.enabled ? 1 : 0)
      .first<{ id: number }>(),
  );
  if (provider === UNIQUE_CONFLICT) return err(c, '服务商标识已存在', 409);
  return ok(c, provider);
});

adminAICatalogRoutes.put('/providers/:id', async (c) => {
  const id = resourceId(c.req.param('id'));
  if (!id) return err(c, '服务商不存在', 404);
  const parsed = providerUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  const provider = await c.env.DB.prepare(
    `UPDATE ai_providers
     SET display_name = ?, enabled = ?, updated_at = datetime('now')
     WHERE id = ? RETURNING id`,
  )
    .bind(parsed.data.displayName, parsed.data.enabled ? 1 : 0, id)
    .first<{ id: number }>();
  if (!provider) return err(c, '服务商不存在', 404);
  return ok(c, provider);
});

adminAICatalogRoutes.post('/endpoints', async (c) => {
  const parsed = adminEndpointSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  if (ADAPTER_CAPABILITY[parsed.data.adapterType] !== parsed.data.capability) {
    return err(c, '适配器能力与端点能力不匹配');
  }
  const provider = await c.env.DB.prepare('SELECT id FROM ai_providers WHERE id = ?')
    .bind(parsed.data.providerId)
    .first<{ id: number }>();
  if (!provider) return err(c, '服务商不存在', 404);
  const endpoint = await catalogWrite(() =>
    c.env.DB.prepare(
      `INSERT INTO ai_provider_endpoints
         (provider_id, capability, adapter_type, base_url, config_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(
        parsed.data.providerId,
        parsed.data.capability,
        parsed.data.adapterType,
        parsed.data.baseUrl,
        JSON.stringify(parsed.data.config),
        parsed.data.enabled ? 1 : 0,
      )
      .first<{ id: number }>(),
  );
  if (endpoint === UNIQUE_CONFLICT) return err(c, '相同能力的适配器端点已存在', 409);
  return ok(c, endpoint);
});

adminAICatalogRoutes.put('/endpoints/:id', async (c) => {
  const id = resourceId(c.req.param('id'));
  if (!id) return err(c, '端点不存在', 404);
  const parsed = adminEndpointSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  if (ADAPTER_CAPABILITY[parsed.data.adapterType] !== parsed.data.capability) {
    return err(c, '适配器能力与端点能力不匹配');
  }
  const provider = await c.env.DB.prepare('SELECT id FROM ai_providers WHERE id = ?')
    .bind(parsed.data.providerId)
    .first<{ id: number }>();
  if (!provider) return err(c, '服务商不存在', 404);
  const endpoint = await catalogWrite(() =>
    c.env.DB.prepare(
      `UPDATE ai_provider_endpoints
       SET provider_id = ?, capability = ?, adapter_type = ?, base_url = ?,
           config_json = ?, enabled = ?, updated_at = datetime('now')
       WHERE id = ?
         AND (
           (capability = ? AND adapter_type = ?)
           OR NOT EXISTS (
             SELECT 1 FROM ai_models m WHERE m.endpoint_id = ai_provider_endpoints.id
           )
         )
       RETURNING id`,
    )
      .bind(
        parsed.data.providerId,
        parsed.data.capability,
        parsed.data.adapterType,
        parsed.data.baseUrl,
        JSON.stringify(parsed.data.config),
        parsed.data.enabled ? 1 : 0,
        id,
        parsed.data.capability,
        parsed.data.adapterType,
      )
      .first<{ id: number }>(),
  );
  if (endpoint === UNIQUE_CONFLICT) return err(c, '相同能力的适配器端点已存在', 409);
  if (!endpoint) {
    const stillExists = await c.env.DB.prepare(
      'SELECT id FROM ai_provider_endpoints WHERE id = ?',
    )
      .bind(id)
      .first<{ id: number }>();
    return stillExists
      ? err(c, '已有模型的端点不能更改能力或适配器', 409)
      : err(c, '端点不存在', 404);
  }
  return ok(c, endpoint);
});

adminAICatalogRoutes.post('/models', async (c) => {
  const parsed = modelSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  const protocol = await endpointProtocol(c.env.DB, parsed.data.endpointId);
  if (!protocol) return err(c, '端点不存在', 404);
  if (ADAPTER_CAPABILITY[protocol.adapterType] !== protocol.capability) {
    return err(c, '目标端点协议配置不一致', 409);
  }
  const validatedConfig = validateModelConfig(protocol.capability, parsed.data.config);
  if (!validatedConfig.success) {
    return err(c, validatedConfig.error.issues[0]?.message ?? '模型配置不合法');
  }
  const model = await catalogWrite(() =>
    c.env.DB.prepare(
      `INSERT INTO ai_models
         (endpoint_id, capability, model_id, display_name, config_json, voices_json,
          recommended, enabled, sort_order)
       SELECT e.id, e.capability, ?, ?, ?, ?, ?, ?, ?
       FROM ai_provider_endpoints e
       WHERE e.id = ? AND e.capability = ? AND e.adapter_type = ?
       RETURNING id`,
    )
      .bind(
        parsed.data.modelId,
        parsed.data.displayName,
        JSON.stringify(validatedConfig.data),
        JSON.stringify(parsed.data.voices),
        parsed.data.recommended ? 1 : 0,
        parsed.data.enabled ? 1 : 0,
        parsed.data.sortOrder,
        parsed.data.endpointId,
        protocol.capability,
        protocol.adapterType,
      )
      .first<{ id: number }>(),
  );
  if (model === UNIQUE_CONFLICT) return err(c, '端点中已存在相同模型 ID', 409);
  if (!model) return err(c, '目标端点协议已变更，请重试', 409);
  return ok(c, model);
});

adminAICatalogRoutes.put('/models/:id', async (c) => {
  const id = resourceId(c.req.param('id'));
  if (!id) return err(c, '模型不存在', 404);
  const parsed = modelSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  const protocol = await endpointProtocol(c.env.DB, parsed.data.endpointId);
  if (!protocol) return err(c, '端点不存在', 404);
  if (ADAPTER_CAPABILITY[protocol.adapterType] !== protocol.capability) {
    return err(c, '目标端点协议配置不一致', 409);
  }
  const validatedConfig = validateModelConfig(protocol.capability, parsed.data.config);
  if (!validatedConfig.success) {
    return err(c, validatedConfig.error.issues[0]?.message ?? '模型配置不合法');
  }
  const model = await catalogWrite(() =>
    c.env.DB.prepare(
      `UPDATE ai_models
       SET endpoint_id = ?, capability = ?, model_id = ?, display_name = ?,
           config_json = ?, voices_json = ?, recommended = ?, enabled = ?, sort_order = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM ai_provider_endpoints e
           WHERE e.id = ? AND e.capability = ? AND e.adapter_type = ?
         )
       RETURNING id`,
    )
      .bind(
        parsed.data.endpointId,
        protocol.capability,
        parsed.data.modelId,
        parsed.data.displayName,
        JSON.stringify(validatedConfig.data),
        JSON.stringify(parsed.data.voices),
        parsed.data.recommended ? 1 : 0,
        parsed.data.enabled ? 1 : 0,
        parsed.data.sortOrder,
        id,
        parsed.data.endpointId,
        protocol.capability,
        protocol.adapterType,
      )
      .first<{ id: number }>(),
  );
  if (model === UNIQUE_CONFLICT) return err(c, '端点中已存在相同模型 ID', 409);
  if (!model) {
    const stillExists = await c.env.DB.prepare('SELECT id FROM ai_models WHERE id = ?')
      .bind(id)
      .first<{ id: number }>();
    return stillExists
      ? err(c, '目标端点协议已变更，请重试', 409)
      : err(c, '模型不存在', 404);
  }
  return ok(c, model);
});
