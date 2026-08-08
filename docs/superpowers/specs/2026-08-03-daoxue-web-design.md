# 题解导学网站（daoxue-web）设计文档

日期：2026-08-03
状态：已获用户确认

## 1. 背景与目标

基于《题解导学提示词（提炼版）》中的四套学科系统提示词（校内数学、语文、物理/科学、英语），构建一个家庭使用、小范围分享的 AI 学习辅导网站：

- 一个账号下可创建多个学生（孩子），每个学生有独立设置与独立记忆；
- 大模型使用 DeepSeek API（服务端统一 Key）；
- 部署到 Cloudflare（Workers + D1）。

「记忆」包含三部分（均已确认）：对话历史、错题本、学习画像自动提炼。

## 2. 技术选型（方案 A，已确认）

| 层 | 选择 | 理由 |
|---|---|---|
| 运行时 | Cloudflare Worker（单 Worker） | 一键部署、零运维、免费额度足够 |
| 后端框架 | Hono（TypeScript） | Workers 生态事实标准，轻量 |
| 数据库 | Cloudflare D1（SQLite） | 与 Worker 原生集成，小规模够用 |
| 前端 | React 18 + Vite + TypeScript，构建为静态资源由同一 Worker 托管（Workers Static Assets） | 响应式 SPA，手机/桌面兼顾 |
| LLM | DeepSeek API（OpenAI 兼容），`deepseek-chat` 默认，`deepseek-reasoner` 可选「深度思考」 | 用户指定 |
| 流式输出 | SSE（服务端代理 DeepSeek stream） | Key 不暴露给浏览器 |

已知限制：DeepSeek API 不支持图片输入，题目需以文本输入；界面须明确说明。

## 3. 账号与权限

- 邮箱 + 密码注册，注册必须提供有效邀请码（例外：数据库中尚无任何用户时可免邀请码，该用户成为管理员，见 §9）。
- 密码用 WebCrypto PBKDF2（SHA-256，≥100k 迭代，随机盐）哈希存储。
- 会话：随机 token（存哈希），HttpOnly + Secure + SameSite=Lax Cookie，有效期 30 天。
- 第一个注册的账号 `is_admin=1`：可在设置页生成/停用邀请码、调整各账号每日消息上限。
- 每日消息条数上限（默认 100 条/账号/天，管理员可调），超出后拒绝新消息并提示。

## 4. 数据模型（D1）

```sql
users(id, email UNIQUE, password_hash, is_admin, daily_message_limit, created_at)
invite_codes(id, code UNIQUE, note, max_uses, used_count, disabled, created_by, created_at)
sessions(id, token_hash UNIQUE, user_id, expires_at, created_at)
students(id, user_id, name, grade, textbook, region, color, notes, created_at)
conversations(id, student_id, subject, title, deep_thinking, created_at, updated_at)
messages(id, conversation_id, role, content, reasoning_content, created_at)
mistake_cards(id, student_id, subject, conversation_id, title, knowledge_point,
              my_answer, key_error, error_tags, correct_steps, reminder,
              retest_question, next_review_date, review_status, created_at)
student_profiles(student_id, subject, profile_text, updated_at,
                 PRIMARY KEY(student_id, subject))
usage_log(id, user_id, date, message_count)  -- 每日用量计数
```

- `subject` 枚举：`math` / `chinese` / `physics` / `english`。
- 所有归属校验：students 必须属于当前 user；conversations/mistake_cards/profiles 必须属于当前 user 的 student。

## 5. 系统提示词组装

每次对话请求，服务端按以下顺序拼接 system prompt：

1. 对应学科的完整提示词原文（从仓库内 `prompts/*.md` 提炼出的纯文本，构建时打包进 Worker）；
2. 学生档案段：姓名、年级/学段、教材版本、地区、家长备注；
3. 学习画像段（若存在）：该学生该学科的 `profile_text`；
4. 平台约束段：提醒模型当前平台不支持图片，若学生提到"看图"需请其打字描述。

## 6. 核心功能

### 6.1 对话
- 选学生 → 选学科 → 新会话或继续历史会话。
- SSE 流式输出；Markdown 渲染 + KaTeX 数学公式；`deepseek-reasoner` 的 reasoning_content 折叠展示。
- 会话标题：首条用户消息前 20 字自动生成。
- 上下文窗口：发送最近 30 条消息（防 token 失控）。

### 6.2 错题本
- 会话中任意 AI 回复下方有「存入错题本」按钮：服务端追加一条抽取指令让模型输出错题卡 JSON（题目、知识点、原答案、关键错误、错因标签、正确步骤、一句话提醒、复测题、建议复测日期），校验后入库。
- 错题本页：按学生+学科筛选，按复测日期排序；可标记复测结果（通过/未通过），未通过自动顺延复测日期；可删除。

### 6.3 学习画像
- 会话产生新消息后，服务端用 `ctx.waitUntil` 触发后台总结（节流：距上次画像更新 ≥10 分钟才触发）：将旧画像 + 最近对话交给 deepseek-chat，产出 ≤500 字新画像（薄弱知识点、高频错因、有效讲法、近期进步），覆盖写入。
- 学生详情页可查看、手动编辑、清空画像。

### 6.4 学生管理
- 学生 CRUD；删除学生需二次确认，级联删除其会话/错题/画像。

## 7. API 设计（/api 前缀，JSON envelope: {success, data, error}）

```
POST /api/auth/register {email, password, inviteCode}
POST /api/auth/login    {email, password}
POST /api/auth/logout
GET  /api/auth/me
GET|POST /api/students          / PUT|DELETE /api/students/:id
GET  /api/students/:id/profiles           -- 各学科画像
PUT  /api/students/:id/profiles/:subject  -- 手动编辑画像
GET|POST /api/students/:id/conversations  -- 列表/新建（含 subject）
GET  /api/conversations/:id/messages
POST /api/conversations/:id/chat          -- SSE 流式；body: {content}
DELETE /api/conversations/:id
POST /api/conversations/:id/mistake-card  -- 从会话抽取错题卡
GET  /api/students/:id/mistake-cards      / PUT|DELETE /api/mistake-cards/:id
-- 管理员
GET|POST /api/admin/invite-codes  / PUT /api/admin/invite-codes/:id
GET  /api/admin/users             / PUT /api/admin/users/:id  -- 调每日上限
```

错误处理：所有输入用 zod 校验；DeepSeek 上游错误转为用户可读提示（余额不足/超时/限流分别提示）；服务端 console.error 记录详情。

## 8. 前端页面（React SPA，响应式）

```
/login /register          -- 登录/注册（含邀请码）
/                         -- 学生列表（卡片，选择学生进入）
/students/:id             -- 学生主页：四学科入口 + 最近会话 + 画像预览
/students/:id/chat/:conversationId  -- 聊天界面（手机全屏，桌面侧栏+聊天区）
/students/:id/mistakes    -- 错题本
/settings                 -- 账号设置；管理员另见邀请码/用户管理
```

- 移动端：底部导航/全屏聊天；桌面端：左侧会话列表 + 右侧聊天。
- 中文界面。

## 9. 部署

- `wrangler.jsonc`：D1 绑定 `DB`、静态资源目录 `dist/client`、`nodejs_compat`。
- Secret：`DEEPSEEK_API_KEY`（`wrangler secret put`）。
- D1 迁移：`migrations/0001_init.sql`，`wrangler d1 migrations apply`。
- 首个邀请码：管理员账号注册需要邀请码会死锁，故规则为**数据库中没有任何用户时，注册可不填邀请码**（成为管理员）；之后必须邀请码。
- 部署步骤写入 README。

## 10. 测试

- Vitest 单元测试：提示词组装、错题卡 JSON 解析校验、邀请码/限额逻辑、鉴权中间件。
- 本地 `wrangler dev` 手动联调全流程；DeepSeek 调用以真实 Key 冒烟验证。

## 11. 不做的事（YAGNI）

- 图片/拍照识题（DeepSeek 不支持，留待未来接入视觉模型）；
- 邮箱验证、找回密码（小范围使用，管理员可直接改库）；
- 多语言界面；
- 数据导出、家长报告推送。

---

# 增补：自学陪伴模块（2026-08-03 第二轮确认）

基于《自学 Agent 基座架构提示词》+ 8 个组件安装提示词 + 固定每日运行协议，在网站中新增「自学陪伴」模式，与「题解导学」并列。已确认：课件环节保持 OpenMAIC 工作流（网站生成课件生产提示词供复制，不站内讲新课）；学习方向不限于四学科；与题解导学一起上线。

## A. 形态

- 每个学生一个自学陪伴区（/students/:id/selflearn）。
- 首次使用：画像采集会话（AI 按基座 4 轮问卷分轮提问，产出【孩子学习画像摘要】后画像就绪）。
- 之后：每日学习会话，AI 按固定每日运行协议执行：任务确认 → 知识保温 → 知识拆解 → 生成 OpenMAIC 课件生产提示词（代码块，供复制）→ 等待"学完了" → 测验/错题卡/错因分析/L1-L4 判定 → 每课输出 → 下一步调度 → 每日家长反馈。
- 原始 docx 是给 WorkBuddy 的"安装提示词"（约 9700 行），不能整体注入；改为两份运行时系统提示词（浓缩，保留全部硬规则与输出模板）：prompts/selflearn-profiling.md、prompts/selflearn-daily.md。

## B. 硬规则（必须保留在浓缩提示词中）

L1-L4 定义；低于 L3 不推进同一链条新内容；无复述证据不判 L3；无迁移证据不判 L4；错因必须归类不写"粗心"；信息不足标注"暂无"不编造；一次只推进一小步；讲完必复述；状态差降强度；不贴标签不制造焦虑；每课结束输出【每课输出】；每日结束输出【每日家长反馈】；家长建议具体可执行。

## C. 数据与记忆

新表：selflearn_profiles（画像，student 一条）、knowledge_points（知识点掌握 L1-L4 + 保温/复测/重构/组网标记）、lesson_outputs（每课输出原文+摘要）、daily_reports（每日家长反馈原文）。conversations 加 mode 列（subject|selflearn-profiling|selflearn-daily），subject 枚举增加 'selflearn'；mistake_cards.subject 放开为含 'selflearn'，加 direction 列。

每次自学对话的系统提示词注入：画像 + 知识点掌握摘要（含低于 L3 清单、待保温/复测项）+ 最近每课输出的调度指令 + 最近每日反馈 + 待复测错题。这就是"学生与 Agent 基座的沟通"。

结构化抽取：助手消息保存后，后台（waitUntil）扫描标记（【每课输出】【每日家长反馈】【错题卡】【孩子学习画像摘要】、掌握等级），命中才调 deepseek-chat 抽取 JSON 入库；画像摘要直接切块保存，不额外调模型。

## D. UI

- 学生主页新增自学陪伴入口（显示画像状态）。
- SelfLearnPage：画像区（查看/编辑/重新采集）、开始今天的学习、历史自学会话、知识点掌握表（按方向分组、L1-L4 彩色）、每课输出与每日反馈历史（展开查看）。
- ChatPage 兼容 selflearn 会话（'自学'标签；隐藏"存入错题本"按钮——自学模式自动抽取）；Markdown 代码块加"复制"按钮（用于复制 OpenMAIC 课件提示词）。
- 自学会话上下文窗口 40 条（普通 30 条）。
