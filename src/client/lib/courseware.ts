import type { CoursewareAISettings } from '../../shared/ai-catalog';
import type { CoursewareGenerationStage, CoursewareStatus, CoursewareSummary } from '../../shared/courseware';

export interface CoursewareReadiness {
  featureEnabled: boolean;
  text: CoursewareAISettings['readiness']['text'];
  teacherSpeech: CoursewareAISettings['readiness']['teacherSpeech'];
  studentSpeech: CoursewareAISettings['readiness']['studentSpeech'];
  image: CoursewareAISettings['readiness']['image'];
}

export interface CoursewareCreateDraft {
  subject: string;
  topic: string;
  learningGoal: string;
  sourceText: string;
  sourceConversationId: string;
  includeImages: boolean;
}

export interface CoursewareCreatePayload {
  subject: string;
  topic: string;
  learningGoal: string;
  sourceText?: string;
  sourceConversationId?: number;
  includeImages: boolean;
}

export function canCreateCourseware(readiness: CoursewareReadiness, includeImages = false): { ok: true } | { ok: false; reason: string } {
  if (!readiness.featureEnabled) return { ok: false, reason: '课件功能尚未开放' };
  const values = [readiness.text, readiness.teacherSpeech, readiness.studentSpeech, ...(includeImages ? [readiness.image] : [])];
  if (values.includes('quota_exhausted')) return { ok: false, reason: '模型套餐额度已用完，请续费或更换个人密钥' };
  if (values.includes('invalid_credential')) return { ok: false, reason: '语音服务密钥无效，请重新配置并测试' };
  if (readiness.text !== 'ready') return { ok: false, reason: '请先配置课件脚本模型和密钥' };
  if (readiness.teacherSpeech !== 'ready') return { ok: false, reason: '请先配置老师语音模型、音色和密钥' };
  if (readiness.studentSpeech !== 'ready') return { ok: false, reason: '请先配置 AI 同学语音模型、音色和密钥' };
  if (includeImages && readiness.image !== 'ready') return { ok: false, reason: '请先配置配图模型和密钥，或关闭教学配图' };
  return { ok: true };
}

export function shouldPollCourseware(status: CoursewareStatus, _retryable = false): boolean {
  return status === 'queued' || status === 'generating';
}

export function generationStageLabel(stage: CoursewareGenerationStage): string {
  const labels: Record<CoursewareGenerationStage, string> = {
    queued: '正在排队准备', scripting: '正在编写课程', speech: '正在生成老师和 AI 同学语音',
    images: '正在准备配图', finalizing: '正在整理课件', ready: '课件已准备好', failed: '生成遇到问题',
  };
  return labels[stage];
}

export function pollDelay(attempt: number): number {
  if (attempt <= 14) return 2_000;
  if (attempt <= 68) return 5_000;
  return 15_000;
}

export function updateCoursewareList(list: CoursewareSummary[], update: CoursewareSummary): CoursewareSummary[] {
  return list.map((item) => item.id === update.id ? update : item);
}

export function mergeCoursewarePage(current: CoursewareSummary[], incoming: CoursewareSummary[]): CoursewareSummary[] {
  const byId = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !byId.has(item.id))];
}

export function buildCoursewareCreatePayload(draft: CoursewareCreateDraft): CoursewareCreatePayload {
  const payload: CoursewareCreatePayload = {
    subject: draft.subject.trim(),
    topic: draft.topic.trim(),
    learningGoal: draft.learningGoal.trim(),
    includeImages: draft.includeImages,
  };
  const sourceText = draft.sourceText.trim();
  if (sourceText) payload.sourceText = sourceText;
  const sourceConversationId = Number(draft.sourceConversationId);
  if (/^\d+$/.test(draft.sourceConversationId) && Number.isSafeInteger(sourceConversationId) && sourceConversationId > 0) {
    payload.sourceConversationId = sourceConversationId;
  }
  return payload;
}

/** A monotonically increasing guard for work that must not overwrite a newer route or mutation. */
export class CoursewareRequestEpoch {
  private value = 0;
  private disposed = false;

  begin(): number {
    this.disposed = false;
    this.value += 1;
    return this.value;
  }

  isCurrent(token: number): boolean {
    return !this.disposed && token === this.value;
  }

  dispose(): void {
    this.disposed = true;
    this.value += 1;
  }
}
