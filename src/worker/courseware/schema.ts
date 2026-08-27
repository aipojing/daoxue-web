import { z } from 'zod';
import type { CoursewareScript, CoursewareScriptSegment } from '../../shared/courseware';

const MAX_RAW_JSON_CHARS = 64 * 1024;
const MAX_JSON_DEPTH = 8;
const SAFE_PARSE_ERROR = '课件脚本无效';
export const MAX_COURSEWARE_SCRIPT_TEXT_CHARS = 18_000;

const SAFE_KATEX_COMMANDS = new Set([
  'alpha', 'beta', 'cdot', 'div', 'frac', 'ge', 'le', 'left', 'mathrm', 'neq', 'overline',
  'pm', 'prod', 'right', 'sqrt', 'sum', 'text', 'times', 'underline',
]);
const FORMAL_ASSESSMENT = /(?:\bL[1-4]\b|正式(?:测评|测验)|掌握(?:等级|结论)|学习等级)/i;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const NAMED_HTML_ENTITIES = new Map<string, string>([
  ['amp', '&'], ['apos', "'"], ['colon', ':'], ['gt', '>'], ['lt', '<'],
  ['newline', '\n'], ['quot', '"'], ['tab', '\t'],
]);
const MAX_KATEX_BRACE_DEPTH = 8;

function containsUnsafeControlOrFormat(value: string, allowLineFeeds = false): boolean {
  for (const character of value) {
    if (allowLineFeeds && character === '\n') continue;
    if (CONTROL_OR_FORMAT.test(character)) return true;
  }
  return false;
}

function decodeHtmlEntitiesOnce(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '&') {
      output += value[index];
      continue;
    }
    const end = value.indexOf(';', index + 1);
    if (end === -1 || end - index > 16) {
      output += '&';
      continue;
    }
    const entity = value.slice(index + 1, end);
    let decoded = NAMED_HTML_ENTITIES.get(entity.toLowerCase());
    if (!decoded && entity.startsWith('#')) {
      const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
      const digits = entity.slice(radix === 16 ? 2 : 1);
      if (digits.length > 0 && digits.length <= 8 && [...digits].every((character) => {
        const code = character.charCodeAt(0);
        return radix === 16
          ? (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
          : code >= 48 && code <= 57;
      })) {
        const codePoint = Number.parseInt(digits, radix);
        if (codePoint >= 0 && codePoint <= 0x10ffff) decoded = String.fromCodePoint(codePoint);
      }
    }
    if (decoded === undefined) {
      output += '&';
      continue;
    }
    output += decoded;
    index = end;
  }
  return output;
}

function decodePercentOnce(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%' || index + 2 >= value.length) {
      output += value[index];
      continue;
    }
    const digits = value.slice(index + 1, index + 3);
    if (![...digits].every((character) => {
      const code = character.charCodeAt(0);
      return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
    })) {
      output += '%';
      continue;
    }
    output += String.fromCharCode(Number.parseInt(digits, 16));
    index += 2;
  }
  return output;
}

function canonicalizeForSafetyCheck(value: string): string {
  let decoded = value;
  for (let index = 0; index < 4; index += 1) {
    const next = decodeHtmlEntitiesOnce(decodePercentOnce(decoded));
    if (next === decoded) break;
    decoded = next;
  }
  let compact = '';
  for (const character of decoded) {
    const code = character.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f || code === 0xa0 || code === 0x200b) continue;
    compact += character;
  }
  return compact.toLowerCase();
}

function hasMarkupContent(value: string): boolean {
  const canonical = canonicalizeForSafetyCheck(value);
  return canonical.includes('<')
    || canonical.includes('>');
}

function isAsciiLetter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isUriSchemeCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return isAsciiLetter(character)
    || (code >= 48 && code <= 57)
    || character === '+'
    || character === '-'
    || character === '.';
}

function hasUriScheme(value: string): boolean {
  const canonical = canonicalizeForSafetyCheck(value);
  for (let index = 0; index < canonical.length; index += 1) {
    if (!isAsciiLetter(canonical[index]!) || (index > 0 && isUriSchemeCharacter(canonical[index - 1]!))) continue;
    let end = index + 1;
    while (end < canonical.length && isUriSchemeCharacter(canonical[end]!)) end += 1;
    if (canonical[end] === ':' && end + 1 < canonical.length) return true;
    index = end;
  }
  return false;
}

function isEmailLocalCharacter(character: string): boolean {
  return isUriSchemeCharacter(character) || "!#$%&'*=/ ?^_`{|}~".replace(' ', '').includes(character);
}

function isEmailDomainCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return isAsciiLetter(character) || (code >= 48 && code <= 57) || character === '-' || character === '.';
}

function hasBareEmail(value: string): boolean {
  const canonical = canonicalizeForSafetyCheck(value);
  for (let at = 1; at < canonical.length - 2; at += 1) {
    if (canonical[at] !== '@' || !isEmailLocalCharacter(canonical[at - 1]!)) continue;
    let domainEnd = at + 1;
    while (domainEnd < canonical.length && isEmailDomainCharacter(canonical[domainEnd]!)) domainEnd += 1;
    const domain = canonical.slice(at + 1, domainEnd);
    if (domain.length > 2 && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')) return true;
  }
  return false;
}

function hasPlainTextMarkdown(value: string): boolean {
  return value.includes('`')
    || value.includes('[')
    || value.includes(']')
    || value.includes('*')
    || value.includes('_')
    || value.includes('~')
    || value.includes('\\')
    || value.includes('#');
}

function isSafePlainText(value: string): boolean {
  return !containsUnsafeControlOrFormat(value)
    && !hasMarkupContent(value)
    && !hasUriScheme(value)
    && !hasBareEmail(value)
    && !hasPlainTextMarkdown(value);
}

function isSafeSpeechText(value: string): boolean {
  return isSafePlainText(value) && !value.includes('$');
}

function isSafeKaTeX(value: string): boolean {
  if (value.length === 0 || hasMarkupContent(value) || containsUnsafeControlOrFormat(value)) return false;
  let braceDepth = 0;
  let leftDelimiterDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (!'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 +-*/=^_{}().,，。：！？'.includes(character) && character !== '\\') {
      return false;
    }
    if (character === '{') {
      braceDepth += 1;
      if (braceDepth > MAX_KATEX_BRACE_DEPTH) return false;
      continue;
    }
    if (character === '}') {
      braceDepth -= 1;
      if (braceDepth < 0) return false;
      continue;
    }
    if (character !== '\\') continue;
    const commandStart = index + 1;
    let commandEnd = commandStart;
    while (commandEnd < value.length && isAsciiLetter(value[commandEnd]!)) commandEnd += 1;
    if (commandEnd === commandStart || !SAFE_KATEX_COMMANDS.has(value.slice(commandStart, commandEnd))) return false;
    const command = value.slice(commandStart, commandEnd);
    if (command === 'left') leftDelimiterDepth += 1;
    if (command === 'right') {
      leftDelimiterDepth -= 1;
      if (leftDelimiterDepth < 0) return false;
    }
    index = commandEnd - 1;
  }
  return braceDepth === 0 && leftDelimiterDepth === 0;
}

function isSafeDisplayMarkdown(value: string): boolean {
  if (containsUnsafeControlOrFormat(value, true) || hasMarkupContent(value)) return false;
  let outsideMath = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '$') {
      outsideMath += value[index];
      continue;
    }
    const mathEnd = value.indexOf('$', index + 1);
    if (mathEnd === -1 || !isSafeKaTeX(value.slice(index + 1, mathEnd))) return false;
    index = mathEnd;
  }
  if (outsideMath.includes('`') || outsideMath.includes('[') || outsideMath.includes(']')
    || outsideMath.includes('\\') || outsideMath.includes('_') || outsideMath.includes('~')
    || outsideMath.includes('#') || outsideMath.includes('>') || hasUriScheme(outsideMath)
    || hasBareEmail(outsideMath)) return false;

  let singleMarkers = 0;
  let doubleMarkers = 0;
  for (let index = 0; index < outsideMath.length; index += 1) {
    if (outsideMath[index] !== '*') continue;
    const run = outsideMath[index + 1] === '*' ? 2 : 1;
    if (run === 2) {
      if (outsideMath[index + 2] === '*') return false;
      doubleMarkers += 1;
    } else {
      singleMarkers += 1;
    }
    index += run - 1;
  }
  return singleMarkers % 2 === 0 && doubleMarkers % 2 === 0;
}

function schemaText(maximum: number, field: string, validator: (value: string) => boolean): z.ZodType<string> {
  return z.string().min(1, `${field} 不能为空`).max(maximum, `${field} 过长`).superRefine((value, context) => {
    if (!validator(value)) context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} 包含不允许的内容` });
  });
}

const plainText = (maximum: number, field: string): z.ZodType<string> => schemaText(maximum, field, isSafePlainText);
const displayText = schemaText(240, 'displayMarkdown', isSafeDisplayMarkdown);
const speechText = schemaText(260, 'speechText', isSafeSpeechText);
const titleText = plainText(80, 'title');

const alternateExplanationSchema = z.object({
  displayMarkdown: displayText,
  speechText,
}).strict();

const visualSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('formula') }).strict(),
  z.object({
    mode: z.literal('generated_image'),
    prompt: plainText(300, 'visual.prompt'),
    altText: plainText(160, 'visual.altText'),
  }).strict(),
]);

const checkpointSchema = z.object({
  prompt: plainText(240, 'checkpoint.prompt'),
  options: z.array(plainText(120, 'checkpoint.options')).min(2).max(4),
  correctAnswer: plainText(120, 'checkpoint.correctAnswer'),
  explanation: plainText(240, 'checkpoint.explanation'),
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
    'teacher_intro', 'teacher_explanation', 'student_question', 'student_misconception',
    'teacher_reframe', 'checkpoint', 'summary',
  ]),
  speaker: z.enum(['teacher', 'student', 'system']),
  title: titleText,
  displayMarkdown: displayText,
  speechText,
  alternateExplanation: alternateExplanationSchema.optional(),
  visual: visualSchema,
  checkpoint: checkpointSchema.optional(),
}).strict();

const scriptSchema = z.object({
  schemaVersion: z.literal(1),
  title: titleText,
  subject: plainText(40, 'subject'),
  grade: plainText(40, 'grade'),
  topic: plainText(120, 'topic'),
  learningObjectives: z.array(plainText(120, 'learningObjectives')).min(1).max(6),
  estimatedMinutes: z.number().int().min(1).max(60),
  segments: z.array(segmentSchema).min(7).max(30),
}).strict();

function segmentTextLength(segment: CoursewareScriptSegment): number {
  let length = segment.segmentKey.length + segment.title.length + segment.displayMarkdown.length + segment.speechText.length;
  if (segment.alternateExplanation) length += segment.alternateExplanation.displayMarkdown.length + segment.alternateExplanation.speechText.length;
  if (segment.visual.mode === 'generated_image') length += (segment.visual.prompt?.length ?? 0) + (segment.visual.altText?.length ?? 0);
  if (segment.checkpoint) {
    length += segment.checkpoint.prompt.length + segment.checkpoint.correctAnswer.length + segment.checkpoint.explanation.length;
    for (const option of segment.checkpoint.options ?? []) length += option.length;
  }
  return length;
}

export function getCoursewareScriptTextLength(script: CoursewareScript): number {
  let length = script.title.length + script.subject.length + script.grade.length + script.topic.length;
  for (const objective of script.learningObjectives) length += objective.length;
  for (const segment of script.segments) length += segmentTextLength(segment);
  return length;
}

function validateScriptInvariants(script: CoursewareScript): boolean {
  const segments = script.segments;
  const keys = new Set<string>();
  const speakerByKind = {
    teacher_intro: 'teacher', teacher_explanation: 'teacher', student_question: 'student',
    student_misconception: 'student', teacher_reframe: 'teacher', checkpoint: 'system', summary: 'teacher',
  } as const;
  let questions = 0;
  let misconceptions = 0;
  let checkpoints = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (keys.has(segment.segmentKey) || segment.speaker !== speakerByKind[segment.kind]) return false;
    keys.add(segment.segmentKey);
    if ((segment.kind === 'teacher_intro' && index !== 0) || (segment.kind === 'summary' && index !== segments.length - 1)) return false;
    const allowsAlternate = segment.kind === 'teacher_explanation' || segment.kind === 'teacher_reframe';
    if (allowsAlternate !== Boolean(segment.alternateExplanation)) return false;
    if ((segment.kind === 'checkpoint') !== Boolean(segment.checkpoint)) return false;
    if (segment.kind === 'student_question') questions += 1;
    if (segment.kind === 'student_misconception') {
      misconceptions += 1;
      if (segments[index + 1]?.kind !== 'teacher_reframe') return false;
    }
    if (segment.kind === 'teacher_reframe' && segments[index - 1]?.kind !== 'student_misconception') return false;
    if (segment.kind === 'checkpoint') checkpoints += 1;
  }
  return segments[0]?.kind === 'teacher_intro'
    && segments[segments.length - 1]?.kind === 'summary'
    && questions > 0
    && misconceptions > 0
    && checkpoints > 0
    && checkpoints <= 3
    && getCoursewareScriptTextLength(script) <= MAX_COURSEWARE_SCRIPT_TEXT_CHARS;
}

function assertSafeJsonStructure(raw: string): void {
  if (raw.length === 0 || raw.length > MAX_RAW_JSON_CHARS) throw new Error('invalid');
  let index = 0;
  const skipWhitespace = (): void => {
    while (index < raw.length && /[\t\n\r ]/.test(raw[index]!)) index += 1;
  };
  const readString = (): string => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < raw.length) {
      const character = raw[index++]!;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') return JSON.parse(raw.slice(start, index)) as string;
    }
    throw new Error('invalid');
  };
  const readValue = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new Error('invalid');
    skipWhitespace();
    const current = raw[index];
    if (current === '{') {
      index += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (raw[index] === '}') { index += 1; return; }
      while (true) {
        skipWhitespace();
        if (raw[index] !== '"') throw new Error('invalid');
        const key = readString();
        if (keys.has(key)) throw new Error('invalid');
        keys.add(key);
        skipWhitespace();
        if (raw[index] !== ':') throw new Error('invalid');
        index += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (raw[index] === '}') { index += 1; return; }
        if (raw[index] !== ',') throw new Error('invalid');
        index += 1;
      }
    }
    if (current === '[') {
      index += 1;
      skipWhitespace();
      if (raw[index] === ']') { index += 1; return; }
      while (true) {
        readValue(depth + 1);
        skipWhitespace();
        if (raw[index] === ']') { index += 1; return; }
        if (raw[index] !== ',') throw new Error('invalid');
        index += 1;
      }
    }
    if (current === '"') { readString(); return; }
    const start = index;
    while (index < raw.length && !/[\t\n\r ,\]}]/.test(raw[index]!)) index += 1;
    if (index === start) throw new Error('invalid');
  };

  readValue(1);
  skipWhitespace();
  if (index !== raw.length) throw new Error('invalid');
}

export function parseCoursewareScript(raw: string): CoursewareScript {
  try {
    assertSafeJsonStructure(raw);
    const parsed: unknown = JSON.parse(raw);
    const result = scriptSchema.safeParse(parsed);
    if (!result.success || !validateScriptInvariants(result.data as CoursewareScript)) throw new Error('invalid');
    return result.data as CoursewareScript;
  } catch {
    throw new Error(SAFE_PARSE_ERROR);
  }
}
