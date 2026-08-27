import { z } from 'zod';
import type { AICapability } from '../../../shared/ai-catalog';
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

type EndpointPathContract =
  | { mode: 'append'; value: string }
  | { mode: 'exact'; value: string };

export interface CompiledAdapterMetadata {
  type: AdapterType;
  capability: AICapability;
  kind: AdapterKind;
  endpointPath: EndpointPathContract;
  endpointConfigSchema: z.ZodType<Record<string, unknown>>;
}

function isIpv4Literal(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

const mediaHostSuffixSchema = z.string().min(1).max(253).refine(
  (value) => value === value.toLowerCase() &&
    !value.includes('*') && !value.includes(':') && !isIpv4Literal(value) &&
    value.split('.').length >= 2 &&
    value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
  '媒体域名后缀必须是小写 DNS 后缀，且不能包含通配符、端口或 IP 地址',
);

const openAIEndpointConfigSchema = z.object({
  allowCustomModelId: z.boolean().optional(),
}).strict();

const tokenPlanTTSEndpointConfigSchema = z.object({
  formats: z.array(z.enum(['mp3', 'wav', 'pcm', 'opus', 'aac'])).min(1).max(5).optional(),
  sampleRates: z.array(z.union([
    z.literal(8000), z.literal(16000), z.literal(22050), z.literal(24000),
    z.literal(44100), z.literal(48000),
  ])).min(1).max(6).optional(),
  mediaHostSuffixes: z.array(mediaHostSuffixSchema).min(1).max(20),
}).strict();

const tokenPlanImageEndpointConfigSchema = z.object({
  sizes: z.array(z.enum(['512*512', '768*768', '1024*1024', '1280*720', '720*1280'])).min(1).max(5).optional(),
  mediaHostSuffixes: z.array(mediaHostSuffixSchema).min(1).max(20),
}).strict();

/** Single source of truth for every compiled adapter that may enter D1. */
export const COMPILED_ADAPTERS = {
  openai_text: {
    type: 'openai_text', capability: 'structured_text', kind: 'text',
    endpointPath: { mode: 'append', value: '/chat/completions' },
    endpointConfigSchema: openAIEndpointConfigSchema,
  },
  token_plan_tts: {
    type: 'token_plan_tts', capability: 'speech_synthesis', kind: 'speech',
    endpointPath: { mode: 'exact', value: '/api/v1/services/audio/tts/SpeechSynthesizer' },
    endpointConfigSchema: tokenPlanTTSEndpointConfigSchema,
  },
  token_plan_image: {
    type: 'token_plan_image', capability: 'image_generation', kind: 'image',
    endpointPath: { mode: 'exact', value: '/api/v1/services/aigc/multimodal-generation/generation' },
    endpointConfigSchema: tokenPlanImageEndpointConfigSchema,
  },
} as const satisfies Record<AdapterType, CompiledAdapterMetadata>;

export const COMPILED_ADAPTER_TYPES = Object.keys(COMPILED_ADAPTERS) as [AdapterType, ...AdapterType[]];

export function getCompiledAdapter(adapterType: AdapterType): CompiledAdapterMetadata {
  return COMPILED_ADAPTERS[adapterType];
}

export function getAdapterKind(adapterType: AdapterType): AdapterKind {
  return getCompiledAdapter(adapterType).kind;
}

export function adapterEndpointPathMatches(adapterType: AdapterType, baseUrl: string): boolean {
  const path = new URL(baseUrl).pathname.replace(/\/+$/, '') || '/';
  const contract = getCompiledAdapter(adapterType).endpointPath;
  return contract.mode === 'exact' ? path === contract.value : !path.endsWith(contract.value);
}

export function validateAdapterEndpointConfig(adapterType: AdapterType, config: unknown) {
  return getCompiledAdapter(adapterType).endpointConfigSchema.safeParse(config);
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
