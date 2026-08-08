import { Hono } from 'hono';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import { getOwnedStudent } from '../students/routes';
import { getOwnedConversation } from '../chat/routes';
import { completeJSON, type ChatMessage } from '../chat/deepseek';
import { isSubject } from '../chat/prompt-builder';
import { EXTRACT_INSTRUCTION, parseMistakeCard } from './extract';
import { resolveAIConfig } from '../lib/settings';
import { checkAndIncrementQuota, refundQuota, beijingToday, beijingDatePlus } from '../chat/quota';
import { toUserMessage } from '../lib/errors';

const EXTRACT_MESSAGE_LIMIT = 20;
const REVIEW_DELAY_INITIAL_DAYS = 2;
const REVIEW_DELAY_FAILED_DAYS = 3;

export const mistakeExtractRoutes = new Hono<AppContext>();
mistakeExtractRoutes.post('/:id/mistake-card', async (c) => {
  const user = c.get('user');
  const conv = await getOwnedConversation(c.env.DB, user.id, Number(c.req.param('id')));
  if (!conv) return err(c, '会话不存在', 404);
  if (!isSubject(conv.subject)) return err(c, '会话学科数据异常', 500);

  // 支持消息级提取：传 messageId 时只取该条 AI 回复及其之前的对话，
  // 这样在长会话里点某一题的"存入错题本"，存的就是那一题
  const body = (await c.req.json().catch(() => ({}))) as { messageId?: unknown };
  const messageId =
    typeof body.messageId === 'number' && Number.isInteger(body.messageId) && body.messageId > 0
      ? body.messageId
      : null;

  if (messageId !== null) {
    const belongs = await c.env.DB.prepare(
      'SELECT id FROM messages WHERE id = ? AND conversation_id = ?',
    )
      .bind(messageId, conv.id)
      .first();
    if (!belongs) return err(c, '消息不存在', 404);
  }

  const { results: recent } = await c.env.DB.prepare(
    `SELECT role, content FROM (
       SELECT id, role, content FROM messages
       WHERE conversation_id = ?1 AND (?2 IS NULL OR id <= ?2)
       ORDER BY id DESC LIMIT ?3
     ) ORDER BY id ASC`,
  )
    .bind(conv.id, messageId, EXTRACT_MESSAGE_LIMIT)
    .all<{ role: string; content: string }>();

  if (recent.length < 2) return err(c, '对话内容太少，还无法提取错题', 422);

  const transcript = recent
    .map((m) => `${m.role === 'user' ? '学生' : '老师'}：${m.content}`)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'user', content: `【辅导对话记录】\n\n${transcript}\n\n---\n\n${EXTRACT_INSTRUCTION}` },
  ];

  const { deepseekKey } = await resolveAIConfig(c.env.DB, c.env);
  if (!deepseekKey) return err(c, '尚未配置 DeepSeek API Key，请管理员在「设置」页填写', 501);

  // 这里同样会调用付费模型，必须计入每日额度
  const today = beijingToday();
  const quota = await checkAndIncrementQuota(c.env.DB, user.id, user.daily_message_limit, today);
  if (!quota.allowed) return err(c, '今日对话次数已用完，明天再来吧', 429);

  let raw: string;
  try {
    raw = await completeJSON(deepseekKey, { messages });
  } catch (e) {
    await refundQuota(c.env.DB, user.id, today);
    return err(c, toUserMessage(e), 502);
  }

  const parsed = parseMistakeCard(raw);
  if ('error' in parsed) return err(c, parsed.error, 502);
  if ('noMistake' in parsed) return err(c, '本次对话未发现值得收录的错题', 422);

  const card = parsed.card;
  const row = await c.env.DB.prepare(
    `INSERT INTO mistake_cards
       (student_id, subject, conversation_id, title, knowledge_point, my_answer, key_error,
        error_tags, correct_steps, reminder, retest_question, next_review_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(
      conv.student_id,
      conv.subject,
      conv.id,
      card.title,
      card.knowledge_point,
      card.my_answer,
      card.key_error,
      JSON.stringify(card.error_tags),
      card.correct_steps,
      card.reminder,
      card.retest_question,
      beijingDatePlus(REVIEW_DELAY_INITIAL_DAYS),
    )
    .first();

  return ok(c, row);
});

export const mistakeStudentRoutes = new Hono<AppContext>();
mistakeStudentRoutes.get('/:id/mistake-cards', async (c) => {
  const user = c.get('user');
  const student = await getOwnedStudent(c.env.DB, user.id, Number(c.req.param('id')));
  if (!student) return err(c, '学生不存在', 404);

  const subject = c.req.query('subject');
  const status = c.req.query('status');
  let query = 'SELECT * FROM mistake_cards WHERE student_id = ?';
  const binds: unknown[] = [student.id];
  if (subject) {
    if (!isSubject(subject) && subject !== 'selflearn') return err(c, '学科不合法');
    query += ' AND subject = ?';
    binds.push(subject);
  }
  if (status) {
    if (status !== 'pending' && status !== 'passed') return err(c, '状态不合法');
    query += ' AND review_status = ?';
    binds.push(status);
  }
  query += ' ORDER BY next_review_date ASC, id DESC LIMIT 500';
  const { results } = await c.env.DB.prepare(query).bind(...binds).all();
  return ok(c, results);
});

export const mistakeCardRoutes = new Hono<AppContext>();
async function getOwnedCard(db: D1Database, userId: number, cardId: number) {
  if (!Number.isInteger(cardId) || cardId < 1) return null;
  return db
    .prepare(
      `SELECT mc.* FROM mistake_cards mc JOIN students s ON s.id = mc.student_id
       WHERE mc.id = ? AND s.user_id = ?`,
    )
    .bind(cardId, userId)
    .first<{ id: number }>();
}

mistakeCardRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const card = await getOwnedCard(c.env.DB, user.id, Number(c.req.param('id')));
  if (!card) return err(c, '错题卡不存在', 404);

  const body = (await c.req.json().catch(() => ({}))) as { action?: unknown };
  if (body.action === 'pass') {
    await c.env.DB.prepare("UPDATE mistake_cards SET review_status = 'passed' WHERE id = ?")
      .bind(card.id)
      .run();
  } else if (body.action === 'fail') {
    await c.env.DB.prepare(
      `UPDATE mistake_cards SET review_status = 'pending', next_review_date = ? WHERE id = ?`,
    )
      .bind(beijingDatePlus(REVIEW_DELAY_FAILED_DAYS), card.id)
      .run();
  } else {
    return err(c, '操作不合法');
  }
  const updated = await c.env.DB.prepare('SELECT * FROM mistake_cards WHERE id = ?').bind(card.id).first();
  return ok(c, updated);
});

mistakeCardRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const card = await getOwnedCard(c.env.DB, user.id, Number(c.req.param('id')));
  if (!card) return err(c, '错题卡不存在', 404);
  await c.env.DB.prepare('DELETE FROM mistake_cards WHERE id = ?').bind(card.id).run();
  return ok(c, { deleted: true });
});
