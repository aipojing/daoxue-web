import { useRef, useState } from 'react';
import { apiPost, ApiError } from '../api';
import type { CoursewareSummary } from '../../shared/courseware';
import { generationStageLabel } from '../lib/courseware';

interface Props {
  courseware: CoursewareSummary;
  onQueued: () => void;
  routeToken: number;
  isRouteCurrent: (token: number) => boolean;
  routeSignal: AbortSignal;
}

export default function CoursewareGenerationStatus({ courseware, onQueued, routeToken, isRouteCurrent, routeSignal }: Props) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'retry' | 'images' | null>(null);
  const pendingRef = useRef(false);
  const retry = async (kind: 'retry' | 'images') => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(kind);
    setError('');
    try {
      await apiPost(`/api/coursewares/${courseware.id}${kind === 'images' ? '/images/retry' : '/retry'}`, undefined, { signal: routeSignal });
      if (!isRouteCurrent(routeToken) || routeSignal.aborted) return;
      onQueued();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '操作未完成，请稍后重试');
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };
  const active = courseware.status === 'queued' || courseware.status === 'generating'
    || (courseware.status === 'ready' && courseware.generationStage === 'images');
  const imageOnlyRetry = courseware.status === 'ready' && courseware.generationStage === 'images';
  return (
    <div className="courseware-generation-status" aria-live="polite">
      <p className="courseware-stage"><strong>{imageOnlyRetry ? '课件已可上课，正在补充配图' : generationStageLabel(courseware.generationStage)}</strong>{active && !imageOnlyRetry && <span> {courseware.progressPercent}%</span>}</p>
      {active && !imageOnlyRetry && <><div className="courseware-progress" aria-label={`生成进度 ${courseware.progressPercent}%`}><span style={{ width: `${courseware.progressPercent}%` }} /></div><p>必需语音：已完成 {courseware.requiredAudioReadyCount} / {courseware.requiredAudioTotalCount}。老师语音和 AI 同学语音完成后才能上课。可以离开，后台会继续。</p></>}
      {imageOnlyRetry && <p>必需语音：已完成 {courseware.requiredAudioReadyCount} / {courseware.requiredAudioTotalCount}。课件已可继续上课，可以离开，后台会继续补充配图。</p>}
      {courseware.warnings.length > 0 && <p className="courseware-warning">配图提醒：{courseware.warnings.join('；')}</p>}
      {courseware.status === 'failed' && <p className="courseware-error" role="alert">{courseware.errorMessage || '生成未完成，请检查配置后重试。'}</p>}
      {error && <p className="courseware-error" role="alert">{error}</p>}
      <div className="courseware-status-actions">
        {courseware.status === 'failed' && courseware.retryable && <button type="button" className="btn btn-sm" disabled={pending !== null} onClick={() => void retry('retry')}>{pending === 'retry' ? '正在重新提交…' : '重新生成课件'}</button>}
        {courseware.status === 'ready' && courseware.imageRetryAvailable && <button type="button" className="btn btn-sm" disabled={pending !== null} onClick={() => void retry('images')}>{pending === 'images' ? '正在重试配图…' : '重试失败配图'}</button>}
      </div>
    </div>
  );
}
