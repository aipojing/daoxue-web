import { UserFacingError } from '../lib/errors';

const DEEPSEEK_BASE = 'https://api.deepseek.com';
const UPSTREAM_TIMEOUT_MS = 120_000;

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface ParsedDelta {
  content?: string;
  reasoning?: string;
  done?: boolean;
}

export function parseSSELine(line: string): ParsedDelta | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trimStart();
  if (payload === '[DONE]') return { done: true };
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    const delta = json.choices?.[0]?.delta;
    if (!delta) return null;
    const reasoning =
      typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
        ? delta.reasoning_content
        : undefined;
    const content =
      typeof delta.content === 'string' && delta.content.length > 0 ? delta.content : undefined;
    return reasoning || content ? { reasoning, content } : null;
  } catch {
    return null;
  }
}

export function mapDeepSeekError(status: number): string {
  switch (status) {
    case 401:
      return 'DeepSeek API Key 无效，请联系管理员检查配置';
    case 402:
      return 'DeepSeek 账户余额不足，请联系管理员充值';
    case 429:
      return '请求过于频繁，请稍后再试';
    default:
      return 'AI 服务暂时不可用，请稍后再试';
  }
}

export interface StreamCallbacks {
  onDelta: (text: string) => Promise<void> | void;
  onReasoning: (text: string) => Promise<void> | void;
}

export async function dispatchDeltaCallbacks(
  delta: ParsedDelta,
  callbacks: StreamCallbacks,
): Promise<void> {
  const pending: Promise<void>[] = [];
  if (delta.reasoning) {
    const reasoning = delta.reasoning;
    pending.push(Promise.resolve().then(() => callbacks.onReasoning(reasoning)));
  }
  if (delta.content) {
    const content = delta.content;
    pending.push(Promise.resolve().then(() => callbacks.onDelta(content)));
  }
  const results = await Promise.allSettled(pending);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
}

export async function streamChat(
  apiKey: string,
  options: { model: string; messages: ChatMessage[] },
  callbacks: StreamCallbacks,
): Promise<{ content: string; reasoningContent: string }> {
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    console.error(`DeepSeek stream error ${res.status}: ${detail.slice(0, 500)}`);
    throw new UserFacingError(mapDeepSeekError(res.status));
  }

  let content = '';
  let reasoningContent = '';
  let buffer = '';
  let sawDone = false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const parsed = parseSSELine(rawLine.trim());
      if (!parsed) continue;
      if (parsed.done) {
        sawDone = true;
        break;
      }
      if (parsed.reasoning) {
        reasoningContent += parsed.reasoning;
      }
      if (parsed.content) {
        content += parsed.content;
      }
      await dispatchDeltaCallbacks(parsed, callbacks);
    }
    if (sawDone) {
      await reader.cancel().catch(() => {});
      break;
    }
  }

  // 上游最后一块可能不以换行结尾，补处理残留，避免丢最后一个增量
  if (!sawDone) {
    buffer += decoder.decode();
    const tail = parseSSELine(buffer.trim());
    if (tail?.done) {
      sawDone = true;
    } else if (tail) {
      if (tail.reasoning) {
        reasoningContent += tail.reasoning;
      }
      if (tail.content) {
        content += tail.content;
      }
      await dispatchDeltaCallbacks(tail, callbacks);
    }
  }

  if (!sawDone) throw new UserFacingError('AI 服务连接中断，请重试');

  return { content, reasoningContent };
}

export async function completeJSON(
  apiKey: string,
  options: { messages: ChatMessage[] },
): Promise<string> {
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: options.messages,
      response_format: { type: 'json_object' },
      stream: false,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`DeepSeek completion error ${res.status}: ${detail.slice(0, 500)}`);
    throw new UserFacingError(mapDeepSeekError(res.status));
  }

  const json = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new UserFacingError('AI 服务返回内容为空，请稍后再试');
  return content;
}
