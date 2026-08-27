import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoursewareScript, CoursewareScriptSegment } from '../../src/shared/courseware';
import { saveCredential } from '../../src/worker/ai-catalog/credentials';
import { recordCredentialHealthForRevision } from '../../src/worker/ai-catalog/repository';
import { ProviderCallError } from '../../src/worker/courseware/adapters/errors';
import { readMp3DurationMs } from '../../src/worker/courseware/audio-metadata';
import {
  advanceCourseware,
  type CoursewareGenerationDependencies,
} from '../../src/worker/courseware/generator';
import { createCoursewareQueueConsumer } from '../../src/worker/courseware/queue';
import { createCoursewareRepository } from '../../src/worker/courseware/repository';
import { resolveModelsForJob } from '../../src/worker/courseware/model-resolution';
import type { Env } from '../../src/worker/env';

class FakeBucket {
  readonly objects = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  readonly hiddenHeads = new Set<string>();
  readonly headFailures = new Map<string, number>();
  readonly deleteFailures = new Set<string>();
  putCalls = 0;

  async put(key: string, bytes: ArrayBuffer, options?: R2PutOptions) {
    this.putCalls += 1;
    const metadata = options?.httpMetadata;
    const contentType = metadata instanceof Headers ? metadata.get('content-type') ?? '' : metadata?.contentType ?? '';
    this.objects.set(key, { bytes: bytes.slice(0), contentType });
    return {} as R2Object;
  }

  async head(key: string) {
    const failures = this.headFailures.get(key) ?? 0;
    if (failures > 0) {
      this.headFailures.set(key, failures - 1);
      throw new Error('temporary head failure');
    }
    if (this.hiddenHeads.has(key)) return null;
    const object = this.objects.get(key);
    return object ? ({ key, size: object.bytes.byteLength } as R2Object) : null;
  }

  async delete(key: string | string[]) {
    for (const item of Array.isArray(key) ? key : [key]) {
      if (this.deleteFailures.has(item)) throw new Error('temporary delete failure');
      this.objects.delete(item);
    }
  }
}

function validMp3(frameCount = 2): ArrayBuffer {
  const frameLength = 417; // MPEG-1 Layer III, 128 kbps, 44.1 kHz
  const bytes = new Uint8Array(frameLength * frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    bytes.set([0xff, 0xfb, 0x90, 0x00], index * frameLength);
  }
  return bytes.buffer;
}

function mp3WithId3(version: 2 | 3 | 4, flags: number, footer = false): ArrayBuffer {
  const frames = new Uint8Array(validMp3());
  const bytes = new Uint8Array(10 + (footer ? 10 : 0) + frames.length);
  bytes.set([0x49, 0x44, 0x33, version, 0, flags, 0, 0, 0, 0]);
  if (footer) bytes.set([0x33, 0x44, 0x49, version, 0, flags, 0, 0, 0, 0], 10);
  bytes.set(frames, footer ? 20 : 10);
  return bytes.buffer;
}

const segment = (
  segmentKey: string,
  kind: CoursewareScriptSegment['kind'],
  speaker: CoursewareScriptSegment['speaker'],
  extra: Partial<CoursewareScriptSegment> = {},
): CoursewareScriptSegment => ({
  segmentKey,
  kind,
  speaker,
  title: `${segmentKey}标题`,
  displayMarkdown: `${segmentKey}正文`,
  speechText: `${segmentKey}讲解`,
  visual: { mode: 'none' },
  ...extra,
});

const script: CoursewareScript = {
  schemaVersion: 1,
  title: '函数互动课',
  subject: '数学',
  grade: '八年级',
  topic: '函数',
  learningObjectives: ['理解函数'],
  estimatedMinutes: 8,
  segments: [
    segment('intro', 'teacher_intro', 'teacher'),
    segment('explain', 'teacher_explanation', 'teacher', {
      alternateExplanation: { displayMarkdown: '换一种解释', speechText: '换一种讲法' },
      visual: { mode: 'generated_image', prompt: '函数坐标图', altText: '函数坐标示意图' },
    }),
    segment('question', 'student_question', 'student'),
    segment('misconception', 'student_misconception', 'student'),
    segment('reframe', 'teacher_reframe', 'teacher', {
      alternateExplanation: { displayMarkdown: '重新理解', speechText: '重新讲解' },
    }),
    segment('checkpoint', 'checkpoint', 'system', {
      checkpoint: {
        prompt: '哪个是函数', options: ['甲', '乙'], correctAnswer: '甲', explanation: '甲符合定义',
      },
    }),
    segment('summary', 'summary', 'teacher'),
  ],
};

const teacherFirstScript: CoursewareScript = {
  ...script,
  segments: [
    segment('intro', 'teacher_intro', 'teacher'),
    segment('explain-a', 'teacher_explanation', 'teacher', {
      alternateExplanation: { displayMarkdown: '解释甲', speechText: '讲法甲' },
    }),
    segment('explain-b', 'teacher_explanation', 'teacher', {
      alternateExplanation: { displayMarkdown: '解释乙', speechText: '讲法乙' },
    }),
    segment('question', 'student_question', 'student'),
    segment('misconception', 'student_misconception', 'student'),
    segment('reframe', 'teacher_reframe', 'teacher', {
      alternateExplanation: { displayMarkdown: '重新理解', speechText: '重新讲解' },
    }),
    segment('checkpoint', 'checkpoint', 'system', {
      checkpoint: {
        prompt: '哪个是函数', options: ['甲', '乙'], correctAnswer: '甲', explanation: '甲符合定义',
      },
    }),
    segment('summary', 'summary', 'teacher'),
  ],
};

interface Fixture {
  appEnv: Env;
  bucket: FakeBucket;
  coursewareId: number;
  userId: number;
}

async function createFixture(options: { includeImages?: boolean; stage?: string; lease?: 'none' | 'fresh' | 'expired' } = {}): Promise<Fixture> {
  const user = await env.DB.prepare(
    "INSERT INTO users(email, password_hash) VALUES (?, 'hash') RETURNING id",
  ).bind(`queue-${crypto.randomUUID()}@example.com`).first<{ id: number }>();
  const student = await env.DB.prepare(
    "INSERT INTO students(user_id, name, grade) VALUES (?, '小明', '八年级') RETURNING id",
  ).bind(user?.id).first<{ id: number }>();
  if (!user || !student) throw new Error('fixture unavailable');

  const selections = await env.DB.prepare(
    `SELECT p.id AS provider_id, p.slug, e.id AS endpoint_id, e.adapter_type, e.base_url,
            e.capability, e.config_json, m.model_id, m.config_json AS model_config_json
     FROM ai_providers p JOIN ai_provider_endpoints e ON e.provider_id = p.id
     JOIN ai_models m ON m.endpoint_id = e.id
     WHERE p.slug = 'bailian-token-plan' AND p.enabled = 1 AND e.enabled = 1 AND m.enabled = 1
     ORDER BY e.id, m.id`,
  ).all<{
    provider_id: number; slug: string; endpoint_id: number; adapter_type: string; base_url: string;
    capability: string; config_json: string; model_id: string; model_config_json: string;
  }>();
  const byCapability = (capability: string, voiceId = '') => {
    const row = selections.results.find((candidate) => candidate.capability === capability);
    if (!row) throw new Error(`missing ${capability}`);
    return {
      providerId: row.provider_id,
      providerSlug: row.slug,
      endpointId: row.endpoint_id,
      adapterType: row.adapter_type,
      adapterVersion: 'v1',
      baseUrl: row.base_url,
      capability: row.capability,
      modelId: row.model_id,
      voiceId,
      endpointConfig: JSON.parse(row.config_json),
      modelConfig: JSON.parse(row.model_config_json),
      params: {},
    };
  };
  const text = byCapability('structured_text');
  const snapshot = {
    schemaVersion: 1,
    promptVersion: 'courseware-v1',
    includeImages: options.includeImages ?? true,
    text,
    teacherSpeech: byCapability('speech_synthesis', 'longanlingxin'),
    studentSpeech: byCapability('speech_synthesis', 'longanlufeng'),
    image: options.includeImages === false ? null : byCapability('image_generation'),
  };
  await saveCredential(env.DB, env, user.id, text.providerId, 'fake-key-must-never-leak');
  const stage = options.stage ?? 'queued';
  const status = stage === 'queued' ? 'queued' : stage === 'ready' ? 'ready' : 'generating';
  const leaseToken = options.lease === 'fresh' || options.lease === 'expired' ? 'other-worker' : null;
  const leaseExpiry = options.lease === 'fresh' ? "+5 minutes" : '-5 minutes';
  const courseware = await env.DB.prepare(
    `INSERT INTO coursewares
     (student_id, subject, grade, topic, learning_goal, source_text, title, status,
      generation_stage, model_snapshot_json, lease_token, lease_expires_at)
     VALUES (?, '数学', '八年级', '函数', '理解函数', '已有学习材料', '函数', ?, ?, ?, ?, datetime('now', ?))
     RETURNING id`,
  ).bind(student.id, status, stage, JSON.stringify(snapshot), leaseToken, leaseExpiry).first<{ id: number }>();
  if (!courseware) throw new Error('courseware fixture unavailable');
  const bucket = new FakeBucket();
  return {
    coursewareId: courseware.id,
    userId: user.id,
    bucket,
    appEnv: { ...env, COURSEWARE_MEDIA: bucket as unknown as R2Bucket } as unknown as Env,
  };
}

function dependencies(overrides: Partial<CoursewareGenerationDependencies> = {}): CoursewareGenerationDependencies {
  return {
    now: () => new Date(),
    generateText: vi.fn(async () => ({
      jsonText: JSON.stringify(script), requestId: 'text-request', inputTokens: 100, outputTokens: 200,
    })),
    synthesizeSpeech: vi.fn(async () => ({
      bytes: validMp3(), contentType: 'audio/mpeg', requestId: crypto.randomUUID(),
    })),
    generateImage: vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/png', requestId: 'image-request',
    })),
    recordCredentialHealth: (appEnv, userId, providerId, revision, status) =>
      recordCredentialHealthForRevision(appEnv.DB, userId, providerId, revision, status),
    ...overrides,
  };
}

async function row(coursewareId: number) {
  return env.DB.prepare(
    'SELECT status, generation_stage, progress_percent, warnings_json, error_code, retryable FROM coursewares WHERE id = ?',
  ).bind(coursewareId).first<{
    status: string; generation_stage: string; progress_percent: number; warnings_json: string;
    error_code: string; retryable: number;
  }>();
}

async function advanceUntilDone(fixture: Fixture, deps: CoursewareGenerationDependencies, maximum = 12) {
  const results: string[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const result = await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    results.push(result);
    if (result !== 'reenqueue') break;
  }
  return results;
}

async function splitStudentSpeechProvider(fixture: Fixture): Promise<number> {
  const stored = await env.DB.prepare('SELECT model_snapshot_json FROM coursewares WHERE id = ?')
    .bind(fixture.coursewareId).first<{ model_snapshot_json: string }>();
  const snapshot = JSON.parse(stored?.model_snapshot_json ?? '{}') as Record<string, any>;
  const student = snapshot.studentSpeech as Record<string, any>;
  const provider = await env.DB.prepare(
    `INSERT INTO ai_providers(slug, display_name) VALUES (?, 'Student TTS Test') RETURNING id`,
  ).bind(`student-tts-${crypto.randomUUID()}`).first<{ id: number }>();
  const endpoint = await env.DB.prepare(
    `INSERT INTO ai_provider_endpoints(provider_id, capability, adapter_type, base_url, config_json)
     VALUES (?, 'speech_synthesis', 'token_plan_tts', ?, ?) RETURNING id`,
  ).bind(provider?.id, student.baseUrl, JSON.stringify(student.endpointConfig)).first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO ai_models(endpoint_id, capability, model_id, display_name, config_json, voices_json)
     VALUES (?, 'speech_synthesis', ?, 'Student TTS Model', ?, ?)`,
  ).bind(endpoint?.id, student.modelId, JSON.stringify(student.modelConfig), JSON.stringify([
    { id: student.voiceId, name: 'Student Voice', recommendedRole: 'student' },
  ])).run();
  if (!provider || !endpoint) throw new Error('student provider fixture unavailable');
  await saveCredential(env.DB, env, fixture.userId, provider.id, 'student-key-old');
  snapshot.studentSpeech = {
    ...student,
    providerId: provider.id,
    providerSlug: `student-provider-${provider.id}`,
    endpointId: endpoint.id,
  };
  await env.DB.prepare('UPDATE coursewares SET model_snapshot_json = ? WHERE id = ?')
    .bind(JSON.stringify(snapshot), fixture.coursewareId).run();
  return provider.id;
}

async function firstReadyArtifact(coursewareId: number, variant: 'audio' | 'image' = 'audio') {
  const prefix = variant === 'audio' ? 'audio' : 'image';
  return env.DB.prepare(
    `SELECT id, ${prefix}_object_key AS object_key, ${prefix}_retry_count AS retry_count
     FROM courseware_segments WHERE courseware_id = ? AND ${prefix}_status = 'ready'
     ORDER BY position LIMIT 1`,
  ).bind(coursewareId).first<{ id: number; object_key: string; retry_count: number }>();
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM invite_codes').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('MP3 duration reader', () => {
  it('skips ID3v2 and sums validated MPEG frame durations', () => {
    const frames = new Uint8Array(validMp3());
    const bytes = new Uint8Array(10 + frames.length);
    bytes.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
    bytes.set(frames, 10);
    expect(readMp3DurationMs(bytes.buffer)).toBe(52);
    try {
      readMp3DurationMs(new Uint8Array([0xff, 0xfb, 0x90]).buffer);
      throw new Error('expected invalid MP3 rejection');
    } catch (error) {
      expect(error).toMatchObject({ errorCode: 'invalid_model_output' });
    }
  });

  it('enforces version-specific ID3v2 flag masks and validates v2.4 footer ownership', () => {
    for (const bytes of [
      mp3WithId3(2, 0x20),
      mp3WithId3(3, 0x10, true),
      mp3WithId3(4, 0x08),
    ]) {
      expect(() => readMp3DurationMs(bytes)).toThrow();
    }
    expect(readMp3DurationMs(mp3WithId3(4, 0x10, true))).toBe(52);
  });
});

describe('courseware queue processor', () => {
  it('generates and strictly validates the script before rendering any artifact', async () => {
    const fixture = await createFixture();
    const speech = vi.fn();
    const result = await advanceCourseware(fixture.appEnv, fixture.coursewareId, dependencies({ synthesizeSpeech: speech }));
    expect(result).toBe('reenqueue');
    expect(speech).not.toHaveBeenCalled();
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'generating', generation_stage: 'speech' });
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM courseware_segments WHERE courseware_id = ?')
      .bind(fixture.coursewareId).first<{ count: number }>();
    expect(count?.count).toBe(7);
  });

  it('rejects malformed script output safely before creating artifacts', async () => {
    const fixture = await createFixture();
    const speech = vi.fn();
    const deps = dependencies({
      generateText: vi.fn(async () => ({
        jsonText: '{"schemaVersion":1,"segments":[]}', requestId: 'bad', inputTokens: 1, outputTokens: 1,
      })),
      synthesizeSpeech: speech,
    });
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('done');
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'failed', error_code: 'invalid_model_output' });
    expect(speech).not.toHaveBeenCalled();
    expect(fixture.bucket.objects.size).toBe(0);
  });

  it('bounds transient text retries at three persisted attempts', async () => {
    const fixture = await createFixture();
    const text = vi.fn(async () => { throw new ProviderCallError('provider_timeout', 504); });
    const deps = dependencies({ generateText: text });
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('done');
    expect(text).toHaveBeenCalledTimes(3);
    expect(await row(fixture.coursewareId)).toMatchObject({
      status: 'failed', generation_stage: 'scripting', error_code: 'provider_timeout', retryable: 1,
    });
  });

  it('renders at most five pending artifacts per advance and includes main, alternate and system audio', async () => {
    const fixture = await createFixture();
    const speech = vi.fn(async () => ({ bytes: validMp3(), contentType: 'audio/mpeg', requestId: crypto.randomUUID() }));
    const deps = dependencies({ synthesizeSpeech: speech });
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    expect(speech).toHaveBeenCalledTimes(5);
    const progress = await row(fixture.coursewareId);
    expect(progress?.progress_percent).toBeGreaterThan(10);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    expect(speech).toHaveBeenCalledTimes(9);
    const calls = (speech.mock.calls as unknown as Array<[unknown, { voiceId: string; text: string }]>).map((call) => call[1]);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ voiceId: 'longanlufeng', text: 'question讲解' }),
      expect.objectContaining({ voiceId: 'longanlingxin', text: '换一种讲法' }),
      expect.objectContaining({ voiceId: 'longanlingxin', text: 'checkpoint讲解' }),
    ]));
  });

  it('stores attempt-scoped audio with frame-derived duration and does not duplicate it', async () => {
    const fixture = await createFixture({ includeImages: false });
    const deps = dependencies();
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const artifact = await env.DB.prepare(
      `SELECT audio_status, audio_object_key, audio_duration_ms FROM courseware_segments
       WHERE courseware_id = ? ORDER BY position LIMIT 1`,
    ).bind(fixture.coursewareId).first<{ audio_status: string; audio_object_key: string; audio_duration_ms: number }>();
    expect(artifact?.audio_status).toBe('ready');
    expect(artifact?.audio_duration_ms).toBe(52);
    expect(artifact?.audio_object_key).toContain('.attempt-');
    const callCount = vi.mocked(deps.synthesizeSpeech).mock.calls.length;
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    expect(vi.mocked(deps.synthesizeSpeech).mock.calls.length).toBeGreaterThan(callCount);
    expect(vi.mocked(deps.synthesizeSpeech).mock.calls.filter((call) => call[1].text === 'intro讲解')).toHaveLength(1);
  });

  it('regenerates only a ready audio artifact whose R2 object disappeared', async () => {
    const fixture = await createFixture({ includeImages: false });
    const deps = dependencies();
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const artifact = await env.DB.prepare(
      `SELECT audio_object_key FROM courseware_segments WHERE courseware_id = ? ORDER BY position LIMIT 1`,
    ).bind(fixture.coursewareId).first<{ audio_object_key: string }>();
    fixture.bucket.objects.delete(artifact?.audio_object_key ?? '');
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const introCalls = vi.mocked(deps.synthesizeSpeech).mock.calls.filter((call) => call[1].text === 'intro讲解');
    expect(introCalls).toHaveLength(2);
    const allOtherTexts = vi.mocked(deps.synthesizeSpeech).mock.calls.map((call) => call[1].text).filter((text) => text !== 'intro讲解');
    expect(new Set(allOtherTexts).size).toBe(allOtherTexts.length);
  });

  it('keeps image failure non-blocking, persists a warning and becomes ready', async () => {
    const fixture = await createFixture();
    const deps = dependencies({
      generateImage: vi.fn(async () => { throw new ProviderCallError('invalid_model_output', 200); }),
    });
    await advanceUntilDone(fixture, deps);
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'ready', generation_stage: 'ready', progress_percent: 100 });
    expect(JSON.parse((await row(fixture.coursewareId))?.warnings_json ?? '[]')).toContain('部分配图生成失败，不影响语音课件播放');
  });

  it('continues the snapshotted image generation when its endpoint is administratively disabled', async () => {
    const fixture = await createFixture();
    const image = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/png', requestId: 'disabled-endpoint-image',
    }));
    const deps = dependencies({ generateImage: image });
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const snapshotRow = await env.DB.prepare('SELECT model_snapshot_json FROM coursewares WHERE id = ?')
      .bind(fixture.coursewareId).first<{ model_snapshot_json: string }>();
    const endpointId = (JSON.parse(snapshotRow?.model_snapshot_json ?? '{}') as { image: { endpointId: number } }).image.endpointId;
    await env.DB.prepare('UPDATE ai_provider_endpoints SET enabled = 0 WHERE id = ?').bind(endpointId).run();
    try {
      await advanceUntilDone(fixture, deps);
      expect(image).toHaveBeenCalledTimes(1);
      expect(await row(fixture.coursewareId)).toMatchObject({ status: 'ready', generation_stage: 'ready' });
      expect(JSON.parse((await row(fixture.coursewareId))?.warnings_json ?? '[]')).not.toContain('部分配图生成失败，不影响语音课件播放');
    } finally {
      await env.DB.prepare('UPDATE ai_provider_endpoints SET enabled = 1 WHERE id = ?').bind(endpointId).run();
    }
  });

  it('resolves required and image snapshot calls after catalog items are disabled, but rejects a changed provider relation', async () => {
    const fixture = await createFixture();
    const repository = createCoursewareRepository(fixture.appEnv.DB);
    const detail = await repository.getForWorker(fixture.coursewareId);
    if (!detail) throw new Error('missing courseware');
    const snapshot = JSON.parse(detail.model_snapshot_json) as {
      text: { providerId: number; endpointId: number };
      teacherSpeech: { endpointId: number };
      studentSpeech: { endpointId: number };
      image: { endpointId: number };
    };
    const modelIds = await env.DB.prepare(
      'SELECT id FROM ai_models WHERE endpoint_id IN (?, ?, ?)',
    ).bind(snapshot.text.endpointId, snapshot.teacherSpeech.endpointId, snapshot.image.endpointId)
      .all<{ id: number }>();
    await env.DB.batch([
      env.DB.prepare('UPDATE ai_providers SET enabled = 0 WHERE id = ?').bind(snapshot.text.providerId),
      env.DB.prepare('UPDATE ai_provider_endpoints SET enabled = 0 WHERE id IN (?, ?, ?)')
        .bind(snapshot.text.endpointId, snapshot.teacherSpeech.endpointId, snapshot.image.endpointId),
      ...modelIds.results.map((model) => env.DB.prepare('UPDATE ai_models SET enabled = 0 WHERE id = ?').bind(model.id)),
    ]);
    try {
      await expect(resolveModelsForJob(fixture.appEnv, detail)).resolves.toMatchObject({
        text: { endpointId: snapshot.text.endpointId },
        teacherSpeech: { endpointId: snapshot.teacherSpeech.endpointId },
        studentSpeech: { endpointId: snapshot.studentSpeech.endpointId },
        image: { endpointId: snapshot.image.endpointId },
      });
      const replacement = await env.DB.prepare(
        "INSERT INTO ai_providers (slug, display_name) VALUES ('snapshot-relation-replacement', 'Replacement') RETURNING id",
      ).first<{ id: number }>();
      await env.DB.prepare('UPDATE ai_provider_endpoints SET provider_id = ? WHERE id = ?')
        .bind(replacement?.id, snapshot.text.endpointId).run();
      await expect(resolveModelsForJob(fixture.appEnv, detail)).rejects.toMatchObject({ errorCode: 'model_unavailable' });
    } finally {
      await env.DB.prepare('UPDATE ai_provider_endpoints SET provider_id = ? WHERE id = ?')
        .bind(snapshot.text.providerId, snapshot.text.endpointId).run();
      await env.DB.prepare('UPDATE ai_providers SET enabled = 1 WHERE id = ?').bind(snapshot.text.providerId).run();
      await env.DB.prepare('UPDATE ai_provider_endpoints SET enabled = 1 WHERE id IN (?, ?, ?)')
        .bind(snapshot.text.endpointId, snapshot.teacherSpeech.endpointId, snapshot.image.endpointId).run();
      await env.DB.batch(modelIds.results.map((model) =>
        env.DB.prepare('UPDATE ai_models SET enabled = 1 WHERE id = ?').bind(model.id)));
    }
  });

  it('retries only a transiently failed image and keeps required audio playable', async () => {
    const fixture = await createFixture();
    let imageCalls = 0;
    const image = vi.fn(async () => {
      imageCalls += 1;
      if (imageCalls === 1) throw new ProviderCallError('provider_timeout', 504);
      return { bytes: new Uint8Array([1]).buffer, contentType: 'image/png', requestId: 'ok' };
    });
    const deps = dependencies({ generateImage: image });
    await advanceUntilDone(fixture, deps);
    expect(image).toHaveBeenCalledTimes(2);
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'ready' });
    const failedAudio = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM courseware_segments WHERE courseware_id = ?
       AND (audio_status != 'ready' OR alternate_audio_status NOT IN ('ready', 'not_required'))`,
    ).bind(fixture.coursewareId).first<{ count: number }>();
    expect(failedAudio?.count).toBe(0);
  });

  it('persists required speech failure safely and updates credential health without leaking the key', async () => {
    const fixture = await createFixture();
    const deps = dependencies({
      synthesizeSpeech: vi.fn(async () => { throw new ProviderCallError('invalid_credential', 401); }),
    });
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const failed = await row(fixture.coursewareId);
    expect(failed).toMatchObject({ status: 'failed', generation_stage: 'speech', error_code: 'invalid_credential', retryable: 0 });
    expect(JSON.stringify(failed)).not.toContain('fake-key-must-never-leak');
    const health = await env.DB.prepare(
      'SELECT health_status FROM user_ai_credentials WHERE user_id = ?',
    ).bind(fixture.userId).first<{ health_status: string }>();
    expect(health?.health_status).toBe('invalid');
  });

  it('continues after credential-health writes fail instead of discarding paid artifacts', async () => {
    const fixture = await createFixture({ includeImages: false });
    const healthWrite = vi.fn(async () => { throw new Error('health database unavailable'); });
    const deps = dependencies({ recordCredentialHealth: healthWrite } as Partial<CoursewareGenerationDependencies>);
    await advanceUntilDone(fixture, deps);
    expect(healthWrite).toHaveBeenCalled();
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'ready', generation_stage: 'ready' });
    expect(fixture.bucket.objects.size).toBe(9);
  });

  it('does not let a late provider failure poison a concurrently rotated credential', async () => {
    const fixture = await createFixture();
    let rotated = false;
    const deps = dependencies({
      synthesizeSpeech: vi.fn(async () => {
        if (!rotated) {
          rotated = true;
          const snapshot = await env.DB.prepare('SELECT model_snapshot_json FROM coursewares WHERE id = ?')
            .bind(fixture.coursewareId).first<{ model_snapshot_json: string }>();
          const providerId = (JSON.parse(snapshot?.model_snapshot_json ?? '{}') as any).teacherSpeech.providerId as number;
          await saveCredential(env.DB, env, fixture.userId, providerId, 'rotated-new-key');
        }
        throw new ProviderCallError('invalid_credential', 401);
      }),
    });
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const health = await env.DB.prepare(
      'SELECT health_status, key_tail FROM user_ai_credentials WHERE user_id = ?',
    ).bind(fixture.userId).first<{ health_status: string; key_tail: string }>();
    expect(health).toMatchObject({ health_status: 'unknown', key_tail: '-key' });
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'failed', error_code: 'invalid_credential' });
  });

  it.each([
    ['success', null, 'generating'],
    ['quota', new ProviderCallError('quota_exhausted', 402), 'failed'],
  ] as const)('ignores a late %s health result from a rotated credential', async (_label, providerError, expectedStatus) => {
    const fixture = await createFixture({ includeImages: false });
    let rotated = false;
    const deps = dependencies({
      synthesizeSpeech: vi.fn(async () => {
        if (!rotated) {
          rotated = true;
          const snapshot = await env.DB.prepare('SELECT model_snapshot_json FROM coursewares WHERE id = ?')
            .bind(fixture.coursewareId).first<{ model_snapshot_json: string }>();
          const providerId = (JSON.parse(snapshot?.model_snapshot_json ?? '{}') as any).teacherSpeech.providerId as number;
          await saveCredential(env.DB, env, fixture.userId, providerId, 'rotated-health-key');
        }
        if (providerError) throw providerError;
        return { bytes: validMp3(), contentType: 'audio/mpeg', requestId: 'late-health' };
      }),
    });
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const health = await env.DB.prepare(
      'SELECT health_status FROM user_ai_credentials WHERE user_id = ?',
    ).bind(fixture.userId).first<{ health_status: string }>();
    expect(health?.health_status).toBe('unknown');
    expect(await row(fixture.coursewareId)).toMatchObject({ status: expectedStatus });
  });

  it('preserves the normalized provider failure when its health update also fails', async () => {
    const fixture = await createFixture();
    const healthWrite = vi.fn(async () => { throw new Error('health unavailable'); });
    const deps = dependencies({
      recordCredentialHealth: healthWrite,
      synthesizeSpeech: vi.fn(async () => { throw new ProviderCallError('quota_exhausted', 402); }),
    });
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    expect(healthWrite).toHaveBeenCalled();
    expect(await row(fixture.coursewareId)).toMatchObject({
      status: 'failed', error_code: 'quota_exhausted', retryable: 0,
    });
  });

  it('classifies a missing credential master key as infrastructure failure without marking the user key invalid', async () => {
    const fixture = await createFixture();
    const appEnv = { ...fixture.appEnv, AI_SETTINGS_ENCRYPTION_KEY: undefined } as unknown as Env;
    expect(await advanceCourseware(appEnv, fixture.coursewareId, dependencies())).toBe('done');
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'failed', error_code: 'internal_error' });
    const health = await env.DB.prepare(
      'SELECT health_status FROM user_ai_credentials WHERE user_id = ?',
    ).bind(fixture.userId).first<{ health_status: string }>();
    expect(health?.health_status).toBe('unknown');
  });

  it('resolves credentials only for speakers in the claimed speech batch', async () => {
    const fixture = await createFixture({ includeImages: false });
    const studentProviderId = await splitStudentSpeechProvider(fixture);
    const speech = vi.fn(async () => ({ bytes: validMp3(), contentType: 'audio/mpeg', requestId: crypto.randomUUID() }));
    const deps = dependencies({
      generateText: vi.fn(async () => ({
        jsonText: JSON.stringify(teacherFirstScript), requestId: 'teacher-first', inputTokens: 10, outputTokens: 20,
      })),
      synthesizeSpeech: speech,
    });
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await env.DB.prepare(
      `UPDATE user_ai_credentials SET health_status = 'invalid' WHERE user_id = ? AND provider_id = ?`,
    ).bind(fixture.userId, studentProviderId).run();
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(speech).toHaveBeenCalledTimes(5);
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'generating', generation_stage: 'speech' });
  });

  it('advances an artifact-complete speech stage without resolving any credential', async () => {
    const fixture = await createFixture({ includeImages: false });
    const deps = dependencies();
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await env.DB.prepare(
      `UPDATE coursewares SET generation_stage = 'speech' WHERE id = ?`,
    ).bind(fixture.coursewareId).run();
    await env.DB.prepare(
      `UPDATE user_ai_credentials SET health_status = 'invalid' WHERE user_id = ?`,
    ).bind(fixture.userId).run();
    const calls = vi.mocked(deps.synthesizeSpeech).mock.calls.length;
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(vi.mocked(deps.synthesizeSpeech).mock.calls.length).toBe(calls);
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'generating', generation_stage: 'images' });
  });

  it('bounds required-audio R2 head errors and fails safely on the third attempt', async () => {
    const fixture = await createFixture({ includeImages: false });
    const deps = dependencies();
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const artifact = await firstReadyArtifact(fixture.coursewareId);
    if (!artifact) throw new Error('audio fixture unavailable');
    fixture.bucket.headFailures.set(artifact.object_key, 3);
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('done');
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'failed', error_code: 'storage_failed', retryable: 1 });
  });

  it('retries finalizing head failures twice and succeeds when storage recovers', async () => {
    const fixture = await createFixture({ includeImages: false });
    const deps = dependencies();
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    expect(await row(fixture.coursewareId)).toMatchObject({ generation_stage: 'finalizing' });
    const artifact = await firstReadyArtifact(fixture.coursewareId);
    if (!artifact) throw new Error('audio fixture unavailable');
    fixture.bucket.headFailures.set(artifact.object_key, 2);
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('done');
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'ready', generation_stage: 'ready' });
  });

  it('full-retries a third finalizing audio head failure through speech and restores the retained object', async () => {
    const fixture = await createFixture({ includeImages: false });
    const deps = dependencies();
    while ((await row(fixture.coursewareId))?.generation_stage !== 'finalizing') {
      expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    }
    const artifact = await firstReadyArtifact(fixture.coursewareId);
    if (!artifact) throw new Error('audio fixture unavailable');
    fixture.bucket.headFailures.set(artifact.object_key, 3);
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('done');
    expect(await row(fixture.coursewareId)).toMatchObject({
      status: 'failed', generation_stage: 'finalizing', error_code: 'storage_failed',
    });

    const repository = createCoursewareRepository(env.DB);
    const claim = await repository.claimRetryableFailure(
      fixture.userId, fixture.coursewareId, `full-retry:${crypto.randomUUID()}`,
    );
    expect(claim).toMatchObject({ resumeStage: 'speech' });
    if (!claim) throw new Error('retry claim unavailable');
    await repository.finishRetryClaim(claim);
    const retained = await env.DB.prepare(
      'SELECT audio_status, audio_object_key FROM courseware_segments WHERE id = ?',
    ).bind(artifact.id).first<{ audio_status: string; audio_object_key: string }>();
    expect(retained).toEqual({ audio_status: 'pending', audio_object_key: artifact.object_key });

    fixture.bucket.headFailures.set(artifact.object_key, 2);
    const speechCalls = vi.mocked(deps.synthesizeSpeech).mock.calls.length;
    const outcomes = await advanceUntilDone(fixture, deps, 8);
    expect(outcomes.at(-1)).toBe('done');
    expect(outcomes.length).toBeLessThanOrEqual(6);
    expect(vi.mocked(deps.synthesizeSpeech).mock.calls.length).toBe(speechCalls);
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'ready', generation_stage: 'ready' });
    const incomplete = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM courseware_segments WHERE courseware_id = ? AND
       (audio_status != 'ready' OR alternate_audio_status NOT IN ('ready', 'not_required'))`,
    ).bind(fixture.coursewareId).first<{ count: number }>();
    expect(incomplete?.count).toBe(0);
  });

  it('generates a missing retained alternate audio once and deletes the exact old attempt key', async () => {
    const fixture = await createFixture({ includeImages: false });
    const deps = dependencies();
    await advanceUntilDone(fixture, deps);
    const artifact = await env.DB.prepare(
      `SELECT id, alternate_audio_object_key AS object_key FROM courseware_segments
       WHERE courseware_id = ? AND alternate_audio_status = 'ready' ORDER BY position LIMIT 1`,
    ).bind(fixture.coursewareId).first<{ id: number; object_key: string }>();
    if (!artifact) throw new Error('alternate audio fixture unavailable');
    fixture.bucket.hiddenHeads.add(artifact.object_key);
    await env.DB.prepare("UPDATE coursewares SET status = 'generating', generation_stage = 'speech' WHERE id = ?")
      .bind(fixture.coursewareId).run();
    await env.DB.prepare("UPDATE courseware_segments SET alternate_audio_status = 'pending' WHERE id = ?")
      .bind(artifact.id).run();
    const calls = vi.mocked(deps.synthesizeSpeech).mock.calls.length;
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(vi.mocked(deps.synthesizeSpeech).mock.calls.length).toBe(calls + 1);
    expect(fixture.bucket.objects.has(artifact.object_key)).toBe(false);
    const replaced = await env.DB.prepare(
      'SELECT alternate_audio_status, alternate_audio_object_key FROM courseware_segments WHERE id = ?',
    ).bind(artifact.id).first<{ alternate_audio_status: string; alternate_audio_object_key: string }>();
    expect(replaced?.alternate_audio_status).toBe('ready');
    expect(replaced?.alternate_audio_object_key).not.toBe(artifact.object_key);
  });

  it('tombstones a missing retained main audio when exact post-CAS cleanup fails', async () => {
    const fixture = await createFixture({ includeImages: false });
    const deps = dependencies();
    await advanceUntilDone(fixture, deps);
    const artifact = await firstReadyArtifact(fixture.coursewareId);
    if (!artifact) throw new Error('audio fixture unavailable');
    fixture.bucket.hiddenHeads.add(artifact.object_key);
    fixture.bucket.deleteFailures.add(artifact.object_key);
    await env.DB.prepare("UPDATE coursewares SET status = 'generating', generation_stage = 'speech' WHERE id = ?")
      .bind(fixture.coursewareId).run();
    await env.DB.prepare("UPDATE courseware_segments SET audio_status = 'pending' WHERE id = ?")
      .bind(artifact.id).run();
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    const tombstone = await env.DB.prepare(
      'SELECT object_key FROM courseware_media_tombstones WHERE object_key = ?',
    ).bind(artifact.object_key).first<{ object_key: string }>();
    expect(tombstone?.object_key).toBe(artifact.object_key);
  });

  it('restores a retained image object without another provider call', async () => {
    const fixture = await createFixture();
    const deps = dependencies();
    await advanceUntilDone(fixture, deps);
    const artifact = await firstReadyArtifact(fixture.coursewareId, 'image');
    if (!artifact) throw new Error('image fixture unavailable');
    await env.DB.prepare("UPDATE coursewares SET generation_stage = 'images' WHERE id = ?")
      .bind(fixture.coursewareId).run();
    await env.DB.prepare("UPDATE courseware_segments SET image_status = 'pending' WHERE id = ?")
      .bind(artifact.id).run();
    const imageCalls = vi.mocked(deps.generateImage).mock.calls.length;
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(vi.mocked(deps.generateImage).mock.calls.length).toBe(imageCalls);
    const restored = await env.DB.prepare('SELECT image_status FROM courseware_segments WHERE id = ?')
      .bind(artifact.id).first<{ image_status: string }>();
    expect(restored?.image_status).toBe('ready');
  });

  it('deletes the retained image attempt after a replacement CAS succeeds', async () => {
    const fixture = await createFixture();
    const deps = dependencies();
    await advanceUntilDone(fixture, deps);
    const artifact = await firstReadyArtifact(fixture.coursewareId, 'image');
    if (!artifact) throw new Error('image fixture unavailable');
    fixture.bucket.hiddenHeads.add(artifact.object_key);
    await env.DB.prepare("UPDATE coursewares SET generation_stage = 'images' WHERE id = ?")
      .bind(fixture.coursewareId).run();
    await env.DB.prepare("UPDATE courseware_segments SET image_status = 'pending' WHERE id = ?")
      .bind(artifact.id).run();
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    expect(fixture.bucket.objects.has(artifact.object_key)).toBe(false);
  });

  it('tombstones a retained image attempt when post-CAS cleanup fails', async () => {
    const fixture = await createFixture();
    const deps = dependencies();
    await advanceUntilDone(fixture, deps);
    const artifact = await firstReadyArtifact(fixture.coursewareId, 'image');
    if (!artifact) throw new Error('image fixture unavailable');
    fixture.bucket.hiddenHeads.add(artifact.object_key);
    fixture.bucket.deleteFailures.add(artifact.object_key);
    await env.DB.prepare("UPDATE coursewares SET generation_stage = 'images' WHERE id = ?")
      .bind(fixture.coursewareId).run();
    await env.DB.prepare("UPDATE courseware_segments SET image_status = 'pending' WHERE id = ?")
      .bind(artifact.id).run();
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const tombstone = await env.DB.prepare(
      'SELECT object_key FROM courseware_media_tombstones WHERE object_key = ?',
    ).bind(artifact.object_key).first<{ object_key: string }>();
    expect(tombstone?.object_key).toBe(artifact.object_key);
  });

  it('retries retained-image head failures twice and restores without provider billing', async () => {
    const fixture = await createFixture();
    const deps = dependencies();
    await advanceUntilDone(fixture, deps);
    const artifact = await firstReadyArtifact(fixture.coursewareId, 'image');
    if (!artifact) throw new Error('image fixture unavailable');
    fixture.bucket.headFailures.set(artifact.object_key, 2);
    await env.DB.prepare("UPDATE coursewares SET generation_stage = 'images' WHERE id = ?")
      .bind(fixture.coursewareId).run();
    const imageCalls = vi.mocked(deps.generateImage).mock.calls.length;
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(vi.mocked(deps.generateImage).mock.calls.length).toBe(imageCalls);
    const restored = await env.DB.prepare('SELECT image_status, image_retry_count FROM courseware_segments WHERE id = ?')
      .bind(artifact.id).first<{ image_status: string; image_retry_count: number }>();
    expect(restored).toEqual({ image_status: 'ready', image_retry_count: 0 });
  });

  it('bounds retained-image head failures and completes ready with a warning on the third attempt', async () => {
    const fixture = await createFixture();
    const deps = dependencies();
    await advanceUntilDone(fixture, deps);
    const artifact = await firstReadyArtifact(fixture.coursewareId, 'image');
    if (!artifact) throw new Error('image fixture unavailable');
    fixture.bucket.headFailures.set(artifact.object_key, 3);
    await env.DB.prepare("UPDATE coursewares SET generation_stage = 'images' WHERE id = ?")
      .bind(fixture.coursewareId).run();
    const imageCalls = vi.mocked(deps.generateImage).mock.calls.length;
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('reenqueue');
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('done');
    expect(vi.mocked(deps.generateImage).mock.calls.length).toBe(imageCalls);
    expect(await row(fixture.coursewareId)).toMatchObject({
      status: 'ready', generation_stage: 'ready', warnings_json: JSON.stringify(['部分配图生成失败，不影响语音课件播放']),
    });
  });

  it('renews a five-minute lease after provider response and avoids R2 when ownership was lost', async () => {
    const fixture = await createFixture({ includeImages: false });
    let remainingMs = 0;
    const deps = dependencies({
      synthesizeSpeech: vi.fn(async () => {
        const lease = await env.DB.prepare('SELECT lease_expires_at FROM coursewares WHERE id = ?')
          .bind(fixture.coursewareId).first<{ lease_expires_at: string }>();
        remainingMs = Date.parse(`${lease?.lease_expires_at.replace(' ', 'T')}Z`) - Date.now();
        await env.DB.prepare(
          `UPDATE coursewares SET status = 'deleting', lease_token = 'deleting-owner',
             lease_expires_at = datetime('now', '+5 minutes') WHERE id = ?`,
        ).bind(fixture.coursewareId).run();
        return { bytes: validMp3(), contentType: 'audio/mpeg', requestId: 'late-provider' };
      }),
    });
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const putsBefore = fixture.bucket.putCalls;
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('ignored');
    expect(remainingMs).toBeGreaterThan(4 * 60 * 1000);
    expect(fixture.bucket.putCalls).toBe(putsBefore);
    expect(await row(fixture.coursewareId)).toMatchObject({ status: 'deleting' });
  });

  it('does not write R2 when a newer generation attempt takes the lease during the provider call', async () => {
    const fixture = await createFixture({ includeImages: false });
    const deps = dependencies({
      synthesizeSpeech: vi.fn(async () => {
        await env.DB.prepare(
          `UPDATE coursewares SET lease_token = 'new-attempt', lease_expires_at = datetime('now', '+5 minutes')
           WHERE id = ?`,
        ).bind(fixture.coursewareId).run();
        return { bytes: validMp3(), contentType: 'audio/mpeg', requestId: 'stale-attempt' };
      }),
    });
    await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps);
    const putsBefore = fixture.bucket.putCalls;
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, deps)).toBe('ignored');
    expect(fixture.bucket.putCalls).toBe(putsBefore);
    const lease = await env.DB.prepare('SELECT lease_token FROM coursewares WHERE id = ?')
      .bind(fixture.coursewareId).first<{ lease_token: string }>();
    expect(lease?.lease_token).toBe('new-attempt');
  });

  it('honors an unexpired lease and recovers an expired lease', async () => {
    const owned = await createFixture({ lease: 'fresh' });
    const blockedDeps = dependencies();
    expect(await advanceCourseware(owned.appEnv, owned.coursewareId, blockedDeps)).toBe('ignored');
    expect(blockedDeps.generateText).not.toHaveBeenCalled();

    const expired = await createFixture({ lease: 'expired' });
    const recoveredDeps = dependencies();
    expect(await advanceCourseware(expired.appEnv, expired.coursewareId, recoveredDeps)).toBe('reenqueue');
    expect(recoveredDeps.generateText).toHaveBeenCalledTimes(1);
  });

  it('acknowledges malformed, deleted and already-ready messages without model calls', async () => {
    const fixture = await createFixture({ stage: 'ready' });
    const readyDeps = dependencies();
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, readyDeps)).toBe('ignored');
    expect(readyDeps.generateText).not.toHaveBeenCalled();
    expect(readyDeps.synthesizeSpeech).not.toHaveBeenCalled();
    await env.DB.prepare("UPDATE coursewares SET status = 'deleting' WHERE id = ?")
      .bind(fixture.coursewareId).run();
    expect(await advanceCourseware(fixture.appEnv, fixture.coursewareId, readyDeps)).toBe('ignored');
    expect(await advanceCourseware(fixture.appEnv, 2_147_483_647, readyDeps)).toBe('ignored');
    const advance = vi.fn(async () => 'ignored' as const);
    const consume = createCoursewareQueueConsumer(advance);
    const ackInvalid = vi.fn();
    const ackReady = vi.fn();
    const retry = vi.fn();
    const batch = {
      messages: [
        { body: { coursewareId: '1', secret: 'do-not-log' }, ack: ackInvalid, retry },
        { body: { coursewareId: fixture.coursewareId }, ack: ackReady, retry },
      ],
    } as unknown as MessageBatch<{ coursewareId: number }>;
    await consume(batch, fixture.appEnv, {} as ExecutionContext);
    expect(ackInvalid).toHaveBeenCalledOnce();
    expect(advance).toHaveBeenCalledOnce();
    expect(ackReady).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries the original message when durable re-enqueue fails', async () => {
    const fixture = await createFixture();
    const consume = createCoursewareQueueConsumer(vi.fn(async () => 'reenqueue' as const));
    const ack = vi.fn();
    const retry = vi.fn();
    const appEnv = {
      ...fixture.appEnv,
      COURSEWARE_QUEUE: { send: vi.fn(async () => { throw new Error('queue unavailable'); }) },
    } as unknown as Env;
    await consume({
      messages: [{ body: { coursewareId: fixture.coursewareId }, ack, retry }],
    } as unknown as MessageBatch<{ coursewareId: number }>, appEnv, {} as ExecutionContext);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(ack).not.toHaveBeenCalled();
  });
});
