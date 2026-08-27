import { z } from 'zod';

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
