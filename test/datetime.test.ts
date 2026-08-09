import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { formatDateTime, formatFullDateTime, localToday } from '../src/client/lib/datetime';

const originalTimezone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = 'Asia/Shanghai';
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe('formatDateTime', () => {
  it('把 SQLite 的 UTC 时间戳按本地时区展示', () => {
    expect(formatDateTime('2026-08-03 01:05:00')).toBe('08-03 09:05');
  });

  it('已带 ISO 格式的时间也能解析', () => {
    expect(formatDateTime('2026-08-03T01:05:00Z')).toBe('08-03 09:05');
  });

  it('UTC 前一天晚间在北京时间显示为次日', () => {
    expect(formatDateTime('2026-08-02 16:30:00')).toBe('08-03 00:30');
  });

  it('保留 ISO 时间中已有的时区偏移', () => {
    expect(formatDateTime('2026-08-03T09:05:00+08:00')).toBe(formatDateTime('2026-08-03T01:05:00Z'));
  });

  it('非法输入原样返回，不抛错', () => {
    expect(formatDateTime('')).toBe('');
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});

describe('formatFullDateTime', () => {
  it('输出到分钟的完整本地时间', () => {
    expect(formatFullDateTime('2026-08-03 01:05:00')).toBe('2026-08-03 09:05');
  });
});

describe('localToday', () => {
  it('按北京时间跨日，而不是按 UTC 日期返回今天', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T16:30:00Z'));

    expect(localToday()).toBe('2026-08-03');
  });
});
