import { z } from 'zod';

const TOP_MARKERS = ['【每课输出】', '【每日家长反馈】', '【错题卡】', '【孩子学习画像摘要】'] as const;

export interface SelfLearnBlocks {
  profileSummary?: string;
  profileDraft?: string;
  lessonOutput?: string;
  dailyReport?: string;
  mistakeCards?: string[];
}

function nextTopMarkerIndex(text: string, from: number): number {
  let min = -1;
  for (const marker of TOP_MARKERS) {
    const idx = text.indexOf(marker, from);
    if (idx >= 0 && (min < 0 || idx < min)) min = idx;
  }
  return min;
}

function sliceBlock(text: string, markerIndex: number, markerLength: number): string {
  const end = nextTopMarkerIndex(text, markerIndex + markerLength);
  return text.slice(markerIndex, end < 0 ? undefined : end).trim();
}

export function detectSelfLearnBlocks(text: string): SelfLearnBlocks {
  const result: SelfLearnBlocks = {};

  const summaryIdx = text.indexOf('【孩子学习画像摘要】');
  if (summaryIdx >= 0) {
    // 画像摘要连同其后的启动建议一起保存
    result.profileSummary = text.slice(summaryIdx).trim();
  } else {
    const draftMatch = text.match(/【孩子学习画像草稿[^】]*】/);
    if (draftMatch && draftMatch.index !== undefined) {
      result.profileDraft = text.slice(draftMatch.index).trim();
    }
  }

  const lessonIdx = text.indexOf('【每课输出】');
  if (lessonIdx >= 0) {
    result.lessonOutput = sliceBlock(text, lessonIdx, '【每课输出】'.length);
  }

  const reportIdx = text.indexOf('【每日家长反馈】');
  if (reportIdx >= 0) {
    result.dailyReport = sliceBlock(text, reportIdx, '【每日家长反馈】'.length);
  }

  const cards: string[] = [];
  let cardIdx = text.indexOf('【错题卡】');
  while (cardIdx >= 0) {
    cards.push(sliceBlock(text, cardIdx, '【错题卡】'.length));
    cardIdx = text.indexOf('【错题卡】', cardIdx + '【错题卡】'.length);
  }
  if (cards.length > 0) result.mistakeCards = cards;

  return result;
}

const knowledgePointSchema = z.object({
  direction: z.string().trim().max(30).default(''),
  chain: z.string().trim().max(60).default(''),
  name: z.string().trim().min(1).max(60),
  level: z.enum(['L1', 'L2', 'L3', 'L4']),
  evidence: z.string().trim().max(300).default(''),
  needsWarmup: z.boolean().default(false),
  needsRetest: z.boolean().default(false),
  needsRebuild: z.boolean().default(false),
  canNetwork: z.boolean().default(false),
});

const extractedMistakeSchema = z.object({
  title: z.string().trim().min(1).max(500),
  knowledgePoint: z.string().trim().max(200).default(''),
  myAnswer: z.string().trim().max(1000).default(''),
  keyError: z.string().trim().max(500).default(''),
  errorTags: z.array(z.string().trim().max(30)).max(5).default([]),
  correctSteps: z.string().trim().max(2000).default(''),
  reminder: z.string().trim().max(200).default(''),
  retestQuestion: z.string().trim().max(1000).default(''),
});

export type ExtractedKnowledgePoint = z.infer<typeof knowledgePointSchema>;
export type ExtractedMistake = z.infer<typeof extractedMistakeSchema>;

export interface SelfLearnExtraction {
  direction: string;
  nextInstruction: string;
  knowledgePoints: ExtractedKnowledgePoint[];
  mistakeCards: ExtractedMistake[];
}

export function parseSelfLearnExtraction(raw: string): SelfLearnExtraction | null {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence?.[1]) text = fence[1];

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;

  const obj = json as {
    direction?: unknown;
    nextInstruction?: unknown;
    knowledgePoints?: unknown;
    mistakeCards?: unknown;
  };

  const knowledgePoints: ExtractedKnowledgePoint[] = [];
  if (Array.isArray(obj.knowledgePoints)) {
    for (const item of obj.knowledgePoints) {
      const parsed = knowledgePointSchema.safeParse(item);
      if (parsed.success) knowledgePoints.push(parsed.data);
    }
  }

  const mistakeCards: ExtractedMistake[] = [];
  if (Array.isArray(obj.mistakeCards)) {
    for (const item of obj.mistakeCards) {
      const parsed = extractedMistakeSchema.safeParse(item);
      if (parsed.success) mistakeCards.push(parsed.data);
    }
  }

  return {
    direction: typeof obj.direction === 'string' ? obj.direction.slice(0, 30) : '',
    nextInstruction: typeof obj.nextInstruction === 'string' ? obj.nextInstruction.slice(0, 500) : '',
    knowledgePoints,
    mistakeCards,
  };
}

export const EXTRACTION_INSTRUCTION = [
  '你是数据提取器。下面是"孩子自学 Agent"的一条输出，请从中提取结构化数据，输出 JSON：',
  '{',
  '  "direction": "本条记录的学习方向（如 数学/编程/写作，无法判断则空字符串）",',
  '  "nextInstruction": "调度指令中「下一次优先做什么」的内容（没有则空字符串）",',
  '  "knowledgePoints": [{"direction": "方向", "chain": "所属知识链或板块", "name": "知识点名称", "level": "L1|L2|L3|L4", "evidence": "等级依据", "needsWarmup": false, "needsRetest": false, "needsRebuild": false, "canNetwork": false}],',
  '  "mistakeCards": [{"title": "题目", "knowledgePoint": "知识点", "myAnswer": "孩子的答案", "keyError": "关键错误", "errorTags": ["错因标签"], "correctSteps": "正确关键步骤", "reminder": "一句话提醒", "retestQuestion": "复测题"}]',
  '}',
  '只提取文本中明确出现的掌握等级判定（L1-L4）和错题卡；没有的字段用空数组或空字符串，不要编造。',
].join('\n');
