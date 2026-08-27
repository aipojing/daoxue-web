import { z } from 'zod';
import type { CoursewareScript } from '../../shared/courseware';

const MAX_RAW_JSON_CHARS = 64 * 1024;
const MAX_JSON_DEPTH = 8;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const HTML_TAG = /<\/?[a-zA-Z!][^>]*>/;
const EXECUTABLE_CONTENT = /(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i;
const MARKDOWN_CODE = /```|`/;
const RAW_LATEX_CONTROL_SEQUENCE = /\\[a-zA-Z]+/;
const URL = /(?:https?:\/\/|www\.)/i;
const MARKDOWN_IN_SPEECH = /(?:\[[^\]]*\]\([^)]*\)|(?:^|\s)[#>*]\s|\*\*|__|~~)/m;
const FORMAL_ASSESSMENT = /(?:\bL[1-4]\b|正式(?:测评|测验)|掌握(?:等级|结论)|学习等级)/i;

function textSchema(maximum: number, field: string, options: { display?: boolean; speech?: boolean } = {}): z.ZodType<string> {
  return z.string().min(1, `${field} 不能为空`).max(maximum, `${field} 过长`).superRefine((value, context) => {
    if (CONTROL_CHARACTERS.test(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} 包含控制字符` });
    }
    if (EXECUTABLE_CONTENT.test(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} 包含可执行内容` });
    }
    if (HTML_TAG.test(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} 包含 HTML` });
    }
    if (options.display && MARKDOWN_CODE.test(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} 只能是安全的普通 Markdown 或 KaTeX` });
    }
    if (options.speech && (MARKDOWN_CODE.test(value) || RAW_LATEX_CONTROL_SEQUENCE.test(value) || URL.test(value) || MARKDOWN_IN_SPEECH.test(value) || value.includes('$'))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} 必须是自然口语文本` });
    }
  });
}

const titleSchema = textSchema(80, 'title');
const displayTextSchema = textSchema(240, 'displayMarkdown', { display: true });
const speechTextSchema = textSchema(260, 'speechText', { speech: true });
const visualPromptSchema = textSchema(300, 'visual.prompt');
const altTextSchema = textSchema(160, 'visual.altText');
const checkpointTextSchema = textSchema(240, 'checkpoint');

const alternateExplanationSchema = z.object({
  displayMarkdown: displayTextSchema,
  speechText: speechTextSchema,
}).strict();

const visualSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('formula') }).strict(),
  z.object({
    mode: z.literal('generated_image'),
    prompt: visualPromptSchema,
    altText: altTextSchema,
  }).strict(),
]);

const checkpointSchema = z.object({
  prompt: checkpointTextSchema,
  options: z.array(textSchema(120, 'checkpoint.options')).min(2).max(4),
  correctAnswer: textSchema(120, 'checkpoint.correctAnswer'),
  explanation: checkpointTextSchema,
}).strict().superRefine((checkpoint, context) => {
  if (new Set(checkpoint.options).size !== checkpoint.options.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'checkpoint options 不能重复' });
  }
  if (!checkpoint.options.includes(checkpoint.correctAnswer)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'checkpoint correctAnswer 必须在 options 中' });
  }
  if ([checkpoint.prompt, ...checkpoint.options, checkpoint.correctAnswer, checkpoint.explanation]
    .some((value) => FORMAL_ASSESSMENT.test(value))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'checkpoint 不能包含正式测评信息' });
  }
});

const segmentSchema = z.object({
  segmentKey: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  kind: z.enum([
    'teacher_intro',
    'teacher_explanation',
    'student_question',
    'student_misconception',
    'teacher_reframe',
    'checkpoint',
    'summary',
  ]),
  speaker: z.enum(['teacher', 'student', 'system']),
  title: titleSchema,
  displayMarkdown: displayTextSchema,
  speechText: speechTextSchema,
  alternateExplanation: alternateExplanationSchema.optional(),
  visual: visualSchema,
  checkpoint: checkpointSchema.optional(),
}).strict();

const scriptSchema = z.object({
  schemaVersion: z.literal(1),
  title: titleSchema,
  subject: textSchema(40, 'subject'),
  grade: textSchema(40, 'grade'),
  topic: textSchema(120, 'topic'),
  learningObjectives: z.array(textSchema(120, 'learningObjectives')).min(1).max(6),
  estimatedMinutes: z.number().int().min(1).max(60),
  segments: z.array(segmentSchema).min(7).max(30),
}).strict().superRefine((script, context) => {
  const segments = script.segments;
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first?.kind !== 'teacher_intro' || last?.kind !== 'summary') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '课件必须以 teacher_intro 开始并以 summary 结束' });
  }

  const keys = new Set<string>();
  let questionCount = 0;
  let misconceptionCount = 0;
  let checkpointCount = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (keys.has(segment.segmentKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['segments', index, 'segmentKey'], message: 'segmentKey 必须唯一' });
    }
    keys.add(segment.segmentKey);

    const speakerByKind = {
      teacher_intro: 'teacher',
      teacher_explanation: 'teacher',
      student_question: 'student',
      student_misconception: 'student',
      teacher_reframe: 'teacher',
      checkpoint: 'system',
      summary: 'teacher',
    } as const;
    if (segment.speaker !== speakerByKind[segment.kind]) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['segments', index, 'speaker'], message: 'kind 与 speaker 不兼容' });
    }

    if ((segment.kind === 'teacher_explanation' || segment.kind === 'teacher_reframe') && !segment.alternateExplanation) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['segments', index, 'alternateExplanation'], message: '核心老师讲解必须预先提供备用讲解' });
    }
    if (segment.kind === 'checkpoint') {
      checkpointCount += 1;
      if (!segment.checkpoint) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['segments', index, 'checkpoint'], message: 'checkpoint 必须有检查内容' });
      }
    } else if (segment.checkpoint) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['segments', index, 'checkpoint'], message: '只有 checkpoint 可以有检查内容' });
    }
    if (segment.kind === 'student_question') questionCount += 1;
    if (segment.kind === 'student_misconception') {
      misconceptionCount += 1;
      if (segments[index + 1]?.kind !== 'teacher_reframe') {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['segments', index], message: 'student_misconception 后必须紧接 teacher_reframe' });
      }
    }
    if (segment.kind === 'teacher_reframe' && segments[index - 1]?.kind !== 'student_misconception') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['segments', index], message: 'teacher_reframe 必须紧接 student_misconception' });
    }
  }
  if (questionCount === 0 || misconceptionCount === 0 || checkpointCount === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '课件必须包含学生提问、学生误解和课内检查' });
  }
  if (checkpointCount > 3) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '课内检查最多三项' });
  }
});

function assertSafeJsonStructure(raw: string): void {
  if (raw.length === 0 || raw.length > MAX_RAW_JSON_CHARS) throw new Error('课件 JSON 长度无效');
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < raw.length && /[\t\n\r ]/.test(raw[index]!)) index += 1;
  };
  const readString = (): string => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < raw.length) {
      const char = raw[index++]!;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        return JSON.parse(raw.slice(start, index)) as string;
      }
    }
    throw new Error('JSON 字符串未结束');
  };
  const readValue = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new Error('JSON 嵌套过深');
    skipWhitespace();
    const current = raw[index];
    if (current === '{') {
      index += 1;
      const objectKeys = new Set<string>();
      skipWhitespace();
      if (raw[index] === '}') {
        index += 1;
        return;
      }
      while (true) {
        skipWhitespace();
        if (raw[index] !== '"') throw new Error('JSON 对象键无效');
        const key = readString();
        if (objectKeys.has(key)) throw new Error('JSON 包含重复字段');
        objectKeys.add(key);
        skipWhitespace();
        if (raw[index] !== ':') throw new Error('JSON 对象缺少冒号');
        index += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (raw[index] === '}') {
          index += 1;
          return;
        }
        if (raw[index] !== ',') throw new Error('JSON 对象缺少逗号');
        index += 1;
      }
    }
    if (current === '[') {
      index += 1;
      skipWhitespace();
      if (raw[index] === ']') {
        index += 1;
        return;
      }
      while (true) {
        readValue(depth + 1);
        skipWhitespace();
        if (raw[index] === ']') {
          index += 1;
          return;
        }
        if (raw[index] !== ',') throw new Error('JSON 数组缺少逗号');
        index += 1;
      }
    }
    if (current === '"') {
      readString();
      return;
    }
    const start = index;
    while (index < raw.length && !/[\t\n\r ,\]}]/.test(raw[index]!)) index += 1;
    if (index === start) throw new Error('JSON 值无效');
  };

  readValue(1);
  skipWhitespace();
  if (index !== raw.length) throw new Error('JSON 尾部内容无效');
}

export function parseCoursewareScript(raw: string): CoursewareScript {
  assertSafeJsonStructure(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('课件脚本不是有效 JSON');
  }
  const result = scriptSchema.safeParse(parsed);
  if (!result.success) throw new Error('课件脚本不满足协议');
  return result.data as CoursewareScript;
}
