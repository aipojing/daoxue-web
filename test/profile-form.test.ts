import { describe, it, expect } from 'vitest';
import { profileFormSchema, buildProfileTextFromForm } from '../src/worker/selflearn/profile-form';

const form = {
  directions: ['数学', '编程'],
  goal: '期末考进班级前十',
  currentPosition: '数学学到分式运算',
  weakSpots: '几何证明',
  mainProblem: '分式运算总出错',
  parentPriority: '先把数学补稳',
  weekdayTime: '30-60分钟',
  weekendTime: '1-2小时',
  startHabit: '需要提醒',
  focusDuration: '15-30分钟',
  difficultyReaction: '容易放弃',
  retellAbility: '能说一部分',
  preferredStyles: ['例题', '先做后讲'],
  mistakeHabit: '偶尔整理',
  interestState: '一般',
  interests: '喜欢打篮球和我的世界',
  parentInvolvement: '只看反馈',
  forbidden: ['催促', '大量刷题'],
  specialNotes: '视力不好，注意用眼时间',
};

describe('profileFormSchema', () => {
  it('接受完整表单', () => {
    expect(profileFormSchema.safeParse(form).success).toBe(true);
  });

  it('接受空表单（全部可选）', () => {
    expect(profileFormSchema.safeParse({}).success).toBe(true);
  });

  it('拒绝超长文本', () => {
    expect(profileFormSchema.safeParse({ goal: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('buildProfileTextFromForm', () => {
  it('生成包含关键信息的画像文本', () => {
    const student = { name: '小明', grade: '初二', textbook: '人教版', region: '北京' };
    const text = buildProfileTextFromForm(student, profileFormSchema.parse(form));
    expect(text).toContain('【孩子学习画像摘要】');
    expect(text).toContain('初二');
    expect(text).toContain('数学、编程');
    expect(text).toContain('数学学到分式运算');
    expect(text).toContain('几何证明');
    expect(text).toContain('分式运算总出错');
    expect(text).toContain('需要提醒');
    expect(text).toContain('容易放弃');
    expect(text).toContain('催促');
    expect(text).toContain('视力不好');
  });

  it('空字段标注为待观察而不是编造', () => {
    const text = buildProfileTextFromForm({ name: '小红', grade: '三年级', textbook: '', region: '' }, profileFormSchema.parse({}));
    expect(text).toContain('小红');
    expect(text).toContain('暂无，待观察');
  });
});
