import {
  OutboundRequestError,
  discardResponseBody,
  readBoundedResponseBytes,
} from '../../lib/outbound-url';
import { ProviderCallError } from './errors';
import type { BinaryMediaResult } from './types';

export function normalizeOutboundError(error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  if (error instanceof OutboundRequestError && error.kind === 'timeout') {
    return new ProviderCallError('provider_timeout', 408);
  }
  if (error instanceof OutboundRequestError && error.kind === 'unavailable') {
    return new ProviderCallError('provider_unavailable', 503);
  }
  return new ProviderCallError('invalid_model_output', 502);
}

async function temporaryMediaFailure(response: Response): Promise<ProviderCallError> {
  await discardResponseBody(response);
  if (response.status === 429) return new ProviderCallError('rate_limited', 429);
  if (response.status === 408 || response.status === 504) {
    return new ProviderCallError('provider_timeout', 408);
  }
  if (response.status >= 500) return new ProviderCallError('provider_unavailable', 503);
  return new ProviderCallError('invalid_model_output', 502);
}

export async function readTemporaryMedia(
  response: Response,
  maxBytes: number,
  allowedContentTypes: ReadonlySet<string>,
  requestId: string,
): Promise<BinaryMediaResult> {
  if (!response.ok) throw await temporaryMediaFailure(response);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!allowedContentTypes.has(contentType)) {
    await discardResponseBody(response);
    throw new ProviderCallError('invalid_model_output', 502);
  }
  try {
    const bytes = await readBoundedResponseBytes(response, maxBytes);
    return { bytes: bytes.slice().buffer, contentType, requestId };
  } catch (error) {
    throw normalizeOutboundError(error);
  }
}
