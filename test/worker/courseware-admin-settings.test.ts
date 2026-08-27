import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePreference, saveUserModelPreferences } from '../../src/worker/ai-catalog/repository';

interface Envelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

const worker = exports.default as unknown as {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

async function api(path: string, init: RequestInit = {}, cookie = ''): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  return worker.fetch(`https://example.com${path}`, { ...init, headers });
}

async function json<T>(response: Response): Promise<Envelope<T>> {
  return response.json<Envelope<T>>();
}

function sessionCookie(response: Response): string {
  const value = response.headers.get('Set-Cookie');
  if (!value) throw new Error('missing session cookie');
  return value.split(';', 1)[0] ?? '';
}

async function register(email: string, inviteCode?: string) {
  const response = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct-password', inviteCode }),
  });
  return {
    response,
    body: await json<{ id: number; isAdmin: boolean }>(response),
    cookie: response.ok ? sessionCookie(response) : '',
  };
}

async function createAdmin() {
  const result = await register('admin@example.com');
  expect(result.response.status).toBe(200);
  expect(result.body.data?.isAdmin).toBe(true);
  return result;
}

async function createMember(adminCookie: string) {
  const invite = await api('/api/admin/invite-codes', {
    method: 'POST',
    body: JSON.stringify({ note: 'member', maxUses: 1 }),
  }, adminCookie);
  const inviteBody = await json<{ code: string }>(invite);
  return register('member@example.com', inviteBody.data?.code);
}

async function providerId(): Promise<number> {
  const provider = await env.DB.prepare(
    "SELECT id FROM ai_providers WHERE slug = 'bailian-token-plan'",
  ).first<{ id: number }>();
  if (!provider) throw new Error('missing seeded provider');
  return provider.id;
}

async function createProvider(slug: string): Promise<number> {
  const provider = await env.DB.prepare(
    'INSERT INTO ai_providers (slug, display_name) VALUES (?, ?) RETURNING id',
  ).bind(slug, slug).first<{ id: number }>();
  if (!provider) throw new Error('failed to create provider');
  return provider.id;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM invite_codes'),
    env.DB.prepare('DELETE FROM user_ai_credentials'),
    env.DB.prepare('DELETE FROM user_model_preferences'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare("DELETE FROM ai_providers WHERE slug LIKE 'task-12-%'"),
    env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('courseware_enabled', '0', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = '0'"),
  ]);
});

describe('courseware catalog administration', () => {
  it('lets an administrator create a model for an existing adapter without code changes', async () => {
    const admin = await createAdmin();
    const endpoint = await api('/api/admin/ai-catalog/endpoints', {
      method: 'POST',
      body: JSON.stringify({
        providerId: await createProvider('task-12-create'), capability: 'structured_text', adapterType: 'openai_text',
        baseUrl: 'https://catalog.example/v1', config: { allowCustomModelId: true }, enabled: true,
      }),
    }, admin.cookie);
    expect(endpoint.status).toBe(200);
    const endpointId = (await json<{ id: number }>(endpoint)).data?.id;
    const model = await api('/api/admin/ai-catalog/models', {
      method: 'POST',
      body: JSON.stringify({
        endpointId, modelId: 'task-12-text', displayName: 'Task 12 Text', config: {}, voices: [],
        recommended: false, enabled: true, sortOrder: 1,
      }),
    }, admin.cookie);
    expect(model.status).toBe(200);

    const catalog = await api('/api/ai-catalog', {}, admin.cookie);
    expect(JSON.stringify((await json(catalog)).data)).toContain('task-12-text');
  });

  it('rejects HTTP, loopback, link-local and private-network endpoint URLs', async () => {
    const admin = await createAdmin();
    const base = {
      providerId: await createProvider('task-12-unsafe-url'), capability: 'structured_text', adapterType: 'openai_text',
      config: {}, enabled: true,
    };
    for (const baseUrl of [
      'http://catalog.example/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1',
      'https://169.254.169.254/v1', 'https://10.0.0.1/v1', 'https://192.168.0.1/v1',
    ]) {
      const response = await api('/api/admin/ai-catalog/endpoints', {
        method: 'POST', body: JSON.stringify({ ...base, baseUrl }),
      }, admin.cookie);
      expect(response.status).toBe(400);
    }
  });

  it('rejects unknown fields, invalid adapter paths, and unsafe image media suffixes', async () => {
    const admin = await createAdmin();
    const responses = await Promise.all([
      api('/api/admin/ai-catalog/endpoints', { method: 'POST', body: JSON.stringify({
        providerId: await createProvider('task-12-path'), capability: 'structured_text', adapterType: 'openai_text',
        baseUrl: 'https://catalog.example/v1/chat/completions', config: {}, enabled: true,
      }) }, admin.cookie),
      api('/api/admin/ai-catalog/endpoints', { method: 'POST', body: JSON.stringify({
        providerId: await createProvider('task-12-image'), capability: 'image_generation', adapterType: 'token_plan_image',
        baseUrl: 'https://catalog.example/api/v1/services/audio/tts/SpeechSynthesizer',
        config: { mediaHostSuffixes: ['*.example.com'] }, enabled: true,
      }) }, admin.cookie),
      api('/api/admin/courseware/status', { method: 'PUT', body: JSON.stringify({ enabled: true, extra: true }) }, admin.cookie),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
  });

  it('normalizes only query-free and fragment-free public endpoint URLs before storing them', async () => {
    const admin = await createAdmin();
    const provider = await createProvider('task-12-normalize');
    const created = await api('/api/admin/ai-catalog/endpoints', {
      method: 'POST', body: JSON.stringify({
        providerId: provider, capability: 'structured_text', adapterType: 'openai_text',
        baseUrl: 'https://catalog.example./v1', config: {}, enabled: true,
      }),
    }, admin.cookie);
    expect(created.status).toBe(200);
    const endpointId = (await json<{ id: number }>(created)).data?.id;
    const storedCreate = await env.DB.prepare('SELECT base_url FROM ai_provider_endpoints WHERE id = ?')
      .bind(endpointId).first<{ base_url: string }>();
    expect(storedCreate?.base_url).toBe('https://catalog.example/v1');

    const updated = await api(`/api/admin/ai-catalog/endpoints/${endpointId}`, {
      method: 'PUT', body: JSON.stringify({
        providerId: provider, capability: 'structured_text', adapterType: 'openai_text',
        baseUrl: 'https://catalog.example./v2', config: {}, enabled: false,
      }),
    }, admin.cookie);
    expect(updated.status).toBe(200);
    const storedUpdate = await env.DB.prepare('SELECT base_url FROM ai_provider_endpoints WHERE id = ?')
      .bind(endpointId).first<{ base_url: string }>();
    expect(storedUpdate?.base_url).toBe('https://catalog.example/v2');

    for (const baseUrl of [
      'https://catalog.example/v1?target=https://private.example',
      'https://catalog.example/v1#fragment',
      'https://user:pass@catalog.example/v1',
      'https://catalog.example/v1%2Fprivate',
    ]) {
      const response = await api('/api/admin/ai-catalog/endpoints', {
        method: 'POST', body: JSON.stringify({
          providerId: await createProvider(`task-12-url-${crypto.randomUUID()}`), capability: 'structured_text',
          adapterType: 'openai_text', baseUrl, config: {}, enabled: true,
        }),
      }, admin.cookie);
      expect(response.status).toBe(400);
    }
  });

  it('rejects literal and malformed media suffixes on the matching TTS and image protocol paths', async () => {
    const admin = await createAdmin();
    const invalidSuffixes = ['*.example.com', '8.8.8.8', '127.0.0.1', '2001:4860:4860::8888', 'Media.Example.com'];
    for (const [index, suffix] of invalidSuffixes.entries()) {
      const imageResponse = await api('/api/admin/ai-catalog/endpoints', {
        method: 'POST', body: JSON.stringify({
          providerId: await createProvider(`task-12-image-suffix-${index}`), capability: 'image_generation', adapterType: 'token_plan_image',
          baseUrl: 'https://catalog.example/api/v1/services/aigc/multimodal-generation/generation',
          config: { mediaHostSuffixes: [suffix] }, enabled: true,
        }),
      }, admin.cookie);
      const ttsResponse = await api('/api/admin/ai-catalog/endpoints', {
        method: 'POST', body: JSON.stringify({
          providerId: await createProvider(`task-12-tts-suffix-${index}`), capability: 'speech_synthesis', adapterType: 'token_plan_tts',
          baseUrl: 'https://catalog.example/api/v1/services/audio/tts/SpeechSynthesizer',
          config: { mediaHostSuffixes: [suffix] }, enabled: true,
        }),
      }, admin.cookie);
      expect(imageResponse.status).toBe(400);
      expect(ttsResponse.status).toBe(400);
    }
  });

  it('keeps endpoint identity stable while allowing an endpoint configuration update', async () => {
    const admin = await createAdmin();
    const provider = await createProvider('task-12-identity-a');
    const otherProvider = await createProvider('task-12-identity-b');
    const created = await api('/api/admin/ai-catalog/endpoints', {
      method: 'POST', body: JSON.stringify({
        providerId: provider, capability: 'structured_text', adapterType: 'openai_text',
        baseUrl: 'https://identity.example/v1', config: { allowCustomModelId: true }, enabled: true,
      }),
    }, admin.cookie);
    const endpointId = (await json<{ id: number }>(created)).data?.id;
    await saveUserModelPreferences(env.DB, admin.body.data?.id ?? 0, {
      preferences: [{
        purpose: 'courseware_text', endpointId: endpointId ?? 0, modelCatalogId: null,
        customModelId: 'private-history-model', voiceId: '', params: {},
      }],
    });
    const changedIdentity = await api(`/api/admin/ai-catalog/endpoints/${endpointId}`, {
      method: 'PUT', body: JSON.stringify({
        providerId: otherProvider, capability: 'structured_text', adapterType: 'openai_text',
        baseUrl: 'https://identity.example/v2', config: { allowCustomModelId: true }, enabled: true,
      }),
    }, admin.cookie);
    expect(changedIdentity.status).toBe(409);
    const changedProtocol = await api(`/api/admin/ai-catalog/endpoints/${endpointId}`, {
      method: 'PUT', body: JSON.stringify({
        providerId: provider, capability: 'speech_synthesis', adapterType: 'token_plan_tts',
        baseUrl: 'https://identity.example/api/v1/services/audio/tts/SpeechSynthesizer',
        config: { mediaHostSuffixes: ['media.example'] }, enabled: true,
      }),
    }, admin.cookie);
    expect(changedProtocol.status).toBe(409);
    expect(await resolvePreference(env.DB, admin.body.data?.id ?? 0, 'courseware_text')).toMatchObject({
      endpointId,
      modelId: 'private-history-model',
      capability: 'structured_text',
    });
    const updated = await api(`/api/admin/ai-catalog/endpoints/${endpointId}`, {
      method: 'PUT', body: JSON.stringify({
        providerId: provider, capability: 'structured_text', adapterType: 'openai_text',
        baseUrl: 'https://identity.example/v2', config: { allowCustomModelId: false }, enabled: false,
      }),
    }, admin.cookie);
    expect(updated.status).toBe(200);
    const stored = await env.DB.prepare(
      'SELECT provider_id, capability, adapter_type, base_url, enabled FROM ai_provider_endpoints WHERE id = ?',
    ).bind(endpointId).first<{ provider_id: number; capability: string; adapter_type: string; base_url: string; enabled: number }>();
    expect(stored).toEqual({ provider_id: provider, capability: 'structured_text', adapter_type: 'openai_text', base_url: 'https://identity.example/v2', enabled: 0 });
  });

  it('forbids non-administrators from catalog and rollout mutations', async () => {
    const admin = await createAdmin();
    const member = await createMember(admin.cookie);
    const responses = await Promise.all([
      api('/api/admin/ai-catalog/providers', { method: 'POST', body: JSON.stringify({ slug: 'task-12-member', displayName: 'No', enabled: true }) }, member.cookie),
      api('/api/admin/courseware/status', { method: 'PUT', body: JSON.stringify({ enabled: true }) }, member.cookie),
      api('/api/admin/courseware/status', {}, member.cookie),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
  });

  it('disables referenced models instead of physically deleting them', async () => {
    const admin = await createAdmin();
    const endpoint = await env.DB.prepare(
      `INSERT INTO ai_provider_endpoints (provider_id, capability, adapter_type, base_url)
       VALUES (?, 'structured_text', 'openai_text', 'https://history.example/v1') RETURNING id`,
    ).bind(await createProvider('task-12-history')).first<{ id: number }>();
    const model = await env.DB.prepare(
      `INSERT INTO ai_models (endpoint_id, capability, model_id, display_name)
       VALUES (?, 'structured_text', 'task-12-history', 'History') RETURNING id`,
    ).bind(endpoint?.id).first<{ id: number }>();
    if (!model || !endpoint) throw new Error('missing model');
    const user = await env.DB.prepare(
      "INSERT INTO users (email, password_hash) VALUES ('history@example.com', 'hash') RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO user_model_preferences (user_id, purpose, endpoint_id, model_catalog_id)
       VALUES (?, 'courseware_text', ?, ?)`,
    ).bind(user?.id, endpoint.id, model.id).run();
    const existing = await env.DB.prepare(
      'SELECT endpoint_id, model_id, display_name, config_json, voices_json, recommended, sort_order FROM ai_models WHERE id = ?',
    ).bind(model.id).first<Record<string, unknown>>();
    const response = await api(`/api/admin/ai-catalog/models/${model.id}`, {
      method: 'PUT', body: JSON.stringify({
        endpointId: existing?.endpoint_id, modelId: existing?.model_id, displayName: existing?.display_name,
        config: JSON.parse(String(existing?.config_json ?? '{}')), voices: JSON.parse(String(existing?.voices_json ?? '[]')),
        recommended: Boolean(existing?.recommended), enabled: false, sortOrder: existing?.sort_order,
      }),
    }, admin.cookie);
    expect(response.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM ai_models WHERE id = ?').bind(model.id).first()).not.toBeNull();
    const catalog = await api('/api/ai-catalog', {}, admin.cookie);
    expect(JSON.stringify((await json(catalog)).data)).not.toContain('task-12-history');
  });

  it('keeps courseware_enabled off until an administrator explicitly enables it', async () => {
    const admin = await createAdmin();
    const before = await api('/api/admin/courseware/status', {}, admin.cookie);
    expect((await json<{ enabled: boolean }>(before)).data?.enabled).toBe(false);
    const enabled = await api('/api/admin/courseware/status', {
      method: 'PUT', body: JSON.stringify({ enabled: true }),
    }, admin.cookie);
    expect((await json<{ enabled: boolean }>(enabled)).data?.enabled).toBe(true);
  });

  it('reports catalog counts and normalized failure counts without child lesson text', async () => {
    const admin = await createAdmin();
    const user = await env.DB.prepare(
      "INSERT INTO users (email, password_hash) VALUES ('parent@example.com', 'hash') RETURNING id",
    ).first<{ id: number }>();
    const student = await env.DB.prepare(
      "INSERT INTO students (user_id, name, grade) VALUES (?, '小明', '三年级') RETURNING id",
    ).bind(user?.id).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO coursewares (student_id, subject, grade, topic, learning_goal, source_text, title, model_snapshot_json, status, error_code, error_message)
       VALUES (?, 'math', '三年级', '孩子课件标题', '目标', '孩子课件正文', '孩子课件标题', '{}', 'failed', 'provider_timeout', '供应商原始报错')`,
    ).bind(student?.id).run();
    const response = await api('/api/admin/courseware/status', {}, admin.cookie);
    const body = await json<Record<string, unknown>>(response);
    expect(body.data).toMatchObject({ providerCount: expect.any(Number), enabledModelCount: expect.any(Number), failedLast24Hours: 1 });
    expect(JSON.stringify(body.data)).not.toContain('孩子课件');
    expect(JSON.stringify(body.data)).not.toContain('供应商原始报错');
  });
});
