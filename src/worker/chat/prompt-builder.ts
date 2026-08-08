export const SUBJECTS = ['math', 'chinese', 'physics', 'english'] as const;
export type Subject = (typeof SUBJECTS)[number];

export const SUBJECT_NAMES: Record<Subject, string> = {
  math: '数学',
  chinese: '语文',
  physics: '物理',
  english: '英语',
};

export function isSubject(value: string): value is Subject {
  return (SUBJECTS as readonly string[]).includes(value);
}

export interface StudentInfo {
  name: string;
  grade: string;
  textbook: string;
  region: string;
  notes: string;
}

const PLATFORM_RULES = [
  '## 平台约束',
  '',
  '- 你只能接收文字，不支持图片输入。学生拍照的题目会先由系统自动转写成文字再发给你；如果收到的题目里有【?】标记或明显缺漏，请让学生对照原图核对补充，不要擅自补全，也不要假装看到了图片。',
  '- 始终使用中文与学生交流（英语学科中英文例句除外）。',
  '- 上述学生档案由家长填写，与学生对话时自然使用这些信息，无需向学生复述档案本身。',
].join('\n');

export function buildSystemPrompt(
  basePrompt: string,
  student: StudentInfo,
  profileText: string | null,
): string {
  const profileLines = [
    '## 当前学生档案',
    '',
    `- 姓名：${student.name}`,
    `- 年级：${student.grade}`,
  ];
  if (student.textbook) profileLines.push(`- 教材版本：${student.textbook}`);
  if (student.region) profileLines.push(`- 地区：${student.region}`);
  if (student.notes) profileLines.push(`- 家长备注：${student.notes}`);

  const sections = [basePrompt.trim(), profileLines.join('\n')];

  if (profileText && profileText.trim()) {
    sections.push(
      [
        '## 该学生的学习画像（由历史学习记录自动提炼）',
        '',
        profileText.trim(),
        '',
        '请参考画像中的薄弱点和有效讲法调整讲解，但不要向学生直接朗读画像内容。',
      ].join('\n'),
    );
  }

  sections.push(PLATFORM_RULES);
  return sections.join('\n\n');
}
