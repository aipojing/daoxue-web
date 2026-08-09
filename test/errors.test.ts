import { describe, it, expect } from 'vitest';
import { UserFacingError, toHttpError, toUserMessage } from '../src/worker/lib/errors';

describe('toUserMessage', () => {
  it('用户可见错误原样透传', () => {
    expect(toUserMessage(new UserFacingError('DeepSeek 账户余额不足'))).toBe('DeepSeek 账户余额不足');
  });

  it('内部错误不泄露细节', () => {
    expect(toUserMessage(new Error('D1_ERROR: near "SELECT": syntax error'))).toBe(
      'AI 服务暂时不可用，请稍后再试',
    );
    expect(toUserMessage(new SyntaxError('Unexpected token < in JSON'))).not.toContain('JSON');
  });

  it('非 Error 值也安全', () => {
    expect(toUserMessage('boom')).toBe('AI 服务暂时不可用，请稍后再试');
    expect(toUserMessage(null, '图片识别失败')).toBe('图片识别失败');
  });
});

describe('toHttpError', () => {
  it('全局错误处理保留 UserFacingError 的安全文案与状态码', () => {
    expect(toHttpError(new UserFacingError('上游服务超时', 502))).toEqual({
      message: '上游服务超时',
      status: 502,
    });
  });

  it('全局错误处理不泄露未知异常', () => {
    expect(toHttpError(new Error('D1 secret'))).toEqual({
      message: '服务器内部错误，请稍后再试',
      status: 500,
    });
  });
});
