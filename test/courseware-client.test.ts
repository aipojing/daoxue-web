import { describe, expect, it } from 'vitest';
import {
  CoursewareRequestEpoch,
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
    expect(canCreateCourseware(readiness({ teacherSpeech: 'invalid_credential' }))).toEqual({ ok: false, reason: '语音服务密钥无效，请重新配置并测试' });
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
});
