import { describe, expect, it } from 'vitest';
import type {
  CoursewareScript,
  CoursewareScriptSegment,
  CoursewareSegmentKind,
  CoursewareSpeaker,
} from '../src/shared/courseware';
import { parseCoursewareScript } from '../src/worker/courseware/schema';
import { buildCoursewarePrompt } from '../src/worker/courseware/prompt-builder';

function segment(
  segmentKey: string,
  kind: CoursewareSegmentKind,
  speaker: CoursewareSpeaker,
  displayMarkdown: string,
  speechText: string,
): CoursewareScriptSegment {
  return {
    segmentKey,
    kind,
    speaker,
    title: displayMarkdown.slice(0, 20),
    displayMarkdown,
    speechText,
    visual: { mode: 'none' },
  };
}

const validScript: CoursewareScript = {
  schemaVersion: 1,
  title: '10以内加法',
  subject: '数学',
  grade: '一年级',
  topic: '加法表示合并',
  learningObjectives: ['理解加法表示把两部分合在一起'],
  estimatedMinutes: 6,
  segments: [
    segment('intro', 'teacher_intro', 'teacher', '先看看两堆积木。', '先看看两堆积木。'),
    {
      ...segment('explain', 'teacher_explanation', 'teacher', '左边3块，右边2块，合起来写成 $3+2$。', '左边三块，右边两块，合起来写成三加二。'),
      alternateExplanation: {
        displayMarkdown: '把两堆推到一起，再从1数到5。',
        speechText: '把两堆推到一起，再从一数到五。',
      },
      visual: {
        mode: 'generated_image',
        prompt: '两堆彩色积木，左三块右两块，无文字，无人物',
        altText: '左边三块积木、右边两块积木',
      },
    },
    segment('question', 'student_question', 'student', '老师，为什么不是32？', '老师，为什么不是三十二？'),
    segment('mistake', 'student_misconception', 'student', '我把3和2挨着写成了32。', '我把三和二挨着写成了三十二。'),
    {
      ...segment('reframe', 'teacher_reframe', 'teacher', '这里是合并，不是把数字拼起来。', '这里是合并，不是把数字拼起来。'),
      alternateExplanation: {
        displayMarkdown: '数一数全部积木：1、2、3、4、5。',
        speechText: '数一数全部积木，一，二，三，四，五。',
      },
    },
    {
      ...segment('check', 'checkpoint', 'system', '3+2等于几？', '三加二等于几？'),
      checkpoint: {
        prompt: '3+2等于几？',
        options: ['4', '5', '32'],
        correctAnswer: '5',
        explanation: '把两部分合起来，一共有5块。',
      },
    },
    segment('summary', 'summary', 'teacher', '加法可以表示把两部分合在一起。', '加法可以表示把两部分合在一起。'),
  ],
};

function parse(script: unknown): CoursewareScript {
  return parseCoursewareScript(JSON.stringify(script));
}

function clonedScript(): CoursewareScript {
  return structuredClone(validScript);
}

describe('courseware script schema', () => {
  it('parses a complete valid voice courseware script unchanged', () => {
    expect(parseCoursewareScript(JSON.stringify(validScript))).toEqual(validScript);
  });

  it.each([
    ['Markdown fence', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = '```ts\\nalert(1)\\n```'; }],
    ['unknown root field', (script: CoursewareScript) => { (script as CoursewareScript & { extra: boolean }).extra = true; }],
    ['unknown segment field', (script: CoursewareScript) => { (script.segments[0] as CoursewareScriptSegment & { extra: boolean }).extra = true; }],
    ['an eighth kind', (script: CoursewareScript) => { (script.segments[0] as CoursewareScriptSegment & { kind: string }).kind = 'video' as never; }],
    ['raw LaTeX in speech', (script: CoursewareScript) => { script.segments[1]!.speechText = '\\frac{3}{2}'; }],
    ['control characters', (script: CoursewareScript) => { script.segments[0]!.speechText = '你好\\u0001'; }],
    ['HTML', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = '<img src=x onerror=alert(1)>'; }],
    ['HTML in an image prompt', (script: CoursewareScript) => { (script.segments[1]!.visual as { mode: 'generated_image'; prompt: string; altText: string }).prompt = '<script>alert(1)</script>'; }],
    ['JavaScript URL', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = '[点击](javascript:alert(1))'; }],
  ])('rejects %s', (_name, mutate) => {
    const script = clonedScript();
    mutate(script);
    expect(() => parse(script)).toThrow();
  });

  it('rejects duplicate JSON object keys and duplicate segment keys', () => {
    const raw = JSON.stringify(validScript).replace('"title":"10以内加法"', '"title":"10以内加法","title":"重复"');
    expect(() => parseCoursewareScript(raw)).toThrow();

    const script = clonedScript();
    script.segments[1]!.segmentKey = 'intro';
    expect(() => parse(script)).toThrow();
  });

  it('rejects excessive JSON nesting and more than 30 segments', () => {
    let raw = '0';
    for (let index = 0; index < 20; index += 1) raw = `[${raw}]`;
    expect(() => parseCoursewareScript(raw)).toThrow();

    const script = clonedScript();
    while (script.segments.length <= 30) {
      script.segments.push(segment(`extra-${script.segments.length}`, 'summary', 'teacher', '复习。', '复习。'));
    }
    expect(() => parse(script)).toThrow();
  });

  it.each([
    ['student_question', (script: CoursewareScript) => { script.segments = script.segments.filter(({ kind }) => kind !== 'student_question'); }],
    ['student_misconception', (script: CoursewareScript) => { script.segments = script.segments.filter(({ kind }) => kind !== 'student_misconception'); }],
    ['a reframe after a misconception', (script: CoursewareScript) => { script.segments[4] = segment('other', 'summary', 'teacher', '总结。', '总结。'); }],
    ['alternate explanation for teacher explanation', (script: CoursewareScript) => { delete script.segments[1]!.alternateExplanation; }],
    ['alternate explanation for teacher reframe', (script: CoursewareScript) => { delete script.segments[4]!.alternateExplanation; }],
  ])('rejects missing %s', (_name, mutate) => {
    const script = clonedScript();
    mutate(script);
    expect(() => parse(script)).toThrow();
  });

  it('enforces speaker, visual, and checkpoint combinations', () => {
    const wrongSpeaker = clonedScript();
    wrongSpeaker.segments[0]!.speaker = 'student';
    expect(() => parse(wrongSpeaker)).toThrow();

    const formulaImagePrompt = clonedScript();
    formulaImagePrompt.segments[0]!.visual = { mode: 'formula', prompt: '不要接受' };
    expect(() => parse(formulaImagePrompt)).toThrow();

    const missingImageAlt = clonedScript();
    missingImageAlt.segments[1]!.visual = { mode: 'generated_image', prompt: '积木' };
    expect(() => parse(missingImageAlt)).toThrow();

    const nonCheckpointData = clonedScript();
    nonCheckpointData.segments[0]!.checkpoint = validScript.segments[5]!.checkpoint;
    expect(() => parse(nonCheckpointData)).toThrow();

    const missingCheckpointData = clonedScript();
    delete missingCheckpointData.segments[5]!.checkpoint;
    expect(() => parse(missingCheckpointData)).toThrow();
  });
});

describe('courseware prompt construction', () => {
  it('wraps source material as explicitly untrusted bounded content', () => {
    const prompt = buildCoursewarePrompt({
      grade: '一年级',
      subject: '数学',
      topic: '加法表示合并',
      learningGoal: '理解合并',
      profileExcerpt: '容易把数字连写。'.repeat(100),
      relatedKnowledge: Array.from({ length: 14 }, (_, index) => `知识${index}`.repeat(100)),
      sourceText: '教材内容'.repeat(3_500),
    });

    expect(prompt.system).toContain('一年级');
    expect(prompt.system).toContain('可信任务字段');
    expect(prompt.user).toContain('不可信');
    expect(prompt.user).toContain('<source_material>');
    expect(prompt.user).toContain('</source_material>');
    expect(prompt.user).toContain('教材内容');
    expect(prompt.user).not.toContain('教材内容'.repeat(3_334));
    expect(prompt.user).not.toContain('知识12');
  });
});
