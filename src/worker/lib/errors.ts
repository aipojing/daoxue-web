import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * 可以安全展示给终端用户的错误。
 * 只有这一类错误的 message 会原样下发；其他异常（D1 报错、JSON 解析失败等）
 * 一律替换成通用文案，避免泄露内部实现细节。
 */
export class UserFacingError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(message: string, status: ContentfulStatusCode = 500) {
    super(message);
    this.name = 'UserFacingError';
    this.status = status;
  }
}

export function toUserMessage(e: unknown, fallback = 'AI 服务暂时不可用，请稍后再试'): string {
  return e instanceof UserFacingError ? e.message : fallback;
}

export function toHttpError(e: unknown): { message: string; status: ContentfulStatusCode } {
  if (e instanceof UserFacingError) return { message: e.message, status: e.status };
  return { message: '服务器内部错误，请稍后再试', status: 500 };
}
