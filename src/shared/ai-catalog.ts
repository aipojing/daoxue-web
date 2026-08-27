export type AICapability = 'structured_text' | 'speech_synthesis' | 'image_generation';

export type CoursewareModelPurpose =
  | 'courseware_text'
  | 'courseware_image'
  | 'teacher_tts'
  | 'student_tts';

export interface AIVoiceOption {
  id: string;
  name: string;
  recommendedRole?: 'teacher' | 'student';
}

export interface AIModelOption {
  id: number;
  endpointId: number;
  capability: AICapability;
  modelId: string;
  displayName: string;
  config: Record<string, unknown>;
  voices: AIVoiceOption[];
  recommended: boolean;
}

export interface AIProviderCatalogItem {
  id: number;
  slug: string;
  displayName: string;
  capabilities: AICapability[];
  models: AIModelOption[];
}

export interface CoursewareModelPreference {
  purpose: CoursewareModelPurpose;
  endpointId: number;
  modelCatalogId: number | null;
  customModelId: string;
  voiceId: string;
  params: Record<string, unknown>;
}

export interface CoursewareAISettings {
  featureEnabled: boolean;
  providers: Array<{
    providerId: number;
    keySet: boolean;
    keyTail: string;
    healthStatus: 'unknown' | 'valid' | 'invalid' | 'quota_exhausted';
    healthCheckedAt: string | null;
  }>;
  preferences: CoursewareModelPreference[];
  readiness: {
    text: 'ready' | 'unconfigured' | 'invalid_credential' | 'quota_exhausted';
    teacherSpeech: 'ready' | 'unconfigured' | 'invalid_credential' | 'quota_exhausted';
    studentSpeech: 'ready' | 'unconfigured' | 'invalid_credential' | 'quota_exhausted';
    image: 'disabled' | 'ready' | 'unconfigured' | 'invalid_credential' | 'quota_exhausted';
  };
}
