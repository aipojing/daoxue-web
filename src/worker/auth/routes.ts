import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import { hashPassword, verifyPassword, generateToken, sha256Hex } from './crypto';
import { requireAuth, SESSION_COOKIE } from './middleware';
import { resolveAIConfig } from '../lib/settings';

const SESSION_DAYS = 30;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_FAILURES = 5;

const emailField = z
  .string()
  .trim()
  .max(254, '邮箱过长')
  .email('邮箱格式不正确')
  .transform((s) => s.toLowerCase());

const registerSchema = z.object({
  email: emailField,
  password: z.string().min(8, '密码至少 8 位').max(100, '密码过长'),
  inviteCode: z.string().trim().max(50).optional(),
});

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, '请输入密码').max(100, '密码过长'),
});

async function createSession(c: { env: { DB: D1Database }; req: { url: string } }, userId: number) {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  await c.env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`,
  )
    .bind(tokenHash, userId)
    .run();
  return token;
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string) {
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export const authRoutes = new Hono<AppContext>();

authRoutes.post('/register', async (c) => {
  const body = registerSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(c, body.error.issues[0]?.message ?? '输入不合法');
  const { email, password, inviteCode } = body.data;

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return err(c, '该邮箱已注册', 409);

  const countRow = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  const isFirstUser = (countRow?.n ?? 0) === 0;

  // 原子抢占邀请码：并发注册时不会超发（校验与计数合并为一条语句）
  if (!isFirstUser) {
    if (!inviteCode) return err(c, '注册需要邀请码');
    const claimed = await c.env.DB.prepare(
      `UPDATE invite_codes SET used_count = used_count + 1
       WHERE code = ? AND disabled = 0 AND used_count < max_uses`,
    )
      .bind(inviteCode)
      .run();
    if (!claimed.meta.changes) return err(c, '邀请码无效或已用完');
  }

  const passwordHash = await hashPassword(password);
  // is_admin 在 INSERT 内原子判定，避免并发下两个账号都成为管理员
  const inserted = await c.env.DB.prepare(
    `INSERT INTO users (email, password_hash, is_admin)
     VALUES (?, ?, (SELECT CASE WHEN EXISTS(SELECT 1 FROM users) THEN 0 ELSE 1 END))
     RETURNING id, email, is_admin, daily_message_limit`,
  )
    .bind(email, passwordHash)
    .first<{ id: number; email: string; is_admin: number; daily_message_limit: number }>();
  if (!inserted) return err(c, '注册失败，请重试', 500);

  const token = await createSession(c, inserted.id);
  setSessionCookie(c, token);
  return ok(c, { id: inserted.id, email: inserted.email, isAdmin: !!inserted.is_admin });
});

authRoutes.post('/login', async (c) => {
  const body = loginSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(c, body.error.issues[0]?.message ?? '输入不合法');
  const { email, password } = body.data;

  // 限制暴力破解：同一邮箱 15 分钟内连续失败 5 次即锁定
  const failures = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_failures
     WHERE email = ? AND created_at > datetime('now', '-${LOGIN_WINDOW_MINUTES} minutes')`,
  )
    .bind(email)
    .first<{ n: number }>();
  if ((failures?.n ?? 0) >= LOGIN_MAX_FAILURES) {
    return err(c, `尝试次数过多，请 ${LOGIN_WINDOW_MINUTES} 分钟后再试`, 429);
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, password_hash, is_admin FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ id: number; email: string; password_hash: string; is_admin: number }>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await c.env.DB.prepare('INSERT INTO login_failures (email) VALUES (?)').bind(email).run();
    return err(c, '邮箱或密码错误', 401);
  }

  await c.env.DB.prepare('DELETE FROM login_failures WHERE email = ?').bind(email).run();
  // 顺手清理该用户的过期会话，避免 sessions 表无限增长
  await c.env.DB.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND expires_at <= datetime('now')`,
  )
    .bind(user.id)
    .run();

  const token = await createSession(c, user.id);
  setSessionCookie(c, token);
  return ok(c, { id: user.id, email: user.email, isAdmin: !!user.is_admin });
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return ok(c, { loggedOut: true });
});

authRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const ai = await resolveAIConfig(c.env.DB, c.env);
  return ok(c, {
    id: user.id,
    email: user.email,
    isAdmin: !!user.is_admin,
    visionEnabled: !!ai.vision,
    aiConfigured: !!ai.deepseekKey,
  });
});
