import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationPath = join(repoRoot, 'migrations/0017_student_gender.sql');
const tempDirs: string[] = [];

function runSql(dbPath: string, sql: string): string {
  const result = spawnSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function queryJson<T>(dbPath: string, sql: string): T[] {
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim() ? (JSON.parse(result.stdout) as T[]) : [];
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('0017 student gender 迁移', () => {
  it('将现有学生迁移为不指定，并限制后续取值', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'daoxue-student-gender-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'test.sqlite3');
    runSql(dbPath, readFileSync(join(repoRoot, 'migrations/0001_init.sql'), 'utf8'));
    runSql(
      dbPath,
      `INSERT INTO users (id, email, password_hash) VALUES (1, 'parent@example.com', 'hash');
       INSERT INTO students (id, user_id, name, grade) VALUES (1, 1, '小安', '二年级');`,
    );

    runSql(dbPath, readFileSync(migrationPath, 'utf8'));

    expect(queryJson<{ gender: string }>(dbPath, 'SELECT gender FROM students WHERE id = 1;'))
      .toEqual([{ gender: 'unspecified' }]);
    runSql(dbPath, "INSERT INTO students (user_id, name, grade, gender) VALUES (1, '小树', '三年级', 'male');");
    runSql(dbPath, "UPDATE students SET gender = 'female' WHERE id = 1;");
    expect(() => runSql(dbPath, "UPDATE students SET gender = 'unknown' WHERE id = 1;"))
      .toThrow(/CHECK constraint failed/);
  });
});
