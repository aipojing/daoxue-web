import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import { hashPassword, verifyPassword, generateToken, sha256Hex } from './crypto';
import { requireAuth, SESSION_COOKIE } from './middleware';
import { resolveAIConfig } from '../lib/settings';
import { UserFacingError } from '../lib/errors';

const SESSION_DAYS = 30;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_FAILURES = 5;

interface RegisteredUser {
  id: number;
  email: string;
  is_admin: number;
  daily_message_limit: number;
}

export type RegistrationInsertResult =
  | { kind: 'created'; user: RegisteredUser }
  | { kind: 'email-exists' }
  | { kind: 'invite-required' }
  | { kind: 'invalid-invite' };

/**
 * 空库管理员的用户与 session、普通注册的邀请码/用户/session 分别放在一个 D1 batch 事务中。
 * 后续语句依赖前一条语句的 changes() 和 last_insert_rowid()，任一写入失败都会整批回滚。
 */
export async function createRegisteredUser(
  db: D1Database,
  email: string,
  passwordHash: string,
  inviteCode: string | undefined,
  sessionTokenHash: string,
): Promise<RegistrationInsertResult> {
  const [firstUserResult, firstSessionResult] = await db.batch([
    db.prepare(
      `INSERT INTO users (email, password_hash, is_admin)
       SELECT ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM users)
       RETURNING id, email, is_admin, daily_message_limit`,
    ).bind(email, passwordHash),
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       SELECT ?, last_insert_rowid(), datetime('now', '+${SESSION_DAYS} days')
       WHERE changes() = 1
       RETURNING id`,
    ).bind(sessionTokenHash),
  ]);
  const firstUser = (firstUserResult?.results as RegisteredUser[] | undefined)?.[0];
  const firstSession = (firstSessionResult?.results as Array<{ id: number }> | undefined)?.[0];
  if (firstUser) {
    if (!firstSession) throw new UserFacingError('注册失败，请重试', 500);
    return { kind: 'created', user: firstUser };
  }

  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return { kind: 'email-exists' };
  if (!inviteCode) return { kind: 'invite-required' };

  try {
    const [claimResult, userResult, sessionResult] = await db.batch([
      db.prepare(
        `UPDATE invite_codes SET used_count = used_count + 1
         WHERE code = ? AND disabled = 0 AND used_count < max_uses
         RETURNING id`,
      ).bind(inviteCode),
      db.prepare(
        `INSERT INTO users (email, password_hash, is_admin)
         SELECT ?, ?, 0 WHERE changes() = 1
         RETURNING id, email, is_admin, daily_message_limit`,
      ).bind(email, passwordHash),
      db.prepare(
        `INSERT INTO sessions (token_hash, user_id, expires_at)
         SELECT ?, last_insert_rowid(), datetime('now', '+${SESSION_DAYS} days')
         WHERE changes() = 1
         RETURNING id`,
      ).bind(sessionTokenHash),
    ]);
    const claimed = (claimResult?.results as Array<{ id: number }> | undefined)?.[0];
    const user = (userResult?.results as RegisteredUser[] | undefined)?.[0];
    const session = (sessionResult?.results as Array<{ id: number }> | undefined)?.[0];
    if (!claimed) return { kind: 'invalid-invite' };
    if (!user || !session) throw new UserFacingError('注册失败，请重试', 500);
    return { kind: 'created', user };
  } catch (error) {
    const duplicate = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first()
      .catch(() => null);
    if (duplicate) return { kind: 'email-exists' };
    throw error;
  }
}

/** 先用单条写语句占用尝试名额，并发请求只有前 maxFailures 个能进入密码校验。 */
export async function reserveLoginAttempt(
  db: D1Database,
  email: string,
  maxFailures = LOGIN_MAX_FAILURES,
): Promise<number | null> {
  await db
    .prepare(
      `DELETE FROM login_failures
       WHERE created_at <= datetime('now', '-${LOGIN_WINDOW_MINUTES} minutes')`,
    )
    .run();

  const row = await db
    .prepare(
      `INSERT INTO login_failures (email)
       SELECT ?1 WHERE (
         SELECT COUNT(*) FROM login_failures
         WHERE email = ?1 AND created_at > datetime('now', '-${LOGIN_WINDOW_MINUTES} minutes')
       ) < ?2
       RETURNING id`,
    )
    .bind(email, maxFailures)
    .first<{ id: number }>();
  return row?.id ?? null;
}

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

  // 这里只做廉价的快速拒绝，不用它决定首用户资格；真正准入仍由下面的原子 INSERT/batch 决定。
  // 避免攻击者用重复邮箱、缺失或明显无效的邀请码无限触发 PBKDF2。
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return err(c, '该邮箱已注册', 409);
  const hasUser = await c.env.DB.prepare('SELECT id FROM users LIMIT 1').first();
  if (hasUser) {
    if (!inviteCode) return err(c, '注册需要邀请码');
    const invite = await c.env.DB
      .prepare(
        `SELECT id FROM invite_codes
         WHERE code = ? AND disabled = 0 AND used_count < max_uses`,
      )
      .bind(inviteCode)
      .first();
    if (!invite) return err(c, '邀请码无效或已用完');
  }

  const passwordHash = await hashPassword(password);
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const inserted = await createRegisteredUser(c.env.DB, email, passwordHash, inviteCode, tokenHash);
  if (inserted.kind === 'email-exists') return err(c, '该邮箱已注册', 409);
  if (inserted.kind === 'invite-required') return err(c, '注册需要邀请码');
  if (inserted.kind === 'invalid-invite') return err(c, '邀请码无效或已用完');

  setSessionCookie(c, token);
  return ok(c, {
    id: inserted.user.id,
    email: inserted.user.email,
    isAdmin: !!inserted.user.is_admin,
  });
});

authRoutes.post('/login', async (c) => {
  const body = loginSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(c, body.error.issues[0]?.message ?? '输入不合法');
  const { email, password } = body.data;

  // 先原子占用一次尝试，避免多个请求同时读到旧计数而绕过限制。
  const attemptId = await reserveLoginAttempt(c.env.DB, email);
  if (attemptId === null) {
    return err(c, `尝试次数过多，请 ${LOGIN_WINDOW_MINUTES} 分钟后再试`, 429);
  }

  try {
    const user = await c.env.DB.prepare(
      'SELECT id, email, password_hash, is_admin FROM users WHERE email = ?',
    )
      .bind(email)
      .first<{ id: number; email: string; password_hash: string; is_admin: number }>();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
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
  } catch (error) {
    // 内部故障不应消耗用户的登录尝试名额。
    await c.env.DB.prepare('DELETE FROM login_failures WHERE id = ?').bind(attemptId).run().catch(() => {});
    throw error;
  }
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
