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
  it('returns the enabled public catalog without Base URLs', async () => {
    const catalog = await getPublicCatalog(env.DB);
    expect(catalog.map((provider) => provider.slug)).toEqual(
      expect.arrayContaining(['bailian-token-plan', 'deepseek']),
    );
    expect(catalog.flatMap((provider) => provider.models).length).toBeGreaterThan(0);
    expect(JSON.stringify(catalog)).not.toContain('baseUrl');
    expect(JSON.stringify(catalog)).not.toContain('https://');
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
});
