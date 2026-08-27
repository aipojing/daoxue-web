import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoursewareScript } from '../../src/shared/courseware';
import { createCoursewareRepository } from '../../src/worker/courseware/repository';
import { persistCoursewareArtifact } from '../../src/worker/courseware/service';
import { buildCoursewareMediaAttemptKey } from '../../src/worker/courseware/media';

async function createOwnedCourseware(
  status: 'generating' | 'ready' | 'failed' = 'generating',
  stage: 'scripting' | 'speech' | 'images' | 'finalizing' | 'ready' = 'speech',
  leaseToken: string | null = 'lease-a',
) {
  const user = await env.DB.prepare(
    "INSERT INTO users(email, password_hash) VALUES ('state@example.com', 'hash') RETURNING id",
  ).first<{ id: number }>();
  const student = await env.DB.prepare(
    `INSERT INTO students(user_id, name, grade) VALUES (?, '小明', '八年级') RETURNING id`,
  ).bind(user?.id).first<{ id: number }>();
  const courseware = await env.DB.prepare(
    `INSERT INTO coursewares
     (student_id, subject, grade, topic, learning_goal, title, status, generation_stage,
      model_snapshot_json, retryable, lease_token, lease_expires_at)
     VALUES (?, 'math', '八年级', '函数', '理解函数', '函数', ?, ?, '{}', ?, ?, datetime('now', '+5 minutes'))
     RETURNING id`,
  ).bind(student?.id, status, stage, status === 'failed' ? 1 : 0, leaseToken).first<{ id: number }>();
  if (!user || !student || !courseware) throw new Error('failed to create state fixture');
  return { userId: user.id, studentId: student.id, coursewareId: courseware.id };
}

async function insertPendingSegment(coursewareId: number) {
  const row = await env.DB.prepare(
    `INSERT INTO courseware_segments
     (courseware_id, position, segment_key, kind, speaker, title, display_markdown, speech_text,
      audio_status, image_status)
     VALUES (?, 0, 'segment-1', 'teacher_intro', 'teacher', '导入', '正文', '正文', 'generating', 'not_required')
     RETURNING id`,
  ).bind(coursewareId).first<{ id: number }>();
  if (!row) throw new Error('failed to insert state segment');
  return row.id;
}

const script: CoursewareScript = {
  schemaVersion: 1,
  title: '函数',
  subject: 'math',
  grade: '八年级',
  topic: '函数',
  learningObjectives: ['理解函数'],
  estimatedMinutes: 10,
  segments: [],
};

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM courseware_media_tombstones').run();
  await env.DB.prepare('DELETE FROM courseware_student_tombstones').run();
  await env.DB.prepare('DELETE FROM invite_codes').run();
  await env.DB.prepare('DELETE FROM users').run();
  const listed = await env.COURSEWARE_MEDIA.list({ prefix: 'courseware/' });
  if (listed.objects.length > 0) await env.COURSEWARE_MEDIA.delete(listed.objects.map((object) => object.key));
});

describe('courseware guarded state primitives', () => {
  it('atomically refuses a courseware insert once student deletion has a tombstone', async () => {
    const fixture = await createOwnedCourseware('ready', 'ready', null);
    await env.DB.prepare('DELETE FROM coursewares WHERE id = ?').bind(fixture.coursewareId).run();
    await env.DB.prepare(
      'INSERT INTO courseware_student_tombstones(user_id, student_id) VALUES (?, ?)',
    ).bind(fixture.userId, fixture.studentId).run();
    const created = await createCoursewareRepository(env.DB).create({
      userId: fixture.userId,
      enqueueToken: 'create-attempt',
      studentId: fixture.studentId,
      sourceConversationId: null,
      subject: 'math',
      grade: '八年级',
      topic: '函数',
      learningGoal: '理解函数',
      sourceText: '',
      title: '函数',
      modelSnapshot: {},
    });
    expect(created).toBeNull();
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM coursewares WHERE student_id = ?')
      .bind(fixture.studentId).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it('prevents stale script, artifact, ready, and failed writes after deleting wins', async () => {
    const fixture = await createOwnedCourseware('generating', 'speech', 'lease-a');
    const segmentId = await insertPendingSegment(fixture.coursewareId);
    const repository = createCoursewareRepository(env.DB);
    expect(await repository.markDeleting(fixture.userId, fixture.coursewareId)).not.toBeNull();

    const staleGuard = { status: 'generating', stage: 'speech', leaseToken: 'lease-a' } as const;
    expect(await repository.saveScript(fixture.coursewareId, script, staleGuard)).toBe(false);
    expect(await repository.markReady(fixture.coursewareId, staleGuard)).toBe(false);
    expect(await repository.markFailed(
      fixture.coursewareId, 'provider_timeout', '服务暂时不可用', true, staleGuard,
    )).toBe(false);

    const objectKey = `courseware/${fixture.userId}/${fixture.studentId}/${fixture.coursewareId}/audio/${segmentId}.mp3`;
    expect(await persistCoursewareArtifact(env, {
      coursewareId: fixture.coursewareId,
      segmentId,
      variant: 'main',
      objectKey,
      attemptToken: 'stale-delete',
      contentType: 'audio/mpeg',
      bytes: new TextEncoder().encode('new-audio').buffer as ArrayBuffer,
    }, staleGuard)).toBe(false);
    expect(await env.COURSEWARE_MEDIA.head(buildCoursewareMediaAttemptKey(objectKey, 'stale-delete'))).toBeNull();

    const courseware = await env.DB.prepare('SELECT status FROM coursewares WHERE id = ?')
      .bind(fixture.coursewareId).first<{ status: string }>();
    const segment = await env.DB.prepare('SELECT audio_status, audio_object_key FROM courseware_segments WHERE id = ?')
      .bind(segmentId).first<{ audio_status: string; audio_object_key: string }>();
    expect(courseware?.status).toBe('deleting');
    expect(segment).toEqual({ audio_status: 'generating', audio_object_key: '' });
  });

  it('preserves the failed stage and requires the exact lease when marking failed', async () => {
    const fixture = await createOwnedCourseware('generating', 'speech', 'lease-a');
    const repository = createCoursewareRepository(env.DB);
    expect(await repository.markFailed(
      fixture.coursewareId,
      'provider_timeout',
      '服务暂时不可用',
      true,
      { status: 'generating', stage: 'speech', leaseToken: 'wrong-lease' },
    )).toBe(false);
    expect(await repository.markFailed(
      fixture.coursewareId,
      'provider_timeout',
      '服务暂时不可用',
      true,
      { status: 'generating', stage: 'speech', leaseToken: 'lease-a' },
    )).toBe(true);
    const row = await env.DB.prepare('SELECT status, generation_stage FROM coursewares WHERE id = ?')
      .bind(fixture.coursewareId).first<{ status: string; generation_stage: string }>();
    expect(row).toEqual({ status: 'failed', generation_stage: 'speech' });
  });

  it('does not let an old lease overwrite or delete the winning object for the same logical key', async () => {
    const fixture = await createOwnedCourseware('generating', 'speech', 'lease-new');
    const segmentId = await insertPendingSegment(fixture.coursewareId);
    const winnerGuard = { status: 'generating', stage: 'speech', leaseToken: 'lease-new' } as const;
    const staleGuard = { status: 'generating', stage: 'speech', leaseToken: 'lease-old' } as const;
    const logicalKey = `courseware/${fixture.userId}/${fixture.studentId}/${fixture.coursewareId}/audio/${segmentId}.mp3`;
    const winnerKey = buildCoursewareMediaAttemptKey(logicalKey, 'write-new');
    const staleKey = buildCoursewareMediaAttemptKey(logicalKey, 'write-old');
    expect(await persistCoursewareArtifact(env, {
      coursewareId: fixture.coursewareId,
      segmentId,
      variant: 'main',
      objectKey: logicalKey,
      attemptToken: 'write-new',
      contentType: 'audio/mpeg',
      bytes: new TextEncoder().encode('first').buffer as ArrayBuffer,
    }, winnerGuard)).toBe(true);
    expect(await persistCoursewareArtifact(env, {
      coursewareId: fixture.coursewareId,
      segmentId,
      variant: 'main',
      objectKey: logicalKey,
      attemptToken: 'write-old',
      contentType: 'audio/mpeg',
      bytes: new TextEncoder().encode('duplicate').buffer as ArrayBuffer,
    }, staleGuard)).toBe(false);
    const row = await env.DB.prepare('SELECT audio_status, audio_object_key FROM courseware_segments WHERE id = ?')
      .bind(segmentId).first<{ audio_status: string; audio_object_key: string }>();
    expect(row).toEqual({ audio_status: 'ready', audio_object_key: winnerKey });
    expect(await env.COURSEWARE_MEDIA.head(winnerKey)).not.toBeNull();
    expect(await env.COURSEWARE_MEDIA.head(staleKey)).toBeNull();
  });

  it('records a cleanup tombstone when a stale attempt object cannot be deleted', async () => {
    const fixture = await createOwnedCourseware('generating', 'speech', 'lease-new');
    const segmentId = await insertPendingSegment(fixture.coursewareId);
    const logicalKey = `courseware/${fixture.userId}/${fixture.studentId}/${fixture.coursewareId}/audio/${segmentId}.mp3`;
    const winnerKey = buildCoursewareMediaAttemptKey(logicalKey, 'winner');
    const staleKey = buildCoursewareMediaAttemptKey(logicalKey, 'stale');
    expect(await persistCoursewareArtifact(env, {
      coursewareId: fixture.coursewareId, segmentId, variant: 'main', objectKey: logicalKey,
      attemptToken: 'winner', contentType: 'audio/mpeg',
      bytes: new TextEncoder().encode('winner').buffer as ArrayBuffer,
    }, { status: 'generating', stage: 'speech', leaseToken: 'lease-new' })).toBe(true);
    vi.spyOn(env.COURSEWARE_MEDIA, 'delete').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(persistCoursewareArtifact(env, {
      coursewareId: fixture.coursewareId, segmentId, variant: 'main', objectKey: logicalKey,
      attemptToken: 'stale', contentType: 'audio/mpeg',
      bytes: new TextEncoder().encode('stale').buffer as ArrayBuffer,
    }, { status: 'generating', stage: 'speech', leaseToken: 'lease-old' })).rejects.toThrow();
    const tombstone = await env.DB.prepare(
      'SELECT object_key, retry_count FROM courseware_media_tombstones WHERE object_key = ?',
    ).bind(staleKey).first<{ object_key: string; retry_count: number }>();
    expect(tombstone).toEqual({ object_key: staleKey, retry_count: 1 });
    expect(await env.COURSEWARE_MEDIA.head(winnerKey)).not.toBeNull();
  });

  it('allows exactly one image retry attempt to claim a ready failed image', async () => {
    const fixture = await createOwnedCourseware('ready', 'ready', null);
    const segmentId = await insertPendingSegment(fixture.coursewareId);
    await env.DB.prepare("UPDATE courseware_segments SET image_status = 'failed' WHERE id = ?")
      .bind(segmentId).run();
    const repository = createCoursewareRepository(env.DB);
    const claims = await Promise.all([
      repository.claimImageRetry(fixture.userId, fixture.coursewareId, 'image-attempt-a'),
      repository.claimImageRetry(fixture.userId, fixture.coursewareId, 'image-attempt-b'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const row = await env.DB.prepare('SELECT generation_stage, lease_token, enqueue_token FROM coursewares WHERE id = ?')
      .bind(fixture.coursewareId).first<{ generation_stage: string; lease_token: string | null; enqueue_token: string }>();
    expect(row?.generation_stage).toBe('images');
    expect(row?.lease_token).toBeNull();
    expect(['image-attempt-a', 'image-attempt-b']).toContain(row?.enqueue_token);
  });

  it('does not let an old image attempt roll back a newer claim', async () => {
    const fixture = await createOwnedCourseware('ready', 'ready', null);
    const segmentId = await insertPendingSegment(fixture.coursewareId);
    await env.DB.prepare("UPDATE courseware_segments SET image_status = 'failed' WHERE id = ?")
      .bind(segmentId).run();
    const repository = createCoursewareRepository(env.DB);
    expect(await repository.claimImageRetry(fixture.userId, fixture.coursewareId, 'attempt-a')).toBe(true);
    expect(await repository.resetClaimedFailedImages(fixture.coursewareId, 'attempt-a')).toBe(true);
    expect(await repository.rollbackImageRetryClaim(fixture.coursewareId, 'attempt-a')).toBe(true);
    expect(await repository.claimImageRetry(fixture.userId, fixture.coursewareId, 'attempt-b')).toBe(true);
    expect(await repository.resetClaimedFailedImages(fixture.coursewareId, 'attempt-b')).toBe(true);
    expect(await repository.rollbackImageRetryClaim(fixture.coursewareId, 'attempt-a')).toBe(false);
    const row = await env.DB.prepare(
      `SELECT c.generation_stage, c.lease_token, c.enqueue_token, cs.image_status, cs.image_request_id
       FROM coursewares c JOIN courseware_segments cs ON cs.courseware_id = c.id
       WHERE c.id = ? AND cs.id = ?`,
    ).bind(fixture.coursewareId, segmentId).first<{
      generation_stage: string; lease_token: string | null; enqueue_token: string;
      image_status: string; image_request_id: string;
    }>();
    expect(row).toEqual({
      generation_stage: 'images', lease_token: null, enqueue_token: 'attempt-b',
      image_status: 'pending', image_request_id: 'attempt-b',
    });
  });

  it('reports whether deleting rows were actually removed', async () => {
    const fixture = await createOwnedCourseware('ready', 'ready', null);
    const repository = createCoursewareRepository(env.DB);
    expect(await repository.deleteRows(fixture.coursewareId)).toBe(false);
    expect(await repository.markDeleting(fixture.userId, fixture.coursewareId)).not.toBeNull();
    expect(await repository.deleteRows(fixture.coursewareId)).toBe(true);
    expect(await repository.deleteRows(fixture.coursewareId)).toBe(false);
  });

  it('keeps enqueue ownership separate so a delivered message can immediately claim a worker lease', async () => {
    const fixture = await createOwnedCourseware('failed', 'speech', null);
    const segmentId = await insertPendingSegment(fixture.coursewareId);
    await env.DB.prepare("UPDATE courseware_segments SET audio_status = 'failed' WHERE id = ?")
      .bind(segmentId).run();
    const repository = createCoursewareRepository(env.DB);
    const claim = await repository.claimRetryableFailure(
      fixture.userId, fixture.coursewareId, 'enqueue-a',
    );
    expect(claim).not.toBeNull();
    const claimed = await env.DB.prepare(
      `SELECT lease_token, enqueue_token, enqueue_kind FROM coursewares WHERE id = ?`,
    ).bind(fixture.coursewareId).first<{
      lease_token: string | null; enqueue_token: string | null; enqueue_kind: string | null;
    }>();
    expect(claimed).toEqual({ lease_token: null, enqueue_token: 'enqueue-a', enqueue_kind: 'full_retry' });
    expect(await repository.claimStage(
      fixture.coursewareId,
      'speech',
      'speech',
      'worker-lease',
      '2099-01-01 00:00:00',
    )).toBe(true);
    const delivered = await env.DB.prepare(
      `SELECT lease_token, enqueue_token, enqueue_kind FROM coursewares WHERE id = ?`,
    ).bind(fixture.coursewareId).first<{
      lease_token: string | null; enqueue_token: string | null; enqueue_kind: string | null;
    }>();
    expect(delivered).toEqual({ lease_token: 'worker-lease', enqueue_token: null, enqueue_kind: null });
    expect(await repository.finishRetryClaim(claim!)).toBe(false);
  });

  it('reclaims an expired enqueue after a crash before send without taking a worker lease', async () => {
    const fixture = await createOwnedCourseware('failed', 'speech', null);
    const segmentId = await insertPendingSegment(fixture.coursewareId);
    await env.DB.prepare("UPDATE courseware_segments SET audio_status = 'failed' WHERE id = ?")
      .bind(segmentId).run();
    const repository = createCoursewareRepository(env.DB);
    expect(await repository.claimRetryableFailure(
      fixture.userId, fixture.coursewareId, 'enqueue-old',
    )).not.toBeNull();
    await env.DB.prepare(
      "UPDATE coursewares SET enqueue_expires_at = datetime('now', '-1 minute') WHERE id = ?",
    ).bind(fixture.coursewareId).run();
    const reclaimed = await repository.claimRetryableFailure(
      fixture.userId, fixture.coursewareId, 'enqueue-new',
    );
    expect(reclaimed?.attemptToken).toBe('enqueue-new');
    const row = await env.DB.prepare(
      `SELECT status, generation_stage, lease_token, enqueue_token FROM coursewares WHERE id = ?`,
    ).bind(fixture.coursewareId).first<{
      status: string; generation_stage: string; lease_token: string | null; enqueue_token: string;
    }>();
    expect(row).toEqual({
      status: 'generating', generation_stage: 'speech', lease_token: null, enqueue_token: 'enqueue-new',
    });
  });

  it('recovers an expired initial create enqueue after an API crash before send', async () => {
    const fixture = await createOwnedCourseware('generating', 'speech', null);
    await env.DB.prepare(
      `UPDATE coursewares SET status = 'queued', generation_stage = 'queued', retryable = 0,
         enqueue_token = 'create-old', enqueue_kind = 'create',
         enqueue_expires_at = datetime('now', '-1 minute') WHERE id = ?`,
    ).bind(fixture.coursewareId).run();
    const claim = await createCoursewareRepository(env.DB).claimRetryableFailure(
      fixture.userId, fixture.coursewareId, 'create-recovery',
    );
    expect(claim).toMatchObject({ resumeStatus: 'generating', resumeStage: 'scripting' });
    const row = await env.DB.prepare(
      `SELECT status, generation_stage, lease_token, enqueue_token, enqueue_kind
       FROM coursewares WHERE id = ?`,
    ).bind(fixture.coursewareId).first();
    expect(row).toEqual({
      status: 'generating', generation_stage: 'scripting', lease_token: null,
      enqueue_token: 'create-recovery', enqueue_kind: 'full_retry',
    });
  });
});
