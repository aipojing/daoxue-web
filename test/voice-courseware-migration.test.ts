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
    expect(() => runSql(
      dbPath,
      "INSERT INTO coursewares(student_id, subject, grade, topic, learning_goal, title, status, model_snapshot_json) VALUES (1, 'math', '三年级', '分数', '理解分数', '分数课', 'unknown', '{}')",
    )).toThrow(/CHECK constraint failed/);
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
