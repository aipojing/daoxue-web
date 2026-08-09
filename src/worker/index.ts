import { Hono } from 'hono';
import type { AppContext } from './env';
import { ok, err } from './lib/envelope';
import { requireAuth, requireAdmin } from './auth/middleware';
import { authRoutes } from './auth/routes';
import { studentRoutes } from './students/routes';
import { conversationStudentRoutes, conversationRoutes } from './chat/routes';
import { mistakeExtractRoutes, mistakeStudentRoutes, mistakeCardRoutes } from './mistakes/routes';
import { selfLearnRoutes } from './selflearn/routes';
import { userAISettingsRoutes } from './settings/routes';
import { adminRoutes } from './admin/routes';
import { toHttpError } from './lib/errors';

const app = new Hono<AppContext>();

app.get('/api/health', (c) => ok(c, { ok: true }));
app.route('/api/auth', authRoutes);

// 鉴权在此统一执行一次。子应用各自 use('*') 会导致同一前缀下每个子应用都跑一遍，
// 一个请求要重复查 4 次会话表。
app.use('/api/students/*', requireAuth);
app.use('/api/conversations/*', requireAuth);
app.use('/api/mistake-cards/*', requireAuth);
app.use('/api/admin/*', requireAuth, requireAdmin);
app.route('/api/students', conversationStudentRoutes);
app.route('/api/students', mistakeStudentRoutes);
app.route('/api/students', selfLearnRoutes);
app.route('/api/students', studentRoutes);
app.route('/api/conversations', mistakeExtractRoutes);
app.route('/api/conversations', conversationRoutes);
app.route('/api/mistake-cards', mistakeCardRoutes);
// requireAuth 已在子路由内执行一次，这里不再重复挂载
app.route('/api/ai-settings', userAISettingsRoutes);
app.route('/api/admin', adminRoutes);

app.notFound((c) => err(c, '接口不存在', 404));

app.onError((e, c) => {
  console.error('Unhandled error:', e);
  const httpError = toHttpError(e);
  return err(c, httpError.message, httpError.status);
});

export default app;
