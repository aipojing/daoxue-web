import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoursewareModelPreference } from '../../src/shared/ai-catalog';
import { saveCredential } from '../../src/worker/ai-catalog/credentials';
import { saveUserModelPreferences } from '../../src/worker/ai-catalog/repository';
import { createCourseware, drainCoursewareMediaTombstones } from '../../src/worker/courseware/service';
import { createCoursewareRepository } from '../../src/worker/courseware/repository';
import { buildCoursewareMediaAttemptKey, deleteCoursewareMedia } from '../../src/worker/courseware/media';

interface Envelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

const worker = exports.default as unknown as {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

async function api(path: string, init: RequestInit = {}, cookie = ''): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  return worker.fetch(`https://example.com${path}`, { ...init, headers });
}

async function json<T>(response: Response): Promise<Envelope<T>> {
  return response.json<Envelope<T>>();
}

async function register(email: string) {
  const existing = await env.DB.prepare('SELECT id FROM users ORDER BY id LIMIT 1').first<{ id: number }>();
  const inviteCode = existing ? `test-${crypto.randomUUID()}` : undefined;
  if (existing && inviteCode) {
    await env.DB.prepare(
      'INSERT INTO invite_codes(code, max_uses, created_by) VALUES (?, 1, ?)',
    ).bind(inviteCode, existing.id).run();
  }
  const response = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct-password', inviteCode }),
  });
  const body = await json<{ id: number }>(response);
  const setCookie = response.headers.get('Set-Cookie');
  if (!body.data || !setCookie) throw new Error('failed to create test account');
  return { id: body.data.id, cookie: setCookie.split(';', 1)[0] ?? '' };
}

async function createStudent(cookie: string, name = '小明') {
  const response = await api('/api/students', {
    method: 'POST',
    body: JSON.stringify({ name, grade: '八年级', textbook: '', region: '', color: '#4f6ef7', notes: '' }),
  }, cookie);
  const body = await json<{ id: number }>(response);
  if (!body.data) throw new Error('failed to create student');
  return body.data.id;
}

async function configureCoursewareAI(userId: number, health: 'valid' | 'invalid' | 'quota_exhausted' = 'valid') {
  const provider = await env.DB.prepare("SELECT id FROM ai_providers WHERE slug = 'bailian-token-plan'")
    .first<{ id: number }>();
  if (!provider) throw new Error('missing seeded provider');
  await saveCredential(env.DB, env, userId, provider.id, 'test-only-courseware-key');
  await env.DB.prepare(
    'UPDATE user_ai_credentials SET health_status = ? WHERE user_id = ? AND provider_id = ?',
  ).bind(health, userId, provider.id).run();
  const { results } = await env.DB.prepare(
    `SELECT id, endpoint_id, capability FROM ai_models
     WHERE model_id IN ('qwen3.7-plus', 'qwen-audio-3.0-tts-plus', 'qwen-image-3.0-pro')`,
  ).all<{ id: number; endpoint_id: number; capability: string }>();
  const byCapability = new Map(results.map((row) => [row.capability, row]));
  const preference = (
    purpose: CoursewareModelPreference['purpose'], capability: string, voiceId = '',
  ): CoursewareModelPreference => {
    const row = byCapability.get(capability);
    if (!row) throw new Error(`missing ${capability} model`);
    return { purpose, endpointId: row.endpoint_id, modelCatalogId: row.id, customModelId: '', voiceId, params: {} };
  };
  await saveUserModelPreferences(env.DB, userId, { preferences: [
    preference('courseware_text', 'structured_text'),
    preference('courseware_image', 'image_generation'),
    preference('teacher_tts', 'speech_synthesis', 'longanlingxin'),
    preference('student_tts', 'speech_synthesis', 'longanlufeng'),
  ] });
}

async function insertCourseware(
  studentId: number,
  status: 'ready' | 'failed' | 'queued' | 'generating' = 'ready',
  generationStage?: 'queued' | 'scripting' | 'speech' | 'images' | 'finalizing' | 'ready' | 'failed',
) {
  const resolvedStage = generationStage
    ?? (status === 'ready' ? 'ready' : status === 'failed' ? 'failed' : status === 'generating' ? 'speech' : 'queued');
  const row = await env.DB.prepare(
    `INSERT INTO coursewares
     (student_id, subject, grade, topic, learning_goal, title, status, generation_stage,
      progress_percent, model_snapshot_json, retryable, error_code, error_message,
      learning_objectives_json, estimated_minutes)
     VALUES (?, 'math', '八年级', '一次函数', '学会画图', '一次函数', ?, ?, ?, '{}', ?, ?, ?, '["理解斜率"]', 12)
     RETURNING id`,
  ).bind(
    studentId,
    status,
    resolvedStage,
    status === 'ready' ? 100 : 0,
    status === 'failed' ? 1 : 0,
    status === 'failed' ? 'provider_timeout' : '',
    status === 'failed' ? '服务暂时不可用' : '',
  ).first<{ id: number }>();
  if (!row) throw new Error('failed to insert courseware');
  return row.id;
}

async function setImageSnapshot(coursewareId: number) {
  const imageEndpoint = await env.DB.prepare(
    `SELECT e.id AS endpoint_id, p.id AS provider_id FROM ai_provider_endpoints e
     JOIN ai_providers p ON p.id = e.provider_id WHERE e.capability = 'image_generation' LIMIT 1`,
  ).first<{ endpoint_id: number; provider_id: number }>();
  await env.DB.prepare('UPDATE coursewares SET model_snapshot_json = ? WHERE id = ?').bind(
    JSON.stringify({ image: { endpointId: imageEndpoint?.endpoint_id, providerId: imageEndpoint?.provider_id } }),
    coursewareId,
  ).run();
}

async function insertSegment(coursewareId: number, imageStatus: 'ready' | 'failed' | 'not_required' = 'not_required') {
  const row = await env.DB.prepare(
    `INSERT INTO courseware_segments
     (courseware_id, position, segment_key, kind, speaker, title, display_markdown, speech_text,
      audio_status, audio_object_key, audio_content_type, audio_duration_ms,
      alternate_audio_status, image_status, image_object_key, image_content_type, checkpoint_json)
     VALUES (?, 0, 'intro', 'teacher_intro', 'teacher', '导入', '正文', '正文',
       'ready', ?, 'audio/mpeg', 1200, 'not_required', ?, ?, ?, '{}') RETURNING id`,
  ).bind(coursewareId, `courseware/placeholder/${coursewareId}/audio.mp3`, imageStatus,
    imageStatus === 'ready' ? `courseware/placeholder/${coursewareId}/image.png` : '',
    imageStatus === 'ready' ? 'image/png' : '').first<{ id: number }>();
  if (!row) throw new Error('failed to insert segment');
  return row.id;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM courseware_media_tombstones').run();
  await env.DB.prepare('DELETE FROM courseware_student_tombstones').run();
  await env.DB.prepare('DELETE FROM invite_codes').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare("UPDATE app_settings SET value = '0' WHERE key = 'courseware_enabled'").run();
  const listed = await env.COURSEWARE_MEDIA.list({ prefix: 'courseware/' });
  if (listed.objects.length > 0) await env.COURSEWARE_MEDIA.delete(listed.objects.map((object) => object.key));
  vi.restoreAllMocks();
});

describe('courseware routes', () => {
  it('requires authentication for every courseware and media route', async () => {
    const routes: Array<[string, string]> = [
      ['POST', '/api/students/1/coursewares'], ['GET', '/api/students/1/coursewares'],
      ['GET', '/api/coursewares/1'], ['GET', '/api/coursewares/1/progress'],
      ['PATCH', '/api/coursewares/1/progress'], ['POST', '/api/coursewares/1/retry'],
      ['POST', '/api/coursewares/1/images/retry'], ['DELETE', '/api/coursewares/1'],
      ['GET', '/api/coursewares/1/segments/1/audio'],
      ['GET', '/api/coursewares/1/segments/1/alternate-audio'],
      ['GET', '/api/coursewares/1/segments/1/image'],
    ];
    for (const [method, path] of routes) expect((await api(path, { method })).status).toBe(401);
  });

  it('rejects creation when the feature flag is disabled', async () => {
    const account = await register('disabled@example.com');
    const studentId = await createStudent(account.cookie);
    const response = await api(`/api/students/${studentId}/coursewares`, {
      method: 'POST', body: JSON.stringify({ subject: 'math', topic: '一次函数', learningGoal: '理解图像', includeImages: false }),
    }, account.cookie);
    expect(response.status).toBe(403);
  });

  it('rejects creation when text or speech preferences and credentials are missing', async () => {
    const account = await register('missing@example.com');
    const studentId = await createStudent(account.cookie);
    await env.DB.prepare("UPDATE app_settings SET value = '1' WHERE key = 'courseware_enabled'").run();
    const response = await api(`/api/students/${studentId}/coursewares`, {
      method: 'POST', body: JSON.stringify({ subject: 'math', topic: '一次函数', learningGoal: '理解图像', includeImages: false }),
    }, account.cookie);
    expect(response.status).toBe(400);
    expect((await json(response)).error).not.toContain('key_ciphertext');
  });

  it('validates creation lengths at the service boundary before inserting', async () => {
    const account = await register('service-validation@example.com');
    const studentId = await createStudent(account.cookie);
    await configureCoursewareAI(account.id);
    await env.DB.prepare("UPDATE app_settings SET value = '1' WHERE key = 'courseware_enabled'").run();
    await expect(createCourseware(env, account.id, {
      studentId,
      subject: 'math',
      topic: '字'.repeat(81),
      learningGoal: '理解图像',
      includeImages: false,
    })).rejects.toMatchObject({ status: 400 });
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM coursewares')
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it('rejects creation after a required provider is known invalid or quota-exhausted', async () => {
    for (const [index, health] of (['invalid', 'quota_exhausted'] as const).entries()) {
      const account = await register(`blocked-${index}@example.com`);
      const studentId = await createStudent(account.cookie);
      await configureCoursewareAI(account.id, health);
      await env.DB.prepare("UPDATE app_settings SET value = '1' WHERE key = 'courseware_enabled'").run();
      const response = await api(`/api/students/${studentId}/coursewares`, {
        method: 'POST', body: JSON.stringify({ subject: 'math', topic: '一次函数', learningGoal: '理解图像', includeImages: false }),
      }, account.cookie);
      expect(response.status).toBe(400);
    }
  });

  it('creates one queued courseware and enqueues only its id', async () => {
    const account = await register('create@example.com');
    const studentId = await createStudent(account.cookie);
    await configureCoursewareAI(account.id);
    await env.DB.prepare("UPDATE app_settings SET value = '1' WHERE key = 'courseware_enabled'").run();
    const sentMessages: unknown[] = [];
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockImplementation(async (message) => {
      sentMessages.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
    const response = await api(`/api/students/${studentId}/coursewares`, {
      method: 'POST', body: JSON.stringify({ subject: 'math', topic: '一次函数', learningGoal: '理解图像', sourceText: '课本例题', includeImages: true }),
    }, account.cookie);
    expect(response.status).toBe(201);
    const created = await json<{ id: number; status: string }>(response);
    expect(created.data?.status).toBe('queued');
    expect(sentMessages).toEqual([{ coursewareId: created.data?.id }]);
    expect(JSON.stringify(created.data)).not.toContain('model_snapshot');
    const enqueue = await env.DB.prepare(
      'SELECT enqueue_token, enqueue_kind FROM coursewares WHERE id = ?',
    ).bind(created.data?.id).first<{ enqueue_token: string | null; enqueue_kind: string | null }>();
    expect(enqueue).toEqual({ enqueue_token: null, enqueue_kind: null });
  });

  it('recovers an expired create enqueue during owned detail polling and ignores its delayed message', async () => {
    const account = await register('recover-create-poll@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId, 'queued', 'queued');
    await env.DB.prepare(
      `UPDATE coursewares SET enqueue_token = 'create-crash', enqueue_kind = 'create',
         enqueue_expires_at = datetime('now', '-1 minute') WHERE id = ?`,
    ).bind(coursewareId).run();
    const other = await register('recover-create-intruder@example.com');
    expect((await api(`/api/coursewares/${coursewareId}`, {}, other.cookie)).status).toBe(403);
    const untouched = await env.DB.prepare('SELECT status, enqueue_token FROM coursewares WHERE id = ?')
      .bind(coursewareId).first();
    expect(untouched).toEqual({ status: 'queued', enqueue_token: 'create-crash' });
    const response = await api(`/api/coursewares/${coursewareId}`, {}, account.cookie);
    expect(response.status).toBe(200);
    const detail = await json<{ status: string; generationStage: string; retryable: boolean; errorCode: string }>(response);
    expect(detail.data).toMatchObject({
      status: 'failed', generationStage: 'queued', retryable: true, errorCode: 'enqueue_timeout',
    });
    expect(await createCoursewareRepository(env.DB).claimStage(
      coursewareId, 'queued', 'scripting', 'delayed-worker', '2099-01-01 00:00:00',
    )).toBe(false);
    const sent: unknown[] = [];
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockImplementation(async (message) => {
      sent.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
    expect((await api(`/api/coursewares/${coursewareId}/retry`, { method: 'POST' }, account.cookie)).status).toBe(200);
    expect(sent).toEqual([{ coursewareId }]);
  });

  it('recovers an expired full retry enqueue on progress polling but not a fresh or actively leased enqueue', async () => {
    const account = await register('recover-full-poll@example.com');
    const studentId = await createStudent(account.cookie);
    const expiredId = await insertCourseware(studentId, 'generating', 'speech');
    const freshId = await insertCourseware(studentId, 'generating', 'speech');
    const activeId = await insertCourseware(studentId, 'generating', 'speech');
    await env.DB.prepare(
      `UPDATE coursewares SET enqueue_token = ?, enqueue_kind = 'full_retry',
         enqueue_expires_at = datetime('now', ?), lease_token = ?, lease_expires_at = ?
       WHERE id = ?`,
    ).bind('expired', '-1 minute', null, null, expiredId).run();
    await env.DB.prepare(
      `UPDATE coursewares SET enqueue_token = ?, enqueue_kind = 'full_retry',
         enqueue_expires_at = datetime('now', ?), lease_token = ?, lease_expires_at = ?
       WHERE id = ?`,
    ).bind('fresh', '+5 minutes', null, null, freshId).run();
    await env.DB.prepare(
      `UPDATE coursewares SET enqueue_token = ?, enqueue_kind = 'full_retry',
         enqueue_expires_at = datetime('now', ?), lease_token = ?, lease_expires_at = datetime('now', '+5 minutes')
       WHERE id = ?`,
    ).bind('active', '-1 minute', 'worker-active', activeId).run();
    for (const id of [expiredId, freshId, activeId]) {
      expect((await api(`/api/coursewares/${id}/progress`, {}, account.cookie)).status).toBe(200);
    }
    const { results } = await env.DB.prepare(
      `SELECT id, status, generation_stage, retryable, enqueue_token, lease_token
       FROM coursewares WHERE id IN (?, ?, ?) ORDER BY id`,
    ).bind(expiredId, freshId, activeId).all<{
      id: number; status: string; generation_stage: string; retryable: number;
      enqueue_token: string | null; lease_token: string | null;
    }>();
    expect(results).toEqual([
      { id: expiredId, status: 'failed', generation_stage: 'speech', retryable: 1, enqueue_token: null, lease_token: null },
      { id: freshId, status: 'generating', generation_stage: 'speech', retryable: 0, enqueue_token: 'fresh', lease_token: null },
      { id: activeId, status: 'generating', generation_stage: 'speech', retryable: 0, enqueue_token: 'active', lease_token: 'worker-active' },
    ]);
    const listRecoveredId = await insertCourseware(studentId, 'generating', 'images');
    await env.DB.prepare(
      `UPDATE coursewares SET enqueue_token = 'list-expired', enqueue_kind = 'full_retry',
         enqueue_expires_at = datetime('now', '-1 minute') WHERE id = ?`,
    ).bind(listRecoveredId).run();
    expect((await api(`/api/students/${studentId}/coursewares`, {}, account.cookie)).status).toBe(200);
    const listRecovered = await env.DB.prepare(
      'SELECT status, generation_stage, retryable FROM coursewares WHERE id = ?',
    ).bind(listRecoveredId).first();
    expect(listRecovered).toEqual({ status: 'failed', generation_stage: 'images', retryable: 1 });
  });

  it('lets a create message acquire its worker lease before Queue.send resolves', async () => {
    const account = await register('create-immediate-consumer@example.com');
    const studentId = await createStudent(account.cookie);
    await configureCoursewareAI(account.id);
    await env.DB.prepare("UPDATE app_settings SET value = '1' WHERE key = 'courseware_enabled'").run();
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockImplementation(async (message) => {
      const id = (message as { coursewareId: number }).coursewareId;
      expect(await createCoursewareRepository(env.DB).claimStage(
        id, 'queued', 'scripting', 'worker-immediate', '2099-01-01 00:00:00',
      )).toBe(true);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
    const response = await api(`/api/students/${studentId}/coursewares`, {
      method: 'POST',
      body: JSON.stringify({ subject: 'math', topic: '一次函数', learningGoal: '理解图像', includeImages: false }),
    }, account.cookie);
    expect(response.status).toBe(201);
    const created = await json<{ id: number }>(response);
    const state = await env.DB.prepare(
      'SELECT generation_stage, lease_token, enqueue_token FROM coursewares WHERE id = ?',
    ).bind(created.data?.id).first<{
      generation_stage: string; lease_token: string | null; enqueue_token: string | null;
    }>();
    expect(state).toEqual({ generation_stage: 'scripting', lease_token: 'worker-immediate', enqueue_token: null });
  });

  it('lists only coursewares owned by the current parent and student', async () => {
    const owner = await register('list-owner@example.com');
    const other = await register('list-other@example.com');
    const ownerStudent = await createStudent(owner.cookie);
    const otherStudent = await createStudent(other.cookie);
    await insertCourseware(ownerStudent);
    await insertCourseware(otherStudent);
    const response = await api(`/api/students/${ownerStudent}/coursewares`, {}, owner.cookie);
    const body = await json<{ items: Array<{ studentId: number }> }>(response);
    expect(response.status).toBe(200);
    expect(body.data?.items).toHaveLength(1);
    expect(body.data?.items[0]?.studentId).toBe(ownerStudent);
  });

  it('returns exact required-audio ready and total counts in list summaries', async () => {
    const account = await register('audio-counts@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId, 'generating', 'speech');
    const first = await insertSegment(coursewareId);
    await env.DB.prepare(
      "UPDATE courseware_segments SET alternate_audio_status = 'ready' WHERE id = ?",
    ).bind(first).run();
    await env.DB.prepare(
      `INSERT INTO courseware_segments
       (courseware_id, position, segment_key, kind, speaker, title, display_markdown, speech_text,
        audio_status, alternate_audio_status, image_status)
       VALUES (?, 1, 'explain', 'teacher_explanation', 'teacher', '讲解', '正文', '正文',
         'pending', 'not_required', 'not_required')`,
    ).bind(coursewareId).run();

    const response = await api(`/api/students/${studentId}/coursewares`, {}, account.cookie);
    const body = await json<{ items: Array<{ requiredAudioReadyCount: number; requiredAudioTotalCount: number }> }>(response);
    expect(body.data?.items[0]).toMatchObject({ requiredAudioReadyCount: 2, requiredAudioTotalCount: 3 });
  });

  it('returns progress and a ready courseware without exposing R2 keys', async () => {
    const account = await register('detail@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    await insertSegment(coursewareId);
    const detail = await api(`/api/coursewares/${coursewareId}`, {}, account.cookie);
    const progress = await api(`/api/coursewares/${coursewareId}/progress`, {}, account.cookie);
    expect(detail.status).toBe(200);
    expect(progress.status).toBe(200);
    const serialized = JSON.stringify((await json(detail)).data);
    expect(serialized).not.toContain('object_key');
    expect(serialized).not.toContain('placeholder');
    expect(serialized).toContain(`/api/coursewares/${coursewareId}/segments/`);
  });

  it('authenticates a courseware request exactly once at the index boundary', async () => {
    const account = await register('single-auth@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let sessionQueries = 0;
    vi.spyOn(env.DB, 'prepare').mockImplementation((query: string) => {
      if (query.includes('FROM sessions')) sessionQueries += 1;
      return originalPrepare(query);
    });
    expect((await api(`/api/coursewares/${coursewareId}`, {}, account.cookie)).status).toBe(200);
    expect(sessionQueries).toBe(1);
  });

  it('saves merged playback and checkpoint progress without writing knowledge evidence', async () => {
    const account = await register('progress@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    await env.DB.prepare(
      `INSERT INTO courseware_segments
       (courseware_id, position, segment_key, kind, speaker, title, display_markdown, speech_text,
        audio_status, checkpoint_json)
       VALUES (?, 0, 'check-1', 'checkpoint', 'system', '检查', '选一个', '选一个', 'not_required',
         '{"prompt":"选一个","options":["A","B"],"correctAnswer":"A","explanation":"说明"}')`,
    ).bind(coursewareId).run();
    const before = await env.DB.prepare('SELECT COUNT(*) AS count FROM knowledge_points').first<{ count: number }>();
    const response = await api(`/api/coursewares/${coursewareId}/progress`, {
      method: 'PATCH', body: JSON.stringify({ revision: 1, currentSegmentPosition: 0, currentTimeMs: 900, checkpointAnswers: { 'check-1': 1 } }),
    }, account.cookie);
    expect(response.status).toBe(200);
    const after = await env.DB.prepare('SELECT COUNT(*) AS count FROM knowledge_points').first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
    expect((await json<{ currentTimeMs: number }>(response)).data?.currentTimeMs).toBe(900);
  });

  it('rejects an older progress revision that arrives after a newer final snapshot', async () => {
    const account = await register('progress-order@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    await env.DB.prepare(
      `INSERT INTO courseware_segments
       (courseware_id, position, segment_key, kind, speaker, title, display_markdown, speech_text, audio_status)
       VALUES (?, 0, 'intro', 'teacher_intro', 'teacher', '开始', '内容', '内容', 'ready'),
              (?, 1, 'summary', 'summary', 'teacher', '总结', '总结', '总结', 'ready')`,
    ).bind(coursewareId, coursewareId).run();

    const newest = await api(`/api/coursewares/${coursewareId}/progress`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 2, currentSegmentPosition: 1, currentTimeMs: 8_000, checkpointAnswers: {} }),
    }, account.cookie);
    expect(newest.status).toBe(200);

    const delayedOlder = await api(`/api/coursewares/${coursewareId}/progress`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 1, currentSegmentPosition: 0, currentTimeMs: 1_000, checkpointAnswers: {} }),
    }, account.cookie);
    expect(delayedOlder.status).toBe(409);

    const progress = await api(`/api/coursewares/${coursewareId}/progress`, {}, account.cookie);
    expect(await json<{ revision: number; currentSegmentPosition: number; currentTimeMs: number }>(progress))
      .toMatchObject({ data: { revision: 2, currentSegmentPosition: 1, currentTimeMs: 8_000 } });
  });

  it('serves owned audio with content type, accept-ranges, and a valid 206 range response', async () => {
    const account = await register('media@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    const segmentId = await insertSegment(coursewareId);
    const logicalKey = `courseware/${account.id}/${studentId}/${coursewareId}/audio/${segmentId}.mp3`;
    const key = buildCoursewareMediaAttemptKey(logicalKey, 'delivery-attempt');
    await env.DB.prepare('UPDATE courseware_segments SET audio_object_key = ? WHERE id = ?').bind(key, segmentId).run();
    await env.COURSEWARE_MEDIA.put(key, new TextEncoder().encode('0123456789'), { httpMetadata: { contentType: 'audio/mpeg' } });
    const response = await api(`/api/coursewares/${coursewareId}/segments/${segmentId}/audio`, {
      headers: { Range: 'bytes=2-5' },
    }, account.cookie);
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(response.headers.get('ETag')).toBeTruthy();
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('2345');
  });

  it('honors wildcard, list, and weak If-None-Match before Range for GET and HEAD', async () => {
    const account = await register('etag@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    const segmentId = await insertSegment(coursewareId);
    const key = `courseware/${account.id}/${studentId}/${coursewareId}/audio/${segmentId}.mp3`;
    await env.DB.prepare('UPDATE courseware_segments SET audio_object_key = ? WHERE id = ?').bind(key, segmentId).run();
    await env.COURSEWARE_MEDIA.put(key, '0123456789', { httpMetadata: { contentType: 'audio/mpeg' } });
    const path = `/api/coursewares/${coursewareId}/segments/${segmentId}/audio`;
    const full = await api(path, {}, account.cookie);
    const etag = full.headers.get('ETag');
    expect(etag).toBeTruthy();
    for (const [method, value] of [
      ['GET', '*'],
      ['GET', `"different", W/${etag}`],
      ['HEAD', `W/${etag}`],
    ] as const) {
      const response = await api(path, {
        method,
        headers: { 'If-None-Match': value, Range: 'bytes=0-1' },
      }, account.cookie);
      expect(response.status).toBe(304);
      expect(response.headers.get('ETag')).toBe(etag);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it('returns 403 when another parent requests a courseware or media object', async () => {
    const owner = await register('private-owner@example.com');
    const other = await register('private-other@example.com');
    const studentId = await createStudent(owner.cookie);
    const coursewareId = await insertCourseware(studentId);
    const segmentId = await insertSegment(coursewareId);
    expect((await api(`/api/coursewares/${coursewareId}`, {}, other.cookie)).status).toBe(403);
    expect((await api(`/api/coursewares/${coursewareId}/segments/${segmentId}/audio`, {}, other.cookie)).status).toBe(403);
  });

  it('keeps a saved ready courseware playable after credentials are removed', async () => {
    const account = await register('saved@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    const segmentId = await insertSegment(coursewareId);
    const key = `courseware/${account.id}/${studentId}/${coursewareId}/audio/${segmentId}.mp3`;
    await env.DB.prepare('UPDATE courseware_segments SET audio_object_key = ? WHERE id = ?').bind(key, segmentId).run();
    await env.COURSEWARE_MEDIA.put(key, 'saved', { httpMetadata: { contentType: 'audio/mpeg' } });
    await env.DB.prepare('DELETE FROM user_ai_credentials WHERE user_id = ?').bind(account.id).run();
    expect((await api(`/api/coursewares/${coursewareId}/segments/${segmentId}/audio`, {}, account.cookie)).status).toBe(200);
  });

  it('retries only failed optional images without replacing audio objects', async () => {
    const account = await register('image-retry@example.com');
    const studentId = await createStudent(account.cookie);
    await configureCoursewareAI(account.id);
    const coursewareId = await insertCourseware(studentId);
    await setImageSnapshot(coursewareId);
    const segmentId = await insertSegment(coursewareId, 'failed');
    const before = await env.DB.prepare('SELECT audio_object_key FROM courseware_segments WHERE id = ?').bind(segmentId).first<{ audio_object_key: string }>();
    const sent: unknown[] = [];
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockImplementation(async (message) => {
      sent.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
    const response = await api(`/api/coursewares/${coursewareId}/images/retry`, { method: 'POST' }, account.cookie);
    expect(response.status).toBe(200);
    const after = await env.DB.prepare('SELECT audio_object_key, image_status FROM courseware_segments WHERE id = ?').bind(segmentId).first<{ audio_object_key: string; image_status: string }>();
    expect(after?.audio_object_key).toBe(before?.audio_object_key);
    expect(after?.image_status).toBe('pending');
    expect(sent).toEqual([{ coursewareId }]);
  });

  it('queues an image retry from a historical snapshot after provider, endpoint, and model are disabled', async () => {
    const account = await register('image-retry-disabled-catalog@example.com');
    const studentId = await createStudent(account.cookie);
    await configureCoursewareAI(account.id);
    const coursewareId = await insertCourseware(studentId);
    await setImageSnapshot(coursewareId);
    await insertSegment(coursewareId, 'failed');
    const image = await env.DB.prepare(
      `SELECT p.id AS provider_id, e.id AS endpoint_id, m.id AS model_id
       FROM ai_models m JOIN ai_provider_endpoints e ON e.id = m.endpoint_id
       JOIN ai_providers p ON p.id = e.provider_id WHERE m.capability = 'image_generation' LIMIT 1`,
    ).first<{ provider_id: number; endpoint_id: number; model_id: number }>();
    await env.DB.batch([
      env.DB.prepare('UPDATE ai_providers SET enabled = 0 WHERE id = ?').bind(image?.provider_id),
      env.DB.prepare('UPDATE ai_provider_endpoints SET enabled = 0 WHERE id = ?').bind(image?.endpoint_id),
      env.DB.prepare('UPDATE ai_models SET enabled = 0 WHERE id = ?').bind(image?.model_id),
    ]);
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
    try {
      expect((await api(`/api/coursewares/${coursewareId}/images/retry`, { method: 'POST' }, account.cookie)).status).toBe(200);
      await env.DB.prepare("UPDATE app_settings SET value = '1' WHERE key = 'courseware_enabled'").run();
      expect((await api(`/api/students/${studentId}/coursewares`, {
        method: 'POST', body: JSON.stringify({ subject: 'math', topic: '新课件', learningGoal: '新目标', includeImages: false }),
      }, account.cookie)).status).toBe(400);
    } finally {
      await env.DB.batch([
        env.DB.prepare('UPDATE ai_providers SET enabled = 1 WHERE id = ?').bind(image?.provider_id),
        env.DB.prepare('UPDATE ai_provider_endpoints SET enabled = 1 WHERE id = ?').bind(image?.endpoint_id),
        env.DB.prepare('UPDATE ai_models SET enabled = 1 WHERE id = ?').bind(image?.model_id),
      ]);
      vi.restoreAllMocks();
    }
  });

  it('rejects image retry when a malformed historical snapshot points at a non-image endpoint', async () => {
    const account = await register('image-retry-wrong-capability@example.com');
    const studentId = await createStudent(account.cookie);
    await configureCoursewareAI(account.id);
    const coursewareId = await insertCourseware(studentId);
    const text = await env.DB.prepare(
      `SELECT p.id AS provider_id, e.id AS endpoint_id
       FROM ai_provider_endpoints e JOIN ai_providers p ON p.id = e.provider_id
       WHERE e.capability = 'structured_text' LIMIT 1`,
    ).first<{ provider_id: number; endpoint_id: number }>();
    await env.DB.prepare('UPDATE coursewares SET model_snapshot_json = ? WHERE id = ?').bind(
      JSON.stringify({ image: { providerId: text?.provider_id, endpointId: text?.endpoint_id } }),
      coursewareId,
    ).run();
    await insertSegment(coursewareId, 'failed');

    expect((await api(`/api/coursewares/${coursewareId}/images/retry`, { method: 'POST' }, account.cookie)).status).toBe(409);
    const detail = await api(`/api/coursewares/${coursewareId}`, {}, account.cookie);
    expect((await json<{ imageRetryAvailable: boolean }>(detail)).data?.imageRetryAvailable).toBe(false);
  });

  it('allows only one concurrent image retry claim and one queue message', async () => {
    const account = await register('image-cas@example.com');
    const studentId = await createStudent(account.cookie);
    await configureCoursewareAI(account.id);
    const coursewareId = await insertCourseware(studentId);
    await setImageSnapshot(coursewareId);
    await insertSegment(coursewareId, 'failed');
    const sent: unknown[] = [];
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockImplementation(async (message) => {
      sent.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
    const responses = await Promise.all([
      api(`/api/coursewares/${coursewareId}/images/retry`, { method: 'POST' }, account.cookie),
      api(`/api/coursewares/${coursewareId}/images/retry`, { method: 'POST' }, account.cookie),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(sent).toEqual([{ coursewareId }]);
  });

  it('reclaims an expired image enqueue after the API crashes before send', async () => {
    const account = await register('image-expired-enqueue@example.com');
    const studentId = await createStudent(account.cookie);
    await configureCoursewareAI(account.id);
    const coursewareId = await insertCourseware(studentId);
    await setImageSnapshot(coursewareId);
    await insertSegment(coursewareId, 'failed');
    const repository = createCoursewareRepository(env.DB);
    expect(await repository.claimImageRetry(account.id, coursewareId, 'image-old')).toBe(true);
    await env.DB.prepare(
      "UPDATE coursewares SET enqueue_expires_at = datetime('now', '-1 minute') WHERE id = ?",
    ).bind(coursewareId).run();
    const sent: unknown[] = [];
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockImplementation(async (message) => {
      sent.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
    expect((await api(`/api/coursewares/${coursewareId}/images/retry`, { method: 'POST' }, account.cookie)).status).toBe(200);
    expect(sent).toEqual([{ coursewareId }]);
  });

  it('rolls back only the failed image retry attempt and allows a later attempt', async () => {
    const account = await register('image-queue-fail@example.com');
    const studentId = await createStudent(account.cookie);
    await configureCoursewareAI(account.id);
    const coursewareId = await insertCourseware(studentId);
    await setImageSnapshot(coursewareId);
    const segmentId = await insertSegment(coursewareId, 'failed');
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockRejectedValueOnce(new Error('test queue failure'));
    expect((await api(`/api/coursewares/${coursewareId}/images/retry`, { method: 'POST' }, account.cookie)).status).toBe(503);
    const rolledBack = await env.DB.prepare(
      `SELECT c.status, c.generation_stage, c.lease_token, cs.image_status, cs.image_request_id
       FROM coursewares c JOIN courseware_segments cs ON cs.courseware_id = c.id
       WHERE c.id = ? AND cs.id = ?`,
    ).bind(coursewareId, segmentId).first<{
      status: string; generation_stage: string; lease_token: string | null;
      image_status: string; image_request_id: string;
    }>();
    expect(rolledBack).toEqual({
      status: 'ready', generation_stage: 'ready', lease_token: null,
      image_status: 'failed', image_request_id: '',
    });
    vi.restoreAllMocks();
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    expect((await api(`/api/coursewares/${coursewareId}/images/retry`, { method: 'POST' }, account.cookie)).status).toBe(200);
  });

  it('does not let retry queue failure overwrite a concurrent deleting state', async () => {
    const account = await register('retry-delete-race@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId, 'failed', 'speech');
    const segmentId = await insertSegment(coursewareId);
    await env.DB.prepare("UPDATE courseware_segments SET audio_status = 'failed' WHERE id = ?")
      .bind(segmentId).run();
    const key = `courseware/${account.id}/${studentId}/${coursewareId}/audio/stale.mp3`;
    await env.COURSEWARE_MEDIA.put(key, 'stale');
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockImplementationOnce(async () => {
      vi.spyOn(env.COURSEWARE_MEDIA, 'delete').mockRejectedValueOnce(new Error('test storage failure'));
      const deleting = await api(`/api/coursewares/${coursewareId}`, { method: 'DELETE' }, account.cookie);
      expect(deleting.status).toBe(503);
      throw new Error('test queue failure');
    });
    const response = await api(`/api/coursewares/${coursewareId}/retry`, { method: 'POST' }, account.cookie);
    expect(response.status).toBe(503);
    const row = await env.DB.prepare('SELECT status FROM coursewares WHERE id = ?')
      .bind(coursewareId).first<{ status: string }>();
    expect(row?.status).toBe('deleting');
  });

  it('allows only one concurrent full retry claim and one queue message', async () => {
    const account = await register('full-retry-cas@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId, 'failed', 'speech');
    const segmentId = await insertSegment(coursewareId);
    await env.DB.prepare("UPDATE courseware_segments SET audio_status = 'failed' WHERE id = ?")
      .bind(segmentId).run();
    const sent: unknown[] = [];
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockImplementation(async (message) => {
      sent.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
    const responses = await Promise.all([
      api(`/api/coursewares/${coursewareId}/retry`, { method: 'POST' }, account.cookie),
      api(`/api/coursewares/${coursewareId}/retry`, { method: 'POST' }, account.cookie),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(sent).toEqual([{ coursewareId }]);
  });

  it('restores a retryable stage after queue failure and permits a later retry', async () => {
    const account = await register('full-retry-queue@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId, 'failed', 'speech');
    const segmentId = await insertSegment(coursewareId);
    await env.DB.prepare("UPDATE courseware_segments SET audio_status = 'failed' WHERE id = ?")
      .bind(segmentId).run();
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockRejectedValueOnce(new Error('test queue failure'));
    expect((await api(`/api/coursewares/${coursewareId}/retry`, { method: 'POST' }, account.cookie)).status).toBe(503);
    const failed = await env.DB.prepare(
      'SELECT status, generation_stage, retryable, lease_token FROM coursewares WHERE id = ?',
    ).bind(coursewareId).first<{
      status: string; generation_stage: string; retryable: number; lease_token: string | null;
    }>();
    expect(failed).toEqual({ status: 'failed', generation_stage: 'speech', retryable: 1, lease_token: null });
    vi.restoreAllMocks();
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    expect((await api(`/api/coursewares/${coursewareId}/retry`, { method: 'POST' }, account.cookie)).status).toBe(200);
  });

  it('resumes full retry at scripting, speech, or images without resetting ready artifacts', async () => {
    const account = await register('retry-stage@example.com');
    const studentId = await createStudent(account.cookie);
    const sent: unknown[] = [];
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockImplementation(async (message) => {
      sent.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });

    const scriptingId = await insertCourseware(studentId, 'failed', 'scripting');
    const speechId = await insertCourseware(studentId, 'failed', 'speech');
    await env.DB.prepare('UPDATE coursewares SET progress_percent = 47 WHERE id = ?').bind(speechId).run();
    const speechReadySegment = await insertSegment(speechId);
    const speechFailedSegment = await env.DB.prepare(
      `INSERT INTO courseware_segments
       (courseware_id, position, segment_key, kind, speaker, title, display_markdown, speech_text,
        audio_status, audio_object_key, audio_content_type, audio_retry_count)
       VALUES (?, 1, 'speech-failed', 'teacher_explanation', 'teacher', '讲解', '正文', '正文',
         'failed', ?, 'audio/mpeg', 3) RETURNING id`,
    ).bind(speechId, `courseware/fixed/${speechId}/failed.mp3`).first<{ id: number }>();
    const imagesId = await insertCourseware(studentId, 'failed', 'images');
    await env.DB.prepare('UPDATE coursewares SET progress_percent = 88 WHERE id = ?').bind(imagesId).run();
    const imageReadySegment = await insertSegment(imagesId, 'ready');
    const imageFailedSegment = await env.DB.prepare(
      `INSERT INTO courseware_segments
       (courseware_id, position, segment_key, kind, speaker, title, display_markdown, speech_text,
        audio_status, audio_object_key, audio_content_type, image_status, image_object_key, image_content_type)
       VALUES (?, 1, 'image-failed', 'teacher_explanation', 'teacher', '讲解', '正文', '正文',
         'ready', ?, 'audio/mpeg', 'failed', ?, 'image/png') RETURNING id`,
    ).bind(imagesId, `courseware/fixed/${imagesId}/audio.mp3`, `courseware/fixed/${imagesId}/image.png`)
      .first<{ id: number }>();

    for (const id of [scriptingId, speechId, imagesId]) {
      expect((await api(`/api/coursewares/${id}/retry`, { method: 'POST' }, account.cookie)).status).toBe(200);
    }
    const stages = await env.DB.prepare(
      'SELECT id, status, generation_stage, progress_percent FROM coursewares WHERE id IN (?, ?, ?) ORDER BY id',
    ).bind(scriptingId, speechId, imagesId).all<{
      id: number; status: string; generation_stage: string; progress_percent: number;
    }>();
    expect(stages.results.map((row) => row.status)).toEqual(['generating', 'generating', 'generating']);
    expect(stages.results.map((row) => row.generation_stage)).toEqual(['scripting', 'speech', 'images']);
    expect(stages.results.map((row) => row.progress_percent)).toEqual([0, 47, 88]);
    const readySpeech = await env.DB.prepare('SELECT audio_status, audio_object_key FROM courseware_segments WHERE id = ?')
      .bind(speechReadySegment).first<{ audio_status: string; audio_object_key: string }>();
    const failedSpeech = await env.DB.prepare('SELECT audio_status, audio_object_key FROM courseware_segments WHERE id = ?')
      .bind(speechFailedSegment?.id).first<{ audio_status: string; audio_object_key: string }>();
    expect(readySpeech?.audio_status).toBe('ready');
    expect(readySpeech?.audio_object_key).toContain('placeholder');
    expect(failedSpeech).toMatchObject({ audio_status: 'pending', audio_object_key: `courseware/fixed/${speechId}/failed.mp3` });
    const readyImage = await env.DB.prepare('SELECT image_status, image_object_key FROM courseware_segments WHERE id = ?')
      .bind(imageReadySegment).first<{ image_status: string; image_object_key: string }>();
    const failedImage = await env.DB.prepare('SELECT image_status, image_object_key FROM courseware_segments WHERE id = ?')
      .bind(imageFailedSegment?.id).first<{ image_status: string; image_object_key: string }>();
    expect(readyImage?.image_status).toBe('ready');
    expect(failedImage).toMatchObject({ image_status: 'pending', image_object_key: `courseware/fixed/${imagesId}/image.png` });
    expect(sent).toEqual([{ coursewareId: scriptingId }, { coursewareId: speechId }, { coursewareId: imagesId }]);
  });

  it('does not rerun scripting for a corrupt later-stage failure with no segments', async () => {
    const account = await register('retry-corrupt@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId, 'failed', 'speech');
    const sent: unknown[] = [];
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockImplementation(async (message) => {
      sent.push(message);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });
    expect((await api(`/api/coursewares/${coursewareId}/retry`, { method: 'POST' }, account.cookie)).status).toBe(409);
    expect(sent).toEqual([]);
  });

  it('resumes finalizing without resetting a failed optional image', async () => {
    const account = await register('retry-finalizing@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId, 'failed', 'finalizing');
    const segmentId = await insertSegment(coursewareId, 'failed');
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    expect((await api(`/api/coursewares/${coursewareId}/retry`, { method: 'POST' }, account.cookie)).status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT c.generation_stage, cs.image_status FROM coursewares c
       JOIN courseware_segments cs ON cs.courseware_id = c.id WHERE c.id = ? AND cs.id = ?`,
    ).bind(coursewareId, segmentId).first<{ generation_stage: string; image_status: string }>();
    expect(row).toEqual({ generation_stage: 'finalizing', image_status: 'failed' });
  });

  it('atomically resumes finalizing required speech failures and retains their object keys', async () => {
    const account = await register('retry-finalizing-speech@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId, 'failed', 'finalizing');
    const segmentId = await insertSegment(coursewareId, 'not_required');
    const mainKey = `courseware/retained/${coursewareId}/main.mp3`;
    const alternateKey = `courseware/retained/${coursewareId}/alternate.mp3`;
    await env.DB.prepare(
      `UPDATE courseware_segments SET audio_status = 'failed', audio_object_key = ?, audio_retry_count = 3,
         alternate_audio_status = 'generating', alternate_audio_object_key = ?,
         alternate_speech_text = '另一种讲法', alternate_audio_retry_count = 2 WHERE id = ?`,
    ).bind(mainKey, alternateKey, segmentId).run();
    vi.spyOn(env.COURSEWARE_QUEUE, 'send').mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    expect((await api(`/api/coursewares/${coursewareId}/retry`, { method: 'POST' }, account.cookie)).status).toBe(200);
    const state = await env.DB.prepare(
      `SELECT c.status, c.generation_stage, cs.audio_status, cs.audio_object_key,
              cs.alternate_audio_status, cs.alternate_audio_object_key
       FROM coursewares c JOIN courseware_segments cs ON cs.courseware_id = c.id
       WHERE c.id = ? AND cs.id = ?`,
    ).bind(coursewareId, segmentId).first<{
      status: string; generation_stage: string; audio_status: string; audio_object_key: string;
      alternate_audio_status: string; alternate_audio_object_key: string;
    }>();
    expect(state).toEqual({
      status: 'generating', generation_stage: 'speech',
      audio_status: 'pending', audio_object_key: mainKey,
      alternate_audio_status: 'pending', alternate_audio_object_key: alternateKey,
    });
  });

  it('marks a courseware deleting and removes its rows and objects', async () => {
    const account = await register('delete@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    const key = `courseware/${account.id}/${studentId}/${coursewareId}/audio/1.mp3`;
    await env.COURSEWARE_MEDIA.put(key, 'delete-me');
    const response = await api(`/api/coursewares/${coursewareId}`, { method: 'DELETE' }, account.cookie);
    expect(response.status).toBe(200);
    expect(await env.COURSEWARE_MEDIA.head(key)).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM coursewares WHERE id = ?').bind(coursewareId).first()).toBeNull();
  });

  it('deletes the owned student media prefix before cascading student rows', async () => {
    const account = await register('delete-student@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    const key = `courseware/${account.id}/${studentId}/${coursewareId}/audio/1.mp3`;
    await env.COURSEWARE_MEDIA.put(key, 'delete-me');
    const response = await api(`/api/students/${studentId}`, { method: 'DELETE' }, account.cookie);
    expect(response.status).toBe(200);
    expect(await env.COURSEWARE_MEDIA.head(key)).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM students WHERE id = ?').bind(studentId).first()).toBeNull();
  });

  it('keeps a student deletion tombstone when the final post-cascade sweep fails and resumes it', async () => {
    const account = await register('delete-student-final-sweep@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    const key = `courseware/${account.id}/${studentId}/${coursewareId}/audio/1.mp3`;
    await env.COURSEWARE_MEDIA.put(key, 'delete-me');
    const realList = env.COURSEWARE_MEDIA.list.bind(env.COURSEWARE_MEDIA);
    vi.spyOn(env.COURSEWARE_MEDIA, 'list')
      .mockImplementationOnce((options) => realList(options))
      .mockRejectedValueOnce(new Error('final sweep unavailable'));
    expect((await api(`/api/students/${studentId}`, { method: 'DELETE' }, account.cookie)).status).toBe(503);
    expect(await env.DB.prepare('SELECT id FROM students WHERE id = ?').bind(studentId).first()).toBeNull();
    expect(await env.DB.prepare(
      'SELECT student_id FROM courseware_student_tombstones WHERE user_id = ? AND student_id = ?',
    ).bind(account.id, studentId).first()).not.toBeNull();
    vi.restoreAllMocks();
    expect((await api(`/api/students/${studentId}`, { method: 'DELETE' }, account.cookie)).status).toBe(200);
    expect(await env.DB.prepare(
      'SELECT student_id FROM courseware_student_tombstones WHERE user_id = ? AND student_id = ?',
    ).bind(account.id, studentId).first()).toBeNull();
    expect(await env.COURSEWARE_MEDIA.head(key)).toBeNull();
  });

  it('drains media cleanup tombstones with a limit and retains failures for an idempotent retry', async () => {
    const keys = Array.from({ length: 12 }, (_, index) => `courseware/1/1/1/audio/${index + 1}.attempt-test.mp3`);
    for (const key of keys) {
      await env.COURSEWARE_MEDIA.put(key, 'stale');
      await env.DB.prepare(
        'INSERT INTO courseware_media_tombstones(object_key, retry_count) VALUES (?, 1)',
      ).bind(key).run();
    }
    const first = await drainCoursewareMediaTombstones(env, 10);
    expect(first).toEqual({ attempted: 10, deleted: 10, failed: 0 });
    expect(JSON.stringify(first)).not.toContain('courseware/');
    const remaining = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM courseware_media_tombstones',
    ).first<{ count: number }>();
    expect(remaining?.count).toBe(2);

    vi.spyOn(env.COURSEWARE_MEDIA, 'delete').mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await drainCoursewareMediaTombstones(env, 10)).toEqual({ attempted: 2, deleted: 1, failed: 1 });
    const retained = await env.DB.prepare(
      'SELECT retry_count FROM courseware_media_tombstones',
    ).first<{ retry_count: number }>();
    expect(retained?.retry_count).toBe(2);
    vi.restoreAllMocks();
    const duplicate = await Promise.all([
      drainCoursewareMediaTombstones(env, 10),
      drainCoursewareMediaTombstones(env, 10),
    ]);
    expect(duplicate.every((result) => !('objectKey' in result))).toBe(true);
    expect(await env.DB.prepare('SELECT object_key FROM courseware_media_tombstones').first()).toBeNull();
  });

  it('opportunistically drains media tombstones from an authenticated courseware request', async () => {
    const account = await register('drain-opportunity@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    const key = `courseware/${account.id}/${studentId}/${coursewareId}/audio/99.attempt-stale.mp3`;
    await env.COURSEWARE_MEDIA.put(key, 'stale');
    await env.DB.prepare(
      'INSERT INTO courseware_media_tombstones(object_key, retry_count) VALUES (?, 1)',
    ).bind(key).run();
    expect((await api(`/api/coursewares/${coursewareId}`, {}, account.cookie)).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await env.DB.prepare(
        'SELECT object_key FROM courseware_media_tombstones WHERE object_key = ?',
      ).bind(key).first()).toBeNull();
    });
    expect(await env.COURSEWARE_MEDIA.head(key)).toBeNull();
  });

  it('keeps deleting ownership rows after an R2 failure and resumes on repeated DELETE', async () => {
    const account = await register('delete-resume@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId, 'generating', 'speech');
    const key = `courseware/${account.id}/${studentId}/${coursewareId}/audio/1.mp3`;
    await env.COURSEWARE_MEDIA.put(key, 'delete-me');
    vi.spyOn(env.COURSEWARE_MEDIA, 'delete').mockRejectedValueOnce(new Error('test partial failure'));
    expect((await api(`/api/coursewares/${coursewareId}`, { method: 'DELETE' }, account.cookie)).status).toBe(503);
    const retained = await env.DB.prepare('SELECT status FROM coursewares WHERE id = ?')
      .bind(coursewareId).first<{ status: string }>();
    expect(retained?.status).toBe('deleting');
    vi.restoreAllMocks();
    expect((await api(`/api/coursewares/${coursewareId}`, { method: 'DELETE' }, account.cookie)).status).toBe(200);
    expect(await env.COURSEWARE_MEDIA.head(key)).toBeNull();
  });

  it('follows every R2 cursor and deletes each exact-prefix page in batches', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ objects: [{ key: 'courseware/1/2/3/a' }], truncated: true, cursor: 'next' })
      .mockResolvedValueOnce({ objects: [{ key: 'courseware/1/2/3/b' }], truncated: false });
    const remove = vi.fn().mockResolvedValue(undefined);
    await deleteCoursewareMedia({ list, delete: remove } as unknown as R2Bucket, {
      userId: 1, studentId: 2, coursewareId: 3,
    });
    expect(list).toHaveBeenNthCalledWith(1, { prefix: 'courseware/1/2/3/', cursor: undefined, limit: 1000 });
    expect(list).toHaveBeenNthCalledWith(2, { prefix: 'courseware/1/2/3/', cursor: 'next', limit: 1000 });
    expect(remove.mock.calls).toEqual([[['courseware/1/2/3/a']], [['courseware/1/2/3/b']]]);
  });

  it('resumes exact-prefix deletion after a later R2 page fails', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ objects: [{ key: 'courseware/1/2/3/a' }], truncated: true, cursor: 'next' })
      .mockResolvedValueOnce({ objects: [{ key: 'courseware/1/2/3/b' }], truncated: false })
      .mockResolvedValueOnce({ objects: [{ key: 'courseware/1/2/3/b' }], truncated: false });
    const remove = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('test second-page failure'))
      .mockResolvedValueOnce(undefined);
    const bucket = { list, delete: remove } as unknown as R2Bucket;
    await expect(deleteCoursewareMedia(bucket, { userId: 1, studentId: 2, coursewareId: 3 }))
      .rejects.toThrow('test second-page failure');
    await expect(deleteCoursewareMedia(bucket, { userId: 1, studentId: 2, coursewareId: 3 }))
      .resolves.toBeUndefined();
    expect(remove.mock.calls).toEqual([
      [['courseware/1/2/3/a']],
      [['courseware/1/2/3/b']],
      [['courseware/1/2/3/b']],
    ]);
  });
});
