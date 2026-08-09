# 化学解题辅导接入设计

## 目标

把化学作为第五个完整学科接入解题辅导，使其与数学、语文、物理、英语具有相同的会话、筛选、学习画像和错题本能力，并使用化学专属导学提示词。

## 范围

本次包含：

- 在解题辅导入口和会话侧栏提供“化学”新会话入口。
- 在解题辅导会话筛选、学习画像和错题本筛选中支持化学。
- 为化学会话加载独立的系统提示词和首次对话说明。
- 在 Worker 与前端的严格学科枚举中加入 `chemistry`。
- 迁移 D1 数据库中的学科 `CHECK` 约束，同时完整保留已有数据和外键关联。
- 更新 README 中关于学科数量和提示词文件的说明。

本次不包含：

- 修改自学陪伴支持的开放学习方向。
- 为化学增加独立 API、独立页面或特殊消息协议。
- 部署 Worker 或对远程 D1 数据库执行迁移。
- 重构现有学科枚举为共享包或新增可配置学科目录。

## 产品行为

化学与四个已有学科保持同等地位：

- 学生可从解题辅导页创建化学会话。
- 化学会话显示名称“化学”和独立主题色。
- 会话侧栏可新建和筛选化学会话。
- 系统可提炼、展示和编辑化学学习画像。
- 化学会话中的回答可存入错题本，错题列表可按化学筛选。
- 化学首次对话提示学生提供年级、完整题目、已有过程、卡点和所需模式。

## AI 提示词

新增 `prompts/chemistry.md`，以用户提供的《化学题解导学系统提示词.md》为内容依据。提示词必须保留以下约束：

- 面向初中、高中学生，不在默认模式下一上来公布答案。
- 同时检查三重一致、先化学后计算、守恒和证据约束。
- 支持 `hint`、`guided`、`review`、`full_solution`、`similar_training` 五种模式。
- 执行信息检查、题型识别、化学分析、作答诊断、定位首个关键卡点、最小干预、验证、迁移与记录八步链路。
- 在 `hint` 和 `guided` 模式中每次只推进一步并等待学生回应。
- 检查化学式、方程式、反应条件、物质状态、单位、有效数字和限定词。
- 对离子方程式、氧化还原和实验题应用对应的专项检查及安全边界。

Worker 的提示词加载方式沿用现有 `getBasePrompt(subject)` 接口，不为化学增加分支路由。

## 应用结构

### Worker

`src/worker/chat/prompt-builder.ts` 的 `SUBJECTS`、`Subject` 和 `SUBJECT_NAMES` 加入 `chemistry`。现有的会话创建校验、画像提炼和错题保存逻辑继续通过 `isSubject` 自动获得化学支持。

`src/worker/chat/prompts.ts` 导入化学 Markdown，并将其加入严格的 `Record<Subject, string>` 映射，保证新增枚举但遗漏提示词时类型检查失败。

### 前端

`src/client/types.ts` 的学科类型、数组、名称和颜色加入化学。所有使用 `SUBJECTS.map(...)` 的入口、筛选和画像界面因此自动出现化学。

`src/client/pages/ChatPage.tsx` 增加化学首次对话文案。会话详情、侧栏标记和错题卡继续使用现有通用映射。

## 数据迁移

现有 D1 表在 `conversations`、`mistake_cards` 和 `student_profiles` 上使用严格学科 `CHECK` 约束。新增 `migrations/0004_add_chemistry_subject.sql`，把允许值扩展为：

- `conversations.subject`：`math`、`chinese`、`physics`、`english`、`chemistry`、`selflearn`。
- `mistake_cards.subject`：`math`、`chinese`、`physics`、`english`、`chemistry`、`selflearn`。
- `student_profiles.subject`：`math`、`chinese`、`physics`、`english`、`chemistry`。

Cloudflare D1 始终启用外键，且延迟外键检查不会阻止 `ON DELETE CASCADE`。迁移采用“备份数据、按依赖顺序重建、恢复数据”的方式：

1. 启用 `PRAGMA defer_foreign_keys = on`。
2. 把 `conversations`、`messages`、`mistake_cards`、`student_profiles`、`lesson_outputs` 和 `daily_reports` 的现有行复制到临时备份表。
3. 先删除引用 `conversations` 的子表，再删除 `conversations` 和 `student_profiles`。
4. 使用原有列、默认值、外键和约束重建各表，仅扩展三个学科白名单。
5. 先恢复父表，再恢复子表，保留全部主键、时间戳和关联 ID。
6. 重建随表删除的索引，删除临时备份表，并恢复即时外键检查。

迁移中任何语句或最终外键检查失败时，D1 的迁移事务应整体失败，不留下半迁移状态。

## 错误处理与兼容性

- API 对未知学科继续返回“学科不合法”，化学通过同一校验路径。
- 已有四学科和自学会话的存储值、显示名称及行为不变。
- 所有历史主键保持不变，避免消息、错题和学习输出失去所属会话。
- 不修改已应用的 `0001`—`0003` 迁移，只新增向前迁移。
- 不自动执行远程迁移或部署；上线时由维护者按部署文档操作。

## 测试与验收

采用测试先行：

1. 更新学科枚举测试，先观察其因缺少 `chemistry` 失败。
2. 增加提示词加载测试，验证化学提示词包含角色、核心视角、模式、默认输出格式和实验安全边界。
3. 增加迁移测试：在仅应用 `0001`—`0003` 的 SQLite 数据库中写入历史会话、消息、错题、画像、每课输出和每日报告，再应用 `0004`。
4. 迁移后验证所有历史数据及关联 ID 完整，外键检查无异常，三个目标表可写入 `chemistry`，并继续拒绝非法学科。
5. 运行全量 Vitest、TypeScript 类型检查和 Vite 生产构建。

验收标准：用户能在所有解题辅导相关界面选择或筛选化学；化学会话使用专属提示词；现有数据迁移后无丢失；合法与非法学科都按严格白名单处理；项目测试、类型检查和构建全部通过。
