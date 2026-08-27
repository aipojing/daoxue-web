import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderCallError,
  normalizeProviderFailure,
  normalizeProviderResponse,
} from '../src/worker/courseware/adapters/errors';
import { openAITextAdapter } from '../src/worker/courseware/adapters/openai-text';
import {
  createImageAdapter,
  createSpeechAdapter,
  createTextAdapter,
  getAdapterKind,
} from '../src/worker/courseware/adapters/registry';
import { tokenPlanImageAdapter } from '../src/worker/courseware/adapters/token-plan-image';
import { tokenPlanTTSAdapter } from '../src/worker/courseware/adapters/token-plan-tts';
import type {
  AdapterSelection,
  ImageGenerationAdapter,
  ImageGenerationRequest,
  SpeechSynthesisAdapter,
  TextGenerationAdapter,
} from '../src/worker/courseware/adapters/types';
import type { ResolvedModelSelection } from '../src/worker/ai-catalog/repository';

afterEach(() => vi.unstubAllGlobals());

function imageRequest(
  overrides: Partial<ImageGenerationRequest> = {},
): ImageGenerationRequest {
  return {
    baseUrl: 'https://provider.example/image',
    apiKey: 'sk-sp-test',
    modelId: 'qwen-image-3.0-pro',
    prompt: '适合三年级的分数示意图',
    size: '1024*1024',
    allowedMediaHostSuffixes: ['cdn.example'],
    timeoutMs: 1000,
    ...overrides,
  };
}

function mockImageGenerationResponse(imageUrl: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    output: { choices: [{ message: { content: [{ image: imageUrl }] } }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

describe('courseware adapter errors', () => {
  it.each([
    [401, 'invalid_credential', false],
    [402, 'quota_exhausted', false],
    [408, 'provider_timeout', true],
    [429, 'rate_limited', true],
    [500, 'provider_unavailable', true],
  ] as const)('maps HTTP %s to %s', (status, errorCode, retryable) => {
    expect(normalizeProviderFailure(status)).toMatchObject({ errorCode, retryable });
  });

  it.each([
    [404, 'model_unavailable', false],
    [422, 'model_unavailable', false],
    [503, 'provider_unavailable', true],
  ] as const)('gives every fallback error a stable retry policy', (status, errorCode, retryable) => {
    expect(normalizeProviderFailure(status)).toMatchObject({ errorCode, retryable });
  });

  it('maps catalog adapter types to one capability kind', () => {
    expect(getAdapterKind('openai_text')).toBe('text');
    expect(getAdapterKind('token_plan_tts')).toBe('speech');
    expect(getAdapterKind('token_plan_image')).toBe('image');
  });

  it.each([
    ['InvalidApiKey', 'invalid_credential', false],
    ['Arrearage', 'quota_exhausted', false],
    ['AllocationQuota.FreeTierOnly', 'quota_exhausted', false],
    ['Throttling', 'rate_limited', true],
    ['ModelNotFound', 'model_unavailable', false],
    ['RequestTimeout', 'provider_timeout', true],
  ] as const)('maps bounded provider code %s without returning its raw message', async (code, errorCode, retryable) => {
    const error = await normalizeProviderResponse(new Response(JSON.stringify({
      code,
      message: 'raw provider detail must not escape',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    expect(error).toMatchObject({ errorCode, retryable });
    expect(error.message).not.toContain('raw provider detail');
  });

  it('does not parse a provider response body outside JSON or text MIME types', async () => {
    const error = await normalizeProviderResponse(new Response('InvalidApiKey raw provider detail', {
      status: 500,
      headers: { 'Content-Type': 'application/octet-stream' },
    }));
    expect(error).toMatchObject({ errorCode: 'provider_unavailable', retryable: true });
    expect(error.message).not.toContain('raw provider detail');
  });

  it('falls back to a public provider error when reading an error body fails', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error('raw transport detail must not escape'));
      },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });

    await expect(normalizeProviderResponse(response)).resolves.toMatchObject({
      errorCode: 'provider_unavailable',
      retryable: true,
    });
  });

  it('derives public message and retryability exclusively from the error code', () => {
    const quota = new ProviderCallError('quota_exhausted', 402);
    const credential = new ProviderCallError('invalid_credential', 401);
    const unsupported = new ProviderCallError('model_unavailable', 404);

    expect(quota).toMatchObject({ errorCode: 'quota_exhausted', retryable: false });
    expect(credential).toMatchObject({ errorCode: 'invalid_credential', retryable: false });
    expect(unsupported).toMatchObject({ errorCode: 'model_unavailable', retryable: false });
    expect(JSON.stringify(quota)).not.toContain('requestId');
  });

  it('makes public provider error fields immutable at JavaScript runtime', () => {
    const error = new ProviderCallError('invalid_credential', 401);
    const mutable = error as unknown as {
      message: string;
      errorCode: string;
      retryable: boolean;
    };

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProviderCallError');
    expect(error.stack).toContain('ProviderCallError');
    expect(() => {
      mutable.message = 'raw provider body must not escape';
    }).toThrow(TypeError);
    expect(() => {
      mutable.errorCode = 'rate_limited';
    }).toThrow(TypeError);
    expect(() => {
      mutable.retryable = true;
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(error, 'message', { value: 'raw provider body must not escape' });
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(error, 'errorCode', { value: 'rate_limited' });
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(error, 'retryable', { value: true });
    }).toThrow(TypeError);
    expect(error).toMatchObject({
      message: '模型服务密钥无效',
      errorCode: 'invalid_credential',
      retryable: false,
    });
  });

  it.each([
    [401, 'Throttling', 'invalid_credential', false],
    [402, 'ModelNotFound', 'quota_exhausted', false],
    [404, 'RequestTimeout', 'model_unavailable', false],
    [503, 'InvalidApiKey', 'provider_unavailable', true],
  ] as const)('keeps explicit HTTP %s classification when provider code conflicts', async (
    status,
    code,
    errorCode,
    retryable,
  ) => {
    const error = await normalizeProviderResponse(new Response(JSON.stringify({
      code,
      message: 'raw message must not escape',
    }), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': 'raw-provider-request-id',
      },
    }));

    expect(error).toMatchObject({ errorCode, retryable });
    expect(error.message).not.toContain('raw message');
    expect(JSON.stringify(error)).not.toContain('raw-provider-request-id');
  });
});

describe('courseware adapter contracts', () => {
  it('accepts the resolved selection fields required by capability adapters', () => {
    const selection = {
      purpose: 'teacher_tts',
      providerId: 1,
      providerSlug: 'token-plan',
      endpointId: 2,
      adapterType: 'token_plan_tts',
      baseUrl: 'https://example.test/v1',
      capability: 'speech_synthesis',
      modelId: 'tts-model',
      voiceId: 'teacher-voice',
      endpointConfig: {},
      modelConfig: {},
      params: {},
    } satisfies ResolvedModelSelection;
    const adapterSelection: AdapterSelection = selection;

    const textAdapter: TextGenerationAdapter = {
      async generateStructured(request) {
        return { jsonText: request.user, requestId: '', inputTokens: 0, outputTokens: 0 };
      },
    };
    const speechAdapter: SpeechSynthesisAdapter = {
      async synthesize() {
        return { bytes: new ArrayBuffer(0), contentType: 'audio/mpeg', requestId: '' };
      },
    };
    const imageAdapter: ImageGenerationAdapter = {
      async generate() {
        return { bytes: new ArrayBuffer(0), contentType: 'image/png', requestId: '' };
      },
    };

    expect([textAdapter, speechAdapter, imageAdapter]).toHaveLength(3);
    expect(adapterSelection.voiceId).toBe('teacher-voice');
  });
});

describe('concrete courseware adapters', () => {
  it('creates only the concrete adapter requested by the catalog', () => {
    expect(createTextAdapter('openai_text')).toBe(openAITextAdapter);
    expect(createSpeechAdapter('token_plan_tts')).toBe(tokenPlanTTSAdapter);
    expect(createImageAdapter('token_plan_image')).toBe(tokenPlanImageAdapter);
    expect(() => createTextAdapter('token_plan_tts')).toThrow('文本适配器类型不受支持');
    expect(() => createSpeechAdapter('token_plan_image')).toThrow('语音适配器类型不受支持');
    expect(() => createImageAdapter('openai_text')).toThrow('图片适配器类型不受支持');
  });

  it('calls OpenAI-compatible JSON generation using only request configuration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'request-1',
      choices: [{ message: { content: '{"schemaVersion":1}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await openAITextAdapter.generateStructured({
      baseUrl: 'https://provider.example/v1/',
      apiKey: 'secret-key',
      modelId: 'model-a',
      system: 'system',
      user: 'user',
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      jsonText: '{"schemaVersion":1}',
      requestId: 'request-1',
      inputTokens: 12,
      outputTokens: 8,
    });
    expect(JSON.stringify(result)).not.toContain('secret-key');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://provider.example/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-key');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'model-a',
      response_format: { type: 'json_object' },
      stream: false,
    });
  });

  it('returns Token Plan TTS bytes from the synchronous binary response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([73, 68, 51]),
      { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'X-Request-Id': 'tts-1' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await tokenPlanTTSAdapter.synthesize({
      baseUrl: 'https://provider.example/tts',
      apiKey: 'sk-sp-test',
      modelId: 'qwen-audio-3.0-tts-plus',
      voiceId: 'longanlingxin',
      text: '你好',
      format: 'mp3',
      sampleRate: 24000,
      timeoutMs: 1000,
    });

    expect(result.contentType).toBe('audio/mpeg');
    expect(result.requestId).toBe('tts-1');
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([73, 68, 51]));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'qwen-audio-3.0-tts-plus',
      input: { voice: 'longanlingxin', format: 'mp3', sample_rate: 24000 },
    });
  });

  it('downloads the temporary image URL without forwarding provider credentials', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: 'https://cdn.example/image.png' }] } }] },
        request_id: 'image-1',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await tokenPlanImageAdapter.generate(imageRequest({
      prompt: '适合三年级的二分之一示意图',
    }));

    expect(result.contentType).toBe('image/png');
    expect(result.requestId).toBe('image-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [downloadUrl, downloadInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(downloadUrl).toBe('https://cdn.example/image.png');
    expect(downloadInit.redirect).toBe('manual');
    expect(new Headers(downloadInit.headers).has('authorization')).toBe(false);
    expect(new Headers(downloadInit.headers).has('cookie')).toBe(false);
  });

  it.each([
    'http://cdn.example/image.png',
    'https://user:pass@cdn.example/image.png',
    'https://localhost/image.png',
    'https://printer.local/image.png',
    'https://127.0.0.1/image.png',
    'https://0.0.0.0/image.png',
    'https://10.0.0.1/image.png',
    'https://172.16.0.1/image.png',
    'https://192.168.1.1/image.png',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/image.png',
    'https://[::1]/image.png',
    'https://[::]/image.png',
    'https://[fe80::1]/image.png',
    'https://[fc00::1]/image.png',
    'https://cdn.attacker.example/image.png',
  ])('rejects an unsafe or unapproved provider media URL: %s', async (imageUrl) => {
    mockImageGenerationResponse(imageUrl);
    await expect(tokenPlanImageAdapter.generate(imageRequest({
      allowedMediaHostSuffixes: ['aliyuncs.com'],
    }))).rejects.toMatchObject({ errorCode: 'invalid_model_output' });
  });

  it('allows an exact media host or dot-delimited subdomain match', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: 'https://img.cdn.example/image.png' }] } }] },
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': 'image/webp' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(tokenPlanImageAdapter.generate(imageRequest())).resolves.toMatchObject({
      contentType: 'image/webp',
    });
  });

  it('validates every temporary-media redirect and follows at most three', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: 'https://cdn.example/start' }] } }] },
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/one' } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: '/two' } }))
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Location: '/three' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': 'image/jpeg' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(tokenPlanImageAdapter.generate(imageRequest())).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('rejects an unsafe temporary-media redirect without exposing its URL', async () => {
    const unsafeUrl = 'https://169.254.169.254/latest/meta-data?secret=raw-url';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: 'https://cdn.example/start' }] } }] },
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: unsafeUrl } }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await tokenPlanImageAdapter.generate(imageRequest()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ errorCode: 'invalid_model_output' });
    expect(JSON.stringify(error)).not.toContain(unsafeUrl);
  });

  it('rejects a fourth temporary-media redirect', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: 'https://cdn.example/start' }] } }] },
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValue(new Response(null, { status: 302, headers: { Location: '/next' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(tokenPlanImageAdapter.generate(imageRequest())).rejects.toMatchObject({
      errorCode: 'invalid_model_output',
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe('courseware adapter response boundaries', () => {
  it.each([
    ['text', () => openAITextAdapter.generateStructured({
      baseUrl: 'https://provider.example/v1', apiKey: 'key', modelId: 'model',
      system: 'system', user: 'user', timeoutMs: 1000,
    })],
    ['speech', () => tokenPlanTTSAdapter.synthesize({
      baseUrl: 'https://provider.example/tts', apiKey: 'key', modelId: 'model',
      voiceId: 'voice', text: 'text', format: 'mp3', sampleRate: 24000, timeoutMs: 1000,
    })],
    ['image', () => tokenPlanImageAdapter.generate(imageRequest())],
  ] as const)('normalizes %s network failures without exposing transport details', async (_kind, call) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('secret-key raw network detail')));
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ errorCode: 'provider_unavailable', retryable: true });
    expect(JSON.stringify(error)).not.toContain('secret-key');
    expect(error).toBeInstanceOf(ProviderCallError);
  });

  it.each([
    ['text', () => openAITextAdapter.generateStructured({
      baseUrl: 'https://provider.example/v1', apiKey: 'key', modelId: 'model',
      system: 'system', user: 'user', timeoutMs: 1000,
    })],
    ['speech', () => tokenPlanTTSAdapter.synthesize({
      baseUrl: 'https://provider.example/tts', apiKey: 'key', modelId: 'model',
      voiceId: 'voice', text: 'text', format: 'mp3', sampleRate: 24000, timeoutMs: 1000,
    })],
    ['image', () => tokenPlanImageAdapter.generate(imageRequest())],
  ] as const)('normalizes %s timeouts', async (_kind, call) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('raw timeout', 'TimeoutError')));
    await expect(call()).rejects.toMatchObject({ errorCode: 'provider_timeout', retryable: true });
  });

  it('requires JSON MIME and valid bounded JSON for structured text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', {
      headers: { 'Content-Type': 'text/html' },
    })));
    await expect(openAITextAdapter.generateStructured({
      baseUrl: 'https://provider.example/v1', apiKey: 'key', modelId: 'model',
      system: 'system', user: 'user', timeoutMs: 1000,
    })).rejects.toMatchObject({ errorCode: 'invalid_model_output' });
  });

  it('rejects declared and actual structured-text bodies over 1 MiB', async () => {
    const request = {
      baseUrl: 'https://provider.example/v1', apiKey: 'key', modelId: 'model',
      system: 'system', user: 'user', timeoutMs: 1000,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(1024 * 1024 + 1) },
    })));
    await expect(openAITextAdapter.generateStructured(request)).rejects.toMatchObject({
      errorCode: 'invalid_model_output',
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(1024 * 1024 + 1), {
      headers: { 'Content-Type': 'application/json' },
    })));
    await expect(openAITextAdapter.generateStructured(request)).rejects.toMatchObject({
      errorCode: 'invalid_model_output',
    });
  });

  it.each(['audio/wav', 'audio/mpegurl', 'text/html'])('accepts no speech MIME except audio/mpeg: %s', async (contentType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: { 'Content-Type': contentType },
    })));
    await expect(tokenPlanTTSAdapter.synthesize({
      baseUrl: 'https://provider.example/tts', apiKey: 'key', modelId: 'model',
      voiceId: 'voice', text: 'text', format: 'mp3', sampleRate: 24000, timeoutMs: 1000,
    })).rejects.toMatchObject({ errorCode: 'invalid_model_output' });
  });

  it('rejects declared and actual speech bodies over 2 MiB', async () => {
    const request = {
      baseUrl: 'https://provider.example/tts', apiKey: 'key', modelId: 'model',
      voiceId: 'voice', text: 'text', format: 'mp3' as const, sampleRate: 24000 as const, timeoutMs: 1000,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1]), {
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(2 * 1024 * 1024 + 1) },
    })));
    await expect(tokenPlanTTSAdapter.synthesize(request)).rejects.toMatchObject({
      errorCode: 'invalid_model_output',
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
      headers: { 'Content-Type': 'audio/mpeg' },
    })));
    await expect(tokenPlanTTSAdapter.synthesize(request)).rejects.toMatchObject({
      errorCode: 'invalid_model_output',
    });
  });

  it.each(['image/svg+xml', 'image/gif', 'text/html'])('accepts no generated-image MIME outside the safe allowlist: %s', async (contentType) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: 'https://cdn.example/image' }] } }] },
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': contentType },
      }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(tokenPlanImageAdapter.generate(imageRequest())).rejects.toMatchObject({
      errorCode: 'invalid_model_output',
    });
  });

  it('rejects declared and actual generated-image bodies over 8 MiB', async () => {
    const generation = () => new Response(JSON.stringify({
      output: { choices: [{ message: { content: [{ image: 'https://cdn.example/image' }] } }] },
    }), { headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(generation())
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(8 * 1024 * 1024 + 1) },
      })));
    await expect(tokenPlanImageAdapter.generate(imageRequest())).rejects.toMatchObject({
      errorCode: 'invalid_model_output',
    });

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(generation())
      .mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
        headers: { 'Content-Type': 'image/png' },
      })));
    await expect(tokenPlanImageAdapter.generate(imageRequest())).rejects.toMatchObject({
      errorCode: 'invalid_model_output',
    });
  });

  it.each([
    ['text', 'http://provider.example/v1', () => openAITextAdapter.generateStructured({
      baseUrl: 'http://provider.example/v1', apiKey: 'key', modelId: 'model',
      system: 'system', user: 'user', timeoutMs: 1000,
    })],
    ['speech', 'https://127.0.0.1/tts', () => tokenPlanTTSAdapter.synthesize({
      baseUrl: 'https://127.0.0.1/tts', apiKey: 'key', modelId: 'model',
      voiceId: 'voice', text: 'text', format: 'mp3', sampleRate: 24000, timeoutMs: 1000,
    })],
    ['image', 'https://[::1]/image', () => tokenPlanImageAdapter.generate(imageRequest({
      baseUrl: 'https://[::1]/image',
    }))],
  ] as const)('rejects an unsafe %s provider endpoint before fetch: %s', async (_kind, _url, call) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(call()).rejects.toMatchObject({ errorCode: 'invalid_model_output' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
