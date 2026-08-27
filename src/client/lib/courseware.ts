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
  const required = [readiness.text, readiness.teacherSpeech, readiness.studentSpeech, ...(includeImages ? [readiness.image] : [])];
  if (required.includes('quota_exhausted')) return { ok: false, reason: '模型套餐额度已用完，请续费或更换个人密钥' };
  if (readiness.text === 'invalid_credential') return { ok: false, reason: '课件脚本模型密钥无效，请重新配置并测试' };
  if (readiness.text !== 'ready') return { ok: false, reason: '请先配置课件脚本模型和密钥' };
  if (readiness.teacherSpeech === 'invalid_credential') return { ok: false, reason: '老师语音服务密钥无效，请重新配置并测试' };
  if (readiness.teacherSpeech !== 'ready') return { ok: false, reason: '请先配置老师语音模型、音色和密钥' };
  if (readiness.studentSpeech === 'invalid_credential') return { ok: false, reason: 'AI 同学语音服务密钥无效，请重新配置并测试' };
  if (readiness.studentSpeech !== 'ready') return { ok: false, reason: '请先配置 AI 同学语音模型、音色和密钥' };
  if (includeImages && readiness.image !== 'ready') {
    if (readiness.image === 'invalid_credential') return { ok: false, reason: '配图模型密钥无效，请重新配置并测试' };
    return { ok: false, reason: '请先配置配图模型和密钥，或关闭教学配图' };
  }
  return { ok: true };
}

export function shouldPollCourseware(
  courseware: CoursewareStatus | Pick<CoursewareSummary, 'status' | 'generationStage'>,
  _retryable = false,
): boolean {
  if (typeof courseware === 'string') return courseware === 'queued' || courseware === 'generating';
  return courseware.status === 'queued' || courseware.status === 'generating'
    || (courseware.status === 'ready' && courseware.generationStage === 'images');
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

  capture(): number { return this.value; }

  isCurrent(token: number): boolean {
    return !this.disposed && token === this.value;
  }

  dispose(): void {
    this.disposed = true;
    this.value += 1;
  }
}

export class CoursewareOperationGuard {
  private readonly versions = new Map<string, number>();
  private disposed = false;

  begin(operation: string): number {
    this.disposed = false;
    const version = (this.versions.get(operation) ?? 0) + 1;
    this.versions.set(operation, version);
    return version;
  }

  isCurrent(operation: string, token: number): boolean {
    return !this.disposed && this.versions.get(operation) === token;
  }

  dispose(): void { this.disposed = true; this.versions.clear(); }
}

export function applyPollingUpdates(
  list: CoursewareSummary[], updates: Array<CoursewareSummary | null>, tombstones: ReadonlySet<number>,
): CoursewareSummary[] {
  return updates.reduce(
    (current, update) => update && !tombstones.has(update.id) ? updateCoursewareList(current, update) : current,
    list.filter((item) => !tombstones.has(item.id)),
  );
}

export class CoursewareItemsCoordinator {
  private items: CoursewareSummary[] = [];
  constructor(private readonly onWake: () => void) {}
  current(): CoursewareSummary[] { return this.items; }
  commit(next: CoursewareSummary[], wakeOnTransition = true): CoursewareSummary[] {
    const wasActive = this.items.some((item) => shouldPollCourseware(item));
    this.items = next;
    if (wakeOnTransition && !wasActive && next.some((item) => shouldPollCourseware(item))) this.onWake();
    return next;
  }
}

interface CoursewareTimerHost {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
}

/** Owns one timer and rejects settlements from replaced focus or route chains. */
export class CoursewarePollChain {
  private timer: number | null = null;
  private generation = 0;
  private attempt = 0;
  private running = false;
  private inFlight = false;
  private wakeRequested = false;

  constructor(
    private readonly host: CoursewareTimerHost,
    private readonly hasActiveCourseware: () => boolean,
    private readonly poll: () => Promise<void>,
  ) {}

  start(): void { this.running = true; this.schedule(); }

  wake(): void {
    if (!this.running) return;
    if (this.inFlight) { this.wakeRequested = true; return; }
    this.generation += 1; this.clearTimer(); this.run(this.generation);
  }

  resetForFocus(): void {
    this.attempt = 0;
    this.wake();
  }

  stop(): void { this.running = false; this.generation += 1; this.wakeRequested = false; this.clearTimer(); }

  private clearTimer(): void {
    if (this.timer !== null) this.host.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running || !this.hasActiveCourseware() || this.timer !== null) return;
    const generation = this.generation;
    this.timer = this.host.setTimeout(() => {
      const timer = this.timer;
      this.timer = null;
      if (timer !== null) this.host.clearTimeout(timer);
      if (!this.running || generation !== this.generation) return;
      this.attempt += 1;
      this.run(generation);
    }, pollDelay(this.attempt));
  }

  private run(generation: number): void {
    if (!this.running || this.inFlight || generation !== this.generation || !this.hasActiveCourseware()) return;
    this.inFlight = true;
    void this.poll().catch(() => undefined).finally(() => {
      this.inFlight = false;
      if (!this.running || generation !== this.generation) return;
      if (this.wakeRequested) { this.wakeRequested = false; this.generation += 1; this.run(this.generation); return; }
      this.schedule();
    });
  }
}
