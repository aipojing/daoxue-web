# 绑定自定义域名（aipojing.xyz）

目的：`*.workers.dev` 在大陆受 DNS 污染基本打不开，绑自己的域名后大陆一般可直连。

域名 `aipojing.xyz` 在**阿里云**注册，解析交给 **Cloudflare** 管理（域名所有权仍在阿里云，只是把 DNS 服务器指过去）。

## 一次性配置步骤

✅ **已完成**（2026-08-04）。NS：`lovisa.ns.cloudflare.com` / `yevgen.ns.cloudflare.com`。

学伴 AI 的地址：

- **https://xue.aipojing.xyz** （主地址，大陆可直连）
- https://daoxue-web.xueban-ai.workers.dev （备用）

根域名 `aipojing.xyz` 给个人站用（另一个项目 `aipojing-site`）。

### 1. 在 Cloudflare 添加站点

1. https://dash.cloudflare.com → 「+ Add」→「Existing domain」
2. 输入 `aipojing.xyz`，选 **Free** 计划
3. 记下页面给出的两个 NS 地址（形如 `xxx.ns.cloudflare.com`）

### 2. 在阿里云修改 DNS 服务器

1. https://dc.console.aliyun.com/ →「域名列表」→ `aipojing.xyz` →「DNS 修改」
2. 把 `ns1.alidns.com` / `ns2.alidns.com` 替换成 Cloudflare 给的两个
3. 保存

注意：新注册的 `.xyz` 需完成实名认证后才能改 NS。

### 3. 绑定到 Worker

NS 生效后（Cloudflare 站点状态变成 **Active**），执行：

```bash
bash scripts/bind-domain.sh aipojing.xyz
```

脚本会先校验 NS 是否已切到 Cloudflare，再部署并自动验证。

也可以手动做：在 `wrangler.jsonc` 加 routes 后 `npm run deploy`：

```jsonc
"routes": [
  { "pattern": "aipojing.xyz", "custom_domain": true },
  { "pattern": "www.aipojing.xyz", "custom_domain": true }
]
```

⚠️ 两个注意点：
1. routes 里配的域名如果在 Cloudflare 上还不是 Active 状态，`wrangler deploy` 会整体失败——所以要等 NS 生效后再加这段配置。
2. 一旦配置了 `routes`，wrangler 会**自动关闭 workers.dev 地址**。想继续保留备用入口，必须同时加 `"workers_dev": true`（本项目已加）。

也可以在控制台手动绑：Workers & Pages → daoxue-web → Settings → Domains & Routes → Add → Custom Domain。

### 4. 验证

```bash
# NS 是否已切换到 Cloudflare
dig NS aipojing.xyz +short

# 网站是否可访问
curl -s https://aipojing.xyz/api/health
curl -s -o /dev/null -w "%{http_code}\n" https://www.aipojing.xyz/
```

证书由 Cloudflare 自动签发，首次绑定后 1-3 分钟内可能报 SSL 错误，属正常。

## 说明

- 绑定后原 `daoxue-web.xueban-ai.workers.dev` 仍然可用，两个地址都指向同一个 Worker。
- 网站托管在境外，**不需要 ICP 备案**。
- 大陆访问走 Cloudflare 海外节点，延迟约 200-400ms（页面打开慢半拍，AI 流式输出不受影响）。
- 如果将来大陆访问变差，可考虑迁到国内云 + 备案域名（需改造 Workers/D1 为 Node + SQLite/RDS）。

---

## 用同一个域名部署多个项目

`aipojing.xyz` 的 DNS 已托管在 Cloudflare，可以无限添加二级域名，**不额外收费**。

当前分配：

| 地址 | 用途 |
|---|---|
| `aipojing.xyz` / `www.aipojing.xyz` | 个人简历站（仓库 aipojing-site） |
| `xue.aipojing.xyz` | 学伴 AI（本项目） |

### 新增一个项目

**情况 A：新项目也是 Cloudflare Worker / Pages（推荐，最省事）**

在新项目的 `wrangler.jsonc` 里加：

```jsonc
"routes": [
  { "pattern": "blog.aipojing.xyz", "custom_domain": true }
],
"workers_dev": true
```

然后 `wrangler deploy`。DNS 记录自动创建、证书自动签发，**不需要碰阿里云，也不需要手动加解析**。

**情况 B：指向其他服务器（阿里云 ECS、Vercel、GitHub Pages 等）**

Cloudflare 控制台 → `aipojing.xyz` → DNS → Add record：

| 目标 | 记录类型 | 内容 |
|---|---|---|
| 自己的服务器 | A | 服务器公网 IP |
| Vercel / Netlify 等 | CNAME | 对方给的域名 |

橙色云朵开着＝流量过 Cloudflare（有 CDN 和防护，大陆访问同样受益）；关掉＝仅解析。

### 注意

- 一个二级域名只能绑一个 Worker，不同项目用不同前缀即可。
- 根域名已分配给个人站，学伴 AI 走 `xue` 二级域名。新增项目继续用新的二级域名即可。
