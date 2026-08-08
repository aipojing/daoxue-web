export interface MemoryKnowledgePoint {
  direction: string;
  chain: string;
  name: string;
  level: string;
  needs_warmup: number;
  needs_retest: number;
  needs_rebuild: number;
  can_network: number;
}

export interface SelfLearnMemoryInput {
  profileText: string | null;
  knowledgePoints: MemoryKnowledgePoint[];
  recentInstructions: string[];
  lastDailyReport: string | null;
  pendingMistakes: Array<{ title: string; next_review_date: string }>;
}

function formatFlags(kp: MemoryKnowledgePoint): string {
  const flags: string[] = [];
  if (kp.needs_warmup) flags.push('待保温');
  if (kp.needs_retest) flags.push('待复测');
  if (kp.needs_rebuild) flags.push('需重构');
  if (kp.can_network) flags.push('可组网');
  return flags.length > 0 ? `（${flags.join('、')}）` : '';
}

export function buildSelfLearnMemory(input: SelfLearnMemoryInput): string {
  const sections: string[] = ['## 该学生的学习记忆（系统注入，最新状态）'];

  sections.push('### 孩子学习画像');
  sections.push(input.profileText?.trim() || '暂无画像记录。');

  sections.push('### 知识点掌握记录');
  if (input.knowledgePoints.length === 0) {
    sections.push('暂无知识点记录（首次学习，需要先做前置诊断，不要假设孩子已掌握任何内容）。');
  } else {
    const lines = input.knowledgePoints.map(
      (kp) =>
        `- [${kp.direction || '未分类'}] ${kp.name}${kp.chain ? `（${kp.chain}）` : ''}：${kp.level}${formatFlags(kp)}`,
    );
    sections.push(lines.join('\n'));
    const below = input.knowledgePoints.filter((kp) => kp.level === 'L1' || kp.level === 'L2');
    if (below.length > 0) {
      sections.push(`注意：以上有 ${below.length} 个知识点低于 L3，不得直接推进依赖它们的新内容。`);
    }
  }

  sections.push('### 最近的调度指令（上次学习结束时留下）');
  sections.push(
    input.recentInstructions.length > 0
      ? input.recentInstructions.map((s) => `- ${s}`).join('\n')
      : '暂无调度指令。',
  );

  if (input.lastDailyReport) {
    sections.push('### 最近一次每日家长反馈（节选）');
    sections.push(input.lastDailyReport.slice(0, 800));
  }

  sections.push('### 待复测错题');
  sections.push(
    input.pendingMistakes.length > 0
      ? input.pendingMistakes
          .slice(0, 8)
          .map((m) => `- ${m.title}（建议复测日期 ${m.next_review_date}）`)
          .join('\n')
      : '暂无待复测错题。',
  );

  return sections.join('\n\n');
}

export function buildSelfLearnSystemPrompt(
  basePrompt: string,
  student: { name: string; grade: string; notes: string },
  memory: string,
): string {
  const studentSection = [
    '## 当前学生',
    '',
    `- 姓名：${student.name}`,
    `- 年级：${student.grade}`,
  ];
  if (student.notes) studentSection.push(`- 家长备注：${student.notes}`);

  return [basePrompt.trim(), studentSection.join('\n'), memory].join('\n\n');
}
