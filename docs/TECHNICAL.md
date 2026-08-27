# 学伴 AI 技术文档

本文面向开发者和自托管维护者，集中说明架构、开发环境、测试、安全策略和项目结构。面向家长与学生的产品使用方法请先阅读 [README](../README.md)。

## 技术栈

| 层 | 选择 |
|---|---|
| 运行时 | Cloudflare Workers，单 Worker 同时提供 API 和静态资源 |
| 后端 | Hono 4 + TypeScript |
| 数据库 | Cloudflare D1（SQLite） |
| 后台任务 | Cloudflare Queues（生成队列 + DLQ） |
| 课件媒体 | 私有 Cloudflare R2（Standard） |
| 前端 | React 18 + Vite + React Router 7 |
| 内容渲染 | react-markdown + KaTeX |
| 大模型 | DeepSeek `deepseek-chat` / `deepseek-reasoner` |
| 视觉模型 | 智谱 GLM-4.1V-Thinking-Flash 或其他 OpenAI 兼容服务 |
| 数据校验 | Zod |
| 测试 | Vitest 单元测试 + Cloudflare Workers/D1 集成测试 |

## 系统结构

```text
浏览器（React）
  │ HTTPS / SSE / authenticated Range
  ▼
Cloudflare Worker（Hono）
  ├─ 鉴权、学生、会话、错题、自学、课件、管理 API
  ├─ 同源私有媒体代理（不向浏览器返回 R2 key）
  ├─ Queue producer / consumer
  └─ 静态资源
       ├── Cloudflare D1：所有权、目录、快照、状态、租约、进度、警告和用量
       ├── Cloudflare Queue：仅 { coursewareId }，推进后台生成
       └── 私有 Cloudflare R2：MP3 与可选图片对象
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

# 先生成一把仅用于本地开发的主密钥，复制输出备用
openssl rand -base64 32

# 本地密钥文件已被 gitignore，不会提交；把上一条命令的输出粘贴到最后一行
cat > .dev.vars <<'EOF'
DEEPSEEK_API_KEY=你的-key
VISION_API_KEY=你的视觉模型-key
# 本地个人 Key 加密主密钥（随机 32 字节 Base64，仅开发用，勿与生产相同）
AI_SETTINGS_ENCRYPTION_KEY=把刚才生成的完整Base64值粘贴到这里
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

AI 服务配置分为**个人配置**（`user_ai_settings`，按账号加密保存 Key，并保存账户级画像提炼策略）和**站点共享配置**（`app_settings` + Worker 环境变量，管理员维护）。

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
- 共享兜底由管理员显式控制，且是 **fail closed**：只有 `shared_ai_fallback_enabled` 明确等于 `'1'` 时才使用共享服务；记录缺失、被误删或设置读取异常（返回空配置）都按"关闭"处理，不会在管理员不知情时消耗共享 Key。migration 0009 初始写入 `'1'` 以保证发布平滑；完成用户迁移后由管理员在「设置」页关闭，进入严格 BYOK。
- `app_settings` 中的 DeepSeek/视觉配置语义为"站点共享服务"，仍保留环境变量兜底。

### 个人 Key 加密

- 算法：AES-256-GCM，12 字节随机 IV；密文、IV、尾号掩码分列存入 `user_ai_settings`。
- AAD 固定为 `user-ai:v1:<user_id>:<deepseek|vision>`，防止密文跨用户或跨服务替换。
- 主密钥只来自 Worker Secret `AI_SETTINGS_ENCRYPTION_KEY`（Base64 编码的 32 字节），本地开发放在 `.dev.vars`。主密钥丢失或轮换后，已有个人密文无法解密，用户需在「AI 服务」页重新保存 Key；在此之前相关账号的 AI 调用保持 fail closed。
- 完整 Key、密文、IV 和主密钥不写入日志、不出现在任何 API 响应；GET 接口只返回是否已配置、尾号掩码和生效来源。
- 每日消息上限对共享 Key 和个人 Key 一视同仁；画像提炼间隔和每日上限保存在 `user_ai_settings`，同一账户下学生共用。后台提炼读取发起会话账户的策略，并消耗该账户当前生效的 DeepSeek Key。

### 视觉服务白名单

普通用户的个人视觉服务只允许后端白名单中的 provider（`zhipu`、`dashscope`），请求地址由后端固定映射，用户不能提交任意 URL（防 SSRF）。管理员的站点共享服务仍允许自定义 OpenAI 兼容地址。

本地开发的 `.dev.vars` 已加入 `.gitignore`。不要把 API Key、生产数据库导出或真实学习数据提交到仓库。

## 语音课件架构

### Capability-driven 模型目录

课件模型不在生成代码中写死。管理员维护三层目录：

```text
provider
  └─ endpoint（capability + adapter_type + HTTPS base URL）
       └─ model（model id、显示名、配置、可选音色、推荐顺序）
```

目录 capability 只有 `structured_text`、`speech_synthesis` 和 `image_generation`。编译进 Worker 的 adapter registry 再校验 endpoint 的 `adapter_type`，当前支持 `openai_text`、`token_plan_tts` 和 `token_plan_image`；目录记录不能让运行时执行任意代码。

家长按用途保存 `courseware_text`、`teacher_tts`、`student_tts` 和可选的 `courseware_image` 偏好。语音用途必须从所选模型声明的音色中选择。创建课件时，Worker 校验 capability/adapter/voice 后把 provider、endpoint、model、voice、参数、adapter/prompt 版本写入 `model_snapshot_json`；后续 Queue 消费者使用该快照，不会偷偷换成账户刚修改的新模型，也不会跨 provider fallback。

### 严格 BYOK 与凭证隔离

语音课件的凭证路径与前文的聊天共享兜底是两套边界：

- 课件只读取 `user_ai_credentials` 中**课件所有者当前可解密的个人 provider Key**；站点共享 DeepSeek/视觉 Key、环境变量共享 Key和浏览器语音都不在候选路径中。
- 每个 `(user_id, provider_id)` 凭证使用 `AI_SETTINGS_ENCRYPTION_KEY` 做 AES-256-GCM 加密，API 只返回已配置状态、尾号和归一化健康状态，不返回密文、IV 或完整 Key。
- 生成调用携带准确的 `credential_revision`。迟到的成功、401 或 quota 结果只能更新本次实际使用的凭证版本，不能污染用户刚轮换的新 Key。
- 真实 provider 的 401/403、quota 才更新对应版本健康状态；主密钥缺失、解密失败、D1/服务配置异常按基础设施错误处理，不把用户 Key 误标为 invalid。
- 缺 Key、invalid 或 quota exhausted 会阻止新的相应阶段；不会改用平台 Key。已经 `ready` 的课件播放不需要 provider Key。

完整 Key、密文、IV、主密钥、R2 object key、完整 prompt、孩子画像正文和生成课件正文都不得进入普通日志。API 仅在通过账户归属校验的 `ready` 详情中返回播放器必需的段落 DTO；目录、列表、状态、错误和管理 DTO 不返回生成正文。

### Queue、D1 与私有 R2 的职责

| 资源 | 权威数据与边界 |
|---|---|
| D1 | 课件/学生/账户归属、严格脚本、model snapshot、段落、artifact 状态、租约、重试计数、warning/usage、安全错误、播放进度、assessment 关联和清理 tombstone。D1 状态是恢复与幂等判断的权威来源。 |
| Queue | 消息运行时严格校验为唯一字段 `{ coursewareId: positive integer }`。消费者逐条 ack/retry，一个消息失败不影响同 batch 其他消息；Queue 只负责唤醒，不承载 prompt、Key、模型或课件正文。 |
| 私有 R2 | 保存 attempt-scoped MP3/图片。Bucket 不开放公共域名；浏览器只能走鉴权同源媒体路由。CAS 失败或删除失败通过精确清理与 D1 tombstone 收敛孤儿对象。 |

生成使用五分钟 lease、续租和 token/CAS guard。每次最多推进五个 artifact，避免单课件淹没 provider。重复或延迟 Queue 消息会先读取 D1：已完成并仍存在的 artifact 不再调用 provider；stale worker 不能覆盖删除中状态、新 attempt 或赢家对象。这里保证的是持久化状态与重复投递安全，不宣称 provider 调用跨崩溃 exactly-once。

### 状态机与失败语义

外层 `status` 为 `queued | generating | ready | failed | deleting`；生成阶段为：

```text
queued → scripting → speech → images → finalizing → ready
             └──────── required failure ───────→ failed
```

- `scripting` 的 provider 输出必须通过严格 schema parser 后才写入段落；HTML/JS/代码不会执行。
- `speech` 必须完成所有主语音和脚本要求的备用语音；缺一项都不能进入 `ready`。
- `images` 是可选阶段。单图失败在 bounded retry 后写 warning，课件仍可进入 `ready`；管理员/家长可对失败图片单独重试。
- timeout、rate limit、provider unavailable 和存储暂时故障执行有界重试；无效凭证、quota、模型不兼容等非瞬时错误立即写入归一化安全失败。
- `finalizing` 会重新核验必需 R2 对象；缺失对象回到对应阶段恢复，存储检查本身失败也有持久化的有界计数，避免无限重排。
- 删除先把课件变为 `deleting`，使旧 worker 的所有写入失效，再清理私有媒体和 D1 数据。

### 媒体 Range 与播放进度

详情 DTO 只包含形如 `/api/coursewares/:coursewareId/segments/:segmentId/audio` 的同源 URL。媒体路由再次沿 `students.user_id` 校验账户、课件、段落和 variant，并验证 D1 中的实际 key 只能属于预期逻辑 key；绝不接受客户端传入 object key。

R2 代理支持 `Range` / `If-Range` / `If-None-Match`：完整响应为 200，合法单段 byte range 为 206（含 `Content-Range`），无效 range 为 416，缓存命中为 304；响应始终带 `Accept-Ranges: bytes` 和 private cache policy。音频拖动因此不需要把 Bucket 公开。

播放器保存的是完整进度快照：当前位置、毫秒时间、课内 checkpoint 答案和单调递增 `revision`。D1 只接受 `progress_revision < incoming revision` 的归属校验 CAS，延迟的普通 PATCH 不能覆盖 `pagehide`/卸载时更新的最终快照。

### 正式测验边界

课内 checkpoint 只属于播放器进度，不写 L1–L4 知识证据。`POST /api/coursewares/:id/assessment` 只接受当前账户拥有且 `ready` 的课件：优先复用同一孩子、同一账户、模式为 `selflearn-daily` 的 source conversation，否则创建一个同模式会话，并用 D1 CAS 只关联一次。固定 request ID `courseware-assessment-{coursewareId}` 复用现有聊天幂等边界。

正式测验的一题一答仍走原 `selflearn-daily` 消息处理，只有正式回答会沉淀知识点和错题卡。功能开关关闭、个人 Key 移除或目录模型停用不影响已保存课件的播放与 assessment 恢复。

## 数据库迁移

迁移文件位于 `migrations/`，按编号顺序执行。基本原则：

当前迁移链到 `0016_courseware_progress_revision.sql`。语音课件首次发布必须连续应用所有待执行的 `0012`–`0016`，不能只应用 catalog/基础课件表后跳过 lifecycle、credential revision 或 progress revision。

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
- 课件列表/详情轮询和 assessment 请求使用 route epoch/AbortSignal；切换孩子或课件后，旧响应不能导航或覆盖新路由。
- 播放进度通过单调 revision 串行化，普通保存与最终保存不会互相回退。

## 项目结构

```text
src/worker/          Cloudflare Worker 后端
  auth/              注册、登录、session、密码哈希、鉴权
  students/          学生 CRUD 与画像表单
  chat/              会话、SSE、模型调用、OCR、额度与租约
  mistakes/          错题卡抽取与错题本
  selflearn/         自学记忆、结构化抽取与每日流程
  courseware/        目录解析、BYOK adapter、Queue 状态机、R2 媒体、进度与正式测验
  ai-catalog/        capability 目录、个人 provider 凭证和模型偏好
  profiles/          学科画像自动提炼
  admin/             邀请码、限额与站点共享 AI 服务配置
  settings/          登录用户个人 AI 设置（加密 Key）接口
  lib/               响应、错误、设置读取、个人设置解析与 AES-GCM 编解码

src/client/          React 前端
  pages/             页面级功能
  components/        表单、模态框、侧栏、消息气泡等
  lib/               聊天、图片、Markdown、日期等工具
  styles/            全局样式

prompts/             数学、语文、物理、英语、化学、历史和自学提示词
migrations/          D1 数据库迁移
test/                单元测试与 Worker/D1 集成测试
docs/                技术、部署、域名与设计资料
```

## 提示词与模型设计

- 六个学科分别使用解题导学提示词，目标是定位卡点并逐步引导；
- 自学提示词保留画像、每日流程、掌握等级和输出模板等硬规则；
- `courseware_enabled = 0` 时自学每日流程保留 OpenMAIC 交接；明确开启后，只在 `selflearn-daily` 末尾接受一个严格的站内课件任务块，profiling 不注入、不解析也不显示课件卡；
- 课件脚本预生成老师、AI 同学、误区、备用解释和 checkpoint，播放时不调用模型；
- 图片服务需要理解几何图、电路图、函数图像等关系，因此使用视觉理解模型而不是纯 OCR。

## 发布与运维

- 首次部署、日常发布、D1 迁移、Secret 配置和回滚：[DEPLOY.md](DEPLOY.md)
- 自定义域名和 DNS：[DOMAIN.md](DOMAIN.md)
- 产品使用方法：[README.md](../README.md)

当前产品不提供自助找回密码和邮箱验证，适合家庭或小范围邀请场景。长会话历史目前也没有分页，后续扩展时需同时考虑客户端体验与 D1 查询成本。
