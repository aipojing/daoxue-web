import { describe, expect, it } from 'vitest';
import { hasAssistantOutput } from '../src/worker/chat/output';

describe('hasAssistantOutput', () => {
  it('content-only 输出可持久化', () => {
    expect(hasAssistantOutput('答案', '')).toBe(true);
  });

  it('reasoning-only 输出可持久化', () => {
    expect(hasAssistantOutput('', '思考过程')).toBe(true);
  });

  it('content 和 reasoning 都为空时不可持久化', () => {
    expect(hasAssistantOutput('', '')).toBe(false);
  });
});
