const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_MEDIA_REDIRECTS = 3;

export type OutboundRequestErrorKind =
  | 'invalid_url'
  | 'timeout'
  | 'unavailable'
  | 'body_too_large'
  | 'invalid_json';

export interface AllowedMediaUrlOptions {
  upgradeHttpToHttps?: boolean;
}

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
  const withoutBrackets = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (withoutBrackets.endsWith('..')) return invalidUrl();
  return withoutBrackets.endsWith('.') ? withoutBrackets.slice(0, -1) : withoutBrackets;
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
  const hostname = normalizedHostname(url);
  if (url.protocol !== 'https:' || url.username || url.password || !isPublicHostname(hostname)) {
    return invalidUrl();
  }
  if (url.hostname.endsWith('.')) url.hostname = hostname;
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

export function assertAllowedMediaUrl(
  value: string,
  allowedHostSuffixes: string[],
  options: AllowedMediaUrlOptions = {},
): string {
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    return invalidUrl();
  }
  if (candidate.protocol === 'http:' && options.upgradeHttpToHttps === true) {
    candidate.protocol = 'https:';
  }
  const safeUrl = assertPublicHttpsUrl(candidate.toString());
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
  options: AllowedMediaUrlOptions = {},
): Promise<Response> {
  let currentUrl = assertAllowedMediaUrl(value, allowedHostSuffixes, options);
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
      await discardResponseBody(response);
      throw new OutboundRequestError('invalid_url');
    }
    const location = response.headers.get('location');
    await discardResponseBody(response);
    if (!location) throw new OutboundRequestError('invalid_url');
    let redirectUrl: string;
    try {
      redirectUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new OutboundRequestError('invalid_url');
    }
    currentUrl = assertAllowedMediaUrl(redirectUrl, allowedHostSuffixes, options);
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
    await discardResponseBody(response);
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
    await ignoreCancelFailure(() => reader.cancel());
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function ignoreCancelFailure(cancel: (() => Promise<unknown>) | undefined): Promise<void> {
  if (!cancel) return;
  try {
    await cancel();
  } catch {
    // Releasing an upstream body is best-effort and must never replace the normalized result.
  }
}

export async function discardResponseBody(response: Response): Promise<void> {
  const body = response.body;
  await ignoreCancelFailure(body ? () => body.cancel() : undefined);
}

function hasSafeJsonComplexity(value: unknown, maxDepth: number, maxArrayLength: number): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.depth > maxDepth) return false;
    if (Array.isArray(current.value)) {
      if (current.value.length > maxArrayLength) return false;
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  maxDepth = 20,
  maxArrayLength = 100,
): Promise<unknown> {
  try {
    const bytes = await readBoundedResponseBytes(response, maxBytes);
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!hasSafeJsonComplexity(value, maxDepth, maxArrayLength)) {
      throw new OutboundRequestError('invalid_json');
    }
    return value;
  } catch (error) {
    if (error instanceof OutboundRequestError) throw error;
    throw new OutboundRequestError('invalid_json');
  }
}
