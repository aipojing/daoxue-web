import type {
  AICapability,
  AIModelOption,
  AIProviderCatalogItem,
  AIVoiceOption,
  CoursewareAISettings,
  CoursewareModelPreference,
  CoursewareModelPurpose,
} from '../../shared/ai-catalog';
import type { Env } from '../env';
import { UserFacingError } from '../lib/errors';
import { resolveCredential } from './credentials';
import { preferenceListSchema, projectPublicModelConfig } from './validation';

type AdapterType = 'openai_text' | 'token_plan_tts' | 'token_plan_image';
type CredentialHealth = 'unknown' | 'valid' | 'invalid' | 'quota_exhausted';

export interface ResolvedModelSelection {
  purpose: CoursewareModelPurpose;
  providerId: number;
  providerSlug: string;
  endpointId: number;
  adapterType: AdapterType;
  baseUrl: string;
  capability: AICapability;
  modelId: string;
  voiceId: string;
  endpointConfig: Record<string, unknown>;
  modelConfig: Record<string, unknown>;
  params: Record<string, unknown>;
}

interface CatalogRow {
  provider_id: number;
  provider_slug: string;
  provider_display_name: string;
  endpoint_id: number;
  endpoint_config_json: string;
  capability: AICapability;
  model_id: number;
  external_model_id: string;
  model_display_name: string;
  model_config_json: string;
  voices_json: string;
  recommended: number;
}

interface ValidationRow {
  request_index: number;
  provider_id: number | null;
  provider_enabled: number | null;
  endpoint_id: number | null;
  endpoint_enabled: number | null;
  endpoint_capability: AICapability | null;
  endpoint_config_json: string | null;
  model_id: number | null;
  model_enabled: number | null;
  model_capability: AICapability | null;
  model_config_json: string | null;
  voices_json: string | null;
}

interface PreferenceRow {
  purpose: CoursewareModelPurpose;
  endpoint_id: number;
  provider_id: number | null;
  model_catalog_id: number | null;
  custom_model_id: string;
  voice_id: string;
  params_json: string;
}

const PURPOSE_CAPABILITY: Record<CoursewareModelPurpose, AICapability> = {
  courseware_text: 'structured_text',
  courseware_image: 'image_generation',
  teacher_tts: 'speech_synthesis',
  student_tts: 'speech_synthesis',
};

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseVoices(value: string | null): AIVoiceOption[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (voice): voice is AIVoiceOption =>
      voice !== null &&
      typeof voice === 'object' &&
      typeof (voice as { id?: unknown }).id === 'string' &&
      typeof (voice as { name?: unknown }).name === 'string',
  );
}

function includesValue(values: unknown[], candidate: unknown): boolean {
  return values.some((value) => JSON.stringify(value) === JSON.stringify(candidate));
}

function matchesParamDeclaration(value: unknown, declaration: unknown): boolean {
  if (Array.isArray(declaration)) return includesValue(declaration, value);
  if (typeof declaration === 'string') {
    if (declaration === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (['string', 'number', 'boolean'].includes(declaration)) {
      return typeof value === declaration;
    }
    return value === declaration;
  }
  if (!declaration || typeof declaration !== 'object') return value === declaration;

  const rule = declaration as Record<string, unknown>;
  if (value === null) return rule.nullable === true;
  let constrained = false;
  if (rule.type !== undefined) {
    constrained = true;
    if (rule.type === 'integer') {
      if (!(typeof value === 'number' && Number.isInteger(value))) return false;
    } else if (
      typeof rule.type !== 'string' ||
      !['string', 'number', 'boolean'].includes(rule.type) ||
      typeof value !== rule.type
    ) {
      return false;
    }
  }
  const allowedValues = Array.isArray(rule.enum)
    ? rule.enum
    : Array.isArray(rule.values)
      ? rule.values
      : null;
  if (allowedValues) {
    constrained = true;
    if (!includesValue(allowedValues, value)) return false;
  }
  const hasNumericBounds =
    typeof rule.minimum === 'number' ||
    typeof rule.maximum === 'number' ||
    typeof rule.min === 'number' ||
    typeof rule.max === 'number';
  if (hasNumericBounds) {
    constrained = true;
    if (typeof value !== 'number') return false;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    const minimum = typeof rule.minimum === 'number' ? rule.minimum : rule.min;
    const maximum = typeof rule.maximum === 'number' ? rule.maximum : rule.max;
    if (typeof minimum === 'number' && value < minimum) return false;
    if (typeof maximum === 'number' && value > maximum) return false;
  }
  const hasStringRules =
    typeof rule.minLength === 'number' ||
    typeof rule.maxLength === 'number' ||
    typeof rule.pattern === 'string';
  if (hasStringRules) {
    constrained = true;
    if (typeof value !== 'string') return false;
  }
  if (typeof value === 'string') {
    if (typeof rule.minLength === 'number' && value.length < rule.minLength) return false;
    if (typeof rule.maxLength === 'number' && value.length > rule.maxLength) return false;
    if (typeof rule.pattern === 'string') {
      try {
        if (!new RegExp(rule.pattern).test(value)) return false;
      } catch {
        return false;
      }
    }
  }
  return constrained;
}

function validateParams(
  params: Record<string, unknown>,
  endpointConfig: Record<string, unknown>,
  modelConfig: Record<string, unknown>,
): void {
  const endpointDeclarations = parseDeclarationMap(endpointConfig.allowedUserParams);
  const modelDeclarations = parseDeclarationMap(modelConfig.allowedUserParams);
  const declarations = { ...endpointDeclarations, ...modelDeclarations };
  for (const [key, value] of Object.entries(params)) {
    if (!(key in declarations) || !matchesParamDeclaration(value, declarations[key])) {
      throw new UserFacingError('模型参数不受支持', 400);
    }
  }
}

function parseDeclarationMap(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function voiceError(purpose: CoursewareModelPurpose): string {
  return purpose === 'teacher_tts'
    ? '老师音色与所选模型不兼容'
    : 'AI 同学音色与所选模型不兼容';
}

export async function getPublicCatalog(db: D1Database): Promise<AIProviderCatalogItem[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS provider_id, p.slug AS provider_slug,
              p.display_name AS provider_display_name,
              e.id AS endpoint_id, e.config_json AS endpoint_config_json, e.capability,
              m.id AS model_id, m.model_id AS external_model_id,
              m.display_name AS model_display_name,
              m.config_json AS model_config_json, m.voices_json,
              m.recommended
       FROM ai_providers p
       JOIN ai_provider_endpoints e ON e.provider_id = p.id AND e.enabled = 1
       JOIN ai_models m
         ON m.endpoint_id = e.id AND m.enabled = 1 AND m.capability = e.capability
       WHERE p.enabled = 1
       ORDER BY p.id, m.sort_order, m.id`,
    )
    .all<CatalogRow>();

  const providers = new Map<number, AIProviderCatalogItem>();
  for (const row of results) {
    let provider = providers.get(row.provider_id);
    if (!provider) {
      provider = {
        id: row.provider_id,
        slug: row.provider_slug,
        displayName: row.provider_display_name,
        capabilities: [],
        models: [],
      };
      providers.set(row.provider_id, provider);
    }
    if (!provider.capabilities.includes(row.capability)) provider.capabilities.push(row.capability);
    const model: AIModelOption = {
      id: row.model_id,
      endpointId: row.endpoint_id,
      allowCustomModelId: parseObject(row.endpoint_config_json).allowCustomModelId === true,
      capability: row.capability,
      modelId: row.external_model_id,
      displayName: row.model_display_name,
      config: projectPublicModelConfig(row.capability, parseObject(row.model_config_json)),
      voices: parseVoices(row.voices_json),
      recommended: row.recommended === 1,
    };
    provider.models.push(model);
  }
  return [...providers.values()];
}

async function validatePreferences(
  db: D1Database,
  preferences: CoursewareModelPreference[],
): Promise<void> {
  const purposes = new Set<CoursewareModelPurpose>();
  for (const preference of preferences) {
    if (purposes.has(preference.purpose)) {
      throw new UserFacingError('同一课件模型用途不能重复配置', 400);
    }
    purposes.add(preference.purpose);
  }
  if (preferences.length === 0) return;

  const request = preferences.map((preference) => ({
    endpointId: preference.endpointId,
    modelCatalogId: preference.modelCatalogId,
  }));
  const { results } = await db
    .prepare(
      `WITH requested AS (
         SELECT CAST(key AS INTEGER) AS request_index,
                CAST(json_extract(value, '$.endpointId') AS INTEGER) AS endpoint_id,
                CAST(json_extract(value, '$.modelCatalogId') AS INTEGER) AS model_catalog_id
         FROM json_each(?)
       )
       SELECT requested.request_index,
              p.id AS provider_id, p.enabled AS provider_enabled,
              e.id AS endpoint_id, e.enabled AS endpoint_enabled,
              e.capability AS endpoint_capability, e.config_json AS endpoint_config_json,
              m.id AS model_id, m.enabled AS model_enabled,
              m.capability AS model_capability, m.config_json AS model_config_json,
              m.voices_json
       FROM requested
       LEFT JOIN ai_provider_endpoints e ON e.id = requested.endpoint_id
       LEFT JOIN ai_providers p ON p.id = e.provider_id
       LEFT JOIN ai_models m
         ON m.id = requested.model_catalog_id AND m.endpoint_id = e.id
       ORDER BY requested.request_index`,
    )
    .bind(JSON.stringify(request))
    .all<ValidationRow>();

  if (results.length !== preferences.length) {
    throw new UserFacingError('模型选择无效或已停用', 400);
  }
  for (const row of results) {
    const preference = preferences[row.request_index];
    if (!preference || !row.provider_id || !row.endpoint_id) {
      throw new UserFacingError('模型选择无效或已停用', 400);
    }
    if (row.provider_enabled !== 1 || row.endpoint_enabled !== 1) {
      throw new UserFacingError('模型选择无效或已停用', 400);
    }
    const expectedCapability = PURPOSE_CAPABILITY[preference.purpose];
    if (row.endpoint_capability !== expectedCapability) {
      throw new UserFacingError('模型用途与所选能力不兼容', 400);
    }

    const endpointConfig = parseObject(row.endpoint_config_json);
    let modelConfig: Record<string, unknown> = {};
    let voices: AIVoiceOption[] = [];
    if (preference.modelCatalogId !== null) {
      if (
        row.model_id !== preference.modelCatalogId ||
        row.model_enabled !== 1 ||
        row.model_capability !== expectedCapability
      ) {
        throw new UserFacingError('模型选择无效或已停用', 400);
      }
      modelConfig = parseObject(row.model_config_json);
      voices = parseVoices(row.voices_json);
    } else if (
      endpointConfig.allowCustomModelId !== true ||
      !/^[A-Za-z0-9._:/-]{1,150}$/.test(preference.customModelId)
    ) {
      throw new UserFacingError('自定义模型 ID 无效或当前端点不允许使用', 400);
    }

    if (expectedCapability === 'speech_synthesis') {
      if (!voices.some((voice) => voice.id === preference.voiceId)) {
        throw new UserFacingError(voiceError(preference.purpose), 400);
      }
    } else if (preference.voiceId !== '') {
      throw new UserFacingError('当前模型不支持音色设置', 400);
    }
    validateParams(preference.params, endpointConfig, modelConfig);
  }
}

export async function saveUserModelPreferences(
  db: D1Database,
  userId: number,
  input: { preferences: CoursewareModelPreference[] },
): Promise<void> {
  const parsed = preferenceListSchema.parse(input);
  await validatePreferences(db, parsed.preferences);
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM user_model_preferences WHERE user_id = ?').bind(userId),
  ];
  for (const preference of parsed.preferences) {
    statements.push(
      db
        .prepare(
          `INSERT INTO user_model_preferences
           (user_id, purpose, endpoint_id, model_catalog_id, custom_model_id,
            voice_id, params_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        )
        .bind(
          userId,
          preference.purpose,
          preference.endpointId,
          preference.modelCatalogId,
          preference.customModelId,
          preference.voiceId,
          JSON.stringify(preference.params),
        ),
    );
  }
  await db.batch(statements);
}

export async function resolvePreference(
  db: D1Database,
  userId: number,
  purpose: CoursewareModelPurpose,
): Promise<ResolvedModelSelection | null> {
  const row = await db
    .prepare(
      `SELECT pref.purpose, pref.endpoint_id, pref.model_catalog_id,
              pref.custom_model_id, pref.voice_id, pref.params_json,
              p.id AS provider_id, p.slug AS provider_slug,
              e.adapter_type, e.base_url, e.capability,
              e.config_json AS endpoint_config_json,
              m.model_id, m.config_json AS model_config_json
       FROM user_model_preferences pref
       JOIN ai_provider_endpoints e ON e.id = pref.endpoint_id AND e.enabled = 1
       JOIN ai_providers p ON p.id = e.provider_id AND p.enabled = 1
       LEFT JOIN ai_models m
         ON m.id = pref.model_catalog_id AND m.endpoint_id = e.id AND m.enabled = 1
       WHERE pref.user_id = ? AND pref.purpose = ?
         AND (pref.model_catalog_id IS NULL OR m.id IS NOT NULL)`,
    )
    .bind(userId, purpose)
    .first<{
      purpose: CoursewareModelPurpose;
      endpoint_id: number;
      model_catalog_id: number | null;
      custom_model_id: string;
      voice_id: string;
      params_json: string;
      provider_id: number;
      provider_slug: string;
      adapter_type: AdapterType;
      base_url: string;
      capability: AICapability;
      endpoint_config_json: string;
      model_id: string | null;
      model_config_json: string | null;
    }>();
  if (!row || row.capability !== PURPOSE_CAPABILITY[purpose]) return null;

  const preference: CoursewareModelPreference = {
    purpose: row.purpose,
    endpointId: row.endpoint_id,
    modelCatalogId: row.model_catalog_id,
    customModelId: row.custom_model_id,
    voiceId: row.voice_id,
    params: parseObject(row.params_json),
  };
  try {
    await validatePreferences(db, [preference]);
  } catch (error) {
    if (error instanceof UserFacingError) return null;
    throw error;
  }

  return {
    purpose: row.purpose,
    providerId: row.provider_id,
    providerSlug: row.provider_slug,
    endpointId: row.endpoint_id,
    adapterType: row.adapter_type,
    baseUrl: row.base_url,
    capability: row.capability,
    modelId: row.model_catalog_id === null ? row.custom_model_id : (row.model_id as string),
    voiceId: row.voice_id,
    endpointConfig: parseObject(row.endpoint_config_json),
    modelConfig: parseObject(row.model_config_json),
    params: preference.params,
  };
}

function readinessFor(
  preference: PreferenceRow | undefined,
  providers: Map<number, CoursewareAISettings['providers'][number]>,
  resolvedPurposes: ReadonlySet<CoursewareModelPurpose>,
  credentialIntegrity: ReadonlyMap<number, 'missing' | 'valid' | 'invalid'>,
): 'ready' | 'unconfigured' | 'invalid_credential' | 'quota_exhausted' {
  if (!preference?.provider_id || !resolvedPurposes.has(preference.purpose)) return 'unconfigured';
  const provider = providers.get(preference.provider_id);
  if (!provider?.keySet) return 'unconfigured';
  const integrity = credentialIntegrity.get(preference.provider_id);
  if (integrity === 'invalid') return 'invalid_credential';
  if (integrity !== 'valid') return 'unconfigured';
  if (provider.healthStatus === 'invalid') return 'invalid_credential';
  if (provider.healthStatus === 'quota_exhausted') return 'quota_exhausted';
  return 'ready';
}

export async function getUserCoursewareAISettings(
  db: D1Database,
  env: Env,
  userId: number,
): Promise<CoursewareAISettings> {
  const [providerResult, preferenceResult, featureRow] = await Promise.all([
    db
      .prepare(
        `SELECT p.id AS provider_id, p.slug,
                c.key_ciphertext, c.key_tail, c.health_status, c.health_checked_at,
                legacy.deepseek_key_ciphertext, legacy.deepseek_key_tail
         FROM ai_providers p
         LEFT JOIN user_ai_credentials c
           ON c.provider_id = p.id AND c.user_id = ?
         LEFT JOIN user_ai_settings legacy ON legacy.user_id = ?
         WHERE p.enabled = 1
         ORDER BY p.id`,
      )
      .bind(userId, userId)
      .all<{
        provider_id: number;
        slug: string;
        key_ciphertext: string | null;
        key_tail: string | null;
        health_status: CredentialHealth | null;
        health_checked_at: string | null;
        deepseek_key_ciphertext: string | null;
        deepseek_key_tail: string | null;
      }>(),
    db
      .prepare(
        `SELECT pref.purpose, pref.endpoint_id, pref.model_catalog_id,
                pref.custom_model_id, pref.voice_id, pref.params_json,
                CASE WHEN p.enabled = 1 AND e.enabled = 1
                     AND (pref.model_catalog_id IS NULL OR m.enabled = 1)
                     THEN p.id ELSE NULL END AS provider_id
         FROM user_model_preferences pref
         LEFT JOIN ai_provider_endpoints e ON e.id = pref.endpoint_id
         LEFT JOIN ai_providers p ON p.id = e.provider_id
         LEFT JOIN ai_models m
           ON m.id = pref.model_catalog_id AND m.endpoint_id = e.id
         WHERE pref.user_id = ?
         ORDER BY CASE pref.purpose
           WHEN 'courseware_text' THEN 1
           WHEN 'courseware_image' THEN 2
           WHEN 'teacher_tts' THEN 3
           WHEN 'student_tts' THEN 4 END`,
      )
      .bind(userId)
      .all<PreferenceRow>(),
    db
      .prepare("SELECT value FROM app_settings WHERE key = 'courseware_enabled'")
      .first<{ value: string }>(),
  ]);

  const providers = providerResult.results.map((row) => {
    const legacyKeySet = row.slug === 'deepseek' && !!row.deepseek_key_ciphertext;
    const directKeySet = !!row.key_ciphertext;
    return {
      providerId: row.provider_id,
      keySet: directKeySet || legacyKeySet,
      keyTail: directKeySet
        ? (row.key_tail ?? '')
        : legacyKeySet
          ? (row.deepseek_key_tail ?? '')
          : '',
      healthStatus: row.health_status ?? 'unknown',
      healthCheckedAt: row.health_checked_at ?? null,
    } satisfies CoursewareAISettings['providers'][number];
  });
  const providerMap = new Map(providers.map((provider) => [provider.providerId, provider]));
  const preferenceByPurpose = new Map(
    preferenceResult.results.map((preference) => [preference.purpose, preference]),
  );
  const [credentialChecks, preferenceChecks] = await Promise.all([
    Promise.all(
      providers.map(async (provider) => {
        if (!provider.keySet) return [provider.providerId, 'missing'] as const;
        try {
          const resolved = await resolveCredential(db, env, userId, provider.providerId);
          return [provider.providerId, resolved ? 'valid' : 'missing'] as const;
        } catch {
          return [provider.providerId, 'invalid'] as const;
        }
      }),
    ),
    Promise.all(
      preferenceResult.results.map(
        async (preference) =>
          [
            preference.purpose,
            await resolvePreference(db, userId, preference.purpose),
          ] as const,
      ),
    ),
  ]);
  const credentialIntegrity = new Map(credentialChecks);
  const resolvedPurposes = new Set(
    preferenceChecks
      .filter((entry) => entry[1] !== null)
      .map(([purpose]) => purpose),
  );
  const imagePreference = preferenceByPurpose.get('courseware_image');

  return {
    featureEnabled: featureRow?.value === '1',
    providers,
    preferences: preferenceResult.results.map((preference) => ({
      purpose: preference.purpose,
      endpointId: preference.endpoint_id,
      modelCatalogId: preference.model_catalog_id,
      customModelId: preference.custom_model_id,
      voiceId: preference.voice_id,
      params: parseObject(preference.params_json),
    })),
    readiness: {
      text: readinessFor(
        preferenceByPurpose.get('courseware_text'),
        providerMap,
        resolvedPurposes,
        credentialIntegrity,
      ),
      teacherSpeech: readinessFor(
        preferenceByPurpose.get('teacher_tts'),
        providerMap,
        resolvedPurposes,
        credentialIntegrity,
      ),
      studentSpeech: readinessFor(
        preferenceByPurpose.get('student_tts'),
        providerMap,
        resolvedPurposes,
        credentialIntegrity,
      ),
      image: imagePreference
        ? readinessFor(imagePreference, providerMap, resolvedPurposes, credentialIntegrity)
        : 'disabled',
    },
  };
}

export async function recordCredentialHealth(
  db: D1Database,
  userId: number,
  providerId: number,
  status: Exclude<CredentialHealth, 'unknown'>,
  _errorCode = '',
): Promise<void> {
  const normalizedErrorCode =
    status === 'invalid' ? 'invalid_credential' : status === 'quota_exhausted' ? status : '';
  await db
    .prepare(
      `INSERT INTO user_ai_credentials
       (user_id, provider_id, health_status, health_checked_at, last_error_code, updated_at)
       VALUES (?, ?, ?, datetime('now'), ?, datetime('now'))
       ON CONFLICT(user_id, provider_id) DO UPDATE SET
         health_status = excluded.health_status,
         health_checked_at = excluded.health_checked_at,
         last_error_code = excluded.last_error_code,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, providerId, status, normalizedErrorCode)
    .run();
}
