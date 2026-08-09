import { describe, it, expect } from 'vitest';
import { shouldRefine } from '../src/worker/profiles/refine';

const now = new Date('2026-08-03T12:00:00Z');

describe('shouldRefine', () => {
  it('无画像时应提炼', () => {
    expect(shouldRefine(null, 10, now)).toBe(true);
  });

  it('5 分钟前更新过则跳过', () => {
    expect(shouldRefine('2026-08-03 11:55:00', 10, now)).toBe(false);
  });

  it('11 分钟前更新过则提炼', () => {
    expect(shouldRefine('2026-08-03 11:49:00', 10, now)).toBe(true);
  });

  it('非法时间字符串按需要提炼处理', () => {
    expect(shouldRefine('garbage', 10, now)).toBe(true);
  });

  it('自定义间隔：20 分钟前更新过则提炼', () => {
    expect(shouldRefine('2026-08-03 11:40:00', 10, now)).toBe(true);
    expect(shouldRefine('2026-08-03 11:40:00', 30, now)).toBe(false);
  });
});
