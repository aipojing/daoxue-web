import { completeJSON, type ChatMessage } from '../chat/deepseek';
import { SUBJECT_NAMES, type Subject } from '../chat/prompt-builder';
import { beijingToday } from '../chat/quota';
import { SETTING_KEYS } from '../lib/settings';

const DEFAULT_REFINE_INTERVAL_MINUTES = 10;
const DEFAULT_DAILY_LIMIT = 0;
const RECENT_MESSAGE_LIMIT = 30;
const MAX_PROFILE_LENGTH = 500;

export function shouldRefine(updatedAt: string | null, intervalMinutes: number, now: Date): boolean {
  if (!updatedAt) return true;
  const parsed = Date.parse(updatedAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(parsed)) return true;
  const interval = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : DEFAULT_REFINE_INTERVAL_MINUTES;
  return now.getTime() - parsed >= interval * 60 * 1000;
}

function resolveRefineSettings(settings: Record<string, string>): { intervalMinutes: number; dailyLimit: number } {
  const intervalRaw = settings[SETTING_KEYS.profileRefineIntervalMinutes];
  const limitRaw = settings[SETTING_KEYS.profileRefineDailyLimit];
  const intervalMinutes = intervalRaw === undefined ? DEFAULT_REFINE_INTERVAL_MINUTES : Number(intervalRaw);
  const dailyLimit = limitRaw === undefined ? DEFAULT_DAILY_LIMIT : Number(limitRaw);
  return {
    intervalMinutes: Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : DEFAULT_REFINE_INTERVAL_MINUTES,
    dailyLimit: Number.isFinite(dailyLimit) && dailyLimit >= 0 ? dailyLimit : DEFAULT_DAILY_LIMIT,
  };
}

async function countTodayRefines(
  db: D1Database,
  studentId: number,
  subject: Subject,
  today: string,
): Promise<number> {
  // D1 的 datetime('now') 是 UTC，按北京时间计日需要 +8 小时
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM profile_refine_log
       WHERE student_id = ? AND subject = ? AND date(datetime(created_at, '+8 hours')) = ?`,
    )
    .bind(studentId, subject, today)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function buildRefineMessages(
  subjectName: string,
  oldProfile: string,
  transcript: string,
): ChatMessage[] {
  const instruction = [
    `你是一名学情分析师。请根据学生${subjectName}学科的旧学习画像和最近的辅导对话记录，更新这名学生的学习画像。`,
    '',
    '要求：',
    `1. 画像为纯文本，不超过 ${MAX_PROFILE_LENGTH} 字；`,
    '2. 涵盖：薄弱知识点、高频错因、对该生有效的讲解方式、近期进步；',
    '3. 以事实为准，没有证据的不要写；旧画像中已被最近表现推翻的内容要更新；',
    '4. 输出 JSON：{"profile": "画像内容"}。',
  ].join('\n');

  const user = [
    `【旧画像】\n${oldProfile || '（暂无）'}`,
    '',
    `【最近对话记录】\n${transcript}`,
  ].join('\n');

  return [
    { role: 'system', content: instruction },
    { role: 'user', content: user },
  ];
}

export async function maybeRefineProfile(
  db: D1Database,
  apiKey: string,
  studentId: number,
  subject: Subject,
  settings: Record<string, string> = {},
): Promise<void> {
  try {
    const { intervalMinutes, dailyLimit } = resolveRefineSettings(settings);
    const existing = await db
      .prepare('SELECT profile_text, updated_at FROM student_profiles WHERE student_id = ? AND subject = ?')
      .bind(studentId, subject)
      .first<{ profile_text: string; updated_at: string }>();

    if (existing && !shouldRefine(existing.updated_at, intervalMinutes, new Date())) return;

    // dailyLimit === 0 表示不限；否则按北京日期计日
    if (dailyLimit > 0) {
      const today = beijingToday();
      const todayCount = await countTodayRefines(db, studentId, subject, today);
      if (todayCount >= dailyLimit) return;
    }

    const { results: recent } = await db
      .prepare(
        `SELECT role, content FROM (
           SELECT m.id, m.role, m.content
           FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
           WHERE cv.student_id = ? AND cv.subject = ?
           ORDER BY m.id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .bind(studentId, subject, RECENT_MESSAGE_LIMIT)
      .all<{ role: string; content: string }>();

    if (recent.length < 2) return;

    const transcript = recent
      .map((m) => `${m.role === 'user' ? '学生' : '老师'}：${m.content.slice(0, 500)}`)
      .join('\n');

    const raw = await completeJSON(apiKey, {
      messages: buildRefineMessages(SUBJECT_NAMES[subject], existing?.profile_text ?? '', transcript),
    });

    const parsed = JSON.parse(raw) as { profile?: unknown };
    if (typeof parsed.profile !== 'string' || !parsed.profile.trim()) return;
    const profileText = parsed.profile.trim().slice(0, MAX_PROFILE_LENGTH * 2);

    await db
      .prepare(
        `INSERT INTO student_profiles (student_id, subject, profile_text, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(student_id, subject) DO UPDATE SET profile_text = excluded.profile_text, updated_at = datetime('now')`,
      )
      .bind(studentId, subject, profileText)
      .run();

    // 记录本次提炼，用于每日上限统计
    await db
      .prepare('INSERT INTO profile_refine_log (student_id, subject) VALUES (?, ?)')
      .bind(studentId, subject)
      .run();
  } catch (e) {
    console.error('profile refine failed (ignored):', e);
  }
}
