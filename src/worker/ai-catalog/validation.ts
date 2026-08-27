import { z } from 'zod';

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

export const adminEndpointSchema = z
  .object({
    providerId: z.number().int().positive(),
    capability: z.enum(['structured_text', 'speech_synthesis', 'image_generation']),
    adapterType: z.enum(['openai_text', 'token_plan_tts', 'token_plan_image']),
    baseUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), 'Base URL 必须使用 HTTPS'),
    config: z.record(z.unknown()).default({}),
    enabled: z.boolean(),
  })
  .strict();
