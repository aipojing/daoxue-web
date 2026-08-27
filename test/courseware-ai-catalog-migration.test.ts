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
  const dir = mkdtempSync(join(tmpdir(), 'daoxue-courseware-catalog-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'test.sqlite3');
  const names = readdirSync(join(repoRoot, 'migrations'))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const sql = names.map((name) => readFileSync(join(repoRoot, 'migrations', name), 'utf8')).join('\n');
  runSql(dbPath, 'PRAGMA foreign_keys = on;\n' + sql);
  return dbPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('0012 courseware AI catalog migration', () => {
  it('creates configurable providers, endpoints, models, credentials and preferences', () => {
    const dbPath = freshDatabase();
    const tables = queryJson<{ name: string }>(
      dbPath,
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND " +
      "(name LIKE 'ai_%' OR name IN ('user_ai_credentials', 'user_model_preferences')) ORDER BY name",
    ).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      'ai_models',
      'ai_provider_endpoints',
      'ai_providers',
      'ai_connection_test_usage',
      'user_ai_credentials',
      'user_model_preferences',
    ]));
    expect(queryJson(dbPath, 'PRAGMA foreign_key_check;')).toEqual([]);
  });

  it('seeds editable Token Plan recommendations instead of code constants', () => {
    const dbPath = freshDatabase();
    const rows = queryJson<{ model_id: string; capability: string }>(
      dbPath,
      "SELECT model_id, capability FROM ai_models ORDER BY model_id",
    );
    expect(rows).toEqual(expect.arrayContaining([
      { model_id: 'qwen3.7-plus', capability: 'structured_text' },
      { model_id: 'qwen-audio-3.0-tts-plus', capability: 'speech_synthesis' },
      { model_id: 'qwen-image-3.0-pro', capability: 'image_generation' },
    ]));
    expect(queryJson<{ media_host_suffixes: string }>(
      dbPath,
      `SELECT json_extract(config_json, '$.mediaHostSuffixes') AS media_host_suffixes
       FROM ai_provider_endpoints WHERE adapter_type = 'token_plan_tts'`,
    )).toEqual([{ media_host_suffixes: '["aliyuncs.com"]' }]);
  });

  it('rejects non-HTTPS endpoints and half credentials', () => {
    const dbPath = freshDatabase();
    expect(() => runSql(
      dbPath,
      "INSERT INTO ai_provider_endpoints(provider_id, capability, adapter_type, base_url) VALUES (1, 'structured_text', 'openai_text', 'http://127.0.0.1/v1')",
    )).toThrow(/CHECK constraint failed/);
    runSql(dbPath, "INSERT INTO users(id, email, password_hash) VALUES (1, 'parent@example.com', 'hash')");
    expect(() => runSql(
      dbPath,
      "INSERT INTO user_ai_credentials(user_id, provider_id, key_ciphertext, key_tail) VALUES (1, 1, 'cipher', 'tail')",
    )).toThrow(/CHECK constraint failed/);
  });
});
