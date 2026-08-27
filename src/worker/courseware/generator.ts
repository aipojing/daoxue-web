import { recordCredentialHealthForRevision } from '../ai-catalog/repository';
import type { CredentialRevision } from '../ai-catalog/credentials';
import type { Env } from '../env';
import { buildCoursewareMediaAttemptKey, buildCoursewareMediaKey } from './media';
import { buildCoursewarePrompt } from './prompt-builder';
import { createCoursewareRepository, type CoursewareDetailRow, type CoursewareSegmentRow } from './repository';
import { parseCoursewareScript } from './schema';
import { cleanupCoursewareAttemptObject, persistCoursewareArtifact } from './service';
import { ProviderCallError } from './adapters/errors';
import { createImageAdapter, createSpeechAdapter, createTextAdapter } from './adapters/registry';
import type {
  BinaryMediaResult,
  ImageGenerationRequest,
  SpeechSynthesisRequest,
  TextGenerationRequest,
  TextGenerationResult,
} from './adapters/types';
import { readMp3DurationMs } from './audio-metadata';
import {
  resolveImageModelForJob,
  resolveStudentSpeechModelForJob,
  resolveTeacherSpeechModelForJob,
  resolveTextModelForJob,
  type ResolvedModelCall,
} from './model-resolution';

export type SpeechSynthesisResult = BinaryMediaResult;
export type ImageGenerationResult = BinaryMediaResult;

export interface CoursewareGenerationDependencies {
  now(): Date;
  generateText(call: ResolvedModelCall, request: TextGenerationRequest): Promise<TextGenerationResult>;
  synthesizeSpeech(call: ResolvedModelCall, request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>;
  generateImage(call: ResolvedModelCall, request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  recordCredentialHealth(
    env: Env,
    userId: number,
    providerId: number,
    revision: CredentialRevision,
    status: 'valid' | 'invalid' | 'quota_exhausted',
  ): Promise<boolean>;
}

const LEASE_MS = 5 * 60 * 1000;
const MAX_ARTIFACTS_PER_ADVANCE = 5;
const MAX_ITEM_ATTEMPTS = 3;
const TRANSIENT_CODES = new Set(['rate_limited', 'provider_timeout', 'provider_unavailable', 'storage_failed']);
const IMAGE_WARNING = '部分配图生成失败，不影响语音课件播放';

const defaultDependencies: CoursewareGenerationDependencies = {
  now: () => new Date(),
  generateText: (call, request) => createTextAdapter(call.adapterType).generateStructured(request),
  synthesizeSpeech: (call, request) => createSpeechAdapter(call.adapterType).synthesize(request),
  generateImage: (call, request) => createImageAdapter(call.adapterType).generate(request),
  recordCredentialHealth: (env, userId, providerId, revision, status) =>
    recordCredentialHealthForRevision(env.DB, userId, providerId, revision, status),
};

function sqliteTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function timeoutMs(call: ResolvedModelCall): number {
  const configured = call.params.timeoutMs ?? call.endpointConfig.timeoutMs;
  return typeof configured === 'number' && Number.isInteger(configured) && configured >= 1_000 && configured <= 120_000
    ? configured
    : 30_000;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function imageSize(call: ResolvedModelCall): string {
  const value = call.params.size ?? call.modelConfig.size;
  if (typeof value !== 'string' || !/^[1-9]\d{2,4}\*[1-9]\d{2,4}$/.test(value)) {
    throw new ProviderCallError('model_unavailable', 422);
  }
  return value;
}

function normalizedError(error: unknown): ProviderCallError {
  return error instanceof ProviderCallError ? error : new ProviderCallError('internal_error', 500);
}

function safeRequestId(value: unknown, apiKey: string): string {
  return typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value) &&
    !value.includes(apiKey) ? value : '';
}

async function recordHealth(
  dependencies: CoursewareGenerationDependencies,
  env: Env,
  courseware: CoursewareDetailRow,
  call: ResolvedModelCall,
  error?: ProviderCallError,
): Promise<void> {
  const status = !error ? 'valid'
    : error.errorCode === 'invalid_credential' ? 'invalid'
      : error.errorCode === 'quota_exhausted' ? 'quota_exhausted' : null;
  if (!status) return;
  try {
    await dependencies.recordCredentialHealth(
      env, courseware.owner_user_id, call.providerId, call.credentialRevision, status,
    );
  } catch {
    // Credential health is advisory. Never discard paid output or replace the normalized job failure.
  }
}

async function claimLease(env: Env, courseware: CoursewareDetailRow, leaseToken: string, now: Date): Promise<boolean> {
  const nextStage = courseware.generation_stage === 'queued' ? 'scripting' : courseware.generation_stage;
  const nextStatus = courseware.status === 'ready' ? 'ready' : 'generating';
  const result = await env.DB.prepare(
    `UPDATE coursewares SET status = ?, generation_stage = ?, lease_token = ?, lease_expires_at = ?,
       enqueue_token = NULL, enqueue_kind = NULL, enqueue_expires_at = NULL, updated_at = datetime('now')
     WHERE id = ? AND status = ? AND generation_stage = ?
       AND (lease_token IS NULL OR lease_expires_at <= ?)`,
  ).bind(nextStatus, nextStage, leaseToken, sqliteTime(new Date(now.getTime() + LEASE_MS)),
    courseware.id, courseware.status, courseware.generation_stage, sqliteTime(now)).run();
  return result.meta.changes === 1;
}

async function renewLease(env: Env, coursewareId: number, leaseToken: string, now: Date): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE coursewares SET lease_expires_at = ?, updated_at = datetime('now')
     WHERE id = ? AND lease_token = ? AND status IN ('generating', 'ready')`,
  ).bind(sqliteTime(new Date(now.getTime() + LEASE_MS)), coursewareId, leaseToken).run();
  return result.meta.changes === 1;
}

async function setStage(
  env: Env,
  courseware: CoursewareDetailRow,
  leaseToken: string,
  from: string,
  to: string,
  progress?: number,
): Promise<boolean> {
  const progressSql = progress === undefined ? '' : ', progress_percent = ?';
  const statement = env.DB.prepare(
    `UPDATE coursewares SET generation_stage = ?${progressSql}, updated_at = datetime('now')
     WHERE id = ? AND status = ? AND generation_stage = ? AND lease_token = ?`,
  );
  const result = progress === undefined
    ? await statement.bind(to, courseware.id, courseware.status, from, leaseToken).run()
    : await statement.bind(to, progress, courseware.id, courseware.status, from, leaseToken).run();
  return result.meta.changes === 1;
}

async function releaseLease(env: Env, coursewareId: number, leaseToken: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE coursewares SET lease_token = NULL, lease_expires_at = NULL, updated_at = datetime('now')
     WHERE id = ? AND lease_token = ?`,
  ).bind(coursewareId, leaseToken).run();
}

async function failCourseware(
  env: Env,
  courseware: CoursewareDetailRow,
  leaseToken: string,
  error: ProviderCallError,
): Promise<'done' | 'ignored'> {
  const committed = await createCoursewareRepository(env.DB).markFailed(
    courseware.id,
    error.errorCode,
    error.message,
    error.retryable,
    { status: courseware.status, stage: courseware.generation_stage, leaseToken },
  );
  return committed ? 'done' : 'ignored';
}

async function advanceScripting(
  env: Env,
  courseware: CoursewareDetailRow,
  leaseToken: string,
  dependencies: CoursewareGenerationDependencies,
): Promise<'done' | 'reenqueue' | 'ignored'> {
  let textCall: ResolvedModelCall | undefined;
  try {
    const text = await resolveTextModelForJob(env, courseware);
    textCall = text;
    if (!await renewLease(env, courseware.id, leaseToken, dependencies.now())) return 'ignored';
    const prompt = buildCoursewarePrompt({
      grade: courseware.grade,
      subject: courseware.subject,
      topic: courseware.topic,
      learningGoal: courseware.learning_goal,
      profileExcerpt: '',
      relatedKnowledge: [],
      sourceText: courseware.source_text,
    });
    const result = await dependencies.generateText(text, {
      baseUrl: text.baseUrl,
      apiKey: text.apiKey,
      modelId: text.modelId,
      system: prompt.system,
      user: prompt.user,
      timeoutMs: timeoutMs(text),
    });
    if (!await renewLease(env, courseware.id, leaseToken, dependencies.now())) return 'ignored';
    let parsed;
    try {
      parsed = parseCoursewareScript(result.jsonText);
    } catch {
      throw new ProviderCallError('invalid_model_output', 502);
    }
    const repository = createCoursewareRepository(env.DB);
    if (!await repository.saveScript(courseware.id, parsed, {
      status: courseware.status,
      stage: courseware.generation_stage,
      leaseToken,
    }, { inputTokens: result.inputTokens, outputTokens: result.outputTokens })) return 'ignored';
    await recordHealth(dependencies, env, courseware, text);
    return 'reenqueue';
  } catch (error) {
    const normalized = normalizedError(error);
    if (TRANSIENT_CODES.has(normalized.errorCode)) {
      const retry = await env.DB.prepare(
        `UPDATE coursewares SET usage_json = json_set(usage_json, '$.textRetryCount',
             COALESCE(json_extract(usage_json, '$.textRetryCount'), 0) + 1),
           error_code = ?, error_message = ?, retryable = 1, updated_at = datetime('now')
         WHERE id = ? AND status = ? AND generation_stage = 'scripting' AND lease_token = ?
         RETURNING CAST(json_extract(usage_json, '$.textRetryCount') AS INTEGER) AS retry_count`,
      ).bind(normalized.errorCode, normalized.message, courseware.id, courseware.status, leaseToken)
        .first<{ retry_count: number }>();
      if (retry && retry.retry_count < MAX_ITEM_ATTEMPTS) {
        if (textCall) await recordHealth(dependencies, env, courseware, textCall, normalized);
        return 'reenqueue';
      }
      if (!retry) return 'ignored';
    }
    const outcome = await failCourseware(env, courseware, leaseToken, normalized);
    if (textCall) await recordHealth(dependencies, env, courseware, textCall, normalized);
    return outcome;
  }
}

type AudioVariant = 'main' | 'alternate';
interface AudioWork { segment: CoursewareSegmentRow; variant: AudioVariant }

function pendingAudioWork(courseware: CoursewareDetailRow): AudioWork[] {
  const work: AudioWork[] = [];
  for (const item of courseware.segments) {
    if (item.audio_status === 'pending') work.push({ segment: item, variant: 'main' });
    if (item.alternate_audio_status === 'pending') work.push({ segment: item, variant: 'alternate' });
  }
  return work.sort((left, right) => left.segment.position - right.segment.position ||
    (left.variant === right.variant ? 0 : left.variant === 'main' ? -1 : 1));
}

function audioFields(variant: AudioVariant) {
  return variant === 'main'
    ? { status: 'audio_status', object: 'audio_object_key', retry: 'audio_retry_count', errorCode: 'audio_error_code', errorMessage: 'audio_error_message' }
    : { status: 'alternate_audio_status', object: 'alternate_audio_object_key', retry: 'alternate_audio_retry_count', errorCode: 'alternate_audio_error_code', errorMessage: 'alternate_audio_error_message' };
}

function artifactFields(variant: AudioVariant | 'image') {
  return variant === 'image'
    ? { status: 'image_status', object: 'image_object_key', retry: 'image_retry_count', errorCode: 'image_error_code', errorMessage: 'image_error_message' }
    : audioFields(variant);
}

type ObjectInspection = 'ready' | 'missing' | 'retry' | 'failed' | 'lost';

async function inspectStoredArtifact(
  env: Env,
  courseware: CoursewareDetailRow,
  leaseToken: string,
  stage: 'speech' | 'images' | 'finalizing',
  segmentId: number,
  variant: AudioVariant | 'image',
  currentStatus: string,
  objectKey: string,
): Promise<ObjectInspection> {
  const fields = artifactFields(variant);
  let object: R2Object | null;
  try {
    object = await env.COURSEWARE_MEDIA.head(objectKey);
  } catch {
    const updated = await env.DB.prepare(
      `UPDATE courseware_segments SET ${fields.retry} = ${fields.retry} + 1,
         ${fields.status} = CASE WHEN ${fields.retry} + 1 < ? THEN ${fields.status} ELSE 'failed' END,
         ${fields.errorCode} = 'storage_failed', ${fields.errorMessage} = '媒体文件保存失败',
         updated_at = datetime('now')
       WHERE id = ? AND courseware_id = ? AND ${fields.status} = ? AND EXISTS (
         SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = ?
       ) RETURNING ${fields.retry} AS retry_count, ${fields.status} AS artifact_status`,
    ).bind(MAX_ITEM_ATTEMPTS, segmentId, courseware.id, currentStatus,
      courseware.id, leaseToken, stage).first<{ retry_count: number; artifact_status: string }>();
    if (!updated) return 'lost';
    return updated.artifact_status === 'failed' ? 'failed' : 'retry';
  }
  if (!object) return 'missing';
  const restored = await env.DB.prepare(
    `UPDATE courseware_segments SET ${fields.status} = 'ready', ${fields.retry} = 0,
       ${fields.errorCode} = '', ${fields.errorMessage} = '', updated_at = datetime('now')
     WHERE id = ? AND courseware_id = ? AND ${fields.status} = ? AND ${fields.object} = ? AND EXISTS (
       SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = ?
     )`,
  ).bind(segmentId, courseware.id, currentStatus, objectKey,
    courseware.id, leaseToken, stage).run();
  return restored.meta.changes === 1 ? 'ready' : 'lost';
}

async function resetMissingReadyAudio(
  env: Env,
  courseware: CoursewareDetailRow,
  leaseToken: string,
): Promise<'ok' | 'reenqueue' | 'failed' | 'ignored'> {
  for (const segment of courseware.segments) {
    for (const variant of ['main', 'alternate'] as const) {
      const fields = audioFields(variant);
      const status = segment[fields.status as keyof CoursewareSegmentRow];
      const objectKey = segment[fields.object as keyof CoursewareSegmentRow];
      if (status !== 'ready' || typeof objectKey !== 'string') continue;
      const inspection = await inspectStoredArtifact(
        env, courseware, leaseToken, 'speech', segment.id, variant, 'ready', objectKey,
      );
      if (inspection === 'retry') return 'reenqueue';
      if (inspection === 'failed') return 'failed';
      if (inspection === 'lost') return 'ignored';
      if (inspection === 'missing') {
        await env.DB.prepare(
          `UPDATE courseware_segments SET ${fields.status} = 'pending', ${fields.object} = '',
             ${fields.retry} = 0, ${fields.errorCode} = '', ${fields.errorMessage} = ''
           WHERE id = ? AND courseware_id = ? AND ${fields.status} = 'ready' AND EXISTS (
             SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'speech'
           )`,
        ).bind(segment.id, courseware.id, courseware.id, leaseToken).run();
      }
    }
  }
  return 'ok';
}

async function updateProgress(env: Env, coursewareId: number, leaseToken: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE coursewares SET progress_percent = MIN(95, 10 + CAST(85.0 * (
       SELECT COALESCE(SUM(
         CASE WHEN audio_status = 'ready' THEN 1 ELSE 0 END +
         CASE WHEN alternate_audio_status IN ('ready', 'not_required') THEN 1 ELSE 0 END +
         CASE WHEN image_status IN ('ready', 'failed', 'not_required') THEN 1 ELSE 0 END
       ), 0) FROM courseware_segments WHERE courseware_id = coursewares.id
     ) / MAX(1, (
       SELECT COUNT(*) * 3 FROM courseware_segments WHERE courseware_id = coursewares.id
     )) AS INTEGER)), updated_at = datetime('now')
     WHERE id = ? AND lease_token = ?`,
  ).bind(coursewareId, leaseToken).run();
}

async function hasFailedRequiredSpeech(env: Env, coursewareId: number): Promise<boolean> {
  const failed = await env.DB.prepare(
    `SELECT 1 AS failed FROM courseware_segments WHERE courseware_id = ? AND
     (audio_status = 'failed' OR alternate_audio_status = 'failed') LIMIT 1`,
  ).bind(coursewareId).first<{ failed: number }>();
  return failed?.failed === 1;
}

async function advanceSpeech(
  env: Env,
  courseware: CoursewareDetailRow,
  leaseToken: string,
  dependencies: CoursewareGenerationDependencies,
): Promise<'done' | 'reenqueue' | 'ignored'> {
  try {
    await env.DB.prepare(
      `UPDATE courseware_segments SET
         audio_status = CASE WHEN audio_status = 'generating' THEN 'pending' ELSE audio_status END,
         alternate_audio_status = CASE WHEN alternate_audio_status = 'generating' THEN 'pending' ELSE alternate_audio_status END
       WHERE courseware_id = ? AND EXISTS (
         SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'speech'
       )`,
    ).bind(courseware.id, courseware.id, leaseToken).run();
    const refreshed = await createCoursewareRepository(env.DB).getForWorker(courseware.id);
    if (!refreshed) return 'ignored';
    const storage = await resetMissingReadyAudio(env, refreshed, leaseToken);
    if (storage === 'reenqueue') return 'reenqueue';
    if (storage === 'failed') return failCourseware(
      env, courseware, leaseToken, new ProviderCallError('storage_failed', 503),
    );
    if (storage === 'ignored') return 'ignored';
    const latest = await createCoursewareRepository(env.DB).getForWorker(courseware.id);
    if (!latest) return 'ignored';
    if (await hasFailedRequiredSpeech(env, courseware.id)) return failCourseware(
      env, courseware, leaseToken, new ProviderCallError('provider_unavailable', 503),
    );
    const batch = pendingAudioWork(latest).slice(0, MAX_ARTIFACTS_PER_ADVANCE);
    if (batch.length === 0) {
      return await setStage(env, courseware, leaseToken, 'speech', 'images') ? 'reenqueue' : 'ignored';
    }
    const generationBatch: AudioWork[] = [];
    for (const item of batch) {
      const fields = audioFields(item.variant);
      const retainedKey = item.segment[fields.object as keyof CoursewareSegmentRow];
      if (typeof retainedKey !== 'string' || retainedKey.length === 0) {
        generationBatch.push(item);
        continue;
      }
      const inspection = await inspectStoredArtifact(
        env, courseware, leaseToken, 'speech', item.segment.id, item.variant, 'pending', retainedKey,
      );
      if (inspection === 'retry') return 'reenqueue';
      if (inspection === 'failed') return failCourseware(
        env, courseware, leaseToken, new ProviderCallError('storage_failed', 503),
      );
      if (inspection === 'lost') return 'ignored';
      if (inspection === 'missing') generationBatch.push(item);
    }
    if (generationBatch.length === 0) {
      const remaining = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM courseware_segments WHERE courseware_id = ? AND
         (audio_status = 'pending' OR alternate_audio_status = 'pending')`,
      ).bind(courseware.id).first<{ count: number }>();
      if ((remaining?.count ?? 0) > 0) return 'reenqueue';
      if (await hasFailedRequiredSpeech(env, courseware.id)) return failCourseware(
        env, courseware, leaseToken, new ProviderCallError('provider_unavailable', 503),
      );
      return await setStage(env, courseware, leaseToken, 'speech', 'images') ? 'reenqueue' : 'ignored';
    }
    const needsStudent = generationBatch.some((item) => item.segment.speaker === 'student');
    const needsTeacher = generationBatch.some((item) => item.segment.speaker !== 'student');
    const [teacherModel, studentModel] = await Promise.all([
      needsTeacher ? resolveTeacherSpeechModelForJob(env, courseware) : Promise.resolve(null),
      needsStudent ? resolveStudentSpeechModelForJob(env, courseware) : Promise.resolve(null),
    ] as const);
    for (const item of generationBatch) {
      if (!await renewLease(env, courseware.id, leaseToken, dependencies.now())) return 'ignored';
      const fields = audioFields(item.variant);
      const claimed = await env.DB.prepare(
        `UPDATE courseware_segments SET ${fields.status} = 'generating', updated_at = datetime('now')
         WHERE id = ? AND courseware_id = ? AND ${fields.status} = 'pending' AND EXISTS (
           SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'speech'
         )`,
      ).bind(item.segment.id, courseware.id, courseware.id, leaseToken).run();
      if (claimed.meta.changes !== 1) continue;
      const model = item.segment.speaker === 'student' ? studentModel : teacherModel;
      if (!model) return failCourseware(
        env, courseware, leaseToken, new ProviderCallError('missing_credential', 401),
      );
      const text = item.variant === 'alternate' ? item.segment.alternate_speech_text : item.segment.speech_text;
      try {
        const result = await dependencies.synthesizeSpeech(model, {
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          modelId: model.modelId,
          voiceId: model.voiceId,
          text,
          format: 'mp3',
          sampleRate: 24000,
          allowedMediaHostSuffixes: stringArray(model.endpointConfig.mediaHostSuffixes),
          timeoutMs: timeoutMs(model),
        });
        if (!await renewLease(env, courseware.id, leaseToken, dependencies.now())) return 'ignored';
        if (result.contentType !== 'audio/mpeg') throw new ProviderCallError('invalid_model_output', 502);
        const durationMs = readMp3DurationMs(result.bytes);
        const logicalKey = buildCoursewareMediaKey(
          courseware.owner_user_id,
          courseware.student_id,
          courseware.id,
          item.segment.id,
          item.variant,
          'mp3',
        );
        let committed: boolean;
        try {
          committed = await persistCoursewareArtifact(env, {
            coursewareId: courseware.id,
            segmentId: item.segment.id,
            variant: item.variant,
            objectKey: logicalKey,
            attemptToken: leaseToken,
            contentType: result.contentType,
            bytes: result.bytes,
            durationMs,
            requestId: safeRequestId(result.requestId, model.apiKey),
          }, { status: courseware.status, stage: 'speech', leaseToken });
        } catch {
          throw new ProviderCallError('storage_failed', 503);
        }
        if (!committed) return 'ignored';
        const retainedKey = item.segment[fields.object as keyof CoursewareSegmentRow];
        const newKey = buildCoursewareMediaAttemptKey(logicalKey, leaseToken);
        if (typeof retainedKey === 'string' && retainedKey.length > 0 && retainedKey !== newKey) {
          try {
            await cleanupCoursewareAttemptObject(env, retainedKey);
          } catch {
            // The exact retained key is tombstoned; the newly committed artifact remains authoritative.
          }
        }
        await recordHealth(dependencies, env, courseware, model);
      } catch (error) {
        const normalized = normalizedError(error);
        const transient = TRANSIENT_CODES.has(normalized.errorCode);
        const failed = await env.DB.prepare(
          `UPDATE courseware_segments SET ${fields.retry} = ${fields.retry} + 1,
             ${fields.status} = CASE WHEN ? = 1 AND ${fields.retry} + 1 < ? THEN 'pending' ELSE 'failed' END,
             ${fields.errorCode} = ?, ${fields.errorMessage} = ?, updated_at = datetime('now')
           WHERE id = ? AND ${fields.status} = 'generating' AND EXISTS (
             SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'speech'
           ) RETURNING ${fields.retry} AS retry_count, ${fields.status} AS artifact_status`,
        ).bind(transient ? 1 : 0, MAX_ITEM_ATTEMPTS, normalized.errorCode, normalized.message,
          item.segment.id, courseware.id, leaseToken)
          .first<{ retry_count: number; artifact_status: string }>();
        if (!failed) return 'ignored';
        if (!transient || failed.artifact_status === 'failed') {
          const outcome = await failCourseware(env, courseware, leaseToken, normalized);
          await recordHealth(dependencies, env, courseware, model, normalized);
          return outcome;
        }
        await recordHealth(dependencies, env, courseware, model, normalized);
      }
      await updateProgress(env, courseware.id, leaseToken);
    }
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM courseware_segments WHERE courseware_id = ? AND
       (audio_status IN ('pending', 'generating') OR alternate_audio_status IN ('pending', 'generating'))`,
    ).bind(courseware.id).first<{ count: number }>();
    if ((pending?.count ?? 0) > 0) return 'reenqueue';
    const failed = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM courseware_segments WHERE courseware_id = ? AND
       (audio_status = 'failed' OR alternate_audio_status = 'failed')`,
    ).bind(courseware.id).first<{ count: number }>();
    if ((failed?.count ?? 0) > 0) return failCourseware(
      env, courseware, leaseToken, new ProviderCallError('provider_unavailable', 503),
    );
    return await setStage(env, courseware, leaseToken, 'speech', 'images') ? 'reenqueue' : 'ignored';
  } catch (error) {
    return failCourseware(env, courseware, leaseToken, normalizedError(error));
  }
}

function imageExtension(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/webp') return 'webp';
  throw new ProviderCallError('invalid_model_output', 502);
}

async function advanceImages(
  env: Env,
  courseware: CoursewareDetailRow,
  leaseToken: string,
  dependencies: CoursewareGenerationDependencies,
): Promise<'done' | 'reenqueue' | 'ignored'> {
  await env.DB.prepare(
    `UPDATE courseware_segments SET image_status = 'pending'
     WHERE courseware_id = ? AND image_status = 'generating' AND EXISTS (
       SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'images'
     )`,
  ).bind(courseware.id, courseware.id, leaseToken).run();
  const refreshed = await createCoursewareRepository(env.DB).getForWorker(courseware.id);
  if (!refreshed) return 'ignored';
  for (const item of refreshed.segments) {
    if (!['ready', 'pending'].includes(item.image_status) || !item.image_object_key) continue;
    const inspection = await inspectStoredArtifact(
      env, courseware, leaseToken, 'images', item.id, 'image', item.image_status, item.image_object_key,
    );
    if (inspection === 'retry') return 'reenqueue';
    if (inspection === 'lost') return 'ignored';
    if (inspection === 'missing' && item.image_status === 'ready') {
      await env.DB.prepare(
        `UPDATE courseware_segments SET image_status = 'pending', image_retry_count = 0,
           image_error_code = '', image_error_message = ''
         WHERE id = ? AND image_status = 'ready' AND EXISTS (
           SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'images'
         )`,
      ).bind(item.id, courseware.id, leaseToken).run();
    }
  }
  const latest = await createCoursewareRepository(env.DB).getForWorker(courseware.id);
  if (!latest) return 'ignored';
  const work = latest.segments.filter((item) => item.image_status === 'pending')
    .sort((left, right) => left.position - right.position).slice(0, MAX_ARTIFACTS_PER_ADVANCE);
  if (work.length === 0) {
    return await setStage(env, courseware, leaseToken, 'images', 'finalizing', 95) ? 'reenqueue' : 'ignored';
  }
  let imageModel: ResolvedModelCall | null;
  try {
    imageModel = await resolveImageModelForJob(env, courseware);
  } catch (error) {
    const normalized = normalizedError(error);
    await env.DB.prepare(
      `UPDATE courseware_segments SET image_status = 'failed', image_error_code = ?, image_error_message = ?
       WHERE courseware_id = ? AND image_status IN ('pending', 'generating') AND EXISTS (
         SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'images'
       )`,
    ).bind(normalized.errorCode, normalized.message, courseware.id, courseware.id, leaseToken).run();
    return await setStage(env, courseware, leaseToken, 'images', 'finalizing', 95) ? 'reenqueue' : 'ignored';
  }
  if (!imageModel) {
    await env.DB.prepare(
      `UPDATE courseware_segments SET image_status = 'failed', image_error_code = 'model_unavailable',
         image_error_message = '所选模型不可用', updated_at = datetime('now')
       WHERE courseware_id = ? AND image_status IN ('pending', 'generating') AND EXISTS (
         SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'images'
       )`,
    ).bind(courseware.id, courseware.id, leaseToken).run();
    return await setStage(env, courseware, leaseToken, 'images', 'finalizing', 95) ? 'reenqueue' : 'ignored';
  }
  for (const item of work) {
    if (!await renewLease(env, courseware.id, leaseToken, dependencies.now())) return 'ignored';
    const claimed = await env.DB.prepare(
      `UPDATE courseware_segments SET image_status = 'generating', updated_at = datetime('now')
       WHERE id = ? AND image_status = 'pending' AND EXISTS (
         SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'images'
       )`,
    ).bind(item.id, courseware.id, leaseToken).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      const result = await dependencies.generateImage(imageModel, {
        baseUrl: imageModel.baseUrl,
        apiKey: imageModel.apiKey,
        modelId: imageModel.modelId,
        prompt: item.visual_prompt,
        size: imageSize(imageModel),
        allowedMediaHostSuffixes: stringArray(imageModel.endpointConfig.mediaHostSuffixes),
        timeoutMs: timeoutMs(imageModel),
      });
      if (!await renewLease(env, courseware.id, leaseToken, dependencies.now())) return 'ignored';
      const logicalKey = buildCoursewareMediaKey(
        courseware.owner_user_id, courseware.student_id, courseware.id, item.id, 'image', imageExtension(result.contentType),
      );
      let committed: boolean;
      try {
        committed = await persistCoursewareArtifact(env, {
          coursewareId: courseware.id,
          segmentId: item.id,
          variant: 'image',
          objectKey: logicalKey,
          attemptToken: leaseToken,
          contentType: result.contentType,
          bytes: result.bytes,
          requestId: safeRequestId(result.requestId, imageModel.apiKey),
        }, { status: courseware.status, stage: 'images', leaseToken });
      } catch {
        throw new ProviderCallError('storage_failed', 503);
      }
      if (!committed) return 'ignored';
      const newKey = buildCoursewareMediaAttemptKey(logicalKey, leaseToken);
      if (item.image_object_key && item.image_object_key !== newKey) {
        try {
          await cleanupCoursewareAttemptObject(env, item.image_object_key);
        } catch {
          // Exact cleanup tombstone was persisted; the new committed artifact remains authoritative.
        }
      }
      await recordHealth(dependencies, env, courseware, imageModel);
    } catch (error) {
      const normalized = normalizedError(error);
      const transient = TRANSIENT_CODES.has(normalized.errorCode);
      const updated = await env.DB.prepare(
        `UPDATE courseware_segments SET image_retry_count = image_retry_count + 1,
           image_status = CASE WHEN ? = 1 AND image_retry_count + 1 < ? THEN 'pending' ELSE 'failed' END,
           image_error_code = ?, image_error_message = ?, updated_at = datetime('now')
         WHERE id = ? AND image_status = 'generating' AND EXISTS (
           SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'images'
         )`,
      ).bind(transient ? 1 : 0, MAX_ITEM_ATTEMPTS, normalized.errorCode, normalized.message,
        item.id, courseware.id, leaseToken).run();
      if (updated.meta.changes !== 1) return 'ignored';
      await recordHealth(dependencies, env, courseware, imageModel, normalized);
    }
    await updateProgress(env, courseware.id, leaseToken);
  }
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM courseware_segments
     WHERE courseware_id = ? AND image_status IN ('pending', 'generating')`,
  ).bind(courseware.id).first<{ count: number }>();
  if ((pending?.count ?? 0) > 0) return 'reenqueue';
  return await setStage(env, courseware, leaseToken, 'images', 'finalizing', 95) ? 'reenqueue' : 'ignored';
}

async function advanceFinalizing(
  env: Env,
  courseware: CoursewareDetailRow,
  leaseToken: string,
): Promise<'done' | 'reenqueue' | 'ignored'> {
  const refreshed = await createCoursewareRepository(env.DB).getForWorker(courseware.id);
  if (!refreshed) return 'ignored';
  if (refreshed.segments.some((item) => item.image_status === 'pending' || item.image_status === 'generating')) {
    await setStage(env, courseware, leaseToken, 'finalizing', 'images');
    return 'reenqueue';
  }
  for (const item of refreshed.segments) {
    for (const [status, objectKey] of [
      [item.audio_status, item.audio_object_key],
      [item.alternate_audio_status, item.alternate_audio_object_key],
    ] as const) {
      if (status === 'not_required') continue;
      if (status !== 'ready' || !objectKey) {
        await setStage(env, courseware, leaseToken, 'finalizing', 'speech');
        return 'reenqueue';
      }
      const variant = objectKey === item.audio_object_key ? 'main' : 'alternate';
      const inspection = await inspectStoredArtifact(
        env, courseware, leaseToken, 'finalizing', item.id, variant, 'ready', objectKey,
      );
      if (inspection === 'retry') return 'reenqueue';
      if (inspection === 'failed') {
        return failCourseware(env, courseware, leaseToken, new ProviderCallError('storage_failed', 503));
      }
      if (inspection === 'lost') return 'ignored';
      if (inspection === 'missing') {
        const fields = audioFields(variant);
        await env.DB.prepare(
          `UPDATE courseware_segments SET ${fields.status} = 'pending', ${fields.object} = '',
             ${fields.retry} = 0, ${fields.errorCode} = '', ${fields.errorMessage} = ''
           WHERE id = ? AND ${fields.status} = 'ready' AND EXISTS (
             SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'finalizing'
           )`,
        ).bind(item.id, courseware.id, leaseToken).run();
        await setStage(env, courseware, leaseToken, 'finalizing', 'speech');
        return 'reenqueue';
      }
    }
    if (item.image_status === 'ready' && item.image_object_key) {
      const inspection = await inspectStoredArtifact(
        env, courseware, leaseToken, 'finalizing', item.id, 'image', 'ready', item.image_object_key,
      );
      if (inspection === 'retry') return 'reenqueue';
      if (inspection === 'lost') return 'ignored';
      if (inspection === 'missing') {
        await env.DB.prepare(
          `UPDATE courseware_segments SET image_status = 'pending', image_retry_count = 0,
             image_error_code = '', image_error_message = ''
           WHERE id = ? AND image_status = 'ready' AND EXISTS (
             SELECT 1 FROM coursewares c WHERE c.id = ? AND c.lease_token = ? AND c.generation_stage = 'finalizing'
           )`,
        ).bind(item.id, courseware.id, leaseToken).run();
        await setStage(env, courseware, leaseToken, 'finalizing', 'images');
        return 'reenqueue';
      }
    }
  }
  const finalState = await createCoursewareRepository(env.DB).getForWorker(courseware.id);
  if (!finalState) return 'ignored';
  const failedImages = finalState.segments.filter((item) => item.image_status === 'failed').length;
  const usage = {
    textInputTokens: 0,
    textOutputTokens: 0,
    speechArtifacts: finalState.segments.reduce((count, item) => count + (item.audio_status === 'ready' ? 1 : 0) + (item.alternate_audio_status === 'ready' ? 1 : 0), 0),
    imageArtifacts: finalState.segments.filter((item) => item.image_status === 'ready').length,
  };
  try {
    const current = JSON.parse(courseware.usage_json) as Record<string, unknown>;
    usage.textInputTokens = typeof current.textInputTokens === 'number' ? current.textInputTokens : 0;
    usage.textOutputTokens = typeof current.textOutputTokens === 'number' ? current.textOutputTokens : 0;
  } catch { /* keep safe zero defaults */ }
  const result = await env.DB.prepare(
    `UPDATE coursewares SET status = 'ready', generation_stage = 'ready', progress_percent = 100,
       warnings_json = ?, usage_json = ?, error_code = '', error_message = '', retryable = 0,
       completed_at = COALESCE(completed_at, datetime('now')), lease_token = NULL, lease_expires_at = NULL,
       updated_at = datetime('now')
     WHERE id = ? AND status = ? AND generation_stage = 'finalizing' AND lease_token = ?`,
  ).bind(JSON.stringify(failedImages > 0 ? [IMAGE_WARNING] : []), JSON.stringify(usage),
    courseware.id, courseware.status, leaseToken).run();
  return result.meta.changes === 1 ? 'done' : 'ignored';
}

export async function advanceCourseware(
  env: Env,
  coursewareId: number,
  dependencies: CoursewareGenerationDependencies = defaultDependencies,
): Promise<'done' | 'reenqueue' | 'ignored'> {
  if (!Number.isSafeInteger(coursewareId) || coursewareId < 1) return 'ignored';
  const repository = createCoursewareRepository(env.DB);
  const initial = await repository.getForWorker(coursewareId);
  if (!initial || initial.status === 'deleting' || initial.status === 'failed' ||
      (initial.status === 'ready' && initial.generation_stage === 'ready')) return 'ignored';
  if (!['queued', 'generating', 'ready'].includes(initial.status) ||
      !['queued', 'scripting', 'speech', 'images', 'finalizing'].includes(initial.generation_stage)) return 'ignored';
  const leaseToken = `generation:${crypto.randomUUID()}`;
  if (!await claimLease(env, initial, leaseToken, dependencies.now())) return 'ignored';
  try {
    const courseware = await repository.getForWorker(coursewareId);
    if (!courseware || courseware.lease_token !== leaseToken) return 'ignored';
    if (courseware.generation_stage === 'scripting') {
      return await advanceScripting(env, courseware, leaseToken, dependencies);
    }
    if (courseware.generation_stage === 'speech') {
      return await advanceSpeech(env, courseware, leaseToken, dependencies);
    }
    if (courseware.generation_stage === 'images') {
      return await advanceImages(env, courseware, leaseToken, dependencies);
    }
    if (courseware.generation_stage === 'finalizing') {
      return await advanceFinalizing(env, courseware, leaseToken);
    }
    return 'ignored';
  } finally {
    await releaseLease(env, coursewareId, leaseToken);
  }
}
