import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import { getOwnedStudent } from '../students/routes';
import { buildSystemPrompt, isSubject } from './prompt-builder';
import { getBasePrompt, getSelfLearnBasePrompt } from './prompts';
import { streamChat, type ChatMessage } from './deepseek';
import { hasAssistantOutput } from './output';
import { checkAndIncrementQuota, refundChargedQuotaOnce, refundQuota, beijingToday } from './quota';
import { toUserMessage } from '../lib/errors';
import { validateImageDataUrl, transcribeImage } from './vision';
import { resolveAIConfig } from '../lib/settings';
import { maybeRefineProfile } from '../profiles/refine';
import { processSelfLearnMessage } from '../selflearn/process';
import {
  buildSelfLearnMemory,
  buildSelfLearnSystemPrompt,
  type MemoryKnowledgePoint,
} from '../selflearn/prompt-builder';

const CONTEXT_MESSAGE_LIMIT = 30;
const SELFLEARN_CONTEXT_MESSAGE_LIMIT = 40;
const MAX_CONTENT_LENGTH = 4000;

const chatInputSchema = z.object({
  content: z.string().trim().min(1, '请输入内容').max(MAX_CONTENT_LENGTH, `单条消息最长 ${MAX_CONTENT_LENGTH} 字`),
});

const createConversationSchema = z.object({
  subject: z.string(),
  mode: z.enum(['selflearn-profiling', 'selflearn-daily']).optional(),
  deepThinking: z.boolean().optional().default(false),
});

interface OwnedConversation {
  id: number;
  student_id: number;
  subject: string;
  mode: string;
  title: string;
  deep_thinking: number;
  student_name: string;
  student_grade: string;
  student_textbook: string;
  student_region: string;
  student_notes: string;
}

export async function getOwnedConversation(
  db: D1Database,
  userId: number,
  conversationId: number,
): Promise<OwnedConversation | null> {
  if (!Number.isInteger(conversationId) || conversationId < 1) return null;
  return db
    .prepare(
      `SELECT cv.id, cv.student_id, cv.subject, cv.mode, cv.title, cv.deep_thinking,
              s.name AS student_name, s.grade AS student_grade, s.textbook AS student_textbook,
              s.region AS student_region, s.notes AS student_notes
       FROM conversations cv JOIN students s ON s.id = cv.student_id
       WHERE cv.id = ? AND s.user_id = ?`,
    )
    .bind(conversationId, userId)
    .first<OwnedConversation>();
}

async function buildSelfLearnPrompt(db: D1Database, conv: OwnedConversation): Promise<string> {
  const [profile, knowledgePoints, instructions, lastReport, pendingMistakes] = await Promise.all([
    db
      .prepare('SELECT profile_text, ready FROM selflearn_profiles WHERE student_id = ?')
      .bind(conv.student_id)
      .first<{ profile_text: string; ready: number }>(),
    db
      .prepare('SELECT * FROM knowledge_points WHERE student_id = ? ORDER BY updated_at DESC LIMIT 60')
      .bind(conv.student_id)
      .all<MemoryKnowledgePoint>(),
    db
      .prepare(
        "SELECT next_instruction FROM lesson_outputs WHERE student_id = ? AND next_instruction != '' ORDER BY id DESC LIMIT 3",
      )
      .bind(conv.student_id)
      .all<{ next_instruction: string }>(),
    db
      .prepare('SELECT content FROM daily_reports WHERE student_id = ? ORDER BY id DESC LIMIT 1')
      .bind(conv.student_id)
      .first<{ content: string }>(),
    db
      .prepare(
        `SELECT title, next_review_date FROM mistake_cards
         WHERE student_id = ? AND subject = 'selflearn' AND review_status = 'pending'
         ORDER BY next_review_date ASC LIMIT 8`,
      )
      .bind(conv.student_id)
      .all<{ title: string; next_review_date: string }>(),
  ]);

  const memory = buildSelfLearnMemory({
    profileText: profile?.profile_text ?? null,
    knowledgePoints: knowledgePoints.results,
    recentInstructions: instructions.results.map((r) => r.next_instruction),
    lastDailyReport: lastReport?.content ?? null,
    pendingMistakes: pendingMistakes.results,
  });

  return buildSelfLearnSystemPrompt(
    getSelfLearnBasePrompt(conv.mode),
    { name: conv.student_name, grade: conv.student_grade, notes: conv.student_notes },
    memory,
  );
}

export const conversationStudentRoutes = new Hono<AppContext>();
conversationStudentRoutes.get('/:id/conversations', async (c) => {
  const user = c.get('user');
  const student = await getOwnedStudent(c.env.DB, user.id, Number(c.req.param('id')));
  if (!student) return err(c, '学生不存在', 404);

  const subject = c.req.query('subject');
  let query =
    'SELECT id, subject, mode, title, deep_thinking, created_at, updated_at FROM conversations WHERE student_id = ?';
  const binds: unknown[] = [student.id];
  if (subject) {
    if (!isSubject(subject) && subject !== 'selflearn') return err(c, '学科不合法');
    query += ' AND subject = ?';
    binds.push(subject);
  }
  query += ' ORDER BY updated_at DESC LIMIT 100';
  const { results } = await c.env.DB.prepare(query).bind(...binds).all();
  return ok(c, results);
});

conversationStudentRoutes.post('/:id/conversations', async (c) => {
  const user = c.get('user');
  const student = await getOwnedStudent(c.env.DB, user.id, Number(c.req.param('id')));
  if (!student) return err(c, '学生不存在', 404);

  const body = createConversationSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(c, '输入不合法');
  const { subject, mode, deepThinking } = body.data;

  const isSelfLearn = subject === 'selflearn';
  if (!isSelfLearn && !isSubject(subject)) return err(c, '学科不合法');
  if (isSelfLearn && !mode) return err(c, '自学会话需要指定阶段');

  const finalMode = isSelfLearn ? mode! : 'subject';
  const title = !isSelfLearn
    ? '新会话'
    : finalMode === 'selflearn-profiling'
      ? '画像采集'
      : `每日学习 ${beijingToday()}`;

  const row = await c.env.DB.prepare(
    `INSERT INTO conversations (student_id, subject, mode, title, deep_thinking) VALUES (?, ?, ?, ?, ?)
     RETURNING id, subject, mode, title, deep_thinking, created_at, updated_at`,
  )
    .bind(student.id, subject, finalMode, title, deepThinking ? 1 : 0)
    .first();
  return ok(c, row);
});

export const conversationRoutes = new Hono<AppContext>();
conversationRoutes.get('/:id/messages', async (c) => {
  const user = c.get('user');
  const conv = await getOwnedConversation(c.env.DB, user.id, Number(c.req.param('id')));
  if (!conv) return err(c, '会话不存在', 404);
  const { results } = await c.env.DB.prepare(
    'SELECT id, role, content, reasoning_content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC',
  )
    .bind(conv.id)
    .all();
  return ok(c, {
    conversation: {
      id: conv.id,
      studentId: conv.student_id,
      subject: conv.subject,
      mode: conv.mode,
      title: conv.title,
      deepThinking: !!conv.deep_thinking,
    },
    messages: results,
  });
});

conversationRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const conv = await getOwnedConversation(c.env.DB, user.id, Number(c.req.param('id')));
  if (!conv) return err(c, '会话不存在', 404);
  const body = (await c.req.json().catch(() => ({}))) as { deepThinking?: unknown };
  if (typeof body.deepThinking !== 'boolean') return err(c, '参数不合法');
  await c.env.DB.prepare('UPDATE conversations SET deep_thinking = ? WHERE id = ?')
    .bind(body.deepThinking ? 1 : 0, conv.id)
    .run();
  return ok(c, { saved: true });
});

conversationRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const conv = await getOwnedConversation(c.env.DB, user.id, Number(c.req.param('id')));
  if (!conv) return err(c, '会话不存在', 404);
  await c.env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(conv.id).run();
  return ok(c, { deleted: true });
});

conversationRoutes.post('/:id/ocr', async (c) => {
  const user = c.get('user');
  const conv = await getOwnedConversation(c.env.DB, user.id, Number(c.req.param('id')));
  if (!conv) return err(c, '会话不存在', 404);

  const config = (await resolveAIConfig(c.env.DB, c.env)).vision;
  if (!config) return err(c, '管理员未配置图片识别服务', 501);

  const body = (await c.req.json().catch(() => ({}))) as { image?: unknown };
  const invalid = validateImageDataUrl(body.image as string);
  if (invalid) return err(c, invalid);

  const today = beijingToday();
  const quota = await checkAndIncrementQuota(c.env.DB, user.id, user.daily_message_limit, today);
  if (!quota.allowed) return err(c, '今日对话次数已用完，明天再来吧', 429);

  try {
    const text = await transcribeImage(config, body.image as string);
    return ok(c, { text });
  } catch (e) {
    await refundQuota(c.env.DB, user.id, today);
    return err(c, toUserMessage(e, '图片识别失败，请重试或改为文字输入'), 502);
  }
});

conversationRoutes.post('/:id/chat', async (c) => {
  const user = c.get('user');
  const conv = await getOwnedConversation(c.env.DB, user.id, Number(c.req.param('id')));
  if (!conv) return err(c, '会话不存在', 404);

  const body = chatInputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(c, body.error.issues[0]?.message ?? '输入不合法');
  const content = body.data.content;

  const db = c.env.DB;
  const executionCtx = c.executionCtx;
  const apiKey = (await resolveAIConfig(db, c.env)).deepseekKey;

  const today = beijingToday();

  return streamSSE(c, async (stream) => {
    const sendError = async (message: string) => {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message }) });
    };

    // 累积已生成内容：即使客户端断开或中途异常，也要把 AI 已经产出的部分落库，
    // 否则历史里会出现"学生问了但老师没答"，且这次调用的费用白花。
    const acc = { content: '', reasoning: '' };
    let savedMessageId: number | null = null;
    const quotaCharge = { charged: false };
    const refundChargedQuota = () =>
      refundChargedQuotaOnce(quotaCharge, () => refundQuota(db, user.id, today));

    const persistAssistant = async () => {
      if (!hasAssistantOutput(acc.content, acc.reasoning) || savedMessageId !== null) return;
      const row = await db
        .prepare(
          'INSERT INTO messages (conversation_id, role, content, reasoning_content) VALUES (?, ?, ?, ?) RETURNING id',
        )
        .bind(conv.id, 'assistant', acc.content, acc.reasoning || null)
        .first<{ id: number }>();
      savedMessageId = row?.id ?? null;
      await db
        .prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
        .bind(conv.id)
        .run();

      if (acc.content && conv.subject === 'selflearn') {
        executionCtx.waitUntil(
          processSelfLearnMessage(db, apiKey, conv.student_id, conv.id, conv.mode, acc.content),
        );
      } else if (acc.content && isSubject(conv.subject)) {
        executionCtx.waitUntil(maybeRefineProfile(db, apiKey, conv.student_id, conv.subject));
      }
    };

    try {
      if (!apiKey) {
        await sendError('尚未配置 DeepSeek API Key，请管理员在「设置」页填写');
        return;
      }
      const quota = await checkAndIncrementQuota(db, user.id, user.daily_message_limit, today);
      if (!quota.allowed) {
        await sendError('今日对话次数已用完，明天再来吧');
        return;
      }
      quotaCharge.charged = true;

      await db
        .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
        .bind(conv.id, 'user', content)
        .run();

      if (conv.title === '新会话') {
        const title = content.replace(/\s+/g, ' ').slice(0, 20);
        await db.prepare('UPDATE conversations SET title = ? WHERE id = ?').bind(title, conv.id).run();
      }

      const isSelfLearn = conv.subject === 'selflearn';
      let systemPrompt: string;

      if (isSelfLearn) {
        systemPrompt = await buildSelfLearnPrompt(db, conv);
      } else {
        if (!isSubject(conv.subject)) {
          await sendError('会话学科数据异常');
          return;
        }
        const profile = await db
          .prepare('SELECT profile_text FROM student_profiles WHERE student_id = ? AND subject = ?')
          .bind(conv.student_id, conv.subject)
          .first<{ profile_text: string }>();

        systemPrompt = buildSystemPrompt(
          getBasePrompt(conv.subject),
          {
            name: conv.student_name,
            grade: conv.student_grade,
            textbook: conv.student_textbook,
            region: conv.student_region,
            notes: conv.student_notes,
          },
          profile?.profile_text ?? null,
        );
      }

      const contextLimit = isSelfLearn ? SELFLEARN_CONTEXT_MESSAGE_LIMIT : CONTEXT_MESSAGE_LIMIT;
      const { results: history } = await db
        .prepare(
          `SELECT role, content FROM (
             SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
           ) ORDER BY id ASC`,
        )
        .bind(conv.id, contextLimit)
        .all<{ role: 'user' | 'assistant'; content: string }>();

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ];

      const model = conv.deep_thinking ? 'deepseek-reasoner' : 'deepseek-chat';

      await streamChat(
        apiKey,
        { model, messages },
        {
          onDelta: (text) => {
            acc.content += text;
            return stream.writeSSE({ event: 'delta', data: JSON.stringify({ text }) });
          },
          onReasoning: (text) => {
            acc.reasoning += text;
            return stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ text }) });
          },
        },
      );

      if (!hasAssistantOutput(acc.content, acc.reasoning)) {
        await refundChargedQuota();
        await sendError('AI 未返回内容，请重试');
        return;
      }

      await persistAssistant();
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ messageId: savedMessageId }) });
    } catch (e) {
      console.error('chat stream error:', e);
      // 已生成的部分照样保存，用户刷新后能看到
      await persistAssistant().catch((e2) => console.error('persist partial reply failed:', e2));
      if (!hasAssistantOutput(acc.content, acc.reasoning)) {
        await refundChargedQuota();
      }
      await sendError(toUserMessage(e)).catch(() => {});
    }
  });
});
