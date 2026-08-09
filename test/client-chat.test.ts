import { describe, expect, it } from 'vitest';
import { isNearBottom, isPersistedMessage } from '../src/client/lib/chat';

describe('client chat helpers', () => {
  it('仅在距离底部不超过默认阈值时视为贴底', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 670, clientHeight: 200 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 710, clientHeight: 200 })).toBe(true);
  });

  it('仅将显式持久化的消息识别为服务端消息', () => {
    expect(isPersistedMessage({ id: 3, persisted: true })).toBe(true);
    expect(isPersistedMessage({ id: 3, persisted: false })).toBe(false);
  });
});
