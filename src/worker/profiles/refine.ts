import { completeJSON, type ChatMessage } from '../chat/deepseek';
import { SUBJECT_NAMES, type Subject } from '../chat/prompt-builder';

const REFINE_INTERVAL_MINUTES = 10;
const RECENT_MESSAGE_LIMIT = 30;
const MAX_PROFILE_LENGTH = 500;

export function shouldRefine(updatedAt: string | null, now: Date): boolean {
  if (!updatedAt) return true;
  const parsed = Date.parse(updatedAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(parsed)) return true;
  return now.getTime() - parsed >= REFINE_INTERVAL_MINUTES * 60 * 1000;
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
): Promise<void> {
  try {
    const existing = await db
      .prepare('SELECT profile_text, updated_at FROM student_profiles WHERE student_id = ? AND subject = ?')
      .bind(studentId, subject)
      .first<{ profile_text: string; updated_at: string }>();

    if (existing && !shouldRefine(existing.updated_at, new Date())) return;

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
  } catch (e) {
    console.error('profile refine failed (ignored):', e);
  }
}
