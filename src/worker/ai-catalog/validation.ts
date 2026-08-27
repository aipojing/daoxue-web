import { z } from 'zod';
import {
  adapterEndpointPathMatches,
  COMPILED_ADAPTER_TYPES,
  getCompiledAdapter,
  type AdapterType,
  validateAdapterEndpointConfig,
} from '../courseware/adapters/registry';
import { assertPublicHttpsUrl } from '../lib/outbound-url';

const speechModelConfigSchema = z
  .object({
    format: z.enum(['mp3', 'wav', 'pcm', 'opus', 'aac']).optional(),
    sampleRate: z.union([
      z.literal(8000),
      z.literal(16000),
      z.literal(22050),
      z.literal(24000),
      z.literal(44100),
      z.literal(48000),
    ]).optional(),
  })
  .strict();

const imageModelConfigSchema = z
  .object({
    size: z.enum(['512*512', '768*768', '1024*1024', '1280*720', '720*1280']).optional(),
  })
  .strict();

const textModelConfigSchema = z.object({}).strict();

const modelConfigByCapability = {
  structured_text: textModelConfigSchema,
  speech_synthesis: speechModelConfigSchema,
  image_generation: imageModelConfigSchema,
} as const;

export const adminModelConfigSchema = z.union([
  speechModelConfigSchema,
  imageModelConfigSchema,
  textModelConfigSchema,
]);

export function validateModelConfig(
  capability: keyof typeof modelConfigByCapability,
  config: unknown,
) {
  return modelConfigByCapability[capability].safeParse(config);
}

export function projectPublicModelConfig(
  capability: keyof typeof modelConfigByCapability,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const candidate =
    capability === 'speech_synthesis'
      ? { format: config.format, sampleRate: config.sampleRate }
      : capability === 'image_generation'
        ? { size: config.size }
        : {};
  const withoutUndefined = Object.fromEntries(
    Object.entries(candidate).filter((entry) => entry[1] !== undefined),
  );
  const parsed = modelConfigByCapability[capability].safeParse(withoutUndefined);
  return parsed.success ? parsed.data : {};
}

export const credentialPatchSchema = z
  .object({
    apiKey: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export const preferenceSchema = z
  .object({
    purpose: z.enum(['courseware_text', 'courseware_image', 'teacher_tts', 'student_tts']),
    endpointId: z.number().int().positive(),
    modelCatalogId: z.number().int().positive().nullable(),
    customModelId: z.string().trim().max(150).default(''),
    voiceId: z.string().trim().max(150).default(''),
    params: z.record(z.unknown()).default({}),
  })
  .strict()
  .refine(
    (value) => (value.modelCatalogId !== null) !== (value.customModelId.length > 0),
    '必须选择目录模型或填写自定义模型 ID',
  );

export const preferenceListSchema = z
  .object({
    preferences: z.array(preferenceSchema).max(4),
  })
  .strict();

export function normalizeAdminEndpointUrl(value: string, adapterType?: AdapterType): string {
  const normalized = assertPublicHttpsUrl(value);
  const url = new URL(normalized);
  if (url.search || url.hash || url.pathname.includes('%')) throw new Error('invalid endpoint URL');
  if (adapterType && getCompiledAdapter(adapterType).endpointPath.mode === 'exact') {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  }
  return url.toString();
}

const rawAdminEndpointSchema = z.object({
  providerId: z.number().int().positive(),
  capability: z.enum(['structured_text', 'speech_synthesis', 'image_generation']),
  adapterType: z.enum(COMPILED_ADAPTER_TYPES),
  baseUrl: z.string().min(1).max(2048),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean(),
}).strict();

export const adminEndpointSchema = rawAdminEndpointSchema.superRefine((value, context) => {
  let safeUrl: string;
  try {
    safeUrl = normalizeAdminEndpointUrl(value.baseUrl, value.adapterType);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: 'Base URL 必须是公网 HTTPS 地址' });
    return;
  }
  if (getCompiledAdapter(value.adapterType).capability !== value.capability) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['capability'], message: '适配器能力与端点能力不匹配' });
  }
  if (!adapterEndpointPathMatches(value.adapterType, safeUrl)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: 'Base URL 路径与适配器协议不匹配' });
  }
  const config = validateAdapterEndpointConfig(value.adapterType, value.config);
  if (!config.success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['config'],
      message: config.error.issues[0]?.message ?? '端点配置不合法',
    });
  }
});
