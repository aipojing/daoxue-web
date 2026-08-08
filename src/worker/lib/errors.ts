/**
 * 可以安全展示给终端用户的错误。
 * 只有这一类错误的 message 会原样下发；其他异常（D1 报错、JSON 解析失败等）
 * 一律替换成通用文案，避免泄露内部实现细节。
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function toUserMessage(e: unknown, fallback = 'AI 服务暂时不可用，请稍后再试'): string {
  return e instanceof UserFacingError ? e.message : fallback;
}
