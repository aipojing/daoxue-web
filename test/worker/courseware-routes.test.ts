import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoursewareModelPreference } from '../../src/shared/ai-catalog';
import { saveCredential } from '../../src/worker/ai-catalog/credentials';
import { saveUserModelPreferences } from '../../src/worker/ai-catalog/repository';
import { createCourseware } from '../../src/worker/courseware/service';

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

async function insertCourseware(studentId: number, status: 'ready' | 'failed' | 'queued' = 'ready') {
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
    status === 'ready' ? 'ready' : status === 'failed' ? 'failed' : 'queued',
    status === 'ready' ? 100 : 0,
    status === 'failed' ? 1 : 0,
    status === 'failed' ? 'provider_timeout' : '',
    status === 'failed' ? '服务暂时不可用' : '',
  ).first<{ id: number }>();
  if (!row) throw new Error('failed to insert courseware');
  return row.id;
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
      method: 'PATCH', body: JSON.stringify({ currentSegmentPosition: 0, currentTimeMs: 900, checkpointAnswers: { 'check-1': 1 } }),
    }, account.cookie);
    expect(response.status).toBe(200);
    const after = await env.DB.prepare('SELECT COUNT(*) AS count FROM knowledge_points').first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
    expect((await json<{ currentTimeMs: number }>(response)).data?.currentTimeMs).toBe(900);
  });

  it('serves owned audio with content type, accept-ranges, and a valid 206 range response', async () => {
    const account = await register('media@example.com');
    const studentId = await createStudent(account.cookie);
    const coursewareId = await insertCourseware(studentId);
    const segmentId = await insertSegment(coursewareId);
    const key = `courseware/${account.id}/${studentId}/${coursewareId}/audio/${segmentId}.mp3`;
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
    const imageEndpoint = await env.DB.prepare(
      `SELECT e.id AS endpoint_id, p.id AS provider_id FROM ai_provider_endpoints e
       JOIN ai_providers p ON p.id = e.provider_id WHERE e.capability = 'image_generation' LIMIT 1`,
    ).first<{ endpoint_id: number; provider_id: number }>();
    await env.DB.prepare('UPDATE coursewares SET model_snapshot_json = ? WHERE id = ?').bind(
      JSON.stringify({ image: { endpointId: imageEndpoint?.endpoint_id, providerId: imageEndpoint?.provider_id } }),
      coursewareId,
    ).run();
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
});
