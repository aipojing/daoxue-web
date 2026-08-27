import type {
  CoursewareGenerationStage,
  CoursewareProgressPatch,
  CoursewareScript,
  CoursewareStatus,
  CoursewareSummary,
} from '../../shared/courseware';

export interface CreateCoursewareRow {
  studentId: number;
  sourceConversationId: number | null;
  subject: string;
  grade: string;
  topic: string;
  learningGoal: string;
  sourceText: string;
  title: string;
  modelSnapshot: Record<string, unknown>;
}

export interface CoursewarePage {
  items: CoursewareSummary[];
  nextCursor: string | null;
}

export interface CoursewareSegmentRow {
  id: number;
  courseware_id: number;
  position: number;
  segment_key: string;
  kind: string;
  speaker: string;
  title: string;
  display_markdown: string;
  speech_text: string;
  alternate_display_markdown: string;
  alternate_speech_text: string;
  visual_mode: 'none' | 'formula' | 'generated_image';
  visual_prompt: string;
  visual_alt_text: string;
  checkpoint_json: string;
  audio_status: string;
  alternate_audio_status: string;
  image_status: string;
  audio_object_key: string;
  audio_content_type: string;
  audio_duration_ms: number;
  alternate_audio_object_key: string;
  alternate_audio_content_type: string;
  alternate_audio_duration_ms: number;
  image_object_key: string;
  image_content_type: string;
  image_error_code: string;
}

export interface CoursewareDetailRow {
  id: number;
  student_id: number;
  owner_user_id: number;
  source_conversation_id: number | null;
  assessment_conversation_id: number | null;
  subject: string;
  grade: string;
  topic: string;
  learning_goal: string;
  source_text: string;
  title: string;
  status: CoursewareStatus;
  generation_stage: CoursewareGenerationStage;
  progress_percent: number;
  current_segment_position: number;
  current_time_ms: number;
  checkpoint_answers_json: string;
  learning_objectives_json: string;
  estimated_minutes: number;
  model_snapshot_json: string;
  warnings_json: string;
  error_code: string;
  error_message: string;
  retryable: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  segments: CoursewareSegmentRow[];
}

export interface SavedArtifact {
  coursewareId: number;
  segmentId: number;
  variant: 'main' | 'alternate' | 'image';
  objectKey: string;
  contentType: string;
  durationMs?: number;
  requestId?: string;
}

export interface CoursewareStateGuard {
  status: CoursewareStatus;
  stage: CoursewareGenerationStage;
  leaseToken: string | null;
}

export interface CoursewareRetryClaim {
  coursewareId: number;
  failedStage: CoursewareGenerationStage;
  resumeStatus: 'queued' | 'generating';
  resumeStage: 'scripting' | 'speech' | 'images' | 'finalizing';
  attemptToken: string;
}

export interface OwnedCoursewareCoordinates {
  userId: number;
  studentId: number;
  coursewareId: number;
}

export interface CoursewareRepository {
  create(input: CreateCoursewareRow): Promise<CoursewareSummary>;
  listOwned(userId: number, studentId: number, cursor: string, limit: number): Promise<CoursewarePage>;
  getOwned(userId: number, coursewareId: number): Promise<CoursewareDetailRow | null>;
  getForWorker(coursewareId: number): Promise<CoursewareDetailRow | null>;
  claimStage(coursewareId: number, expectedStage: string, nextStage: string, leaseToken: string, leaseUntil: string): Promise<boolean>;
  releaseLease(coursewareId: number, guard: CoursewareStateGuard): Promise<boolean>;
  saveScript(coursewareId: number, script: CoursewareScript, guard: CoursewareStateGuard): Promise<boolean>;
  saveArtifact(artifact: SavedArtifact, guard: CoursewareStateGuard): Promise<boolean>;
  saveProgress(userId: number, coursewareId: number, input: CoursewareProgressPatch): Promise<boolean>;
  markReady(coursewareId: number, guard: CoursewareStateGuard): Promise<boolean>;
  markFailed(coursewareId: number, code: string, safeMessage: string, retryable: boolean, guard: CoursewareStateGuard): Promise<boolean>;
  claimRetryableFailure(userId: number, coursewareId: number, attemptToken: string): Promise<CoursewareRetryClaim | null>;
  finishRetryClaim(claim: CoursewareRetryClaim): Promise<boolean>;
  rollbackRetryClaim(claim: CoursewareRetryClaim, code: string, safeMessage: string): Promise<boolean>;
  claimImageRetry(userId: number, coursewareId: number, attemptToken: string): Promise<boolean>;
  resetClaimedFailedImages(coursewareId: number, attemptToken: string): Promise<boolean>;
  finishImageRetryClaim(coursewareId: number, attemptToken: string): Promise<boolean>;
  rollbackImageRetryClaim(coursewareId: number, attemptToken: string): Promise<boolean>;
  markDeleting(userId: number, coursewareId: number): Promise<OwnedCoursewareCoordinates | null>;
  deleteRows(coursewareId: number): Promise<boolean>;
}

interface SummaryRow {
  id: number;
  student_id: number;
  title: string;
  subject: string;
  topic: string;
  status: CoursewareStatus;
  generation_stage: CoursewareGenerationStage;
  progress_percent: number;
  retryable: number;
  error_code: string;
  error_message: string;
  warnings_json: string;
  created_at: string;
  updated_at: string;
  failed_images: number;
}

function parseArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

export function mapSummaryRow(row: SummaryRow): CoursewareSummary {
  return {
    id: row.id,
    studentId: row.student_id,
    title: row.title,
    subject: row.subject,
    topic: row.topic,
    status: row.status,
    generationStage: row.generation_stage,
    progressPercent: row.progress_percent,
    retryable: row.retryable === 1,
    imageRetryAvailable: row.failed_images > 0,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    warnings: parseArray(row.warnings_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SUMMARY_COLUMNS = `c.id, c.student_id, c.title, c.subject, c.topic, c.status,
  c.generation_stage, c.progress_percent, c.retryable, c.error_code, c.error_message,
  c.warnings_json, c.created_at, c.updated_at,
  (SELECT COUNT(*) FROM courseware_segments cs
   WHERE cs.courseware_id = c.id AND cs.image_status = 'failed') AS failed_images`;

function decodeCursor(cursor: string): { updatedAt: string; id: number } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(atob(cursor)) as { updatedAt?: unknown; id?: unknown };
    if (typeof parsed.updatedAt !== 'string' || !Number.isInteger(parsed.id) || Number(parsed.id) < 1) return null;
    return { updatedAt: parsed.updatedAt, id: Number(parsed.id) };
  } catch {
    return null;
  }
}

function encodeCursor(updatedAt: string, id: number): string {
  return btoa(JSON.stringify({ updatedAt, id }));
}

async function loadSegments(db: D1Database, coursewareId: number): Promise<CoursewareSegmentRow[]> {
  const { results } = await db.prepare(
    'SELECT * FROM courseware_segments WHERE courseware_id = ? ORDER BY position, id',
  ).bind(coursewareId).all<CoursewareSegmentRow>();
  return results;
}

export function createCoursewareRepository(db: D1Database): CoursewareRepository {
  return {
    async create(input) {
      const row = await db.prepare(
        `INSERT INTO coursewares
         (student_id, source_conversation_id, subject, grade, topic, learning_goal,
          source_text, title, model_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      ).bind(
        input.studentId, input.sourceConversationId, input.subject, input.grade, input.topic,
        input.learningGoal, input.sourceText, input.title, JSON.stringify(input.modelSnapshot),
      ).first<{ id: number }>();
      if (!row) throw new Error('courseware insert failed');
      const created = await db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM coursewares c WHERE c.id = ?`)
        .bind(row.id).first<SummaryRow>();
      if (!created) throw new Error('courseware insert unavailable');
      return mapSummaryRow(created);
    },

    async listOwned(userId, studentId, cursor, requestedLimit) {
      const limit = Math.max(1, Math.min(50, Number.isInteger(requestedLimit) ? requestedLimit : 20));
      const decoded = decodeCursor(cursor);
      if (cursor && !decoded) return { items: [], nextCursor: null };
      const cursorClause = decoded ? 'AND (c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))' : '';
      const statement = db.prepare(
        `SELECT ${SUMMARY_COLUMNS}
         FROM coursewares c JOIN students s ON s.id = c.student_id
         WHERE s.user_id = ? AND c.student_id = ? ${cursorClause}
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      );
      const bound = decoded
        ? statement.bind(userId, studentId, decoded.updatedAt, decoded.updatedAt, decoded.id, limit + 1)
        : statement.bind(userId, studentId, limit + 1);
      const { results } = await bound.all<SummaryRow>();
      const hasMore = results.length > limit;
      const pageRows = results.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(mapSummaryRow),
        nextCursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
      };
    },

    async getOwned(userId, coursewareId) {
      if (!Number.isInteger(coursewareId) || coursewareId < 1) return null;
      const row = await db.prepare(
        `SELECT c.*, s.user_id AS owner_user_id
         FROM coursewares c JOIN students s ON s.id = c.student_id
         WHERE c.id = ? AND s.user_id = ?`,
      ).bind(coursewareId, userId).first<Omit<CoursewareDetailRow, 'segments'>>();
      return row ? { ...row, segments: await loadSegments(db, coursewareId) } : null;
    },

    async getForWorker(coursewareId) {
      if (!Number.isInteger(coursewareId) || coursewareId < 1) return null;
      const row = await db.prepare(
        `SELECT c.*, s.user_id AS owner_user_id
         FROM coursewares c JOIN students s ON s.id = c.student_id WHERE c.id = ?`,
      ).bind(coursewareId).first<Omit<CoursewareDetailRow, 'segments'>>();
      return row ? { ...row, segments: await loadSegments(db, coursewareId) } : null;
    },

    async claimStage(coursewareId, expectedStage, nextStage, leaseToken, leaseUntil) {
      const current = await db.prepare('SELECT status FROM coursewares WHERE id = ?')
        .bind(coursewareId).first<{ status: CoursewareStatus }>();
      if (!current || !['queued', 'generating', 'ready'].includes(current.status)) return false;
      const nextStatus = current.status === 'ready' ? 'ready' : 'generating';
      const result = await db.prepare(
        `UPDATE coursewares SET status = ?, generation_stage = ?, lease_token = ?,
           lease_expires_at = ?, updated_at = datetime('now')
         WHERE id = ? AND status = ? AND generation_stage = ?
           AND (lease_token IS NULL OR lease_expires_at <= datetime('now'))`,
      ).bind(nextStatus, nextStage, leaseToken, leaseUntil, coursewareId, current.status, expectedStage).run();
      return result.meta.changes === 1;
    },

    async releaseLease(coursewareId, guard) {
      const result = await db.prepare(
        `UPDATE coursewares SET lease_token = NULL, lease_expires_at = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = ? AND generation_stage = ?
           AND ((? IS NULL AND lease_token IS NULL) OR lease_token = ?)`,
      ).bind(coursewareId, guard.status, guard.stage, guard.leaseToken, guard.leaseToken).run();
      return result.meta.changes === 1;
    },

    async saveScript(coursewareId, script, guard) {
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `UPDATE coursewares SET title = ?, subject = ?, grade = ?, topic = ?,
             learning_objectives_json = ?, estimated_minutes = ?, updated_at = datetime('now')
           WHERE id = ? AND status = ? AND generation_stage = ?
             AND ((? IS NULL AND lease_token IS NULL) OR lease_token = ?)`,
        ).bind(script.title, script.subject, script.grade, script.topic,
          JSON.stringify(script.learningObjectives), script.estimatedMinutes, coursewareId,
          guard.status, guard.stage, guard.leaseToken, guard.leaseToken),
        db.prepare(
          `DELETE FROM courseware_segments WHERE courseware_id = ? AND EXISTS (
             SELECT 1 FROM coursewares c WHERE c.id = ? AND c.status = ? AND c.generation_stage = ?
               AND ((? IS NULL AND c.lease_token IS NULL) OR c.lease_token = ?)
           )`,
        ).bind(coursewareId, coursewareId, guard.status, guard.stage, guard.leaseToken, guard.leaseToken),
      ];
      script.segments.forEach((segment, position) => {
        statements.push(db.prepare(
          `INSERT INTO courseware_segments
           (courseware_id, position, segment_key, kind, speaker, title, display_markdown, speech_text,
            alternate_display_markdown, alternate_speech_text, visual_mode, visual_prompt,
            visual_alt_text, checkpoint_json, audio_status, alternate_audio_status, image_status)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM coursewares c WHERE c.id = ? AND c.status = ? AND c.generation_stage = ?
               AND ((? IS NULL AND c.lease_token IS NULL) OR c.lease_token = ?)
           )`,
        ).bind(
          coursewareId, position, segment.segmentKey, segment.kind, segment.speaker, segment.title,
          segment.displayMarkdown, segment.speechText, segment.alternateExplanation?.displayMarkdown ?? '',
          segment.alternateExplanation?.speechText ?? '', segment.visual.mode, segment.visual.prompt ?? '',
          segment.visual.altText ?? '', JSON.stringify(segment.checkpoint ?? {}),
          segment.speaker === 'system' ? 'not_required' : 'pending',
          segment.alternateExplanation ? 'pending' : 'not_required',
          segment.visual.mode === 'generated_image' ? 'pending' : 'not_required',
          coursewareId, guard.status, guard.stage, guard.leaseToken, guard.leaseToken,
        ));
      });
      const results = await db.batch(statements);
      return results[0]?.meta.changes === 1;
    },

    async saveArtifact(artifact, guard) {
      const fields = artifact.variant === 'main'
        ? ['audio_status', 'audio_object_key', 'audio_content_type', 'audio_duration_ms', 'audio_request_id']
        : artifact.variant === 'alternate'
          ? ['alternate_audio_status', 'alternate_audio_object_key', 'alternate_audio_content_type', 'alternate_audio_duration_ms', 'alternate_audio_request_id']
          : ['image_status', 'image_object_key', 'image_content_type', null, 'image_request_id'];
      const durationField = fields[3];
      const sql = durationField
        ? `UPDATE courseware_segments SET ${fields[0]} = 'ready', ${fields[1]} = ?, ${fields[2]} = ?, ${durationField} = ?, ${fields[4]} = ?, updated_at = datetime('now')
           WHERE id = ? AND courseware_id = ? AND ${fields[0]} = 'generating' AND EXISTS (
             SELECT 1 FROM coursewares c WHERE c.id = courseware_segments.courseware_id
               AND c.status = ? AND c.generation_stage = ?
               AND ((? IS NULL AND c.lease_token IS NULL) OR c.lease_token = ?)
           )`
        : `UPDATE courseware_segments SET ${fields[0]} = 'ready', ${fields[1]} = ?, ${fields[2]} = ?, ${fields[4]} = ?, updated_at = datetime('now')
           WHERE id = ? AND courseware_id = ? AND ${fields[0]} = 'generating' AND EXISTS (
             SELECT 1 FROM coursewares c WHERE c.id = courseware_segments.courseware_id
               AND c.status = ? AND c.generation_stage = ?
               AND ((? IS NULL AND c.lease_token IS NULL) OR c.lease_token = ?)
           )`;
      const statement = db.prepare(sql);
      let result: D1Result;
      if (durationField) {
        result = await statement.bind(
          artifact.objectKey, artifact.contentType, artifact.durationMs ?? 0, artifact.requestId ?? '',
          artifact.segmentId, artifact.coursewareId, guard.status, guard.stage,
          guard.leaseToken, guard.leaseToken,
        ).run();
      } else {
        result = await statement.bind(
          artifact.objectKey, artifact.contentType, artifact.requestId ?? '', artifact.segmentId,
          artifact.coursewareId, guard.status, guard.stage, guard.leaseToken, guard.leaseToken,
        ).run();
      }
      return result.meta.changes === 1;
    },

    async saveProgress(userId, coursewareId, input) {
      const result = await db.prepare(
        `UPDATE coursewares SET current_segment_position = ?, current_time_ms = ?,
           checkpoint_answers_json = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'ready' AND EXISTS (
           SELECT 1 FROM students s WHERE s.id = coursewares.student_id AND s.user_id = ?
         )`,
      ).bind(input.currentSegmentPosition, input.currentTimeMs,
        JSON.stringify(input.checkpointAnswers), coursewareId, userId).run();
      return result.meta.changes === 1;
    },

    async markReady(coursewareId, guard) {
      const result = await db.prepare(
        `UPDATE coursewares SET status = 'ready', generation_stage = 'ready', progress_percent = 100,
           lease_token = NULL, lease_expires_at = NULL, completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND status = ? AND generation_stage = ?
           AND ((? IS NULL AND lease_token IS NULL) OR lease_token = ?)`,
      ).bind(coursewareId, guard.status, guard.stage, guard.leaseToken, guard.leaseToken).run();
      return result.meta.changes === 1;
    },

    async markFailed(coursewareId, code, safeMessage, retryable, guard) {
      const result = await db.prepare(
        `UPDATE coursewares SET status = 'failed', error_code = ?,
           error_message = ?, retryable = ?, lease_token = NULL, lease_expires_at = NULL,
           updated_at = datetime('now')
         WHERE id = ? AND status = ? AND generation_stage = ?
           AND ((? IS NULL AND lease_token IS NULL) OR lease_token = ?)`,
      ).bind(code, safeMessage, retryable ? 1 : 0, coursewareId,
        guard.status, guard.stage, guard.leaseToken, guard.leaseToken).run();
      return result.meta.changes === 1;
    },

    async claimRetryableFailure(userId, coursewareId, attemptToken) {
      const state = await db.prepare(
        `SELECT c.generation_stage,
                COUNT(cs.id) AS segment_count,
                COALESCE(SUM(CASE WHEN cs.audio_status NOT IN ('ready', 'not_required')
                                  OR cs.alternate_audio_status NOT IN ('ready', 'not_required')
                                  THEN 1 ELSE 0 END), 0) AS unfinished_speech,
                COALESCE(SUM(CASE WHEN cs.image_status NOT IN ('ready', 'not_required')
                                  THEN 1 ELSE 0 END), 0) AS unfinished_images
         FROM coursewares c
         JOIN students s ON s.id = c.student_id
         LEFT JOIN courseware_segments cs ON cs.courseware_id = c.id
         WHERE c.id = ? AND s.user_id = ? AND c.status = 'failed' AND c.retryable = 1
         GROUP BY c.id`,
      ).bind(coursewareId, userId).first<{
        generation_stage: CoursewareGenerationStage;
        segment_count: number;
        unfinished_speech: number;
        unfinished_images: number;
      }>();
      if (!state) return null;
      let resumeStage: CoursewareRetryClaim['resumeStage'];
      if (['queued', 'scripting'].includes(state.generation_stage)) {
        resumeStage = 'scripting';
      } else {
        if (state.segment_count === 0) return null;
        if (state.generation_stage === 'finalizing') {
          resumeStage = 'finalizing';
        } else if (state.generation_stage === 'speech') {
          resumeStage = state.unfinished_speech > 0
            ? 'speech'
            : state.unfinished_images > 0 ? 'images' : 'finalizing';
        } else if (state.generation_stage === 'images') {
          resumeStage = state.unfinished_speech > 0
            ? 'speech'
            : state.unfinished_images > 0 ? 'images' : 'finalizing';
        } else {
          // Compatibility for an old terminal `generation_stage = failed` row: infer from artifacts,
          // but never re-run the paid scripting call without an explicit scripting/queued stage.
          resumeStage = state.unfinished_speech > 0
            ? 'speech'
            : state.unfinished_images > 0 ? 'images' : 'finalizing';
        }
      }
      const resumeStatus: CoursewareRetryClaim['resumeStatus'] = 'generating';
      const claim: CoursewareRetryClaim = {
        coursewareId,
        failedStage: state.generation_stage,
        resumeStatus,
        resumeStage,
        attemptToken,
      };
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `UPDATE coursewares SET status = ?, generation_stage = ?, error_code = '', error_message = '',
             retryable = 0, lease_token = ?, lease_expires_at = datetime('now', '+5 minutes'),
             updated_at = datetime('now')
           WHERE id = ? AND status = 'failed' AND generation_stage = ? AND retryable = 1
             AND (lease_token IS NULL OR lease_expires_at <= datetime('now'))
             AND EXISTS (
               SELECT 1 FROM students s WHERE s.id = coursewares.student_id AND s.user_id = ?
             )`,
        ).bind(resumeStatus, resumeStage, attemptToken, coursewareId, state.generation_stage, userId),
      ];
      if (resumeStage === 'speech') {
        statements.push(db.prepare(
          `UPDATE courseware_segments SET
             audio_status = CASE WHEN audio_status IN ('failed', 'generating') THEN 'pending' ELSE audio_status END,
             audio_error_code = CASE WHEN audio_status IN ('failed', 'generating') THEN '' ELSE audio_error_code END,
             audio_error_message = CASE WHEN audio_status IN ('failed', 'generating') THEN '' ELSE audio_error_message END,
             audio_retry_count = CASE WHEN audio_status IN ('failed', 'generating') THEN 0 ELSE audio_retry_count END,
             alternate_audio_status = CASE WHEN alternate_audio_status IN ('failed', 'generating') THEN 'pending' ELSE alternate_audio_status END,
             alternate_audio_error_code = CASE WHEN alternate_audio_status IN ('failed', 'generating') THEN '' ELSE alternate_audio_error_code END,
             alternate_audio_error_message = CASE WHEN alternate_audio_status IN ('failed', 'generating') THEN '' ELSE alternate_audio_error_message END,
             alternate_audio_retry_count = CASE WHEN alternate_audio_status IN ('failed', 'generating') THEN 0 ELSE alternate_audio_retry_count END,
             updated_at = datetime('now')
           WHERE courseware_id = ? AND EXISTS (
             SELECT 1 FROM coursewares c WHERE c.id = courseware_segments.courseware_id
               AND c.status = ? AND c.generation_stage = ? AND c.lease_token = ?
           )`,
        ).bind(coursewareId, resumeStatus, resumeStage, attemptToken));
      } else if (resumeStage === 'images') {
        statements.push(db.prepare(
          `UPDATE courseware_segments SET
             image_status = CASE WHEN image_status IN ('failed', 'generating') THEN 'pending' ELSE image_status END,
             image_error_code = CASE WHEN image_status IN ('failed', 'generating') THEN '' ELSE image_error_code END,
             image_error_message = CASE WHEN image_status IN ('failed', 'generating') THEN '' ELSE image_error_message END,
             image_retry_count = CASE WHEN image_status IN ('failed', 'generating') THEN 0 ELSE image_retry_count END,
             updated_at = datetime('now')
           WHERE courseware_id = ? AND EXISTS (
             SELECT 1 FROM coursewares c WHERE c.id = courseware_segments.courseware_id
               AND c.status = ? AND c.generation_stage = ? AND c.lease_token = ?
           )`,
        ).bind(coursewareId, resumeStatus, resumeStage, attemptToken));
      }
      const results = await db.batch(statements);
      return results[0]?.meta.changes === 1 ? claim : null;
    },

    async finishRetryClaim(claim) {
      const result = await db.prepare(
        `UPDATE coursewares SET lease_token = NULL, lease_expires_at = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = ? AND generation_stage = ? AND lease_token = ?`,
      ).bind(claim.coursewareId, claim.resumeStatus, claim.resumeStage, claim.attemptToken).run();
      return result.meta.changes === 1;
    },

    async rollbackRetryClaim(claim, code, safeMessage) {
      const result = await db.prepare(
        `UPDATE coursewares SET status = 'failed', generation_stage = ?, error_code = ?,
           error_message = ?, retryable = 1, lease_token = NULL, lease_expires_at = NULL,
           updated_at = datetime('now')
         WHERE id = ? AND status = ? AND generation_stage = ? AND lease_token = ?`,
      ).bind(claim.resumeStage, code, safeMessage, claim.coursewareId,
        claim.resumeStatus, claim.resumeStage, claim.attemptToken).run();
      return result.meta.changes === 1;
    },

    async claimImageRetry(userId, coursewareId, attemptToken) {
      const result = await db.prepare(
        `UPDATE coursewares SET generation_stage = 'images', lease_token = ?,
           lease_expires_at = datetime('now', '+5 minutes'), updated_at = datetime('now')
         WHERE id = ? AND status = 'ready' AND generation_stage = 'ready'
           AND (lease_token IS NULL OR lease_expires_at <= datetime('now'))
           AND EXISTS (
             SELECT 1 FROM students s WHERE s.id = coursewares.student_id AND s.user_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM courseware_segments cs
             WHERE cs.courseware_id = coursewares.id AND cs.image_status = 'failed'
           )`,
      ).bind(attemptToken, coursewareId, userId).run();
      return result.meta.changes === 1;
    },

    async resetClaimedFailedImages(coursewareId, attemptToken) {
      const result = await db.prepare(
        `UPDATE courseware_segments SET image_status = 'pending', image_request_id = ?,
           image_error_code = '', image_error_message = '', image_retry_count = 0,
           updated_at = datetime('now')
         WHERE courseware_id = ? AND image_status = 'failed' AND EXISTS (
           SELECT 1 FROM coursewares c WHERE c.id = courseware_segments.courseware_id
             AND c.status = 'ready' AND c.generation_stage = 'images' AND c.lease_token = ?
         )`,
      ).bind(attemptToken, coursewareId, attemptToken).run();
      return result.meta.changes > 0;
    },

    async finishImageRetryClaim(coursewareId, attemptToken) {
      const result = await db.prepare(
        `UPDATE coursewares SET lease_token = NULL, lease_expires_at = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'ready' AND generation_stage = 'images' AND lease_token = ?`,
      ).bind(coursewareId, attemptToken).run();
      return result.meta.changes === 1;
    },

    async rollbackImageRetryClaim(coursewareId, attemptToken) {
      const results = await db.batch([
        db.prepare(
          `UPDATE courseware_segments SET image_status = 'failed', image_request_id = '',
             image_error_code = 'queue_unavailable', image_error_message = '图片重试队列暂时不可用',
             updated_at = datetime('now')
           WHERE courseware_id = ? AND image_status = 'pending' AND image_request_id = ?
             AND EXISTS (
               SELECT 1 FROM coursewares c WHERE c.id = courseware_segments.courseware_id
                 AND c.status = 'ready' AND c.generation_stage = 'images' AND c.lease_token = ?
             )`,
        ).bind(coursewareId, attemptToken, attemptToken),
        db.prepare(
          `UPDATE coursewares SET generation_stage = 'ready', lease_token = NULL,
             lease_expires_at = NULL, updated_at = datetime('now')
           WHERE id = ? AND status = 'ready' AND generation_stage = 'images' AND lease_token = ?`,
        ).bind(coursewareId, attemptToken),
      ]);
      return results[1]?.meta.changes === 1;
    },

    async markDeleting(userId, coursewareId) {
      await db.prepare(
        `UPDATE coursewares SET status = 'deleting', lease_token = NULL, lease_expires_at = NULL,
           updated_at = datetime('now')
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM students s WHERE s.id = coursewares.student_id AND s.user_id = ?
         )`,
      ).bind(coursewareId, userId).run();
      const row = await db.prepare(
        `SELECT s.user_id, c.student_id, c.id
         FROM coursewares c JOIN students s ON s.id = c.student_id
         WHERE c.id = ? AND s.user_id = ? AND c.status = 'deleting'`,
      ).bind(coursewareId, userId).first<{ user_id: number; student_id: number; id: number }>();
      return row ? { userId: row.user_id, studentId: row.student_id, coursewareId: row.id } : null;
    },

    async deleteRows(coursewareId) {
      const result = await db.prepare("DELETE FROM coursewares WHERE id = ? AND status = 'deleting'")
        .bind(coursewareId).run();
      return result.meta.changes === 1;
    },
  };
}
