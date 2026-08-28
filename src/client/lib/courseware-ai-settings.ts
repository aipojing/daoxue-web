import type {
  AIModelOption,
  AIProviderCatalogItem,
  AIVoiceOption,
  CoursewareAISettings,
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

/**
 * Tracks the latest request per independent UI scope. A stale response is never
 * allowed to update a mounted settings card, even if it resolves after a newer request.
 */
export class CoursewareRequestGuard {
  private active = true;
  private epochs = new Map<string, number>();

  begin(scope: string): number {
    const token = (this.epochs.get(scope) ?? 0) + 1;
    this.epochs.set(scope, token);
    return token;
  }

  invalidate(scope: string): void {
    this.begin(scope);
  }

  isCurrent(scope: string, token: number): boolean {
    return this.active && this.epochs.get(scope) === token;
  }

  dispose(): void {
    this.active = false;
    this.epochs.clear();
  }
}

/**
 * Keeps settings reads behind successful writes. A refresh captures the current
 * revision and may apply only if no write has started or committed since then.
 */
export class CoursewareSettingsRevision {
  private revision = 0;

  beginWrite(): number {
    this.revision += 1;
    return this.revision;
  }

  captureRefresh(): number {
    return this.revision;
  }

  commitWrite(writeRevision: number): boolean {
    this.revision += 1;
    return true;
  }

  isRefreshCurrent(refreshRevision: number): boolean {
    return refreshRevision === this.revision;
  }
}

export class CoursewareSettingsReadEpoch {
  private epoch = 0;

  begin(): number {
    this.epoch += 1;
    return this.epoch;
  }

  invalidate(): void {
    this.epoch += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.epoch;
  }
}

export function shouldClearSettingsSyncStatus(hasPendingWrites: boolean): boolean {
  return !hasPendingWrites;
}

export class CoursewareSettingsWriteTracker {
  private nextId = 1;
  private pending = new Set<number>();
  private needsRefresh = false;

  begin(): number {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.add(id);
    this.needsRefresh = true;
    return id;
  }

  settle(id: number, _succeeded: boolean): boolean {
    this.pending.delete(id);
    if (this.pending.size !== 0 || !this.needsRefresh) return false;
    this.needsRefresh = false;
    return true;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  retryRefresh(): void {
    this.needsRefresh = true;
  }
}

export function mergeCredentialSettings(
  current: CoursewareAISettings,
  snapshot: CoursewareAISettings,
  providerId: number,
): CoursewareAISettings {
  const provider = snapshot.providers.find((item) => item.providerId === providerId);
  if (!provider) return current;
  return {
    ...current,
    providers: current.providers.map((item) => item.providerId === providerId ? provider : item),
  };
}

export function mergePreferenceSettings(
  current: CoursewareAISettings,
  snapshot: CoursewareAISettings,
): CoursewareAISettings {
  return { ...current, preferences: snapshot.preferences };
}

export function applyCurrentRequestResult(
  guard: CoursewareRequestGuard,
  scope: string,
  token: number,
  apply: () => void,
): boolean {
  if (!guard.isCurrent(scope, token)) return false;
  apply();
  return true;
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

function defaultSelectionForPurpose(
  settings: CoursewareAISettings,
  catalog: AIProviderCatalogItem[],
  purpose: CoursewareModelPurpose,
): CoursewareSelectionDraft {
  const saved = settings.preferences.find((preference) => preference.purpose === purpose);
  if (saved) {
    return {
      endpointId: saved.endpointId,
      modelCatalogId: saved.modelCatalogId,
      customModelId: saved.customModelId,
      voiceId: saved.voiceId,
      params: { ...saved.params },
    };
  }
  const model = modelsForPurpose(catalog, purpose).find((candidate) => candidate.recommended)
    ?? modelsForPurpose(catalog, purpose)[0];
  if (!model) return { endpointId: 0, modelCatalogId: null, customModelId: '', voiceId: '', params: {} };
  const recommendedRole = purpose === 'teacher_tts' ? 'teacher' : purpose === 'student_tts' ? 'student' : undefined;
  const voice = recommendedRole
    ? model.voices.find((candidate) => candidate.recommendedRole === recommendedRole) ?? model.voices[0]
    : undefined;
  return {
    endpointId: model.endpointId,
    modelCatalogId: model.id,
    customModelId: '',
    voiceId: voice?.id ?? '',
    params: {},
  };
}

export function createCoursewareSettingsDraft(
  settings: CoursewareAISettings,
  catalog: AIProviderCatalogItem[],
): CoursewareSettingsDraft {
  return {
    includeImages: settings.preferences.some((preference) => preference.purpose === 'courseware_image'),
    text: defaultSelectionForPurpose(settings, catalog, 'courseware_text'),
    image: defaultSelectionForPurpose(settings, catalog, 'courseware_image'),
    teacherSpeech: defaultSelectionForPurpose(settings, catalog, 'teacher_tts'),
    studentSpeech: defaultSelectionForPurpose(settings, catalog, 'student_tts'),
    catalog,
  };
}

export function validateCoursewareSelectionCredentials(
  settings: CoursewareAISettings,
  catalog: AIProviderCatalogItem[],
  selections: CoursewareModelPreference[],
): string {
  for (const selection of selections) {
    const provider = catalog.find((candidate) =>
      candidate.models.some((model) => model.endpointId === selection.endpointId));
    const credential = provider
      ? settings.providers.find((candidate) => candidate.providerId === provider.id)
      : undefined;
    if (!credential?.keySet) return '请先在 AI 服务中配置所选模型的服务商密钥';
    if (credential.healthStatus === 'quota_exhausted') return '所选模型的服务商额度已用完';
    if (credential.healthStatus === 'invalid') return '所选模型的服务商密钥无效';
  }
  return '';
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
