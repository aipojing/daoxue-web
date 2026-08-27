import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, isSubject, SUBJECTS, SUBJECT_NAMES } from '../src/worker/chat/prompt-builder';
import { getBasePrompt } from '../src/worker/chat/prompts';
import { COURSEWARE_SCRIPT_PROMPT } from '../src/worker/courseware/prompt-builder';

const student = { name: '小明', grade: '初二', textbook: '人教版', region: '北京', notes: '' };

describe('buildSystemPrompt', () => {
  it('包含基础提示词、学生档案与画像', () => {
    const p = buildSystemPrompt('BASE_PROMPT', student, '计算易错');
    expect(p).toContain('BASE_PROMPT');
    expect(p).toContain('小明');
    expect(p).toContain('初二');
    expect(p).toContain('人教版');
    expect(p).toContain('计算易错');
    expect(p).toContain('不支持图片');
  });

  it('无画像时不包含画像段落标题', () => {
    const p = buildSystemPrompt('BASE', student, null);
    expect(p).not.toContain('学习画像');
  });

  it('空字段不输出对应行', () => {
    const p = buildSystemPrompt('BASE', { ...student, textbook: '', region: '', notes: '' }, null);
    expect(p).not.toContain('教材版本');
    expect(p).not.toContain('地区');
  });
});

describe('subjects', () => {
  it('学科枚举与名称一致', () => {
    expect(SUBJECTS).toEqual(['math', 'chinese', 'physics', 'english', 'chemistry', 'history']);
    expect(SUBJECT_NAMES.math).toBe('数学');
    expect(SUBJECT_NAMES.english).toBe('英语');
    expect(SUBJECT_NAMES.chemistry).toBe('化学');
    expect(SUBJECT_NAMES.history).toBe('历史');
  });

  it('isSubject 校验', () => {
    expect(isSubject('math')).toBe(true);
    expect(isSubject('physics')).toBe(true);
    expect(isSubject('chemistry')).toBe(true);
    expect(isSubject('history')).toBe(true);
    expect(isSubject('biology')).toBe(false);
    expect(isSubject('')).toBe(false);
  });

  it('化学提示词包含关键导学约束', () => {
    const prompt = getBasePrompt('chemistry');
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

  it('历史提示词包含核心导学约束', () => {
    const prompt = getBasePrompt('history');
    expect(prompt).toContain('校内历史独立版');
    expect(prompt).toContain('定时空');
    expect(prompt).toContain('观点—证据—解释');
    expect(prompt).toContain('史料性质');
    expect(prompt).toContain('guided');
    expect(prompt).toContain('full_solution');
    expect(prompt).toContain('五个失分定位维度');
    expect(prompt).toContain('不编造人物、年代、事件、出处、数据和引文');
  });
});

describe('courseware script prompt', () => {
  it('ships the versioned voice courseware prompt', () => {
    expect(COURSEWARE_SCRIPT_PROMPT).toContain('schemaVersion');
    expect(COURSEWARE_SCRIPT_PROMPT).toContain('student_question');
    expect(COURSEWARE_SCRIPT_PROMPT).toContain('student_misconception');
    expect(COURSEWARE_SCRIPT_PROMPT).toContain('alternateExplanation');
    expect(COURSEWARE_SCRIPT_PROMPT).toContain('不允许链接');
    expect(COURSEWARE_SCRIPT_PROMPT).toContain('SSML');
  });
});
