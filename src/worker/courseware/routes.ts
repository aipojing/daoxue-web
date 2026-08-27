import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type {
  CoursewareCheckpoint,
  CoursewareDetail,
  CoursewareProgressPatch,
  CoursewareScriptSegment,
  CoursewareSummary,
} from '../../shared/courseware';
import { resolveCredential } from '../ai-catalog/credentials';
import type { AppContext } from '../env';
import { ok, err } from '../lib/envelope';
import { UserFacingError } from '../lib/errors';
import { getOwnedStudent } from '../students/routes';
import { createCourseware, drainCoursewareMediaTombstones } from './service';
import {
  createCoursewareRepository,
  type CoursewareDetailRow,
  type CoursewareSegmentRow,
} from './repository';
import {
  deleteCoursewareMedia,
  getCoursewareMediaResponse,
  isCoursewareMediaKeyForLogicalKey,
} from './media';
import { getOrCreateCoursewareAssessment } from './assessment';

const createSchema = z.object({
  subject: z.string().trim().min(1).max(40),
  topic: z.string().trim().min(1).max(80),
  learningGoal: z.string().trim().min(1).max(240),
  sourceConversationId: z.number().int().positive().optional(),
  sourceText: z.string().max(10_000).optional(),
  includeImages: z.boolean(),
}).strict();

const checkpointAnswersSchema = z.record(
  z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  z.union([z.number().int().min(0).max(3), z.literal('skipped')]),
).refine((answers) => Object.keys(answers).length <= 30, '检查点答案过多');

const progressPatchSchema = z.object({
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  currentSegmentPosition: z.number().int().min(0).max(29).optional(),
  currentTimeMs: z.number().int().min(0).max(86_400_000).optional(),
  checkpointAnswers: checkpointAnswersSchema.optional(),
}).strict().refine(
  (value) => value.currentSegmentPosition !== undefined
    || value.currentTimeMs !== undefined
    || value.checkpointAnswers !== undefined,
  '至少提供一个进度字段',
);

function parseId(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isoTimestamp(value: string): string {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString();
}

function withIsoDates(summary: CoursewareSummary): CoursewareSummary {
  return { ...summary, createdAt: isoTimestamp(summary.createdAt), updatedAt: isoTimestamp(summary.updatedAt) };
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseStrings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function requiredAudioCounts(segments: CoursewareSegmentRow[]): { ready: number; total: number } {
  return segments.reduce((counts, segment) => ({
    ready: counts.ready + (segment.audio_status === 'ready' ? 1 : 0) + (segment.alternate_audio_status === 'ready' ? 1 : 0),
    total: counts.total + 1 + (segment.alternate_audio_status === 'not_required' ? 0 : 1),
  }), { ready: 0, total: 0 });
}

function parseCheckpoint(value: string): CoursewareCheckpoint | undefined {
  const parsed = parseObject(value);
  return typeof parsed.prompt === 'string' && typeof parsed.correctAnswer === 'string'
    && typeof parsed.explanation === 'string'
    ? parsed as unknown as CoursewareCheckpoint
    : undefined;
}

function mapSegment(coursewareId: number, segment: CoursewareSegmentRow): CoursewareDetail['segments'][number] {
  const base = `/api/coursewares/${coursewareId}/segments/${segment.id}`;
  const mapped: CoursewareScriptSegment & {
    id: number;
    audioUrl: string;
    alternateAudioUrl: string | null;
    imageUrl: string | null;
    audioDurationMs: number;
    alternateAudioDurationMs: number;
  } = {
    id: segment.id,
    segmentKey: segment.segment_key,
    kind: segment.kind as CoursewareScriptSegment['kind'],
    speaker: segment.speaker as CoursewareScriptSegment['speaker'],
    title: segment.title,
    displayMarkdown: segment.display_markdown,
    speechText: segment.speech_text,
    visual: {
      mode: segment.visual_mode,
      ...(segment.visual_prompt ? { prompt: segment.visual_prompt } : {}),
      ...(segment.visual_alt_text ? { altText: segment.visual_alt_text } : {}),
    },
    audioUrl: segment.audio_status === 'ready' && segment.audio_object_key ? `${base}/audio` : '',
    alternateAudioUrl: segment.alternate_audio_status === 'ready' && segment.alternate_audio_object_key
      ? `${base}/alternate-audio` : null,
    imageUrl: segment.image_status === 'ready' && segment.image_object_key ? `${base}/image` : null,
    audioDurationMs: segment.audio_duration_ms,
    alternateAudioDurationMs: segment.alternate_audio_duration_ms,
  };
  if (segment.alternate_display_markdown && segment.alternate_speech_text) {
    mapped.alternateExplanation = {
      displayMarkdown: segment.alternate_display_markdown,
      speechText: segment.alternate_speech_text,
    };
  }
  const checkpoint = parseCheckpoint(segment.checkpoint_json);
  if (checkpoint) mapped.checkpoint = checkpoint;
  return mapped;
}

async function canRetryImages(db: D1Database, userId: number, detail: CoursewareDetailRow): Promise<boolean> {
  const eligible = await db.prepare(
    `SELECT 1 AS eligible FROM coursewares c
     WHERE c.id = ? AND c.status = 'ready' AND (
       (c.generation_stage = 'ready' AND EXISTS (
         SELECT 1 FROM courseware_segments cs
         WHERE cs.courseware_id = c.id AND cs.image_status = 'failed'
       ))
       OR (c.generation_stage = 'images' AND c.enqueue_kind = 'image_retry'
           AND c.enqueue_expires_at <= datetime('now') AND EXISTS (
         SELECT 1 FROM courseware_segments cs
         WHERE cs.courseware_id = c.id AND cs.image_status = 'pending'
           AND cs.image_request_id = c.enqueue_token
       ))
     )`,
  ).bind(detail.id).first<{ eligible: number }>();
  if (!eligible) return false;
  const image = parseObject(detail.model_snapshot_json).image;
  if (!image || typeof image !== 'object' || Array.isArray(image)) return false;
  const snapshot = image as Record<string, unknown>;
  if (!Number.isInteger(snapshot.providerId) || !Number.isInteger(snapshot.endpointId)) return false;
  const row = await db.prepare(
    `SELECT 1 AS usable
     FROM ai_providers p
     JOIN ai_provider_endpoints e ON e.provider_id = p.id
     JOIN user_ai_credentials credential ON credential.provider_id = p.id AND credential.user_id = ?
     WHERE p.id = ? AND e.id = ?
       AND e.capability = 'image_generation'
       AND credential.key_ciphertext IS NOT NULL
       AND credential.key_iv IS NOT NULL
       AND credential.health_status NOT IN ('invalid', 'quota_exhausted')`,
  ).bind(userId, snapshot.providerId, snapshot.endpointId).first<{ usable: number }>();
  return Boolean(row);
}

async function mapDetail(db: D1Database, userId: number, row: CoursewareDetailRow): Promise<CoursewareDetail> {
  const audioCounts = requiredAudioCounts(row.segments);
  const summary: CoursewareSummary = withIsoDates({
    id: row.id,
    studentId: row.student_id,
    title: row.title,
    subject: row.subject,
    topic: row.topic,
    status: row.status,
    generationStage: row.generation_stage,
    progressPercent: row.progress_percent,
    requiredAudioReadyCount: audioCounts.ready,
    requiredAudioTotalCount: audioCounts.total,
    retryable: row.retryable === 1,
    imageRetryAvailable: await canRetryImages(db, userId, row),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    warnings: parseStrings(row.warnings_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const checkpointAnswers = parseObject(row.checkpoint_answers_json) as CoursewareDetail['checkpointAnswers'];
  return {
    ...summary,
    grade: row.grade,
    learningObjectives: parseStrings(row.learning_objectives_json),
    estimatedMinutes: row.estimated_minutes,
    currentSegmentPosition: row.current_segment_position,
    currentTimeMs: row.current_time_ms,
    progressRevision: row.progress_revision,
    checkpointAnswers,
    assessmentConversationId: row.assessment_conversation_id,
    segments: row.status === 'ready' ? row.segments.map((segment) => mapSegment(row.id, segment)) : [],
  };
}

async function ownedDetail(c: Context<AppContext>): Promise<CoursewareDetailRow | null> {
  const coursewareId = parseId(c.req.param('coursewareId'));
  if (!coursewareId) return null;
  const repository = createCoursewareRepository(c.env.DB);
  await repository.recoverOwnedExpiredEnqueues(c.get('user').id, coursewareId);
  return repository.getOwned(c.get('user').id, coursewareId);
}

export const coursewareStudentRoutes = new Hono<AppContext>();

coursewareStudentRoutes.use('*', async (c, next) => {
  c.executionCtx.waitUntil(drainCoursewareMediaTombstones(c.env).then(() => undefined).catch(() => undefined));
  await next();
});

coursewareStudentRoutes.post('/:studentId/coursewares', async (c) => {
  const studentId = parseId(c.req.param('studentId'));
  if (!studentId) return err(c, '学生不存在', 404);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '输入不合法', 400);
  const created = await createCourseware(c.env, c.get('user').id, { studentId, ...parsed.data });
  return ok(c, withIsoDates(created), 201);
});

coursewareStudentRoutes.get('/:studentId/coursewares', async (c) => {
  const user = c.get('user');
  const studentId = parseId(c.req.param('studentId'));
  if (!studentId || !await getOwnedStudent(c.env.DB, user.id, studentId)) return err(c, '学生不存在', 404);
  const rawLimit = c.req.query('limit');
  const requestedLimit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return err(c, '分页参数不合法', 400);
  const repository = createCoursewareRepository(c.env.DB);
  await repository.recoverOwnedExpiredEnqueues(user.id);
  const page = await repository.listOwned(
    user.id, studentId, c.req.query('cursor') ?? '', requestedLimit,
  );
  const items = await Promise.all(page.items.map(async (summary) => {
    let imageRetryAvailable = false;
    if (summary.imageRetryAvailable) {
      const detail = await repository.getOwned(user.id, summary.id);
      imageRetryAvailable = detail ? await canRetryImages(c.env.DB, user.id, detail) : false;
    }
    return withIsoDates({ ...summary, imageRetryAvailable });
  }));
  return ok(c, { ...page, items });
});

export const coursewareRoutes = new Hono<AppContext>();

coursewareRoutes.use('*', async (c, next) => {
  c.executionCtx.waitUntil(drainCoursewareMediaTombstones(c.env).then(() => undefined).catch(() => undefined));
  await next();
});

coursewareRoutes.get('/:coursewareId', async (c) => {
  const detail = await ownedDetail(c);
  if (!detail) return err(c, '无权访问该课件', 403);
  return ok(c, await mapDetail(c.env.DB, c.get('user').id, detail));
});

coursewareRoutes.get('/:coursewareId/progress', async (c) => {
  const detail = await ownedDetail(c);
  if (!detail) return err(c, '无权访问该课件', 403);
  return ok(c, {
    currentSegmentPosition: detail.current_segment_position,
    currentTimeMs: detail.current_time_ms,
    revision: detail.progress_revision,
    checkpointAnswers: parseObject(detail.checkpoint_answers_json),
    updatedAt: isoTimestamp(detail.updated_at),
  });
});

coursewareRoutes.post('/:coursewareId/assessment', async (c) => {
  const coursewareId = parseId(c.req.param('coursewareId'));
  if (!coursewareId) return err(c, '无权访问该课件', 403);
  return ok(c, await getOrCreateCoursewareAssessment(c.env, c.get('user').id, coursewareId));
});

coursewareRoutes.patch('/:coursewareId/progress', async (c) => {
  const detail = await ownedDetail(c);
  if (!detail) return err(c, '无权访问该课件', 403);
  const parsed = progressPatchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, parsed.error.issues[0]?.message ?? '播放进度不合法', 400);
  const maximumPosition = Math.max(0, detail.segments.length - 1);
  if (parsed.data.currentSegmentPosition !== undefined && parsed.data.currentSegmentPosition > maximumPosition) {
    return err(c, '播放位置超出课件范围', 400);
  }
  const checkpoints = new Map(detail.segments
    .filter((segment) => segment.kind === 'checkpoint')
    .map((segment) => [segment.segment_key, parseCheckpoint(segment.checkpoint_json)]));
  if (parsed.data.checkpointAnswers) {
    for (const [key, answer] of Object.entries(parsed.data.checkpointAnswers)) {
      const checkpoint = checkpoints.get(key);
      if (!checkpoint || (answer !== 'skipped' && (!checkpoint.options || answer >= checkpoint.options.length))) {
        return err(c, '检查点答案不合法', 400);
      }
    }
  }
  const merged: CoursewareProgressPatch = {
    revision: parsed.data.revision,
    currentSegmentPosition: parsed.data.currentSegmentPosition ?? detail.current_segment_position,
    currentTimeMs: parsed.data.currentTimeMs ?? detail.current_time_ms,
    checkpointAnswers: {
      ...(parseObject(detail.checkpoint_answers_json) as CoursewareProgressPatch['checkpointAnswers']),
      ...(parsed.data.checkpointAnswers ?? {}),
    },
  };
  if (Object.keys(merged.checkpointAnswers).length > 30) return err(c, '检查点答案过多', 400);
  if (!await createCoursewareRepository(c.env.DB).saveProgress(c.get('user').id, detail.id, merged)) {
    return err(c, '课件状态已变化，请刷新后重试', 409);
  }
  return ok(c, merged);
});

coursewareRoutes.post('/:coursewareId/retry', async (c) => {
  const detail = await ownedDetail(c);
  if (!detail) return err(c, '无权访问该课件', 403);
  const repository = createCoursewareRepository(c.env.DB);
  const claim = await repository.claimRetryableFailure(
    c.get('user').id, detail.id, `full-retry:${crypto.randomUUID()}`,
  );
  if (!claim) return err(c, '当前课件不可重试', 409);
  try {
    await c.env.COURSEWARE_QUEUE.send({ coursewareId: detail.id });
  } catch {
    await repository.rollbackRetryClaim(
      claim, 'queue_unavailable', '课件生成队列暂时不可用，请稍后重试',
    );
    throw new UserFacingError('课件生成服务暂时不可用，请稍后重试', 503);
  }
  await repository.finishRetryClaim(claim);
  return ok(c, { queued: true });
});

coursewareRoutes.post('/:coursewareId/images/retry', async (c) => {
  const detail = await ownedDetail(c);
  if (!detail) return err(c, '无权访问该课件', 403);
  if (!await canRetryImages(c.env.DB, c.get('user').id, detail)) return err(c, '当前课件图片不可重试', 409);
  const image = parseObject(detail.model_snapshot_json).image as Record<string, unknown>;
  const providerId = Number(image.providerId);
  const credential = await resolveCredential(c.env.DB, c.env, c.get('user').id, providerId);
  if (!credential) return err(c, '图片模型个人 Key 不可用', 409);
  const repository = createCoursewareRepository(c.env.DB);
  const attemptToken = `image-retry:${crypto.randomUUID()}`;
  if (!await repository.claimImageRetry(c.get('user').id, detail.id, attemptToken)) {
    return err(c, '当前课件图片不可重试', 409);
  }
  try {
    await c.env.COURSEWARE_QUEUE.send({ coursewareId: detail.id });
  } catch {
    await repository.rollbackImageRetryClaim(detail.id, attemptToken);
    throw new UserFacingError('图片重试服务暂时不可用，请稍后重试', 503);
  }
  await repository.finishImageRetryClaim(detail.id, attemptToken);
  return ok(c, { queued: true });
});

coursewareRoutes.delete('/:coursewareId', async (c) => {
  const coursewareId = parseId(c.req.param('coursewareId'));
  if (!coursewareId) return err(c, '无权访问该课件', 403);
  const repository = createCoursewareRepository(c.env.DB);
  const owner = await repository.markDeleting(c.get('user').id, coursewareId);
  if (!owner) return err(c, '无权访问该课件', 403);
  try {
    await deleteCoursewareMedia(c.env.COURSEWARE_MEDIA, owner);
  } catch {
    throw new UserFacingError('课件媒体删除暂时失败，请稍后重试', 503);
  }
  if (!await repository.deleteRows(coursewareId)) {
    const remaining = await repository.getForWorker(coursewareId);
    if (remaining) throw new UserFacingError('课件删除状态已变化，请稍后重试', 503);
  }
  return ok(c, { deleted: true });
});

type MediaVariant = 'audio' | 'alternate-audio' | 'image';

coursewareRoutes.get('/:coursewareId/segments/:segmentId/:variant', async (c) => {
  const variant = c.req.param('variant') as MediaVariant;
  if (!['audio', 'alternate-audio', 'image'].includes(variant)) return err(c, '接口不存在', 404);
  const coursewareId = parseId(c.req.param('coursewareId'));
  const segmentId = parseId(c.req.param('segmentId'));
  if (!coursewareId || !segmentId) return err(c, '无权访问该课件媒体', 403);
  const row = await c.env.DB.prepare(
    `SELECT cs.*, c.student_id, s.user_id
     FROM courseware_segments cs
     JOIN coursewares c ON c.id = cs.courseware_id
     JOIN students s ON s.id = c.student_id
     WHERE cs.id = ? AND cs.courseware_id = ? AND s.user_id = ? AND c.status = 'ready'`,
  ).bind(segmentId, coursewareId, c.get('user').id).first<CoursewareSegmentRow & { student_id: number; user_id: number }>();
  if (!row) return err(c, '无权访问该课件媒体', 403);
  const status = variant === 'audio' ? row.audio_status
    : variant === 'alternate-audio' ? row.alternate_audio_status : row.image_status;
  const key = variant === 'audio' ? row.audio_object_key
    : variant === 'alternate-audio' ? row.alternate_audio_object_key : row.image_object_key;
  const expectedPrefix = `courseware/${row.user_id}/${row.student_id}/${coursewareId}/`;
  const imageExtension = row.image_content_type === 'image/png' ? 'png'
    : row.image_content_type === 'image/jpeg' ? 'jpg'
      : row.image_content_type === 'image/webp' ? 'webp' : '';
  const expectedKey = variant === 'audio' ? `${expectedPrefix}audio/${segmentId}.mp3`
    : variant === 'alternate-audio' ? `${expectedPrefix}audio/${segmentId}-alternate.mp3`
      : imageExtension ? `${expectedPrefix}images/${segmentId}.${imageExtension}` : '';
  if (status !== 'ready' || !key || !isCoursewareMediaKeyForLogicalKey(key, expectedKey)) {
    return err(c, '课件媒体尚未就绪', 404);
  }
  const response = await getCoursewareMediaResponse(c.env.COURSEWARE_MEDIA, key, c.req.raw);
  if (response.status === 404) return err(c, '课件媒体不存在', 404);
  return response;
});
