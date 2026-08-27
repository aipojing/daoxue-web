import type { CoursewareSummary } from '../../shared/courseware';
import type { CoursewareModelPurpose } from '../../shared/ai-catalog';
import { resolveCredential } from '../ai-catalog/credentials';
import {
  getUserCoursewareAISettings,
  resolvePreference,
  type ResolvedModelSelection,
} from '../ai-catalog/repository';
import type { Env } from '../env';
import { UserFacingError } from '../lib/errors';
import {
  createCoursewareRepository,
  type CoursewareStateGuard,
  type SavedArtifact,
} from './repository';
import { buildCoursewareMediaAttemptKey, putCoursewareMedia } from './media';

export interface CreateCoursewareInput {
  studentId: number;
  subject: string;
  topic: string;
  learningGoal: string;
  sourceConversationId?: number;
  sourceText?: string;
  includeImages: boolean;
}

export interface PersistCoursewareArtifactInput extends SavedArtifact {
  attemptToken: string;
  bytes: ArrayBuffer;
}

async function cleanupAttemptObject(env: Env, objectKey: string): Promise<void> {
  const repository = createCoursewareRepository(env.DB);
  try {
    await env.COURSEWARE_MEDIA.delete(objectKey);
    await repository.removeMediaTombstone(objectKey);
  } catch (error) {
    await repository.recordMediaTombstone(objectKey);
    throw error;
  }
}

export async function cleanupCoursewareMediaTombstone(env: Env, objectKey: string): Promise<boolean> {
  const tombstone = await env.DB.prepare(
    'SELECT object_key FROM courseware_media_tombstones WHERE object_key = ?',
  ).bind(objectKey).first<{ object_key: string }>();
  if (!tombstone) return false;
  await cleanupAttemptObject(env, tombstone.object_key);
  return true;
}

/**
 * Task 9 writes bytes before its D1 artifact CAS. If ownership of the state lease was
 * lost (most importantly to deleting), remove exactly the just-written private object.
 */
export async function persistCoursewareArtifact(
  env: Env,
  input: PersistCoursewareArtifactInput,
  guard: CoursewareStateGuard,
): Promise<boolean> {
  const attemptObjectKey = buildCoursewareMediaAttemptKey(input.objectKey, input.attemptToken);
  await putCoursewareMedia(env.COURSEWARE_MEDIA, attemptObjectKey, input.bytes, input.contentType);
  try {
    const committed = await createCoursewareRepository(env.DB).saveArtifact(
      { ...input, objectKey: attemptObjectKey },
      guard,
    );
    if (committed) return true;
  } catch (error) {
    await cleanupAttemptObject(env, attemptObjectKey);
    throw error;
  }
  await cleanupAttemptObject(env, attemptObjectKey);
  return false;
}

interface OwnedStudent {
  id: number;
  grade: string;
}

function boundedText(value: unknown, maximum: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new UserFacingError(`${label}不合法`, 400);
  const normalized = allowEmpty ? value : value.trim();
  if ((!allowEmpty && normalized.length === 0) || Array.from(normalized).length > maximum) {
    throw new UserFacingError(`${label}不合法`, 400);
  }
  return normalized;
}

function validateInput(input: CreateCoursewareInput): CreateCoursewareInput {
  if (!Number.isSafeInteger(input.studentId) || input.studentId < 1 || typeof input.includeImages !== 'boolean') {
    throw new UserFacingError('课件创建参数不合法', 400);
  }
  if (input.sourceConversationId !== undefined
    && (!Number.isSafeInteger(input.sourceConversationId) || input.sourceConversationId < 1)) {
    throw new UserFacingError('来源会话不合法', 400);
  }
  return {
    studentId: input.studentId,
    subject: boundedText(input.subject, 40, '学科'),
    topic: boundedText(input.topic, 80, '主题'),
    learningGoal: boundedText(input.learningGoal, 240, '学习目标'),
    ...(input.sourceConversationId === undefined ? {} : { sourceConversationId: input.sourceConversationId }),
    ...(input.sourceText === undefined ? {} : { sourceText: boundedText(input.sourceText, 10_000, '来源文本', true) }),
    includeImages: input.includeImages,
  };
}

function readinessError(
  label: string,
  readiness: 'ready' | 'unconfigured' | 'invalid_credential' | 'quota_exhausted' | 'disabled',
): UserFacingError {
  if (readiness === 'invalid_credential') return new UserFacingError(`${label} Key 已失效，请替换并测试后重试`, 400);
  if (readiness === 'quota_exhausted') return new UserFacingError(`${label} Key 额度已用尽，请更换并测试后重试`, 400);
  return new UserFacingError(`${label}尚未完整配置`, 400);
}

async function requiredSelection(
  env: Env,
  userId: number,
  purpose: CoursewareModelPurpose,
  label: string,
): Promise<ResolvedModelSelection> {
  const selection = await resolvePreference(env.DB, userId, purpose);
  if (!selection) throw new UserFacingError(`${label}尚未完整配置`, 400);
  const credential = await resolveCredential(env.DB, env, userId, selection.providerId);
  if (!credential) throw new UserFacingError(`${label}尚未配置个人 Key`, 400);
  return selection;
}

function snapshotSelection(selection: ResolvedModelSelection): Record<string, unknown> {
  return {
    providerId: selection.providerId,
    providerSlug: selection.providerSlug,
    endpointId: selection.endpointId,
    adapterType: selection.adapterType,
    adapterVersion: 'v1',
    baseUrl: selection.baseUrl,
    capability: selection.capability,
    modelId: selection.modelId,
    voiceId: selection.voiceId,
    endpointConfig: selection.endpointConfig,
    modelConfig: selection.modelConfig,
    params: selection.params,
  };
}

export async function createCourseware(
  env: Env,
  userId: number,
  rawInput: CreateCoursewareInput,
): Promise<CoursewareSummary> {
  const input = validateInput(rawInput);
  const feature = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'courseware_enabled'",
  ).first<{ value: string }>();
  if (feature?.value !== '1') throw new UserFacingError('互动课件功能暂未开放', 403);

  const student = await env.DB.prepare(
    'SELECT id, grade FROM students WHERE id = ? AND user_id = ?',
  ).bind(input.studentId, userId).first<OwnedStudent>();
  if (!student) throw new UserFacingError('学生不存在', 404);

  if (input.sourceConversationId !== undefined) {
    const conversation = await env.DB.prepare(
      `SELECT cv.id FROM conversations cv
       JOIN students s ON s.id = cv.student_id
       WHERE cv.id = ? AND cv.student_id = ? AND s.user_id = ?
         AND cv.subject = 'selflearn' AND cv.mode = 'selflearn-daily'`,
    ).bind(input.sourceConversationId, student.id, userId).first<{ id: number }>();
    if (!conversation) throw new UserFacingError('来源自学会话不存在', 404);
  }

  const settings = await getUserCoursewareAISettings(env.DB, env, userId);
  if (settings.readiness.text !== 'ready') throw readinessError('课件文本模型', settings.readiness.text);
  if (settings.readiness.teacherSpeech !== 'ready') throw readinessError('老师语音模型', settings.readiness.teacherSpeech);
  if (settings.readiness.studentSpeech !== 'ready') throw readinessError('AI 同学语音模型', settings.readiness.studentSpeech);
  if (input.includeImages && settings.readiness.image !== 'ready') {
    throw readinessError('课件图片模型', settings.readiness.image);
  }

  const [text, teacherSpeech, studentSpeech, image] = await Promise.all([
    requiredSelection(env, userId, 'courseware_text', '课件文本模型'),
    requiredSelection(env, userId, 'teacher_tts', '老师语音模型'),
    requiredSelection(env, userId, 'student_tts', 'AI 同学语音模型'),
    input.includeImages
      ? requiredSelection(env, userId, 'courseware_image', '课件图片模型')
      : Promise.resolve(null),
  ]);
  const snapshot = {
    schemaVersion: 1,
    promptVersion: 'courseware-v1',
    includeImages: input.includeImages,
    text: snapshotSelection(text),
    teacherSpeech: snapshotSelection(teacherSpeech),
    studentSpeech: snapshotSelection(studentSpeech),
    image: image ? snapshotSelection(image) : null,
  };
  const repository = createCoursewareRepository(env.DB);
  const enqueueToken = `create:${crypto.randomUUID()}`;
  const created = await repository.create({
    userId,
    enqueueToken,
    studentId: student.id,
    sourceConversationId: input.sourceConversationId ?? null,
    subject: input.subject,
    grade: student.grade,
    topic: input.topic,
    learningGoal: input.learningGoal,
    sourceText: input.sourceText ?? '',
    title: input.topic,
    modelSnapshot: snapshot,
  });
  if (!created) throw new UserFacingError('学生正在删除或不存在', 409);
  try {
    await env.COURSEWARE_QUEUE.send({ coursewareId: created.id });
  } catch {
    await repository.rollbackCreateEnqueue(created.id, enqueueToken);
    throw new UserFacingError('课件生成服务暂时不可用，请稍后重试', 503);
  }
  await repository.finishEnqueue(created.id, enqueueToken);
  return created;
}
