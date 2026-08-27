const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_MEDIA_REDIRECTS = 3;

export type OutboundRequestErrorKind = 'invalid_url' | 'timeout' | 'unavailable' | 'body_too_large';

export class OutboundRequestError extends Error {
  constructor(readonly kind: OutboundRequestErrorKind) {
    super('出站请求失败');
    this.name = 'OutboundRequestError';
  }
}

function invalidUrl(): never {
  throw new OutboundRequestError('invalid_url');
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function ipv4Octets(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255)
    ? octets as [number, number, number, number]
    : null;
}

function isNonPublicIPv4(octets: [number, number, number, number]): boolean {
  const [first, second, third] = octets;
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224;
}

function isNonPublicIPv6(hostname: string): boolean {
  if (!hostname.includes(':')) return false;
  const normalized = hostname.toLowerCase().split('%', 1)[0] ?? '';
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('::ffff:')) return true;
  return !/^[23][0-9a-f]{0,3}:/.test(normalized);
}

function isPublicHostname(hostname: string): boolean {
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return false;
  }
  const octets = ipv4Octets(hostname);
  if (octets) return !isNonPublicIPv4(octets);
  return !isNonPublicIPv6(hostname);
}

export function assertPublicHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidUrl();
  }
  if (url.protocol !== 'https:' || url.username || url.password || !isPublicHostname(normalizedHostname(url))) {
    return invalidUrl();
  }
  return url.toString();
}

function normalizeAllowedSuffix(value: string): string {
  const suffix = value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!suffix || suffix.includes('*') || suffix.includes(':') ||
      !suffix.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return invalidUrl();
  }
  return suffix;
}

export function assertAllowedMediaUrl(value: string, allowedHostSuffixes: string[]): string {
  const safeUrl = assertPublicHttpsUrl(value);
  const hostname = normalizedHostname(new URL(safeUrl));
  const allowed = allowedHostSuffixes.some((value) => {
    const suffix = normalizeAllowedSuffix(value);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
  if (!allowed) return invalidUrl();
  return safeUrl;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Object &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export async function fetchAllowedMedia(
  value: string,
  allowedHostSuffixes: string[],
  timeoutMs: number,
): Promise<Response> {
  let currentUrl = assertAllowedMediaUrl(value, allowedHostSuffixes);
  const signal = AbortSignal.timeout(timeoutMs);

  for (let redirectCount = 0; ; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      throw new OutboundRequestError(isTimeoutError(error) ? 'timeout' : 'unavailable');
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (redirectCount >= MAX_MEDIA_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new OutboundRequestError('invalid_url');
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new OutboundRequestError('invalid_url');
    let redirectUrl: string;
    try {
      redirectUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new OutboundRequestError('invalid_url');
    }
    currentUrl = assertAllowedMediaUrl(redirectUrl, allowedHostSuffixes);
  }
}

function declaredBodyTooLarge(response: Response, maxBytes: number): boolean {
  const value = response.headers.get('content-length');
  if (!value || !/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) > BigInt(maxBytes);
  } catch {
    return true;
  }
}

export async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (declaredBodyTooLarge(response, maxBytes)) {
    throw new OutboundRequestError('body_too_large');
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new OutboundRequestError('body_too_large');
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof OutboundRequestError) throw error;
    throw new OutboundRequestError(isTimeoutError(error) ? 'timeout' : 'unavailable');
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
