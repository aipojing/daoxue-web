# 学伴 AI（daoxue-web）

> 面向家庭的 AI 学习陪伴网站：让孩子在提示、讲解、练习和复盘中自己学会，而不是直接得到答案。

[在线体验](https://xue.aipojing.xyz) · [备用地址](https://daoxue-web.xueban-ai.workers.dev) · [部署文档](docs/DEPLOY.md) · [GitHub 仓库](https://github.com/aipojing/daoxue-web)

一个账号可为多个孩子建立独立档案。AI 会记录每个孩子的学习目标、已学内容、掌握程度和典型错因，随着使用逐渐形成更贴合个人的学习节奏。

## 它解决什么问题？

| 场景 | 学伴 AI 的做法 |
|---|---|
| 想系统学一项新内容 | 根据画像安排每日学习闭环，追踪知识点掌握情况与下一步任务 |
| 作业被难题卡住 | 判断卡点后给最小提示，逐步引导，而不是直接报答案 |
| 错题反复出现 | 自动整理错题卡、归类错因，并按复测日期提醒巩固 |
| 家长难以持续跟进 | 将每日学习情况、待复测内容和薄弱点结构化沉淀 |

## 两种使用模式

### 🎯 自学陪伴 —— 有计划地学新内容

基于《自学 Agent 基座架构提示词》+ 8 个组件 + 固定每日运行协议实现的每日自学闭环：

```
填画像表单（建学生时一次性完成）
  ↓
任务确认 → 旧知识保温 → 知识点拆解
  ↓
生成课件提示词（复制到 OpenMAIC 上课）
  ↓
孩子学完回来说"学完了"
  ↓
一题一出的测验 → 错题卡 → 错因分析 → L1-L4 掌握等级判定
  ↓
【每课输出】 → 下一步调度 → 【每日家长反馈】
```

AI 输出的每课输出、每日家长反馈、错题卡和掌握等级会被自动结构化存档，第二天开始学习时自动注入上下文——所以 AI 知道昨天学到哪、哪个知识点还没稳、今天该先复测什么。

**核心规则（提示词硬约束）**：低于 L3 不推进同一链条新内容；没有复述证据不判 L3；没有迁移证据不判 L4；错因必须归类不能写"粗心"；信息不足标注"暂无"不编造；孩子状态差时降低强度而不是加量。

适合：每天固定时间的系统自学、预习补弱、专项提升（学习方向不限于五学科，编程 / 写作等都支持）。

### 💡 解题辅导 —— 遇到具体题目时用

基于五套学科提示词（数学 / 语文 / 物理 / 英语 / 化学）的分步导学。AI 不直接报答案，而是先判断孩子卡在哪一步（读题 / 概念 / 建模 / 计算 / 表达），再逐级给最小提示引导孩子自己解出来。支持批改复盘、错因诊断、一键存入错题本。

适合：写作业卡壳、订正错题、考前针对性练习。

## 功能一览

| 功能 | 说明 |
|---|---|
| 多学生档案 | 一个账号多个孩子，数据严格隔离 |
| 画像表单 | 建学生时 4 步引导填写（方向目标 / 学习习惯 / 状态兴趣 / 家长要求），随时可改 |
| 错题本 | AI 自动整理结构化错题卡（错因标签、关键步骤、复测题），按复测日期管理，未通过自动顺延 |
| 知识点掌握表 | L1-L4 等级 + 待保温 / 待复测 / 需重构 / 可组网标记 |
| 拍照识题 | 可选功能，配视觉模型 Key 后拍照自动转写成文字（家长核对后发送） |
| 深度思考 | 切换 `deepseek-reasoner`，适合难题，思考过程可展开查看 |
| 邀请码注册 | 首个账号自动成为管理员，之后注册需邀请码 |
| 每日限额 | 默认 100 条/账号/天，管理员可调，防止 API 费用失控 |
| 网页配 Key | 管理员在设置页填 API Key，无需重新部署 |

## 技术栈

| 层 | 选择 |
|---|---|
| 运行时 | Cloudflare Workers（单 Worker 同时提供 API 和静态资源） |
| 后端 | Hono 4 + TypeScript |
| 数据库 | Cloudflare D1（SQLite） |
| 前端 | React 18 + Vite + react-router 7 |
| 渲染 | react-markdown + KaTeX（数学公式） |
| 大模型 | DeepSeek（`deepseek-chat` / `deepseek-reasoner`） |
| 视觉模型 | 智谱 GLM-4.1V-Thinking-Flash（免费）或任意 OpenAI 兼容服务 |
| 校验 / 测试 | zod / Vitest（单元测试 + 真实 Worker/D1 集成测试） |

## 快速开始（本地开发）

### 准备条件

- Node.js 22（见 `.nvmrc`）
- 一个拥有 Workers 和 D1 权限的 Cloudflare 账号
- DeepSeek API Key；若要开启拍照识题，再准备兼容视觉模型的 API Key

首次自托管时，请先按 [部署文档](docs/DEPLOY.md) 创建自己的 D1 数据库，并把生成的数据库 ID 写入 `wrangler.jsonc`。

```bash
npm install

# 配置本地密钥（此文件已被 gitignore，不会提交）
cat > .dev.vars <<'EOF'
DEEPSEEK_API_KEY=sk-你的key
VISION_API_KEY=你的智谱key
EOF

# 初始化本地数据库
npx wrangler d1 migrations apply daoxue-db --local

# 构建前端（wrangler dev 需要 dist/client 存在）
npm run build

# 启动（API + 页面都在 http://localhost:8787）
npm run dev:worker
```

前端热更新开发时另开一个终端跑 `npm run dev:client`（5173 端口，`/api` 自动代理到 8787）。

常用命令：

```bash
npm test          # 跑单元测试 + Worker/D1 集成测试
npm run typecheck # 类型检查（前端 + Worker）
npm run build     # 类型检查 + 构建前端
npm audit         # 检查全部依赖漏洞
npx wrangler deploy --dry-run --outdir .wrangler/dry-run # 只验证 Worker 打包，不部署
npm run deploy    # 构建并部署到 Cloudflare
```

本项目使用 Node.js 22（见 `.nvmrc`）；使用 nvm 时先运行 `nvm use`。

GitHub Actions 会在 push 和 pull request 时执行依赖安装、测试、构建、全部依赖审计及
Wrangler dry-run。dry-run 只在本地生成打包产物，不会部署 Worker，也不会连接或修改远程 D1。

## 安全与隐私

- `.dev.vars` 已加入 `.gitignore`，请只在本地保存 API Key，切勿提交到仓库。
- 生产环境可由管理员在「设置」页配置密钥，也可使用 Cloudflare Secret；密钥不会回显完整内容。
- 首个注册账号自动成为管理员，后续注册需邀请码。公开部署前请确认管理员账号和邀请码策略符合你的使用场景。
- 本项目不提供示例账号、示例密钥或真实学习数据；自行部署时请使用自己的 Cloudflare 账号和数据库。

## 部署与发布

见 **[docs/DEPLOY.md](docs/DEPLOY.md)**——首次部署、日常更新发布、数据库迁移、密钥配置、回滚、常见问题。

绑定自定义域名见 **[docs/DOMAIN.md](docs/DOMAIN.md)**。

## 使用说明

- **首个注册的账号自动成为管理员**（无需邀请码），之后所有注册都需要邀请码。
- 管理员在「设置」页：填写 API Key、生成 / 停用邀请码、调整每个账号的每日消息上限。
- 建学生时填 4 步画像表单 → 学生主页选模式 → 自学陪伴点「开始今天的学习」，解题辅导选学科开始对话。
- 自学会话输入框上方有「开始今天的学习 / 学完了 / 今天结束」快捷按钮，不用记暗号。
- 课件环节 AI 会输出一段提示词，代码块右上角点「复制」，粘贴到 [OpenMAIC](https://open.maic.chat/) 生成课件。

## 项目结构

```
src/worker/          Cloudflare Worker（后端）
  auth/              注册登录、会话、密码哈希、鉴权中间件
  students/          学生 CRUD、画像表单
  chat/              会话与 SSE 流式聊天、DeepSeek/视觉模型调用、限额
  mistakes/          错题卡抽取与错题本
  selflearn/         自学陪伴：记忆注入、结构化抽取
  profiles/          学科画像自动提炼
  admin/             邀请码、用户限额、API Key 配置
  lib/               响应封装、错误类型、设置读取

src/client/          React 前端
  pages/             各页面
  components/        通用组件（向导、侧栏、消息气泡、图标等）
  lib/               图片压缩、时区格式化
  styles/global.css  设计系统「教室与作业本」

prompts/             AI 提示词（构建时打包进 Worker）
  math/chinese/physics/english/chemistry.md   五套学科题解导学提示词
  selflearn-profiling.md            画像采集（已由表单替代，保留备用）
  selflearn-daily.md                自学每日运行协议（基座 + 8 组件浓缩）

migrations/          D1 数据库迁移
test/                Vitest 单元测试
docs/                设计文档、实现计划、部署文档
```

## 设计说明

- **画像表单来自提示词原文**：4 步表单对应基座画像采集的四轮问卷，问题和选项文案取自原文，只是把 AI 口头提问改成了可点选的表单。
- **提示词是浓缩版不是原文**：原始 docx 是给 WorkBuddy 的"安装提示词"（约 9700 行），含大量安装确认和自检内容，且远超上下文窗口。运行时用的是保留全部硬规则、流程和输出模板的浓缩版，每条消息完整携带。
- **课件环节走 OpenMAIC**：按原方案设计，本站不讲新课，只生成课件生产提示词供复制到 [OpenMAIC](https://open.maic.chat/) 上课。
- **视觉模型选 Thinking 而非 OCR**：拍题除了认字还要描述几何图形 / 电路图 / 函数图像的关系，需要视觉理解推理能力，纯 OCR 模型做不好。

## 已知限制

- 大陆访问走 Cloudflare 海外节点，延迟约 200-400ms（页面打开慢半拍，AI 流式输出不受影响）。
- 没有找回密码流程，忘记密码需管理员改库重置。
- 没有邮箱验证，按小范围邀请制使用设计。
