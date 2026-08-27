import type { CoursewareModelPurpose } from '../../shared/ai-catalog';
import type { Env } from '../env';
import { resolveCredentialWithRevision, type CredentialRevision } from './credentials';
import {
  recordCredentialHealthForRevision,
  reserveConnectionTest,
  resolvePreference,
  type ResolvedModelSelection,
} from './repository';
import { ProviderCallError, normalizeProviderError } from '../courseware/adapters/errors';
import {
  createImageAdapter,
  createSpeechAdapter,
  createTextAdapter,
} from '../courseware/adapters/registry';

const TEXT_TEST_MESSAGES = [
  { role: 'system' as const, content: '只回复：连接成功' },
  { role: 'user' as const, content: '请执行连接测试。' },
] as const;
const SPEECH_TEST_TEXT = '你好，这是老师语音试听。';
const IMAGE_TEST_PROMPT = '儿童教育插图，一只红苹果和一只蓝色铅笔，纯色背景，无文字，无商标';
const CONNECTION_TIMEOUT_MS = 15_000;
const TEXT_MAX_OUTPUT_TOKENS = 16;
const IMAGE_TEST_SIZE = '1024*1024';

export type ConnectionTestCapability = 'text' | 'teacher_tts' | 'student_tts' | 'image';

export interface TextTestResult {
  status: 'valid';
}

export interface BinaryTestResult {
  status: 'valid';
  bytes: ArrayBuffer;
  contentType: string;
}

const PURPOSE: Record<ConnectionTestCapability, CoursewareModelPurpose> = {
  text: 'courseware_text',
  teacher_tts: 'teacher_tts',
  student_tts: 'student_tts',
  image: 'courseware_image',
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function assertCompatibleSelection(
  capability: ConnectionTestCapability,
  selection: ResolvedModelSelection,
): void {
  const compatible = capability === 'text'
    ? selection.capability === 'structured_text' && selection.adapterType === 'openai_text' && !selection.voiceId
    : capability === 'image'
      ? selection.capability === 'image_generation' && selection.adapterType === 'token_plan_image' && !selection.voiceId
      : selection.capability === 'speech_synthesis' && selection.adapterType === 'token_plan_tts' && !!selection.voiceId;
  if (!compatible) {
    throw new ProviderCallError(
      capability === 'teacher_tts' || capability === 'student_tts'
        ? 'incompatible_voice'
        : 'model_unavailable',
      422,
    );
  }
}

async function recordHealth(
  env: Env,
  userId: number,
  providerId: number,
  revision: CredentialRevision,
  status: 'valid' | 'invalid' | 'quota_exhausted',
): Promise<void> {
  try {
    await recordCredentialHealthForRevision(
      env.DB,
      userId,
      providerId,
      revision,
      status,
    );
  } catch {
    // Health is advisory; never discard a successful bounded sample or replace a normalized failure.
  }
}

async function resolveCurrentPersonalCall(
  env: Env,
  userId: number,
  capability: ConnectionTestCapability,
): Promise<{ selection: ResolvedModelSelection; apiKey: string; revision: CredentialRevision }> {
  let selection: ResolvedModelSelection | null;
  try {
    selection = await resolvePreference(env.DB, userId, PURPOSE[capability]);
  } catch {
    throw new ProviderCallError('internal_error', 503);
  }
  if (!selection) throw new ProviderCallError('model_unavailable', 422);
  assertCompatibleSelection(capability, selection);

  let credential;
  try {
    credential = await resolveCredentialWithRevision(env.DB, env, userId, selection.providerId);
  } catch {
    throw new ProviderCallError('internal_error', 503);
  }
  // Connection tests intentionally use only the current catalog credential row. They never
  // consume shared or legacy fallback keys.
  if (!credential?.apiKey || credential.revision.source !== 'catalog') {
    throw new ProviderCallError('missing_credential', 401);
  }
  return { selection, apiKey: credential.apiKey, revision: credential.revision };
}

async function reserveDailyAttempt(env: Env, userId: number): Promise<void> {
  const utcDate = new Date().toISOString().slice(0, 10);
  if (!await reserveConnectionTest(env.DB, userId, utcDate)) {
    throw new ProviderCallError('rate_limited', 429);
  }
}

export async function testConfiguredCapability(
  env: Env,
  userId: number,
  capability: ConnectionTestCapability,
): Promise<TextTestResult | BinaryTestResult> {
  const { selection, apiKey, revision } = await resolveCurrentPersonalCall(env, userId, capability);
  await reserveDailyAttempt(env, userId);

  try {
    let result: TextTestResult | BinaryTestResult;
    if (capability === 'text') {
      await createTextAdapter(selection.adapterType).generateStructured({
        baseUrl: selection.baseUrl,
        apiKey,
        modelId: selection.modelId,
        system: TEXT_TEST_MESSAGES[0].content,
        user: TEXT_TEST_MESSAGES[1].content,
        timeoutMs: CONNECTION_TIMEOUT_MS,
        maxOutputTokens: TEXT_MAX_OUTPUT_TOKENS,
        responseFormat: 'text',
      });
      result = { status: 'valid' };
    } else if (capability === 'image') {
      const media = await createImageAdapter(selection.adapterType).generate({
        baseUrl: selection.baseUrl,
        apiKey,
        modelId: selection.modelId,
        prompt: IMAGE_TEST_PROMPT,
        size: IMAGE_TEST_SIZE,
        allowedMediaHostSuffixes: stringArray(selection.endpointConfig.mediaHostSuffixes),
        timeoutMs: CONNECTION_TIMEOUT_MS,
      });
      result = { status: 'valid', bytes: media.bytes, contentType: media.contentType };
    } else {
      const media = await createSpeechAdapter(selection.adapterType).synthesize({
        baseUrl: selection.baseUrl,
        apiKey,
        modelId: selection.modelId,
        voiceId: selection.voiceId,
        text: SPEECH_TEST_TEXT,
        format: 'mp3',
        sampleRate: 24000,
        allowedMediaHostSuffixes: stringArray(selection.endpointConfig.mediaHostSuffixes),
        timeoutMs: CONNECTION_TIMEOUT_MS,
      });
      result = { status: 'valid', bytes: media.bytes, contentType: media.contentType };
    }
    await recordHealth(env, userId, selection.providerId, revision, 'valid');
    return result;
  } catch (rawError) {
    const error = normalizeProviderError(rawError);
    const status = error.errorCode === 'invalid_credential'
      ? 'invalid'
      : error.errorCode === 'quota_exhausted'
        ? 'quota_exhausted'
        : null;
    if (status) await recordHealth(env, userId, selection.providerId, revision, status);
    throw error;
  }
}
