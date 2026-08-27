import type {
  AIModelOption,
  AIProviderCatalogItem,
  AIVoiceOption,
  CoursewareModelPreference,
  CoursewareModelPurpose,
} from '../../shared/ai-catalog';

export interface CoursewareSelectionDraft {
  endpointId: number;
  modelCatalogId: number | null;
  customModelId: string;
  voiceId: string;
  params: Record<string, unknown>;
}

export interface CoursewareSettingsDraft {
  includeImages: boolean;
  text: CoursewareSelectionDraft;
  image: CoursewareSelectionDraft | null;
  teacherSpeech: CoursewareSelectionDraft;
  studentSpeech: CoursewareSelectionDraft;
  catalog: AIProviderCatalogItem[];
}

const purposeCapability: Record<CoursewareModelPurpose, AIModelOption['capability']> = {
  courseware_text: 'structured_text',
  courseware_image: 'image_generation',
  teacher_tts: 'speech_synthesis',
  student_tts: 'speech_synthesis',
};

export function buildCredentialPatch(value: string | null): { apiKey: string | null } {
  if (value === null) return { apiKey: null };
  const apiKey = value.trim();
  if (!apiKey || /[•*]{3,}/.test(apiKey)) throw new Error('请输入完整的 API Key');
  return { apiKey };
}

export function modelsForPurpose(
  catalog: AIProviderCatalogItem[],
  purpose: CoursewareModelPurpose,
): AIModelOption[] {
  return catalog.flatMap((provider) =>
    provider.models.filter((model) => model.capability === purposeCapability[purpose]),
  );
}

export function voicesForModel(
  catalog: AIProviderCatalogItem[],
  modelCatalogId: number,
): AIVoiceOption[] {
  for (const provider of catalog) {
    const model = provider.models.find((item) => item.id === modelCatalogId);
    if (model) return model.voices;
  }
  return [];
}

function selectedModel(
  catalog: AIProviderCatalogItem[],
  selection: CoursewareSelectionDraft,
  purpose: CoursewareModelPurpose,
): AIModelOption | null {
  if (selection.modelCatalogId === null) {
    if (purpose !== 'courseware_text') return null;
    const endpoint = catalog.flatMap((provider) => provider.models)
      .find((model) => model.endpointId === selection.endpointId && model.allowCustomModelId);
    if (!endpoint || endpoint.capability !== purposeCapability[purpose] || !selection.customModelId.trim()) {
      return null;
    }
    return endpoint;
  }
  const model = catalog.flatMap((provider) => provider.models)
    .find((item) => item.id === selection.modelCatalogId && item.endpointId === selection.endpointId);
  return model?.capability === purposeCapability[purpose] ? model : null;
}

function preferenceFor(
  draft: CoursewareSettingsDraft,
  purpose: CoursewareModelPurpose,
  selection: CoursewareSelectionDraft,
): CoursewareModelPreference {
  const model = selectedModel(draft.catalog, selection, purpose);
  if (!model) throw new Error('请先选择兼容的模型');
  const voiceId = selection.voiceId.trim();
  if (purpose === 'teacher_tts' || purpose === 'student_tts') {
    if (!model.voices.some((voice) => voice.id === voiceId)) {
      throw new Error('音色与所选语音模型不兼容');
    }
  } else if (voiceId) {
    throw new Error('当前模型不支持音色设置');
  }
  return {
    purpose,
    endpointId: model.endpointId,
    modelCatalogId: selection.modelCatalogId,
    customModelId: selection.modelCatalogId === null ? selection.customModelId.trim() : '',
    voiceId,
    params: selection.params,
  };
}

export function buildCoursewarePreferences(
  draft: CoursewareSettingsDraft,
): { preferences: CoursewareModelPreference[] } {
  const preferences = [
    preferenceFor(draft, 'courseware_text', draft.text),
    ...(draft.includeImages
      ? [preferenceFor(draft, 'courseware_image', draft.image ?? invalidImageSelection())]
      : []),
    preferenceFor(draft, 'teacher_tts', draft.teacherSpeech),
    preferenceFor(draft, 'student_tts', draft.studentSpeech),
  ];
  return { preferences };
}

function invalidImageSelection(): CoursewareSelectionDraft {
  return { endpointId: 0, modelCatalogId: null, customModelId: '', voiceId: '', params: {} };
}
