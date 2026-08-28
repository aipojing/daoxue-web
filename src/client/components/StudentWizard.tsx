import { useState } from 'react';
import { apiPost, apiPut, ApiError } from '../api';
import {
  GRADES,
  PROVINCES,
  splitRegion,
  joinRegion,
  hasProfileFormContent,
  isProfileFormDirty,
  EMPTY_PROFILE_FORM,
  type ProfileFormData,
  type Student,
  type StudentGender,
} from '../types';
import { useDialogFocus } from '../lib/modal';
import StudentGenderField from './StudentGenderField';

const COLOR_OPTIONS: Array<{ value: string; name: string }> = [
  { value: '#1e5b4a', name: '墨绿' },
  { value: '#b8432f', name: '砖红' },
  { value: '#33648f', name: '靛蓝' },
  { value: '#b0782a', name: '赭黄' },
  { value: '#635c9b', name: '藤紫' },
  { value: '#3a7d5c', name: '松绿' },
];

const DIRECTION_OPTIONS = ['数学', '语文', '英语', '物理/科学', '编程', '写作', '阅读', '演讲', '科创'];
const TIME_OPTIONS = ['30分钟内', '30-60分钟', '1-2小时', '2小时以上'];
const START_OPTIONS = ['主动开始', '需要提醒', '经常拖延', '比较抵触'];
const FOCUS_OPTIONS = ['15分钟内', '15-30分钟', '30-60分钟', '1小时以上'];
const REACTION_OPTIONS = ['主动思考', '马上问人', '容易放弃', '容易急躁', '假装会了'];
const RETELL_OPTIONS = ['能清楚复述', '能说一部分', '基本说不出', '没试过'];
const STYLE_OPTIONS = ['讲解', '例题', '图示', '动手操作', '游戏化', '项目任务', '提问引导', '先做后讲'];
const MISTAKE_OPTIONS = ['有错题本', '偶尔整理', '基本不整理'];
const INTEREST_STATE_OPTIONS = ['喜欢', '一般', '抗拒', '不稳定'];
const INVOLVEMENT_OPTIONS = ['每天陪着学', '只看反馈', '卡住时介入', '尽量让孩子自主'];
const FORBIDDEN_OPTIONS = ['催促', '批评', '大量刷题', '竞速比拼', '太幼稚的内容', '太难的内容'];

interface BasicInfo {
  name: string;
  grade: string;
  textbook: string;
  region: string;
  color: string;
  gender: StudentGender;
  notes: string;
}

interface Props {
  mode: 'create' | 'profile';
  studentId?: number;
  student?: Student;
  initialForm?: ProfileFormData;
  onClose: () => void;
  /** create 模式会回传新建的学生，便于调用方直接跳转 */
  onDone: (student?: Student) => void;
}

function ChipSelect({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="wizard-chips">
      {options.map((opt) => {
        const active = value.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            className={active ? 'chip active' : 'chip'}
            aria-pressed={active}
            onClick={() => onChange(active ? value.filter((v) => v !== opt) : [...value, opt])}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

function RadioChips({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="wizard-chips">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={value === opt ? 'chip active' : 'chip'}
          aria-pressed={value === opt}
          onClick={() => onChange(value === opt ? '' : opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

export default function StudentWizard({ mode, studentId, student, initialForm, onClose, onDone }: Props) {
  const isCreate = mode === 'create';
  const firstStep = isCreate ? 0 : 1;
  const [step, setStep] = useState(firstStep);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const initialRegion = splitRegion(student?.region ?? '');
  const [basic, setBasic] = useState<BasicInfo>({
    name: student?.name ?? '',
    grade: student?.grade ?? '初一',
    textbook: student?.textbook ?? '',
    region: student?.region ?? '',
    color: student?.color ?? COLOR_OPTIONS[0]!.value,
    gender: student?.gender ?? 'unspecified',
    notes: student?.notes ?? '',
  });
  const [province, setProvince] = useState(initialRegion.province);
  const [city, setCity] = useState(initialRegion.city);
  const [form, setForm] = useState<ProfileFormData>(initialForm ?? EMPTY_PROFILE_FORM);
  const initialProfileForm = initialForm ?? EMPTY_PROFILE_FORM;

  const setField = <K extends keyof ProfileFormData>(key: K, val: ProfileFormData[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const next = () => {
    if (step === 0 && (!basic.name.trim() || !basic.grade)) {
      setError('请填写姓名和年级');
      return;
    }
    setError('');
    setStep(step + 1);
  };

  const submit = async () => {
    setSubmitting(true);
    setError('');
    try {
      if (isCreate) {
        const created = await apiPost<Student>('/api/students', {
          ...basic,
          region: joinRegion(province, city),
          profileForm: form,
        });
        onDone(created);
      } else {
        await apiPut(`/api/students/${studentId}/selflearn/profile-form`, { profileForm: form });
        onDone();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败，请重试');
      setSubmitting(false);
    }
  };

  const totalSteps = 4;
  const stepTitles = ['基础信息', '方向与目标', '学习习惯', '状态与家长参与'];

  // 表单填了内容时，误点遮罩不能直接丢弃
  const requestClose = () => {
    const hasContent = isCreate
      ? Boolean(
          basic.name.trim() ||
            basic.textbook.trim() ||
            basic.notes.trim() ||
            province ||
            city.trim() ||
            hasProfileFormContent(form),
        )
      : isProfileFormDirty(form, initialProfileForm);
    if (hasContent && !window.confirm('放弃已填写的内容？')) return;
    onClose();
  };
  const dialogRef = useDialogFocus<HTMLDivElement>(requestClose);

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div
        ref={dialogRef}
        className="modal wizard-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="student-wizard-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wizard-header">
          <h2 id="student-wizard-title" className="modal-title">{isCreate ? '添加学生' : '编辑孩子画像'}</h2>
          <div className="wizard-steps">
            {stepTitles.map((title, i) => (
              <span
                key={title}
                className={
                  i === step ? 'wizard-step active' : i < step ? 'wizard-step done' : 'wizard-step'
                }
              >
                {i + 1} {title}
              </span>
            ))}
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}

        {step === 0 && (
          <div className="wizard-body">
            <label className="form-label">
              姓名 *
              <input
                value={basic.name}
                onChange={(e) => setBasic({ ...basic, name: e.target.value })}
                placeholder="孩子的名字"
                maxLength={20}
              />
            </label>
            <label className="form-label">
              年级 *
              <select value={basic.grade} onChange={(e) => setBasic({ ...basic, grade: e.target.value })}>
                {GRADES.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-label">
              教材版本
              <input
                value={basic.textbook}
                onChange={(e) => setBasic({ ...basic, textbook: e.target.value })}
                placeholder="如：人教版"
                maxLength={30}
              />
            </label>
            <div className="form-row">
              <label className="form-label">
                所在省份
                <select value={province} onChange={(e) => setProvince(e.target.value)}>
                  <option value="">不填</option>
                  {PROVINCES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-label">
                城市（建议填写，中考等考试按城市）
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="如：杭州"
                  maxLength={20}
                />
              </label>
            </div>
            <div className="form-label">
              头像颜色
              <div className="color-options">
                {COLOR_OPTIONS.map((cOpt) => (
                  <button
                    key={cOpt.value}
                    type="button"
                    className={cOpt.value === basic.color ? 'color-dot selected' : 'color-dot'}
                    style={{ background: cOpt.value }}
                    onClick={() => setBasic({ ...basic, color: cOpt.value })}
                    aria-label={cOpt.name}
                    aria-pressed={cOpt.value === basic.color}
                  />
                ))}
              </div>
            </div>
            <StudentGenderField
              value={basic.gender}
              onChange={(gender) => setBasic({ ...basic, gender })}
            />
          </div>
        )}

        {step === 1 && (
          <div className="wizard-body">
            <p className="wizard-hint">以下内容用于生成孩子的学习画像，AI 会据此安排学习。都可以选填，不确定的先跳过。</p>
            <div className="form-label">
              想让 AI 重点支持哪些方向？（可多选）
              <ChipSelect options={DIRECTION_OPTIONS} value={form.directions} onChange={(v) => setField('directions', v)} />
            </div>
            <label className="form-label">
              最近的阶段目标（考试 / 考级 / 比赛 / 作品等）
              <input value={form.goal} onChange={(e) => setField('goal', e.target.value)} placeholder="如：期末数学考进班级前十" maxLength={200} />
            </label>
            <label className="form-label">
              当前学到哪里了？
              <input
                value={form.currentPosition}
                onChange={(e) => setField('currentPosition', e.target.value)}
                placeholder="如：数学学到二次函数；Python 刚学完循环"
                maxLength={200}
              />
            </label>
            <label className="form-label">
              哪些内容明显薄弱、反复错或不愿意碰？
              <input
                value={form.weakSpots}
                onChange={(e) => setField('weakSpots', e.target.value)}
                placeholder="如：几何证明、完形填空"
                maxLength={200}
              />
            </label>
            <label className="form-label">
              最近最头疼的学习问题
              <input value={form.mainProblem} onChange={(e) => setField('mainProblem', e.target.value)} placeholder="如：分式运算总出错、作文写不长" maxLength={200} />
            </label>
            <label className="form-label">
              家长最希望先改善什么
              <input value={form.parentPriority} onChange={(e) => setField('parentPriority', e.target.value)} placeholder="如：先把数学基础补稳" maxLength={200} />
            </label>
            <div className="form-row">
              <div className="form-label">
                平日每天可自学时间
                <RadioChips options={TIME_OPTIONS} value={form.weekdayTime} onChange={(v) => setField('weekdayTime', v)} />
              </div>
              <div className="form-label">
                周末每天可自学时间
                <RadioChips options={TIME_OPTIONS} value={form.weekendTime} onChange={(v) => setField('weekendTime', v)} />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-body">
            <div className="form-label">
              孩子通常怎么开始学习？
              <RadioChips options={START_OPTIONS} value={form.startHabit} onChange={(v) => setField('startHabit', v)} />
            </div>
            <div className="form-label">
              一次能专注多久？
              <RadioChips options={FOCUS_OPTIONS} value={form.focusDuration} onChange={(v) => setField('focusDuration', v)} />
            </div>
            <div className="form-label">
              遇到不会的题通常会？
              <RadioChips options={REACTION_OPTIONS} value={form.difficultyReaction} onChange={(v) => setField('difficultyReaction', v)} />
            </div>
            <div className="form-label">
              能把学过的内容用自己的话讲出来吗？
              <RadioChips options={RETELL_OPTIONS} value={form.retellAbility} onChange={(v) => setField('retellAbility', v)} />
            </div>
            <div className="form-label">
              更容易接受哪种学习方式？（可多选）
              <ChipSelect options={STYLE_OPTIONS} value={form.preferredStyles} onChange={(v) => setField('preferredStyles', v)} />
            </div>
            <div className="form-label">
              错题整理习惯
              <RadioChips options={MISTAKE_OPTIONS} value={form.mistakeHabit} onChange={(v) => setField('mistakeHabit', v)} />
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="wizard-body">
            <div className="form-label">
              孩子对学习的兴趣状态
              <RadioChips options={INTEREST_STATE_OPTIONS} value={form.interestState} onChange={(v) => setField('interestState', v)} />
            </div>
            <label className="form-label">
              孩子平时的兴趣点（AI 会用来举例）
              <input value={form.interests} onChange={(e) => setField('interests', e.target.value)} placeholder="如：篮球、我的世界、恐龙" maxLength={200} />
            </label>
            <div className="form-label">
              家长希望参与到什么程度？
              <RadioChips options={INVOLVEMENT_OPTIONS} value={form.parentInvolvement} onChange={(v) => setField('parentInvolvement', v)} />
            </div>
            <div className="form-label">
              不希望 AI 使用的方式（可多选）
              <ChipSelect options={FORBIDDEN_OPTIONS} value={form.forbidden} onChange={(v) => setField('forbidden', v)} />
            </div>
            <label className="form-label">
              特别注意事项
              <textarea
                value={form.specialNotes}
                onChange={(e) => setField('specialNotes', e.target.value)}
                placeholder="如：视力不好注意用眼；容易焦虑，多鼓励"
                rows={2}
                maxLength={500}
              />
            </label>
          </div>
        )}

        <div className="modal-actions wizard-actions">
          <button type="button" className="btn" onClick={requestClose}>
            取消
          </button>
          <div className="wizard-actions-right">
            {step > firstStep && (
              <button type="button" className="btn" onClick={() => setStep(step - 1)}>
                上一步
              </button>
            )}
            {step < totalSteps - 1 ? (
              <button type="button" className="btn btn-primary" onClick={next}>
                下一步
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={submitting}>
                {submitting ? '保存中…' : '完成'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
