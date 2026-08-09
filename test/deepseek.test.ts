import { afterEach, describe, it, expect, vi } from 'vitest';
import { mapDeepSeekError, parseSSELine, streamChat } from '../src/worker/chat/deepseek';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('接受 SSE 规范允许的无空格 data 字段', () => {
    expect(parseSSELine('data:{"choices":[{"delta":{"content":"你"}}]}')).toEqual({ content: '你' });
    expect(parseSSELine('data:[DONE]')).toEqual({ done: true });
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

describe('streamChat 组合增量回调', () => {
  function stubCombinedDelta() {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"思考","content":"答案"}}]}\n',
          { status: 200 },
        ),
      ),
    );
  }

  const options = { model: 'deepseek-reasoner', messages: [] };

  it('reasoning 回调 Promise reject 时仍分派 content，并传播原错误', async () => {
    stubCombinedDelta();
    const error = new Error('reasoning reject');
    const content: string[] = [];

    await expect(
      streamChat('key', options, {
        onReasoning: () => Promise.reject(error),
        onDelta: async (text) => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          content.push(text);
        },
      }),
    ).rejects.toBe(error);
    expect(content).toEqual(['答案']);
  });

  it('reasoning 回调同步抛错时仍分派 content，并传播原错误', async () => {
    stubCombinedDelta();
    const error = new Error('reasoning throw');
    const content: string[] = [];

    await expect(
      streamChat('key', options, {
        onReasoning: () => {
          throw error;
        },
        onDelta: (text) => {
          content.push(text);
        },
      }),
    ).rejects.toBe(error);
    expect(content).toEqual(['答案']);
  });

  it('上游未发送 [DONE] 就关闭时视为中断', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('data: {"choices":[{"delta":{"content":"半句"}}]}\n', { status: 200 }),
      ),
    );

    await expect(
      streamChat('key', { model: 'deepseek-chat', messages: [] }, {
        onReasoning: () => {},
        onDelta: () => {},
      }),
    ).rejects.toThrow('连接中断');
  });

  it('上游发送 [DONE] 后正常完成', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          'data: {"choices":[{"delta":{"content":"完整"}}]}\n\ndata: [DONE]\n\n',
          { status: 200 },
        ),
      ),
    );

    await expect(
      streamChat('key', { model: 'deepseek-chat', messages: [] }, {
        onReasoning: () => {},
        onDelta: () => {},
      }),
    ).resolves.toEqual({ content: '完整', reasoningContent: '' });
  });
});
