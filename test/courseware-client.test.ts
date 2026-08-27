import { describe, expect, it } from 'vitest';
import {
  CoursewareOperationGuard,
  CoursewareItemsCoordinator,
  CoursewarePollChain,
  CoursewareRequestEpoch,
  applyPollingUpdates,
  buildCoursewareCreatePayload,
  canCreateCourseware,
  generationStageLabel,
  mergeCoursewarePage,
  pollDelay,
  shouldPollCourseware,
  updateCoursewareList,
  type CoursewareReadiness,
} from '../src/client/lib/courseware';
import type { CoursewareStatus, CoursewareSummary } from '../src/shared/courseware';

function readiness(patch: Partial<CoursewareReadiness> = {}): CoursewareReadiness {
  return {
    featureEnabled: true,
    text: 'ready',
    teacherSpeech: 'ready',
    studentSpeech: 'ready',
    image: 'disabled',
    ...patch,
  };
}

function summary(id: number, status: CoursewareStatus, updatedAt = '2026-08-26T00:00:00.000Z'): CoursewareSummary {
  return {
    id,
    studentId: 1,
    title: `课件 ${id}`,
    subject: '数学',
    topic: '认识二分之一',
    status,
    generationStage: status === 'ready' ? 'ready' : status === 'failed' ? 'failed' : 'queued',
    progressPercent: status === 'ready' ? 100 : 0,
    requiredAudioReadyCount: 0,
    requiredAudioTotalCount: 0,
    retryable: status === 'failed',
    imageRetryAvailable: false,
    errorCode: '',
    errorMessage: '',
    warnings: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('courseware library helpers', () => {
  it('blocks creation for feature, configuration, credential, quota, and requested-image problems', () => {
    expect(canCreateCourseware(readiness({ featureEnabled: false }))).toEqual({ ok: false, reason: '课件功能尚未开放' });
    expect(canCreateCourseware(readiness({ text: 'unconfigured' }))).toEqual({ ok: false, reason: '请先配置课件脚本模型和密钥' });
    expect(canCreateCourseware(readiness({ teacherSpeech: 'unconfigured' }))).toEqual({ ok: false, reason: '请先配置老师语音模型、音色和密钥' });
    expect(canCreateCourseware(readiness({ studentSpeech: 'unconfigured' }))).toEqual({ ok: false, reason: '请先配置 AI 同学语音模型、音色和密钥' });
    expect(canCreateCourseware(readiness({ text: 'quota_exhausted' }))).toEqual({ ok: false, reason: '模型套餐额度已用完，请续费或更换个人密钥' });
    expect(canCreateCourseware(readiness({ text: 'invalid_credential' }))).toEqual({ ok: false, reason: '课件脚本模型密钥无效，请重新配置并测试' });
    expect(canCreateCourseware(readiness({ teacherSpeech: 'invalid_credential' }))).toEqual({ ok: false, reason: '老师语音服务密钥无效，请重新配置并测试' });
    expect(canCreateCourseware(readiness({ image: 'invalid_credential' }), true)).toEqual({ ok: false, reason: '配图模型密钥无效，请重新配置并测试' });
    expect(canCreateCourseware(readiness({ image: 'unconfigured' }), true)).toEqual({ ok: false, reason: '请先配置配图模型和密钥，或关闭教学配图' });
    expect(canCreateCourseware(readiness({ image: 'quota_exhausted' }), true)).toEqual({ ok: false, reason: '模型套餐额度已用完，请续费或更换个人密钥' });
  });

  it('polls only jobs that may advance and uses the documented cumulative schedule', () => {
    expect(shouldPollCourseware('queued')).toBe(true);
    expect(shouldPollCourseware('generating')).toBe(true);
    expect(shouldPollCourseware('ready')).toBe(false);
    expect(shouldPollCourseware('failed', false)).toBe(false);
    expect(shouldPollCourseware('failed', true)).toBe(false);
    expect(pollDelay(0)).toBe(2_000);
    expect(pollDelay(14)).toBe(2_000);
    expect(pollDelay(15)).toBe(5_000);
    expect(pollDelay(68)).toBe(5_000);
    expect(pollDelay(69)).toBe(15_000);
  });

  it('keeps the incoming order while de-duplicating cursor pages and merges updates by id', () => {
    const older = summary(1, 'queued', '2026-08-26T00:00:00.000Z');
    const newer = summary(2, 'ready', '2026-08-26T01:00:00.000Z');
    expect(updateCoursewareList([older], { ...older, status: 'ready', generationStage: 'ready', progressPercent: 100 }))
      .toEqual([{ ...older, status: 'ready', generationStage: 'ready', progressPercent: 100 }]);
    expect(mergeCoursewarePage([newer], [newer, older])).toEqual([newer, older]);
  });

  it('uses child-readable stage labels', () => {
    expect(generationStageLabel('scripting')).toBe('正在编写课程');
    expect(generationStageLabel('speech')).toBe('正在生成老师和 AI 同学语音');
    expect(generationStageLabel('images')).toBe('正在准备配图');
  });

  it('whitelists only backend-accepted create fields', () => {
    expect(buildCoursewareCreatePayload({
      subject: ' 数学 ', topic: ' 分数 ', learningGoal: ' 学会比较分数 ', sourceText: '教材节选', sourceConversationId: 7,
      includeImages: true, userId: 99, baseUrl: 'https://example.com', apiKey: 'secret', snapshot: { model: 'private' },
    } as Parameters<typeof buildCoursewareCreatePayload>[0])).toEqual({ subject: '数学', topic: '分数', learningGoal: '学会比较分数', sourceText: '教材节选', sourceConversationId: 7, includeImages: true });
  });

  it('rejects a stale poll or delete result after its route epoch has changed', () => {
    const epoch = new CoursewareRequestEpoch();
    const poll = epoch.begin();
    const deletion = epoch.begin();
    expect(epoch.isCurrent(poll)).toBe(false);
    expect(epoch.isCurrent(deletion)).toBe(true);
    epoch.dispose();
    expect(epoch.isCurrent(deletion)).toBe(false);
  });

  it('keeps exactly one cancellable polling chain across state updates and focus resets', async () => {
    const scheduled = new Map<number, () => void>();
    const cleared: number[] = [];
    let nextTimer = 0;
    const host = {
      setTimeout(callback: () => void) { const id = ++nextTimer; scheduled.set(id, callback); return id; },
      clearTimeout(id: number) { cleared.push(id); scheduled.delete(id); },
    };
    let active = true;
    const completions: Array<() => void> = [];
    const chain = new CoursewarePollChain(host, () => active, () => new Promise<void>((resolve) => completions.push(resolve)));

    chain.start();
    expect(scheduled.size).toBe(1);
    [...scheduled.values()][0]!();
    chain.resetForFocus();
    expect(cleared).toHaveLength(1);
    expect(completions).toHaveLength(1);
    chain.resetForFocus();
    chain.resetForFocus();
    expect(completions).toHaveLength(1);
    completions[0]!();
    await Promise.resolve();
    expect(completions).toHaveLength(2);
    completions[1]!();
    await Promise.resolve();
    expect(scheduled.size).toBe(1);
    active = false;
    [...scheduled.values()][0]!();
    await Promise.resolve();
    expect(scheduled.size).toBe(0);
  });

  it('keeps route changes separate from independent mutations and tombstones deleted rows', () => {
    const route = new CoursewareRequestEpoch();
    const operations = new CoursewareOperationGuard();
    const routeA = route.begin();
    const deleteRequest = operations.begin('delete:1');
    const loadMore = operations.begin('load-more');
    const routeB = route.begin();
    expect(route.isCurrent(routeA)).toBe(false);
    expect(route.isCurrent(routeB)).toBe(true);
    expect(operations.isCurrent('delete:1', deleteRequest)).toBe(true);
    expect(operations.isCurrent('load-more', loadMore)).toBe(true);
    const list = [summary(1, 'generating'), summary(2, 'ready')];
    expect(applyPollingUpdates(list, [{ ...summary(1, 'ready'), generationStage: 'ready' }], new Set([1])))
      .toEqual([summary(2, 'ready')]);
  });

  it('continues polling when an otherwise ready lesson retries optional images', () => {
    expect(shouldPollCourseware({ ...summary(8, 'ready'), generationStage: 'images' })).toBe(true);
    expect(shouldPollCourseware({ ...summary(8, 'ready'), generationStage: 'ready' })).toBe(false);
  });

  it('wakes only after each idle to active entry commits its next list', () => {
    let wakes = 0;
    const coordinator = new CoursewareItemsCoordinator(() => { wakes += 1; });
    const queued = summary(1, 'queued');
    coordinator.commit([queued]); // initial load
    coordinator.commit([]);
    coordinator.commit([queued]); // create
    coordinator.commit([{ ...summary(2, 'failed'), retryable: true }]);
    coordinator.commit([{ ...summary(2, 'generating'), generationStage: 'speech' }]); // full retry
    coordinator.commit([summary(3, 'ready')]);
    coordinator.commit([{ ...summary(3, 'ready'), generationStage: 'images' }]); // image retry
    expect(wakes).toBe(4);
  });
});
