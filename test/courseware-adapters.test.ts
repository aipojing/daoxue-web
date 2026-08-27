import { describe, expect, it } from 'vitest';
import {
  ProviderCallError,
  normalizeProviderFailure,
  normalizeProviderResponse,
} from '../src/worker/courseware/adapters/errors';
import { getAdapterKind } from '../src/worker/courseware/adapters/registry';
import type {
  AdapterSelection,
  ImageGenerationAdapter,
  SpeechSynthesisAdapter,
  TextGenerationAdapter,
} from '../src/worker/courseware/adapters/types';
import type { ResolvedModelSelection } from '../src/worker/ai-catalog/repository';

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
