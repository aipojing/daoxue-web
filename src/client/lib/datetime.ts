/**
 * 服务端统一存 UTC（SQLite datetime('now')，格式 "YYYY-MM-DD HH:MM:SS"），
 * 展示时必须转成用户本地时区，否则国内用户看到的时间会慢 8 小时。
 */
function parseUtc(ts: string): Date | null {
  if (!ts) return null;
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  const d = new Date(hasTimezone ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 例：08-04 15:32 */
export function formatDateTime(ts: string): string {
  const d = parseUtc(ts);
  if (!d) return ts;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 例：2026-08-04 15:32 */
export function formatFullDateTime(ts: string): string {
  const d = parseUtc(ts);
  if (!d) return ts;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 本地"今天"的 YYYY-MM-DD，用于和服务端的日期字段比较 */
export function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
