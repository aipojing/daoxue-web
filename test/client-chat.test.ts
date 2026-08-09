import { describe, expect, it } from 'vitest';
import {
  isNearBottom,
  isPersistedMessage,
  markPersistedMessages,
  shouldApplyConversationDetail,
  shouldCommitAssistantMessage,
  subscribeToMobileMediaQuery,
} from '../src/client/lib/chat';
import type { Message } from '../src/client/types';

describe('client chat helpers', () => {
  it('仅在距离底部小于默认阈值时视为贴底', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 670, clientHeight: 200 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 680, clientHeight: 200 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 710, clientHeight: 200 })).toBe(true);
  });

  it('仅将显式持久化的消息识别为服务端消息', () => {
    expect(isPersistedMessage({ id: 3, persisted: true })).toBe(true);
    expect(isPersistedMessage({ id: 3, persisted: false })).toBe(false);
  });

  it('拒绝从会话 1 切到 new 后返回的旧详情', () => {
    expect(
      shouldApplyConversationDetail({
        routeConversationId: 'new',
        requestedConversationId: '1',
        currentGeneration: 2,
        requestGeneration: 1,
      }),
    ).toBe(false);
  });

  it('拒绝同一路由的旧世代详情请求', () => {
    expect(
      shouldApplyConversationDetail({
        routeConversationId: '1',
        requestedConversationId: '1',
        currentGeneration: 2,
        requestGeneration: 1,
      }),
    ).toBe(false);
  });

  it('路由 ID 与请求世代都匹配时应用会话详情', () => {
    expect(
      shouldApplyConversationDetail({
        routeConversationId: '1',
        requestedConversationId: '1',
        currentGeneration: 2,
        requestGeneration: 2,
      }),
    ).toBe(true);
  });

  it('为服务端历史消息标记 persisted', () => {
    const history: Message[] = [
      { id: 1, role: 'assistant', content: '答案', reasoning_content: null, created_at: '2026-01-01' },
    ];

    expect(markPersistedMessages(history)).toEqual([{ ...history[0], persisted: true }]);
  });

  it('reasoning-only 流完成后应提交气泡', () => {
    expect(shouldCommitAssistantMessage('', '推理过程')).toBe(true);
    expect(shouldCommitAssistantMessage('', '')).toBe(false);
  });

  it('订阅媒体查询时初始化状态，并在清理时移除同一个监听器', () => {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    let addedListener: ((event: { matches: boolean }) => void) | undefined;
    let removedListener: ((event: { matches: boolean }) => void) | undefined;
    const mediaQuery = {
      matches: false,
      addEventListener: (_type: 'change', listener: (event: { matches: boolean }) => void) => {
        addedListener = listener;
        listeners.add(listener);
      },
      removeEventListener: (_type: 'change', listener: (event: { matches: boolean }) => void) => {
        removedListener = listener;
        listeners.delete(listener);
      },
    };
    const values: boolean[] = [];

    const cleanup = subscribeToMobileMediaQuery(mediaQuery, (matches) => values.push(matches));
    for (const listener of listeners) listener({ matches: true });
    cleanup();
    for (const listener of listeners) listener({ matches: false });

    expect(values).toEqual([false, true]);
    expect(removedListener).toBe(addedListener);
    expect(listeners.size).toBe(0);
  });
});
