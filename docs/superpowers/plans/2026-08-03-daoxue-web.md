# 题解导学网站实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建并部署一个基于四套学科题解导学提示词的家庭 AI 辅导网站：账号→多学生→独立设置与记忆（对话历史/错题本/学习画像），DeepSeek API，Cloudflare Workers + D1。

**Architecture:** 单 Cloudflare Worker：Hono 提供 `/api/*` JSON+SSE 接口，同 Worker 通过 Workers Static Assets 托管 Vite 构建的 React SPA。D1 存储全部数据。DeepSeek 调用仅发生在服务端（Key 为 Worker Secret）。

**Tech Stack:** TypeScript、Hono 4、Cloudflare Workers + D1、Vite 6 + React 18 + react-router-dom 7、react-markdown + remark-math + rehype-katex、zod、Vitest。

## Global Constraints

- 学科枚举固定：`math` / `chinese` / `physics` / `english`（数据库、API、前端一致）。
- API 响应统一 envelope：`{success: boolean, data: T|null, error: string|null}`（SSE 端点除外）。
- 所有资源必须做归属校验：student 属于当前 user，conversation/mistake_card/profile 属于当前 user 的 student。
- 所有 API 输入用 zod 校验；上游 DeepSeek 错误必须转成中文用户可读提示，不裸露堆栈。
- 密码 PBKDF2-SHA256 100000 迭代；会话 Cookie `HttpOnly; Secure; SameSite=Lax; Path=/`，30 天。
- DeepSeek：base `https://api.deepseek.com`，默认 `deepseek-chat`，深度思考 `deepseek-reasoner`；平台不支持图片输入。
- 上下文窗口：每次 chat 只发送最近 30 条消息。
- 界面全中文、响应式（手机全屏聊天、桌面侧栏布局）。
- 不做：图片识题、邮箱验证、找回密码、多语言、数据导出。
- 提交信息遵循 conventional commits（feat/fix/docs/test/chore），无 attribution 尾注。

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`
- Create: `src/worker/index.ts`, `src/worker/env.ts`
- Create: `src/client/index.html`, `src/client/main.tsx`, `src/client/App.tsx`, `src/client/styles/global.css`

**Interfaces:**
- Produces: `Env` 类型 `{ DB: D1Database; ASSETS: Fetcher; DEEPSEEK_API_KEY: string }`；Hono app 挂在 `/api` 下，`GET /api/health` 返回 `{success:true,data:{ok:true},error:null}`。

**Steps:**

- [ ] **Step 1:** `npm init -y` 后安装依赖：
  - dependencies: `hono` `zod` `react` `react-dom` `react-router-dom` `react-markdown` `remark-math` `remark-gfm` `rehype-katex` `katex`
  - devDependencies: `wrangler` `typescript` `vite` `@vitejs/plugin-react` `vitest` `@types/react` `@types/react-dom` `@cloudflare/workers-types`
- [ ] **Step 2:** 写 `wrangler.jsonc`：

```jsonc
{
  "name": "daoxue-web",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "daoxue-db", "database_id": "placeholder-set-on-deploy" }
  ],
  "rules": [{ "type": "Text", "globs": ["**/*.md"] }],
  "observability": { "enabled": true }
}
```

- [ ] **Step 3:** `vite.config.ts`：root 设为 `src/client`，build.outDir `../../dist/client`，dev server proxy `/api` → `http://localhost:8787`。`package.json` scripts：`dev:worker`(wrangler dev)、`dev:client`(vite)、`build`(tsc --noEmit && vite build)、`deploy`(npm run build && wrangler deploy)、`test`(vitest run)。
- [ ] **Step 4:** `src/worker/index.ts`：Hono app，`/api/health` 路由，未匹配 `/api/*` 返回 404 envelope；`src/client` 放最小 React 壳（App 显示"题解导学"标题）。`.gitignore`：node_modules、dist、.wrangler、.dev.vars。
- [ ] **Step 5:** 验证：`npm run build` 成功；`wrangler dev` 启动后 `curl localhost:8787/api/health` 返回 envelope JSON。
- [ ] **Step 6:** Commit `chore: 项目脚手架（Hono Worker + Vite React + wrangler 配置）`。

---

### Task 2: D1 数据库 schema 与迁移

**Files:**
- Create: `migrations/0001_init.sql`

**Interfaces:**
- Produces: 下述全部表结构，后续任务的 SQL 依赖列名完全一致。

**Steps:**

- [ ] **Step 1:** 写 `migrations/0001_init.sql`：

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  daily_message_limit INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  grade TEXT NOT NULL,
  textbook TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#4f6ef7',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english')),
  title TEXT NOT NULL DEFAULT '新会话',
  deep_thinking INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  reasoning_content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE mistake_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english')),
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  knowledge_point TEXT NOT NULL DEFAULT '',
  my_answer TEXT NOT NULL DEFAULT '',
  key_error TEXT NOT NULL DEFAULT '',
  error_tags TEXT NOT NULL DEFAULT '[]',
  correct_steps TEXT NOT NULL DEFAULT '',
  reminder TEXT NOT NULL DEFAULT '',
  retest_question TEXT NOT NULL DEFAULT '',
  next_review_date TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','passed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE student_profiles (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english')),
  profile_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, subject)
);
CREATE TABLE usage_log (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_students_user ON students(user_id);
CREATE INDEX idx_conversations_student ON conversations(student_id, updated_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX idx_mistakes_student ON mistake_cards(student_id, next_review_date);
```

- [ ] **Step 2:** 本地应用迁移：`wrangler d1 migrations apply daoxue-db --local`，确认成功。
- [ ] **Step 3:** Commit `feat: D1 数据库 schema 迁移`。

---

### Task 3: 学科提示词与系统提示词组装

**Files:**
- Create: `prompts/math.md`, `prompts/chinese.md`, `prompts/physics.md`, `prompts/english.md`（从 `学习/题解导学提示词（提炼版）/*.md` 各文件的代码块中提取**纯提示词正文**，去掉来源链接/说明/推荐输入模板）
- Create: `src/worker/chat/prompts.ts`
- Test: `test/prompts.test.ts`

**Interfaces:**
- Produces:
  - `SUBJECTS: readonly ['math','chinese','physics','english']`; `type Subject`; `SUBJECT_NAMES: Record<Subject,string>`（数学/语文/物理/英语）
  - `buildSystemPrompt(basePrompt: string, student: {name:string; grade:string; textbook:string; region:string; notes:string}, profileText: string | null): string`
  - `getBasePrompt(subject: Subject): string`（内部 import 四个 md 文本模块）

**Steps:**

- [ ] **Step 1:** 写失败测试 `test/prompts.test.ts`（测 `buildSystemPrompt` 纯函数，不 import md）：

```ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/worker/chat/prompts';

const student = { name: '小明', grade: '初二', textbook: '人教版', region: '北京', notes: '' };

describe('buildSystemPrompt', () => {
  it('包含基础提示词、学生档案与画像', () => {
    const p = buildSystemPrompt('BASE_PROMPT', student, '计算易错');
    expect(p).toContain('BASE_PROMPT');
    expect(p).toContain('小明');
    expect(p).toContain('初二');
    expect(p).toContain('计算易错');
    expect(p).toContain('不支持图片'); // 平台约束段
  });
  it('无画像时不包含画像段落标题', () => {
    const p = buildSystemPrompt('BASE', student, null);
    expect(p).not.toContain('学习画像');
  });
});
```

- [ ] **Step 2:** 运行 `npx vitest run test/prompts.test.ts`，确认 FAIL。
- [ ] **Step 3:** 实现 `prompts.ts`：拼接顺序 = 学科基础提示词 → `## 当前学生档案`（姓名/年级/教材/地区/家长备注，空字段跳过）→ `## 该学生的学习画像`（仅当 profileText 非空）→ `## 平台约束`（固定文案：本平台暂不支持图片输入，如学生提到图片请让其用文字描述题目；始终使用中文）。vitest 配置里给 `.md` 加占位处理或让测试仅走纯函数路径。
- [ ] **Step 4:** 运行测试确认 PASS。
- [ ] **Step 5:** Commit `feat: 学科提示词打包与系统提示词组装`。

---

### Task 4: 鉴权（注册/登录/会话/中间件）

**Files:**
- Create: `src/worker/auth/crypto.ts`, `src/worker/auth/routes.ts`, `src/worker/auth/middleware.ts`, `src/worker/lib/envelope.ts`
- Modify: `src/worker/index.ts`（挂载路由）
- Test: `test/crypto.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(pw: string): Promise<string>`（格式 `pbkdf2$100000$<salt_b64>$<hash_b64>`）、`verifyPassword(pw: string, stored: string): Promise<boolean>`
  - `generateToken(): string`（32 字节 base64url）、`sha256Hex(s: string): Promise<string>`
  - `ok(data)` / `err(message, status)` envelope helper
  - Hono 中间件 `requireAuth`：校验 cookie `session` → 查 sessions（未过期）→ `c.set('user', {id, email, is_admin, daily_message_limit})`；`requireAdmin` 在其后校验 is_admin。
  - 路由：`POST /api/auth/register {email,password,inviteCode?}`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`
- 业务规则：users 表为空 → 免邀请码注册且 `is_admin=1`；否则必须有效邀请码（存在、未停用、`used_count<max_uses`），注册成功后 `used_count+1`。密码最短 8 位；email 格式 zod 校验。登录成功写 session（30 天）并 Set-Cookie；logout 删除 session 及 cookie。

**Steps:**

- [ ] **Step 1:** 写失败测试 `test/crypto.test.ts`：hash→verify 正确密码 true、错误密码 false；两次 hash 同一密码结果不同（盐随机）；`generateToken()` 长度≥40 且两次不同。
- [ ] **Step 2:** 运行确认 FAIL。
- [ ] **Step 3:** 用 WebCrypto（`crypto.subtle.importKey('raw',…,'PBKDF2')` + `deriveBits`）实现 crypto.ts；实现 envelope、routes、middleware 并挂载。
- [ ] **Step 4:** 测试 PASS；`wrangler dev` 下 curl 冒烟：空库注册成 admin → me → logout → login。
- [ ] **Step 5:** Commit `feat: 邀请码注册、登录与会话鉴权`。

---

### Task 5: 学生 CRUD 与画像查看/编辑 API

**Files:**
- Create: `src/worker/students/routes.ts`
- Modify: `src/worker/index.ts`
- Test: `test/students.validation.test.ts`

**Interfaces:**
- Produces（全部走 requireAuth）：
  - `GET /api/students` → 当前用户学生列表（含各自会话数、错题数聚合）
  - `POST /api/students {name, grade, textbook?, region?, color?, notes?}`（name/grade 必填，zod schema `studentSchema` 导出供测试）
  - `PUT /api/students/:id`（同 schema partial）/ `DELETE /api/students/:id`（级联由外键处理）
  - `GET /api/students/:id/profiles` → `[{subject, profile_text, updated_at}]`
  - `PUT /api/students/:id/profiles/:subject {profileText}` → upsert student_profiles
  - 内部 helper `getOwnedStudent(db, userId, studentId)`：查不到或不属于该用户 → 404 envelope（供后续任务复用）

**Steps:**

- [ ] **Step 1:** 写失败测试：`studentSchema` 拒绝空 name、拒绝超 20 字 name、接受合法输入；subject 参数校验函数 `isSubject('math')===true`、`isSubject('biology')===false`。
- [ ] **Step 2:** 确认 FAIL → 实现路由与 helper → PASS。
- [ ] **Step 3:** curl 冒烟：建学生、改学生、跨用户访问返回 404。
- [ ] **Step 4:** Commit `feat: 学生管理与学习画像 API`。

---

### Task 6: 会话/消息 API 与 DeepSeek 流式聊天

**Files:**
- Create: `src/worker/chat/deepseek.ts`, `src/worker/chat/quota.ts`, `src/worker/chat/routes.ts`
- Modify: `src/worker/index.ts`
- Test: `test/quota.test.ts`, `test/deepseek.test.ts`

**Interfaces:**
- Produces:
  - `deepseek.ts`: `streamChat(apiKey, {model, messages, onDelta, onReasoning}): Promise<{content, reasoningContent}>`（解析上游 SSE `data:` 行，`[DONE]` 结束）；`completeJSON(apiKey, {messages}): Promise<string>`（非流式，`response_format:{type:'json_object'}`，model 固定 deepseek-chat）；错误映射 `mapDeepSeekError(status): string`（401→"DeepSeek API Key 无效"，402→"DeepSeek 账户余额不足"，429→"请求过于频繁，请稍后再试"，其他→"AI 服务暂时不可用，请稍后再试"）
  - `quota.ts`: `checkAndIncrementQuota(db, userId, limit, today: string): Promise<{allowed: boolean, used: number}>`（`INSERT ... ON CONFLICT(user_id,date) DO UPDATE SET message_count = message_count+1` 后读回判断；today 由调用方传入便于测试）
  - 路由：
    - `GET /api/students/:id/conversations?subject=` 列表（updated_at 倒序）
    - `POST /api/students/:id/conversations {subject, deepThinking?}` → 新会话
    - `GET /api/conversations/:id/messages`、`DELETE /api/conversations/:id`、`PUT /api/conversations/:id {deepThinking}`
    - `POST /api/conversations/:id/chat {content}` → **SSE 响应**，事件：`delta {text}`、`reasoning {text}`、`done {messageId}`、`error {message}`
- chat 端点流程：归属校验 → 限额检查（超限返回 SSE error 事件"今日对话次数已用完"）→ 存 user 消息 → 若会话标题仍为"新会话"则截取首条消息前 20 字为标题 → 组装 system prompt（Task 3 + 该生该科画像）+ 最近 30 条消息 → streamChat 转发增量 → 完成后存 assistant 消息（含 reasoning_content）、`updated_at=datetime('now')` → 触发画像提炼（Task 8 的 `maybeRefineProfile`，用 `c.executionCtx.waitUntil`，Task 8 前先留存根空实现）→ 发 done 事件。

**Steps:**

- [ ] **Step 1:** 写失败测试：
  - `test/quota.test.ts`：用内存假 DB（简单对象模拟 prepare/bind/first 的最小 stub）验证首条 allowed、达到 limit 后 allowed=false。若 stub 成本过高，改为把 SQL 结果判断逻辑抽成纯函数 `isQuotaExceeded(count, limit)` 测试之，SQL 部分归入冒烟。
  - `test/deepseek.test.ts`：`parseSSELine('data: {"choices":[{"delta":{"content":"你"}}]}')` 返回 `{content:'你'}`；`parseSSELine('data: [DONE]')` 返回 `{done:true}`；`mapDeepSeekError(402)` 含"余额"。导出 `parseSSELine` 纯函数。
- [ ] **Step 2:** 确认 FAIL → 实现 → PASS。
- [ ] **Step 3:** `.dev.vars` 写入真实 `DEEPSEEK_API_KEY`（不入库），`wrangler dev` 用 curl 冒烟 chat 端点看到流式增量与 done。
- [ ] **Step 4:** Commit `feat: 会话消息 API 与 DeepSeek 流式聊天`。

---

### Task 7: 错题卡抽取与错题本 API

**Files:**
- Create: `src/worker/mistakes/extract.ts`, `src/worker/mistakes/routes.ts`
- Modify: `src/worker/index.ts`
- Test: `test/mistakes.test.ts`

**Interfaces:**
- Produces:
  - `extract.ts`: `EXTRACT_INSTRUCTION`（中文指令：从对话中提取一张错题卡，输出 JSON，字段 title/knowledge_point/my_answer/key_error/error_tags(数组)/correct_steps/reminder/retest_question；若对话中没有可收录的错误则输出 `{"no_mistake": true}`）；`parseMistakeCard(raw: string): {card: MistakeCard} | {noMistake: true} | {error: string}`（zod 校验，容忍 markdown 代码围栏包裹的 JSON）
  - 路由：
    - `POST /api/conversations/:id/mistake-card` → 取该会话最近 20 条消息 + EXTRACT_INSTRUCTION 调 `completeJSON` → parse → 入库（`next_review_date = date('now','+2 day')`）→ 返回卡片；no_mistake 时返回 `err('本次对话未发现值得收录的错题', 422)`
    - `GET /api/students/:id/mistake-cards?subject=&status=`（按 next_review_date 升序）
    - `PUT /api/mistake-cards/:id {action: 'pass'|'fail'}`：pass → `review_status='passed'`；fail → `next_review_date = date('now','+3 day')`（保持 pending）
    - `DELETE /api/mistake-cards/:id`
- 归属校验复用 `getOwnedStudent`；卡片归属经 student 间接校验。

**Steps:**

- [ ] **Step 1:** 写失败测试 `test/mistakes.test.ts`：合法 JSON（含围栏 ```json）解析成功；`{"no_mistake":true}` 返回 noMistake；缺 title 返回 error；error_tags 非数组返回 error。
- [ ] **Step 2:** 确认 FAIL → 实现 → PASS。
- [ ] **Step 3:** curl 冒烟：真实对话后抽取一张卡、标记 fail 看日期顺延。
- [ ] **Step 4:** Commit `feat: 错题卡抽取与错题本 API`。

---

### Task 8: 学习画像后台提炼

**Files:**
- Create: `src/worker/profiles/refine.ts`
- Modify: `src/worker/chat/routes.ts`（把存根替换为真实调用）
- Test: `test/refine.test.ts`

**Interfaces:**
- Produces:
  - `shouldRefine(updatedAt: string | null, now: Date): boolean`（null → true；距上次 ≥10 分钟 → true）
  - `maybeRefineProfile(db, apiKey, studentId, subject): Promise<void>`：读画像 updated_at → `shouldRefine` false 则直接返回；true 则取该生该科最近 30 条消息 + 旧画像，用 REFINE_INSTRUCTION（中文：合并生成 ≤500 字学习画像，涵盖薄弱知识点/高频错因/有效讲法/近期进步，纯文本）调 `completeJSON`（要求 `{"profile": "..."}`）→ upsert student_profiles。任何异常 console.error 后吞掉（后台任务不得影响聊天）。

**Steps:**

- [ ] **Step 1:** 写失败测试：`shouldRefine(null, now)===true`；5 分钟前 → false；11 分钟前 → true（updated_at 为 SQLite `datetime('now')` 格式字符串 `YYYY-MM-DD HH:MM:SS`，按 UTC 解析）。
- [ ] **Step 2:** 确认 FAIL → 实现 → PASS。
- [ ] **Step 3:** 冒烟：连续对话后查 student_profiles 出现内容。
- [ ] **Step 4:** Commit `feat: 学习画像自动提炼`。

---

### Task 9: 管理员 API（邀请码与用户限额）

**Files:**
- Create: `src/worker/admin/routes.ts`
- Modify: `src/worker/index.ts`

**Interfaces:**
- Produces（requireAuth + requireAdmin）：
  - `GET /api/admin/invite-codes`；`POST /api/admin/invite-codes {note?, maxUses?}` → code 为 8 位随机大写字母数字；`PUT /api/admin/invite-codes/:id {disabled}`
  - `GET /api/admin/users` →（id, email, is_admin, daily_message_limit, 今日已用条数）；`PUT /api/admin/users/:id {dailyMessageLimit}`

**Steps:**

- [ ] **Step 1:** 实现路由（逻辑薄，无单测；zod 校验 maxUses 1–1000、limit 1–10000）。
- [ ] **Step 2:** curl 冒烟：生成邀请码 → 用它注册第二个账号 → used_count+1 → 停用后注册失败。
- [ ] **Step 3:** Commit `feat: 管理员邀请码与用户限额 API`。

---

### Task 10: 前端基础（API client、路由、登录注册）

**Files:**
- Create: `src/client/api.ts`, `src/client/types.ts`, `src/client/pages/LoginPage.tsx`, `src/client/pages/RegisterPage.tsx`, `src/client/components/Layout.tsx`
- Modify: `src/client/App.tsx`, `src/client/styles/global.css`

**Interfaces:**
- Produces:
  - `api.ts`: `apiGet/apiPost/apiPut/apiDelete<T>(path, body?)`（credentials include、解析 envelope、`success:false` 时 throw `ApiError(message)`）；`streamChat(conversationId, content, handlers: {onDelta, onReasoning, onDone, onError})`（fetch + ReadableStream 手动解析 SSE，供 Task 12 用）
  - `types.ts`: `User/Student/Conversation/Message/MistakeCard/Profile` 接口 + `SUBJECT_NAMES` 常量（与后端一致）
  - 路由骨架：`/login` `/register` `/`(需登录，未登录重定向) `/students/:id` `/students/:id/chat/:conversationId` `/students/:id/mistakes` `/settings`；`AuthContext` 提供 `user/loading/refresh`，App 启动时调 `/api/auth/me`。
- 设计基调（global.css）：CSS 变量主题（浅色为主）、系统字体栈、主色 `#4f6ef7`、圆角卡片、移动优先媒体查询 `@media (min-width: 768px)`。

**Steps:**

- [ ] **Step 1:** 实现上述文件；登录/注册页为居中卡片表单，注册含邀请码输入框及说明文案（首个账号无需邀请码）。
- [ ] **Step 2:** 验证：`npm run build` 通过；dev 下注册/登录/登出跳转正确，表单错误显示中文提示。
- [ ] **Step 3:** Commit `feat: 前端框架、鉴权页面与 API client`。

---

### Task 11: 学生列表与学生主页

**Files:**
- Create: `src/client/pages/StudentsPage.tsx`, `src/client/pages/StudentDetailPage.tsx`, `src/client/components/StudentFormModal.tsx`

**Interfaces:**
- Consumes: Task 5 API、Task 10 的 api.ts/types.ts。
- Produces: `/` 学生卡片网格（姓名首字彩色头像、年级、会话/错题计数、新建/编辑/删除入口）；`/students/:id` 学生主页：四个学科入口卡（数学/语文/物理/英语，点击→新建会话或最近会话列表）、最近会话列表（标题+学科+时间，点击续聊）、画像预览（各学科 profile_text 摘要，可展开编辑保存）、错题本入口。

**Steps:**

- [ ] **Step 1:** 实现页面与弹窗表单（新建学生：姓名、年级下拉[小一~高三]、教材版本、地区、颜色选择、备注）。
- [ ] **Step 2:** 验证：建/改/删学生全流程，删除有 confirm 二次确认；手机宽度单列、桌面多列。
- [ ] **Step 3:** Commit `feat: 学生列表与学生主页`。

---

### Task 12: 聊天界面

**Files:**
- Create: `src/client/pages/ChatPage.tsx`, `src/client/components/MessageBubble.tsx`, `src/client/components/MarkdownContent.tsx`, `src/client/components/ConversationSidebar.tsx`

**Interfaces:**
- Consumes: Task 6 API、`streamChat`。
- Produces: `/students/:id/chat/:conversationId`（`new?subject=math` 特殊值表示先建会话再进入）。桌面：左侧会话列表（按学科分组/筛选、新建、删除）+ 右侧聊天区；手机：全屏聊天，顶栏返回+标题，会话列表收进抽屉。功能：
  - 消息气泡：用户右侧、AI 左侧；`MarkdownContent` 用 react-markdown + remark-math + remark-gfm + rehype-katex 渲染（import 'katex/dist/katex.min.css'）
  - 流式：发送后立即显示用户消息与 AI 占位，onDelta 增量追加，自动滚底
  - reasoning_content 折叠块（"已深度思考"可展开）
  - 「深度思考」开关（PUT deepThinking）、「存入错题本」按钮（调 Task 7 抽取端点，成功 toast，422 提示无错题）
  - 输入框多行自适应，Enter 发送 / Shift+Enter 换行；流式中禁止再发；错误事件红色提示条
  - 空会话时显示引导文案（提示词的默认开场 + "支持输入题目文字，暂不支持图片"）

**Steps:**

- [ ] **Step 1:** 实现组件与页面。
- [ ] **Step 2:** 验证：真实 Key 下四个学科各发一题，流式/公式渲染/深度思考/存错题全部可用；手机宽度体验正常。
- [ ] **Step 3:** Commit `feat: 聊天界面（流式、公式、深度思考、存错题）`。

---

### Task 13: 错题本页面

**Files:**
- Create: `src/client/pages/MistakesPage.tsx`, `src/client/components/MistakeCardItem.tsx`

**Interfaces:**
- Consumes: Task 7 API。
- Produces: `/students/:id/mistakes`：学科筛选 tab、状态筛选（待复测/已通过）、按复测日期排序；到期卡片标红"今日应复测"。卡片展示全部字段（错因标签为彩色 chip），操作：复测通过 / 复测未通过（顺延3天）/ 删除（confirm）。

**Steps:**

- [ ] **Step 1:** 实现页面。
- [ ] **Step 2:** 验证筛选、标记、顺延、删除。
- [ ] **Step 3:** Commit `feat: 错题本页面`。

---

### Task 14: 设置与管理员页面

**Files:**
- Create: `src/client/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: Task 9 API、AuthContext。
- Produces: `/settings`：账号信息（邮箱）、退出登录；`is_admin` 时显示：邀请码管理（列表含已用次数、生成、停用）、用户管理（列表含今日用量、修改每日上限）。

**Steps:**

- [ ] **Step 1:** 实现页面。
- [ ] **Step 2:** 验证：生成邀请码可复制；隐身窗口用邀请码注册第二账号成功且数据隔离。
- [ ] **Step 3:** Commit `feat: 设置与管理员页面`。

---

### Task 15: README 与整体冒烟

**Files:**
- Create: `README.md`, `scripts/smoke.md`（冒烟清单）

**Steps:**

- [ ] **Step 1:** README：项目简介、本地开发（npm install → `.dev.vars` 配 DEEPSEEK_API_KEY → `wrangler d1 migrations apply daoxue-db --local` → 两个 dev 进程）、部署步骤（见 Task 16 命令）、邀请码机制、限额说明、"不支持图片"限制。
- [ ] **Step 2:** 全量 `npm test` + `npm run build` 通过；按 smoke.md 手动过一遍主流程（注册→建学生→四科对话→错题→画像→管理员）。
- [ ] **Step 3:** Commit `docs: README 与冒烟清单`。

---

### Task 16: 部署到 Cloudflare

**Steps:**

- [ ] **Step 1:** `wrangler login`（需用户交互授权）。
- [ ] **Step 2:** `wrangler d1 create daoxue-db` → 把返回的 database_id 填入 wrangler.jsonc → `wrangler d1 migrations apply daoxue-db --remote`。
- [ ] **Step 3:** `wrangler secret put DEEPSEEK_API_KEY`（向用户索要 Key）。
- [ ] **Step 4:** `npm run deploy` → 拿到 workers.dev URL。
- [ ] **Step 5:** 线上冒烟：注册管理员、建学生、每科对话一次、生成邀请码。
- [ ] **Step 6:** Commit `chore: 部署配置定稿`，把 URL 汇报给用户。
