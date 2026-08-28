import { Hono } from 'hono';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import { studentSchema, studentUpdateSchema } from './validation';
import { isSubject } from '../chat/prompt-builder';
import { profileFormSchema, buildProfileTextFromForm } from '../selflearn/profile-form';
import { deleteStudentCoursewareMedia } from '../courseware/media';
import { UserFacingError } from '../lib/errors';

async function saveProfileForm(
  db: D1Database,
  student: { id: number; name: string; grade: string; textbook: string; region: string },
  form: unknown,
): Promise<boolean> {
  const parsed = profileFormSchema.safeParse(form);
  if (!parsed.success) return false;
  const profileText = buildProfileTextFromForm(student, parsed.data);
  await db
    .prepare(
      `INSERT INTO selflearn_profiles (student_id, profile_text, form_json, ready, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'))
       ON CONFLICT(student_id) DO UPDATE SET profile_text = excluded.profile_text,
         form_json = excluded.form_json, ready = 1, updated_at = datetime('now')`,
    )
    .bind(student.id, profileText, JSON.stringify(parsed.data))
    .run();
  return true;
}

export interface StudentRow {
  id: number;
  user_id: number;
  name: string;
  grade: string;
  textbook: string;
  region: string;
  color: string;
  gender: 'male' | 'female' | 'unspecified';
  notes: string;
  created_at: string;
}

export async function getOwnedStudent(
  db: D1Database,
  userId: number,
  studentId: number,
): Promise<StudentRow | null> {
  if (!Number.isInteger(studentId) || studentId < 1) return null;
  return db
    .prepare('SELECT * FROM students WHERE id = ? AND user_id = ?')
    .bind(studentId, userId)
    .first<StudentRow>();
}

export const studentRoutes = new Hono<AppContext>();

studentRoutes.get('/', async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    `SELECT s.*,
       (SELECT COUNT(*) FROM conversations cv WHERE cv.student_id = s.id) AS conversation_count,
       (SELECT COUNT(*) FROM mistake_cards mc WHERE mc.student_id = s.id AND mc.review_status = 'pending') AS pending_mistake_count
     FROM students s WHERE s.user_id = ? ORDER BY s.created_at ASC`,
  )
    .bind(user.id)
    .all();
  return ok(c, results);
});

studentRoutes.post('/', async (c) => {
  const user = c.get('user');
  const raw = (await c.req.json().catch(() => ({}))) as { profileForm?: unknown };
  const body = studentSchema.safeParse(raw);
  if (!body.success) return err(c, body.error.issues[0]?.message ?? '输入不合法');
  const { name, grade, textbook, region, color, gender, notes } = body.data;
  const row = await c.env.DB.prepare(
    `INSERT INTO students (user_id, name, grade, textbook, region, color, gender, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(user.id, name, grade, textbook, region, color, gender, notes)
    .first<StudentRow>();

  if (row && raw.profileForm !== undefined) {
    const savedForm = await saveProfileForm(c.env.DB, row, raw.profileForm);
    if (!savedForm) return err(c, '学生已创建，但画像表单内容不合法，请到自学陪伴页重新填写', 400);
  }
  return ok(c, row);
});

studentRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const student = await getOwnedStudent(c.env.DB, user.id, Number(c.req.param('id')));
  if (!student) return err(c, '学生不存在', 404);
  return ok(c, student);
});

studentRoutes.put('/:id/selflearn/profile-form', async (c) => {
  const user = c.get('user');
  const student = await getOwnedStudent(c.env.DB, user.id, Number(c.req.param('id')));
  if (!student) return err(c, '学生不存在', 404);
  const raw = (await c.req.json().catch(() => ({}))) as { profileForm?: unknown };
  const saved = await saveProfileForm(c.env.DB, student, raw.profileForm);
  if (!saved) return err(c, '画像表单不合法');
  return ok(c, { saved: true });
});

studentRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const student = await getOwnedStudent(c.env.DB, user.id, Number(c.req.param('id')));
  if (!student) return err(c, '学生不存在', 404);

  const body = studentUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(c, body.error.issues[0]?.message ?? '输入不合法');

  const merged = { ...student, ...body.data };
  const row = await c.env.DB.prepare(
    `UPDATE students SET name = ?, grade = ?, textbook = ?, region = ?, color = ?, gender = ?, notes = ?
     WHERE id = ? RETURNING *`,
  )
    .bind(
      merged.name,
      merged.grade,
      merged.textbook,
      merged.region,
      merged.color,
      merged.gender,
      merged.notes,
      student.id,
    )
    .first<StudentRow>();
  return ok(c, row);
});

studentRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const studentId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(studentId) || studentId < 1) return err(c, '学生不存在', 404);
  await c.env.DB.prepare(
    `INSERT INTO courseware_student_tombstones(user_id, student_id)
     SELECT user_id, id FROM students WHERE id = ? AND user_id = ?
     ON CONFLICT(user_id, student_id) DO UPDATE SET updated_at = datetime('now')`,
  ).bind(studentId, user.id).run();
  const tombstone = await c.env.DB.prepare(
    'SELECT student_id FROM courseware_student_tombstones WHERE user_id = ? AND student_id = ?',
  ).bind(user.id, studentId).first<{ student_id: number }>();
  if (!tombstone) return err(c, '学生不存在', 404);
  const student = await getOwnedStudent(c.env.DB, user.id, studentId);
  await c.env.DB.prepare(
    `UPDATE coursewares SET status = 'deleting', lease_token = NULL, lease_expires_at = NULL,
       enqueue_token = NULL, enqueue_kind = NULL, enqueue_expires_at = NULL,
       updated_at = datetime('now')
     WHERE student_id = ? AND EXISTS (
       SELECT 1 FROM courseware_student_tombstones t
       WHERE t.user_id = ? AND t.student_id = coursewares.student_id
     )`,
  ).bind(studentId, user.id).run();
  if (student) {
    try {
      await deleteStudentCoursewareMedia(c.env.COURSEWARE_MEDIA, user.id, studentId);
    } catch {
      throw new UserFacingError('学生课件媒体删除暂时失败，请稍后重试', 503);
    }
    await c.env.DB.prepare('DELETE FROM students WHERE id = ? AND user_id = ?')
      .bind(studentId, user.id).run();
  }
  try {
    await deleteStudentCoursewareMedia(c.env.COURSEWARE_MEDIA, user.id, studentId);
  } catch {
    throw new UserFacingError('学生课件媒体删除暂时失败，请稍后重试', 503);
  }
  await c.env.DB.prepare(
    'DELETE FROM courseware_student_tombstones WHERE user_id = ? AND student_id = ?',
  ).bind(user.id, studentId).run();
  return ok(c, { deleted: true });
});

studentRoutes.get('/:id/profiles', async (c) => {
  const user = c.get('user');
  const student = await getOwnedStudent(c.env.DB, user.id, Number(c.req.param('id')));
  if (!student) return err(c, '学生不存在', 404);
  const { results } = await c.env.DB.prepare(
    'SELECT subject, profile_text, updated_at FROM student_profiles WHERE student_id = ?',
  )
    .bind(student.id)
    .all();
  return ok(c, results);
});

studentRoutes.put('/:id/profiles/:subject', async (c) => {
  const user = c.get('user');
  const student = await getOwnedStudent(c.env.DB, user.id, Number(c.req.param('id')));
  if (!student) return err(c, '学生不存在', 404);

  const subject = c.req.param('subject');
  if (!isSubject(subject)) return err(c, '学科不合法');

  const body = (await c.req.json().catch(() => ({}))) as { profileText?: unknown };
  if (typeof body.profileText !== 'string' || body.profileText.length > 2000) {
    return err(c, '画像内容不合法（最长 2000 字）');
  }

  await c.env.DB.prepare(
    `INSERT INTO student_profiles (student_id, subject, profile_text, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(student_id, subject) DO UPDATE SET profile_text = excluded.profile_text, updated_at = datetime('now')`,
  )
    .bind(student.id, subject, body.profileText.trim())
    .run();
  return ok(c, { saved: true });
});
