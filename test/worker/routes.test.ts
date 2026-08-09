import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeRefineProfile } from '../../src/worker/profiles/refine';
import { SETTING_KEYS } from '../../src/worker/lib/settings';
import { releaseConversationChatLease, tryAcquireConversationChatLease } from '../../src/worker/chat/lease';
import {
  beijingToday,
  checkAndIncrementQuota,
  refundQuota,
  reserveQuotaForExistingChatMessage,
} from '../../src/worker/chat/quota';

interface Envelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

const worker = exports.default as unknown as {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

async function api(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  return worker.fetch(`https://example.com${path}`, { ...init, headers });
}

async function json<T>(response: Response): Promise<Envelope<T>> {
  return response.json<Envelope<T>>();
}

function sessionCookie(response: Response): string {
  const value = response.headers.get('Set-Cookie');
  if (!value) throw new Error('响应未设置 session cookie');
  return value.split(';', 1)[0] ?? '';
}

async function register(email: string, inviteCode?: string) {
  const response = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct-password', inviteCode }),
  });
  return { response, body: await json<{ id: number; isAdmin: boolean }>(response), cookie: response.ok ? sessionCookie(response) : '' };
}

async function createAdmin() {
  const result = await register('admin@example.com');
  expect(result.response.status).toBe(200);
  expect(result.body.data?.isAdmin).toBe(true);
  return result;
}

async function createInvite(adminCookie: string, maxUses = 1): Promise<string> {
  const response = await api(
    '/api/admin/invite-codes',
    { method: 'POST', body: JSON.stringify({ note: 'test', maxUses }) },
    adminCookie,
  );
  expect(response.status).toBe(200);
  const body = await json<{ code: string }>(response);
  return body.data?.code ?? '';
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_ai_settings'),
    env.DB.prepare('DELETE FROM invite_codes'),
    env.DB.prepare('DELETE FROM login_failures'),
    env.DB.prepare('DELETE FROM app_settings'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

describe('画像提炼并发预算', () => {
  it('同一学生学科并发触发时只调用一次模型', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash) VALUES (1, 'admin@example.com', 'hash')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO students (id, user_id, name, grade) VALUES (1, 1, '小明', '初二')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO conversations (id, student_id, subject, title) VALUES (1, 1, 'math', '测试')`,
    ).run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content) VALUES (1, 'user', '问题')`,
      ),
      env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content) VALUES (1, 'assistant', '回答')`,
      ),
    ]);

    const upstream = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"profile":"新画像"}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', upstream);
    const settings = {
      [SETTING_KEYS.profileRefineIntervalMinutes]: '10',
      [SETTING_KEYS.profileRefineDailyLimit]: '1',
    };

    await Promise.all([
      maybeRefineProfile(env.DB, 'key', 1, 'math', settings),
      maybeRefineProfile(env.DB, 'key', 1, 'math', settings),
    ]);

    expect(upstream).toHaveBeenCalledTimes(1);
    const log = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM profile_refine_log WHERE student_id = 1 AND subject = 'math'`,
    ).first<{ n: number }>();
    expect(log?.n).toBe(1);
  });
});

describe('对话额度并发安全', () => {
  it('并发扣减不突破上限，并发退还不会变成负数', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash) VALUES (1, 'quota@example.com', 'hash')`,
    ).run();
    const day = '2026-08-09';

    const charged = await Promise.all(
      Array.from({ length: 10 }, () => checkAndIncrementQuota(env.DB, 1, 5, day)),
    );
    expect(charged.filter((result) => result.allowed)).toHaveLength(5);
    expect(charged.filter((result) => !result.allowed)).toHaveLength(5);
    expect(
      (await env.DB.prepare(
        'SELECT message_count FROM usage_log WHERE user_id = 1 AND date = ?',
      ).bind(day).first<{ message_count: number }>())?.message_count,
    ).toBe(5);

    await Promise.all(Array.from({ length: 10 }, () => refundQuota(env.DB, 1, day)));
    expect(
      (await env.DB.prepare(
        'SELECT message_count FROM usage_log WHERE user_id = 1 AND date = ?',
      ).bind(day).first<{ message_count: number }>())?.message_count,
    ).toBe(0);
  });

  it('恢复消息已被删除时不泄漏额度', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash) VALUES (1, 'quota@example.com', 'hash')`,
    ).run();

    expect(await reserveQuotaForExistingChatMessage(env.DB, {
      userId: 1,
      limit: 5,
      today: '2026-08-09',
      messageId: 999,
    })).toBe(false);
    expect(
      await env.DB.prepare(
        'SELECT message_count FROM usage_log WHERE user_id = 1 AND date = ?',
      ).bind('2026-08-09').first(),
    ).toBeNull();
  });
});

describe('Worker 基础响应与鉴权', () => {
  it('健康检查和 404 都保持统一 envelope', async () => {
    const health = await api('/api/health');
    expect(health.status).toBe(200);
    expect(await json(health)).toEqual({ success: true, data: { ok: true }, error: null });

    const missing = await api('/api/not-found');
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ success: false, data: null, error: '接口不存在' });
  });

  it('未登录不能访问学生资源', async () => {
    const response = await api('/api/students');
    expect(response.status).toBe(401);
    expect((await json(response)).error).toBe('未登录');
  });

  it('同邮箱并发错误登录只允许前 5 次进入校验', async () => {
    await createAdmin();
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', password: 'wrong-password' }),
      })),
    );

    const statuses = attempts.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
    const failures = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM login_failures WHERE email = 'admin@example.com'`,
    ).first<{ n: number }>();
    expect(failures?.n).toBe(5);
  });
});

describe('注册与管理员权限', () => {
  it('首管理员的 session 写入失败时回滚用户', async () => {
    await env.DB.prepare(
      `CREATE TRIGGER fail_registration_session
       BEFORE INSERT ON sessions
       BEGIN SELECT RAISE(ABORT, 'forced session failure'); END`,
    ).run();

    let result: Awaited<ReturnType<typeof register>>;
    try {
      result = await register('admin@example.com');
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_registration_session').run();
    }

    expect(result.response.status).toBe(500);
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
    expect(users?.n).toBe(0);
    expect(sessions?.n).toBe(0);
  });

  it('邀请码注册的 session 写入失败时回滚用户和邀请码次数', async () => {
    const admin = await createAdmin();
    const code = await createInvite(admin.cookie);
    await env.DB.prepare(
      `CREATE TRIGGER fail_registration_session
       BEFORE INSERT ON sessions
       BEGIN SELECT RAISE(ABORT, 'forced session failure'); END`,
    ).run();

    let result: Awaited<ReturnType<typeof register>>;
    try {
      result = await register('member@example.com', code);
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_registration_session').run();
    }

    expect(result.response.status).toBe(500);
    const member = await env.DB.prepare(
      `SELECT id FROM users WHERE email = 'member@example.com'`,
    ).first();
    const invite = await env.DB.prepare(
      'SELECT used_count FROM invite_codes WHERE code = ?',
    ).bind(code).first<{ used_count: number }>();
    expect(member).toBeNull();
    expect(invite?.used_count).toBe(0);
  });

  it('只有首个用户可以免邀请码注册', async () => {
    await createAdmin();
    const second = await register('second@example.com');
    expect(second.response.status).toBe(400);
    expect(second.body.error).toContain('邀请码');
  });

  it('空库并发注册时至多一个请求能免邀请码成功', async () => {
    const results = await Promise.all([register('one@example.com'), register('two@example.com')]);
    expect(results.map((result) => result.response.status).sort()).toEqual([200, 400]);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('邀请码注册成功但普通用户仍不能访问管理员接口', async () => {
    const admin = await createAdmin();
    const code = await createInvite(admin.cookie);
    const member = await register('member@example.com', code);
    expect(member.response.status).toBe(200);
    expect(member.body.data?.isAdmin).toBe(false);

    const response = await api('/api/admin/users', {}, member.cookie);
    expect(response.status).toBe(403);
  });

  it('同邮箱并发邀请注册失败时事务回滚占用次数', async () => {
    const admin = await createAdmin();
    const code = await createInvite(admin.cookie, 2);

    const results = await Promise.all([
      register('same@example.com', code),
      register('same@example.com', code),
    ]);

    expect(results.map((result) => result.response.status).sort()).toEqual([200, 409]);
    const invite = await env.DB.prepare(
      'SELECT used_count FROM invite_codes WHERE code = ?',
    ).bind(code).first<{ used_count: number }>();
    expect(invite?.used_count).toBe(1);
  });

  it('单次邀请码被两个不同邮箱并发使用时只创建一个账号', async () => {
    const admin = await createAdmin();
    const code = await createInvite(admin.cookie, 1);

    const results = await Promise.all([
      register('one@example.com', code),
      register('two@example.com', code),
    ]);

    expect(results.map((result) => result.response.status).sort()).toEqual([200, 400]);
    const invite = await env.DB.prepare(
      'SELECT used_count FROM invite_codes WHERE code = ?',
    ).bind(code).first<{ used_count: number }>();
    expect(invite?.used_count).toBe(1);
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(users?.n).toBe(2);
  });

  it('管理员同值更新不会被误报为资源不存在', async () => {
    const admin = await createAdmin();
    const userResponse = await api(`/api/admin/users/${admin.body.data?.id}`, {
      method: 'PUT',
      body: JSON.stringify({ dailyMessageLimit: 100 }),
    }, admin.cookie);
    expect(userResponse.status).toBe(200);

    const code = await createInvite(admin.cookie);
    const invite = await env.DB.prepare('SELECT id FROM invite_codes WHERE code = ?').bind(code).first<{ id: number }>();
    const inviteResponse = await api(`/api/admin/invite-codes/${invite?.id}`, {
      method: 'PUT',
      body: JSON.stringify({ disabled: false }),
    }, admin.cookie);
    expect(inviteResponse.status).toBe(200);
  });
});

describe('资源归属、局部更新与聊天额度', () => {
  it('不同用户之间的学生与会话资源相互隔离', async () => {
    const admin = await createAdmin();
    const studentResponse = await api('/api/students', {
      method: 'POST',
      body: JSON.stringify({ name: '学生甲', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(studentResponse)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST',
      body: JSON.stringify({ subject: 'chemistry' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;

    const code = await createInvite(admin.cookie);
    const member = await register('member@example.com', code);
    expect((await api(`/api/students/${student.id}`, {}, member.cookie)).status).toBe(404);
    expect((await api(`/api/conversations/${conversation.id}/messages`, {}, member.cookie)).status).toBe(404);
  });

  it('只修改姓名时保留其余学生资料', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST',
      body: JSON.stringify({
        name: '旧名', grade: '初二', textbook: '人教版', region: '浙江 杭州', color: '#123456', notes: '保留',
      }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;

    const updated = await api(`/api/students/${student.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: '新名' }),
    }, admin.cookie);
    expect(updated.status).toBe(200);
    expect((await json<Record<string, unknown>>(updated)).data).toMatchObject({
      name: '新名', textbook: '人教版', region: '浙江 杭州', color: '#123456', notes: '保留',
    });
  });

  it('未配置 DeepSeek 时不扣额度也不落用户消息', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'chemistry' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;

    const response = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST', body: JSON.stringify({ content: '测试题目' }),
    }, admin.cookie);
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('请先在「AI 服务」页配置 DeepSeek API Key');
    expect(stream).toContain('"userMessageId":null');
    expect(stream).toContain('"assistantMessageId":null');

    const usage = await env.DB.prepare('SELECT message_count FROM usage_log WHERE user_id = 1').first();
    const messages = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(usage).toBeNull();
    expect(messages?.n).toBe(0);
    const detailAfterError = await api(
      `/api/conversations/${conversation.id}/messages`,
      {},
      admin.cookie,
    );
    expect((await json<{ conversation: { generating: boolean } }>(detailAfterError)).data?.conversation.generating)
      .toBe(false);
  });

  it('额度已用完时原子拒绝且不落 user 消息', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'test-key')"),
      env.DB.prepare('UPDATE users SET daily_message_limit = 1 WHERE id = ?').bind(admin.body.data!.id),
      env.DB.prepare(
        'INSERT INTO usage_log (user_id, date, message_count) VALUES (?, ?, 1)',
      ).bind(admin.body.data!.id, beijingToday()),
    ]);
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const response = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content: '超额问题', requestId: 'request-over-limit' }),
    }, admin.cookie);
    expect(await response.text()).toContain('今日对话次数已用完');
    expect(upstream).not.toHaveBeenCalled();
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
    ).bind(conversation.id).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('上游在用户消息落库后失败时返回对账 ID', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'test-key')`,
    ).run();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('上游失败', { status: 500 })));

    const response = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST', body: JSON.stringify({ content: '我的问题' }),
    }, admin.cookie);
    const stream = await response.text();
    const userMessage = await env.DB.prepare(
      `SELECT id FROM messages WHERE conversation_id = ? AND role = 'user'`,
    ).bind(conversation.id).first<{ id: number }>();

    expect(userMessage?.id).toBeTypeOf('number');
    expect(stream).toContain(`"userMessageId":${userMessage?.id}`);
    expect(stream).toContain('"assistantMessageId":null');
  });

  it('上游中断但部分回复已落库时返回两个对账 ID', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'test-key')`,
      ),
      env.DB.prepare(
        `INSERT INTO student_profiles (student_id, subject, profile_text)
         VALUES (?, 'math', '已有画像')`,
      ).bind(student.id),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response('data: {"choices":[{"delta":{"content":"部分回答"}}]}\n', { status: 200 }),
    ));

    const response = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST', body: JSON.stringify({ content: '我的问题' }),
    }, admin.cookie);
    const stream = await response.text();
    const { results } = await env.DB.prepare(
      `SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY id`,
    ).bind(conversation.id).all<{ id: number; role: string }>();
    const userMessageId = results.find((message) => message.role === 'user')?.id;
    const assistantMessageId = results.find((message) => message.role === 'assistant')?.id;

    expect(stream).toContain(`"userMessageId":${userMessageId}`);
    expect(stream).toContain(`"assistantMessageId":${assistantMessageId}`);
  });

  it('同一个 request ID 重试时不重复落消息、扣额度或调用上游', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'test-key')`,
      ),
      env.DB.prepare(
        `INSERT INTO student_profiles (student_id, subject, profile_text)
         VALUES (?, 'math', '已有画像')`,
      ).bind(student.id),
    ]);
    const upstream = vi.fn().mockImplementation(async () =>
      new Response('data: {"choices":[{"delta":{"content":"答案"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
    );
    vi.stubGlobal('fetch', upstream);
    const body = JSON.stringify({ content: '同一道题', requestId: 'request-12345678' });

    const first = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST', body,
    }, admin.cookie);
    expect(await first.text()).toContain('event: done');
    const second = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST', body,
    }, admin.cookie);
    const secondStream = await second.text();

    expect(secondStream).toContain('已提交');
    expect(upstream).toHaveBeenCalledTimes(1);
    const messages = await env.DB.prepare(
      'SELECT role, client_request_id FROM messages WHERE conversation_id = ? ORDER BY id',
    ).bind(conversation.id).all<{ role: string; client_request_id: string | null }>();
    expect(messages.results).toEqual([
      { role: 'user', client_request_id: 'request-12345678' },
      { role: 'assistant', client_request_id: 'request-12345678' },
    ]);
    const usage = await env.DB.prepare(
      'SELECT message_count FROM usage_log WHERE user_id = ?',
    ).bind(admin.body.data!.id).first<{ message_count: number }>();
    expect(usage?.message_count).toBe(1);
  });

  it('已落 user 但上游失败时，同 request ID 可复用原消息重试模型', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'test-key')`,
      ),
      env.DB.prepare(
        `INSERT INTO student_profiles (student_id, subject, profile_text)
         VALUES (?, 'math', '已有画像')`,
      ).bind(student.id),
    ]);
    const upstream = vi.fn()
      .mockImplementationOnce(async () => new Response('上游失败', { status: 500 }))
      .mockImplementationOnce(async () =>
        new Response('data: {"choices":[{"delta":{"content":"重试成功"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
      );
    vi.stubGlobal('fetch', upstream);
    const body = JSON.stringify({ content: '需要重试的题', requestId: 'request-retry-123' });

    const first = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST', body,
    }, admin.cookie);
    expect(await first.text()).toContain('event: error');
    const second = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST', body,
    }, admin.cookie);
    expect(await second.text()).toContain('event: done');

    expect(upstream).toHaveBeenCalledTimes(2);
    const messages = await env.DB.prepare(
      `SELECT role, client_request_id FROM messages
       WHERE conversation_id = ? ORDER BY id`,
    ).bind(conversation.id).all<{ role: string; client_request_id: string | null }>();
    expect(messages.results).toEqual([
      { role: 'user', client_request_id: 'request-retry-123' },
      { role: 'assistant', client_request_id: 'request-retry-123' },
    ]);
    const usage = await env.DB.prepare(
      'SELECT message_count FROM usage_log WHERE user_id = ?',
    ).bind(admin.body.data!.id).first<{ message_count: number }>();
    expect(usage?.message_count).toBe(1);
  });

  it('恢复已占额度但无 assistant 的 request 时不重复扣额度', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'test-key')`,
      ),
      env.DB.prepare(
        `INSERT INTO student_profiles (student_id, subject, profile_text)
         VALUES (?, 'math', '已有画像')`,
      ).bind(student.id),
      env.DB.prepare(
        `INSERT INTO usage_log (user_id, date, message_count) VALUES (?, ?, 1)`,
      ).bind(admin.body.data!.id, beijingToday()),
      env.DB.prepare(
        `INSERT INTO messages
           (conversation_id, role, content, client_request_id, quota_charged)
         VALUES (?, 'user', '崩溃前已扣额度', 'request-crash-123', 1)`,
      ).bind(conversation.id),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response('data: {"choices":[{"delta":{"content":"恢复成功"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
    ));

    const retried = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content: '崩溃前已扣额度', requestId: 'request-crash-123' }),
    }, admin.cookie);
    expect(await retried.text()).toContain('event: done');

    const usage = await env.DB.prepare(
      'SELECT message_count FROM usage_log WHERE user_id = ?',
    ).bind(admin.body.data!.id).first<{ message_count: number }>();
    expect(usage?.message_count).toBe(1);
  });

  it('已有 user 的 request 仍持有租约时只返回处理中状态', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    const inserted = await env.DB.prepare(
      `INSERT INTO messages (conversation_id, role, content, client_request_id)
       VALUES (?, 'user', '处理中问题', 'request-active-123') RETURNING id`,
    ).bind(conversation.id).first<{ id: number }>();
    expect(await tryAcquireConversationChatLease(env.DB, conversation.id, 'active-token')).toBe(true);

    const response = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content: '处理中问题', requestId: 'request-active-123' }),
    }, admin.cookie);
    const stream = await response.text();
    expect(stream).toContain('正在处理中');
    expect(stream).toContain(`"userMessageId":${inserted?.id}`);

    const deletion = await api(`/api/conversations/${conversation.id}`, {
      method: 'DELETE',
    }, admin.cookie);
    expect(deletion.status).toBe(409);
    expect((await json(deletion)).error).toContain('生成回复');

    await releaseConversationChatLease(env.DB, conversation.id, 'active-token');
  });

  it('相同 request ID 携带不同问题时返回 409 且不改历史', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    await env.DB.prepare(
      `INSERT INTO messages (conversation_id, role, content, client_request_id)
       VALUES (?, 'user', '原问题', 'request-content-123')`,
    ).bind(conversation.id).run();

    const response = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content: '被篡改的新问题', requestId: 'request-content-123' }),
    }, admin.cookie);
    expect(response.status).toBe(409);
    expect((await json(response)).error).toContain('原问题不匹配');
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
    ).bind(conversation.id).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('同一会话已在生成时拒绝第二个并发 chat', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'test-key')`,
    ).run();

    const upstream = vi.fn().mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"不应出现"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
    );
    vi.stubGlobal('fetch', upstream);
    const [firstLease, secondLease] = await Promise.all([
      tryAcquireConversationChatLease(env.DB, conversation.id, 'lease-1'),
      tryAcquireConversationChatLease(env.DB, conversation.id, 'lease-2'),
    ]);
    expect([firstLease, secondLease].filter(Boolean)).toHaveLength(1);

    const detailWhileGenerating = await api(
      `/api/conversations/${conversation.id}/messages`,
      {},
      admin.cookie,
    );
    expect((await json<{ conversation: { generating: boolean } }>(detailWhileGenerating)).data?.conversation.generating)
      .toBe(true);

    const secondResponse = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST', body: JSON.stringify({ content: '问题二' }),
    }, admin.cookie);
    const secondText = await secondResponse.text();

    expect(secondText).toContain('正在生成');
    expect(secondText).toContain('"userMessageId":null');
    expect(upstream).not.toHaveBeenCalled();

    await releaseConversationChatLease(
      env.DB,
      conversation.id,
      firstLease ? 'lease-1' : 'lease-2',
    );

    const detailAfterRelease = await api(
      `/api/conversations/${conversation.id}/messages`,
      {},
      admin.cookie,
    );
    expect((await json<{ conversation: { generating: boolean } }>(detailAfterRelease)).data?.conversation.generating)
      .toBe(false);
  });

  it('过期会话租约可接管，旧 token 不能释放新租约', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST', body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST', body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    await env.DB.prepare(
      `INSERT INTO conversation_chat_leases (conversation_id, lease_token, expires_at)
       VALUES (?, 'old-token', datetime('now', '-1 second'))`,
    ).bind(conversation.id).run();

    expect(await tryAcquireConversationChatLease(env.DB, conversation.id, 'new-token')).toBe(true);
    await releaseConversationChatLease(env.DB, conversation.id, 'old-token');

    const lease = await env.DB.prepare(
      'SELECT lease_token FROM conversation_chat_leases WHERE conversation_id = ?',
    ).bind(conversation.id).first<{ lease_token: string }>();
    expect(lease?.lease_token).toBe('new-token');
  });
});

describe('错题本与自学路由', () => {
  it('从对话提取错题后可筛选、复测和删除', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST',
      body: JSON.stringify({ name: '小明', grade: '初二' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;
    const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST',
      body: JSON.stringify({ subject: 'math' }),
    }, admin.cookie);
    const conversation = (await json<{ id: number }>(conversationResponse)).data!;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', '我算得 1/2 + 1/3 = 2/5')`,
      ).bind(conversation.id),
      env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', '异分母分数应先通分')`,
      ).bind(conversation.id),
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'test-key')`,
      ),
    ]);
    const assistant = await env.DB.prepare(
      `SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant'`,
    ).bind(conversation.id).first<{ id: number }>();
    const cardJson = JSON.stringify({
      title: '异分母分数加法',
      knowledge_point: '分数通分',
      my_answer: '2/5',
      key_error: '直接将分子分母相加',
      error_tags: ['运算规则'],
      correct_steps: '先通分再相加',
      reminder: '异分母先通分',
      retest_question: '计算 1/4 + 1/6',
    });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: cardJson } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const extracted = await api(`/api/conversations/${conversation.id}/mistake-card`, {
      method: 'POST',
      body: JSON.stringify({ messageId: assistant?.id }),
    }, admin.cookie);
    const extractedBody = await json<{ id: number; subject: string; review_status: string }>(extracted);
    expect(extracted.status, extractedBody.error ?? undefined).toBe(200);
    const card = extractedBody.data!;
    expect(card).toMatchObject({ subject: 'math', review_status: 'pending' });

    const pending = await api(
      `/api/students/${student.id}/mistake-cards?subject=math&status=pending`,
      {},
      admin.cookie,
    );
    expect((await json<Array<{ id: number }>>(pending)).data?.map((item) => item.id)).toEqual([card.id]);

    const passed = await api(`/api/mistake-cards/${card.id}`, {
      method: 'PUT',
      body: JSON.stringify({ action: 'pass' }),
    }, admin.cookie);
    expect((await json<{ review_status: string }>(passed)).data?.review_status).toBe('passed');

    expect((await api(`/api/mistake-cards/${card.id}`, { method: 'DELETE' }, admin.cookie)).status).toBe(200);
    const remaining = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM mistake_cards WHERE id = ?',
    ).bind(card.id).first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it('自学概览只对学生所属账号开放', async () => {
    const admin = await createAdmin();
    const created = await api('/api/students', {
      method: 'POST',
      body: JSON.stringify({ name: '小红', grade: '初一' }),
    }, admin.cookie);
    const student = (await json<{ id: number }>(created)).data!;

    const saved = await api(`/api/students/${student.id}/selflearn/profile`, {
      method: 'PUT',
      body: JSON.stringify({ profileText: '数学基础稳定，需要加强阅读理解。' }),
    }, admin.cookie);
    expect(saved.status).toBe(200);
    const conversation = await api(`/api/students/${student.id}/conversations`, {
      method: 'POST',
      body: JSON.stringify({ subject: 'selflearn', mode: 'selflearn-daily' }),
    }, admin.cookie);
    expect(conversation.status).toBe(200);

    const overview = await api(`/api/students/${student.id}/selflearn`, {}, admin.cookie);
    const overviewBody = await json<{
      profile: { profile_text: string; ready: number };
      conversations: Array<{ mode: string }>;
    }>(overview);
    expect(overviewBody.data?.profile).toMatchObject({
      profile_text: '数学基础稳定，需要加强阅读理解。',
      ready: 1,
    });
    expect(overviewBody.data?.conversations).toHaveLength(1);

    const code = await createInvite(admin.cookie);
    const member = await register('member@example.com', code);
    expect(member.response.status).toBe(200);
    expect((await api(`/api/students/${student.id}/selflearn`, {}, member.cookie)).status).toBe(404);
  });
});

interface AISettingsStatus {
  personal: {
    deepseekKeySet: boolean;
    deepseekKeyTail: string;
    visionKeySet: boolean;
    visionKeyTail: string;
    visionProvider: 'zhipu' | 'dashscope';
    visionModel: string;
  };
  sharedFallbackEnabled: boolean;
  effective: {
    deepseekConfigured: boolean;
    deepseekSource: 'personal' | 'shared' | 'none';
    visionEnabled: boolean;
    visionSource: 'personal' | 'shared' | 'none';
  };
}

async function putAISettings(cookie: string, body: unknown): Promise<Response> {
  return api('/api/ai-settings', { method: 'PUT', body: JSON.stringify(body) }, cookie);
}

async function getAISettings(cookie: string): Promise<AISettingsStatus> {
  const response = await api('/api/ai-settings', {}, cookie);
  expect(response.status).toBe(200);
  return (await json<AISettingsStatus>(response)).data!;
}

describe('用户 AI 设置', () => {
  async function setupTwoUsers() {
    const admin = await createAdmin();
    const code = await createInvite(admin.cookie, 2);
    const member = await register('member@example.com', code);
    expect(member.response.status).toBe(200);
    return { admin, member };
  }

  it('未登录不能读取或修改 AI 设置', async () => {
    expect((await api('/api/ai-settings')).status).toBe(401);
    expect((await api('/api/ai-settings', { method: 'PUT', body: '{}' })).status).toBe(401);
  });

  it('两名用户只能看到和修改自己的 Key 状态', async () => {
    const { admin, member } = await setupTwoUsers();
    expect((await putAISettings(admin.cookie, { deepseekApiKey: 'sk-user-a' })).status).toBe(200);
    expect((await putAISettings(member.cookie, { deepseekApiKey: 'sk-user-b' })).status).toBe(200);

    const adminStatus = await getAISettings(admin.cookie);
    const memberStatus = await getAISettings(member.cookie);
    expect(adminStatus.personal).toMatchObject({ deepseekKeySet: true, deepseekKeyTail: 'er-a' });
    expect(memberStatus.personal).toMatchObject({ deepseekKeySet: true, deepseekKeyTail: 'er-b' });

    expect(JSON.stringify(adminStatus)).not.toContain('sk-user-a');
    expect(JSON.stringify(adminStatus)).not.toContain('sk-user-b');
    expect(JSON.stringify(memberStatus)).not.toContain('sk-user-a');
    expect(JSON.stringify(memberStatus)).not.toContain('sk-user-b');

    // D1 中只保存密文、IV 和尾号
    const rows = await env.DB.prepare('SELECT * FROM user_ai_settings').all();
    expect(JSON.stringify(rows.results)).not.toContain('sk-user-a');
    expect(JSON.stringify(rows.results)).not.toContain('sk-user-b');
  });

  it('null 清除、字段省略保留、空字符串拒绝', async () => {
    const { admin } = await setupTwoUsers();
    await putAISettings(admin.cookie, {
      deepseekApiKey: 'sk-user-a',
      visionApiKey: 'vision-user-a',
    });

    const cleared = await putAISettings(admin.cookie, { deepseekApiKey: null });
    expect(cleared.status).toBe(200);
    expect((await getAISettings(admin.cookie)).personal).toMatchObject({
      deepseekKeySet: false,
      deepseekKeyTail: '',
      visionKeySet: true,
    });

    expect((await putAISettings(admin.cookie, { visionApiKey: '' })).status).toBe(400);
    expect((await putAISettings(admin.cookie, { visionApiKey: '   ' })).status).toBe(400);
    // 保存后视觉 Key 未被空字符串误删
    expect((await getAISettings(admin.cookie)).personal.visionKeySet).toBe(true);
  });

  it('普通用户无法配置白名单以外的视觉 provider 或未知字段', async () => {
    const { admin } = await setupTwoUsers();
    expect((await putAISettings(admin.cookie, { visionProvider: 'https://attacker.example' })).status).toBe(400);
    expect((await putAISettings(admin.cookie, { visionApiUrl: 'https://attacker.example' })).status).toBe(400);
    expect((await putAISettings(admin.cookie, {})).status).toBe(400);
    const valid = await putAISettings(admin.cookie, { visionApiKey: 'vk-a', visionProvider: 'dashscope' });
    expect(valid.status).toBe(200);
    expect((await getAISettings(admin.cookie)).personal.visionProvider).toBe('dashscope');
  });

  it('只有管理员能启停站点共享兜底，同值更新不报错', async () => {
    const { admin, member } = await setupTwoUsers();

    expect((await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ sharedFallbackEnabled: false }),
    }, member.cookie)).status).toBe(403);

    const initial = await json<{ sharedFallbackEnabled: boolean }>(
      await api('/api/admin/settings', {}, admin.cookie),
    );
    expect(initial.data?.sharedFallbackEnabled).toBe(true);

    const first = await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ sharedFallbackEnabled: false }),
    }, admin.cookie);
    const second = await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ sharedFallbackEnabled: false }),
    }, admin.cookie);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const after = await json<{ sharedFallbackEnabled: boolean }>(
      await api('/api/admin/settings', {}, admin.cookie),
    );
    expect(after.data?.sharedFallbackEnabled).toBe(false);

    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ sharedFallbackEnabled: true }),
    }, admin.cookie);
    const reenabled = await json<{ sharedFallbackEnabled: boolean }>(
      await api('/api/admin/settings', {}, admin.cookie),
    );
    expect(reenabled.data?.sharedFallbackEnabled).toBe(true);
  });

  it('保存或清除后立即返回最新生效来源', async () => {
    const { admin } = await setupTwoUsers();
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('shared_ai_fallback_enabled', '0')`,
    ).run();

    let status = await getAISettings(admin.cookie);
    expect(status.sharedFallbackEnabled).toBe(false);
    expect(status.effective.deepseekSource).toBe('none');

    await putAISettings(admin.cookie, { deepseekApiKey: 'sk-user-a' });
    status = await getAISettings(admin.cookie);
    expect(status.effective).toMatchObject({ deepseekConfigured: true, deepseekSource: 'personal' });

    await putAISettings(admin.cookie, { deepseekApiKey: null });
    status = await getAISettings(admin.cookie);
    expect(status.effective).toMatchObject({ deepseekConfigured: false, deepseekSource: 'none' });
  });
});

async function createStudentAndConversation(cookie: string, subject = 'math') {
  const created = await api('/api/students', {
    method: 'POST',
    body: JSON.stringify({ name: '小明', grade: '初二' }),
  }, cookie);
  const student = (await json<{ id: number }>(created)).data!;
  const conversationResponse = await api(`/api/students/${student.id}/conversations`, {
    method: 'POST',
    body: JSON.stringify({ subject }),
  }, cookie);
  const conversation = (await json<{ id: number }>(conversationResponse)).data!;
  return { student, conversation };
}

function upstreamCallHeaders(upstream: ReturnType<typeof vi.fn>, index = 0): Record<string, string> {
  return (upstream.mock.calls[index]?.[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};
}

describe('账户级 AI 调用链', () => {
  it('聊天优先发送个人 DeepSeek Key', async () => {
    const admin = await createAdmin();
    const { conversation } = await createStudentAndConversation(admin.cookie);
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'sk-shared')`,
    ).run();
    await putAISettings(admin.cookie, { deepseekApiKey: 'sk-personal' });
    const upstream = vi.fn().mockImplementation(async () =>
      new Response('data: {"choices":[{"delta":{"content":"答案"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
    );
    vi.stubGlobal('fetch', upstream);

    const response = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content: '题目' }),
    }, admin.cookie);
    expect(await response.text()).toContain('event: done');
    expect(upstream).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-personal' }),
      }),
    );
  });

  it('无个人 Key 且兜底开启时使用共享 Key', async () => {
    const admin = await createAdmin();
    const { conversation } = await createStudentAndConversation(admin.cookie);
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'sk-shared')`,
    ).run();
    const upstream = vi.fn().mockImplementation(async () =>
      new Response('data: {"choices":[{"delta":{"content":"答案"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
    );
    vi.stubGlobal('fetch', upstream);

    const response = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content: '题目' }),
    }, admin.cookie);
    expect(await response.text()).toContain('event: done');
    expect(upstreamCallHeaders(upstream).Authorization).toBe('Bearer sk-shared');
  });

  it('关闭共享兜底后无个人 Key 不扣额度也不落消息', async () => {
    const admin = await createAdmin();
    const { conversation } = await createStudentAndConversation(admin.cookie);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'sk-shared')`),
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('shared_ai_fallback_enabled', '0')`,
      ),
    ]);
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const response = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content: '题目' }),
    }, admin.cookie);
    expect(await response.text()).toContain('请先在「AI 服务」页配置');
    expect(upstream).not.toHaveBeenCalled();
    const usage = await env.DB.prepare(
      'SELECT message_count FROM usage_log WHERE user_id = ?',
    ).bind(admin.body.data!.id).first();
    const messages = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
    ).bind(conversation.id).first<{ n: number }>();
    expect(usage).toBeNull();
    expect(messages?.n).toBe(0);
  });

  it('个人密文损坏时聊天 fail closed，不使用共享 Key', async () => {
    const admin = await createAdmin();
    const { conversation } = await createStudentAndConversation(admin.cookie);
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'sk-shared')`,
    ).run();
    await putAISettings(admin.cookie, { deepseekApiKey: 'sk-personal' });
    await env.DB.prepare(
      `UPDATE user_ai_settings SET deepseek_key_ciphertext = '!!!corrupted!!!'
       WHERE user_id = ?`,
    ).bind(admin.body.data!.id).run();
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const response = await api(`/api/conversations/${conversation.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content: '题目' }),
    }, admin.cookie);
    expect(await response.text()).toContain('个人 AI 配置无法读取');
    expect(upstream).not.toHaveBeenCalled();
    const messages = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
    ).bind(conversation.id).first<{ n: number }>();
    expect(messages?.n).toBe(0);

    // 同一会话的租约已被释放，修复 Key 后可立即继续
    const leases = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM conversation_chat_leases WHERE conversation_id = ? AND expires_at > datetime(\'now\')',
    ).bind(conversation.id).first<{ n: number }>();
    expect(leases?.n).toBe(0);
  });

  it('OCR 使用个人视觉 Key 和白名单 provider URL', async () => {
    const admin = await createAdmin();
    const { conversation } = await createStudentAndConversation(admin.cookie);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES ('vision_api_key', 'vk-shared')`),
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('vision_api_url', 'https://shared.example.com/v1')`,
      ),
    ]);
    await putAISettings(admin.cookie, {
      visionApiKey: 'vision-personal',
      visionProvider: 'dashscope',
    });
    const upstream = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '识别文字' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', upstream);

    const response = await api(`/api/conversations/${conversation.id}/ocr`, {
      method: 'POST',
      body: JSON.stringify({ image: 'data:image/jpeg;base64,/9j/4AAQ' }),
    }, admin.cookie);
    expect(response.status).toBe(200);
    expect((await json<{ text: string }>(response)).data?.text).toBe('识别文字');
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    expect(upstreamCallHeaders(upstream).Authorization).toBe('Bearer vision-personal');
  });

  it('未配置任何视觉服务时 OCR 引导去 AI 服务页', async () => {
    const admin = await createAdmin();
    const { conversation } = await createStudentAndConversation(admin.cookie);
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('shared_ai_fallback_enabled', '0')`,
    ).run();

    const response = await api(`/api/conversations/${conversation.id}/ocr`, {
      method: 'POST',
      body: JSON.stringify({ image: 'data:image/jpeg;base64,/9j/4AAQ' }),
    }, admin.cookie);
    expect(response.status).toBe(501);
    expect((await json(response)).error).toContain('请先在「AI 服务」页配置图片识别服务');
  });

  it('错题提取使用会话所属账户的个人 Key', async () => {
    const admin = await createAdmin();
    const { conversation } = await createStudentAndConversation(admin.cookie);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', '我算得 1/2 + 1/3 = 2/5')`,
      ).bind(conversation.id),
      env.DB.prepare(
        `INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', '异分母分数应先通分')`,
      ).bind(conversation.id),
      env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'sk-shared')`),
    ]);
    await putAISettings(admin.cookie, { deepseekApiKey: 'sk-personal' });
    const cardJson = JSON.stringify({
      title: '异分母分数加法',
      knowledge_point: '分数通分',
      my_answer: '2/5',
      key_error: '直接将分子分母相加',
      error_tags: ['运算规则'],
      correct_steps: '先通分再相加',
      reminder: '异分母先通分',
      retest_question: '计算 1/4 + 1/6',
    });
    const upstream = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: cardJson } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', upstream);

    const extracted = await api(`/api/conversations/${conversation.id}/mistake-card`, {
      method: 'POST',
      body: JSON.stringify({}),
    }, admin.cookie);
    expect(extracted.status).toBe(200);
    expect(upstreamCallHeaders(upstream).Authorization).toBe('Bearer sk-personal');
  });

  it('/api/auth/me 在保存、清除和启停兜底后返回正确来源', async () => {
    const admin = await createAdmin();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'sk-shared')`),
      env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES ('vision_api_key', 'vk-shared')`),
    ]);
    const me = async () =>
      (await json<{
        aiConfigured: boolean;
        aiSource: string;
        visionEnabled: boolean;
        visionSource: string;
      }>(await api('/api/auth/me', {}, admin.cookie))).data!;

    expect(await me()).toMatchObject({
      aiConfigured: true,
      aiSource: 'shared',
      visionEnabled: true,
      visionSource: 'shared',
    });

    await putAISettings(admin.cookie, { deepseekApiKey: 'sk-personal', visionApiKey: 'vk-personal' });
    expect(await me()).toMatchObject({
      aiConfigured: true,
      aiSource: 'personal',
      visionEnabled: true,
      visionSource: 'personal',
    });

    await putAISettings(admin.cookie, { deepseekApiKey: null, visionApiKey: null });
    expect(await me()).toMatchObject({ aiSource: 'shared', visionSource: 'shared' });

    await env.DB.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('shared_ai_fallback_enabled', '0')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
    expect(await me()).toMatchObject({
      aiConfigured: false,
      aiSource: 'none',
      visionEnabled: false,
      visionSource: 'none',
    });
  });
});
