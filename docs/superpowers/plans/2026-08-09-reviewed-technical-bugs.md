# Confirmed Technical Bugs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复代码审查中已经复现的 DeepSeek 流式输出、图片 MIME、地区拆分、聊天自动滚动及服务端消息身份判断问题。

**Architecture:** 后端将“有最终答案”和“只有推理内容”都视为可持久化的有效流输出，同时保持真正空响应的退款行为；SSE 解析保留同一增量里的两个字段。前端使用明确的持久化标志和可测试的滚动/消息判断函数，不再借用时间字段表达消息身份。

**Tech Stack:** TypeScript、Hono、React 18、Vitest、Cloudflare Workers/D1。

## Global Constraints

- 不修改审查中已确认不成立的后台同值 UPDATE、学生 partial schema、流式卸载保护等逻辑。
- 不修改“只沟通，不改”的错题知识点回写、会话清理、密码找回、消息分页、自学摘要产品项。
- 不引入新依赖，不改变现有 API 路径、响应 envelope、数据库 schema 或严格学科白名单。
- `deepseek-reasoner` 只有 `reasoning_content` 时必须保留该消息、发送 `done`、不退款；`content` 与 `reasoning_content` 都为空时仍报错并退款。
- 同一 DeepSeek SSE delta 同时包含 `reasoning_content` 与 `content` 时必须同时保留并分别触发回调。
- 图片 Data URL 接受大小写不敏感的 `jpeg`、常见别名 `jpg`、`png`、`webp`，继续拒绝其他类型并维持大小限制。
- 用户上翻聊天记录后，流式增量不得强制滚到底部；用户回到底部或主动发送新消息后恢复自动跟随。
- 是否为服务端真实消息必须由显式状态表达，不得再通过 `created_at` 是否为空推断。
- 所有行为改动遵循 TDD：先增加失败测试并记录 RED，再写最小实现并记录 GREEN。

---

### Task 1: DeepSeek 流输出与图片 MIME

**Files:**
- Modify: `src/worker/chat/deepseek.ts:14-34`
- Modify: `src/worker/chat/routes.ts:251-376`
- Modify: `src/worker/chat/vision.ts:36-40`
- Modify: `test/deepseek.test.ts`
- Modify: `test/vision.test.ts`

**Interfaces:**
- Consumes: `ParsedDelta`、`streamChat`、`validateImageDataUrl`、现有聊天 SSE 事件。
- Produces: `parseSSELine()` 可同时返回 `{ reasoning, content }`；聊天路由可持久化 reasoning-only 消息。

- [ ] **Step 1: 为组合增量和 MIME 兼容写失败测试**

```ts
expect(
  parseSSELine('data: {"choices":[{"delta":{"reasoning_content":"思考","content":"答案"}}]}'),
).toEqual({ reasoning: '思考', content: '答案' });

expect(validateImageDataUrl('data:image/JPEG;base64,/9j/4AAQ')).toBeNull();
expect(validateImageDataUrl('data:image/JPG;base64,/9j/4AAQ')).toBeNull();
expect(validateImageDataUrl('data:image/PNG;base64,AAAA')).toBeNull();
```

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run: `npm test -- test/deepseek.test.ts test/vision.test.ts`

Expected: 组合增量只返回 reasoning，大小写/`jpg` MIME 被拒绝。

- [ ] **Step 3: 最小修改解析与 MIME 校验**

`parseSSELine()` 独立收集两个非空字段，至少有一个字段时返回同一个对象；MIME 正则改为：

```ts
/^data:image\/(?:jpe?g|png|webp);base64,/i
```

- [ ] **Step 4: 修正 reasoning-only 完成策略**

将助手持久化条件改为 `content` 或 `reasoning` 任一非空即可；只有两个字段都为空时才退款并发送“AI 未返回内容”。保存 reasoning-only 消息时 `content` 使用空字符串、`reasoning_content` 保存推理文本、正常发送 `done`。画像提炼和自学后处理仅在存在最终 `content` 时触发。

- [ ] **Step 5: 运行聚焦测试、完整测试和类型检查**

Run: `npm test -- test/deepseek.test.ts test/vision.test.ts`

Run: `npm test && npm run typecheck`

Expected: 全部通过且无新增警告。

- [ ] **Step 6: 提交**

```bash
git add src/worker/chat/deepseek.ts src/worker/chat/routes.ts src/worker/chat/vision.ts test/deepseek.test.ts test/vision.test.ts
git commit -m "fix: preserve reasoning output and accept valid image MIME"
```

---

### Task 2: 地区拆分与聊天交互状态

**Files:**
- Create: `src/client/lib/chat.ts`
- Modify: `src/client/types.ts:25-44,91-98`
- Modify: `src/client/pages/ChatPage.tsx:39-320`
- Modify: `test/client-subjects.test.ts`
- Create: `test/client-chat.test.ts`

**Interfaces:**
- Consumes: `Message`、`splitRegion()`、聊天滚动容器指标。
- Produces: `isNearBottom({scrollHeight, scrollTop, clientHeight}, threshold?)` 与 `isPersistedMessage(message)`；`Message.persisted?: boolean`。

- [ ] **Step 1: 为地区和聊天纯函数写失败测试**

```ts
expect(splitRegion('北京市')).toEqual({ province: '北京', city: '' });
expect(splitRegion('北京市朝阳区')).toEqual({ province: '北京', city: '朝阳区' });
expect(splitRegion('浙江省杭州市')).toEqual({ province: '浙江', city: '杭州市' });

expect(isNearBottom({ scrollHeight: 1000, scrollTop: 670, clientHeight: 200 })).toBe(false);
expect(isNearBottom({ scrollHeight: 1000, scrollTop: 710, clientHeight: 200 })).toBe(true);
expect(isPersistedMessage({ id: 3, persisted: true })).toBe(true);
expect(isPersistedMessage({ id: 3, persisted: false })).toBe(false);
```

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run: `npm test -- test/client-subjects.test.ts test/client-chat.test.ts`

Expected: 地区断言失败，新的聊天工具模块尚不存在。

- [ ] **Step 3: 实现地区规范化和聊天纯函数**

`splitRegion()` 在匹配省级名称后移除紧邻的 `省`、`市`、`自治区`、`特别行政区` 后缀；四个直辖市的单独 `市` 不得成为 city。`isNearBottom` 默认阈值为 120 像素；`isPersistedMessage` 只检查显式 `persisted === true`。

- [ ] **Step 4: 在 ChatPage 接入明确状态**

加载服务端历史时把消息映射为 `persisted: true`；乐观消息和手动停止生成的本地消息标为 `false`；流完成消息按 `messageId !== null` 标记。`commitStreamed` 在 content 或 reasoning 任一非空时都提交气泡。保存错题通过 `isPersistedMessage` 决定是否传 messageId。

- [ ] **Step 5: 修复响应式判断和自动滚动**

使用 `matchMedia('(max-width: 767px)')` 的 change 监听维护 `isMobile` 状态并清理监听。滚动容器 `onScroll` 用 `isNearBottom` 更新 `stickToBottomRef`；新会话加载和主动发送时设为 true；消息/流变化时只在该 ref 为 true 时滚到底部。

- [ ] **Step 6: 运行聚焦测试、完整测试和类型检查**

Run: `npm test -- test/client-subjects.test.ts test/client-chat.test.ts`

Run: `npm test && npm run typecheck`

Expected: 全部通过且无新增警告。

- [ ] **Step 7: 提交**

```bash
git add src/client/lib/chat.ts src/client/types.ts src/client/pages/ChatPage.tsx test/client-subjects.test.ts test/client-chat.test.ts
git commit -m "fix: stabilize chat scrolling and message identity"
```
