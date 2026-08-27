import {
  assertPublicHttpsUrl,
  discardResponseBody,
  fetchAllowedMedia,
  readBoundedJson,
} from '../../lib/outbound-url';
import { ProviderCallError, normalizeProviderResponse } from './errors';
import { normalizeOutboundError, readTemporaryMedia } from './media-response';
import type { ImageGenerationAdapter } from './types';

const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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

export const tokenPlanImageAdapter: ImageGenerationAdapter = {
  async generate(request) {
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
            messages: [{
              role: 'user',
              content: [{ text: request.prompt }],
            }],
          },
          parameters: { size: request.size },
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
    if (!isRecord(parsed) || !isRecord(parsed.output) || !Array.isArray(parsed.output.choices) ||
        parsed.output.choices.length < 1 || parsed.output.choices.length > 16) {
      throw new ProviderCallError('invalid_model_output', 502);
    }
    const firstChoice = parsed.output.choices[0];
    if (!isRecord(firstChoice) || !isRecord(firstChoice.message) ||
        !Array.isArray(firstChoice.message.content) || firstChoice.message.content.length > 64 ||
        !firstChoice.message.content.every(isRecord)) {
      throw new ProviderCallError('invalid_model_output', 502);
    }
    const imageValue = firstChoice.message.content.find((item) => typeof item.image === 'string')?.image;
    if (typeof imageValue !== 'string' || !imageValue) {
      throw new ProviderCallError('invalid_model_output', 502);
    }

    let download: Response;
    try {
      download = await fetchAllowedMedia(
        imageValue,
        request.allowedMediaHostSuffixes,
        remainingTimeoutMs(deadline),
      );
    } catch (error) {
      throw normalizeOutboundError(error);
    }
    const headerRequestId = response.headers.get('x-request-id');
    const requestId = safeRequestId(headerRequestId, request.apiKey) ||
      safeRequestId(parsed.request_id, request.apiKey);
    return readTemporaryMedia(
      download,
      MAX_IMAGE_RESPONSE_BYTES,
      ALLOWED_IMAGE_CONTENT_TYPES,
      requestId,
    );
  },
};
