import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AICapability,
  CoursewareModelPreference,
  CoursewareModelPurpose,
} from '../../src/shared/ai-catalog';
import { readBoundedConnectionTestBody } from '../../src/worker/ai-catalog/routes';

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

async function configuredAccount(email: string, apiKey = 'sk-connection-test-only') {
  const registerResponse = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct-password' }),
  });
  expect(registerResponse.status).toBe(200);
  const account = await json<{ id: number }>(registerResponse);
  const userId = account.data?.id ?? 0;
  const cookie = sessionCookie(registerResponse);
  const provider = await env.DB.prepare(
    "SELECT id FROM ai_providers WHERE slug = 'bailian-token-plan'",
  ).first<{ id: number }>();
  if (!provider) throw new Error('missing seeded provider');

  const credentialResponse = await api(
    `/api/courseware-ai-settings/credentials/${provider.id}`,
    { method: 'PUT', body: JSON.stringify({ apiKey }) },
    cookie,
  );
  expect(credentialResponse.status).toBe(200);

  const { results } = await env.DB.prepare(
    `SELECT id, endpoint_id, capability FROM ai_models
     WHERE model_id IN ('qwen3.7-plus', 'qwen-audio-3.0-tts-plus', 'qwen-image-3.0-pro')`,
  ).all<{ id: number; endpoint_id: number; capability: AICapability }>();
  const byCapability = new Map(results.map((row) => [row.capability, row]));
  const selection = (
    purpose: CoursewareModelPurpose,
    capability: AICapability,
    voiceId = '',
  ): CoursewareModelPreference => {
    const model = byCapability.get(capability);
    if (!model) throw new Error(`missing seeded ${capability} model`);
    return {
      purpose,
      endpointId: model.endpoint_id,
      modelCatalogId: model.id,
      customModelId: '',
      voiceId,
      params: {},
    };
  };
  const preferences = {
    preferences: [
      selection('courseware_text', 'structured_text'),
      selection('courseware_image', 'image_generation'),
      selection('teacher_tts', 'speech_synthesis', 'longanlingxin'),
      selection('student_tts', 'speech_synthesis', 'longanlufeng'),
    ],
  };
  const preferenceResponse = await api(
    '/api/courseware-ai-settings/preferences',
    { method: 'PUT', body: JSON.stringify(preferences) },
    cookie,
  );
  expect(preferenceResponse.status).toBe(200);
  return { cookie, userId, providerId: provider.id, apiKey };
}

function textProviderResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: '{"status":"连接成功"}' } }],
    usage: { prompt_tokens: 9, completion_tokens: 4 },
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function usageCount(userId: number): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT request_count FROM ai_connection_test_usage WHERE user_id = ?',
  ).bind(userId).first<{ request_count: number }>();
  return row?.request_count ?? 0;
}

function oversizedStream(
  onCancel: () => void = () => undefined,
  rejectCancel = false,
): ReadableStream<Uint8Array> {
  const chunks = [new Uint8Array(700).fill(32), new Uint8Array(700).fill(32)];
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
    },
    cancel() {
      onCancel();
      if (rejectCancel) throw new Error('cancel must not replace safe 413');
    },
  });
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM users').run();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AI provider connection tests', () => {
  it('tests the selected text model with a fixed harmless prompt and bounded output', async () => {
    const account = await configuredAccount('connection-text@example.com');
    const upstream = vi.fn().mockImplementation(async () => textProviderResponse());
    vi.stubGlobal('fetch', upstream);

    const response = await api(
      '/api/courseware-ai-settings/test/text',
      { method: 'POST', body: '{}' },
      account.cookie,
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      success: true,
      data: { status: 'valid' },
      error: null,
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'qwen3.7-plus',
      messages: [
        { role: 'system', content: '只回复：连接成功' },
        { role: 'user', content: '请执行连接测试。' },
      ],
      max_tokens: 16,
      stream: false,
    });
    expect(await usageCount(account.userId)).toBe(1);
  });

  it('returns speech bytes without persisting the sample to R2', async () => {
    const account = await configuredAccount('connection-speech@example.com');
    const before = (await env.COURSEWARE_MEDIA.list()).objects.map((item) => item.key).sort();
    const upstream = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        output: { audio: { url: 'https://media.aliyuncs.com/sample.mp3' } },
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(async () => new Response(new Uint8Array([73, 68, 51]), {
        headers: { 'Content-Type': 'audio/mpeg' },
      }));
    vi.stubGlobal('fetch', upstream);

    const response = await api(
      '/api/courseware-ai-settings/test/speech',
      { method: 'POST', body: JSON.stringify({ purpose: 'teacher_tts' }) },
      account.cookie,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([73, 68, 51]));
    const [, providerInit] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(providerInit.body))).toMatchObject({
      input: { text: '你好，这是老师语音试听。', voice: 'longanlingxin' },
    });
    expect((await env.COURSEWARE_MEDIA.list()).objects.map((item) => item.key).sort()).toEqual(before);
  });

  it('returns image bytes without exposing or persisting the provider image URL', async () => {
    const account = await configuredAccount('connection-image@example.com');
    const providerImageUrl = 'https://media.aliyuncs.com/private-test-image.png';
    const before = (await env.COURSEWARE_MEDIA.list()).objects.map((item) => item.key).sort();
    const upstream = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: providerImageUrl }] } }] },
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png' },
      }));
    vi.stubGlobal('fetch', upstream);

    const response = await api(
      '/api/courseware-ai-settings/test/image',
      { method: 'POST' },
      account.cookie,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBeNull();
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(new TextDecoder().decode(bytes)).not.toContain(providerImageUrl);
    const [, providerInit] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(providerInit.body))).toMatchObject({
      input: {
        messages: [{
          role: 'user',
          content: [{ text: '儿童教育插图，一只红苹果和一只蓝色铅笔，纯色背景，无文字，无商标' }],
        }],
      },
      parameters: { size: '1024*1024' },
    });
    expect((await env.COURSEWARE_MEDIA.list()).objects.map((item) => item.key).sort()).toEqual(before);
  });

  it('never accepts arbitrary prompts or internal provider configuration from the browser', async () => {
    const account = await configuredAccount('connection-input@example.com');
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const forbidden = { prompt: 'do expensive work', baseUrl: 'https://evil.example', modelId: 'evil' };

    const responses = await Promise.all([
      api('/api/courseware-ai-settings/test/text', {
        method: 'POST', body: JSON.stringify(forbidden),
      }, account.cookie),
      api('/api/courseware-ai-settings/test/speech', {
        method: 'POST', body: JSON.stringify({ purpose: 'teacher_tts', ...forbidden }),
      }, account.cookie),
      api('/api/courseware-ai-settings/test/image', {
        method: 'POST', body: JSON.stringify(forbidden),
      }, account.cookie),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(upstream).not.toHaveBeenCalled();
    expect(await usageCount(account.userId)).toBe(0);
  });

  it.each([
    ['/api/courseware-ai-settings/test/text', '{}'],
    ['/api/courseware-ai-settings/test/speech', '{"purpose":"teacher_tts"}'],
    ['/api/courseware-ai-settings/test/image', '{}'],
  ])('rejects a declared body over 1 KiB before %s reaches the provider', async (path, body) => {
    const account = await configuredAccount(`declared-limit-${path.split('/').at(-1)}@example.com`);
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const response = await api(path, {
      method: 'POST',
      headers: { 'Content-Length': '1025' },
      body,
    }, account.cookie);

    expect(response.status).toBe(413);
    expect(await json(response)).toEqual({
      success: false, data: null, error: '连接测试请求体过大',
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(await usageCount(account.userId)).toBe(0);
  });

  it.each([
    ['missing', undefined],
    ['forged', '2'],
  ])('streams and rejects an oversized body with %s Content-Length', async (_kind, contentLength) => {
    const account = await configuredAccount(`stream-limit-${_kind}@example.com`);
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (contentLength) headers.set('Content-Length', contentLength);

    const response = await api('/api/courseware-ai-settings/test/text', {
      method: 'POST',
      headers,
      body: oversizedStream(),
    }, account.cookie);

    expect(response.status).toBe(413);
    expect((await json(response)).error).toBe('连接测试请求体过大');
    expect(upstream).not.toHaveBeenCalled();
    expect(await usageCount(account.userId)).toBe(0);
  });

  it('keeps the fixed 413 response when oversized-stream cancellation fails', async () => {
    const cancelled = vi.fn();
    const result = await readBoundedConnectionTestBody(
      oversizedStream(cancelled, true),
      undefined,
    );

    expect(result).toEqual({
      ok: false, status: 413, message: '连接测试请求体过大',
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('accepts an exactly 1 KiB valid empty JSON body', async () => {
    const account = await configuredAccount('exact-body-limit@example.com');
    const upstream = vi.fn().mockImplementation(async () => textProviderResponse());
    vi.stubGlobal('fetch', upstream);
    const body = `{${' '.repeat(1022)}}`;
    expect(new TextEncoder().encode(body)).toHaveLength(1024);

    const response = await api('/api/courseware-ai-settings/test/text', {
      method: 'POST', body,
    }, account.cookie);

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await usageCount(account.userId)).toBe(1);
  });

  it('rejects malformed bounded JSON without provider usage', async () => {
    const account = await configuredAccount('malformed-body@example.com');
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const response = await api('/api/courseware-ai-settings/test/text', {
      method: 'POST', body: '{',
    }, account.cookie);

    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect(await usageCount(account.userId)).toBe(0);
  });

  it('atomically enforces twenty connection-test calls per user per UTC day', async () => {
    const account = await configuredAccount('connection-limit@example.com');
    const upstream = vi.fn().mockImplementation(async () => textProviderResponse());
    vi.stubGlobal('fetch', upstream);

    const responses = await Promise.all(Array.from({ length: 21 }, () => api(
      '/api/courseware-ai-settings/test/text',
      { method: 'POST' },
      account.cookie,
    )));

    expect(responses.filter((response) => response.status === 200)).toHaveLength(20);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect(upstream).toHaveBeenCalledTimes(20);
    expect(await usageCount(account.userId)).toBe(20);
  });

  it('returns safe invalid-key and quota-exhausted errors, counts failures, and updates readiness', async () => {
    const account = await configuredAccount('connection-errors@example.com');
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response('provider request-id secret body', { status: 401 }))
      .mockImplementationOnce(async () => new Response('provider quota body', { status: 402 }))
      .mockImplementationOnce(async () => textProviderResponse()));

    const invalidResponse = await api(
      '/api/courseware-ai-settings/test/text', { method: 'POST' }, account.cookie,
    );
    expect(invalidResponse.status).toBe(401);
    expect(await json(invalidResponse)).toEqual({
      success: false, data: null, error: '模型服务密钥无效',
    });

    const quotaResponse = await api(
      '/api/courseware-ai-settings/test/text', { method: 'POST' }, account.cookie,
    );
    expect(quotaResponse.status).toBe(402);
    expect(await json(quotaResponse)).toEqual({
      success: false, data: null, error: '模型套餐额度已用完',
    });
    expect(await usageCount(account.userId)).toBe(2);

    const settings = await json<{ readiness: { text: string } }>(
      await api('/api/courseware-ai-settings', {}, account.cookie),
    );
    expect(settings.data?.readiness.text).toBe('quota_exhausted');

    const recovered = await api(
      '/api/courseware-ai-settings/test/text', { method: 'POST' }, account.cookie,
    );
    expect(recovered.status).toBe(200);
    const recoveredSettings = await json<{ readiness: { text: string } }>(
      await api('/api/courseware-ai-settings', {}, account.cookie),
    );
    expect(recoveredSettings.data?.readiness.text).toBe('ready');
  });

  it('does not expose decrypted keys, provider bodies, request ids, or URLs in responses or logs', async () => {
    const secret = 'sk-never-render-this-value';
    const account = await configuredAccount('connection-secrets@example.com', secret);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new Error(`${secret} https://internal.provider.example request-id-sensitive`),
    ));

    const response = await api(
      '/api/courseware-ai-settings/test/text', { method: 'POST' }, account.cookie,
    );
    const serialized = JSON.stringify(await json(response));

    expect(response.status).toBe(503);
    expect(serialized).toContain('模型服务暂时不可用');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('internal.provider.example');
    expect(serialized).not.toContain('request-id-sensitive');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
  });

  it('does not let an in-flight result overwrite the health of a replacement key', async () => {
    const account = await configuredAccount('connection-revision@example.com', 'sk-old-revision');
    let finishProvider: (() => void) | undefined;
    const providerGate = new Promise<void>((resolve) => { finishProvider = resolve; });
    const upstream = vi.fn().mockImplementation(async () => {
      await providerGate;
      return textProviderResponse();
    });
    vi.stubGlobal('fetch', upstream);

    const testResponsePromise = api(
      '/api/courseware-ai-settings/test/text', { method: 'POST' }, account.cookie,
    );
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    const replacement = await api(
      `/api/courseware-ai-settings/credentials/${account.providerId}`,
      { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-new-revision' }) },
      account.cookie,
    );
    expect(replacement.status).toBe(200);
    finishProvider?.();
    const testResponse = await testResponsePromise;
    expect(testResponse.status).toBe(200);

    const row = await env.DB.prepare(
      'SELECT health_status FROM user_ai_credentials WHERE user_id = ? AND provider_id = ?',
    ).bind(account.userId, account.providerId).first<{ health_status: string }>();
    expect(row?.health_status).toBe('unknown');
  });

  it('keeps credential health unchanged for transient provider and decryption infrastructure failures', async () => {
    const account = await configuredAccount('connection-transient@example.com');
    await env.DB.prepare(
      `UPDATE user_ai_credentials SET health_status = 'valid'
       WHERE user_id = ? AND provider_id = ?`,
    ).bind(account.userId, account.providerId).run();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('temporary', { status: 503 })));

    const transient = await api(
      '/api/courseware-ai-settings/test/text', { method: 'POST' }, account.cookie,
    );
    expect(transient.status).toBe(503);
    let row = await env.DB.prepare(
      'SELECT health_status FROM user_ai_credentials WHERE user_id = ? AND provider_id = ?',
    ).bind(account.userId, account.providerId).first<{ health_status: string }>();
    expect(row?.health_status).toBe('valid');

    await env.DB.prepare(
      "UPDATE user_ai_credentials SET key_ciphertext = 'corrupted' WHERE user_id = ? AND provider_id = ?",
    ).bind(account.userId, account.providerId).run();
    const decryptFailure = await api(
      '/api/courseware-ai-settings/test/text', { method: 'POST' }, account.cookie,
    );
    expect(decryptFailure.status).toBe(503);
    row = await env.DB.prepare(
      'SELECT health_status FROM user_ai_credentials WHERE user_id = ? AND provider_id = ?',
    ).bind(account.userId, account.providerId).first<{ health_status: string }>();
    expect(row?.health_status).toBe('valid');
    expect(await usageCount(account.userId)).toBe(1);
  });
});
