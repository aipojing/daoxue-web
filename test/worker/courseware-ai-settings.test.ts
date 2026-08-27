import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AICapability,
  CoursewareModelPreference,
  CoursewareModelPurpose,
} from '../../src/shared/ai-catalog';
import { resolveCredential, saveCredential } from '../../src/worker/ai-catalog/credentials';
import {
  getPublicCatalog,
  getUserCoursewareAISettings,
  recordCredentialHealth,
  resolvePreference,
  saveUserModelPreferences,
} from '../../src/worker/ai-catalog/repository';
import { UserFacingError } from '../../src/worker/lib/errors';
import { saveUserAISettings } from '../../src/worker/lib/user-ai-settings';

async function insertUser(id: number, email: string): Promise<void> {
  await env.DB.prepare('INSERT INTO users(id, email, password_hash) VALUES (?, ?, ?)')
    .bind(id, email, 'hash')
    .run();
}

async function providerIdBySlug(slug: string): Promise<number> {
  const row = await env.DB.prepare('SELECT id FROM ai_providers WHERE slug = ?')
    .bind(slug)
    .first<{ id: number }>();
  if (!row) throw new Error(`missing seeded provider ${slug}`);
  return row.id;
}

async function seededProviderId(): Promise<number> {
  return providerIdBySlug('bailian-token-plan');
}

interface StoredCredential {
  key_ciphertext: string;
  key_iv: string;
  key_tail: string;
}

async function storedCredential(userId: number, providerId: number): Promise<StoredCredential> {
  const row = await env.DB.prepare(
    `SELECT key_ciphertext, key_iv, key_tail
     FROM user_ai_credentials WHERE user_id = ? AND provider_id = ?`,
  )
    .bind(userId, providerId)
    .first<StoredCredential>();
  if (!row) throw new Error('missing stored test credential');
  return row;
}

function mutateBase64(value: string, byteIndex: number): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const resolvedIndex = byteIndex < 0 ? bytes.length + byteIndex : byteIndex;
  bytes[resolvedIndex] = (bytes[resolvedIndex] ?? 0) ^ 1;
  return btoa(String.fromCharCode(...bytes));
}

async function captureCredentialFailure(
  userId: number,
  providerId: number,
): Promise<string> {
  let caught: unknown;
  try {
    await resolveCredential(env.DB, env, userId, providerId);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UserFacingError);
  return caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
}

async function expectCredentialCorruptionFailsClosed(
  column: 'key_ciphertext' | 'key_iv',
  mutate: (stored: StoredCredential) => string,
): Promise<void> {
  await insertUser(1, 'integrity@example.com');
  const providerId = await seededProviderId();
  const fakeKey = 'test-only-integrity-value';
  await saveCredential(env.DB, env, 1, providerId, fakeKey);
  await saveUserModelPreferences(
    env.DB,
    1,
    await seededPreferences({ teacherVoice: 'longanlingxin' }),
  );
  const stored = await storedCredential(1, providerId);
  await env.DB.prepare(
    `UPDATE user_ai_credentials SET ${column} = ? WHERE user_id = ? AND provider_id = ?`,
  )
    .bind(mutate(stored), 1, providerId)
    .run();

  const settings = await getUserCoursewareAISettings(env.DB, env, 1);
  expect(settings.readiness.text).toBe('invalid_credential');
  const renderedError = await captureCredentialFailure(1, providerId);
  expect(renderedError.includes(fakeKey)).toBe(false);
  expect(renderedError.includes(stored.key_ciphertext)).toBe(false);
  expect(renderedError.includes('OperationError')).toBe(false);
  expect(renderedError.toLowerCase().includes('decrypt')).toBe(false);
}

async function seededPreferences(
  input: { teacherVoice: string },
): Promise<{ preferences: CoursewareModelPreference[] }> {
  const { results } = await env.DB.prepare(
    `SELECT m.id AS model_catalog_id, m.capability, m.endpoint_id
     FROM ai_models m
     WHERE m.model_id IN ('qwen3.7-plus', 'qwen-audio-3.0-tts-plus', 'qwen-image-3.0-pro')`,
  ).all<{ model_catalog_id: number; capability: AICapability; endpoint_id: number }>();
  const byCapability = new Map(results.map((row) => [row.capability, row]));
  const selection = (
    purpose: CoursewareModelPurpose,
    capability: AICapability,
    voiceId = '',
  ): CoursewareModelPreference => {
    const row = byCapability.get(capability);
    if (!row) throw new Error(`missing seeded ${capability} model`);
    return {
      purpose,
      endpointId: row.endpoint_id,
      modelCatalogId: row.model_catalog_id,
      customModelId: '',
      voiceId,
      params: {},
    };
  };
  return {
    preferences: [
      selection('courseware_text', 'structured_text'),
      selection('courseware_image', 'image_generation'),
      selection('teacher_tts', 'speech_synthesis', input.teacherVoice),
      selection('student_tts', 'speech_synthesis', 'longanlufeng'),
    ],
  };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM users').run();
});

describe('courseware AI credentials', () => {
  it('encrypts each provider key with user/provider AAD and never returns plaintext', async () => {
    await insertUser(1, 'a@example.com');
    await insertUser(2, 'b@example.com');
    const providerId = await seededProviderId();
    const fakeKey = 'test-only-user-a';
    await saveCredential(env.DB, env, 1, providerId, fakeKey);

    expect(await resolveCredential(env.DB, env, 1, providerId)).toBe(fakeKey);
    expect(await resolveCredential(env.DB, env, 2, providerId)).toBe('');
    const stored = await env.DB.prepare(
      'SELECT key_ciphertext, key_iv, key_tail FROM user_ai_credentials WHERE user_id = ?',
    )
      .bind(1)
      .first<Record<string, string>>();
    expect(JSON.stringify(stored)).not.toContain(fakeKey);

    const status = await getUserCoursewareAISettings(env.DB, env, 1);
    expect(JSON.stringify(status)).not.toContain(fakeKey);
    expect(status.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId, keySet: true, keyTail: 'er-a' }),
      ]),
    );
  });

  it('requires personal credentials and never resolves the shared site key', async () => {
    await insertUser(1, 'a@example.com');
    const providerId = await seededProviderId();
    await env.DB.prepare(
      "INSERT INTO app_settings(key, value) VALUES ('deepseek_api_key', 'test-only-shared') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run();
    expect(await resolveCredential(env.DB, env, 1, providerId)).toBe('');
  });

  it('fails readiness closed when the encryption master key is unavailable', async () => {
    await insertUser(1, 'missing-master@example.com');
    const providerId = await seededProviderId();
    await saveCredential(env.DB, env, 1, providerId, 'test-only-missing-master');
    await saveUserModelPreferences(
      env.DB,
      1,
      await seededPreferences({ teacherVoice: 'longanlingxin' }),
    );

    const settings = await getUserCoursewareAISettings(
      env.DB,
      { ...env, AI_SETTINGS_ENCRYPTION_KEY: undefined },
      1,
    );
    expect(settings.readiness).toEqual({
      text: 'invalid_credential',
      teacherSpeech: 'invalid_credential',
      studentSpeech: 'invalid_credential',
      image: 'invalid_credential',
    });
  });

  it('fails readiness and resolution closed for corrupted ciphertext payload', async () => {
    await expectCredentialCorruptionFailsClosed('key_ciphertext', (stored) =>
      mutateBase64(stored.key_ciphertext, 0),
    );
  });

  it('fails readiness and resolution closed for a corrupted IV', async () => {
    await expectCredentialCorruptionFailsClosed('key_iv', (stored) =>
      mutateBase64(stored.key_iv, 0),
    );
  });

  it('fails readiness and resolution closed for a corrupted authentication tag', async () => {
    await expectCredentialCorruptionFailsClosed('key_ciphertext', (stored) =>
      mutateBase64(stored.key_ciphertext, -1),
    );
  });

  it('rejects ciphertext moved to another user without leaking sensitive details', async () => {
    await insertUser(1, 'source@example.com');
    await insertUser(2, 'target@example.com');
    const providerId = await seededProviderId();
    const fakeKey = 'test-only-user-bound';
    await saveCredential(env.DB, env, 1, providerId, fakeKey);
    const stored = await storedCredential(1, providerId);
    await env.DB.prepare(
      `INSERT INTO user_ai_credentials
       (user_id, provider_id, key_ciphertext, key_iv, key_tail)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(2, providerId, stored.key_ciphertext, stored.key_iv, stored.key_tail)
      .run();

    await saveUserModelPreferences(
      env.DB,
      2,
      await seededPreferences({ teacherVoice: 'longanlingxin' }),
    );
    const settings = await getUserCoursewareAISettings(env.DB, env, 2);
    expect(settings.readiness.text).toBe('invalid_credential');

    const renderedError = await captureCredentialFailure(2, providerId);
    expect(renderedError.includes(fakeKey)).toBe(false);
    expect(renderedError.includes(stored.key_ciphertext)).toBe(false);
    expect(renderedError.includes('OperationError')).toBe(false);
    expect(renderedError.toLowerCase().includes('decrypt')).toBe(false);
  });

  it('rejects ciphertext moved to another provider without leaking sensitive details', async () => {
    await insertUser(1, 'provider-bound@example.com');
    const sourceProviderId = await seededProviderId();
    const targetProviderId = await providerIdBySlug('deepseek');
    const fakeKey = 'test-only-provider-bound';
    await saveCredential(env.DB, env, 1, sourceProviderId, fakeKey);
    const stored = await storedCredential(1, sourceProviderId);
    await env.DB.prepare(
      `INSERT INTO user_ai_credentials
       (user_id, provider_id, key_ciphertext, key_iv, key_tail)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(1, targetProviderId, stored.key_ciphertext, stored.key_iv, stored.key_tail)
      .run();

    const deepseekModel = await env.DB.prepare(
      `SELECT m.id AS model_catalog_id, m.endpoint_id
       FROM ai_models m
       JOIN ai_provider_endpoints e ON e.id = m.endpoint_id
       WHERE e.provider_id = ? AND m.model_id = 'deepseek-chat'`,
    )
      .bind(targetProviderId)
      .first<{ model_catalog_id: number; endpoint_id: number }>();
    if (!deepseekModel) throw new Error('missing seeded DeepSeek model');
    await saveUserModelPreferences(env.DB, 1, {
      preferences: [
        {
          purpose: 'courseware_text',
          endpointId: deepseekModel.endpoint_id,
          modelCatalogId: deepseekModel.model_catalog_id,
          customModelId: '',
          voiceId: '',
          params: {},
        },
      ],
    });
    const settings = await getUserCoursewareAISettings(env.DB, env, 1);
    expect(settings.readiness.text).toBe('invalid_credential');

    const renderedError = await captureCredentialFailure(1, targetProviderId);
    expect(renderedError.includes(fakeKey)).toBe(false);
    expect(renderedError.includes(stored.key_ciphertext)).toBe(false);
    expect(renderedError.includes('OperationError')).toBe(false);
    expect(renderedError.toLowerCase().includes('decrypt')).toBe(false);
  });

  it('reuses only the existing personal DeepSeek key for the DeepSeek catalog provider', async () => {
    await insertUser(1, 'a@example.com');
    const fakeKey = 'test-only-personal-deepseek';
    await saveUserAISettings(env.DB, env.AI_SETTINGS_ENCRYPTION_KEY!, 1, {
      deepseekApiKey: fakeKey,
    });
    const deepseekProviderId = await providerIdBySlug('deepseek');
    expect(await resolveCredential(env.DB, env, 1, deepseekProviderId)).toBe(fakeKey);

    const status = await getUserCoursewareAISettings(env.DB, env, 1);
    expect(status.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: deepseekProviderId,
          keySet: true,
          keyTail: 'seek',
        }),
      ]),
    );
    expect(JSON.stringify(status)).not.toContain(fakeKey);
  });

  it('records exhausted health without storing provider details and key replacement resets it', async () => {
    await insertUser(1, 'a@example.com');
    const providerId = await seededProviderId();
    await saveCredential(env.DB, env, 1, providerId, 'test-only-first');
    await saveUserModelPreferences(
      env.DB,
      1,
      await seededPreferences({ teacherVoice: 'longanlingxin' }),
    );
    await recordCredentialHealth(env.DB, 1, providerId, 'quota_exhausted', 'quota_exhausted');

    let status = await getUserCoursewareAISettings(env.DB, env, 1);
    expect(status.providers.find((item) => item.providerId === providerId)?.healthStatus).toBe(
      'quota_exhausted',
    );
    expect(status.readiness).toEqual({
      text: 'quota_exhausted',
      teacherSpeech: 'quota_exhausted',
      studentSpeech: 'quota_exhausted',
      image: 'quota_exhausted',
    });
    expect(JSON.stringify(status)).not.toContain('provider detail');

    await recordCredentialHealth(env.DB, 1, providerId, 'invalid', 'provider detail');
    status = await getUserCoursewareAISettings(env.DB, env, 1);
    expect(status.readiness).toEqual({
      text: 'invalid_credential',
      teacherSpeech: 'invalid_credential',
      studentSpeech: 'invalid_credential',
      image: 'invalid_credential',
    });
    const healthRow = await env.DB.prepare(
      'SELECT last_error_code FROM user_ai_credentials WHERE user_id = ? AND provider_id = ?',
    )
      .bind(1, providerId)
      .first<{ last_error_code: string }>();
    expect(healthRow?.last_error_code).toBe('invalid_credential');

    await saveCredential(env.DB, env, 1, providerId, 'test-only-replacement');
    status = await getUserCoursewareAISettings(env.DB, env, 1);
    expect(status.providers.find((item) => item.providerId === providerId)?.healthStatus).toBe(
      'unknown',
    );
    expect(status.readiness.text).toBe('ready');
  });
});

describe('courseware AI catalog and preferences', () => {
  it('returns only safe public endpoint metadata without Base URLs or internal endpoint config', async () => {
    const catalog = await getPublicCatalog(env.DB);
    expect(catalog.map((provider) => provider.slug)).toEqual(
      expect.arrayContaining(['bailian-token-plan', 'deepseek']),
    );
    expect(catalog.flatMap((provider) => provider.models).length).toBeGreaterThan(0);
    const qwenText = catalog
      .flatMap((provider) => provider.models)
      .find((model) => model.modelId === 'qwen3.7-plus');
    const tts = catalog
      .flatMap((provider) => provider.models)
      .find((model) => model.capability === 'speech_synthesis');
    expect(qwenText).toMatchObject({ allowCustomModelId: true });
    expect(tts).toMatchObject({ allowCustomModelId: false });
    expect(JSON.stringify(catalog)).not.toContain('baseUrl');
    expect(JSON.stringify(catalog)).not.toContain('https://');
    expect(JSON.stringify(catalog)).not.toContain('mediaHostSuffixes');
    expect(JSON.stringify(catalog)).not.toContain('sampleRates');
    expect(JSON.stringify(catalog)).not.toContain('"formats"');
  });

  it('rejects a voice that is absent from the selected model catalog entry', async () => {
    await insertUser(1, 'a@example.com');
    const input = await seededPreferences({ teacherVoice: 'not-a-real-voice' });
    await expect(saveUserModelPreferences(env.DB, 1, input)).rejects.toThrow(
      '老师音色与所选模型不兼容',
    );
  });

  it('saves and resolves all four purposes while user settings omit Base URLs', async () => {
    await insertUser(1, 'a@example.com');
    const providerId = await seededProviderId();
    await saveCredential(env.DB, env, 1, providerId, 'test-only-courseware');
    const input = await seededPreferences({ teacherVoice: 'longanlingxin' });
    await saveUserModelPreferences(env.DB, 1, input);

    const purposes = input.preferences.map((item) => item.purpose);
    const resolved = await Promise.all(
      purposes.map((purpose) => resolvePreference(env.DB, 1, purpose)),
    );
    expect(resolved.map((item) => item?.purpose)).toEqual(purposes);
    expect(resolved.map((item) => item?.capability)).toEqual([
      'structured_text',
      'image_generation',
      'speech_synthesis',
      'speech_synthesis',
    ]);

    const settings = await getUserCoursewareAISettings(env.DB, env, 1);
    expect(settings.preferences.map((item) => item.purpose)).toEqual(purposes);
    expect(settings.readiness).toEqual({
      text: 'ready',
      teacherSpeech: 'ready',
      studentSpeech: 'ready',
      image: 'ready',
    });
    expect(JSON.stringify(settings)).not.toContain('baseUrl');
    expect(JSON.stringify(settings)).not.toContain('https://');
  });

  it('reports required purposes as unconfigured without a personal provider credential', async () => {
    await insertUser(1, 'a@example.com');
    const input = await seededPreferences({ teacherVoice: 'longanlingxin' });
    await saveUserModelPreferences(env.DB, 1, input);

    const settings = await getUserCoursewareAISettings(env.DB, env, 1);
    expect(settings.readiness).toEqual({
      text: 'unconfigured',
      teacherSpeech: 'unconfigured',
      studentSpeech: 'unconfigured',
      image: 'unconfigured',
    });
  });

  it('rejects user params that are not declared by the selected endpoint or model', async () => {
    await insertUser(1, 'a@example.com');
    const input = await seededPreferences({ teacherVoice: 'longanlingxin' });
    input.preferences[0]!.params = { unexpected: true };
    await expect(saveUserModelPreferences(env.DB, 1, input)).rejects.toThrow(
      '模型参数不受支持',
    );
  });

  it('fails closed when an allowed user param has an empty catalog declaration', async () => {
    await insertUser(1, 'a@example.com');
    const input = await seededPreferences({ teacherVoice: 'longanlingxin' });
    const endpointId = input.preferences[0]!.endpointId;
    const original = await env.DB.prepare(
      'SELECT config_json FROM ai_provider_endpoints WHERE id = ?',
    )
      .bind(endpointId)
      .first<{ config_json: string }>();
    if (!original) throw new Error('missing seeded endpoint');

    try {
      await env.DB.prepare(
        `UPDATE ai_provider_endpoints
         SET config_json = json_set(config_json, '$.allowedUserParams.unsafe', json('{}'))
         WHERE id = ?`,
      )
        .bind(endpointId)
        .run();
      input.preferences[0]!.params = { unsafe: 'arbitrary' };
      await expect(saveUserModelPreferences(env.DB, 1, input)).rejects.toThrow(
        '模型参数不受支持',
      );
    } finally {
      await env.DB.prepare('UPDATE ai_provider_endpoints SET config_json = ? WHERE id = ?')
        .bind(original.config_json, endpointId)
        .run();
    }
  });

  it('invalidates a saved speech preference when its voice is removed from the catalog', async () => {
    await insertUser(1, 'voice-drift@example.com');
    const providerId = await seededProviderId();
    await saveCredential(env.DB, env, 1, providerId, 'test-only-voice-drift');
    const input = await seededPreferences({ teacherVoice: 'longanlingxin' });
    await saveUserModelPreferences(env.DB, 1, input);
    const teacher = input.preferences.find((item) => item.purpose === 'teacher_tts')!;
    const original = await env.DB.prepare('SELECT voices_json FROM ai_models WHERE id = ?')
      .bind(teacher.modelCatalogId)
      .first<{ voices_json: string }>();
    if (!original) throw new Error('missing seeded speech model');

    try {
      await env.DB.prepare(
        `UPDATE ai_models SET voices_json =
         '[{"id":"longanlufeng","name":"student-test-voice"}]' WHERE id = ?`,
      )
        .bind(teacher.modelCatalogId)
        .run();
      expect(await resolvePreference(env.DB, 1, 'teacher_tts')).toBeNull();
      const settings = await getUserCoursewareAISettings(env.DB, env, 1);
      expect(settings.readiness.teacherSpeech).toBe('unconfigured');
      expect(settings.readiness.studentSpeech).toBe('ready');
    } finally {
      await env.DB.prepare('UPDATE ai_models SET voices_json = ? WHERE id = ?')
        .bind(original.voices_json, teacher.modelCatalogId)
        .run();
    }
  });

  it('invalidates saved params when the catalog declaration is tightened', async () => {
    await insertUser(1, 'param-drift@example.com');
    const providerId = await seededProviderId();
    await saveCredential(env.DB, env, 1, providerId, 'test-only-param-drift');
    const input = await seededPreferences({ teacherVoice: 'longanlingxin' });
    input.preferences = [input.preferences.find((item) => item.purpose === 'courseware_text')!];
    input.preferences[0]!.params = { temperature: 0.5 };
    const endpointId = input.preferences[0]!.endpointId;
    const original = await env.DB.prepare(
      'SELECT config_json FROM ai_provider_endpoints WHERE id = ?',
    )
      .bind(endpointId)
      .first<{ config_json: string }>();
    if (!original) throw new Error('missing seeded text endpoint');

    try {
      await env.DB.prepare(
        `UPDATE ai_provider_endpoints SET config_json = json_set(
           config_json, '$.allowedUserParams.temperature',
           json('{"type":"number","minimum":0,"maximum":1}')
         ) WHERE id = ?`,
      )
        .bind(endpointId)
        .run();
      await saveUserModelPreferences(env.DB, 1, input);
      await env.DB.prepare(
        `UPDATE ai_provider_endpoints SET config_json = json_set(
           config_json, '$.allowedUserParams.temperature.maximum', 0.1
         ) WHERE id = ?`,
      )
        .bind(endpointId)
        .run();

      expect(await resolvePreference(env.DB, 1, 'courseware_text')).toBeNull();
      const settings = await getUserCoursewareAISettings(env.DB, env, 1);
      expect(settings.readiness.text).toBe('unconfigured');
    } finally {
      await env.DB.prepare('UPDATE ai_provider_endpoints SET config_json = ? WHERE id = ?')
        .bind(original.config_json, endpointId)
        .run();
    }
  });

  it('invalidates a saved custom model when the endpoint revokes custom IDs', async () => {
    await insertUser(1, 'custom-drift@example.com');
    const providerId = await seededProviderId();
    await saveCredential(env.DB, env, 1, providerId, 'test-only-custom-drift');
    const input = await seededPreferences({ teacherVoice: 'longanlingxin' });
    const text = input.preferences.find((item) => item.purpose === 'courseware_text')!;
    text.modelCatalogId = null;
    text.customModelId = 'vendor/custom-model';
    input.preferences = [text];
    await saveUserModelPreferences(env.DB, 1, input);
    const original = await env.DB.prepare(
      'SELECT config_json FROM ai_provider_endpoints WHERE id = ?',
    )
      .bind(text.endpointId)
      .first<{ config_json: string }>();
    if (!original) throw new Error('missing seeded custom-model endpoint');

    try {
      await env.DB.prepare(
        `UPDATE ai_provider_endpoints
         SET config_json = json_set(config_json, '$.allowCustomModelId', json('false'))
         WHERE id = ?`,
      )
        .bind(text.endpointId)
        .run();
      expect(await resolvePreference(env.DB, 1, 'courseware_text')).toBeNull();
      const settings = await getUserCoursewareAISettings(env.DB, env, 1);
      expect(settings.readiness.text).toBe('unconfigured');
    } finally {
      await env.DB.prepare('UPDATE ai_provider_endpoints SET config_json = ? WHERE id = ?')
        .bind(original.config_json, text.endpointId)
        .run();
    }
  });

  it('keeps readiness invalid when a saved endpoint capability changes', async () => {
    await insertUser(1, 'capability-drift@example.com');
    const providerId = await seededProviderId();
    await saveCredential(env.DB, env, 1, providerId, 'test-only-capability-drift');
    const input = await seededPreferences({ teacherVoice: 'longanlingxin' });
    input.preferences = [input.preferences.find((item) => item.purpose === 'courseware_text')!];
    await saveUserModelPreferences(env.DB, 1, input);
    const endpointId = input.preferences[0]!.endpointId;

    try {
      await env.DB.prepare(
        "UPDATE ai_provider_endpoints SET capability = 'image_generation' WHERE id = ?",
      )
        .bind(endpointId)
        .run();
      expect(await resolvePreference(env.DB, 1, 'courseware_text')).toBeNull();
      const settings = await getUserCoursewareAISettings(env.DB, env, 1);
      expect(settings.readiness.text).toBe('unconfigured');
    } finally {
      await env.DB.prepare(
        "UPDATE ai_provider_endpoints SET capability = 'structured_text' WHERE id = ?",
      )
        .bind(endpointId)
        .run();
    }
  });
});
