# 部署与发布文档

本项目部署在 Cloudflare Workers + D1。整站（API + 网页）都在一个 Worker 里，一条 `npm run deploy` 就能发布。

- 线上地址：https://xue.aipojing.xyz （备用 https://daoxue-web.xueban-ai.workers.dev）
- Cloudflare 账号：使用拥有目标 D1 数据库和 Workers 权限的账号
- D1 数据库名：`daoxue-db`
- 私有 R2：`daoxue-courseware-media`（生产）/ `daoxue-courseware-media-preview`（preview）
- Queue：`daoxue-courseware-generation`，DLQ：`daoxue-courseware-generation-dlq`

---

## 一、日常更新发布（最常用）

改完代码后：

```bash
cd daoxue-web
nvm use  # 使用项目要求的 Node.js 22

# 1. 自检：测试、构建、全部依赖审计与 Worker 打包必须全过
npm test
npm run build
npm audit
npx wrangler deploy --dry-run --outdir .wrangler/dry-run

# 2. 查看并按编号应用所有待执行 additive migrations；不要挑文件或跳号
npx wrangler d1 migrations list daoxue-db --remote
npx wrangler d1 migrations apply daoxue-db --remote

# 3. 构建并发布
npm run deploy
```

发布成功会输出线上地址和 Version ID。**改动会立即生效**（全球边缘节点约 30 秒内同步完成）。

仓库的 GitHub Actions 会在 push 和 pull request 时执行同一套门禁。`wrangler deploy --dry-run`
只验证生产 Worker 能否正确打包，不会部署、不会读取或修改远程 D1；只有显式运行上面的
`d1 migrations apply --remote` 和最后的 `npm run deploy` 才会改变线上状态。

浏览器看不到新版本时，强制刷新：Mac `Cmd + Shift + R`，Windows `Ctrl + F5`。

### 发布前检查清单

- [ ] `npm test` 全绿
- [ ] `npm run build` 无报错
- [ ] `npm audit` 无已知依赖漏洞
- [ ] `wrangler deploy --dry-run` 无配置或打包告警
- [ ] GitHub Actions CI 全绿
- [ ] 本地 `npm run dev:worker` 跑通改动涉及的页面
- [ ] 改了数据库结构 → 新建了 migration 文件（不要改已应用过的旧文件）
- [ ] 没有把 API Key 写进代码（`.dev.vars` 已 gitignore）
- [ ] 涉及语音课件 → 生产 `courseware_enabled` 仍为 `0`，直到 preview/本地完整冒烟通过

---

## 二、首次部署（换新账号或重建环境时用）

```bash
# 1. 登录 Cloudflare（会打开浏览器授权）
npx wrangler login

# 2. 创建 D1 数据库，把输出的 database_id 填进 wrangler.jsonc
npx wrangler d1 create daoxue-db

# 3. 应用全部数据库迁移
npx wrangler d1 migrations apply daoxue-db --remote

# 4. 首次部署前需要注册 workers.dev 子域名
#    在 Cloudflare 控制台 Workers & Pages → 右侧 Subdomain 处设置
#    （命令行交互不可用时，也可用 API：
#     curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/subdomain" \
#          -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
#          -d '{"subdomain":"你想要的名字"}' ）

# 5. 构建并部署
npm run deploy
```

新子域名首次访问会有 1-3 分钟的 TLS 证书签发时间，期间会报 SSL 握手失败，属正常现象。

---

## 二（附）、用户级 AI 配置功能首次发布（migrations 0009–0010）

发布顺序固定为：配置并备份加密 Secret → 备份 D1 → 应用迁移 → 发布 Worker → 验证共享兜底 →
用户录入个人 Key → 关闭共享兜底。

```bash
# 1. 生成一次加密主密钥。复制输出并先保存到密码管理器；不要生成第二次
openssl rand -base64 32

# 将密码管理器里刚保存的同一个值粘贴到 Wrangler 提示中
npx wrangler secret put AI_SETTINGS_ENCRYPTION_KEY

# 2. 备份远程 D1；目录已被 gitignore，避免误提交真实学习数据
mkdir -p backups
chmod 700 backups
npx wrangler d1 export daoxue-db --remote --output backups/pre-user-ai-settings.sql
chmod 600 backups/pre-user-ai-settings.sql

# 3. 应用待执行迁移（0009 建表，0010 增加账户画像策略）并发布
npx wrangler d1 migrations apply daoxue-db --remote
npm run deploy
```

部署后检查：

1. 管理员进入「设置」页，确认“站点共享 AI 服务”区可见且共享兜底开关为开启（迁移初始值）；
2. 用一个测试普通账号在「AI 服务」页保存个人 Key 和画像策略，完成一次聊天；配置视觉 Key 后再完成一次拍照识题；
3. 逐个账号完成个人 Key 录入后，管理员在「设置」页关闭共享兜底开关，进入严格 BYOK。

回滚说明：

- 回滚旧代码后，旧版本会忽略共享兜底开关并恢复"全局共享 Key"行为；
- `user_ai_settings` 表及 0010 新增列保留不影响旧代码读写；
- 只要表内仍有个人密文，就不得删除或覆盖 `AI_SETTINGS_ENCRYPTION_KEY`，否则密文永久无法恢复。

---

## 二（附二）、语音课件首次发布：默认关闭

这是 additive、disabled rollout。严格按下面顺序执行；不要先发布依赖新表的 Worker，也不要为了回滚删除 Bucket、Queue、DLQ、迁移或课件对象。

### 1. 创建私有 Standard R2

名称必须与 `wrangler.jsonc` 完全一致：

```bash
npx wrangler r2 bucket create daoxue-courseware-media
npx wrangler r2 bucket create daoxue-courseware-media-preview
```

R2 默认使用 Standard storage class。两个 Bucket 都保持 private：不要配置 public development URL、公开域名或允许浏览器直连。Worker 的 `COURSEWARE_MEDIA` binding 负责生产/preview 选择，媒体只能通过登录后的同源 API 读取。

### 2. 创建 generation Queue 与 DLQ

```bash
npx wrangler queues create daoxue-courseware-generation-dlq
npx wrangler queues create daoxue-courseware-generation
```

`wrangler.jsonc` 已声明 producer binding `COURSEWARE_QUEUE`，consumer 使用 batch size 1、最大并发 2、最大重试 3，并把耗尽的消息送到 `daoxue-courseware-generation-dlq`。不要改名后只改控制台；配置和远端资源必须一致。

### 3. 备份 D1，并顺序应用 0012–0016

```bash
mkdir -p backups
chmod 700 backups
npx wrangler d1 export daoxue-db --remote --output backups/pre-voice-courseware.sql
chmod 600 backups/pre-voice-courseware.sql

npx wrangler d1 migrations list daoxue-db --remote
npx wrangler d1 migrations apply daoxue-db --remote
npx wrangler d1 migrations list daoxue-db --remote
```

Wrangler 会按文件名顺序应用所有待执行迁移。发布前必须确认下面五个 additive migration 都已执行，不能只停在 0012/0013：

| migration | 内容 |
|---|---|
| `0012_courseware_ai_catalog.sql` | capability catalog、个人 provider credential、模型偏好、连接测试限额 |
| `0013_voice_coursewares.sql` | 课件/段落/消息 draft，写入 `courseware_enabled = 0` 默认值 |
| `0014_courseware_lifecycle.sql` | enqueue lease、媒体/学生清理 tombstone |
| `0015_credential_revision.sql` | 凭证版本句柄，隔离 Key 轮换后的健康状态 |
| `0016_courseware_progress_revision.sql` | 单调播放进度 revision |

检查 flag，结果必须是 `0`：

```bash
npx wrangler d1 execute daoxue-db --remote \
  --command "SELECT key, value FROM app_settings WHERE key = 'courseware_enabled';"
```

不要编辑已应用 migration，也不要用删除表/列模拟回滚。

### 4. 配置唯一加密主密钥

如果环境还没有 `AI_SETTINGS_ENCRYPTION_KEY`，只生成一次，先保存到密码管理器，再写入 Worker Secret：

```bash
openssl rand -base64 32
npx wrangler secret put AI_SETTINGS_ENCRYPTION_KEY
```

不要为课件配置共享 provider Key。站点既有 `DEEPSEEK_API_KEY` / `VISION_API_KEY` 共享兜底只服务原聊天/OCR 路径，课件生成不会读取它们。课件测试账户必须自己在「AI 服务」页保存 provider Key。

### 5. 以关闭状态部署 Worker

```bash
npm test
npm run typecheck
npm run build
npm run deploy:dry-run
npm run deploy
```

部署后再次从管理员 UI 和 D1 查询确认语音课件开关关闭。关闭状态下不能创建新课件，但新 API、绑定和 additive schema 已可接受验证；已有 `ready` 课件仍可播放和继续正式测验。

### 6. 配置目录和个人测试账户

1. 管理员进入「设置」的模型目录，核对 provider、endpoint capability、adapter、HTTPS base URL、模型、音色和启用状态；不要在目录中保存 Key。
2. 使用专门的非生产家长测试账户进入「AI 服务」，分别保存自己的课件脚本、老师语音、AI 同学语音和可选图片 provider Key/偏好。
3. 依次运行文本、语音和图片连接测试，确认页面只显示尾号/健康状态；空 Key、错误 Key、quota exhausted 都应阻止新生成且没有共享兜底。

### 7. 在 preview/本地临时开启并完成 end-to-end smoke

生产仍保持 `0`。在绑定 preview R2 的 preview 或完整本地环境中，通过管理员 UI 临时打开 `courseware_enabled`，仅用上面的专用测试账户执行 [冒烟清单](../scripts/smoke.md)：

1. 从 `selflearn-daily` 严格任务卡创建课件；离开页面，等待 Queue consumer 完成后返回。
2. 播放主/学生语音，拖动 seek（网络响应为 206），切换倍速，触发预生成备用解释，回答 checkpoint 并刷新确认进度。
3. 点击正式测验，确认只创建/复用一个所属每日自学会话，重复点击不产生多个开场请求。
4. 观察配图失败 warning、归一化失败数量、D1 writes/rows、R2 operations/storage、Queue backlog/retry/DLQ 和 provider 用量。
5. 完成后把 preview/local flag 重新关回 `0`。

### 8. 生产启用与停止新生成

只有上述完整 smoke 通过后，管理员才在生产「设置」页明确开启语音课件。开启后先用同一个专用家长账户做一轮小流量生产验证，再逐步通知普通账户。

发生 provider、费用或稳定性异常时，第一步是把 `courseware_enabled` 关回 `0`。这只阻止新的课件创建；已经保存的课件、私有媒体、播放进度和正式测验仍可使用。

### 9. 语音课件回滚

1. 管理员先关闭 `courseware_enabled`，停止新创建。
2. 记录 Queue backlog/DLQ、失败码和当前 Worker Version ID；条件允许时让已经领取的任务完成或安全失败。
3. 使用 `npx wrangler rollback` 回到已知稳定 Worker 版本。
4. 保留 0012–0016 新表/列、`AI_SETTINGS_ENCRYPTION_KEY`、两个私有 R2 Bucket 及对象、generation Queue、DLQ 和所有 D1 tombstone。它们是增量资源，不是回滚目标；后续重新发布兼容 Worker 可继续恢复/清理。

**禁止**通过删除 Bucket、Queue、DLQ、迁移记录、课件表或密文来回滚。这会破坏已付费媒体、用户进度、凭证可恢复性和后台清理依据。

---

## 三、AI 服务与 API Key 配置

AI 服务分两层，分别按配置所有者放在两个页面中（不用重新部署，随时能换）：

1. **个人配置（所有登录用户）**：每个账号填自己的 DeepSeek Key 和视觉服务 Key，优先级最高，
   同账号下所有学生共用；同时设置该账号的画像提炼间隔和每日上限。Key 以 AES-256-GCM 密文存入 D1，
   页面只显示尾号不回显完整值。个人视觉服务只允许智谱 / 阿里云百炼两种白名单服务。入口为「AI 服务」。
2. **站点共享配置（仅管理员）**：作为没有个人 Key 账号的聊天/OCR 兜底，可自定义 OpenAI 兼容地址，入口为「设置」。它不用于语音课件。

| 配置项 | 说明 | 从哪里拿 |
|---|---|---|
| DeepSeek API Key | 必填，驱动全部对话 | https://platform.deepseek.com |
| 视觉模型 Key | 选填，开启拍照识题 | https://open.bigmodel.cn （GLM-4.1V-Thinking-Flash 免费） |
| 视觉服务地址 / 模型（仅共享） | 选填，共享服务换其他 OpenAI 兼容服务时填 | 如通义：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` + `qwen-vl-plus` |
| 画像提炼间隔 / 每日上限（仅个人） | 控制当前账号 Key 的后台画像消耗；默认 10 分钟 / 每日不限 | 在「AI 服务」页直接设置 |

共享兜底开关由管理员显式控制：migration 0009 初始为"开启"，保证老用户不中断；
全部账号录完个人 Key 后，管理员在「设置」页关闭开关，即进入严格 BYOK。

**共享服务的备用方式：环境变量 Secret**

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put VISION_API_KEY
```

共享服务优先级：**网页配置 > 环境变量**。共享与个人都没配时，对话会提示去「AI 服务」页配置。语音课件无论共享开关如何都只认当前账户个人 provider credential。

**必须配置的加密主密钥**

个人 Key 依赖 Worker Secret `AI_SETTINGS_ENCRYPTION_KEY`（Base64 编码的 32 字节）：

```bash
# 只生成一次，先把输出保存到密码管理器
openssl rand -base64 32

# 再将密码管理器中的同一个值粘贴到提示中
npx wrangler secret put AI_SETTINGS_ENCRYPTION_KEY
```

未配置该 Secret 时，「AI 服务」页保存新的个人 Key 会返回 503；只修改画像策略不依赖加密。已有的个人密文仍会 fail closed。

---

## 四、数据库迁移

### 新增迁移

在 `migrations/` 下按序号新建文件，如 `0004_xxx.sql`：

```sql
ALTER TABLE students ADD COLUMN new_field TEXT NOT NULL DEFAULT '';
```

然后：

```bash
npx wrangler d1 migrations apply daoxue-db --local    # 本地先验
npx wrangler d1 migrations apply daoxue-db --remote   # 线上
```

**注意事项**

- 已经应用过的迁移文件不要再改，只能新增；wrangler 靠文件名记录应用状态。
- D1 是 SQLite，`ALTER TABLE` 只支持加列，改列 / 加约束需要"建新表 → 拷数据 → 换名"。
- 迁移只能往前，没有自动回滚，写之前想清楚。

### 查数据 / 应急改库

```bash
# 线上
npx wrangler d1 execute daoxue-db --remote --command "SELECT id, email FROM users;"

# 本地
npx wrangler d1 execute daoxue-db --local --command "SELECT * FROM students;"
```

常见应急操作：

```bash
# 给某用户重置密码：先用 node 生成 PBKDF2 哈希，或直接删号让对方重新注册
# 解除某邮箱的登录锁定
npx wrangler d1 execute daoxue-db --remote --command "DELETE FROM login_failures WHERE email='xxx@xx.com';"

# 手动给某账号提管理员
npx wrangler d1 execute daoxue-db --remote --command "UPDATE users SET is_admin=1 WHERE email='xxx@xx.com';"

# 重置某账号今日用量
npx wrangler d1 execute daoxue-db --remote --command "DELETE FROM usage_log WHERE user_id=1;"
```

---

## 五、绑定自定义域名（解决大陆访问）

`*.workers.dev` 在大陆受 DNS 污染影响基本打不开，需要绑自己的域名。

1. **买域名**：在 Cloudflare 控制台 Domain Registration 直接买（约 $10/年，无溢价），或在阿里云等注册商买后把 NS 改成 Cloudflare 提供的两个地址。
2. **接入 Cloudflare**：控制台 → Add a site → 输入域名 → 选 Free 计划。
3. **绑定到 Worker**：控制台 → Workers & Pages → daoxue-web → Settings → Domains & Routes → Add Custom Domain，填 `你的域名` 或 `app.你的域名`。
4. 证书自动签发，几分钟后生效。原 workers.dev 地址继续可用。

绑定后大陆一般可直连（走 Cloudflare 海外节点，延迟 200-400ms）。**网站托管在境外不需要 ICP 备案**。

---

## 六、回滚

```bash
# 查看历史版本
npx wrangler deployments list

# 回滚到指定版本
npx wrangler rollback --message "回滚原因"
```

**注意**：代码能回滚，**数据库迁移不能**。如果新版本加了迁移又回滚了代码，可能出现"表结构比代码新"的情况——一般无害（多余的列不影响旧代码），但反过来（代码需要新列却没迁移）会报错。

---

## 七、日志与排查

```bash
# 实时看线上日志（含 console.error）
npx wrangler tail

# 只看报错
npx wrangler tail --status error
```

控制台也能看：Workers & Pages → daoxue-web → Logs（已开启 observability）。

### 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 页面正常但发消息报"Key 无效" | 「AI 服务」页填 DeepSeek Key；或检查 Key 是否欠费 |
| 报"今日对话次数已用完" | 设置页调高该账号的每日上限，或等北京时间 0 点重置 |
| 报"尝试次数过多" | 登录连错 5 次会锁 15 分钟，等待或删 `login_failures` 表对应行 |
| 拍照按钮不见了 | 没配视觉模型 Key，「AI 服务」页填上即可 |
| 部署后页面还是旧的 | 强制刷新浏览器（Cmd+Shift+R） |
| 本地 `wrangler dev` 报 compatibility date 错误 | 本地 wrangler 版本旧，升级 wrangler 或调低 `wrangler.jsonc` 里的 `compatibility_date` |
| 新绑定的域名报 SSL 错误 | 证书还在签发，等 1-3 分钟 |

---

## 八、成本

| 项目 | 免费额度 | 家庭使用是否够 |
|---|---|---|
| Workers 请求 | 10 万次/天 | 远超所需 |
| D1 读 | 500 万行/天 | 远超所需 |
| D1 写 | 10 万行/天 | 远超所需 |
| D1 存储 | 5 GB | 够用很多年 |
| Queue | 以 Cloudflare 当前套餐为准 | 生成消息只含课件 ID；用量需在 smoke 后观察 |
| 私有 R2 Standard | 以 Cloudflare 当前套餐为准 | MP3/图片是主要增量存储，按实际课件量监控 |
| 智谱 GLM-4.1V-Thinking-Flash | 免费 | 够用 |
| DeepSeek / 课件文本、TTS、图片 provider | 按各 provider 套餐计费 | 严格使用账户个人套餐，发布前后都要监控 |

聊天和课件 provider 调用是主要可变成本，R2/Queue 也会随课件量增长。对话每日限额不会替代课件 provider 自身的 quota；应分别观察 provider usage、Queue、D1 和 R2 指标，不在文档中假定某个套餐价格或免费额度长期不变。

---

## 九、备份

D1 可以整体 `export`；临时抽查单表时也可执行查询导出：

```bash
npx wrangler d1 execute daoxue-db --remote --json \
  --command "SELECT * FROM students;" > backup-students.json
```

重要的表：`users` `students` `selflearn_profiles` `knowledge_points` `mistake_cards` `lesson_outputs` `daily_reports` `messages` `ai_providers` `ai_provider_endpoints` `ai_models` `user_ai_credentials` `user_model_preferences` `coursewares` `courseware_segments` 以及课件 tombstone 表。

建议每隔一段时间导一次 `selflearn_profiles`、`knowledge_points`、`mistake_cards`——这几张是孩子的学习积累，重建不回来。
课件备份还必须把 D1 记录与私有 R2 对象作为一组考虑；只备份表而丢失 R2，`ready` 记录也无法播放。不要把 R2 object key、provider Key 或真实课件正文写进普通备份日志。
