import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tempDirs: string[] = [];
const MIGRATIONS = [
  '0001_init.sql',
  '0002_app_settings.sql',
  '0003_login_failures.sql',
  '0004_profile_refine_settings.sql',
  '0005_add_chemistry_subject.sql',
  '0006_operation_leases.sql',
  '0007_chat_request_id.sql',
  '0008_chat_request_recovery.sql',
  '0009_user_ai_settings.sql',
] as const;

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

function applyMigrations(dbPath: string, names: readonly string[]): void {
  const sql = names.map((name) => readFileSync(join(repoRoot, 'migrations', name), 'utf8')).join('\n');
  runSql(dbPath, `PRAGMA foreign_keys = on;\n${sql}`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('数据库迁移链', () => {
  it('全新数据库可按编号顺序应用全部迁移', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daoxue-full-migrations-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'test.sqlite3');

    applyMigrations(dbPath, MIGRATIONS);

    expect(queryJson(dbPath, 'PRAGMA foreign_key_check;')).toEqual([]);
    expect(
      queryJson<{ name: string }>(
        dbPath,
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name IN (
           'conversation_chat_leases', 'conversations', 'profile_refine_leases',
           'profile_refine_log', 'student_profiles'
         )
         ORDER BY name`,
      ),
    ).toEqual([
      { name: 'conversation_chat_leases' },
      { name: 'conversations' },
      { name: 'profile_refine_leases' },
      { name: 'profile_refine_log' },
      { name: 'student_profiles' },
    ]);
    expect(
      queryJson<{ name: string }>(dbPath, "PRAGMA table_info('messages');")
        .filter((column) => ['client_request_id', 'quota_charged'].includes(column.name))
        .map((column) => column.name),
    ).toEqual(['client_request_id', 'quota_charged']);
    expect(
      queryJson<{ name: string }>(
        dbPath,
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_messages_client_request';",
      ),
    ).toEqual([{ name: 'idx_messages_client_request' }]);
    runSql(
      dbPath,
      `INSERT INTO users (id, email, password_hash) VALUES (1, 'fresh@example.com', 'hash');
       INSERT INTO students (id, user_id, name, grade) VALUES (1, 1, '小新', '初三');
       INSERT INTO conversations (student_id, subject, title) VALUES (1, 'chemistry', '化学会话');
       INSERT INTO messages (conversation_id, role, content, client_request_id)
         VALUES (1, 'user', '题目', 'request-12345678');
       INSERT INTO messages (conversation_id, role, content, client_request_id)
         VALUES (1, 'assistant', '答案', 'request-12345678');
       INSERT INTO student_profiles (student_id, subject, profile_text) VALUES (1, 'chemistry', '化学画像');
       INSERT INTO profile_refine_leases (student_id, subject, lease_token, expires_at)
         VALUES (1, 'chemistry', 'profile-token', datetime('now', '+3 minutes'));
       INSERT INTO conversation_chat_leases (conversation_id, lease_token, expires_at)
         VALUES (1, 'chat-token', datetime('now', '+3 minutes'));`,
    );
    expect(() =>
      runSql(
        dbPath,
        `INSERT INTO messages (conversation_id, role, content, client_request_id)
         VALUES (1, 'user', '重复题目', 'request-12345678');`,
      ),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      runSql(
        dbPath,
        `INSERT INTO messages (conversation_id, role, content, client_request_id)
         VALUES (1, 'assistant', '重复答案', 'request-12345678');`,
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('保留历史关联数据并扩展严格学科白名单', () => {
    const migrationPath = join(repoRoot, 'migrations/0005_add_chemistry_subject.sql');
    expect(existsSync(migrationPath)).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'daoxue-chemistry-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'test.sqlite3');
    applyMigrations(dbPath, MIGRATIONS.slice(0, 4));

    runSql(
      dbPath,
      `PRAGMA foreign_keys = on;
       INSERT INTO users (id, email, password_hash) VALUES (1, 'parent@example.com', 'hash');
       INSERT INTO students (id, user_id, name, grade) VALUES (1, 1, '小明', '初三');
       INSERT INTO conversations (id, student_id, subject, title) VALUES (11, 1, 'math', '历史会话');
       INSERT INTO conversations (id, student_id, subject, mode, title)
         VALUES (12, 1, 'selflearn', 'selflearn-daily', '历史自学会话');
       INSERT INTO messages (id, conversation_id, role, content) VALUES (21, 11, 'user', '历史消息');
       INSERT INTO mistake_cards
         (id, student_id, subject, conversation_id, title, next_review_date)
         VALUES (31, 1, 'math', 11, '历史错题', '2026-08-12');
       INSERT INTO student_profiles (student_id, subject, profile_text)
         VALUES (1, 'math', '历史画像');
       INSERT INTO lesson_outputs
         (id, student_id, conversation_id, direction, content, next_instruction)
         VALUES (41, 1, 11, '数学', '历史每课输出', '继续复测');
       INSERT INTO daily_reports
         (id, student_id, conversation_id, report_date, content)
         VALUES (51, 1, 11, '2026-08-09', '历史每日报告');
       INSERT INTO profile_refine_log (id, student_id, subject) VALUES (61, 1, 'math');`,
    );

    const remainingMigrations = MIGRATIONS.slice(4)
      .map((name) => readFileSync(join(repoRoot, 'migrations', name), 'utf8'))
      .join('\n');
    runSql(dbPath, `PRAGMA foreign_keys = on;\n${remainingMigrations}`);

    const preserved = queryJson<{
      conversations: number;
      selflearn: number;
      messages: number;
      mistakes: number;
      profiles: number;
      lessons: number;
      reports: number;
      profileRefines: number;
      leaseTables: number;
      loginCleanupIndex: number;
      indexes: number;
    }>(
      dbPath,
      `SELECT
         (SELECT COUNT(*) FROM conversations WHERE id = 11 AND title = '历史会话') AS conversations,
         (SELECT COUNT(*) FROM conversations WHERE id = 12 AND subject = 'selflearn') AS selflearn,
         (SELECT COUNT(*) FROM messages WHERE id = 21 AND conversation_id = 11) AS messages,
         (SELECT COUNT(*) FROM mistake_cards WHERE id = 31 AND conversation_id = 11) AS mistakes,
         (SELECT COUNT(*) FROM student_profiles WHERE student_id = 1 AND profile_text = '历史画像') AS profiles,
         (SELECT COUNT(*) FROM lesson_outputs WHERE id = 41 AND conversation_id = 11) AS lessons,
         (SELECT COUNT(*) FROM daily_reports WHERE id = 51 AND conversation_id = 11) AS reports,
         (SELECT COUNT(*) FROM profile_refine_log WHERE id = 61 AND student_id = 1) AS profileRefines,
         (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'table' AND name IN ('profile_refine_leases', 'conversation_chat_leases')) AS leaseTables,
         (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'index' AND name = 'idx_login_failures_created_at') AS loginCleanupIndex,
         (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'index' AND name IN (
            'idx_conversations_student', 'idx_messages_conversation', 'idx_mistakes_student',
            'idx_lesson_outputs_student', 'idx_daily_reports_student'
          )) AS indexes;`,
    );
    expect(preserved[0]).toEqual({
      conversations: 1,
      selflearn: 1,
      messages: 1,
      mistakes: 1,
      profiles: 1,
      lessons: 1,
      reports: 1,
      profileRefines: 1,
      leaseTables: 2,
      loginCleanupIndex: 1,
      indexes: 5,
    });
    expect(queryJson(dbPath, 'PRAGMA foreign_key_check;')).toEqual([]);

    runSql(
      dbPath,
      `PRAGMA foreign_keys = on;
       INSERT INTO conversations (id, student_id, subject, title) VALUES (13, 1, 'chemistry', '化学会话');
       INSERT INTO mistake_cards
         (id, student_id, subject, conversation_id, title, next_review_date)
         VALUES (32, 1, 'chemistry', 13, '化学错题', '2026-08-13');
       INSERT INTO student_profiles (student_id, subject, profile_text)
         VALUES (1, 'chemistry', '化学画像');`,
    );

    expect(() =>
      runSql(dbPath, "INSERT INTO conversations (student_id, subject) VALUES (1, 'biology');"),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      runSql(
        dbPath,
        "INSERT INTO mistake_cards (student_id, subject, title, next_review_date) VALUES (1, 'biology', '非法', '2026-08-14');",
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      runSql(dbPath, "INSERT INTO student_profiles (student_id, subject) VALUES (1, 'biology');"),
    ).toThrow(/CHECK constraint failed/);
  });
});
