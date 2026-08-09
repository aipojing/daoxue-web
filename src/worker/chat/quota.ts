/** 统一按北京时间计日：限额在本地 0 点重置，日报日期不跨天错位 */
export function beijingToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** @deprecated 保留给按传入时间取日期的场景，业务请用 beijingToday() */
export function todayString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 北京时间 N 天后的日期，用于复测安排（避免 UTC 算出前一天） */
export function beijingDatePlus(days: number, now: Date = new Date()): string {
  return beijingToday(new Date(now.getTime() + days * 86400_000));
}

export function isQuotaExceeded(usedCount: number, limit: number): boolean {
  return usedCount >= limit;
}

export async function refundChargedQuotaOnce(
  state: { charged: boolean },
  refund: () => Promise<void>,
): Promise<boolean> {
  if (!state.charged) return false;
  state.charged = false;
  await refund();
  return true;
}

/**
 * 原子地检查并递增当日用量。
 * 用带 WHERE 的 upsert，避免"先查后写"在并发下被绕过。
 */
export async function checkAndIncrementQuota(
  db: D1Database,
  userId: number,
  limit: number,
  today: string,
): Promise<{ allowed: boolean; used: number }> {
  if (limit < 1) return { allowed: false, used: 0 };

  const row = await db
    .prepare(
      `INSERT INTO usage_log (user_id, date, message_count) VALUES (?1, ?2, 1)
       ON CONFLICT(user_id, date) DO UPDATE SET message_count = message_count + 1
         WHERE message_count < ?3
       RETURNING message_count`,
    )
    .bind(userId, today, limit)
    .first<{ message_count: number }>();

  return row ? { allowed: true, used: row.message_count } : { allowed: false, used: limit };
}

/** 上游调用失败时退还额度，避免服务故障期间白扣 */
export async function refundQuota(db: D1Database, userId: number, today: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE usage_log SET message_count = message_count - 1
         WHERE user_id = ? AND date = ? AND message_count > 0`,
      )
      .bind(userId, today)
      .run();
  } catch (e) {
    console.error('refund quota failed:', e);
  }
}
