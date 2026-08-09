import { describe, expect, it } from 'vitest';
import { buildAISettingsPatch } from '../src/client/lib/ai-settings';

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
      }),
    ).toEqual({ visionProvider: 'zhipu', visionModel: '' });
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
      }),
    ).toEqual({
      deepseekApiKey: 'sk-new',
      visionApiKey: null,
      visionProvider: 'dashscope',
      visionModel: 'qwen-vl-plus',
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
      }),
    ).toEqual({
      deepseekApiKey: null,
      visionApiKey: null,
      visionProvider: 'zhipu',
      visionModel: '',
    });
  });
});
