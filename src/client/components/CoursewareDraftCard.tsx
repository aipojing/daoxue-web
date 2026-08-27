import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CoursewareAISettings } from '../../shared/ai-catalog';
import type { CoursewareSummary } from '../../shared/courseware';
import { apiPost, ApiError } from '../api';
import type { CoursewareSettingsState } from '../lib/chat';
import { canCreateCourseware } from '../lib/courseware';
import type { SelfLearnCoursewareDraft } from '../types';

interface Props {
  studentId: number;
  sourceConversationId: number;
  draft: SelfLearnCoursewareDraft;
  settings: CoursewareAISettings | null;
  settingsState: CoursewareSettingsState;
}

export function buildCoursewareDraftCreateRequest(
  studentId: number,
  sourceConversationId: number,
  draft: SelfLearnCoursewareDraft,
  includeImages: boolean,
) {
  return {
    path: `/api/students/${studentId}/coursewares`,
    body: { ...draft, sourceConversationId, includeImages },
  };
}

function initialImagePreference(settings: CoursewareAISettings): boolean {
  return settings.readiness.image === 'ready'
    && settings.preferences.some((preference) => preference.purpose === 'courseware_image');
}

export default function CoursewareDraftCard({
  studentId, sourceConversationId, draft, settings, settingsState,
}: Props) {
  const navigate = useNavigate();
  const [includeImages, setIncludeImages] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submittingRef = useRef(false);

  useEffect(() => {
    if (settingsState === 'ready' && settings) setIncludeImages(initialImagePreference(settings));
  }, [settings, settingsState]);

  const loading = settingsState === 'loading';
  const readiness = settingsState === 'ready' && settings
    ? { featureEnabled: settings.featureEnabled, ...settings.readiness }
    : null;
  const eligible = readiness ? canCreateCourseware(readiness, includeImages) : null;

  const create = async () => {
    if (!eligible?.ok || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      const request = buildCoursewareDraftCreateRequest(studentId, sourceConversationId, draft, includeImages);
      const created = await apiPost<CoursewareSummary>(request.path, request.body);
      navigate(`/students/${studentId}/coursewares/${created.id}`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '课件创建失败，请稍后重试');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <section className="courseware-draft-card" aria-label="语音课件任务">
      <p className="courseware-eyebrow">课程已准备好</p>
      <h3>{draft.topic}</h3>
      <dl>
        <div><dt>学科</dt><dd>{draft.subject}</dd></div>
        <div><dt>学习目标</dt><dd>{draft.learningGoal}</dd></div>
      </dl>
      <label className="courseware-image-toggle">
        <input type="checkbox" checked={includeImages} disabled={loading || submitting || settings?.readiness.image !== 'ready'}
          onChange={(event) => setIncludeImages(event.target.checked)} />
        生成教学配图
      </label>
      {loading && <p className="courseware-config-note" role="status">正在读取课件配置…</p>}
      {settingsState === 'error' && <p className="form-error" role="alert">无法读取课件配置，请重试</p>}
      {eligible && !eligible.ok && !loading && <p className="courseware-config-note" role="status">{eligible.reason} <Link to="/ai-settings">前往 AI 服务</Link></p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="button" className="btn btn-primary" disabled={!eligible?.ok || submitting}
        onClick={() => void create()}>{submitting ? '正在生成…' : '生成语音课件'}</button>
    </section>
  );
}
