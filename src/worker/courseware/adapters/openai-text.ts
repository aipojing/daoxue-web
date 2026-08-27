import {
  OutboundRequestError,
  assertPublicHttpsUrl,
  discardResponseBody,
  readBoundedJson,
} from '../../lib/outbound-url';
import { ProviderCallError, normalizeProviderResponse } from './errors';
import type { TextGenerationAdapter } from './types';

const MAX_TEXT_RESPONSE_BYTES = 1024 * 1024;

function isTimeoutError(error: unknown): boolean {
  return error instanceof Object &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function normalizeReadError(error: unknown): ProviderCallError {
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

function textEndpoint(baseUrl: string): string {
  try {
    const endpoint = new URL(assertPublicHttpsUrl(baseUrl));
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/chat/completions`;
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.toString();
  } catch {
    throw new ProviderCallError('invalid_model_output', 502);
  }
}

function isJsonContentType(response: Response): boolean {
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mime === 'application/json' || mime.endsWith('+json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const openAITextAdapter: TextGenerationAdapter = {
  async generateStructured(request) {
    const endpoint = textEndpoint(request.baseUrl);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify({
          model: request.modelId,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          response_format: { type: 'json_object' },
          stream: false,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
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
      parsed = await readBoundedJson(response, MAX_TEXT_RESPONSE_BYTES);
    } catch (error) {
      throw normalizeReadError(error);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.choices) ||
        parsed.choices.length < 1 || parsed.choices.length > 16) {
      throw new ProviderCallError('invalid_model_output', 502);
    }
    const firstChoice = parsed.choices[0];
    if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
      throw new ProviderCallError('invalid_model_output', 502);
    }
    const jsonText = firstChoice.message.content;
    if (typeof jsonText !== 'string' || !jsonText.trim()) {
      throw new ProviderCallError('invalid_model_output', 502);
    }
    const usage = parsed.usage;
    if (usage !== undefined && !isRecord(usage)) {
      throw new ProviderCallError('invalid_model_output', 502);
    }
    const inputTokens = usage?.prompt_tokens;
    const outputTokens = usage?.completion_tokens;
    const headerRequestId = response.headers.get('x-request-id');
    return {
      jsonText,
      requestId: safeRequestId(headerRequestId, request.apiKey) || safeRequestId(parsed.id, request.apiKey),
      inputTokens: Number.isSafeInteger(inputTokens) && (inputTokens as number) >= 0
        ? inputTokens as number
        : 0,
      outputTokens: Number.isSafeInteger(outputTokens) && (outputTokens as number) >= 0
        ? outputTokens as number
        : 0,
    };
  },
};
