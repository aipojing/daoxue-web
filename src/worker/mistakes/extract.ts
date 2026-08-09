import { z } from 'zod';

export const EXTRACT_INSTRUCTION = [
  '你是一名错题整理助手。请从上面这段辅导对话中，提取一张最有复习价值的错题卡。',
  '',
  '要求：',
  '1. 只收录学生真实出错、且有复习价值的题目；如果对话中学生没有出错，或错误没有复习价值，输出 {"no_mistake": true}。',
  '2. 否则输出以下 JSON（所有字段都用简体中文，值为纯文本）：',
  '{',
  '  "title": "题目内容（简洁概括，含关键数据）",',
  '  "knowledge_point": "涉及的知识点",',
  '  "my_answer": "学生的原答案或原过程",',
  '  "key_error": "第一处关键错误",',
  '  "error_tags": ["错因标签，1-2个"],',
  '  "correct_steps": "正确的关键步骤",',
  '  "reminder": "一句话提醒",',
  '  "retest_question": "一道同类复测题（改数字或换表达）"',
  '}',
].join('\n');

const cardSchema = z.object({
  title: z.string().trim().min(1).max(500),
  knowledge_point: z.string().trim().max(200).default(''),
  my_answer: z.string().trim().max(1000).default(''),
  key_error: z.string().trim().max(500).default(''),
  error_tags: z.array(z.string().trim().max(30)).max(5).default([]),
  correct_steps: z.string().trim().max(2000).default(''),
  reminder: z.string().trim().max(200).default(''),
  retest_question: z.string().trim().max(1000).default(''),
});

export type MistakeCardData = z.infer<typeof cardSchema>;

export type ParseResult = { card: MistakeCardData } | { noMistake: true } | { error: string };

export function parseMistakeCard(raw: string): ParseResult {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) text = fenceMatch[1];

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'AI 返回的错题卡格式无法解析' };
  }

  if (typeof json === 'object' && json !== null && (json as { no_mistake?: unknown }).no_mistake === true) {
    return { noMistake: true };
  }

  const parsed = cardSchema.safeParse(json);
  if (!parsed.success) return { error: 'AI 返回的错题卡缺少必要字段' };
  return { card: parsed.data };
}
