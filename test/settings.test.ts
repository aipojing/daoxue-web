import { describe, it, expect } from 'vitest';
import { mergeAIConfig, maskTail, SETTING_KEYS } from '../src/worker/lib/settings';

describe('mergeAIConfig', () => {
  it('数据库配置优先于环境变量', () => {
    const cfg = mergeAIConfig(
      { [SETTING_KEYS.deepseekApiKey]: 'sk-db', [SETTING_KEYS.visionApiKey]: 'vk-db' },
      { DEEPSEEK_API_KEY: 'sk-env', VISION_API_KEY: 'vk-env' },
    );
    expect(cfg.deepseekKey).toBe('sk-db');
    expect(cfg.vision?.apiKey).toBe('vk-db');
    expect(cfg.deepseekFromDb).toBe(true);
    expect(cfg.visionFromDb).toBe(true);
  });

  it('数据库为空时回落到环境变量', () => {
    const cfg = mergeAIConfig({}, { DEEPSEEK_API_KEY: 'sk-env', VISION_API_KEY: 'vk-env' });
    expect(cfg.deepseekKey).toBe('sk-env');
    expect(cfg.vision?.apiKey).toBe('vk-env');
    expect(cfg.deepseekFromDb).toBe(false);
  });

  it('都没有时 deepseekKey 为空、vision 为 null', () => {
    const cfg = mergeAIConfig({}, {});
    expect(cfg.deepseekKey).toBe('');
    expect(cfg.vision).toBeNull();
  });

  it('自定义视觉地址与模型生效', () => {
    const cfg = mergeAIConfig(
      {
        [SETTING_KEYS.visionApiKey]: 'vk',
        [SETTING_KEYS.visionApiUrl]: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        [SETTING_KEYS.visionModel]: 'qwen-vl-plus',
      },
      {},
    );
    expect(cfg.vision?.url).toContain('dashscope');
    expect(cfg.vision?.model).toBe('qwen-vl-plus');
  });
});

describe('SETTING_KEYS', () => {
  it('包含站点共享兜底开关键名', () => {
    expect(SETTING_KEYS.sharedAIFallbackEnabled).toBe('shared_ai_fallback_enabled');
  });
});

describe('maskTail', () => {
  it('只显示尾 4 位', () => {
    expect(maskTail('sk-1234567890abcd')).toBe('abcd');
    expect(maskTail('')).toBe('');
  });

  it('短密钥不直接泄露完整值', () => {
    expect(maskTail('abc')).toBe('****');
    expect(maskTail('abcd')).toBe('****');
    expect(maskTail('shortkey')).toBe('****');
  });
});
