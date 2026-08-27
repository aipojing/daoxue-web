import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoursewareScript, CoursewareScriptSegment } from '../../src/shared/courseware';
import { saveCredential } from '../../src/worker/ai-catalog/credentials';
import { ProviderCallError } from '../../src/worker/courseware/adapters/errors';
import { readMp3DurationMs } from '../../src/worker/courseware/audio-metadata';
import {
  advanceCourseware,
  type CoursewareGenerationDependencies,
} from '../../src/worker/courseware/generator';
import { createCoursewareQueueConsumer } from '../../src/worker/courseware/queue';
import type { Env } from '../../src/worker/env';

class FakeBucket {
  readonly objects = new Map<string, { bytes: ArrayBuffer; contentType: string }>();

  async put(key: string, bytes: ArrayBuffer, options?: R2PutOptions) {
    const metadata = options?.httpMetadata;
    const contentType = metadata instanceof Headers ? metadata.get('content-type') ?? '' : metadata?.contentType ?? '';
    this.objects.set(key, { bytes: bytes.slice(0), contentType });
    return {} as R2Object;
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? ({ key, size: object.bytes.byteLength } as R2Object) : null;
  }

  async delete(key: string | string[]) {
    for (const item of Array.isArray(key) ? key : [key]) this.objects.delete(item);
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

  it('keeps a courseware playable when its snapshotted image endpoint is administratively disabled', async () => {
    const fixture = await createFixture();
    const image = vi.fn();
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
      expect(image).not.toHaveBeenCalled();
      expect(await row(fixture.coursewareId)).toMatchObject({ status: 'ready', generation_stage: 'ready' });
      expect(JSON.parse((await row(fixture.coursewareId))?.warnings_json ?? '[]')).toContain('部分配图生成失败，不影响语音课件播放');
    } finally {
      await env.DB.prepare('UPDATE ai_provider_endpoints SET enabled = 1 WHERE id = ?').bind(endpointId).run();
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
