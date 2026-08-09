# AI 服务配置归属调整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将站点共享 AI 配置移到管理员设置页，并把画像提炼间隔与每日上限改为账户级 AI 设置。

**Architecture:** `user_ai_settings` 新增两个带约束的画像策略列，个人设置 API 负责读写；`resolveUserAIConfig()` 把策略与当前账户的 Key 一次解析，聊天路由把明确的策略对象传给画像提炼。管理员设置 API 和页面只保留共享凭据与兜底开关，个人 AI 页面不再接触管理员接口。

**Tech Stack:** TypeScript、React 18、Hono、Cloudflare Workers、D1/SQLite、Zod、Vitest、Miniflare、Vite。

## Global Constraints

- 个人 Key 继续使用 AES-256-GCM 加密，完整 Key、密文和 IV 不得返回前端或写入日志。
- 个人视觉 provider 只允许 `zhipu`、`dashscope`，禁止用户提交任意 URL。
- 个人配置所有权只从 session 的 `user.id` 获取。
- 画像间隔范围为整数 1–1440，默认 10；每日上限范围为整数 0–1000，默认 0。
- 旧 `app_settings` 画像键保留但新代码停止读写，保证旧 Worker 可回滚。
- 使用 Node.js 22 执行测试、构建和 Wrangler。

---

### Task 1: D1 账户级画像策略迁移

**Files:**
- Create: `migrations/0010_user_profile_refine_settings.sql`
- Modify: `test/user-ai-settings-migration.test.ts`

**Interfaces:**
- Produces: `user_ai_settings.profile_refine_interval_minutes` 与 `profile_refine_daily_limit`。

- [ ] **Step 1: 写迁移失败测试**

把 `0010_user_profile_refine_settings.sql` 加入测试迁移链，并验证：

```ts
expect(row).toEqual({
  profile_refine_interval_minutes: 10,
  profile_refine_daily_limit: 0,
});
expect(() => runSql(dbPath,
  `UPDATE user_ai_settings SET profile_refine_interval_minutes = 0 WHERE user_id = 1;`,
)).toThrow(/CHECK constraint failed/);
```

测试还要先写入一组 0009 个人密文，再应用 0010，确认密文、IV、尾号与视觉配置原样保留；预先写入的旧 `app_settings` 画像键仍存在。

- [ ] **Step 2: 运行测试并确认因迁移文件缺失而失败**

Run:

```bash
npx vitest run --config vitest.config.ts test/user-ai-settings-migration.test.ts
```

Expected: FAIL，原因是找不到 `0010_user_profile_refine_settings.sql` 或缺少新增列。

- [ ] **Step 3: 编写最小迁移**

```sql
ALTER TABLE user_ai_settings
  ADD COLUMN profile_refine_interval_minutes INTEGER NOT NULL DEFAULT 10
  CHECK (profile_refine_interval_minutes BETWEEN 1 AND 1440);

ALTER TABLE user_ai_settings
  ADD COLUMN profile_refine_daily_limit INTEGER NOT NULL DEFAULT 0
  CHECK (profile_refine_daily_limit BETWEEN 0 AND 1000);
```

- [ ] **Step 4: 运行迁移测试至通过**

Run: 同 Step 2。

Expected: 迁移测试全部 PASS，`PRAGMA foreign_key_check` 无结果。

### Task 2: 个人设置 API 与画像运行时使用账户策略

**Files:**
- Modify: `src/worker/lib/user-ai-settings.ts`
- Modify: `src/worker/settings/routes.ts`
- Modify: `src/worker/profiles/refine.ts`
- Modify: `src/worker/chat/routes.ts`
- Modify: `test/worker/user-ai-settings.test.ts`
- Modify: `test/worker/routes.test.ts`

**Interfaces:**
- Produces: `ProfileRefineSettings`、`ResolvedUserAIConfig.profileRefine`。
- Produces: `PUT /api/ai-settings` 的两个账户级数值字段。

- [ ] **Step 1: 写账户默认值、隔离和局部更新失败测试**

在真实 D1 测试中覆盖：无行时为 10/0；用户 A 保存 20/1、用户 B 保存 60/3；仅更新 `dailyLimit` 不覆盖 interval 或 Key。

```ts
expect((await resolveUserAIConfig(env.DB, env, 1)).profileRefine).toEqual({
  intervalMinutes: 20,
  dailyLimit: 1,
});
```

路由测试提交越界值并断言 400；只保存画像策略时不要求加密主密钥。

- [ ] **Step 2: 运行 Worker 聚焦测试并确认失败**

```bash
npx vitest run --config vitest.worker.config.ts test/worker/user-ai-settings.test.ts test/worker/routes.test.ts
```

Expected: FAIL，原因是响应和解析结果缺少账户画像策略或路由拒绝新字段。

- [ ] **Step 3: 扩展个人设置模型和保存逻辑**

新增明确类型和默认值解析：

```ts
export interface ProfileRefineSettings {
  intervalMinutes: number;
  dailyLimit: number;
}

const DEFAULT_PROFILE_REFINE: ProfileRefineSettings = {
  intervalMinutes: 10,
  dailyLimit: 0,
};
```

`PersonalRow` 增加两列；`UserAISettingsPatch` 与状态响应增加两个字段；`saveUserAISettings()` 只在字段出现时生成对应 `SET`。设置路由 Zod schema 增加整数边界，并仅当请求含新的非空 Key 时检查 `AI_SETTINGS_ENCRYPTION_KEY`。

- [ ] **Step 4: 把画像提炼入口改为明确策略参数**

```ts
export async function maybeRefineProfile(
  db: D1Database,
  apiKey: string,
  studentId: number,
  subject: Subject,
  profileRefine: ProfileRefineSettings,
): Promise<void>
```

删除 `resolveRefineSettings(appSettings)`；聊天成功后传入 `aiConfig.profileRefine`。并发租约、日志预算和统计维度不变。

- [ ] **Step 5: 运行聚焦测试至通过**

Run: 同 Step 2。

Expected: 全部 PASS，两个用户策略互不影响，旧全站画像键不影响结果。

### Task 3: 收紧管理员共享设置 API

**Files:**
- Modify: `src/worker/admin/routes.ts`
- Modify: `src/worker/lib/settings.ts`
- Modify: `src/client/types.ts`
- Modify: `test/worker/routes.test.ts`

**Interfaces:**
- Produces: 只含共享凭据、视觉配置和 `sharedFallbackEnabled` 的 `AdminSettings`。

- [ ] **Step 1: 写管理员边界失败测试**

```ts
expect(adminSettings.data).not.toHaveProperty('profileRefineIntervalMinutes');
expect(adminSettings.data).not.toHaveProperty('profileRefineDailyLimit');
expect(updateWithLegacyProfileField.status).toBe(400);
```

保留普通用户访问 `/api/admin/settings` 返回 403 的断言。

- [ ] **Step 2: 运行路由测试并确认失败**

Run:

```bash
npx vitest run --config vitest.worker.config.ts test/worker/routes.test.ts
```

Expected: FAIL，当前 GET 仍返回画像字段且 PUT 会静默接受旧字段。

- [ ] **Step 3: 删除管理员画像字段并启用严格 schema**

从管理员 GET、PUT、Zod schema 与 `AdminSettings` 删除两字段；给 `settingsSchema` 增加 `.strict()`。从 `SETTING_KEYS` 删除运行时不再使用的画像键常量，数据库旧行不做删除。

- [ ] **Step 4: 运行路由与设置测试至通过**

```bash
npx vitest run --config vitest.worker.config.ts test/worker/routes.test.ts
npx vitest run --config vitest.config.ts test/settings.test.ts
```

Expected: 全部 PASS。

### Task 4: 调整个人 AI 页与管理员设置页

**Files:**
- Modify: `src/client/lib/ai-settings.ts`
- Modify: `src/client/pages/AISettingsPage.tsx`
- Modify: `src/client/pages/SettingsPage.tsx`
- Create: `src/client/components/SharedAISettingsCard.tsx`
- Modify: `src/client/types.ts`
- Modify: `test/client-ai-settings.test.ts`

**Interfaces:**
- Produces: 个人保存请求中的两个画像策略字段。
- Produces: 只在管理员设置页渲染的 `SharedAISettingsCard`。

- [ ] **Step 1: 写个人与共享请求构造失败测试**

扩展个人草稿：

```ts
expect(buildAISettingsPatch({
  ...draft,
  profileRefineIntervalMinutes: 30,
  profileRefineDailyLimit: 2,
})).toMatchObject({
  profileRefineIntervalMinutes: 30,
  profileRefineDailyLimit: 2,
});
```

为共享请求增加纯函数测试，确认只发送共享 Key、视觉 URL/模型和兜底开关，结果中不存在任何 `profileRefine*` 字段。

- [ ] **Step 2: 运行客户端聚焦测试并确认失败**

```bash
npx vitest run --config vitest.config.ts test/client-ai-settings.test.ts
```

Expected: FAIL，当前个人 patch 不包含画像策略且没有共享 patch 构造函数。

- [ ] **Step 3: 实现请求构造与前端类型**

`AIKeyDraft` 增加两个数值字段，个人 patch 返回类型允许 `number`；新增 `buildSharedAISettingsPatch()`，只接受共享字段。`UserAISettings.personal` 增加两个画像字段，`AdminSettings` 保持 Task 3 的精简结构。

- [ ] **Step 4: 重写页面归属**

`AISettingsPage` 删除 `useAuth().user.isAdmin`、`/api/admin/settings` 请求和整个共享卡片；在个人卡片内增加两个数值输入并由同一保存按钮提交。

把共享字段、加载、保存、pending 与错误处理封装进 `SharedAISettingsCard`。`SettingsPage` 只在 `isAdmin` 时渲染该组件，并把组件错误/成功反馈留在组件内，避免污染邀请码和用户管理状态。

- [ ] **Step 5: 运行聚焦测试、类型检查和构建**

```bash
npx vitest run --config vitest.config.ts test/client-ai-settings.test.ts
npm run typecheck
npm run build
```

Expected: 全部 PASS；生产 bundle 成功生成。

### Task 5: 文档、全量验证与生产发布

**Files:**
- Modify: `README.md`
- Modify: `docs/TECHNICAL.md`
- Modify: `docs/DEPLOY.md`

**Interfaces:**
- Produces: 与实际页面、权限和账户级策略一致的用户及部署文档。

- [ ] **Step 1: 更新文档**

把管理员共享配置入口改为“设置”；把画像策略描述改为账户级并说明同一账户下学生共用；移除“画像策略仍是站点级”的旧描述。

- [ ] **Step 2: 检查陈旧文案**

```bash
rg -n "画像提炼的间隔和每日上限仍是站点级|管理员在「AI 服务」页|站点共享.*画像" README.md docs src
```

Expected: 无陈旧产品说明；历史 spec/plan 可保留原始决策记录，但现行 README、TECHNICAL、DEPLOY 和源码文案必须一致。

- [ ] **Step 3: 运行完整本地门禁**

```bash
npm test
npm run build
npm audit
npx wrangler deploy --dry-run
git diff --check
```

Expected: 0 failed tests、构建成功、0 vulnerabilities、Worker dry-run 成功、无空白错误。

- [ ] **Step 4: 生产数据安全发布**

先用 `wrangler d1 export daoxue-db --remote --output backups/pre-user-profile-settings-20260810.sql` 备份并设为权限 600；若文件已存在则停止而不是覆盖。再应用 0010，验证无待迁移、列默认值与 CHECK；推送功能提交并等待 GitHub CI 成功，最后用 Node 22 执行 `wrangler deploy`。

- [ ] **Step 5: 线上验收**

验证 `/api/health` 为 200；普通会话访问 `/api/admin/settings` 为 403；个人 AI 设置响应包含 10/0；管理员页面中共享配置位于“设置”，AI 服务页只含个人配置；记录 Worker 版本和 CI 地址。
