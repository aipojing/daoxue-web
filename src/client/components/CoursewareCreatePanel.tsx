import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiPost, ApiError } from '../api';
import type { CoursewareAISettings } from '../../shared/ai-catalog';
import type { CoursewareSummary } from '../../shared/courseware';
import { buildCoursewareCreatePayload, canCreateCourseware, type CoursewareCreateDraft } from '../lib/courseware';

interface Props {
  studentId: number;
  settings: CoursewareAISettings;
  onCreated: (courseware: CoursewareSummary) => void;
  routeToken: number;
  isRouteCurrent: (token: number) => boolean;
  routeSignal: AbortSignal;
}

const EMPTY_DRAFT: CoursewareCreateDraft = { subject: '', topic: '', learningGoal: '', sourceText: '', sourceConversationId: '', includeImages: false };

function readinessLabel(value: CoursewareAISettings['readiness'][keyof CoursewareAISettings['readiness']]): string {
  return value === 'ready' ? '已就绪' : value === 'disabled' ? '未启用' : value === 'quota_exhausted' ? '额度已用完' : value === 'invalid_credential' ? '密钥无效' : '尚未配置';
}

export default function CoursewareCreatePanel({ studentId, settings, onCreated, routeToken, isRouteCurrent, routeSignal }: Props) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const readiness = { featureEnabled: settings.featureEnabled, ...settings.readiness };
  const eligible = canCreateCourseware(readiness, draft.includeImages);

  const change = <K extends keyof CoursewareCreateDraft>(key: K, value: CoursewareCreateDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!eligible.ok || submittingRef.current) return;
    const payload = buildCoursewareCreatePayload(draft);
    if (!payload.subject || !payload.topic || !payload.learningGoal) {
      setError('请填写学科、主题和学习目标');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      const created = await apiPost<CoursewareSummary>(`/api/students/${studentId}/coursewares`, payload, { signal: routeSignal });
      if (!isRouteCurrent(routeToken) || routeSignal.aborted) return;
      onCreated(created);
      setDraft(EMPTY_DRAFT);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建课件失败，请稍后重试');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <section className="courseware-create" aria-labelledby="courseware-create-title">
      <div className="courseware-section-heading"><div><p className="courseware-eyebrow">新建课件</p><h1 id="courseware-create-title">为这次学习准备一节语音课</h1></div></div>
      <div className="courseware-readiness-grid" aria-label="课件模型准备情况">
        <span>课程脚本 <b>{readinessLabel(settings.readiness.text)}</b></span>
        <span>老师语音 <b>{readinessLabel(settings.readiness.teacherSpeech)}</b></span>
        <span>AI 同学语音 <b>{readinessLabel(settings.readiness.studentSpeech)}</b></span>
        <span>教学配图 <b>{readinessLabel(settings.readiness.image)}</b></span>
      </div>
      <p className="courseware-account-note">生成会使用家长自己的模型套餐。额度耗尽后不会切换到平台账号，新的课件生成功能会暂停。</p>
      {!eligible.ok && <p className="courseware-config-note" role="status">{eligible.reason} <Link to="/ai-settings">前往 AI 服务</Link></p>}
      <form className="courseware-form" onSubmit={(event) => void submit(event)}>
        <label>学科<input value={draft.subject} maxLength={40} onChange={(event) => change('subject', event.target.value)} disabled={submitting} placeholder="例如：数学" required /></label>
        <label>学习主题<input value={draft.topic} maxLength={80} onChange={(event) => change('topic', event.target.value)} disabled={submitting} placeholder="例如：认识二分之一" required /></label>
        <label className="courseware-form-wide">学习目标<textarea value={draft.learningGoal} maxLength={240} onChange={(event) => change('learningGoal', event.target.value)} disabled={submitting} placeholder="例如：能用图形解释二分之一，并比较简单分数" required rows={3} /></label>
        <label className="courseware-form-wide">参考材料（可选）<textarea value={draft.sourceText} maxLength={10_000} onChange={(event) => change('sourceText', event.target.value)} disabled={submitting} placeholder="可粘贴教材要点、题目或家长的补充说明" rows={3} /></label>
        <label>来源自学会话 ID（可选）<input inputMode="numeric" value={draft.sourceConversationId} onChange={(event) => change('sourceConversationId', event.target.value)} disabled={submitting} /></label>
        <label className="courseware-image-toggle"><input type="checkbox" checked={draft.includeImages} onChange={(event) => change('includeImages', event.target.checked)} disabled={submitting} />生成教学配图</label>
        {error && <p className="form-error courseware-form-wide" role="alert">{error}</p>}
        <div className="courseware-form-actions courseware-form-wide"><button className="btn btn-primary" type="submit" disabled={!eligible.ok || submitting}>{submitting ? '正在提交…' : '开始生成课件'}</button></div>
      </form>
    </section>
  );
}
