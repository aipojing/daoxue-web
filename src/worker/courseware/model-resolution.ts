import { z } from 'zod';
import type { AICapability, CoursewareModelPurpose } from '../../shared/ai-catalog';
import { resolveCredentialWithRevision, type CredentialRevision } from '../ai-catalog/credentials';
import { resolvePreference, type ResolvedModelSelection } from '../ai-catalog/repository';
import type { Env } from '../env';
import { ProviderCallError } from './adapters/errors';
import { COMPILED_ADAPTER_TYPES, type AdapterType } from './adapters/registry';
import type { CoursewareDetailRow } from './repository';

export interface ResolvedModelCall {
  providerId: number;
  providerSlug: string;
  endpointId: number;
  adapterType: AdapterType;
  baseUrl: string;
  capability: AICapability;
  modelId: string;
  apiKey: string;
  credentialRevision: CredentialRevision;
  endpointConfig: Record<string, unknown>;
  modelConfig: Record<string, unknown>;
  params: Record<string, unknown>;
}

export interface ResolvedCoursewareModels {
  text: ResolvedModelCall;
  teacherSpeech: ResolvedModelCall & { voiceId: string };
  studentSpeech: ResolvedModelCall & { voiceId: string };
  image: ResolvedModelCall | null;
}

const snapshotCallSchema = z.object({
  providerId: z.number().int().positive(),
  providerSlug: z.string().min(1).max(100),
  endpointId: z.number().int().positive(),
  adapterType: z.enum(COMPILED_ADAPTER_TYPES),
  adapterVersion: z.literal('v1'),
  baseUrl: z.string().url().refine((value) => value.startsWith('https://')),
  capability: z.enum(['structured_text', 'speech_synthesis', 'image_generation']),
  modelId: z.string().min(1).max(150),
  voiceId: z.string().max(150),
  endpointConfig: z.record(z.unknown()),
  modelConfig: z.record(z.unknown()),
  params: z.record(z.unknown()),
}).strict();

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  promptVersion: z.literal('courseware-v1'),
  includeImages: z.boolean(),
  text: snapshotCallSchema,
  teacherSpeech: snapshotCallSchema,
  studentSpeech: snapshotCallSchema,
  image: snapshotCallSchema.nullable(),
}).strict();

function assertKind(
  selection: { capability: AICapability; adapterType: AdapterType; voiceId: string },
  capability: AICapability,
  adapterType: AdapterType,
  needsVoice: boolean,
): void {
  if (selection.capability !== capability || selection.adapterType !== adapterType ||
      (needsVoice ? selection.voiceId.length === 0 : selection.voiceId.length !== 0)) {
    throw new ProviderCallError(needsVoice ? 'incompatible_voice' : 'model_unavailable', 422);
  }
}

async function withCredential(
  env: Env,
  userId: number,
  selection: Omit<ResolvedModelSelection, 'purpose'> | z.infer<typeof snapshotCallSchema>,
): Promise<ResolvedModelCall> {
  let credential;
  try {
    credential = await resolveCredentialWithRevision(env.DB, env, userId, selection.providerId);
  } catch {
    throw new ProviderCallError('internal_error', 503);
  }
  if (!credential?.apiKey) throw new ProviderCallError('missing_credential', 401);
  if (credential.healthStatus === 'invalid') throw new ProviderCallError('invalid_credential', 401);
  if (credential.healthStatus === 'quota_exhausted') throw new ProviderCallError('quota_exhausted', 402);
  return {
    providerId: selection.providerId,
    providerSlug: selection.providerSlug,
    endpointId: selection.endpointId,
    adapterType: selection.adapterType,
    baseUrl: selection.baseUrl,
    capability: selection.capability,
    modelId: selection.modelId,
    apiKey: credential.apiKey,
    credentialRevision: credential.revision,
    endpointConfig: selection.endpointConfig,
    modelConfig: selection.modelConfig,
    params: selection.params,
  };
}

async function creationSelection(env: Env, userId: number, purpose: CoursewareModelPurpose) {
  const selection = await resolvePreference(env.DB, userId, purpose);
  if (!selection) throw new ProviderCallError('model_unavailable', 422);
  return selection;
}

export async function resolveModelsForCreation(
  env: Env,
  userId: number,
  includeImages: boolean,
): Promise<ResolvedCoursewareModels> {
  const [text, teacherSpeech, studentSpeech, image] = await Promise.all([
    creationSelection(env, userId, 'courseware_text'),
    creationSelection(env, userId, 'teacher_tts'),
    creationSelection(env, userId, 'student_tts'),
    includeImages ? creationSelection(env, userId, 'courseware_image') : Promise.resolve(null),
  ]);
  assertKind(text, 'structured_text', 'openai_text', false);
  assertKind(teacherSpeech, 'speech_synthesis', 'token_plan_tts', true);
  assertKind(studentSpeech, 'speech_synthesis', 'token_plan_tts', true);
  if (image) assertKind(image, 'image_generation', 'token_plan_image', false);
  return {
    text: await withCredential(env, userId, text),
    teacherSpeech: { ...await withCredential(env, userId, teacherSpeech), voiceId: teacherSpeech.voiceId },
    studentSpeech: { ...await withCredential(env, userId, studentSpeech), voiceId: studentSpeech.voiceId },
    image: image ? await withCredential(env, userId, image) : null,
  };
}

async function assertSnapshotIdentity(env: Env, providerId: number, endpointId: number): Promise<void> {
  const relation = await env.DB.prepare(
    `SELECT e.id FROM ai_provider_endpoints e JOIN ai_providers p ON p.id = e.provider_id
     WHERE p.id = ? AND e.id = ?`,
  ).bind(providerId, endpointId).first<{ id: number }>();
  if (!relation) throw new ProviderCallError('model_unavailable', 422);
}

function parseJobSnapshot(courseware: CoursewareDetailRow): z.infer<typeof snapshotSchema> {
  try {
    const snapshot = snapshotSchema.parse(JSON.parse(courseware.model_snapshot_json));
    assertKind(snapshot.text, 'structured_text', 'openai_text', false);
    assertKind(snapshot.teacherSpeech, 'speech_synthesis', 'token_plan_tts', true);
    assertKind(snapshot.studentSpeech, 'speech_synthesis', 'token_plan_tts', true);
    if (snapshot.image) assertKind(snapshot.image, 'image_generation', 'token_plan_image', false);
    if (snapshot.includeImages !== Boolean(snapshot.image)) throw new Error('snapshot mismatch');
    return snapshot;
  } catch (error) {
    if (error instanceof ProviderCallError) throw error;
    throw new ProviderCallError('model_unavailable', 422);
  }
}

async function resolveSnapshotCall(
  env: Env,
  courseware: CoursewareDetailRow,
  selection: z.infer<typeof snapshotCallSchema>,
): Promise<ResolvedModelCall> {
  await assertSnapshotIdentity(env, selection.providerId, selection.endpointId);
  return withCredential(env, courseware.owner_user_id, selection);
}

export async function resolveTextModelForJob(env: Env, courseware: CoursewareDetailRow): Promise<ResolvedModelCall> {
  return resolveSnapshotCall(env, courseware, parseJobSnapshot(courseware).text);
}

export async function resolveSpeechModelsForJob(env: Env, courseware: CoursewareDetailRow): Promise<{
  teacherSpeech: ResolvedModelCall & { voiceId: string };
  studentSpeech: ResolvedModelCall & { voiceId: string };
}> {
  const [teacherSpeech, studentSpeech] = await Promise.all([
    resolveTeacherSpeechModelForJob(env, courseware),
    resolveStudentSpeechModelForJob(env, courseware),
  ] as const);
  return { teacherSpeech, studentSpeech };
}

export async function resolveTeacherSpeechModelForJob(
  env: Env,
  courseware: CoursewareDetailRow,
): Promise<ResolvedModelCall & { voiceId: string }> {
  const snapshot = parseJobSnapshot(courseware);
  const teacherSpeech = await resolveSnapshotCall(env, courseware, snapshot.teacherSpeech);
  return { ...teacherSpeech, voiceId: snapshot.teacherSpeech.voiceId };
}

export async function resolveStudentSpeechModelForJob(
  env: Env,
  courseware: CoursewareDetailRow,
): Promise<ResolvedModelCall & { voiceId: string }> {
  const snapshot = parseJobSnapshot(courseware);
  const studentSpeech = await resolveSnapshotCall(env, courseware, snapshot.studentSpeech);
  return { ...studentSpeech, voiceId: snapshot.studentSpeech.voiceId };
}

export async function resolveImageModelForJob(
  env: Env,
  courseware: CoursewareDetailRow,
): Promise<ResolvedModelCall | null> {
  const image = parseJobSnapshot(courseware).image;
  return image ? resolveSnapshotCall(env, courseware, image) : null;
}

export function hasImageModelSnapshot(courseware: CoursewareDetailRow): boolean {
  return parseJobSnapshot(courseware).image !== null;
}

export async function resolveModelsForJob(
  env: Env,
  courseware: CoursewareDetailRow,
): Promise<ResolvedCoursewareModels> {
  const [text, speech, image] = await Promise.all([
    resolveTextModelForJob(env, courseware),
    resolveSpeechModelsForJob(env, courseware),
    resolveImageModelForJob(env, courseware),
  ] as const);
  return {
    text,
    teacherSpeech: speech.teacherSpeech,
    studentSpeech: speech.studentSpeech,
    image,
  };
}
