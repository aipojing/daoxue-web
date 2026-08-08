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

# 1. 自检：类型 + 测试必须全过
npm run typecheck
npm test

# 2. 如果改了 migrations/ 下的文件，先应用到线上库
npx wrangler d1 migrations apply daoxue-db --remote

# 3. 构建并发布
npm run deploy
```

发布成功会输出线上地址和 Version ID。**改动会立即生效**（全球边缘节点约 30 秒内同步完成）。

浏览器看不到新版本时，强制刷新：Mac `Cmd + Shift + R`，Windows `Ctrl + F5`。

### 发布前检查清单

- [ ] `npm test` 全绿
- [ ] `npm run typecheck` 无报错
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

## 三、API Key 配置

**推荐方式：网页配置**（不用重新部署，随时能换）

登录管理员账号 → 「设置」页 → 「AI 服务配置」：

| 配置项 | 说明 | 从哪里拿 |
|---|---|---|
| DeepSeek API Key | 必填，驱动全部对话 | https://platform.deepseek.com |
| 视觉模型 Key | 选填，开启拍照识题 | https://open.bigmodel.cn （GLM-4.1V-Thinking-Flash 免费） |
| 视觉服务地址 / 模型 | 选填，换其他 OpenAI 兼容服务时填 | 如通义：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` + `qwen-vl-plus` |

Key 存在 D1 的 `app_settings` 表里，页面只显示尾号不回显完整值，输入框留空表示不修改。

**备用方式：环境变量 Secret**

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put VISION_API_KEY
```

优先级：**网页配置 > 环境变量**。两个都没配时，对话会提示"尚未配置 DeepSeek API Key"。

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
| 页面正常但发消息报"Key 无效" | 设置页填 DeepSeek Key；或检查 Key 是否欠费 |
| 报"今日对话次数已用完" | 设置页调高该账号的每日上限，或等北京时间 0 点重置 |
| 报"尝试次数过多" | 登录连错 5 次会锁 15 分钟，等待或删 `login_failures` 表对应行 |
| 拍照按钮不见了 | 没配视觉模型 Key，设置页填上即可 |
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
