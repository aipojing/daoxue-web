import { describe, it, expect } from 'vitest';
import { parseSSELine, mapDeepSeekError } from '../src/worker/chat/deepseek';

describe('parseSSELine', () => {
  it('解析 content 增量', () => {
    const r = parseSSELine('data: {"choices":[{"delta":{"content":"你"}}]}');
    expect(r).toEqual({ content: '你' });
  });

  it('解析 reasoning_content 增量', () => {
    const r = parseSSELine('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}');
    expect(r).toEqual({ reasoning: '思考' });
  });

  it('同时解析 reasoning_content 与 content 增量', () => {
    expect(
      parseSSELine('data: {"choices":[{"delta":{"reasoning_content":"思考","content":"答案"}}]}'),
    ).toEqual({ reasoning: '思考', content: '答案' });
  });

  it('[DONE] 返回 done', () => {
    expect(parseSSELine('data: [DONE]')).toEqual({ done: true });
  });

  it('非 data 行返回 null', () => {
    expect(parseSSELine(': keep-alive')).toBeNull();
    expect(parseSSELine('')).toBeNull();
  });

  it('损坏的 JSON 返回 null 而不抛错', () => {
    expect(parseSSELine('data: {broken')).toBeNull();
  });
});

describe('mapDeepSeekError', () => {
  it('常见状态码映射为中文', () => {
    expect(mapDeepSeekError(401)).toContain('Key');
    expect(mapDeepSeekError(402)).toContain('余额');
    expect(mapDeepSeekError(429)).toContain('频繁');
    expect(mapDeepSeekError(500)).toContain('稍后');
  });
});
