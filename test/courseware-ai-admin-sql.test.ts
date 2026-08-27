import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../src/worker/ai-catalog/admin-routes.ts', import.meta.url),
  'utf8',
);

describe('courseware AI administrator atomic SQL', () => {
  it('guards endpoint protocol changes in the UPDATE statement that performs the write', () => {
    const statement = source.match(/`UPDATE ai_provider_endpoints[\s\S]*?RETURNING id`/)?.[0] ?? '';
    expect(statement).toContain('NOT EXISTS');
    expect(statement).toContain('ai_models');
    expect(statement).toMatch(/capability\s*=\s*\?/);
    expect(statement).toMatch(/adapter_type\s*=\s*\?/);
  });

  it('binds model creation and movement to the target endpoint protocol in write SQL', () => {
    const insert = source.match(/`INSERT INTO ai_models[\s\S]*?RETURNING id`/)?.[0] ?? '';
    const update = source.match(/`UPDATE ai_models[\s\S]*?RETURNING id`/)?.[0] ?? '';
    expect(insert).toContain('SELECT');
    expect(insert).toContain('ai_provider_endpoints');
    expect(insert).toMatch(/adapter_type\s*=\s*\?/);
    expect(update).toContain('EXISTS');
    expect(update).toContain('ai_provider_endpoints');
    expect(update).toMatch(/adapter_type\s*=\s*\?/);
  });
});
