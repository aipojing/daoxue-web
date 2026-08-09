import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  getVisionConfig,
  getPersonalVisionConfig,
  validateImageDataUrl,
  buildVisionRequestBody,
  parseVisionResponse,
  transcribeImage,
} from '../src/worker/chat/vision';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getVisionConfig', () => {
  it('未配置 Key 返回 null', () => {
    expect(getVisionConfig({})).toBeNull();
  });

  it('有 Key 时使用默认智谱地址与免费视觉模型', () => {
    const cfg = getVisionConfig({ VISION_API_KEY: 'k' });
    expect(cfg?.url).toContain('bigmodel.cn');
    expect(cfg?.model).toBe('glm-4.1v-thinking-flash');
  });

  it('可覆盖为其他 OpenAI 兼容服务', () => {
    const cfg = getVisionConfig({
      VISION_API_KEY: 'k',
      VISION_API_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      VISION_MODEL: 'qwen-vl-plus',
    });
    expect(cfg?.url).toContain('dashscope');
    expect(cfg?.model).toBe('qwen-vl-plus');
  });
});

describe('getPersonalVisionConfig', () => {
  it('没有 Key 返回 null', () => {
    expect(getPersonalVisionConfig('zhipu', '', '')).toBeNull();
  });

  it('白名单 provider 使用固定地址与默认模型', () => {
    expect(getPersonalVisionConfig('zhipu', 'vk', '')).toMatchObject({
      apiKey: 'vk',
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      model: 'glm-4.1v-thinking-flash',
    });
    expect(getPersonalVisionConfig('dashscope', 'vk', '')).toMatchObject({
      apiKey: 'vk',
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen-vl-plus',
    });
  });

  it('允许覆盖模型但不接受自定义地址', () => {
    const cfg = getPersonalVisionConfig('dashscope', 'vk', 'qwen-vl-max');
    expect(cfg?.model).toBe('qwen-vl-max');
    expect(cfg?.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  });
});

describe('validateImageDataUrl', () => {
  it('接受合法 jpeg data url', () => {
    expect(validateImageDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toBeNull();
  });

  it('接受大小写兼容的 JPEG、JPG 与 PNG data url', () => {
    expect(validateImageDataUrl('data:image/JPEG;base64,/9j/4AAQ')).toBeNull();
    expect(validateImageDataUrl('data:image/JPG;base64,/9j/4AAQ')).toBeNull();
    expect(validateImageDataUrl('data:image/PNG;base64,AAAA')).toBeNull();
  });

  it('接受混合或大写 WebP，拒绝 GIF', () => {
    expect(validateImageDataUrl('data:image/WebP;base64,AAAA')).toBeNull();
    expect(validateImageDataUrl('data:image/WEBP;base64,AAAA')).toBeNull();
    expect(validateImageDataUrl('data:image/GIF;base64,R0lGODlh')).not.toBeNull();
  });

  it('拒绝非图片数据', () => {
    expect(validateImageDataUrl('data:text/html;base64,AAA')).not.toBeNull();
    expect(validateImageDataUrl('hello')).not.toBeNull();
  });

  it('拒绝超大图片', () => {
    const huge = 'data:image/jpeg;base64,' + 'A'.repeat(7 * 1024 * 1024);
    expect(validateImageDataUrl(huge)).toContain('过大');
  });
});

describe('buildVisionRequestBody / parseVisionResponse', () => {
  it('请求体为 OpenAI 兼容多模态格式', () => {
    const body = buildVisionRequestBody('glm-4v-flash', 'data:image/jpeg;base64,xx') as {
      model: string;
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    expect(body.model).toBe('glm-4v-flash');
    expect(body.messages[0]!.content[0]!.type).toBe('image_url');
    expect(body.messages[0]!.content[1]!.type).toBe('text');
  });

  it('解析字符串 content', () => {
    expect(parseVisionResponse({ choices: [{ message: { content: ' 题目：1+1= ' } }] })).toBe('题目：1+1=');
  });

  it('解析分段数组 content', () => {
    expect(
      parseVisionResponse({ choices: [{ message: { content: [{ type: 'text', text: '题目' }, { type: 'text', text: 'A' }] } }] }),
    ).toBe('题目A');
  });

  it('空响应返回 null', () => {
    expect(parseVisionResponse({})).toBeNull();
    expect(parseVisionResponse({ choices: [{ message: { content: '' } }] })).toBeNull();
  });

  it('剔除 thinking 模型的思考过程', () => {
    expect(
      parseVisionResponse({
        choices: [{ message: { content: '<think>先看图里的数字</think>题目：1/2 + 1/3 = ?' } }],
      }),
    ).toBe('题目：1/2 + 1/3 = ?');
  });
});

describe('transcribeImage', () => {
  it('视觉服务 Key 无效时引导去 AI 服务页而不是联系管理员', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })));
    await expect(
      transcribeImage(
        { apiKey: 'key', url: 'https://vision.example.test', model: 'vision' },
        'data:image/png;base64,AAAA',
      ),
    ).rejects.toThrow('图片识别服务 Key 无效，请在「AI 服务」页检查当前配置');
  });

  it('视觉服务长时无响应时主动超时', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
      ),
    );

    await expect(
      transcribeImage(
        { apiKey: 'key', url: 'https://vision.example.test', model: 'vision' },
        'data:image/png;base64,AAAA',
        5,
      ),
    ).rejects.toThrow('超时');
  });
});
