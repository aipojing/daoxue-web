import type { Env } from '../env';
import { UserFacingError } from '../lib/errors';

export interface CoursewareAssessment {
  conversationId: number;
  requestId: string;
  starterText: string;
}

interface AssessmentCoursewareRow {
  id: number;
  student_id: number;
  source_conversation_id: number | null;
  assessment_conversation_id: number | null;
  title: string;
  topic: string;
  learning_goal: string;
  learning_objectives_json: string;
  status: string;
}

function parseObjectives(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 12) : [];
  } catch {
    return [];
  }
}

function assessmentResponse(courseware: AssessmentCoursewareRow, conversationId: number): CoursewareAssessment {
  const objectives = parseObjectives(courseware.learning_objectives_json)
    .map((item) => item.trim()).filter(Boolean).join('、');
  const starterText = [
    `我已经学完语音课件《${courseware.title}》，主题是“${courseware.topic}”。`,
    objectives ? `本课目标是：${objectives}。` : `本课目标是：${courseware.learning_goal}。`,
    '请按现有正式测验流程开始一题一答评估；每次只出一道题，等待我回答后再判定与继续。',
  ].join('\n').slice(0, 1_000);
  return {
    conversationId,
    requestId: `courseware-assessment-${courseware.id}`,
    starterText,
  };
}

export async function getOrCreateCoursewareAssessment(
  env: Env,
  userId: number,
  coursewareId: number,
): Promise<CoursewareAssessment> {
  if (!Number.isSafeInteger(coursewareId) || coursewareId < 1) {
    throw new UserFacingError('无权访问该课件', 403);
  }
  const courseware = await env.DB.prepare(
    `SELECT c.id, c.student_id, c.source_conversation_id, c.assessment_conversation_id,
            c.title, c.topic, c.learning_goal, c.learning_objectives_json, c.status
     FROM coursewares c JOIN students s ON s.id = c.student_id
     WHERE c.id = ? AND s.user_id = ?`,
  ).bind(coursewareId, userId).first<AssessmentCoursewareRow>();
  if (!courseware) throw new UserFacingError('无权访问该课件', 403);
  if (courseware.status !== 'ready') throw new UserFacingError('课件尚未完成，暂时不能开始正式测验', 409);

  if (courseware.assessment_conversation_id) {
    const existing = await env.DB.prepare(
      `SELECT cv.id FROM conversations cv JOIN students s ON s.id = cv.student_id
       WHERE cv.id = ? AND cv.student_id = ? AND s.user_id = ?`,
    ).bind(courseware.assessment_conversation_id, courseware.student_id, userId).first<{ id: number }>();
    if (existing) return assessmentResponse(courseware, existing.id);
  }

  const source = courseware.source_conversation_id ? await env.DB.prepare(
    `SELECT cv.id FROM conversations cv JOIN students s ON s.id = cv.student_id
     WHERE cv.id = ? AND cv.student_id = ? AND cv.subject = 'selflearn'
       AND cv.mode = 'selflearn-daily' AND s.user_id = ?`,
  ).bind(courseware.source_conversation_id, courseware.student_id, userId).first<{ id: number }>() : null;

  let candidateId = source?.id ?? null;
  let createdCandidate = false;
  if (!candidateId) {
    const title = `课后测验 · ${courseware.title}`.slice(0, 200);
    const created = await env.DB.prepare(
      `INSERT INTO conversations(student_id, subject, mode, title)
       VALUES (?, 'selflearn', 'selflearn-daily', ?) RETURNING id`,
    ).bind(courseware.student_id, title).first<{ id: number }>();
    if (!created) throw new UserFacingError('正式测验会话创建失败，请稍后重试', 503);
    candidateId = created.id;
    createdCandidate = true;
  }

  const attached = await env.DB.prepare(
    `UPDATE coursewares SET assessment_conversation_id = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'ready' AND assessment_conversation_id IS NULL AND EXISTS (
       SELECT 1 FROM students s WHERE s.id = coursewares.student_id AND s.user_id = ?
     )`,
  ).bind(candidateId, courseware.id, userId).run();

  let winnerId = candidateId;
  if (attached.meta.changes !== 1) {
    const winner = await env.DB.prepare(
      `SELECT c.assessment_conversation_id AS id FROM coursewares c JOIN students s ON s.id = c.student_id
       JOIN conversations cv ON cv.id = c.assessment_conversation_id
       WHERE c.id = ? AND c.status = 'ready' AND s.user_id = ? AND cv.student_id = c.student_id`,
    ).bind(courseware.id, userId).first<{ id: number }>();
    if (createdCandidate) {
      await env.DB.prepare(
        `DELETE FROM conversations WHERE id = ? AND NOT EXISTS (
           SELECT 1 FROM coursewares WHERE assessment_conversation_id = ?
         )`,
      ).bind(candidateId, candidateId).run();
    }
    if (!winner) throw new UserFacingError('课件状态已变化，请刷新后重试', 409);
    winnerId = winner.id;
  }
  return assessmentResponse(courseware, winnerId);
}
