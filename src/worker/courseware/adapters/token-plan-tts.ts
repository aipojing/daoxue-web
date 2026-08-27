import {
  OutboundRequestError,
  assertPublicHttpsUrl,
  readBoundedResponseBytes,
} from '../../lib/outbound-url';
import { ProviderCallError, normalizeProviderResponse } from './errors';
import type { SpeechSynthesisAdapter } from './types';

const MAX_SPEECH_RESPONSE_BYTES = 2 * 1024 * 1024;

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

function normalizeReadError(error: unknown): ProviderCallError {
  if (error instanceof OutboundRequestError && error.kind === 'timeout') {
    return new ProviderCallError('provider_timeout', 408);
  }
  if (error instanceof OutboundRequestError && error.kind === 'unavailable') {
    return new ProviderCallError('provider_unavailable', 503);
  }
  return new ProviderCallError('invalid_model_output', 502);
}

function safeRequestId(value: string | null, apiKey: string): string {
  return value && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value) && !value.includes(apiKey)
    ? value
    : '';
}

export const tokenPlanTTSAdapter: SpeechSynthesisAdapter = {
  async synthesize(request) {
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
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      if (error instanceof ProviderCallError) throw error;
      if (isTimeoutError(error)) throw new ProviderCallError('provider_timeout', 408);
      throw new ProviderCallError('provider_unavailable', 503);
    }
    if (!response.ok) throw await normalizeProviderResponse(response);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (contentType !== 'audio/mpeg') throw new ProviderCallError('invalid_model_output', 502);

    try {
      const bytes = await readBoundedResponseBytes(response, MAX_SPEECH_RESPONSE_BYTES);
      return {
        bytes: bytes.slice().buffer,
        contentType,
        requestId: safeRequestId(response.headers.get('x-request-id'), request.apiKey),
      };
    } catch (error) {
      throw normalizeReadError(error);
    }
  },
};
