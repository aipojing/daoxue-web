import { Hono } from 'hono';
import { z } from 'zod';
import type { AICapability, AIVoiceOption } from '../../shared/ai-catalog';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import { adminEndpointSchema } from './validation';

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
    config: z.record(z.unknown()).default({}),
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
} as const;

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

async function endpointCapability(
  db: D1Database,
  endpointId: number,
): Promise<AICapability | null> {
  const endpoint = await db
    .prepare('SELECT capability FROM ai_provider_endpoints WHERE id = ?')
    .bind(endpointId)
    .first<{ capability: AICapability }>();
  return endpoint?.capability ?? null;
}

export const adminAICatalogRoutes = new Hono<AppContext>();

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
  const provider = await c.env.DB.prepare(
    `INSERT INTO ai_providers (slug, display_name, enabled)
     VALUES (?, ?, ?) RETURNING id`,
  )
    .bind(parsed.data.slug, parsed.data.displayName, parsed.data.enabled ? 1 : 0)
    .first<{ id: number }>();
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
  const endpoint = await c.env.DB.prepare(
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
    .first<{ id: number }>();
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
  const endpoint = await c.env.DB.prepare(
    `UPDATE ai_provider_endpoints
     SET provider_id = ?, capability = ?, adapter_type = ?, base_url = ?,
         config_json = ?, enabled = ?, updated_at = datetime('now')
     WHERE id = ? RETURNING id`,
  )
    .bind(
      parsed.data.providerId,
      parsed.data.capability,
      parsed.data.adapterType,
      parsed.data.baseUrl,
      JSON.stringify(parsed.data.config),
      parsed.data.enabled ? 1 : 0,
      id,
    )
    .first<{ id: number }>();
  if (!endpoint) return err(c, '端点不存在', 404);
  return ok(c, endpoint);
});

adminAICatalogRoutes.post('/models', async (c) => {
  const parsed = modelSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  const capability = await endpointCapability(c.env.DB, parsed.data.endpointId);
  if (!capability) return err(c, '端点不存在', 404);
  const model = await c.env.DB.prepare(
    `INSERT INTO ai_models
       (endpoint_id, capability, model_id, display_name, config_json, voices_json,
        recommended, enabled, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      parsed.data.endpointId,
      capability,
      parsed.data.modelId,
      parsed.data.displayName,
      JSON.stringify(parsed.data.config),
      JSON.stringify(parsed.data.voices),
      parsed.data.recommended ? 1 : 0,
      parsed.data.enabled ? 1 : 0,
      parsed.data.sortOrder,
    )
    .first<{ id: number }>();
  return ok(c, model);
});

adminAICatalogRoutes.put('/models/:id', async (c) => {
  const id = resourceId(c.req.param('id'));
  if (!id) return err(c, '模型不存在', 404);
  const parsed = modelSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  const capability = await endpointCapability(c.env.DB, parsed.data.endpointId);
  if (!capability) return err(c, '端点不存在', 404);
  const model = await c.env.DB.prepare(
    `UPDATE ai_models
     SET endpoint_id = ?, capability = ?, model_id = ?, display_name = ?,
         config_json = ?, voices_json = ?, recommended = ?, enabled = ?, sort_order = ?,
         updated_at = datetime('now')
     WHERE id = ? RETURNING id`,
  )
    .bind(
      parsed.data.endpointId,
      capability,
      parsed.data.modelId,
      parsed.data.displayName,
      JSON.stringify(parsed.data.config),
      JSON.stringify(parsed.data.voices),
      parsed.data.recommended ? 1 : 0,
      parsed.data.enabled ? 1 : 0,
      parsed.data.sortOrder,
      id,
    )
    .first<{ id: number }>();
  if (!model) return err(c, '模型不存在', 404);
  return ok(c, model);
});
