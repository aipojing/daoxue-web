import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tempDirs: string[] = [];

function runSql(dbPath: string, sql: string): string {
  const result = spawnSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function queryJson<T>(dbPath: string, sql: string): T[] {
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim() ? JSON.parse(result.stdout) as T[] : [];
}

function freshDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daoxue-voice-courseware-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'test.sqlite3');
  const names = readdirSync(join(repoRoot, 'migrations'))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const sql = names.map((name) => readFileSync(join(repoRoot, 'migrations', name), 'utf8')).join('\n');
  runSql(dbPath, 'PRAGMA foreign_keys = on;\n' + sql);
  return dbPath;
}

function insertOwnedStudent(dbPath: string): void {
  runSql(
    dbPath,
    "INSERT INTO users(id, email, password_hash) VALUES (1, 'parent@example.com', 'hash');" +
    "INSERT INTO students(id, user_id, name, grade) VALUES (1, 1, '小雨', '三年级');",
  );
}

function insertCourseware(dbPath: string): void {
  runSql(
    dbPath,
    "INSERT INTO coursewares(student_id, subject, grade, topic, learning_goal, title, model_snapshot_json) " +
    "VALUES (1, 'math', '三年级', '分数', '理解分数', '分数课', '{}');",
  );
}

type SegmentInput = Partial<{
  position: number;
  segmentKey: string;
  kind: string;
  speaker: string;
  checkpointJson: string;
  audioStatus: string;
  imageStatus: string;
}>;

function insertSegment(dbPath: string, input: SegmentInput = {}): void {
  const {
    position = 0,
    segmentKey = 'intro',
    kind = 'teacher_intro',
    speaker = 'teacher',
    checkpointJson = '{}',
    audioStatus = 'pending',
    imageStatus = 'not_required',
  } = input;
  runSql(
    dbPath,
    "INSERT INTO courseware_segments(" +
    'courseware_id, position, segment_key, kind, speaker, title, display_markdown, speech_text, ' +
    'checkpoint_json, audio_status, image_status) VALUES ' +
    `(1, ${position}, '${segmentKey}', '${kind}', '${speaker}', '分数导入', '内容', '讲解', ` +
    `'${checkpointJson}', '${audioStatus}', '${imageStatus}');`,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('0013 voice courseware migration', () => {
  it('creates coursewares and segments with strict states', () => {
    const dbPath = freshDatabase();
    insertOwnedStudent(dbPath);
    const columns = queryJson<{ name: string }>(
      dbPath,
      "PRAGMA table_info('coursewares')",
    ).map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining([
      'student_id',
      'assessment_conversation_id',
      'model_snapshot_json',
      'lease_token',
      'lease_expires_at',
    ]));
    expect(queryJson<{ name: string }>(
      dbPath,
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'courseware_segments'",
    )).toEqual([{ name: 'courseware_segments' }]);
    expect(() => runSql(
      dbPath,
      "INSERT INTO coursewares(student_id, subject, grade, topic, learning_goal, title, status, model_snapshot_json) VALUES (1, 'math', '三年级', '分数', '理解分数', '分数课', 'unknown', '{}')",
    )).toThrow(/CHECK constraint failed/);
    insertCourseware(dbPath);
    insertSegment(dbPath);
  });

  it('rejects invalid segment states and duplicate segment identity', () => {
    const dbPath = freshDatabase();
    insertOwnedStudent(dbPath);
    insertCourseware(dbPath);
    insertSegment(dbPath);

    expect(() => insertSegment(dbPath, { position: 1, segmentKey: 'invalid-kind', kind: 'unknown' }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insertSegment(dbPath, { position: 2, segmentKey: 'invalid-speaker', speaker: 'narrator' }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insertSegment(dbPath, { position: 3, segmentKey: 'invalid-audio', audioStatus: 'unknown' }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insertSegment(dbPath, { position: 4, segmentKey: 'invalid-image', imageStatus: 'unknown' }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insertSegment(dbPath, { position: 5, segmentKey: 'invalid-json', checkpointJson: 'not-json' }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insertSegment(dbPath, { segmentKey: 'same-position' }))
      .toThrow(/UNIQUE constraint failed/);
    expect(() => insertSegment(dbPath, { position: 6 }))
      .toThrow(/UNIQUE constraint failed/);
  });

  it('seeds the feature flag off and keeps foreign keys valid', () => {
    const dbPath = freshDatabase();
    expect(queryJson<{ value: string }>(
      dbPath,
      "SELECT value FROM app_settings WHERE key = 'courseware_enabled'",
    )).toEqual([{ value: '0' }]);
    expect(queryJson(dbPath, 'PRAGMA foreign_key_check;')).toEqual([]);
    expect(queryJson<{ name: string }>(dbPath, "PRAGMA table_info('messages')").map((row) => row.name))
      .toContain('courseware_draft_json');
  });
});
