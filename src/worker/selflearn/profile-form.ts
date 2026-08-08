import { z } from 'zod';

const shortText = z.string().trim().max(500).default('');
const choice = z.string().trim().max(30).default('');
const chipList = z.array(z.string().trim().max(30)).max(12).default([]);

export const profileFormSchema = z.object({
  directions: chipList,
  goal: shortText,
  currentPosition: shortText,
  weakSpots: shortText,
  mainProblem: shortText,
  parentPriority: shortText,
  weekdayTime: choice,
  weekendTime: choice,
  startHabit: choice,
  focusDuration: choice,
  difficultyReaction: choice,
  retellAbility: choice,
  preferredStyles: chipList,
  mistakeHabit: choice,
  interestState: choice,
  interests: shortText,
  parentInvolvement: choice,
  forbidden: chipList,
  specialNotes: shortText,
});

export type ProfileForm = z.infer<typeof profileFormSchema>;

const MISSING = '暂无，待观察';

function value(v: string): string {
  return v.trim() || MISSING;
}

function list(v: string[]): string {
  return v.length > 0 ? v.join('、') : MISSING;
}

export function buildProfileTextFromForm(
  student: { name: string; grade: string; textbook: string; region: string },
  form: ProfileForm,
): string {
  return [
    '【孩子学习画像摘要】（家长表单填写）',
    '',
    '一、基础信息',
    `- 姓名：${student.name}`,
    `- 年级：${student.grade}`,
    `- 地区 / 教材：${[student.region, student.textbook].filter(Boolean).join(' / ') || MISSING}`,
    '',
    '二、学习方向与目标',
    `- 优先支持方向：${list(form.directions)}`,
    `- 阶段目标：${value(form.goal)}`,
    `- 当前学习位置：${value(form.currentPosition)}`,
    `- 明显薄弱或卡住的内容：${value(form.weakSpots)}`,
    `- 当前主要问题：${value(form.mainProblem)}`,
    `- 家长优先目标：${value(form.parentPriority)}`,
    `- 可用学习时间：平日 ${value(form.weekdayTime)}，周末 ${value(form.weekendTime)}`,
    '',
    '三、学习习惯画像',
    `- 启动方式：${value(form.startHabit)}`,
    `- 单次专注时长：${value(form.focusDuration)}`,
    `- 遇到难题的反应：${value(form.difficultyReaction)}`,
    `- 复述能力：${value(form.retellAbility)}`,
    `- 适合的学习方式：${list(form.preferredStyles)}`,
    `- 错题整理习惯：${value(form.mistakeHabit)}`,
    '',
    '四、学习状态画像',
    `- 学科兴趣状态：${value(form.interestState)}`,
    `- 可用兴趣点：${value(form.interests)}`,
    '',
    '五、家长参与与限制',
    `- 家长参与方式：${value(form.parentInvolvement)}`,
    `- 禁用方式：${list(form.forbidden)}`,
    `- 特别注意事项：${value(form.specialNotes)}`,
    '',
    '说明：以上画像来自家长填写的表单；标注"暂无，待观察"的项，请在学习中观察补充，不要编造。',
  ].join('\n');
}
