import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export interface Envelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ success: true, data, error: null } satisfies Envelope<T>, status);
}

export function err(c: Context, message: string, status: ContentfulStatusCode = 400) {
  return c.json({ success: false, data: null, error: message } satisfies Envelope<never>, status);
}
