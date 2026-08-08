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

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onReasoning: (text: string) => void;
  onDone: (messageId: number | null) => void;
  onError: (message: string) => void;
}

export async function streamChatRequest(
  conversationId: number,
  content: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/conversations/${conversationId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
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
    handlers.onError(json?.error ?? 'AI 服务暂时不可用，请稍后再试');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const processEvent = (rawEvent: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let payload: { text?: string; message?: string; messageId?: number | null };
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
      handlers.onError(payload.message ?? 'AI 服务出错，请重试');
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        processEvent(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf('\n\n');
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
