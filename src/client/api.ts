interface Envelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('网络连接失败，请检查网络', 0);
  }

  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!json) throw new ApiError('服务器响应异常', res.status);
  if (!json.success) {
    // 登录态失效时统一送回登录页，避免各页面把"未登录"当普通错误展示
    if (res.status === 401 && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login');
    }
    throw new ApiError(json.error ?? '请求失败', res.status);
  }
  return json.data as T;
}

export const apiGet = <T>(path: string) => request<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
export const apiPut = <T>(path: string, body?: unknown) => request<T>('PUT', path, body);
export const apiDelete = <T>(path: string) => request<T>('DELETE', path);

export function getAuthProbeError(error: unknown): string {
  return error instanceof ApiError && error.status === 401 ? '' : '无法确认登录状态，请重试';
}

export async function performLogout(requestLogout: () => Promise<unknown>, clearAuth: () => void): Promise<void> {
  await requestLogout();
  clearAuth();
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onReasoning: (text: string) => void;
  onDone: (messageId: number | null) => void;
  onError: (message: string, metadata?: StreamErrorMetadata) => void;
}

export interface StreamErrorMetadata {
  userMessageId: number | null;
  assistantMessageId: number | null;
}

export async function streamChatRequest(
  conversationId: number,
  content: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  requestId?: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/conversations/${conversationId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, ...(requestId ? { requestId } : {}) }),
      credentials: 'same-origin',
      signal,
    });
  } catch (e) {
    if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
    handlers.onError('网络连接失败，请检查网络');
    return;
  }

  const contentType = res.headers.get('Content-Type') ?? '';
  if (!res.ok || !res.body || !contentType.includes('text/event-stream')) {
    const json = (await res.json().catch(() => null)) as Envelope<unknown> | null;
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login');
    }
    handlers.onError(json?.error ?? 'AI 服务暂时不可用，请稍后再试', {
      userMessageId: null,
      assistantMessageId: null,
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const processEvent = (rawEvent: string) => {
    if (finished) return;
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of rawEvent.split(/\r\n|\r|\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let payload: {
      text?: string;
      message?: string;
      messageId?: number | null;
      userMessageId?: number | null;
      assistantMessageId?: number | null;
    };
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (eventName === 'delta' && typeof payload.text === 'string') handlers.onDelta(payload.text);
    else if (eventName === 'reasoning' && typeof payload.text === 'string') handlers.onReasoning(payload.text);
    else if (eventName === 'done') {
      finished = true;
      handlers.onDone(payload.messageId ?? null);
    } else if (eventName === 'error') {
      finished = true;
      const hasPersistenceMetadata = 'userMessageId' in payload || 'assistantMessageId' in payload;
      handlers.onError(
        payload.message ?? 'AI 服务出错，请重试',
        hasPersistenceMetadata
          ? {
              userMessageId: typeof payload.userMessageId === 'number' ? payload.userMessageId : null,
              assistantMessageId: typeof payload.assistantMessageId === 'number' ? payload.assistantMessageId : null,
            }
          : undefined,
      );
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.match(/\r?\n\r?\n|\r\r/);
      while (boundary?.index !== undefined) {
        processEvent(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        boundary = buffer.match(/\r?\n\r?\n|\r\r/);
      }
    }
    if (!finished && buffer.trim()) processEvent(buffer);
  } catch {
    /* 下面统一兜底 */
  } finally {
    // 连接被静默关闭（Worker 重启、代理超时）时也要收尾，
    // 否则前端会永远停在"生成中"，输入框再也点不动
    if (!finished && !signal?.aborted) handlers.onError('连接中断，请重试');
  }
}
