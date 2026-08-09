# 学伴 AI 技术文档

本文面向开发者和自托管维护者，集中说明架构、开发环境、测试、安全策略和项目结构。面向家长与学生的产品使用方法请先阅读 [README](../README.md)。

## 技术栈

| 层 | 选择 |
|---|---|
| 运行时 | Cloudflare Workers，单 Worker 同时提供 API 和静态资源 |
| 后端 | Hono 4 + TypeScript |
| 数据库 | Cloudflare D1（SQLite） |
| 前端 | React 18 + Vite + React Router 7 |
| 内容渲染 | react-markdown + KaTeX |
| 大模型 | DeepSeek `deepseek-chat` / `deepseek-reasoner` |
| 视觉模型 | 智谱 GLM-4.1V-Thinking-Flash 或其他 OpenAI 兼容服务 |
| 数据校验 | Zod |
| 测试 | Vitest 单元测试 + Cloudflare Workers/D1 集成测试 |

## 系统结构

```text
浏览器（React）
  │ HTTPS / SSE
  ▼
Cloudflare Worker（Hono）
  ├─ 鉴权、学生、会话、错题、自学、管理 API
  ├─ DeepSeek / 视觉模型调用
  └─ 静态资源
       │
       ▼
Cloudflare D1
```

后端使用统一响应 envelope。聊天采用 SSE 流式返回，并使用请求 ID、会话租约和数据库唯一索引保证断线重试幂等；额度占用、用户消息落库以及失败退款状态通过 D1 事务保持一致。

一个账号可以拥有多个学生。服务端访问学生、会话、错题和自学数据时，都会沿 `student.user_id` 校验资源归属；管理员接口另有管理员权限中间件。

## 本地开发

### 准备条件

- Node.js 22，版本约束见 [`.nvmrc`](../.nvmrc)；
- npm；
- 一个 DeepSeek API Key；
- 如需测试拍照识题，再准备 OpenAI 兼容的视觉模型服务；
- 自托管或连接远端资源时，需要拥有 Workers 和 D1 权限的 Cloudflare 账号。

首次自托管请先阅读 [部署文档](DEPLOY.md)，创建 D1 数据库并将数据库 ID 写入 `wrangler.jsonc`。

```bash
npm install

# 本地密钥文件已被 gitignore，不会提交
cat > .dev.vars <<'EOF'
DEEPSEEK_API_KEY=你的-key
VISION_API_KEY=你的视觉模型-key
# 本地个人 Key 加密主密钥（随机 32 字节 Base64，仅开发用，勿与生产相同）
AI_SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32 的输出)
EOF

# 初始化本地数据库
npx wrangler d1 migrations apply daoxue-db --local

# wrangler dev 需要先生成 dist/client
npm run build
npm run dev:worker
```

应用会运行在 `http://localhost:8787`。

需要前端热更新时，另开终端运行：

```bash
npm run dev:client
```

Vite 使用 5173 端口，并将 `/api` 请求代理到本地 Worker。

## 常用命令

```bash
npm test              # 单元测试 + 真实 Worker/D1 集成测试
npm run test:unit     # 仅 Node 单元测试
npm run test:worker   # 仅 Workers/D1 测试
npm run typecheck     # 前端、Worker 和 Worker 测试类型检查
npm run build         # 类型检查 + 前端生产构建
npm audit             # 检查全部依赖漏洞
npm run deploy:dry-run # 构建并验证 Worker 打包，不发布
npm run deploy        # 测试、构建并部署到 Cloudflare
```

项目以 Node.js 22 为基准。使用 nvm 时，在执行命令前先运行 `nvm use`。

## 测试与 CI

测试分为两组：

- 普通 Vitest：纯函数、SSE 解析、提示词处理、表单校验、日期、Markdown、图片压缩和数据库迁移链；
- Workers Vitest：在 Miniflare 的真实 D1 环境中验证鉴权、权限隔离、并发注册、邀请码、额度、聊天租约、请求幂等、画像提炼和各路由行为。

GitHub Actions 会在每次 push 和 pull request 时执行：

1. `npm ci`；
2. `npm test`；
3. `npm run build`；
4. `npm audit`；
5. `wrangler deploy --dry-run`。

dry-run 只验证 Worker 和静态资源能否正确打包，不会部署，也不会修改远端 D1。

## 配置与密钥

AI 服务配置分为**个人配置**（`user_ai_settings`，按账号加密保存）和**站点共享配置**（`app_settings` + Worker 环境变量，管理员维护）。

每次模型调用（聊天、OCR、错题提取、自学后处理、画像提炼）都通过 `resolveUserAIConfig()` 按账号解析：

```text
个人密文（user_ai_settings）
  → 若存在，按 user_id 解密并使用
  → 若不存在且 shared_ai_fallback_enabled = 1，读取 app_settings / Worker Secret
  → 否则返回未配置
```

要点：

- 个人 Key 始终优先于站点共享 Key；两者不做字段级混搭（视觉配置的 Key/地址/模型整段取个人或整段取共享）。
- 个人密文损坏或与主密钥不匹配时 **fail closed**：直接报错，不回退共享 Key，避免产生意外的共享费用。
- 共享兜底由管理员显式控制。migration 0009 初始写入"开启"以保证发布平滑；完成用户迁移后由管理员在「AI 服务」页关闭，进入严格 BYOK。
- `app_settings` 中的 DeepSeek/视觉配置语义为"站点共享服务"，仍保留环境变量兜底。

### 个人 Key 加密

- 算法：AES-256-GCM，12 字节随机 IV；密文、IV、尾号掩码分列存入 `user_ai_settings`。
- AAD 固定为 `user-ai:v1:<user_id>:<deepseek|vision>`，防止密文跨用户或跨服务替换。
- 主密钥只来自 Worker Secret `AI_SETTINGS_ENCRYPTION_KEY`（Base64 编码的 32 字节），本地开发放在 `.dev.vars`。主密钥丢失或轮换后，已有个人密文无法解密，用户需在「AI 服务」页重新保存 Key；在此之前相关账号的 AI 调用保持 fail closed。
- 完整 Key、密文、IV 和主密钥不写入日志、不出现在任何 API 响应；GET 接口只返回是否已配置、尾号掩码和生效来源。
- 每日消息上限对共享 Key 和个人 Key 一视同仁；画像提炼的间隔和每日上限仍是站点级策略，但后台提炼同样消耗发起会话账号当前生效的 DeepSeek Key。

### 视觉服务白名单

普通用户的个人视觉服务只允许后端白名单中的 provider（`zhipu`、`dashscope`），请求地址由后端固定映射，用户不能提交任意 URL（防 SSRF）。管理员的站点共享服务仍允许自定义 OpenAI 兼容地址。

本地开发的 `.dev.vars` 已加入 `.gitignore`。不要把 API Key、生产数据库导出或真实学习数据提交到仓库。

## 数据库迁移

迁移文件位于 `migrations/`，按编号顺序执行。基本原则：

- 已经应用过的迁移不可修改，只能新增迁移；
- 本地验证迁移链后，再备份并应用远端迁移；
- 先迁移数据库，再发布依赖新结构的 Worker；
- D1 迁移没有自动回滚，生产变更前必须导出备份。

具体命令、备份、回滚注意事项见 [部署文档](DEPLOY.md)。

## 关键可靠性设计

### 注册和登录

- 首位管理员的用户与 session 在同一 D1 batch 中创建；
- 普通注册的邀请码占用、用户和 session 在同一事务中完成；
- 登录失败次数使用原子占位，避免并发请求绕过限制；
- 过期登录失败记录会按时间窗口清理。

### 聊天和额度

- 同一会话使用带 token 和过期时间的租约，避免并发生成串题；
- 客户端每次发送携带稳定 request ID，断线重试复用该 ID；
- 用户消息和 assistant 消息均有 request ID 唯一约束；
- 额度与消息状态原子写入，失败退款同步更新持久化状态；
- DeepSeek 流必须收到 `[DONE]` 才视为完整成功；
- 已产生的部分回答会尽量落库，客户端再通过消息 ID 对账。

### 前端异步状态

- 会话、OCR、错题筛选和设置页请求使用路由世代或请求世代隔离旧响应；
- 未知 SSE 断线会查询服务端生成状态，不立即重复提交；
- 新会话创建会复用 StrictMode 重放期间的 pending 请求；
- 模态框支持初始焦点、焦点圈定、Escape 关闭和焦点恢复。

## 项目结构

```text
src/worker/          Cloudflare Worker 后端
  auth/              注册、登录、session、密码哈希、鉴权
  students/          学生 CRUD 与画像表单
  chat/              会话、SSE、模型调用、OCR、额度与租约
  mistakes/          错题卡抽取与错题本
  selflearn/         自学记忆、结构化抽取与每日流程
  profiles/          学科画像自动提炼
  admin/             邀请码、限额与站点共享 AI 服务配置
  settings/          登录用户个人 AI 设置（加密 Key）接口
  lib/               响应、错误、设置读取、个人设置解析与 AES-GCM 编解码

src/client/          React 前端
  pages/             页面级功能
  components/        表单、模态框、侧栏、消息气泡等
  lib/               聊天、图片、Markdown、日期等工具
  styles/            全局样式

prompts/             数学、语文、物理、英语、化学和自学提示词
migrations/          D1 数据库迁移
test/                单元测试与 Worker/D1 集成测试
docs/                技术、部署、域名与设计资料
```

## 提示词与模型设计

- 五个学科分别使用解题导学提示词，目标是定位卡点并逐步引导；
- 自学提示词保留画像、每日流程、掌握等级和输出模板等硬规则；
- 自学课件环节只生成供 OpenMAIC 使用的课件生产提示词；
- 图片服务需要理解几何图、电路图、函数图像等关系，因此使用视觉理解模型而不是纯 OCR。

## 发布与运维

- 首次部署、日常发布、D1 迁移、Secret 配置和回滚：[DEPLOY.md](DEPLOY.md)
- 自定义域名和 DNS：[DOMAIN.md](DOMAIN.md)
- 产品使用方法：[README.md](../README.md)

当前产品不提供自助找回密码和邮箱验证，适合家庭或小范围邀请场景。长会话历史目前也没有分页，后续扩展时需同时考虑客户端体验与 D1 查询成本。
