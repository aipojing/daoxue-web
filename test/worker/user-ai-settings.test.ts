import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { SETTING_KEYS, setSetting } from '../../src/worker/lib/settings';
import {
  getUserAISettingsStatus,
  resolveUserAIConfig,
  saveUserAISettings,
} from '../../src/worker/lib/user-ai-settings';

async function insertUser(id: number, email: string): Promise<void> {
  await env.DB.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .bind(id, email, 'hash')
    .run();
}

async function corruptPersonalCiphertext(userId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE user_ai_settings SET deepseek_key_ciphertext = '!!!corrupted!!!' WHERE user_id = ?`,
  )
    .bind(userId)
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_ai_settings'),
    env.DB.prepare('DELETE FROM app_settings'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

describe('resolveUserAIConfig 优先级', () => {
  it('个人 Key 优先于共享 Key，且只在本人账户生效', async () => {
    await insertUser(1, 'user-a@example.com');
    await insertUser(2, 'user-b@example.com');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'sk-shared')`,
      ),
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('shared_ai_fallback_enabled', '1')`,
      ),
    ]);
    await saveUserAISettings(env.DB, env.AI_SETTINGS_ENCRYPTION_KEY!, 1, {
      deepseekApiKey: 'sk-user-a',
    });

    const userA = await resolveUserAIConfig(env.DB, env, 1);
    expect(userA.deepseekSource).toBe('personal');
    expect(userA.deepseekKey).toBe('sk-user-a');

    const userB = await resolveUserAIConfig(env.DB, env, 2);
    expect(userB.deepseekSource).toBe('shared');
    expect(userB.deepseekKey).toBe('sk-shared');
  });

  it('关闭共享兜底后未配置个人 Key 的用户来源为 none', async () => {
    await insertUser(1, 'user-a@example.com');
    await insertUser(2, 'user-b@example.com');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'sk-shared')`,
      ),
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('shared_ai_fallback_enabled', '1')`,
      ),
    ]);
    await saveUserAISettings(env.DB, env.AI_SETTINGS_ENCRYPTION_KEY!, 1, {
      deepseekApiKey: 'sk-user-a',
    });

    await setSetting(env.DB, SETTING_KEYS.sharedAIFallbackEnabled, '0');

    const userB = await resolveUserAIConfig(env.DB, env, 2);
    expect(userB.deepseekSource).toBe('none');
    expect(userB.deepseekKey).toBe('');
    expect(userB.vision).toBeNull();
    expect(userB.visionSource).toBe('none');

    // 兜底关闭不影响已有个人 Key 的账户
    const userA = await resolveUserAIConfig(env.DB, env, 1);
    expect(userA.deepseekSource).toBe('personal');
  });

  it('兜底开关记录缺失时按关闭处理（fail closed）', async () => {
    await insertUser(1, 'user-a@example.com');
    // 只有共享 Key、没有任何开关记录（模拟记录被误删或读取异常返回空配置）
    await setSetting(env.DB, SETTING_KEYS.deepseekApiKey, 'sk-shared');

    const resolved = await resolveUserAIConfig(env.DB, env, 1);
    expect(resolved.deepseekSource).toBe('none');
    expect(resolved.deepseekKey).toBe('');
    expect(resolved.vision).toBeNull();
    expect(resolved.visionSource).toBe('none');

    // 开关记录缺失不影响个人 Key，也不会让共享 Key 被误用
    await saveUserAISettings(env.DB, env.AI_SETTINGS_ENCRYPTION_KEY!, 1, {
      deepseekApiKey: 'sk-user-a',
    });
    const withPersonal = await resolveUserAIConfig(env.DB, env, 1);
    expect(withPersonal.deepseekSource).toBe('personal');
    expect(withPersonal.deepseekKey).toBe('sk-user-a');
  });

  it('个人密文损坏时 fail closed，不回退共享 Key', async () => {
    await insertUser(1, 'user-a@example.com');
    await setSetting(env.DB, SETTING_KEYS.deepseekApiKey, 'sk-shared');
    await saveUserAISettings(env.DB, env.AI_SETTINGS_ENCRYPTION_KEY!, 1, {
      deepseekApiKey: 'sk-user-a',
    });
    await corruptPersonalCiphertext(1);

    await expect(resolveUserAIConfig(env.DB, env, 1)).rejects.toThrow('个人 AI 配置无法读取');
  });

  it('主密钥与密文不匹配时 fail closed', async () => {
    await insertUser(1, 'user-a@example.com');
    await setSetting(env.DB, SETTING_KEYS.deepseekApiKey, 'sk-shared');
    const otherMasterKey = btoa('fedcba9876543210fedcba9876543210');
    await saveUserAISettings(env.DB, otherMasterKey, 1, { deepseekApiKey: 'sk-user-a' });

    await expect(resolveUserAIConfig(env.DB, env, 1)).rejects.toThrow('个人 AI 配置无法读取');
  });

  it('个人视觉 Key 优先且固定使用白名单 provider 地址', async () => {
    await insertUser(1, 'user-a@example.com');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('vision_api_key', 'vk-shared')`,
      ),
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('vision_api_url', 'https://shared.example.com/v1')`,
      ),
    ]);
    await saveUserAISettings(env.DB, env.AI_SETTINGS_ENCRYPTION_KEY!, 1, {
      visionApiKey: 'vk-personal',
      visionProvider: 'dashscope',
    });

    const resolved = await resolveUserAIConfig(env.DB, env, 1);
    expect(resolved.visionSource).toBe('personal');
    expect(resolved.vision).toMatchObject({
      apiKey: 'vk-personal',
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen-vl-plus',
    });
  });

  it('没有个人视觉 Key 时按兜底开关使用或拒绝共享视觉服务', async () => {
    await insertUser(1, 'user-a@example.com');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('vision_api_key', 'vk-shared')`,
      ),
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('shared_ai_fallback_enabled', '1')`,
      ),
    ]);

    const withFallback = await resolveUserAIConfig(env.DB, env, 1);
    expect(withFallback.visionSource).toBe('shared');
    expect(withFallback.vision?.apiKey).toBe('vk-shared');

    await setSetting(env.DB, SETTING_KEYS.sharedAIFallbackEnabled, '0');
    const withoutFallback = await resolveUserAIConfig(env.DB, env, 1);
    expect(withoutFallback.visionSource).toBe('none');
    expect(withoutFallback.vision).toBeNull();
  });

  it('复用调用方已读取的 app_settings，不再次查询数据库', async () => {
    await insertUser(1, 'user-a@example.com');
    const appSettings = {
      [SETTING_KEYS.deepseekApiKey]: 'sk-shared',
      [SETTING_KEYS.sharedAIFallbackEnabled]: '1',
    };
    const resolved = await resolveUserAIConfig(env.DB, env, 1, appSettings);
    expect(resolved.deepseekSource).toBe('shared');
    expect(resolved.deepseekKey).toBe('sk-shared');

    // 调用方传入的配置缺少开关记录时同样按关闭处理
    const withoutToggle = await resolveUserAIConfig(env.DB, env, 1, {
      [SETTING_KEYS.deepseekApiKey]: 'sk-shared',
    });
    expect(withoutToggle.deepseekSource).toBe('none');
  });
});

describe('saveUserAISettings', () => {
  it('画像策略按账户隔离，局部保存不覆盖另一个字段或已有 Key', async () => {
    await insertUser(1, 'user-a@example.com');
    await insertUser(2, 'user-b@example.com');
    const masterKey = env.AI_SETTINGS_ENCRYPTION_KEY!;
    await saveUserAISettings(env.DB, masterKey, 1, {
      deepseekApiKey: 'sk-user-a',
      profileRefineIntervalMinutes: 20,
      profileRefineDailyLimit: 1,
    });
    await saveUserAISettings(env.DB, masterKey, 2, {
      profileRefineIntervalMinutes: 60,
      profileRefineDailyLimit: 3,
    });
    await saveUserAISettings(env.DB, '', 1, { profileRefineDailyLimit: 2 });

    expect((await resolveUserAIConfig(env.DB, env, 1)).profileRefine).toEqual({
      intervalMinutes: 20,
      dailyLimit: 2,
    });
    expect((await resolveUserAIConfig(env.DB, env, 1)).deepseekKey).toBe('sk-user-a');
    expect((await resolveUserAIConfig(env.DB, env, 2)).profileRefine).toEqual({
      intervalMinutes: 60,
      dailyLimit: 3,
    });
  });

  it('局部保存不覆盖未提交字段，null 清除对应 Key', async () => {
    await insertUser(1, 'user-a@example.com');
    const masterKey = env.AI_SETTINGS_ENCRYPTION_KEY!;
    await saveUserAISettings(env.DB, masterKey, 1, {
      deepseekApiKey: 'sk-user-a',
      visionApiKey: 'vk-user-a',
    });
    await saveUserAISettings(env.DB, masterKey, 1, { visionProvider: 'dashscope' });

    let status = await getUserAISettingsStatus(env.DB, env, 1);
    expect(status.personal).toMatchObject({
      deepseekKeySet: true,
      visionKeySet: true,
      visionProvider: 'dashscope',
    });

    await saveUserAISettings(env.DB, masterKey, 1, { deepseekApiKey: null });
    status = await getUserAISettingsStatus(env.DB, env, 1);
    expect(status.personal.deepseekKeySet).toBe(false);
    expect(status.personal.deepseekKeyTail).toBe('');
    expect(status.personal.visionKeySet).toBe(true);
  });

  it('替换 Key 后旧密文不可再解密出新值以外的内容', async () => {
    await insertUser(1, 'user-a@example.com');
    const masterKey = env.AI_SETTINGS_ENCRYPTION_KEY!;
    await saveUserAISettings(env.DB, masterKey, 1, { deepseekApiKey: 'sk-old-key-value' });
    await saveUserAISettings(env.DB, masterKey, 1, { deepseekApiKey: 'sk-new-key-value' });

    const resolved = await resolveUserAIConfig(env.DB, env, 1);
    expect(resolved.deepseekKey).toBe('sk-new-key-value');
  });

  it('数据库中只保存密文、IV 和尾号，状态响应不含明文', async () => {
    await insertUser(1, 'user-a@example.com');
    await saveUserAISettings(env.DB, env.AI_SETTINGS_ENCRYPTION_KEY!, 1, {
      deepseekApiKey: 'sk-user-a',
      visionApiKey: 'vk-user-a',
    });

    const row = await env.DB.prepare(
      'SELECT * FROM user_ai_settings WHERE user_id = 1',
    ).first<Record<string, string>>();
    expect(JSON.stringify(row)).not.toContain('sk-user-a');
    expect(JSON.stringify(row)).not.toContain('vk-user-a');
    expect(row?.deepseek_key_tail).toBe('er-a');

    const status = await getUserAISettingsStatus(env.DB, env, 1);
    expect(JSON.stringify(status)).not.toContain('sk-user-a');
    expect(JSON.stringify(status)).not.toContain('vk-user-a');
  });
});

describe('getUserAISettingsStatus', () => {
  it('没有个人设置行时返回账户画像策略默认值', async () => {
    await insertUser(1, 'user-a@example.com');

    const status = await getUserAISettingsStatus(env.DB, env, 1);
    expect(status.personal).toMatchObject({
      profileRefineIntervalMinutes: 10,
      profileRefineDailyLimit: 0,
    });
    expect((await resolveUserAIConfig(env.DB, env, 1)).profileRefine).toEqual({
      intervalMinutes: 10,
      dailyLimit: 0,
    });
  });

  it('反映个人/共享/未配置三种生效来源', async () => {
    await insertUser(1, 'user-a@example.com');
    const masterKey = env.AI_SETTINGS_ENCRYPTION_KEY!;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('deepseek_api_key', 'sk-shared')`,
      ),
      env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('shared_ai_fallback_enabled', '1')`,
      ),
    ]);

    let status = await getUserAISettingsStatus(env.DB, env, 1);
    expect(status.effective).toMatchObject({
      deepseekConfigured: true,
      deepseekSource: 'shared',
    });
    expect(status.sharedFallbackEnabled).toBe(true);

    await saveUserAISettings(env.DB, masterKey, 1, { deepseekApiKey: 'sk-user-a' });
    status = await getUserAISettingsStatus(env.DB, env, 1);
    expect(status.effective.deepseekSource).toBe('personal');

    await saveUserAISettings(env.DB, masterKey, 1, { deepseekApiKey: null });
    await setSetting(env.DB, SETTING_KEYS.sharedAIFallbackEnabled, '0');
    status = await getUserAISettingsStatus(env.DB, env, 1);
    expect(status.effective).toMatchObject({
      deepseekConfigured: false,
      deepseekSource: 'none',
      visionEnabled: false,
      visionSource: 'none',
    });
  });

  it('个人密文损坏时状态读取同样 fail closed', async () => {
    await insertUser(1, 'user-a@example.com');
    await saveUserAISettings(env.DB, env.AI_SETTINGS_ENCRYPTION_KEY!, 1, {
      deepseekApiKey: 'sk-user-a',
    });
    await corruptPersonalCiphertext(1);

    await expect(getUserAISettingsStatus(env.DB, env, 1)).rejects.toThrow('个人 AI 配置无法读取');
  });
});
