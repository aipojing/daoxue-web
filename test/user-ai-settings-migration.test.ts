import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function freshDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daoxue-user-ai-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'test.sqlite3');
  applyMigrations(dbPath, MIGRATIONS);
  runSql(
    dbPath,
    `INSERT INTO users (id, email, password_hash) VALUES (1, 'user-a@example.com', 'hash');`,
  );
  return dbPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('0009 user_ai_settings 迁移', () => {
  it('完整迁移链后存在用户级 AI 设置表与共享兜底开关', () => {
    const dbPath = freshDatabase();

    const columns = queryJson<{ name: string }>(dbPath, "PRAGMA table_info('user_ai_settings');").map(
      (column) => column.name,
    );
    expect(columns).toEqual(
      expect.arrayContaining([
        'user_id',
        'deepseek_key_ciphertext',
        'deepseek_key_iv',
        'deepseek_key_tail',
        'vision_key_ciphertext',
        'vision_key_iv',
        'vision_key_tail',
        'vision_provider',
        'vision_model',
        'encryption_version',
        'updated_at',
      ]),
    );

    const setting = queryJson<{ value: string }>(
      dbPath,
      "SELECT value FROM app_settings WHERE key = 'shared_ai_fallback_enabled';",
    );
    expect(setting[0]?.value).toBe('1');

    expect(queryJson(dbPath, 'PRAGMA foreign_key_check;')).toEqual([]);
  });

  it('视觉 provider 只接受白名单取值', () => {
    const dbPath = freshDatabase();
    expect(() =>
      runSql(
        dbPath,
        `INSERT INTO user_ai_settings (user_id, vision_provider) VALUES (1, 'https://attacker.example');`,
      ),
    ).toThrow(/CHECK constraint failed/);

    runSql(dbPath, `INSERT INTO user_ai_settings (user_id, vision_provider) VALUES (1, 'dashscope');`);
    const row = queryJson<{ vision_provider: string }>(
      dbPath,
      'SELECT vision_provider FROM user_ai_settings WHERE user_id = 1;',
    );
    expect(row[0]?.vision_provider).toBe('dashscope');
  });

  it('半套密文（只有密文没有 IV 或尾号）被拒绝', () => {
    const dbPath = freshDatabase();
    expect(() =>
      runSql(
        dbPath,
        `INSERT INTO user_ai_settings (user_id, deepseek_key_ciphertext, deepseek_key_tail)
         VALUES (1, 'ciphertext', 'tail');`,
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      runSql(
        dbPath,
        `INSERT INTO user_ai_settings (user_id, vision_key_ciphertext, vision_key_iv)
         VALUES (1, 'ciphertext', 'iv');`,
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('user_id 必须对应真实用户，删除用户时级联清理', () => {
    const dbPath = freshDatabase();
    // sqlite CLI 每个进程都要单独开启外键约束
    expect(() =>
      runSql(dbPath, `PRAGMA foreign_keys = on;\nINSERT INTO user_ai_settings (user_id) VALUES (999);`),
    ).toThrow(/FOREIGN KEY constraint failed/);

    runSql(
      dbPath,
      `PRAGMA foreign_keys = on;
       INSERT INTO user_ai_settings
         (user_id, deepseek_key_ciphertext, deepseek_key_iv, deepseek_key_tail)
         VALUES (1, 'ciphertext', 'iv', 'tail');`,
    );
    runSql(dbPath, 'PRAGMA foreign_keys = on;\nDELETE FROM users WHERE id = 1;');
    expect(
      queryJson<{ n: number }>(dbPath, 'SELECT COUNT(*) AS n FROM user_ai_settings;'),
    ).toEqual([{ n: 0 }]);
  });

  it('兜底开关种子语句可安全重放且不覆盖管理员的既有取值', () => {
    const dbPath = freshDatabase();
    // 管理员关闭兜底后，重新执行迁移中的种子 INSERT 不得把它改回开启
    runSql(
      dbPath,
      `UPDATE app_settings SET value = '0' WHERE key = 'shared_ai_fallback_enabled';`,
    );
    const migration = readFileSync(join(repoRoot, 'migrations/0009_user_ai_settings.sql'), 'utf8');
    const seedInsert = migration.slice(migration.indexOf('INSERT INTO app_settings'));
    runSql(dbPath, seedInsert);
    const setting = queryJson<{ value: string }>(
      dbPath,
      "SELECT value FROM app_settings WHERE key = 'shared_ai_fallback_enabled';",
    );
    expect(setting[0]?.value).toBe('0');
  });
});
