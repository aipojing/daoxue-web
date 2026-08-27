import { describe, expect, it } from 'vitest';
import {
  buildCredentialPatch,
  buildCoursewarePreferences,
  applyCurrentRequestResult,
  CoursewareRequestGuard,
  CoursewareSettingsRevision,
  modelsForPurpose,
  type CoursewareSettingsDraft,
} from '../src/client/lib/courseware-ai-settings';
import type { AIProviderCatalogItem } from '../src/shared/ai-catalog';

const catalog: AIProviderCatalogItem[] = [{
  id: 1,
  slug: 'test-provider',
  displayName: '测试服务商',
  capabilities: ['structured_text', 'speech_synthesis', 'image_generation'],
  models: [
    { id: 11, endpointId: 101, allowCustomModelId: false, capability: 'structured_text', modelId: 'text-a', displayName: '文本 A', config: {}, voices: [], recommended: true },
    { id: 12, endpointId: 102, allowCustomModelId: false, capability: 'speech_synthesis', modelId: 'speech-a', displayName: '语音 A', config: {}, voices: [{ id: 'teacher', name: '老师' }, { id: 'student', name: '同学' }], recommended: true },
    { id: 13, endpointId: 103, allowCustomModelId: false, capability: 'image_generation', modelId: 'image-a', displayName: '图片 A', config: {}, voices: [], recommended: true },
  ],
}];

const validDraft: CoursewareSettingsDraft = {
  includeImages: true,
  text: { endpointId: 101, modelCatalogId: 11, customModelId: '', voiceId: '', params: {} },
  image: { endpointId: 103, modelCatalogId: 13, customModelId: '', voiceId: '', params: {} },
  teacherSpeech: { endpointId: 102, modelCatalogId: 12, customModelId: '', voiceId: 'teacher', params: {} },
  studentSpeech: { endpointId: 102, modelCatalogId: 12, customModelId: '', voiceId: 'student', params: {} },
  catalog,
};

describe('courseware AI settings client', () => {
  it('never sends a masked key back as a credential', () => {
    expect(() => buildCredentialPatch('••••er-a')).toThrow('请输入完整的 API Key');
    expect(buildCredentialPatch('sk-new-personal-key')).toEqual({ apiKey: 'sk-new-personal-key' });
    expect(buildCredentialPatch(null)).toEqual({ apiKey: null });
  });

  it('filters model choices by purpose capability', () => {
    expect(modelsForPurpose(catalog, 'teacher_tts').map((item) => item.capability))
      .toEqual(['speech_synthesis']);
    expect(modelsForPurpose(catalog, 'courseware_image').map((item) => item.capability))
      .toEqual(['image_generation']);
  });

  it('requires separate compatible teacher and AI-student voices', () => {
    expect(() => buildCoursewarePreferences({
      ...validDraft,
      teacherSpeech: { ...validDraft.teacherSpeech, voiceId: 'missing' },
    })).toThrow('音色与所选语音模型不兼容');
    expect(buildCoursewarePreferences(validDraft).preferences.map((item) => item.purpose))
      .toEqual(['courseware_text', 'courseware_image', 'teacher_tts', 'student_tts']);
  });

  it('allows a custom ID only for a public text endpoint and omits disabled images', () => {
    const customCatalog = [{
      ...catalog[0]!,
      models: catalog[0]!.models.map((model) => ({
        ...model,
        allowCustomModelId: model.capability !== 'speech_synthesis',
      })),
    }];
    expect(buildCoursewarePreferences({
      ...validDraft,
      includeImages: false,
      catalog: customCatalog,
      text: { ...validDraft.text, modelCatalogId: null, customModelId: 'parent-text-model' },
    }).preferences.map((item) => item.purpose)).toEqual(['courseware_text', 'teacher_tts', 'student_tts']);
    expect(() => buildCoursewarePreferences({
      ...validDraft,
      catalog: customCatalog,
      image: { ...validDraft.image!, modelCatalogId: null, customModelId: 'not-allowed-for-images' },
    })).toThrow('请先选择兼容的模型');
  });

  it('keeps concurrent provider and voice requests in separate latest-intent scopes', () => {
    const guard = new CoursewareRequestGuard();
    const firstProvider = guard.begin('credential-1');
    const secondProvider = guard.begin('credential-2');
    const firstTeacherPreview = guard.begin('teacher_tts');
    const studentPreview = guard.begin('student_tts');
    const newestTeacherPreview = guard.begin('teacher_tts');

    expect(guard.isCurrent('credential-1', firstProvider)).toBe(true);
    expect(guard.isCurrent('credential-2', secondProvider)).toBe(true);
    expect(guard.isCurrent('teacher_tts', firstTeacherPreview)).toBe(false);
    expect(guard.isCurrent('teacher_tts', newestTeacherPreview)).toBe(true);
    expect(guard.isCurrent('student_tts', studentPreview)).toBe(true);
  });

  it('invalidates every outstanding result after disposal', () => {
    const guard = new CoursewareRequestGuard();
    const token = guard.begin('image');
    guard.dispose();
    expect(guard.isCurrent('image', token)).toBe(false);
  });

  it('never applies a returned media result after disposal', () => {
    const guard = new CoursewareRequestGuard();
    const token = guard.begin('image');
    let createdUrls = 0;
    guard.dispose();

    expect(applyCurrentRequestResult(guard, 'image', token, () => { createdUrls += 1; })).toBe(false);
    expect(createdUrls).toBe(0);
  });

  it('rejects a refresh that began before a successful settings write committed', () => {
    const revision = new CoursewareSettingsRevision();
    const oldRefresh = revision.captureRefresh();
    const write = revision.beginWrite();
    const refreshDuringWrite = revision.captureRefresh();

    expect(revision.isRefreshCurrent(oldRefresh)).toBe(false);
    expect(revision.commitWrite(write)).toBe(true);
    expect(revision.isRefreshCurrent(refreshDuringWrite)).toBe(false);
    expect(revision.isRefreshCurrent(revision.captureRefresh())).toBe(true);
  });
});
