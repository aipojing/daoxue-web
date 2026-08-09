import { describe, it, expect } from 'vitest';
import {
  beijingToday,
  isQuotaExceeded,
  refundChargedQuotaOnce,
  todayString,
} from '../src/worker/chat/quota';

describe('quota', () => {
  it('未达上限允许', () => {
    expect(isQuotaExceeded(0, 100)).toBe(false);
    expect(isQuotaExceeded(99, 100)).toBe(false);
  });

  it('达到或超过上限拒绝', () => {
    expect(isQuotaExceeded(100, 100)).toBe(true);
    expect(isQuotaExceeded(150, 100)).toBe(true);
  });

  it('todayString 输出 YYYY-MM-DD（UTC）', () => {
    expect(todayString(new Date('2026-08-03T01:02:03Z'))).toBe('2026-08-03');
  });

  it('已扣额度连续退款两次时只执行第一次退款尝试', async () => {
    const state = { charged: true };
    let attempts = 0;
    const refund = async () => {
      attempts += 1;
      throw new Error('退款写入失败');
    };

    await expect(refundChargedQuotaOnce(state, refund)).rejects.toThrow('退款写入失败');
    await expect(refundChargedQuotaOnce(state, refund)).resolves.toBe(false);
    expect(attempts).toBe(1);
  });
});

describe('beijingToday', () => {
  it('UTC 凌晨对应北京时间已是当天白天', () => {
    // UTC 2026-08-03 01:00 = 北京 2026-08-03 09:00
    expect(beijingToday(new Date('2026-08-03T01:00:00Z'))).toBe('2026-08-03');
  });

  it('UTC 前一天晚间已进入北京次日（限额按本地 0 点重置）', () => {
    // UTC 2026-08-02 16:30 = 北京 2026-08-03 00:30
    expect(beijingToday(new Date('2026-08-02T16:30:00Z'))).toBe('2026-08-03');
  });

  it('UTC 前一天下午仍是北京当天', () => {
    // UTC 2026-08-02 15:30 = 北京 2026-08-02 23:30
    expect(beijingToday(new Date('2026-08-02T15:30:00Z'))).toBe('2026-08-02');
  });
});
