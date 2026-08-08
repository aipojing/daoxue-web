import { Hono } from 'hono';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import { getOwnedStudent } from '../students/routes';

export const selfLearnRoutes = new Hono<AppContext>();
selfLearnRoutes.get('/:id/selflearn', async (c) => {
  const user = c.get('user');
  const student = await getOwnedStudent(c.env.DB, user.id, Number(c.req.param('id')));
  if (!student) return err(c, '学生不存在', 404);

  const [profile, knowledgePoints, lessonOutputs, dailyReports, conversations] = await Promise.all([
    c.env.DB.prepare(
      'SELECT profile_text, form_json, ready, updated_at FROM selflearn_profiles WHERE student_id = ?',
    )
      .bind(student.id)
      .first<{ profile_text: string; form_json: string; ready: number; updated_at: string }>(),
    c.env.DB.prepare(
      'SELECT * FROM knowledge_points WHERE student_id = ? ORDER BY direction ASC, updated_at DESC LIMIT 200',
    )
      .bind(student.id)
      .all(),
    c.env.DB.prepare(
      'SELECT id, conversation_id, direction, content, next_instruction, created_at FROM lesson_outputs WHERE student_id = ? ORDER BY id DESC LIMIT 30',
    )
      .bind(student.id)
      .all(),
    c.env.DB.prepare(
      'SELECT id, conversation_id, report_date, content, created_at FROM daily_reports WHERE student_id = ? ORDER BY id DESC LIMIT 14',
    )
      .bind(student.id)
      .all(),
    c.env.DB.prepare(
      `SELECT id, subject, mode, title, deep_thinking, created_at, updated_at FROM conversations
       WHERE student_id = ? AND subject = 'selflearn' ORDER BY updated_at DESC LIMIT 20`,
    )
      .bind(student.id)
      .all(),
  ]);

  return ok(c, {
    profile: profile ?? null,
    knowledgePoints: knowledgePoints.results,
    lessonOutputs: lessonOutputs.results,
    dailyReports: dailyReports.results,
    conversations: conversations.results,
  });
});

selfLearnRoutes.put('/:id/selflearn/profile', async (c) => {
  const user = c.get('user');
  const student = await getOwnedStudent(c.env.DB, user.id, Number(c.req.param('id')));
  if (!student) return err(c, '学生不存在', 404);

  const body = (await c.req.json().catch(() => ({}))) as { profileText?: unknown };
  if (typeof body.profileText !== 'string' || !body.profileText.trim() || body.profileText.length > 8000) {
    return err(c, '画像内容不合法（最长 8000 字）');
  }

  await c.env.DB.prepare(
    `INSERT INTO selflearn_profiles (student_id, profile_text, ready, updated_at)
     VALUES (?, ?, 1, datetime('now'))
     ON CONFLICT(student_id) DO UPDATE SET profile_text = excluded.profile_text, ready = 1, updated_at = datetime('now')`,
  )
    .bind(student.id, body.profileText.trim())
    .run();
  return ok(c, { saved: true });
});
