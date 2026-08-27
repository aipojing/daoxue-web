import { openAITextAdapter } from './openai-text';
import { tokenPlanImageAdapter } from './token-plan-image';
import { tokenPlanTTSAdapter } from './token-plan-tts';
import type {
  ImageGenerationAdapter,
  SpeechSynthesisAdapter,
  TextGenerationAdapter,
} from './types';

export type AdapterType = 'openai_text' | 'token_plan_tts' | 'token_plan_image';
export type AdapterKind = 'text' | 'speech' | 'image';

/** The only adapter identifiers administrators may persist in the catalog. */
export const COMPILED_ADAPTER_TYPES = [
  'openai_text',
  'token_plan_tts',
  'token_plan_image',
] as const satisfies readonly AdapterType[];

export function getAdapterKind(adapterType: AdapterType): AdapterKind {
  if (adapterType === 'openai_text') return 'text';
  if (adapterType === 'token_plan_tts') return 'speech';
  return 'image';
}

export function createTextAdapter(adapterType: AdapterType): TextGenerationAdapter {
  if (adapterType !== 'openai_text') throw new Error('文本适配器类型不受支持');
  return openAITextAdapter;
}

export function createSpeechAdapter(adapterType: AdapterType): SpeechSynthesisAdapter {
  if (adapterType !== 'token_plan_tts') throw new Error('语音适配器类型不受支持');
  return tokenPlanTTSAdapter;
}

export function createImageAdapter(adapterType: AdapterType): ImageGenerationAdapter {
  if (adapterType !== 'token_plan_image') throw new Error('图片适配器类型不受支持');
  return tokenPlanImageAdapter;
}
