# 化学解题辅导接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把化学作为第五个完整学科接入解题辅导，并通过严格 D1 白名单迁移保留全部历史数据。

**Architecture:** 沿用现有 `Subject` 枚举驱动的通用会话、筛选、画像和错题流程，只增加 `chemistry` 枚举值、显示元数据与独立 Markdown 提示词。数据库通过一个向前迁移备份并重建所有受 `conversations` 外键影响的表，避免 D1 在删除父表时触发级联数据丢失。

**Tech Stack:** TypeScript、React 18、Hono、Cloudflare Workers/D1、SQLite、Vitest、Vite

## Global Constraints

- 化学存储代码固定为 `chemistry`，显示名称固定为“化学”，主题色固定为 `#7b4f8c`。
- `conversations` 与 `mistake_cards` 只允许五个学科代码加 `selflearn`；`student_profiles` 只允许五个学科代码。
- 化学提示词以 `/Users/ahs/Desktop/学习/化学题解导学系统提示词.md` 为唯一内容来源，保留其中全部导学规则。
- 不修改已经发布的 `migrations/0001_init.sql`、`0002_app_settings.sql`、`0003_login_failures.sql`。
- 迁移必须保留所有历史主键、时间戳、会话关联和表索引。
- 不执行远程 D1 迁移，不部署 Worker。

---

## File Map

- Create: `prompts/chemistry.md` — 化学专属系统提示词。
- Create: `test/client-subjects.test.ts` — 前端学科枚举与显示元数据测试。
- Create: `test/chemistry-migration.test.ts` — 带历史数据的 SQLite 迁移回归测试。
- Create: `migrations/0004_add_chemistry_subject.sql` — D1 严格白名单迁移。
- Modify: `test/prompts.test.ts` — Worker 枚举、校验和提示词加载测试。
- Modify: `src/worker/chat/prompt-builder.ts` — Worker 学科枚举与中文名。
- Modify: `src/worker/chat/prompts.ts` — 化学提示词导入和映射。
- Modify: `src/client/types.ts` — 前端学科枚举、中文名和主题色。
- Modify: `src/client/pages/ChatPage.tsx` — 化学首次对话说明。
- Modify: `README.md` — 五学科能力及提示词目录说明。

### Task 1: Worker 学科模型与化学提示词

**Files:**
- Create: `prompts/chemistry.md`
- Modify: `test/prompts.test.ts`
- Modify: `src/worker/chat/prompt-builder.ts`
- Modify: `src/worker/chat/prompts.ts`

**Interfaces:**
- Produces: `Subject` 新增 `'chemistry'`；`SUBJECT_NAMES.chemistry === '化学'`；`getBasePrompt('chemistry'): string`。
- Consumes: 用户提供的 `/Users/ahs/Desktop/学习/化学题解导学系统提示词.md`。

- [ ] **Step 1: 写 Worker 失败测试**

把 `test/prompts.test.ts` 的导入和学科测试改为：

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSystemPrompt, isSubject, SUBJECTS, SUBJECT_NAMES } from '../src/worker/chat/prompt-builder';
import { getBasePrompt } from '../src/worker/chat/prompts';

// 保留现有 buildSystemPrompt 测试。

describe('subjects', () => {
  it('学科枚举与名称一致', () => {
    expect(SUBJECTS).toEqual(['math', 'chinese', 'physics', 'english', 'chemistry']);
    expect(SUBJECT_NAMES.math).toBe('数学');
    expect(SUBJECT_NAMES.english).toBe('英语');
    expect(SUBJECT_NAMES.chemistry).toBe('化学');
  });

  it('isSubject 校验', () => {
    expect(isSubject('math')).toBe(true);
    expect(isSubject('physics')).toBe(true);
    expect(isSubject('chemistry')).toBe(true);
    expect(isSubject('biology')).toBe(false);
    expect(isSubject('')).toBe(false);
  });

  it('化学提示词包含关键导学约束', () => {
    expect(getBasePrompt('chemistry')).toBeTruthy();
    const prompt = readFileSync(new URL('../prompts/chemistry.md', import.meta.url), 'utf8');
    expect(prompt).toContain('校内化学题解导学系统');
    expect(prompt).toContain('三重一致');
    expect(prompt).toContain('先化学、后计算');
    expect(prompt).toContain('第一个关键卡点');
    expect(prompt).toContain('hint');
    expect(prompt).toContain('guided');
    expect(prompt).toContain('full_solution');
    expect(prompt).toContain('【当前只需要完成的一步】');
    expect(prompt).toContain('危险、有毒、强腐蚀或产生有害气体');
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run test/prompts.test.ts`

Expected: FAIL，明确显示 `SUBJECTS` 缺少 `chemistry`、`SUBJECT_NAMES.chemistry` 不存在或 `getBasePrompt('chemistry')` 无法通过类型/运行校验。

- [ ] **Step 3: 加入 Worker 枚举和提示词映射**

把 `src/worker/chat/prompt-builder.ts` 的学科声明更新为：

```ts
export const SUBJECTS = ['math', 'chinese', 'physics', 'english', 'chemistry'] as const;
export type Subject = (typeof SUBJECTS)[number];

export const SUBJECT_NAMES: Record<Subject, string> = {
  math: '数学',
  chinese: '语文',
  physics: '物理',
  english: '英语',
  chemistry: '化学',
};
```

在 `src/worker/chat/prompts.ts` 中增加：

```ts
import chemistryPrompt from '../../../prompts/chemistry.md';
```

并把映射更新为：

```ts
const BASE_PROMPTS: Record<Subject, string> = {
  math: mathPrompt,
  chinese: chinesePrompt,
  physics: physicsPrompt,
  english: englishPrompt,
  chemistry: chemistryPrompt,
};
```

- [ ] **Step 4: 创建化学提示词**

使用 `apply_patch` 创建 `prompts/chemistry.md`，内容逐段采用 `/Users/ahs/Desktop/学习/化学题解导学系统提示词.md` 从标题 `# 校内化学题解导学系统提示词` 到末尾核心原则的完整文本，不删减五种模式、八步链路、默认输出格式、表达检查、首次对话和实验安全边界。

创建后执行内容一致性校验：

```bash
cmp prompts/chemistry.md '/Users/ahs/Desktop/学习/化学题解导学系统提示词.md'
```

Expected: exit 0，无输出。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run: `npx vitest run test/prompts.test.ts`

Expected: PASS，`test/prompts.test.ts` 全部通过。

- [ ] **Step 6: 提交 Worker 与提示词改动**

```bash
git add test/prompts.test.ts src/worker/chat/prompt-builder.ts src/worker/chat/prompts.ts prompts/chemistry.md
git commit -m "feat: add chemistry tutoring prompt"
```

### Task 2: 前端化学入口、筛选与学习画像

**Files:**
- Create: `test/client-subjects.test.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/pages/ChatPage.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: `chemistry` 学科代码和“化学”名称。
- Produces: 前端 `Subject` 支持化学，所有基于 `SUBJECTS` 的入口/筛选/画像自动显示化学，并提供化学首次对话文案。

- [ ] **Step 1: 写前端学科失败测试**

创建 `test/client-subjects.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { SUBJECTS, SUBJECT_NAMES, SUBJECT_COLORS, isSubject } from '../src/client/types';

describe('client subjects', () => {
  it('将化学作为第五个完整学科', () => {
    expect(SUBJECTS).toEqual(['math', 'chinese', 'physics', 'english', 'chemistry']);
    expect(SUBJECT_NAMES.chemistry).toBe('化学');
    expect(SUBJECT_COLORS.chemistry).toBe('#7b4f8c');
    expect(isSubject('chemistry')).toBe(true);
  });

  it('继续拒绝未知学科和自学代码', () => {
    expect(isSubject('biology')).toBe(false);
    expect(isSubject('selflearn')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run test/client-subjects.test.ts`

Expected: FAIL，显示数组缺少 `chemistry` 或化学名称/颜色未定义。

- [ ] **Step 3: 更新前端严格枚举与显示元数据**

把 `src/client/types.ts` 的对应声明更新为：

```ts
export type Subject = 'math' | 'chinese' | 'physics' | 'english' | 'chemistry';

export const SUBJECTS: Subject[] = ['math', 'chinese', 'physics', 'english', 'chemistry'];

export const SUBJECT_NAMES: Record<Subject, string> = {
  math: '数学',
  chinese: '语文',
  physics: '物理',
  english: '英语',
  chemistry: '化学',
};

export const SUBJECT_COLORS: Record<Subject, string> = {
  math: '#33648f',
  chinese: '#b8432f',
  physics: '#3a7d5c',
  english: '#b0782a',
  chemistry: '#7b4f8c',
};
```

- [ ] **Step 4: 增加化学首次对话文案**

在 `src/client/pages/ChatPage.tsx` 的 `SUBJECT_INTROS` 中加入：

```ts
chemistry:
  '请告诉我：1. 年级；2. 化学题目或清晰图片；3. 你已经写出的过程；4. 你认为卡住的位置；5. 希望使用的模式：提示、分步导学、批改复盘或完整讲解。未选择模式时，我会根据现有信息采用批改复盘或分步导学。',
```

- [ ] **Step 5: 更新 README**

把解题辅导说明改为：

```md
基于五套学科提示词（数学 / 语文 / 物理 / 英语 / 化学）的分步导学。
```

把提示词目录说明改为：

```text
math/chinese/physics/english/chemistry.md   五套学科题解导学提示词
```

- [ ] **Step 6: 运行测试、类型检查并确认 GREEN**

Run: `npx vitest run test/client-subjects.test.ts && npm run typecheck`

Expected: PASS；前端与 Worker 类型检查均无错误，所有 `Record<Subject, ...>` 均覆盖化学。

- [ ] **Step 7: 提交前端与文档改动**

```bash
git add test/client-subjects.test.ts src/client/types.ts src/client/pages/ChatPage.tsx README.md
git commit -m "feat: expose chemistry tutoring across the UI"
```

### Task 3: 严格白名单数据迁移

**Files:**
- Create: `test/chemistry-migration.test.ts`
- Create: `migrations/0004_add_chemistry_subject.sql`

**Interfaces:**
- Consumes: `0001`—`0003` 创建的现有 D1 schema。
- Produces: 保留原数据的 schema；`conversations`/`mistake_cards` 接受 `chemistry` 和 `selflearn`；`student_profiles` 接受 `chemistry`；三表均拒绝未知值。

- [ ] **Step 1: 写迁移失败测试**

创建 `test/chemistry-migration.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tempDirs: string[] = [];

function runSql(dbPath: string, sql: string): string {
  const result = spawnSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function queryJson<T>(dbPath: string, sql: string): T[] {
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim() ? (JSON.parse(result.stdout) as T[]) : [];
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('0004_add_chemistry_subject migration', () => {
  it('保留历史关联数据并扩展严格学科白名单', () => {
    const migrationPath = join(repoRoot, 'migrations/0004_add_chemistry_subject.sql');
    expect(existsSync(migrationPath)).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'daoxue-chemistry-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'test.sqlite3');
    const initialSchema = ['0001_init.sql', '0002_app_settings.sql', '0003_login_failures.sql']
      .map((name) => readFileSync(join(repoRoot, 'migrations', name), 'utf8'))
      .join('\n');
    runSql(dbPath, `PRAGMA foreign_keys = on;\n${initialSchema}`);

    runSql(
      dbPath,
      `PRAGMA foreign_keys = on;
       INSERT INTO users (id, email, password_hash) VALUES (1, 'parent@example.com', 'hash');
       INSERT INTO students (id, user_id, name, grade) VALUES (1, 1, '小明', '初三');
       INSERT INTO conversations (id, student_id, subject, title) VALUES (11, 1, 'math', '历史会话');
       INSERT INTO messages (id, conversation_id, role, content) VALUES (21, 11, 'user', '历史消息');
       INSERT INTO mistake_cards
         (id, student_id, subject, conversation_id, title, next_review_date)
         VALUES (31, 1, 'math', 11, '历史错题', '2026-08-12');
       INSERT INTO student_profiles (student_id, subject, profile_text)
         VALUES (1, 'math', '历史画像');
       INSERT INTO lesson_outputs
         (id, student_id, conversation_id, direction, content, next_instruction)
         VALUES (41, 1, 11, '数学', '历史每课输出', '继续复测');
       INSERT INTO daily_reports
         (id, student_id, conversation_id, report_date, content)
         VALUES (51, 1, 11, '2026-08-09', '历史每日报告');`,
    );

    const migration = readFileSync(migrationPath, 'utf8');
    runSql(dbPath, `PRAGMA foreign_keys = on;\n${migration}`);

    const preserved = queryJson<{
      conversations: number;
      messages: number;
      mistakes: number;
      profiles: number;
      lessons: number;
      reports: number;
    }>(
      dbPath,
      `SELECT
         (SELECT COUNT(*) FROM conversations WHERE id = 11 AND title = '历史会话') AS conversations,
         (SELECT COUNT(*) FROM messages WHERE id = 21 AND conversation_id = 11) AS messages,
         (SELECT COUNT(*) FROM mistake_cards WHERE id = 31 AND conversation_id = 11) AS mistakes,
         (SELECT COUNT(*) FROM student_profiles WHERE student_id = 1 AND profile_text = '历史画像') AS profiles,
         (SELECT COUNT(*) FROM lesson_outputs WHERE id = 41 AND conversation_id = 11) AS lessons,
         (SELECT COUNT(*) FROM daily_reports WHERE id = 51 AND conversation_id = 11) AS reports;`,
    );
    expect(preserved[0]).toEqual({
      conversations: 1,
      messages: 1,
      mistakes: 1,
      profiles: 1,
      lessons: 1,
      reports: 1,
    });
    expect(queryJson(dbPath, 'PRAGMA foreign_key_check;')).toEqual([]);

    runSql(
      dbPath,
      `PRAGMA foreign_keys = on;
       INSERT INTO conversations (id, student_id, subject, title) VALUES (12, 1, 'chemistry', '化学会话');
       INSERT INTO mistake_cards
         (id, student_id, subject, conversation_id, title, next_review_date)
         VALUES (32, 1, 'chemistry', 12, '化学错题', '2026-08-13');
       INSERT INTO student_profiles (student_id, subject, profile_text)
         VALUES (1, 'chemistry', '化学画像');`,
    );

    expect(() =>
      runSql(dbPath, "INSERT INTO conversations (student_id, subject) VALUES (1, 'biology');"),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      runSql(
        dbPath,
        "INSERT INTO mistake_cards (student_id, subject, title, next_review_date) VALUES (1, 'biology', '非法', '2026-08-14');",
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      runSql(dbPath, "INSERT INTO student_profiles (student_id, subject) VALUES (1, 'biology');"),
    ).toThrow(/CHECK constraint failed/);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx vitest run test/chemistry-migration.test.ts`

Expected: FAIL at `expect(existsSync(migrationPath)).toBe(true)`，因为 `0004` 尚不存在。

- [ ] **Step 3: 创建数据迁移**

创建 `migrations/0004_add_chemistry_subject.sql`，按以下确定顺序实现：

```sql
PRAGMA defer_foreign_keys = on;

CREATE TABLE _0004_conversations AS SELECT * FROM conversations;
CREATE TABLE _0004_messages AS SELECT * FROM messages;
CREATE TABLE _0004_mistake_cards AS SELECT * FROM mistake_cards;
CREATE TABLE _0004_student_profiles AS SELECT * FROM student_profiles;
CREATE TABLE _0004_lesson_outputs AS SELECT * FROM lesson_outputs;
CREATE TABLE _0004_daily_reports AS SELECT * FROM daily_reports;

DROP TABLE messages;
DROP TABLE mistake_cards;
DROP TABLE lesson_outputs;
DROP TABLE daily_reports;
DROP TABLE conversations;
DROP TABLE student_profiles;

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english','chemistry','selflearn')),
  mode TEXT NOT NULL DEFAULT 'subject' CHECK (mode IN ('subject','selflearn-profiling','selflearn-daily')),
  title TEXT NOT NULL DEFAULT '新会话',
  deep_thinking INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  reasoning_content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mistake_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english','chemistry','selflearn')),
  direction TEXT NOT NULL DEFAULT '',
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  knowledge_point TEXT NOT NULL DEFAULT '',
  my_answer TEXT NOT NULL DEFAULT '',
  key_error TEXT NOT NULL DEFAULT '',
  error_tags TEXT NOT NULL DEFAULT '[]',
  correct_steps TEXT NOT NULL DEFAULT '',
  reminder TEXT NOT NULL DEFAULT '',
  retest_question TEXT NOT NULL DEFAULT '',
  next_review_date TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','passed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE student_profiles (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english','chemistry')),
  profile_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, subject)
);

CREATE TABLE lesson_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  next_instruction TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  report_date TEXT NOT NULL DEFAULT (date('now')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO conversations
  (id, student_id, subject, mode, title, deep_thinking, created_at, updated_at)
  SELECT id, student_id, subject, mode, title, deep_thinking, created_at, updated_at
  FROM _0004_conversations;

INSERT INTO messages
  (id, conversation_id, role, content, reasoning_content, created_at)
  SELECT id, conversation_id, role, content, reasoning_content, created_at
  FROM _0004_messages;

INSERT INTO mistake_cards
  (id, student_id, subject, direction, conversation_id, title, knowledge_point, my_answer,
   key_error, error_tags, correct_steps, reminder, retest_question, next_review_date,
   review_status, created_at)
  SELECT id, student_id, subject, direction, conversation_id, title, knowledge_point, my_answer,
         key_error, error_tags, correct_steps, reminder, retest_question, next_review_date,
         review_status, created_at
  FROM _0004_mistake_cards;

INSERT INTO student_profiles (student_id, subject, profile_text, updated_at)
  SELECT student_id, subject, profile_text, updated_at FROM _0004_student_profiles;

INSERT INTO lesson_outputs
  (id, student_id, conversation_id, direction, content, next_instruction, created_at)
  SELECT id, student_id, conversation_id, direction, content, next_instruction, created_at
  FROM _0004_lesson_outputs;

INSERT INTO daily_reports
  (id, student_id, conversation_id, report_date, content, created_at)
  SELECT id, student_id, conversation_id, report_date, content, created_at
  FROM _0004_daily_reports;

CREATE INDEX idx_conversations_student ON conversations(student_id, updated_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX idx_mistakes_student ON mistake_cards(student_id, next_review_date);
CREATE INDEX idx_lesson_outputs_student ON lesson_outputs(student_id, id DESC);
CREATE INDEX idx_daily_reports_student ON daily_reports(student_id, id DESC);

DROP TABLE _0004_messages;
DROP TABLE _0004_mistake_cards;
DROP TABLE _0004_student_profiles;
DROP TABLE _0004_lesson_outputs;
DROP TABLE _0004_daily_reports;
DROP TABLE _0004_conversations;

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = off;
```

- [ ] **Step 4: 运行迁移测试并确认 GREEN**

Run: `npx vitest run test/chemistry-migration.test.ts`

Expected: PASS；六类历史记录全部保留，`PRAGMA foreign_key_check` 返回空数组，化学写入成功，非法学科写入失败。

- [ ] **Step 5: 用 Wrangler 验证全新本地 D1**

Run: `npx wrangler d1 migrations apply daoxue-db --local`

Expected: `0004_add_chemistry_subject.sql` 成功应用；如果本地库已有迁移，只应用尚未执行的 `0004`，不连接远程数据库。

- [ ] **Step 6: 提交迁移改动**

```bash
git add test/chemistry-migration.test.ts migrations/0004_add_chemistry_subject.sql
git commit -m "feat: migrate D1 for chemistry subjects"
```

### Task 4: 全量验证与改动审查

**Files:**
- Verify only: all files changed in Tasks 1–3.

**Interfaces:**
- Consumes: 完成后的应用、提示词与迁移。
- Produces: 可交付的验证记录，不执行远程写入。

- [ ] **Step 1: 运行全量单元和迁移测试**

Run: `npm test`

Expected: 所有 Vitest 测试通过，0 failures。

- [ ] **Step 2: 运行类型检查**

Run: `npm run typecheck`

Expected: client 与 worker TypeScript 检查均通过，0 errors。

- [ ] **Step 3: 运行生产构建**

Run: `npm run build`

Expected: Vite 构建成功生成 `dist/client`，无构建错误。

- [ ] **Step 4: 检查差异质量与范围**

```bash
git diff --check HEAD~3..HEAD
git status --short
git log -6 --oneline
```

Expected: `git diff --check` 无输出；工作区无未提交源码改动；最近提交包含规格、计划和本功能的三个实现提交，除此之外只有原有历史提交。

- [ ] **Step 5: 按 verification-before-completion 技能核对证据后交付**

交付摘要必须列出：五学科 UI、化学提示词、严格白名单迁移、历史数据迁移测试，以及 `npm test`、`npm run typecheck`、`npm run build` 的新鲜结果；明确说明未执行远程迁移和部署。
