import {
  assertPublicHttpsUrl,
  discardResponseBody,
  fetchAllowedMedia,
  readBoundedJson,
} from '../../lib/outbound-url';
import { ProviderCallError, normalizeProviderResponse } from './errors';
import { normalizeOutboundError, readTemporaryMedia } from './media-response';
import type { SpeechSynthesisAdapter } from './types';

const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_SPEECH_RESPONSE_BYTES = 2 * 1024 * 1024;
const ALLOWED_SPEECH_CONTENT_TYPES = new Set(['audio/mpeg']);

function isTimeoutError(error: unknown): boolean {
  return error instanceof Object &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function endpointUrl(value: string): string {
  try {
    return assertPublicHttpsUrl(value);
  } catch {
    throw new ProviderCallError('invalid_model_output', 502);
  }
}

function safeRequestId(value: unknown, apiKey: string): string {
  return typeof value === 'string' && value.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(value) && !value.includes(apiKey)
    ? value
    : '';
}

function isJsonContentType(response: Response): boolean {
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mime === 'application/json' || mime.endsWith('+json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function remainingTimeoutMs(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) throw new ProviderCallError('provider_timeout', 408);
  return remaining;
}

export const tokenPlanTTSAdapter: SpeechSynthesisAdapter = {
  async synthesize(request) {
    const deadline = performance.now() + request.timeoutMs;
    let response: Response;
    try {
      response = await fetch(endpointUrl(request.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify({
          model: request.modelId,
          input: {
            text: request.text,
            voice: request.voiceId,
            format: request.format,
            sample_rate: request.sampleRate,
          },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(remainingTimeoutMs(deadline)),
      });
    } catch (error) {
      if (error instanceof ProviderCallError) throw error;
      if (isTimeoutError(error)) throw new ProviderCallError('provider_timeout', 408);
      throw new ProviderCallError('provider_unavailable', 503);
    }
    if (!response.ok) throw await normalizeProviderResponse(response);
    if (!isJsonContentType(response)) {
      await discardResponseBody(response);
      throw new ProviderCallError('invalid_model_output', 502);
    }

    let parsed: unknown;
    try {
      parsed = await readBoundedJson(response, MAX_JSON_RESPONSE_BYTES);
    } catch (error) {
      throw normalizeOutboundError(error);
    }
    if (!isRecord(parsed) || !isRecord(parsed.output) || !isRecord(parsed.output.audio) ||
        typeof parsed.output.audio.url !== 'string' || !parsed.output.audio.url) {
      throw new ProviderCallError('invalid_model_output', 502);
    }

    let download: Response;
    try {
      download = await fetchAllowedMedia(
        parsed.output.audio.url,
        request.allowedMediaHostSuffixes,
        remainingTimeoutMs(deadline),
        { upgradeHttpToHttps: true },
      );
    } catch (error) {
      throw normalizeOutboundError(error);
    }
    const requestId = safeRequestId(response.headers.get('x-request-id'), request.apiKey) ||
      safeRequestId(parsed.request_id, request.apiKey);
    return readTemporaryMedia(
      download,
      MAX_SPEECH_RESPONSE_BYTES,
      ALLOWED_SPEECH_CONTENT_TYPES,
      requestId,
    );
  },
};
