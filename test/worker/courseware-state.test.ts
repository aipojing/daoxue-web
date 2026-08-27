import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CoursewareScript } from '../../src/shared/courseware';
import { createCoursewareRepository } from '../../src/worker/courseware/repository';
import { persistCoursewareArtifact } from '../../src/worker/courseware/service';

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
  await env.DB.prepare('DELETE FROM invite_codes').run();
  await env.DB.prepare('DELETE FROM users').run();
  const listed = await env.COURSEWARE_MEDIA.list({ prefix: 'courseware/' });
  if (listed.objects.length > 0) await env.COURSEWARE_MEDIA.delete(listed.objects.map((object) => object.key));
});

describe('courseware guarded state primitives', () => {
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
      contentType: 'audio/mpeg',
      bytes: new TextEncoder().encode('new-audio').buffer as ArrayBuffer,
    }, staleGuard)).toBe(false);
    expect(await env.COURSEWARE_MEDIA.head(objectKey)).toBeNull();

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

  it('does not replace an artifact that is already ready under the same lease', async () => {
    const fixture = await createOwnedCourseware('generating', 'speech', 'lease-a');
    const segmentId = await insertPendingSegment(fixture.coursewareId);
    const guard = { status: 'generating', stage: 'speech', leaseToken: 'lease-a' } as const;
    const firstKey = `courseware/${fixture.userId}/${fixture.studentId}/${fixture.coursewareId}/audio/${segmentId}.mp3`;
    expect(await persistCoursewareArtifact(env, {
      coursewareId: fixture.coursewareId,
      segmentId,
      variant: 'main',
      objectKey: firstKey,
      contentType: 'audio/mpeg',
      bytes: new TextEncoder().encode('first').buffer as ArrayBuffer,
    }, guard)).toBe(true);
    const duplicateKey = `${firstKey}.duplicate`;
    expect(await persistCoursewareArtifact(env, {
      coursewareId: fixture.coursewareId,
      segmentId,
      variant: 'main',
      objectKey: duplicateKey,
      contentType: 'audio/mpeg',
      bytes: new TextEncoder().encode('duplicate').buffer as ArrayBuffer,
    }, guard)).toBe(false);
    const row = await env.DB.prepare('SELECT audio_status, audio_object_key FROM courseware_segments WHERE id = ?')
      .bind(segmentId).first<{ audio_status: string; audio_object_key: string }>();
    expect(row).toEqual({ audio_status: 'ready', audio_object_key: firstKey });
    expect(await env.COURSEWARE_MEDIA.head(firstKey)).not.toBeNull();
    expect(await env.COURSEWARE_MEDIA.head(duplicateKey)).toBeNull();
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
    const row = await env.DB.prepare('SELECT generation_stage, lease_token FROM coursewares WHERE id = ?')
      .bind(fixture.coursewareId).first<{ generation_stage: string; lease_token: string }>();
    expect(row?.generation_stage).toBe('images');
    expect(['image-attempt-a', 'image-attempt-b']).toContain(row?.lease_token);
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
      `SELECT c.generation_stage, c.lease_token, cs.image_status, cs.image_request_id
       FROM coursewares c JOIN courseware_segments cs ON cs.courseware_id = c.id
       WHERE c.id = ? AND cs.id = ?`,
    ).bind(fixture.coursewareId, segmentId).first<{
      generation_stage: string; lease_token: string;
      image_status: string; image_request_id: string;
    }>();
    expect(row).toEqual({
      generation_stage: 'images', lease_token: 'attempt-b',
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
});
