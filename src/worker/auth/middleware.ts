import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import type { AppContext, AuthUser } from '../env';
import { err } from '../lib/envelope';
import { sha256Hex } from './crypto';

export const SESSION_COOKIE = 'session';

export const requireAuth = createMiddleware<AppContext>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return err(c, '未登录', 401);

  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.is_admin, u.daily_message_limit
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
  )
    .bind(tokenHash)
    .first<AuthUser>();

  if (!row) return err(c, '登录已过期，请重新登录', 401);
  c.set('user', row);
  await next();
});

export const requireAdmin = createMiddleware<AppContext>(async (c, next) => {
  const user = c.get('user');
  if (!user || !user.is_admin) return err(c, '需要管理员权限', 403);
  await next();
});
