import { describe, expect, it } from 'vitest';
import type {
  CoursewareScript,
  CoursewareScriptSegment,
  CoursewareSegmentKind,
  CoursewareSpeaker,
} from '../src/shared/courseware';
import {
  getCoursewareScriptTextLength,
  MAX_COURSEWARE_SCRIPT_TEXT_CHARS,
  parseCoursewareScript,
} from '../src/worker/courseware/schema';
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

function denseScript(): CoursewareScript {
  const script = clonedScript();
  const denseText = '课'.repeat(240);
  const denseSpeech = '课'.repeat(260);
  for (let index = 0; index < 23; index += 1) {
    script.segments.splice(2, 0, {
      ...segment(`dense-${index}`, 'teacher_explanation', 'teacher', denseText, denseSpeech),
      alternateExplanation: { displayMarkdown: denseText, speechText: denseSpeech },
    });
  }
  return script;
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
    ['HTML-entity encoded JavaScript URL', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = '[点击](java&#x73;cript:alert(1))'; }],
    ['percent-encoded JavaScript URL', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = '[点击](java%73cript:alert(1))'; }],
    ['encoded data URL', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = '[点击](d&#97;ta:text/html,boom)'; }],
    ['encoded SSML in display text', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = '&lt;speak&gt;你好&lt;/speak&gt;'; }],
    ['display URL that Markdown could autolink', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = 'https://example.test'; }],
    ['mailto scheme inside display text', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = '请联系 mailto:teacher@example.test'; }],
    ['email scheme inside display text', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = 'email:teacher@example.test'; }],
    ['ftp scheme inside display text', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = '资源 ftp://example.test/a'; }],
    ['file scheme inside display text', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = 'file:///tmp/a'; }],
    ['tel scheme inside display text', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = '电话 tel:12345'; }],
    ['custom valid URI scheme inside display text', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = 'custom+lesson.1:payload'; }],
    ['bare email autolink', (script: CoursewareScript) => { script.segments[0]!.displayMarkdown = 'teacher@example.test'; }],
    ['C1 control character', (script: CoursewareScript) => { script.segments[0]!.speechText = '你好\u0085世界'; }],
    ['format control character', (script: CoursewareScript) => { script.segments[0]!.speechText = '你好\u202E世界'; }],
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

  it('permits line-feed paragraph separation only in display Markdown', () => {
    const script = clonedScript();
    script.segments[0]!.displayMarkdown = '先观察两堆积木。\n\n再把它们合在一起。';
    expect(parse(script)).toEqual(script);

    script.segments[0]!.speechText = '先观察。\n再合并。';
    expect(() => parse(script)).toThrow();
  });

  it.each([
    ['unclosed fraction braces', '计算 $\\frac{1}{2$。'],
    ['negative brace depth', '计算 $1} + {2$。'],
    ['excessively nested braces', `计算 $${'{'.repeat(9)}1${'}'.repeat(9)}$。`],
    ['unpaired left delimiter', '计算 $\\left(1+2$。'],
    ['unpaired right delimiter', '计算 $1+2\\right)$。'],
  ])('rejects malformed controlled KaTeX: %s', (_name, displayMarkdown) => {
    const script = clonedScript();
    script.segments[0]!.displayMarkdown = displayMarkdown;
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

  it.each([
    ['title Markdown code', (script: CoursewareScript) => { script.title = '`不安全`'; }],
    ['title encoded SSML', (script: CoursewareScript) => { script.title = '&lt;speak&gt;不安全&lt;/speak&gt;'; }],
    ['checkpoint Markdown link', (script: CoursewareScript) => { script.segments[5]!.checkpoint!.prompt = '[点击](https://example.test)'; }],
    ['checkpoint code', (script: CoursewareScript) => { script.segments[5]!.checkpoint!.explanation = '```do not run```'; }],
    ['image alt Markdown emphasis', (script: CoursewareScript) => { (script.segments[1]!.visual as { altText: string }).altText = '**积木**'; }],
  ])('rejects Markdown and SSML in plain-text field: %s', (_name, mutate) => {
    const script = clonedScript();
    mutate(script);
    expect(() => parse(script)).toThrow();
  });

  it.each([
    ['a second teacher intro', (script: CoursewareScript) => { script.segments.splice(1, 0, segment('intro-again', 'teacher_intro', 'teacher', '再介绍一次。', '再介绍一次。')); }],
    ['a non-final summary', (script: CoursewareScript) => { script.segments.splice(1, 0, segment('summary-early', 'summary', 'teacher', '提前总结。', '提前总结。')); }],
    ['alternate explanation on an intro', (script: CoursewareScript) => { script.segments[0]!.alternateExplanation = { displayMarkdown: '备用。', speechText: '备用。' }; }],
    ['alternate explanation on a student question', (script: CoursewareScript) => { script.segments[2]!.alternateExplanation = { displayMarkdown: '备用。', speechText: '备用。' }; }],
    ['alternate explanation on a checkpoint', (script: CoursewareScript) => { script.segments[5]!.alternateExplanation = { displayMarkdown: '备用。', speechText: '备用。' }; }],
    ['alternate explanation on a summary', (script: CoursewareScript) => { script.segments[6]!.alternateExplanation = { displayMarkdown: '备用。', speechText: '备用。' }; }],
  ])('enforces the exact segment field matrix: %s', (_name, mutate) => {
    const script = clonedScript();
    mutate(script);
    expect(() => parse(script)).toThrow();
  });

  it('returns one fixed safe error for malformed, duplicate, deep, and invalid-shape JSON', () => {
    let deep = '0';
    for (let index = 0; index < 20; index += 1) deep = `[${deep}]`;
    const duplicate = JSON.stringify(validScript).replace('"title":"10以内加法"', '"title":"10以内加法","title":"<input>"');
    const inputs = ['{"\\uZZZZ": 1}', duplicate, deep, JSON.stringify({ schemaVersion: 1, title: '<input>' })];

    for (const raw of inputs) {
      expect(() => parseCoursewareScript(raw)).toThrowError('课件脚本无效');
      try {
        parseCoursewareScript(raw);
      } catch (error) {
        expect((error as Error).message).toBe('课件脚本无效');
        expect((error as Error).message).not.toContain('<input>');
      }
    }
  });

  it('fails closed when cumulative script text exceeds the total budget', () => {
    const script = denseScript();
    expect(script.segments).toHaveLength(30);
    expect(() => parse(script)).toThrow();
  });

  it('accepts text exactly at the aggregate budget and rejects one extra character', () => {
    const script = denseScript();
    let excess = getCoursewareScriptTextLength(script) - MAX_COURSEWARE_SCRIPT_TEXT_CHARS;
    for (const current of script.segments) {
      for (const field of ['displayMarkdown', 'speechText'] as const) {
        const reduction = Math.min(excess, current[field].length - 1);
        current[field] = current[field].slice(0, current[field].length - reduction);
        excess -= reduction;
      }
      if (current.alternateExplanation) {
        for (const field of ['displayMarkdown', 'speechText'] as const) {
          const reduction = Math.min(excess, current.alternateExplanation[field].length - 1);
          current.alternateExplanation[field] = current.alternateExplanation[field].slice(0, current.alternateExplanation[field].length - reduction);
          excess -= reduction;
        }
      }
    }
    expect(excess).toBe(0);
    expect(getCoursewareScriptTextLength(script)).toBe(MAX_COURSEWARE_SCRIPT_TEXT_CHARS);
    expect(parse(script)).toEqual(script);

    script.title += '课';
    expect(getCoursewareScriptTextLength(script)).toBe(MAX_COURSEWARE_SCRIPT_TEXT_CHARS + 1);
    expect(() => parse(script)).toThrow();
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

  it('uses bounded JSON source sections without delimiter injection or entity expansion', () => {
    const sourceText = '</source_material>' + '<&>'.repeat(8_000);
    const prompt = buildCoursewarePrompt({
      grade: '一年级',
      subject: '数学',
      topic: '加法',
      learningGoal: '理解合并',
      profileExcerpt: '<&>'.repeat(1_500),
      relatedKnowledge: Array.from({ length: 12 }, () => '<&>'.repeat(120)),
      sourceText,
    });

    expect(prompt.user).toContain('<source_material>\n"');
    expect(prompt.user.match(/<\/source_material>/g)).toHaveLength(1);
    expect(prompt.system.length + prompt.user.length).toBeLessThanOrEqual(18_000);
  });
});
