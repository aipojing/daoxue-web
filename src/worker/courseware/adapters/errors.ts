import type { NormalizedProviderErrorCode } from './types';
import { discardResponseBody, ignoreCancelFailure } from '../../lib/outbound-url';

const MAX_ERROR_BODY_BYTES = 64 * 1024;

const ERROR_DETAILS: Record<NormalizedProviderErrorCode, { message: string; retryable: boolean }> = {
  missing_credential: { message: '未配置模型服务密钥', retryable: false },
  invalid_credential: { message: '模型服务密钥无效', retryable: false },
  quota_exhausted: { message: '模型套餐额度已用完', retryable: false },
  rate_limited: { message: '模型服务请求过于频繁', retryable: true },
  provider_timeout: { message: '模型服务响应超时', retryable: true },
  provider_unavailable: { message: '模型服务暂时不可用', retryable: true },
  invalid_model_output: { message: '模型服务返回了无效结果', retryable: false },
  model_unavailable: { message: '所选模型不可用', retryable: false },
  incompatible_voice: { message: '所选音色不可用', retryable: false },
  storage_failed: { message: '媒体文件保存失败', retryable: true },
  internal_error: { message: '课件生成服务暂时不可用', retryable: false },
};

export class ProviderCallError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly errorCode: NormalizedProviderErrorCode,
    readonly status: number,
  ) {
    const details = ERROR_DETAILS[errorCode];
    super(details.message);
    this.name = 'ProviderCallError';
    this.retryable = details.retryable;
    Object.defineProperties(this, {
      message: { value: details.message, writable: false, configurable: false },
      errorCode: { value: errorCode, writable: false, configurable: false, enumerable: true },
      retryable: { value: details.retryable, writable: false, configurable: false, enumerable: true },
    });
  }
}

function providerError(errorCode: NormalizedProviderErrorCode, status: number): ProviderCallError {
  return new ProviderCallError(errorCode, status);
}

export function normalizeProviderFailure(status: number): ProviderCallError {
  if (status === 401 || status === 403) return providerError('invalid_credential', status);
  if (status === 402) return providerError('quota_exhausted', status);
  if (status === 408 || status === 504) return providerError('provider_timeout', status);
  if (status === 429) return providerError('rate_limited', status);
  if (status === 404 || status === 422) return providerError('model_unavailable', status);
  if (status >= 500) return providerError('provider_unavailable', status);
  return providerError('internal_error', status);
}

function hasExplicitHttpClassification(status: number): boolean {
  return status === 401 || status === 403 || status === 402 ||
    status === 408 || status === 504 || status === 429 ||
    status === 404 || status === 422 || status >= 500;
}

function canReadErrorBody(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mime === 'application/json' || mime.endsWith('+json') || mime.startsWith('text/');
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAX_ERROR_BODY_BYTES - total;
      const chunk = next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < next.value.byteLength) break;
    }
  } finally {
    await ignoreCancelFailure(() => reader.cancel());
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function providerCodeFromBody(body: string, contentType: string | null): string {
  if (contentType?.toLowerCase().includes('json')) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        const nested = record.error && typeof record.error === 'object'
          ? record.error as Record<string, unknown>
          : undefined;
        for (const candidate of [record.code, record.errorCode, record.type, nested?.code, nested?.type]) {
          if (typeof candidate === 'string' && candidate.length <= 200) return candidate;
        }
      }
    } catch {
      return '';
    }
    return '';
  }

  const match = body.match(/(?:code|type|errorCode)\s*[:=]\s*["']?([A-Za-z0-9._-]{1,200})/i);
  return match?.[1] ?? '';
}

function normalizeProviderCode(code: string): NormalizedProviderErrorCode | null {
  const normalized = code.toLowerCase();
  if (/invalid.?api.?key|authentication|unauthenticated|invalid.?credential/.test(normalized)) {
    return 'invalid_credential';
  }
  if (/arrearage|allocationquota|quota/.test(normalized)) return 'quota_exhausted';
  if (/throttl|rate.?limit/.test(normalized)) return 'rate_limited';
  if (/timeout|timed.?out/.test(normalized)) return 'provider_timeout';
  if (/invalid.?voice|voice.*(?:not.?found|unavailable)|unsupported.?voice|incompatible.?voice/.test(normalized)) {
    return 'incompatible_voice';
  }
  if (/model.*(?:not.?found|unavailable)|(?:not.?found|unsupported).?model|invalid.?model/.test(normalized)) {
    return 'model_unavailable';
  }
  if (/invalid.?(?:response|output|json)|malformed.?(?:response|output|json)/.test(normalized)) {
    return 'invalid_model_output';
  }
  return null;
}

export async function normalizeProviderResponse(
  response: Response,
): Promise<ProviderCallError> {
  if (hasExplicitHttpClassification(response.status) || !canReadErrorBody(response.headers.get('content-type'))) {
    await discardResponseBody(response);
    return normalizeProviderFailure(response.status);
  }

  const contentType = response.headers.get('content-type');
  try {
    const code = normalizeProviderCode(providerCodeFromBody(await readBoundedBody(response), contentType));
    return code ? providerError(code, response.status) : normalizeProviderFailure(response.status);
  } catch {
    return normalizeProviderFailure(response.status);
  }
}
