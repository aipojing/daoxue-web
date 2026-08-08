import { describe, it, expect } from 'vitest';
import { formatDateTime, formatFullDateTime, localToday } from '../src/client/lib/datetime';

describe('formatDateTime', () => {
  it('把 SQLite 的 UTC 时间戳按本地时区展示', () => {
    // 该测试进程时区固定为 UTC+8 时应显示 08-03 09:05；这里只断言不再原样返回 UTC 字符串
    const out = formatDateTime('2026-08-03 01:05:00');
    expect(out).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(out).not.toBe('2026-08-03 01:05:00');
  });

  it('已带 ISO 格式的时间也能解析', () => {
    expect(formatDateTime('2026-08-03T01:05:00Z')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('非法输入原样返回，不抛错', () => {
    expect(formatDateTime('')).toBe('');
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});

describe('formatFullDateTime', () => {
  it('输出到分钟的完整本地时间', () => {
    expect(formatFullDateTime('2026-08-03 01:05:00')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('localToday', () => {
  it('返回本地时区的 YYYY-MM-DD', () => {
    const today = localToday();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const now = new Date();
    expect(today.slice(0, 4)).toBe(String(now.getFullYear()));
  });
});
