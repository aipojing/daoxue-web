import {
  OutboundRequestError,
  assertAllowedMediaUrl,
  assertPublicHttpsUrl,
  fetchAllowedMedia,
  readBoundedResponseBytes,
} from '../../lib/outbound-url';
import { ProviderCallError, normalizeProviderResponse } from './errors';
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

function normalizeOutboundError(error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  if (error instanceof OutboundRequestError && error.kind === 'timeout') {
    return new ProviderCallError('provider_timeout', 408);
  }
  if (error instanceof OutboundRequestError && error.kind === 'unavailable') {
    return new ProviderCallError('provider_unavailable', 503);
  }
  return new ProviderCallError('invalid_model_output', 502);
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

export const tokenPlanImageAdapter: ImageGenerationAdapter = {
  async generate(request) {
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
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      if (error instanceof ProviderCallError) throw error;
      if (isTimeoutError(error)) throw new ProviderCallError('provider_timeout', 408);
      throw new ProviderCallError('provider_unavailable', 503);
    }
    if (!response.ok) throw await normalizeProviderResponse(response);
    if (!isJsonContentType(response)) throw new ProviderCallError('invalid_model_output', 502);

    let body: {
      request_id?: unknown;
      output?: {
        choices?: Array<{
          message?: { content?: Array<{ image?: unknown }> };
        }>;
      };
    };
    try {
      const bytes = await readBoundedResponseBytes(response, MAX_JSON_RESPONSE_BYTES);
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as typeof body;
    } catch (error) {
      throw normalizeOutboundError(error);
    }
    const imageUrl = body?.output?.choices?.[0]?.message?.content?.find(
      (item) => typeof item.image === 'string',
    )?.image;
    if (typeof imageUrl !== 'string') throw new ProviderCallError('invalid_model_output', 502);

    let safeImageUrl: string;
    let download: Response;
    try {
      safeImageUrl = assertAllowedMediaUrl(imageUrl, request.allowedMediaHostSuffixes);
      download = await fetchAllowedMedia(safeImageUrl, request.allowedMediaHostSuffixes, request.timeoutMs);
    } catch (error) {
      throw normalizeOutboundError(error);
    }
    const headerRequestId = response.headers.get('x-request-id');
    const requestId = safeRequestId(headerRequestId, request.apiKey) ||
      safeRequestId(body.request_id, request.apiKey);
    if (!download.ok) throw await normalizeProviderResponse(download);
    const contentType = download.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
      throw new ProviderCallError('invalid_model_output', 502);
    }
    try {
      const bytes = await readBoundedResponseBytes(download, MAX_IMAGE_RESPONSE_BYTES);
      return { bytes: bytes.slice().buffer, contentType, requestId };
    } catch (error) {
      throw normalizeOutboundError(error);
    }
  },
};
