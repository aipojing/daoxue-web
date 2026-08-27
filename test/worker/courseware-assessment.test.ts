import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateCoursewareAssessment } from '../../src/worker/courseware/assessment';
import { createCoursewareRepository } from '../../src/worker/courseware/repository';
import { processSelfLearnMessage } from '../../src/worker/selflearn/process';

interface Fixture {
  userId: number;
  studentId: number;
  coursewareId: number;
}

interface Envelope<T> { success: boolean; data: T | null; error: string | null }
const worker = exports.default as unknown as { fetch(input: string, init?: RequestInit): Promise<Response> };
async function api(path: string, init: RequestInit = {}, cookie = ''): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  return worker.fetch(`https://example.com${path}`, { ...init, headers });
}
async function body<T>(response: Response): Promise<Envelope<T>> { return response.json<Envelope<T>>(); }

async function fixture(options: { status?: 'ready' | 'generating'; sourceConversationId?: number | null } = {}): Promise<Fixture> {
  const user = await env.DB.prepare(
    "INSERT INTO users(email, password_hash) VALUES (?, 'hash') RETURNING id",
  ).bind(`assessment-${crypto.randomUUID()}@example.com`).first<{ id: number }>();
  const student = await env.DB.prepare(
    "INSERT INTO students(user_id, name, grade) VALUES (?, '小明', '初二') RETURNING id",
  ).bind(user?.id).first<{ id: number }>();
  if (!user || !student) throw new Error('assessment fixture unavailable');
  const status = options.status ?? 'ready';
  const courseware = await env.DB.prepare(
    `INSERT INTO coursewares
       (student_id, source_conversation_id, subject, grade, topic, learning_goal, title,
        status, generation_stage, progress_percent, model_snapshot_json, learning_objectives_json,
        checkpoint_answers_json)
     VALUES (?, ?, '数学', '初二', '一次函数', '能判断一次函数并说明斜率意义', '一次函数语音课',
       ?, ?, ?, '{}', '["判断一次函数","解释斜率"]', '{"check-1":1}') RETURNING id`,
  ).bind(student.id, options.sourceConversationId ?? null, status,
    status === 'ready' ? 'ready' : 'speech', status === 'ready' ? 100 : 40).first<{ id: number }>();
  if (!courseware) throw new Error('courseware fixture unavailable');
  return { userId: user.id, studentId: student.id, coursewareId: courseware.id };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM invite_codes').run();
  await env.DB.prepare('DELETE FROM users').run();
});

afterEach(() => vi.unstubAllGlobals());

describe('courseware formal assessment', () => {
  it('requires an owned ready courseware before starting assessment', async () => {
    const pending = await fixture({ status: 'generating' });
    const other = await fixture();
    await expect(getOrCreateCoursewareAssessment(env, pending.userId, pending.coursewareId))
      .rejects.toMatchObject({ status: 409 });
    await expect(getOrCreateCoursewareAssessment(env, other.userId, pending.coursewareId))
      .rejects.toMatchObject({ status: 403 });
  });

  it('reuses an owned source selflearn-daily conversation', async () => {
    const base = await fixture();
    const source = await env.DB.prepare(
      `INSERT INTO conversations(student_id, subject, mode, title)
       VALUES (?, 'selflearn', 'selflearn-daily', '今日学习') RETURNING id`,
    ).bind(base.studentId).first<{ id: number }>();
    await env.DB.prepare('UPDATE coursewares SET source_conversation_id = ? WHERE id = ?')
      .bind(source?.id, base.coursewareId).run();
    const result = await getOrCreateCoursewareAssessment(env, base.userId, base.coursewareId);
    expect(result.conversationId).toBe(source?.id);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM conversations WHERE student_id = ?')
      .bind(base.studentId).first<{ count: number }>()).toEqual({ count: 1 });
  });

  it('creates one linked selflearn-daily conversation when no qualified source exists', async () => {
    const base = await fixture();
    const result = await getOrCreateCoursewareAssessment(env, base.userId, base.coursewareId);
    const conversation = await env.DB.prepare(
      'SELECT student_id, subject, mode, title FROM conversations WHERE id = ?',
    ).bind(result.conversationId).first<{
      student_id: number; subject: string; mode: string; title: string;
    }>();
    expect(conversation).toEqual({
      student_id: base.studentId, subject: 'selflearn', mode: 'selflearn-daily',
      title: '课后测验 · 一次函数语音课',
    });
  });

  it('does not reuse a profiling or another-student source conversation', async () => {
    const base = await fixture();
    const foreign = await fixture();
    const profiling = await env.DB.prepare(
      `INSERT INTO conversations(student_id, subject, mode, title)
       VALUES (?, 'selflearn', 'selflearn-profiling', '画像') RETURNING id`,
    ).bind(base.studentId).first<{ id: number }>();
    for (const sourceId of [profiling?.id, await env.DB.prepare(
      `INSERT INTO conversations(student_id, subject, mode, title)
       VALUES (?, 'selflearn', 'selflearn-daily', '其他孩子') RETURNING id`,
    ).bind(foreign.studentId).first<{ id: number }>().then((row) => row?.id)]) {
      await env.DB.prepare('UPDATE coursewares SET source_conversation_id = ?, assessment_conversation_id = NULL WHERE id = ?')
        .bind(sourceId, base.coursewareId).run();
      const assessment = await getOrCreateCoursewareAssessment(env, base.userId, base.coursewareId);
      expect(assessment.conversationId).not.toBe(sourceId);
      await env.DB.prepare('UPDATE coursewares SET assessment_conversation_id = NULL WHERE id = ?')
        .bind(base.coursewareId).run();
    }
  });

  it('returns one conversation under repeated and concurrent starts', async () => {
    const base = await fixture();
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      getOrCreateCoursewareAssessment(env, base.userId, base.coursewareId)));
    expect(new Set(results.map((item) => item.conversationId)).size).toBe(1);
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM conversations
       WHERE student_id = ? AND subject = 'selflearn' AND mode = 'selflearn-daily'`,
    ).bind(base.studentId).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it('returns one stable request id and a bounded starter without checkpoint or model data', async () => {
    const base = await fixture();
    const first = await getOrCreateCoursewareAssessment(env, base.userId, base.coursewareId);
    const again = await getOrCreateCoursewareAssessment(env, base.userId, base.coursewareId);
    expect(first).toEqual(again);
    expect(first.requestId).toBe(`courseware-assessment-${base.coursewareId}`);
    expect(first.starterText.length).toBeLessThanOrEqual(1_000);
    expect(first.starterText).toContain('一次函数');
    expect(first.starterText).toContain('一题一答');
    expect(first.starterText).not.toContain('check-1');
    expect(first.starterText).not.toContain('model_snapshot');
  });

  it('does not create mastery evidence from checkpoint progress patches', async () => {
    const base = await fixture();
    expect(await createCoursewareRepository(env.DB).saveProgress(base.userId, base.coursewareId, {
      revision: 1, currentSegmentPosition: 0, currentTimeMs: 900, checkpointAnswers: { 'check-1': 1 },
    })).toBe(true);
    const evidence = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_points WHERE student_id = ?',
    ).bind(base.studentId).first<{ count: number }>();
    expect(evidence?.count).toBe(0);
  });

  it('continues creating mastery evidence and mistake cards from formal selflearn answers', async () => {
    const base = await fixture();
    const assessment = await getOrCreateCoursewareAssessment(env, base.userId, base.coursewareId);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      direction: '数学', nextInstruction: '复测斜率',
      knowledgePoints: [{ direction: '数学', chain: '函数', name: '斜率意义', level: 'L2', evidence: '正式测验回答不完整', needsRetest: true }],
      mistakeCards: [{ title: '判断斜率正负', knowledgePoint: '斜率意义', myAnswer: '不确定', keyError: '未联系增减性', errorTags: ['概念'], correctSteps: '由增减性判断', reminder: '先看增减', retestQuestion: '斜率为负时图像如何变化' }],
    }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await processSelfLearnMessage(
      env.DB, 'fake-personal-key', base.studentId, assessment.conversationId, 'selflearn-daily',
      '【每课输出】\n正式测验：斜率意义判定为 L2。\n【错题卡】\n判断斜率正负答错。',
    );
    expect(await env.DB.prepare('SELECT level FROM knowledge_points WHERE student_id = ?')
      .bind(base.studentId).first<{ level: string }>()).toEqual({ level: 'L2' });
    expect(await env.DB.prepare('SELECT subject FROM mistake_cards WHERE student_id = ?')
      .bind(base.studentId).first<{ subject: string }>()).toEqual({ subject: 'selflearn' });
  });

  it('resumes an old ready assessment while generation is feature-disabled and credentials are absent', async () => {
    const base = await fixture();
    await env.DB.prepare(
      `INSERT INTO app_settings(key, value) VALUES ('courseware_enabled', '0')
       ON CONFLICT(key) DO UPDATE SET value = '0'`,
    ).run();
    const first = await getOrCreateCoursewareAssessment(env, base.userId, base.coursewareId);
    const second = await getOrCreateCoursewareAssessment(env, base.userId, base.coursewareId);
    expect(second).toEqual(first);
  });

  it('mounts an authenticated HTTP assessment route that remains usable while the feature is off', async () => {
    const registration = await api('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ email: 'assessment-http@example.com', password: 'correct-password' }),
    });
    const registered = await body<{ id: number }>(registration);
    const cookie = registration.headers.get('Set-Cookie')?.split(';', 1)[0] ?? '';
    const student = await env.DB.prepare(
      "INSERT INTO students(user_id, name, grade) VALUES (?, '小明', '初二') RETURNING id",
    ).bind(registered.data?.id).first<{ id: number }>();
    const ready = await env.DB.prepare(
      `INSERT INTO coursewares
       (student_id, subject, grade, topic, learning_goal, title, status, generation_stage,
        progress_percent, model_snapshot_json, learning_objectives_json)
       VALUES (?, '数学', '初二', '一次函数', '判断一次函数', '一次函数', 'ready', 'ready', 100, '{}', '[]')
       RETURNING id`,
    ).bind(student?.id).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO app_settings(key, value) VALUES ('courseware_enabled', '0')
       ON CONFLICT(key) DO UPDATE SET value = '0'`,
    ).run();
    expect((await api(`/api/coursewares/${ready?.id}/assessment`, { method: 'POST' })).status).toBe(401);
    const response = await api(`/api/coursewares/${ready?.id}/assessment`, { method: 'POST' }, cookie);
    expect(response.status).toBe(200);
    expect((await body<CoursewareAssessmentShape>(response)).data).toMatchObject({
      requestId: `courseware-assessment-${ready?.id}`,
    });
  });

  it('never exposes a raw or partial machine suffix from historical message rows', async () => {
    const registration = await api('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ email: 'draft-history@example.com', password: 'correct-password' }),
    });
    const registered = await body<{ id: number }>(registration);
    const cookie = registration.headers.get('Set-Cookie')?.split(';', 1)[0] ?? '';
    const student = await env.DB.prepare(
      "INSERT INTO students(user_id, name, grade) VALUES (?, '小明', '初二') RETURNING id",
    ).bind(registered.data?.id).first<{ id: number }>();
    const conversation = await env.DB.prepare(
      `INSERT INTO conversations(student_id, subject, mode, title)
       VALUES (?, 'selflearn', 'selflearn-daily', '今日学习') RETURNING id`,
    ).bind(student?.id).first<{ id: number }>();
    const safeDraft = { subject: '数学', topic: '一次函数', learningGoal: '判断一次函数', sourceText: '前置诊断摘要' };
    await env.DB.prepare(
      `INSERT INTO messages(conversation_id, role, content, courseware_draft_json)
       VALUES (?, 'assistant', ?, ?)`,
    ).bind(conversation?.id,
      '给孩子看的课程说明\n【语音课件任务】\n```json\n{"apiKey":"raw-secret","baseUrl":"https://bad.example',
      JSON.stringify(safeDraft)).run();
    const response = await api(`/api/conversations/${conversation?.id}/messages`, {}, cookie);
    const detail = await body<{ messages: Array<Record<string, unknown>> }>(response);
    expect(detail.data?.messages).toEqual([expect.objectContaining({
      content: '给孩子看的课程说明', coursewareDraft: safeDraft,
    })]);
    const serialized = JSON.stringify(detail.data);
    expect(serialized).not.toContain('raw-secret');
    expect(serialized).not.toContain('bad.example');
    expect(serialized).not.toContain('courseware_draft_json');
  });

  it('preserves marker text from users and from non-selflearn subjects', async () => {
    const registration = await api('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ email: 'draft-scope@example.com', password: 'correct-password' }),
    });
    const registered = await body<{ id: number }>(registration);
    const cookie = registration.headers.get('Set-Cookie')?.split(';', 1)[0] ?? '';
    const student = await env.DB.prepare(
      "INSERT INTO students(user_id, name, grade) VALUES (?, '小明', '初二') RETURNING id",
    ).bind(registered.data?.id).first<{ id: number }>();
    const selflearn = await env.DB.prepare(
      `INSERT INTO conversations(student_id, subject, mode, title)
       VALUES (?, 'selflearn', 'selflearn-daily', '今日学习') RETURNING id`,
    ).bind(student?.id).first<{ id: number }>();
    const math = await env.DB.prepare(
      `INSERT INTO conversations(student_id, subject, mode, title)
       VALUES (?, 'math', 'subject', '数学讨论') RETURNING id`,
    ).bind(student?.id).first<{ id: number }>();
    const markerText = '请解释【语音课件任务】这个字符串';
    await env.DB.batch([
      env.DB.prepare("INSERT INTO messages(conversation_id, role, content) VALUES (?, 'user', ?)")
        .bind(selflearn?.id, markerText),
      env.DB.prepare("INSERT INTO messages(conversation_id, role, content) VALUES (?, 'assistant', ?)")
        .bind(math?.id, markerText),
    ]);
    const selflearnMessages = await body<{ messages: Array<{ content: string }> }>(
      await api(`/api/conversations/${selflearn?.id}/messages`, {}, cookie),
    );
    const mathMessages = await body<{ messages: Array<{ content: string }> }>(
      await api(`/api/conversations/${math?.id}/messages`, {}, cookie),
    );
    expect(selflearnMessages.data?.messages[0]?.content).toBe(markerText);
    expect(mathMessages.data?.messages[0]?.content).toBe(markerText);
  });
});

interface CoursewareAssessmentShape {
  conversationId: number;
  requestId: string;
  starterText: string;
}
