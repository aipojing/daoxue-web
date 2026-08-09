import { UserFacingError } from '../lib/errors';

const DEFAULT_VISION_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_VISION_MODEL = 'glm-4.1v-thinking-flash';
const MAX_IMAGE_BASE64_LENGTH = 6 * 1024 * 1024;
const VISION_TIMEOUT_MS = 120_000;

export const OCR_PROMPT = [
  '你是题目转写助手。请把图片中的题目完整、准确地转写成文字：',
  '1. 包括题干、全部数字与单位、选项（A/B/C/D）、表格数据和图中标注；',
  '2. 如有几何图形、电路图、函数图像或示意图，用文字准确描述图形关系（点线位置、角度、连接方式、坐标趋势等）；',
  '3. 手写的作答或过程，单独放在【学生作答】标题下转写；',
  '4. 看不清的字符用【?】标出，不要猜测；',
  '5. 数学公式用常见文本写法（如 1/2、x^2、√3）；',
  '只输出转写内容，不要解答题目，不要添加任何评论。',
].join('\n');

export interface VisionConfig {
  apiKey: string;
  url: string;
  model: string;
}

export function getVisionConfig(env: {
  VISION_API_KEY?: string;
  VISION_API_URL?: string;
  VISION_MODEL?: string;
}): VisionConfig | null {
  if (!env.VISION_API_KEY) return null;
  return {
    apiKey: env.VISION_API_KEY,
    url: env.VISION_API_URL || DEFAULT_VISION_URL,
    model: env.VISION_MODEL || DEFAULT_VISION_MODEL,
  };
}

export function validateImageDataUrl(dataUrl: string): string | null {
  if (typeof dataUrl !== 'string') return '图片数据不合法';
  if (!/^data:image\/(?:jpe?g|png|webp);base64,/i.test(dataUrl)) return '仅支持 JPG/PNG/WebP 图片';
  if (dataUrl.length > MAX_IMAGE_BASE64_LENGTH) return '图片过大，请压缩后重试（最大约 4MB）';
  return null;
}

export function buildVisionRequestBody(model: string, imageDataUrl: string): unknown {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: OCR_PROMPT },
        ],
      },
    ],
    stream: false,
  };
}

// thinking 类模型可能把思考过程混入 content，转写结果只保留答案部分
function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\|begin_of_box\|>|<\|end_of_box\|>/g, '')
    .trim();
}

export function parseVisionResponse(json: unknown): string | null {
  const content = (
    json as { choices?: Array<{ message?: { content?: unknown } }> }
  )?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && stripThinking(content)) return stripThinking(content);
  // 部分兼容实现把 content 返回为分段数组
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('');
    const cleaned = stripThinking(text);
    return cleaned || null;
  }
  return null;
}

export async function transcribeImage(
  config: VisionConfig,
  imageDataUrl: string,
  timeoutMs = VISION_TIMEOUT_MS,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(buildVisionRequestBody(config.model, imageDataUrl)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new UserFacingError('图片识别超时，请重试或改为文字输入');
    }
    throw e;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`vision API error ${res.status}: ${detail.slice(0, 500)}`);
    if (res.status === 401) throw new UserFacingError('图片识别服务 Key 无效，请联系管理员');
    if (res.status === 429) throw new UserFacingError('图片识别请求过于频繁，请稍后再试');
    throw new UserFacingError('图片识别服务暂时不可用，请稍后再试或改为文字输入');
  }

  const json = (await res.json().catch(() => null)) as unknown;
  const text = parseVisionResponse(json);
  if (!text) throw new UserFacingError('未能识别出图片内容，请换个角度拍摄或改为文字输入');
  return text;
}
