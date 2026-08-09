# 用户级 AI Key 与独立 AI 服务页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个登录账户安全地配置并优先使用自己的 DeepSeek/视觉服务 Key，同时把“AI 服务”从管理员设置中拆成独立页面，并保留管理员可显式启停的站点共享服务兜底。

**Architecture:** 新增以 `user_id` 为主键的 `user_ai_settings`，API Key 用 Worker Secret 提供的 256 位主密钥做 AES-GCM 加密，密文绑定用户与服务类型作为 AAD；完整 Key 永不返回前端、永不写日志。运行时统一通过 `resolveUserAIConfig()` 按“个人配置 → 管理员明确开启的站点共享配置 → 未配置”解析，聊天、OCR、错题提取、画像提炼和自学后处理共享同一次解析结果。前端新增所有登录用户可见的 `/ai-settings`，原 `/settings` 只保留账号、邀请码和用户管理。

**Tech Stack:** TypeScript、Hono、Cloudflare Workers Web Crypto、Cloudflare D1、React 18、React Router 7、Zod、Vitest、Miniflare Workers/D1 集成测试。

## Global Constraints

- 用户级配置按账户保存，同一账户下的全部学生共用；本期不支持“每个学生一个 Key”。
- 个人 Key 始终优先于站点共享 Key；个人密文损坏或主密钥不匹配时必须明确报错，禁止静默改用站点共享 Key 产生意外费用。
- 站点共享兜底必须由管理员显式控制。为避免现有线上用户在发布瞬间中断，迁移初始写入“已开启”；完成用户迁移后由管理员手动关闭，之后即为严格 BYOK。
- 现有 `app_settings` 中的 DeepSeek/视觉配置保留，语义改为“站点共享 AI 服务”；本期不自动把它复制给首位管理员，也不删除环境变量兜底。
- 用户 Key 使用 AES-256-GCM 加密后写入 D1；主密钥只存在于 `AI_SETTINGS_ENCRYPTION_KEY` Worker Secret / 本地 `.dev.vars`，不得提交仓库、写日志或通过 API 返回。
- AES-GCM AAD 必须包含版本、用户 ID 与服务类型，例如 `user-ai:v1:42:deepseek`，防止密文跨用户或跨服务替换。
- 普通用户不得提交任意视觉 API URL。个人视觉服务只允许后端白名单中的 `zhipu`、`dashscope`；管理员的站点共享服务继续允许自定义 OpenAI 兼容地址。
- API 中 Key 字段采用三态：省略表示不修改，非空字符串表示覆盖，`null` 表示清除；空字符串作为非法输入拒绝，避免“保存空表单”误删 Key。
- GET 接口只返回是否已配置、尾号掩码、服务来源和非敏感模型信息；任何响应都不得包含密文、IV、完整 Key 或主密钥。
- 当前 `daily_message_limit` 继续对个人 Key 和共享 Key 一视同仁，作为账户安全上限；画像提炼间隔和每日上限本期仍是站点级策略，但 AI 页面必须提示画像提炼也会消耗当前生效的 DeepSeek Key。
- 保存或清除个人配置后必须刷新 `/api/auth/me`，使聊天页的拍照入口与 AI 可用状态立即更新。
- 发布顺序固定为：配置并备份加密 Secret → 备份 D1 → 应用迁移 → 发布 Worker → 验证共享兜底 → 用户录入个人 Key → 关闭共享兜底。
- 已应用的旧 migration 不得修改；只能新增 `0009_user_ai_settings.sql`。
- 所有行为修改遵循 TDD：先新增失败测试并确认 RED，再做最小实现并确认 GREEN；每个任务独立提交。

---

## File Map

**New files**

- `migrations/0009_user_ai_settings.sql`：用户级密文、视觉提供商和共享兜底开关。
- `src/worker/lib/secrets.ts`：AES-GCM 编解码与主密钥校验，保持无 D1、无业务依赖。
- `src/worker/lib/user-ai-settings.ts`：个人设置读写、掩码状态和个人/共享解析策略。
- `src/worker/settings/routes.ts`：登录用户自己的 AI 设置 GET/PUT 接口。
- `src/client/pages/AISettingsPage.tsx`：个人 AI 服务配置及管理员共享服务区。
- `src/client/lib/ai-settings.ts`：前端三态更新请求构造与可测试的表单规则。
- `test/secrets.test.ts`：加密、AAD、错误主密钥与不确定性测试。
- `test/user-ai-settings.test.ts`：解析优先级、提供商白名单和密文失败策略。
- `test/user-ai-settings-migration.test.ts`：完整迁移链和约束测试。
- `test/client-ai-settings.test.ts`：前端请求构造纯函数测试。

**Modified files**

- `src/worker/env.ts`、`wrangler.test.jsonc`、`test/worker/env.d.ts`：注入测试/运行时加密 Secret。
- `src/worker/lib/settings.ts`：增加共享兜底设置键，明确现有 resolver 只解析站点共享配置。
- `src/worker/chat/vision.ts`：导出受支持个人视觉服务的固定 URL/默认模型映射，并使用面向个人配置的错误文案。
- `src/worker/chat/routes.ts`、`src/worker/mistakes/routes.ts`、`src/worker/auth/routes.ts`：改用用户级 resolver。
- `src/worker/admin/routes.ts`：把现有 Key 接口语义改为站点共享配置并增加兜底开关。
- `src/worker/index.ts`：挂载登录用户 AI 设置接口。
- `src/client/App.tsx`、`src/client/components/Layout.tsx`：新增独立 AI 服务页和导航入口。
- `src/client/pages/SettingsPage.tsx`：移除 AI 配置，只保留账号及站点管理。
- `src/client/types.ts`：增加个人/共享 AI 设置和来源类型。
- `src/client/styles/global.css`：独立 AI 设置页的状态、按钮和响应式样式。
- `test/worker/routes.test.ts`：真实 D1 下的权限隔离、调用来源和清除配置覆盖。
- `test/settings.test.ts`、`test/vision.test.ts`：共享配置命名和个人视觉 provider 映射。
- `test/chemistry-migration.test.ts`：把 `0009` 纳入既有“全新数据库完整迁移链”门禁。
- `README.md`、`docs/TECHNICAL.md`、`docs/DEPLOY.md`：产品使用、安全模型和发布顺序。

---

### Task 1: 用户级表结构与 AES-GCM 基础设施

**Files:**
- Create: `migrations/0009_user_ai_settings.sql`
- Create: `src/worker/lib/secrets.ts`
- Modify: `src/worker/env.ts`
- Modify: `wrangler.test.jsonc`
- Create: `test/secrets.test.ts`
- Create: `test/user-ai-settings-migration.test.ts`
- Modify: `test/chemistry-migration.test.ts`

**Interfaces:**
- Produces: `EncryptedSecret`、`encryptSecret(masterKeyBase64, plaintext, aad)`、`decryptSecret(masterKeyBase64, encrypted, aad)`。
- Produces: `user_ai_settings` 表；Task 2 依赖其列名和约束。

- [ ] **Step 1: 写 migration 失败测试**

在 `test/user-ai-settings-migration.test.ts` 使用项目现有 SQLite/migration 测试方式，断言完整迁移后存在以下结构与约束：

```ts
expect(columns).toEqual(expect.arrayContaining([
  'user_id',
  'deepseek_key_ciphertext',
  'deepseek_key_iv',
  'deepseek_key_tail',
  'vision_key_ciphertext',
  'vision_key_iv',
  'vision_key_tail',
  'vision_provider',
  'vision_model',
  'encryption_version',
  'updated_at',
]));

expect(await setting('shared_ai_fallback_enabled')).toBe('1');
await expect(insertSetting({ visionProvider: 'attacker-url' })).rejects.toThrow();
await expect(insertHalfEncryptedDeepseekKey()).rejects.toThrow();
```

同时在 `test/chemistry-migration.test.ts` 的 `MIGRATIONS` 数组末尾追加：

```ts
'0009_user_ai_settings.sql',
```

- [ ] **Step 2: 写加密失败测试**

在 `test/secrets.test.ts` 固定使用 32 字节测试主密钥，不使用真实生产值：

```ts
const masterKey = btoa('0123456789abcdef0123456789abcdef');

it('AES-GCM 可往返且相同明文每次产生不同密文', async () => {
  const first = await encryptSecret(masterKey, 'sk-personal', 'user-ai:v1:1:deepseek');
  const second = await encryptSecret(masterKey, 'sk-personal', 'user-ai:v1:1:deepseek');
  expect(first).not.toEqual(second);
  expect(await decryptSecret(masterKey, first, 'user-ai:v1:1:deepseek')).toBe('sk-personal');
});

it('密文不能换用户或换服务解密', async () => {
  const encrypted = await encryptSecret(masterKey, 'secret', 'user-ai:v1:1:deepseek');
  await expect(decryptSecret(masterKey, encrypted, 'user-ai:v1:2:deepseek')).rejects.toThrow();
  await expect(decryptSecret(masterKey, encrypted, 'user-ai:v1:1:vision')).rejects.toThrow();
});

it.each(['', btoa('too-short')])('拒绝非 32 字节主密钥', async (invalid) => {
  await expect(encryptSecret(invalid, 'secret', 'aad')).rejects.toThrow('32 字节');
});
```

- [ ] **Step 3: 运行聚焦测试并确认 RED**

Run: `npm run test:unit -- test/secrets.test.ts test/user-ai-settings-migration.test.ts`

Expected: FAIL，原因分别为模块/迁移尚不存在。

- [ ] **Step 4: 新增 D1 migration**

`migrations/0009_user_ai_settings.sql` 使用以下完整 schema；共享兜底初始为 `1` 只用于平滑迁移：

```sql
CREATE TABLE user_ai_settings (
  user_id INTEGER PRIMARY KEY,
  deepseek_key_ciphertext TEXT,
  deepseek_key_iv TEXT,
  deepseek_key_tail TEXT NOT NULL DEFAULT '',
  vision_key_ciphertext TEXT,
  vision_key_iv TEXT,
  vision_key_tail TEXT NOT NULL DEFAULT '',
  vision_provider TEXT NOT NULL DEFAULT 'zhipu'
    CHECK (vision_provider IN ('zhipu', 'dashscope')),
  vision_model TEXT NOT NULL DEFAULT '',
  encryption_version INTEGER NOT NULL DEFAULT 1
    CHECK (encryption_version = 1),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (
    (deepseek_key_ciphertext IS NULL AND deepseek_key_iv IS NULL AND deepseek_key_tail = '') OR
    (deepseek_key_ciphertext IS NOT NULL AND deepseek_key_iv IS NOT NULL AND deepseek_key_tail <> '')
  ),
  CHECK (
    (vision_key_ciphertext IS NULL AND vision_key_iv IS NULL AND vision_key_tail = '') OR
    (vision_key_ciphertext IS NOT NULL AND vision_key_iv IS NOT NULL AND vision_key_tail <> '')
  )
);

INSERT INTO app_settings (key, value, updated_at)
VALUES ('shared_ai_fallback_enabled', '1', datetime('now'))
ON CONFLICT(key) DO NOTHING;
```

- [ ] **Step 5: 实现独立加密模块**

`src/worker/lib/secrets.ts` 只接受 Base64 编码的 32 字节主密钥，使用 12 字节随机 IV 与调用者提供的 AAD：

```ts
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importMasterKey(value: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw new Error('AI 设置加密主密钥必须是 Base64 编码的 32 字节值');
  }
  if (bytes.byteLength !== 32) throw new Error('AI 设置加密主密钥必须是 32 字节');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(
  masterKeyBase64: string,
  plaintext: string,
  aad: string,
): Promise<EncryptedSecret> {
  const key = await importMasterKey(masterKeyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      additionalData: encoder.encode(aad) as BufferSource,
    },
    key,
    encoder.encode(plaintext) as BufferSource,
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decryptSecret(
  masterKeyBase64: string,
  encrypted: EncryptedSecret,
  aad: string,
): Promise<string> {
  const key = await importMasterKey(masterKeyBase64);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(encrypted.iv) as BufferSource,
      additionalData: encoder.encode(aad) as BufferSource,
    },
    key,
    base64ToBytes(encrypted.ciphertext) as BufferSource,
  );
  return decoder.decode(plaintext);
}
```

- [ ] **Step 6: 增加环境类型和固定测试 binding**

在 `src/worker/env.ts` 增加：

```ts
/** Base64 编码的 32 字节 AES-GCM 主密钥，只能通过 Worker Secret 注入。 */
AI_SETTINGS_ENCRYPTION_KEY?: string;
```

在 `wrangler.test.jsonc` 增加非生产测试值：

```jsonc
"vars": {
  "AI_SETTINGS_ENCRYPTION_KEY": "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
}
```

- [ ] **Step 7: 运行 migration、加密和完整基础测试**

Run: `npm run test:unit -- test/secrets.test.ts test/user-ai-settings-migration.test.ts`

Expected: PASS，测试中不得输出明文 Key。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add migrations/0009_user_ai_settings.sql src/worker/lib/secrets.ts src/worker/env.ts wrangler.test.jsonc test/secrets.test.ts test/user-ai-settings-migration.test.ts test/chemistry-migration.test.ts
git commit -m "feat: add encrypted user AI settings storage"
```

---

### Task 2: 用户设置领域模型与个人/共享解析策略

**Files:**
- Create: `src/worker/lib/user-ai-settings.ts`
- Modify: `src/worker/lib/settings.ts`
- Modify: `src/worker/chat/vision.ts`
- Create: `test/user-ai-settings.test.ts`
- Modify: `test/settings.test.ts`
- Modify: `test/vision.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `encryptSecret()`、`decryptSecret()` 和 `user_ai_settings` schema。
- Produces: `AIConfigSource`、`UserAISettingsStatus`、`UserAISettingsPatch`、`getUserAISettingsStatus()`、`saveUserAISettings()`、`resolveUserAIConfig()`。
- Produces: `getPersonalVisionConfig(provider, key, model)`；Task 5 的 OCR 路由使用它。

- [ ] **Step 1: 写解析优先级与 fail-closed 测试**

`test/user-ai-settings.test.ts` 至少覆盖以下行为：

```ts
expect((await resolveUserAIConfig(db, env, userA)).deepseekSource).toBe('personal');
expect((await resolveUserAIConfig(db, env, userA)).deepseekKey).toBe('sk-user-a');
expect((await resolveUserAIConfig(db, env, userB)).deepseekSource).toBe('shared');

await setSetting(db, SETTING_KEYS.sharedAIFallbackEnabled, '0');
expect((await resolveUserAIConfig(db, env, userB)).deepseekSource).toBe('none');

await corruptPersonalCiphertext(db, userA);
await expect(resolveUserAIConfig(db, env, userA)).rejects.toThrow('个人 AI 配置无法读取');
```

同时覆盖：

```ts
expect(getPersonalVisionConfig('zhipu', 'vk', '')).toMatchObject({
  url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  model: 'glm-4.1v-thinking-flash',
});
expect(getPersonalVisionConfig('dashscope', 'vk', '')).toMatchObject({
  url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  model: 'qwen-vl-plus',
});
```

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run: `npm run test:unit -- test/user-ai-settings.test.ts test/settings.test.ts test/vision.test.ts`

Expected: FAIL，新 resolver、共享开关和个人视觉 provider 尚不存在。

- [ ] **Step 3: 明确共享配置接口**

在 `src/worker/lib/settings.ts` 增加：

```ts
sharedAIFallbackEnabled: 'shared_ai_fallback_enabled',
```

保留 `getSettings()`、`setSetting()` 与现有 `mergeAIConfig()`，但增加注释说明它只解析管理员共享 D1 配置和 Worker 环境变量；用户请求不得直接调用它作为最终配置。

- [ ] **Step 4: 增加受控个人视觉 provider**

在 `src/worker/chat/vision.ts` 导出固定映射：

```ts
export type PersonalVisionProvider = 'zhipu' | 'dashscope';

const PERSONAL_VISION_PROVIDERS: Record<
  PersonalVisionProvider,
  { url: string; defaultModel: string }
> = {
  zhipu: {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defaultModel: 'glm-4.1v-thinking-flash',
  },
  dashscope: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defaultModel: 'qwen-vl-plus',
  },
};

export function getPersonalVisionConfig(
  provider: PersonalVisionProvider,
  apiKey: string,
  model: string,
): VisionConfig | null {
  if (!apiKey) return null;
  const selected = PERSONAL_VISION_PROVIDERS[provider];
  return { apiKey, url: selected.url, model: model || selected.defaultModel };
}
```

- [ ] **Step 5: 实现用户设置类型、状态读取和保存**

`src/worker/lib/user-ai-settings.ts` 固定公开以下接口：

```ts
export type AIConfigSource = 'personal' | 'shared' | 'none';

export interface UserAISettingsPatch {
  deepseekApiKey?: string | null;
  visionApiKey?: string | null;
  visionProvider?: PersonalVisionProvider;
  visionModel?: string;
}

export interface UserAISettingsStatus {
  personal: {
    deepseekKeySet: boolean;
    deepseekKeyTail: string;
    visionKeySet: boolean;
    visionKeyTail: string;
    visionProvider: PersonalVisionProvider;
    visionModel: string;
  };
  sharedFallbackEnabled: boolean;
  effective: {
    deepseekConfigured: boolean;
    deepseekSource: AIConfigSource;
    visionEnabled: boolean;
    visionSource: AIConfigSource;
  };
}

export interface ResolvedUserAIConfig {
  deepseekKey: string;
  vision: VisionConfig | null;
  deepseekSource: AIConfigSource;
  visionSource: AIConfigSource;
}
```

保存规则不得采用“先读整行、再整行覆盖”，否则两个并发局部保存会互相丢字段。实现时先为用户 `INSERT ... ON CONFLICT DO NOTHING`，再动态生成只包含 patch 已出现字段的 `UPDATE`，两条语句放进同一个 `db.batch()`；`null` 把对应 ciphertext、IV、tail 一起清空，字符串先加密再写，视觉 provider/model 可独立修改。AAD 由唯一函数生成：

```ts
function secretAAD(userId: number, service: 'deepseek' | 'vision'): string {
  return `user-ai:v1:${userId}:${service}`;
}
```

`resolveUserAIConfig()` 必须按以下顺序落地，禁止字段级混搭个人和共享视觉配置：

```ts
const personal = await readPersonalRow(db, userId);
const resolvedSettings = appSettings ?? await getSettings(db);
const shared = mergeAIConfig(resolvedSettings, env);
const fallbackEnabled = resolvedSettings[SETTING_KEYS.sharedAIFallbackEnabled] === '1';

const personalDeepseek = await decryptPresentKey(personal, 'deepseek');
const personalVision = await decryptPresentKey(personal, 'vision');

return {
  deepseekKey: personalDeepseek || (fallbackEnabled ? shared.deepseekKey : ''),
  deepseekSource: personalDeepseek ? 'personal' : fallbackEnabled && shared.deepseekKey ? 'shared' : 'none',
  vision: personalVision
    ? getPersonalVisionConfig(personal.vision_provider, personalVision, personal.vision_model)
    : fallbackEnabled
      ? shared.vision
      : null,
  visionSource: personalVision ? 'personal' : fallbackEnabled && shared.vision ? 'shared' : 'none',
};
```

实现时只查询一次 `app_settings`；若调用者已在聊天路由读取，允许通过可选参数传入。解密异常统一转换为：

```ts
throw new UserFacingError('个人 AI 配置无法读取，请在「AI 服务」页重新保存 Key', 503);
```

- [ ] **Step 6: 运行解析测试并确认 GREEN**

Run: `npm run test:unit -- test/user-ai-settings.test.ts test/settings.test.ts test/vision.test.ts`

Expected: PASS；断言个人配置不泄漏到其他 userId，共享关闭后来源为 `none`。

- [ ] **Step 7: 提交**

```bash
git add src/worker/lib/user-ai-settings.ts src/worker/lib/settings.ts src/worker/chat/vision.ts test/user-ai-settings.test.ts test/settings.test.ts test/vision.test.ts
git commit -m "feat: resolve personal AI credentials before shared fallback"
```

---

### Task 3: 登录用户 AI 设置 API 与权限隔离

**Files:**
- Create: `src/worker/settings/routes.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/worker/routes.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `getUserAISettingsStatus()` 与 `saveUserAISettings()`。
- Produces: `GET /api/ai-settings`、`PUT /api/ai-settings`。

- [ ] **Step 1: 写真实 Worker/D1 路由失败测试**

在 `test/worker/routes.test.ts` 新增“用户 AI 设置”分组，覆盖：

```ts
it('未登录不能读取或修改 AI 设置', async () => {
  expect((await api('/api/ai-settings')).status).toBe(401);
  expect((await api('/api/ai-settings', { method: 'PUT', body: '{}' })).status).toBe(401);
});

it('两名用户只能看到和修改自己的 Key 状态', async () => {
  await putAISettings(userA.cookie, { deepseekApiKey: 'sk-user-a' });
  await putAISettings(userB.cookie, { deepseekApiKey: 'sk-user-b' });
  expect(await getAISettings(userA.cookie)).toMatchObject({
    personal: { deepseekKeySet: true, deepseekKeyTail: 'er-a' },
  });
  expect(JSON.stringify(await getAISettings(userA.cookie))).not.toContain('sk-user-a');
  expect(JSON.stringify(await getAISettings(userA.cookie))).not.toContain('sk-user-b');
});

it('null 清除、字段省略保留、空字符串拒绝', async () => {
  await putAISettings(userA.cookie, {
    deepseekApiKey: 'sk-user-a',
    visionApiKey: 'vision-user-a',
  });
  await putAISettings(userA.cookie, { deepseekApiKey: null });
  expect(await getAISettings(userA.cookie)).toMatchObject({
    personal: { deepseekKeySet: false, visionKeySet: true },
  });
  expect((await putAISettingsRaw(userA.cookie, { visionApiKey: '' })).status).toBe(400);
});
```

另直接查询 D1，断言 `user_ai_settings` 不包含 `sk-user-a` 或 `vision-user-a` 明文。

- [ ] **Step 2: 运行 Worker 测试并确认 RED**

Run: `npm run test:worker -- test/worker/routes.test.ts`

Expected: FAIL，接口返回 404。

- [ ] **Step 3: 实现 Zod 三态输入与用户路由**

`src/worker/settings/routes.ts` 的输入 schema 固定为：

```ts
const keyValue = z.string().trim().min(1).max(500).nullable();

const userAISettingsSchema = z
  .object({
    deepseekApiKey: keyValue.optional(),
    visionApiKey: keyValue.optional(),
    visionProvider: z.enum(['zhipu', 'dashscope']).optional(),
    visionModel: z.string().trim().max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '没有需要保存的配置');
```

路由只从 session 的 `c.get('user').id` 取 owner，不接收 body/query 中的 userId：

```ts
export const userAISettingsRoutes = new Hono<AppContext>();
userAISettingsRoutes.use('*', requireAuth);

userAISettingsRoutes.get('/', async (c) => {
  return ok(c, await getUserAISettingsStatus(c.env.DB, c.env, c.get('user').id));
});

userAISettingsRoutes.put('/', async (c) => {
  const parsed = userAISettingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法');
  if (!c.env.AI_SETTINGS_ENCRYPTION_KEY) return err(c, '服务器尚未配置 AI 设置加密服务', 503);
  await saveUserAISettings(c.env.DB, c.env.AI_SETTINGS_ENCRYPTION_KEY, c.get('user').id, parsed.data);
  return ok(c, await getUserAISettingsStatus(c.env.DB, c.env, c.get('user').id));
});
```

- [ ] **Step 4: 挂载路由**

在 `src/worker/index.ts` 增加：

```ts
import { userAISettingsRoutes } from './settings/routes';
app.route('/api/ai-settings', userAISettingsRoutes);
```

鉴权只在该子路由执行一次，不再在 index 重复挂同一中间件。

- [ ] **Step 5: 运行权限与存储测试**

Run: `npm run test:worker -- test/worker/routes.test.ts`

Expected: PASS；D1 中只出现密文/IV/尾号，跨账户读取不存在入口。

- [ ] **Step 6: 提交**

```bash
git add src/worker/settings/routes.ts src/worker/index.ts test/worker/routes.test.ts
git commit -m "feat: expose isolated personal AI settings API"
```

---

### Task 4: 管理员共享服务与兜底开关

**Files:**
- Modify: `src/worker/admin/routes.ts`
- Modify: `src/worker/lib/settings.ts`
- Modify: `test/worker/routes.test.ts`

**Interfaces:**
- Consumes: `SETTING_KEYS.sharedAIFallbackEnabled`。
- Produces: 管理员设置响应的 `sharedFallbackEnabled`；PUT 接受同名 boolean。

- [ ] **Step 1: 写管理员开关权限和同值更新测试**

```ts
it('只有管理员能启停站点共享兜底', async () => {
  expect((await api('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({ sharedFallbackEnabled: false }),
  }, member.cookie)).status).toBe(403);

  const first = await putAdminSettings(admin.cookie, { sharedFallbackEnabled: false });
  const second = await putAdminSettings(admin.cookie, { sharedFallbackEnabled: false });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect((await getAdminSettings(admin.cookie)).sharedFallbackEnabled).toBe(false);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm run test:worker -- test/worker/routes.test.ts`

Expected: FAIL，管理员 schema 尚未接受 `sharedFallbackEnabled`。

- [ ] **Step 3: 扩展管理员设置 contract**

在 `settingsSchema` 增加：

```ts
sharedFallbackEnabled: z.boolean().optional(),
```

GET 响应增加：

```ts
sharedFallbackEnabled: settings[SETTING_KEYS.sharedAIFallbackEnabled] === '1',
```

PUT 使用现有 `setSetting()` 持久化：

```ts
if (sharedFallbackEnabled !== undefined) {
  await setSetting(
    c.env.DB,
    SETTING_KEYS.sharedAIFallbackEnabled,
    sharedFallbackEnabled ? '1' : '0',
  );
}
```

现有 `deepseekKeySet` 等字段在后端暂不改名，减少 API churn；前端 Task 6 用文案明确它们代表“共享服务”。

- [ ] **Step 4: 运行测试并提交**

Run: `npm run test:worker -- test/worker/routes.test.ts`

Expected: PASS。

```bash
git add src/worker/admin/routes.ts src/worker/lib/settings.ts test/worker/routes.test.ts
git commit -m "feat: add explicit shared AI fallback control"
```

---

### Task 5: 全部 AI 调用链切换到账户级配置

**Files:**
- Modify: `src/worker/chat/routes.ts`
- Modify: `src/worker/mistakes/routes.ts`
- Modify: `src/worker/auth/routes.ts`
- Modify: `src/worker/chat/deepseek.ts`
- Modify: `src/worker/chat/vision.ts`
- Modify: `test/worker/routes.test.ts`
- Modify: `test/deepseek.test.ts`
- Modify: `test/vision.test.ts`

**Interfaces:**
- Consumes: `resolveUserAIConfig(db, env, userId, appSettings?)`。
- Produces: `/api/auth/me` 中稳定的 `aiConfigured`、`aiSource`、`visionEnabled`、`visionSource`。

- [ ] **Step 1: 写调用来源失败测试**

真实 Worker 测试至少覆盖四条路径：

```ts
it('聊天优先发送个人 DeepSeek Key', async () => {
  await setSharedDeepseek('sk-shared');
  await putAISettings(user.cookie, { deepseekApiKey: 'sk-personal' });
  await sendChat(user.cookie, conversation.id, '题目');
  expect(upstream).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-personal' }) }),
  );
});

it('关闭共享兜底后无个人 Key 不扣额度也不落消息', async () => {
  await setSharedFallback(false);
  const response = await sendChat(user.cookie, conversation.id, '题目');
  expect(await response.text()).toContain('请先在「AI 服务」页配置');
  expect(await usageCount(user.id)).toBe(0);
  expect(await messageCount(conversation.id)).toBe(0);
});

it('OCR 使用个人视觉 Key 和白名单 provider URL', async () => {
  await putAISettings(user.cookie, {
    visionApiKey: 'vision-personal',
    visionProvider: 'dashscope',
  });
  await sendOCR(user.cookie, conversation.id, fixtureImage);
  expect(upstream.mock.calls[0]?.[0]).toBe(
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  );
});

it('错题提取使用会话所属账户的个人 Key', async () => {
  await extractMistake(user.cookie, conversation.id);
  expect(upstreamAuthorization()).toBe('Bearer sk-personal');
});
```

再断言 `/api/auth/me` 在保存、清除个人视觉 Key 和启停共享兜底后返回正确 source。

- [ ] **Step 2: 运行 Worker 测试并确认 RED**

Run: `npm run test:worker -- test/worker/routes.test.ts`

Expected: FAIL；当前调用仍使用全站 `mergeAIConfig()`/`resolveAIConfig()`。

- [ ] **Step 3: 改造聊天与后台后处理**

在 `src/worker/chat/routes.ts`，聊天占用会话 lease 后只读取一次全局设置：

```ts
const appSettings = await getSettings(db);
const aiConfig = await resolveUserAIConfig(db, c.env, user.id, appSettings);
const apiKey = aiConfig.deepseekKey;
```

后续 `streamChat()`、`processSelfLearnMessage()`、`maybeRefineProfile()` 都继续使用这一个 `apiKey`，保证本次请求内来源一致；不得在 `waitUntil` 中重新解析成另一用户或另一来源。未配置时在扣额度、写 user message、改标题之前返回：

```ts
await sendError('请先在「AI 服务」页配置 DeepSeek API Key');
```

- [ ] **Step 4: 改造 OCR、错题提取与当前用户状态**

OCR：

```ts
const config = (await resolveUserAIConfig(c.env.DB, c.env, user.id)).vision;
if (!config) return err(c, '请先在「AI 服务」页配置图片识别服务', 501);
```

错题提取：

```ts
const { deepseekKey } = await resolveUserAIConfig(c.env.DB, c.env, user.id);
if (!deepseekKey) return err(c, '请先在「AI 服务」页配置 DeepSeek API Key', 501);
```

`/api/auth/me` 返回：

```ts
const status = await getUserAISettingsStatus(c.env.DB, c.env, user.id);
return ok(c, {
  id: user.id,
  email: user.email,
  isAdmin: !!user.is_admin,
  aiConfigured: status.effective.deepseekConfigured,
  aiSource: status.effective.deepseekSource,
  visionEnabled: status.effective.visionEnabled,
  visionSource: status.effective.visionSource,
});
```

- [ ] **Step 5: 修正上游鉴权错误文案**

DeepSeek 与视觉服务无法知道本次 Key 来源时，不再一律写“联系管理员”，统一改成：

```ts
'DeepSeek API Key 无效，请在「AI 服务」页检查当前配置'
'DeepSeek 账户余额不足，请检查当前生效 Key 对应的账户余额'
'图片识别服务 Key 无效，请在「AI 服务」页检查当前配置'
```

- [ ] **Step 6: 运行 AI 调用链与完整后端测试**

Run: `npm run test:unit -- test/deepseek.test.ts test/vision.test.ts test/user-ai-settings.test.ts`

Run: `npm run test:worker -- test/worker/routes.test.ts`

Expected: PASS；测试同时证明个人 Key 不会串号、共享关闭不产生额度或消息副作用。

- [ ] **Step 7: 提交**

```bash
git add src/worker/chat/routes.ts src/worker/mistakes/routes.ts src/worker/auth/routes.ts src/worker/chat/deepseek.ts src/worker/chat/vision.ts test/worker/routes.test.ts test/deepseek.test.ts test/vision.test.ts
git commit -m "feat: use account AI credentials across model calls"
```

---

### Task 6: 独立 AI 服务页与管理员设置瘦身

**Files:**
- Create: `src/client/lib/ai-settings.ts`
- Create: `src/client/pages/AISettingsPage.tsx`
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/Layout.tsx`
- Modify: `src/client/types.ts`
- Modify: `src/client/styles/global.css`
- Create: `test/client-ai-settings.test.ts`

**Interfaces:**
- Consumes: `GET/PUT /api/ai-settings`、管理员 `GET/PUT /api/admin/settings`。
- Produces: `/ai-settings` 页面、`buildAISettingsPatch()`、新的 `User` AI 来源字段。

- [ ] **Step 1: 写三态表单请求失败测试**

`src/client/lib/ai-settings.ts` 的目标接口：

```ts
export interface AIKeyDraft {
  deepseekInput: string;
  visionInput: string;
  visionProvider: 'zhipu' | 'dashscope';
  visionModel: string;
  clearDeepseek: boolean;
  clearVision: boolean;
}

export function buildAISettingsPatch(draft: AIKeyDraft): Record<string, string | null>;
```

测试：

```ts
expect(buildAISettingsPatch({
  deepseekInput: '', visionInput: '', visionProvider: 'zhipu', visionModel: '',
  clearDeepseek: false, clearVision: false,
})).toEqual({ visionProvider: 'zhipu', visionModel: '' });

expect(buildAISettingsPatch({
  deepseekInput: ' sk-new ', visionInput: '', visionProvider: 'dashscope', visionModel: ' qwen-vl-plus ',
  clearDeepseek: false, clearVision: true,
})).toEqual({
  deepseekApiKey: 'sk-new',
  visionApiKey: null,
  visionProvider: 'dashscope',
  visionModel: 'qwen-vl-plus',
});
```

- [ ] **Step 2: 运行前端聚焦测试并确认 RED**

Run: `npm run test:unit -- test/client-ai-settings.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 增加客户端类型和请求构造函数**

在 `src/client/types.ts` 增加：

```ts
export type AIConfigSource = 'personal' | 'shared' | 'none';

export interface UserAISettings {
  personal: {
    deepseekKeySet: boolean;
    deepseekKeyTail: string;
    visionKeySet: boolean;
    visionKeyTail: string;
    visionProvider: 'zhipu' | 'dashscope';
    visionModel: string;
  };
  sharedFallbackEnabled: boolean;
  effective: {
    deepseekConfigured: boolean;
    deepseekSource: AIConfigSource;
    visionEnabled: boolean;
    visionSource: AIConfigSource;
  };
}
```

`User` 增加必填字段：

```ts
aiConfigured: boolean;
aiSource: AIConfigSource;
visionEnabled: boolean;
visionSource: AIConfigSource;
```

`AdminSettings` 增加 `sharedFallbackEnabled: boolean`。

- [ ] **Step 4: 实现 `/ai-settings` 页面**

`AISettingsPage.tsx` 首次加载总是请求 `/api/ai-settings`；管理员额外并行请求 `/api/admin/settings`。页面结构固定为：

```ts
function sourceBadge(source: AIConfigSource): JSX.Element {
  const label = source === 'personal' ? '使用个人配置' : source === 'shared' ? '使用站点共享' : '未配置';
  const className = source === 'none' ? 'badge badge-danger' : 'badge badge-success';
  return <span className={className}>{label}</span>;
}

interface SharedAIFieldsProps {
  settings: AdminSettings | null;
  deepseekKey: string;
  visionKey: string;
  visionUrl: string;
  visionModel: string;
  profileInterval: string;
  profileDailyLimit: string;
  disabled: boolean;
  onChange: (field: 'deepseekKey' | 'visionKey' | 'visionUrl' | 'visionModel' | 'profileInterval' | 'profileDailyLimit', value: string) => void;
}
```

```tsx
<div className="page">
  <div className="page-header"><h1>AI 服务</h1></div>

  <section className="card settings-card" aria-labelledby="personal-ai-title">
    <h2 id="personal-ai-title" className="section-title">我的 AI 服务</h2>
    <p className="form-hint">
      同一账户下的所有学生共用这些 Key。对话、错题提取、自学处理和学习画像可能消耗 DeepSeek 额度。
    </p>
    <div className="key-row">
      <div className="key-row-head">
        <strong>DeepSeek API Key</strong>
        {sourceBadge(personalSettings.effective.deepseekSource)}
      </div>
      <input
        type="password"
        value={deepseekInput}
        onChange={(event) => setDeepseekInput(event.target.value)}
        placeholder="sk-…（留空表示不修改）"
        autoComplete="off"
      />
      {personalSettings.personal.deepseekKeySet && (
        <button className="btn btn-danger-ghost" disabled={savingPersonal} onClick={clearPersonalDeepseek}>
          清除个人 DeepSeek Key
        </button>
      )}
    </div>
    <div className="key-row">
      <div className="key-row-head">
        <strong>图片识别服务</strong>
        {sourceBadge(personalSettings.effective.visionSource)}
      </div>
      <input
        type="password"
        value={visionInput}
        onChange={(event) => setVisionInput(event.target.value)}
        placeholder="视觉服务 Key（留空表示不修改）"
        autoComplete="off"
      />
      <select value={visionProvider} onChange={(event) => setVisionProvider(event.target.value as 'zhipu' | 'dashscope')}>
        <option value="zhipu">智谱</option>
        <option value="dashscope">阿里云百炼</option>
      </select>
      <input
        value={visionModel}
        onChange={(event) => setVisionModel(event.target.value)}
        placeholder={visionProvider === 'zhipu' ? 'glm-4.1v-thinking-flash' : 'qwen-vl-plus'}
      />
      {personalSettings.personal.visionKeySet && (
        <button className="btn btn-danger-ghost" disabled={savingPersonal} onClick={clearPersonalVision}>
          清除个人视觉 Key
        </button>
      )}
    </div>
    <button className="btn btn-primary" disabled={savingPersonal} onClick={savePersonal}>
      {savingPersonal ? '保存中…' : '保存我的配置'}
    </button>
  </section>

  {user?.isAdmin && (
    <section className="card settings-card" aria-labelledby="shared-ai-title">
      <h2 id="shared-ai-title" className="section-title">站点共享 AI 服务</h2>
      <p className="form-hint">仅在开启共享兜底且用户没有相应个人 Key 时使用。</p>
      <SharedAIFields
        settings={adminSettings}
        deepseekKey={sharedDeepseekInput}
        visionKey={sharedVisionInput}
        visionUrl={sharedVisionUrl}
        visionModel={sharedVisionModel}
        profileInterval={profileInterval}
        profileDailyLimit={profileDailyLimit}
        disabled={savingShared}
        onChange={updateSharedDraft}
      />
      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={sharedFallbackEnabled}
          onChange={(event) => setSharedFallbackEnabled(event.target.checked)}
        />
        允许未配置个人 Key 的用户使用站点共享服务
      </label>
      <button className="btn btn-primary" disabled={savingShared} onClick={saveShared}>
        {savingShared ? '保存中…' : '保存站点配置'}
      </button>
    </section>
  )}
</div>
```

`SharedAIFields` 定义在同一文件中，props 就是上述参数；其 JSX 从当前 `SettingsPage.tsx` 的“AI 服务配置”卡片原样搬迁 DeepSeek、视觉 URL/模型、画像间隔和画像每日上限字段，只把标题和按钮移交给父页面，不改变现有取值范围或帮助链接。

具体交互规则：

- Key 输入框 `type="password"`、`autoComplete="off"`，加载后保持空白，只显示“已配置（尾号 xxxx）”。
- 保存个人配置成功后清空 Key 输入，使用 PUT 返回值更新状态，并 `await refresh()` 刷新 AuthContext。
- 清除按钮不依赖空输入，明确发送对应 `null`；请求期间保存/清除按钮全部 disabled，防止竞态覆盖。
- 管理员共享配置沿用现有保存逻辑；共享开关与 Key/画像字段在同一次 PUT 提交。
- badge 文案分别为“使用个人配置”“使用站点共享”“未配置”，不得只显示模糊的“可用”。
- 页面错误使用现有 `ApiError` 文案，成功使用 `role="status"` toast。

- [ ] **Step 5: 注册独立路由与导航**

在 `src/client/App.tsx` 懒加载并注册：

```tsx
const AISettingsPage = lazy(() => import('./pages/AISettingsPage'));

<Route
  path="/ai-settings"
  element={
    <RequireAuth>
      <Layout><AISettingsPage /></Layout>
    </RequireAuth>
  }
/>
```

在 `Layout.tsx` 的设置入口前增加所有登录用户可见的“AI 服务”；移动端和桌面端复用同一导航数组，不复制权限判断。

- [ ] **Step 6: 瘦身原设置页**

从 `SettingsPage.tsx` 删除 AI Key、视觉 URL/模型、画像提炼状态和保存函数；`loadAdmin()` 只并行加载：

```ts
const [inviteData, userData] = await Promise.all([
  apiGet<InviteCode[]>('/api/admin/invite-codes'),
  apiGet<AdminUser[]>('/api/admin/users'),
]);
```

最终 `/settings` 对普通用户显示账号与退出，对管理员额外显示邀请码和用户管理；所有 AI 相关配置只出现在 `/ai-settings`。

- [ ] **Step 7: 增加响应式和状态样式**

复用 `.settings-card`、`.key-row`、`.badge`，只新增页面确实需要的类：

```css
.settings-toggle-row {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
}

.settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
```

窄屏下按钮保持最小触控高度，不把 Key 状态和操作挤到同一行。

- [ ] **Step 8: 运行前端测试、类型检查和构建**

Run: `npm run test:unit -- test/client-ai-settings.test.ts test/client-ui.test.ts`

Run: `npm run typecheck && npm run build`

Expected: PASS；Vite 继续保持路由级懒加载，入口 chunk 不重新吸入 Markdown/KaTeX 大包。

- [ ] **Step 9: 本地手工验收**

Run: `npm run dev:worker`

依次验证：普通用户可见“AI 服务”导航但看不到共享区；管理员同时看到个人与共享区；保存后聊天页立即出现/隐藏拍照按钮；浏览器 Network 响应中搜不到完整测试 Key；刷新页面后输入框为空而尾号状态仍在。

- [ ] **Step 10: 提交**

```bash
git add src/client/lib/ai-settings.ts src/client/pages/AISettingsPage.tsx src/client/pages/SettingsPage.tsx src/client/App.tsx src/client/components/Layout.tsx src/client/types.ts src/client/styles/global.css test/client-ai-settings.test.ts
git commit -m "feat: add standalone personal AI service settings"
```

---

### Task 7: 产品、技术与部署文档

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `docs/TECHNICAL.md`
- Modify: `docs/DEPLOY.md`

**Interfaces:**
- Consumes: Tasks 1–6 的最终 UI、Secret 名和发布顺序。
- Produces: 用户可执行的 Key 配置说明和维护者可执行的上线 runbook。

- [ ] **Step 1: 更新产品 README**

README 的产品使用流程改成：

```md
1. 登录后先进入「AI 服务」。
2. 填写自己的 DeepSeek API Key；需要拍照识题时再填写视觉服务 Key。
3. 创建学生并选择学科或自学模式开始使用。
```

明确说明同一账户下学生共用 Key、Key 保存后不回显、普通用户无法看到他人的配置，以及“站点共享”只在管理员开启时生效。README 只链接技术文档，不展开 AES、D1 schema 或部署命令。

- [ ] **Step 2: 更新技术文档**

`docs/TECHNICAL.md` 的“配置与密钥”必须记录：

```text
个人密文（user_ai_settings）
  → 若存在，按 user_id 解密并使用
  → 若不存在且 shared_ai_fallback_enabled = 1，读取 app_settings / Worker Secret
  → 否则返回未配置
```

补充 AES-256-GCM、AAD、主密钥丢失影响、禁止日志记录、普通视觉 provider 白名单，以及日限额和画像后台调用仍会消耗当前用户生效 Key。

- [ ] **Step 3: 更新部署 runbook**

`docs/DEPLOY.md` 增加首次发布命令：

```bash
# 只生成一次，先复制输出并保存到密码管理器
openssl rand -base64 32

# 将密码管理器中的同一个值粘贴到 Wrangler 提示中
npx wrangler secret put AI_SETTINGS_ENCRYPTION_KEY

mkdir -p backups
chmod 700 backups
npx wrangler d1 export daoxue-db --remote --output backups/pre-user-ai-settings.sql
chmod 600 backups/pre-user-ai-settings.sql
npx wrangler d1 migrations apply daoxue-db --remote
npm run deploy
```

同时把 `backups/` 加入 `.gitignore`，避免生产 D1 导出文件进入 Git。

部署后检查：管理员进入“AI 服务”，确认共享兜底仍为开启；用测试普通账户保存个人 Key 并完成一次聊天/OCR；逐个用户完成配置后关闭共享兜底。回滚说明必须写明：旧代码会忽略共享开关并恢复全局 Key 行为，`0009` 表保留不影响旧代码；只要表内仍有个人密文就不得删除或覆盖 `AI_SETTINGS_ENCRYPTION_KEY`。

- [ ] **Step 4: 检查文档一致性并提交**

Run: `rg -n "管理员.*API Key|管理员未配置|AI 服务配置|app_settings.*Key" README.md docs src/client src/worker`

Expected: 只剩明确描述“站点共享配置”的文字；普通用户错误文案不再要求联系管理员配置个人 Key。

```bash
git add .gitignore README.md docs/TECHNICAL.md docs/DEPLOY.md
git commit -m "docs: explain personal AI keys and secure rollout"
```

---

### Task 8: 全量验证与生产发布门禁

**Files:**
- Modify only if verification exposes a defect in files already listed above.

**Interfaces:**
- Consumes: Tasks 1–7 的全部提交。
- Produces: 可部署且具备明确回滚条件的版本。

- [ ] **Step 1: 新鲜运行完整自动化门禁**

Run: `git diff --check`

Run: `npm test`

Run: `npm run build`

Run: `npm audit --omit=dev`

Run: `npx wrangler deploy --dry-run --outdir .wrangler/dry-run`

Expected: 全部退出码为 0；单元测试、真实 Worker/D1 测试、三套 TypeScript 检查和 Vite 构建全部通过。

- [ ] **Step 2: 做安全回归检查**

Run: `rg -n "AI_SETTINGS_ENCRYPTION_KEY|deepseekApiKey|visionApiKey|ciphertext|Authorization" src test README.md docs`

逐项确认：

- 生产 Secret 没有字面值；唯一固定主密钥只在测试配置。
- GET/PUT 响应对象没有 ciphertext、IV、完整 Key 字段。
- `console.*` 不打印请求 body、解密值或 Authorization header。
- 普通用户输入没有进入任意 fetch URL。
- 所有模型调用都经 `resolveUserAIConfig()` 或使用同一请求已解析的 `apiKey`。

- [ ] **Step 3: 本地双账户冒烟**

使用管理员 A 与普通用户 B：A 配个人 `sk-a`，B 配个人 `sk-b`；分别创建会话并检查上游测试桩收到正确 Authorization；清除 B 的 Key，在共享开启时确认 B 使用共享，在关闭后确认 B 被引导至 AI 服务页且不扣额度。删除 B 用户后确认 `user_ai_settings` 通过外键级联删除。

- [ ] **Step 4: 生产前停点**

在任何远程写入前确认以下三项都有明确结果：

```text
AI_SETTINGS_ENCRYPTION_KEY 已写入 Cloudflare 且另有安全备份
D1 远程备份文件已生成且路径明确
管理员知道迁移后共享兜底初始为开启，不会立刻影响现有用户
```

如果任一项未满足，停止，不执行 remote migration 或 deploy。

- [ ] **Step 5: 应用迁移并发布**

Run: `npx wrangler d1 migrations apply daoxue-db --remote`

Expected: 只新增并应用 `0009_user_ai_settings.sql`。

Run: `npm run deploy`

Expected: 发布成功并输出新的 Worker Version ID。

- [ ] **Step 6: 线上验收**

在 `https://xue.aipojing.xyz` 验证管理员与普通用户两种身份；查看 Worker 日志确认无解密错误且无 Key 内容；完成个人 DeepSeek 对话和个人视觉 OCR；最后按实际迁移进度决定是否关闭共享兜底，不在发布脚本中自动关闭。

- [ ] **Step 7: 提交验证中产生的必要修正**

若 Step 1–6 没有产生代码修正，不创建空提交；若有修正，先用 `git status --short` 列出本轮实际变更，再逐个写出明确路径执行 `git add`，最后提交：

```bash
git commit -m "fix: close user AI settings verification gaps"
```

---

## Acceptance Criteria

- 普通登录用户能进入独立“AI 服务”页，保存、替换和清除自己的 DeepSeek/视觉 Key。
- 管理员也通过“我的 AI 服务”配置自己的 Key，并能在同页维护站点共享服务和共享兜底开关。
- 用户 A 的读取、聊天、OCR、错题提取、自学和画像流程不会使用用户 B 的 Key。
- 个人 Key 存在时不使用共享 Key；个人 Key 不存在且共享关闭时不调用模型、不扣额度、不写聊天消息。
- 个人密文损坏或主密钥不匹配时 fail closed，不产生共享费用。
- 普通用户无法配置任意视觉 URL；所有个人视觉请求只发送到白名单 provider。
- API、HTML、日志和前端状态均不出现完整 Key、密文、IV 或加密主密钥。
- 保存/清除后 `/api/auth/me` 和聊天页能力立即同步。
- 现有用户在迁移发布时仍可通过初始开启的共享兜底继续使用，管理员可在完成迁移后切换到严格 BYOK。
- `npm test`、`npm run build`、`npm audit --omit=dev` 和 Wrangler dry-run 全部通过。
