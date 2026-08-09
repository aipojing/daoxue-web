# 部署与发布文档

本项目部署在 Cloudflare Workers + D1。整站（API + 网页）都在一个 Worker 里，一条 `npm run deploy` 就能发布。

- 线上地址：https://xue.aipojing.xyz （备用 https://daoxue-web.xueban-ai.workers.dev）
- Cloudflare 账号：使用拥有目标 D1 数据库和 Workers 权限的账号
- D1 数据库名：`daoxue-db`

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

# 2. 如果改了 migrations/ 下的文件，先应用到线上库
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

## 二（附）、用户级 AI Key 功能首次发布（migration 0009）

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

# 3. 应用迁移（只新增 0009_user_ai_settings.sql）并发布
npx wrangler d1 migrations apply daoxue-db --remote
npm run deploy
```

部署后检查：

1. 管理员进入「AI 服务」页，确认"站点共享"区可见且共享兜底开关为开启（迁移初始值）；
2. 用一个测试普通账号保存个人 Key，完成一次聊天；配置视觉 Key 后再完成一次拍照识题；
3. 逐个账号完成个人 Key 录入后，管理员关闭共享兜底开关，进入严格 BYOK。

回滚说明：

- 回滚旧代码后，旧版本会忽略共享兜底开关并恢复"全局共享 Key"行为；
- `user_ai_settings` 表（0009）保留不影响旧代码读写；
- 只要表内仍有个人密文，就不得删除或覆盖 `AI_SETTINGS_ENCRYPTION_KEY`，否则密文永久无法恢复。

---

## 三、AI 服务与 API Key 配置

AI 服务分两层，都在登录后可见的「AI 服务」页配置（不用重新部署，随时能换）：

1. **个人配置（所有登录用户）**：每个账号填自己的 DeepSeek Key 和视觉服务 Key，优先级最高，
   同账号下所有学生共用；Key 以 AES-256-GCM 密文存入 D1，页面只显示尾号不回显完整值。
   个人视觉服务只允许智谱 / 阿里云百炼两种白名单服务。
2. **站点共享配置（仅管理员）**：作为没有个人 Key 账号的兜底，可自定义 OpenAI 兼容地址。

| 配置项 | 说明 | 从哪里拿 |
|---|---|---|
| DeepSeek API Key | 必填，驱动全部对话 | https://platform.deepseek.com |
| 视觉模型 Key | 选填，开启拍照识题 | https://open.bigmodel.cn （GLM-4.1V-Thinking-Flash 免费） |
| 视觉服务地址 / 模型（仅共享） | 选填，共享服务换其他 OpenAI 兼容服务时填 | 如通义：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` + `qwen-vl-plus` |

共享兜底开关由管理员显式控制：migration 0009 初始为"开启"，保证老用户不中断；
全部账号录完个人 Key 后，管理员在「AI 服务」页关闭开关，即进入严格 BYOK。

**共享服务的备用方式：环境变量 Secret**

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put VISION_API_KEY
```

共享服务优先级：**网页配置 > 环境变量**。共享与个人都没配时，对话会提示去「AI 服务」页配置。

**必须配置的加密主密钥**

个人 Key 依赖 Worker Secret `AI_SETTINGS_ENCRYPTION_KEY`（Base64 编码的 32 字节）：

```bash
# 只生成一次，先把输出保存到密码管理器
openssl rand -base64 32

# 再将密码管理器中的同一个值粘贴到提示中
npx wrangler secret put AI_SETTINGS_ENCRYPTION_KEY
```

未配置该 Secret 时，「AI 服务」页保存个人 Key 会返回 503；已有的个人密文也会 fail closed。

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
| 智谱 GLM-4.1V-Thinking-Flash | 免费 | 够用 |
| **DeepSeek** | **按量付费** | **唯一实际花钱的地方** |

DeepSeek 是主要成本。每条对话会带完整系统提示词（自学模式约 9 千字），按当前价格粗估每天认真学一小时约几毛钱。每日限额就是防止意外失控用的。

---

## 九、备份

D1 没有一键导出，需要时按表导：

```bash
npx wrangler d1 execute daoxue-db --remote --json \
  --command "SELECT * FROM students;" > backup-students.json
```

重要的表：`users` `students` `selflearn_profiles` `knowledge_points` `mistake_cards` `lesson_outputs` `daily_reports` `messages`。

建议每隔一段时间导一次 `selflearn_profiles`、`knowledge_points`、`mistake_cards`——这几张是孩子的学习积累，重建不回来。
