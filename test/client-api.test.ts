import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGet, streamChatRequest, type StreamHandlers } from '../src/client/api';
import * as clientApi from '../src/client/api';

const encoder = new TextEncoder();

function sseResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

function handlers(): StreamHandlers {
  return {
    onDelta: vi.fn(),
    onReasoning: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamChatRequest', () => {
  it('按 SSE 规范分隔 CRLF 结束的多个事件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'event: delta\r\ndata: {"text":"答"}\r\n\r\n',
          'event: done\r\ndata: {"messageId":7}\r\n\r\n',
        ]),
      ),
    );
    const received = handlers();

    await streamChatRequest(1, '问题', received);

    expect(received.onDelta).toHaveBeenCalledWith('答');
    expect(received.onDone).toHaveBeenCalledWith(7);
    expect(received.onError).not.toHaveBeenCalled();
  });

  it('发送稳定 request ID 供服务端幂等处理', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse(['event: done\ndata: {"messageId":7}\n\n']),
    );
    vi.stubGlobal('fetch', fetchMock);

    await streamChatRequest(1, '问题', handlers(), undefined, 'request-123');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      content: '问题',
      requestId: 'request-123',
    });
  });

  it('收到 done 后忽略同一缓冲区内的后续事件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'event: delta\ndata: {"text":"完整"}\n\n',
          'event: done\ndata: {"messageId":7}\n\n',
          'event: delta\ndata: {"text":"不应追加"}\n\n',
        ]),
      ),
    );
    const received = handlers();

    await streamChatRequest(1, '问题', received);

    expect(received.onDelta).toHaveBeenCalledTimes(1);
    expect(received.onDelta).toHaveBeenCalledWith('完整');
    expect(received.onDone).toHaveBeenCalledOnce();
  });

  it('将 error 事件的服务端持久化元数据交给调用方', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'event: error\ndata: {"message":"上游中断","userMessageId":11,"assistantMessageId":12}\n\n',
        ]),
      ),
    );
    const received = handlers();

    await streamChatRequest(1, '问题', received);

    expect(received.onError).toHaveBeenCalledWith('上游中断', {
      userMessageId: 11,
      assistantMessageId: 12,
    });
  });

  it('会话过期导致非 SSE 401 时统一跳回登录页', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/students/1/chat/2', assign } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, data: null, error: '登录已过期，请重新登录' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const received = handlers();

    await streamChatRequest(1, '问题', received);

    expect(assign).toHaveBeenCalledWith('/login');
    expect(received.onError).toHaveBeenCalledWith('登录已过期，请重新登录', {
      userMessageId: null,
      assistantMessageId: null,
    });
  });

  it('无法获知服务端是否已接收时不伪造未落库 metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('socket closed')));
    const networkFailure = handlers();

    await streamChatRequest(1, '问题', networkFailure);

    expect((networkFailure.onError as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      '网络连接失败，请检查网络',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([])));
    const silentEof = handlers();
    await streamChatRequest(1, '问题', silentEof);
    expect((silentEof.onError as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['连接中断，请重试']);
  });
});

describe('鉴权交互辅助函数', () => {
  it('退出请求失败时不清空本地鉴权态', async () => {
    const performLogout = (clientApi as typeof clientApi & {
      performLogout?: (request: () => Promise<unknown>, clear: () => void) => Promise<void>;
    }).performLogout;
    let cleared = false;
    let rejected = false;

    try {
      await performLogout?.(
        async () => {
          throw new Error('断网');
        },
        () => {
          cleared = true;
        },
      );
    } catch {
      rejected = true;
    }

    expect(rejected).toBe(true);
    expect(cleared).toBe(false);
  });

  it('冷启动鉴权探测的非 401 错误返回可重试提示', () => {
    const getAuthProbeError = (clientApi as typeof clientApi & {
      getAuthProbeError?: (error: unknown) => string;
    }).getAuthProbeError;

    expect(getAuthProbeError?.(new Error('断网'))).toBe('无法确认登录状态，请重试');
    expect(getAuthProbeError?.(new clientApi.ApiError('未登录', 401))).toBe('');
  });
});

describe('普通 API 请求', () => {
  it('中止请求时原样抛出 AbortError', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('已中止', 'AbortError');
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    await expect(apiGet('/api/example', { signal: controller.signal })).rejects.toBe(abortError);
  });

  it('已中止信号遇到非 AbortError 时仍暴露 AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('socket closed')));

    await expect(apiGet('/api/example', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('普通网络错误仍转换为面向用户的网络错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('socket closed')));

    await expect(apiGet('/api/example')).rejects.toMatchObject({
      message: '网络连接失败，请检查网络',
      status: 0,
    });
  });

  it('401 仍跳转登录页并返回 API 错误', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/students/1', assign } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      data: null,
      error: '登录已过期，请重新登录',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })));

    await expect(apiGet('/api/example')).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith('/login');
  });
});
