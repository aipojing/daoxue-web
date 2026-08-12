import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tempDirs: string[] = [];
const MIGRATIONS_BEFORE_HISTORY = [
  '0001_init.sql',
  '0002_app_settings.sql',
  '0003_login_failures.sql',
  '0004_profile_refine_settings.sql',
  '0005_add_chemistry_subject.sql',
  '0006_operation_leases.sql',
  '0007_chat_request_id.sql',
  '0008_chat_request_recovery.sql',
  '0009_user_ai_settings.sql',
  '0010_user_profile_refine_settings.sql',
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

describe('历史学科迁移', () => {
  it('保留现有数据和聊天恢复字段，并扩展严格学科白名单', () => {
    const migrationPath = join(repoRoot, 'migrations/0011_add_history_subject.sql');
    expect(existsSync(migrationPath)).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'daoxue-history-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'test.sqlite3');
    applyMigrations(dbPath, MIGRATIONS_BEFORE_HISTORY);

    runSql(
      dbPath,
      `PRAGMA foreign_keys = on;
       INSERT INTO users (id, email, password_hash) VALUES (1, 'parent@example.com', 'hash');
       INSERT INTO students (id, user_id, name, grade) VALUES (1, 1, '小明', '初三');
       INSERT INTO conversations (id, student_id, subject, title) VALUES (11, 1, 'chemistry', '原有会话');
       INSERT INTO conversations (id, student_id, subject, mode, title)
         VALUES (12, 1, 'selflearn', 'selflearn-daily', '原有自学会话');
       INSERT INTO messages
         (id, conversation_id, role, content, reasoning_content, client_request_id, quota_charged)
         VALUES (21, 11, 'user', '原有消息', '思考', 'request-12345678', 1);
       INSERT INTO mistake_cards
         (id, student_id, subject, conversation_id, title, next_review_date)
         VALUES (31, 1, 'chemistry', 11, '原有错题', '2026-08-20');
       INSERT INTO student_profiles (student_id, subject, profile_text)
         VALUES (1, 'chemistry', '原有画像');
       INSERT INTO lesson_outputs
         (id, student_id, conversation_id, direction, content, next_instruction)
         VALUES (41, 1, 11, '化学', '原有每课输出', '继续复测');
       INSERT INTO daily_reports
         (id, student_id, conversation_id, report_date, content)
         VALUES (51, 1, 11, '2026-08-13', '原有每日报告');
       INSERT INTO conversation_chat_leases (conversation_id, lease_token, expires_at)
         VALUES (11, 'chat-token', datetime('now', '+3 minutes'));`,
    );

    runSql(dbPath, `PRAGMA foreign_keys = on;\n${readFileSync(migrationPath, 'utf8')}`);

    expect(queryJson(dbPath, 'PRAGMA foreign_key_check;')).toEqual([]);
    expect(
      queryJson<Record<string, number>>(
        dbPath,
        `SELECT
           (SELECT COUNT(*) FROM conversations WHERE id = 11 AND subject = 'chemistry') AS conversations,
           (SELECT COUNT(*) FROM conversations WHERE id = 12 AND subject = 'selflearn') AS selflearn,
           (SELECT COUNT(*) FROM messages WHERE id = 21 AND client_request_id = 'request-12345678'
             AND quota_charged = 1) AS messages,
           (SELECT COUNT(*) FROM mistake_cards WHERE id = 31 AND conversation_id = 11) AS mistakes,
           (SELECT COUNT(*) FROM student_profiles WHERE student_id = 1 AND profile_text = '原有画像') AS profiles,
           (SELECT COUNT(*) FROM lesson_outputs WHERE id = 41 AND conversation_id = 11) AS lessons,
           (SELECT COUNT(*) FROM daily_reports WHERE id = 51 AND conversation_id = 11) AS reports,
           (SELECT COUNT(*) FROM conversation_chat_leases WHERE conversation_id = 11
             AND lease_token = 'chat-token') AS leases;`,
      ),
    ).toEqual([{
      conversations: 1,
      selflearn: 1,
      messages: 1,
      mistakes: 1,
      profiles: 1,
      lessons: 1,
      reports: 1,
      leases: 1,
    }]);

    runSql(
      dbPath,
      `INSERT INTO conversations (id, student_id, subject, title) VALUES (13, 1, 'history', '历史会话');
       INSERT INTO mistake_cards
         (id, student_id, subject, conversation_id, title, next_review_date)
         VALUES (32, 1, 'history', 13, '历史错题', '2026-08-21');
       INSERT INTO student_profiles (student_id, subject, profile_text)
         VALUES (1, 'history', '历史画像');`,
    );

    expect(() =>
      runSql(dbPath, "INSERT INTO conversations (student_id, subject) VALUES (1, 'biology');"),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      runSql(
        dbPath,
        "INSERT INTO mistake_cards (student_id, subject, title, next_review_date) VALUES (1, 'biology', '非法', '2026-08-22');",
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      runSql(dbPath, "INSERT INTO student_profiles (student_id, subject) VALUES (1, 'biology');"),
    ).toThrow(/CHECK constraint failed/);

    expect(
      queryJson<{ name: string }>(
        dbPath,
        `SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (
           'idx_messages_client_request_user', 'idx_messages_client_request',
           'idx_messages_client_request_assistant'
         ) ORDER BY name;`,
      ).map(({ name }) => name),
    ).toEqual([
      'idx_messages_client_request',
      'idx_messages_client_request_assistant',
      'idx_messages_client_request_user',
    ]);
  });
});
