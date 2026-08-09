import { describe, expect, it } from 'vitest';
import { buildAISettingsPatch } from '../src/client/lib/ai-settings';
import * as aiSettings from '../src/client/lib/ai-settings';

describe('buildAISettingsPatch', () => {
  it('空表单只提交视觉 provider 与模型，不触碰 Key', () => {
    expect(
      buildAISettingsPatch({
        deepseekInput: '',
        visionInput: '',
        visionProvider: 'zhipu',
        visionModel: '',
        clearDeepseek: false,
        clearVision: false,
        profileRefineIntervalMinutes: 10,
        profileRefineDailyLimit: 0,
      }),
    ).toEqual({
      visionProvider: 'zhipu',
      visionModel: '',
      profileRefineIntervalMinutes: 10,
      profileRefineDailyLimit: 0,
    });
  });

  it('填写覆盖、null 清除并 trim 输入', () => {
    expect(
      buildAISettingsPatch({
        deepseekInput: ' sk-new ',
        visionInput: '',
        visionProvider: 'dashscope',
        visionModel: ' qwen-vl-plus ',
        clearDeepseek: false,
        clearVision: true,
        profileRefineIntervalMinutes: 30,
        profileRefineDailyLimit: 2,
      }),
    ).toEqual({
      deepseekApiKey: 'sk-new',
      visionApiKey: null,
      visionProvider: 'dashscope',
      visionModel: 'qwen-vl-plus',
      profileRefineIntervalMinutes: 30,
      profileRefineDailyLimit: 2,
    });
  });

  it('清除标记优先于输入框内容', () => {
    expect(
      buildAISettingsPatch({
        deepseekInput: 'sk-typed',
        visionInput: 'vk-typed',
        visionProvider: 'zhipu',
        visionModel: '',
        clearDeepseek: true,
        clearVision: true,
        profileRefineIntervalMinutes: 20,
        profileRefineDailyLimit: 1,
      }),
    ).toEqual({
      deepseekApiKey: null,
      visionApiKey: null,
      visionProvider: 'zhipu',
      visionModel: '',
      profileRefineIntervalMinutes: 20,
      profileRefineDailyLimit: 1,
    });
  });

  it('站点共享请求只包含共享凭据和兜底开关', () => {
    const buildShared = (
      aiSettings as unknown as {
        buildSharedAISettingsPatch?: (draft: Record<string, unknown>) => Record<string, unknown>;
      }
    ).buildSharedAISettingsPatch;
    expect(buildShared).toBeTypeOf('function');
    const patch = buildShared!({
      deepseekInput: ' sk-shared ',
      visionInput: ' vk-shared ',
      visionApiUrl: ' https://vision.example/v1 ',
      visionModel: ' model-a ',
      sharedFallbackEnabled: true,
    });
    expect(patch).toEqual({
      deepseekApiKey: 'sk-shared',
      visionApiKey: 'vk-shared',
      visionApiUrl: 'https://vision.example/v1',
      visionModel: 'model-a',
      sharedFallbackEnabled: true,
    });
    expect(patch).not.toHaveProperty('profileRefineIntervalMinutes');
    expect(patch).not.toHaveProperty('profileRefineDailyLimit');
  });

  it('画像策略输入使用统一边界校验', () => {
    const validate = (
      aiSettings as unknown as {
        validateProfileRefineSettings?: (interval: number, dailyLimit: number) => string | null;
      }
    ).validateProfileRefineSettings;
    expect(validate).toBeTypeOf('function');
    expect(validate!(10, 0)).toBeNull();
    expect(validate!(0, 0)).toContain('1–1440');
    expect(validate!(10, 1001)).toContain('0–1000');
    expect(validate!(10.5, 1)).toContain('整数');
  });
});
