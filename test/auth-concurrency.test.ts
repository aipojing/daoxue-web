import { describe, expect, it } from 'vitest';
import { createRegisteredUser, reserveLoginAttempt } from '../src/worker/auth/routes';

type User = { id: number; email: string; is_admin: number; daily_message_limit: number };

class AuthMemoryDb {
  users: User[] = [];
  sessions: Array<{ id: number; tokenHash: string; userId: number }> = [];
  failures: Array<{ id: number; email: string; expired: boolean }> = [];
  invite = { id: 1, code: 'INVITE', maxUses: 1, usedCount: 0, disabled: false };
  failNextRegularInsert = false;
  batchCalls = 0;

  prepare(sql: string) {
    return {
      run: async () => this.run(sql, []),
      bind: (...args: unknown[]) => ({
        __sql: sql,
        __args: args,
        first: async <T>() => this.first(sql, args) as T | null,
        run: async () => this.run(sql, args),
      }),
    };
  }

  async batch(statements: Array<{ __sql: string; __args: unknown[] }>) {
    this.batchCalls += 1;
    const users = [...this.users];
    const sessions = [...this.sessions];
    const usedCount = this.invite.usedCount;
    try {
      const results: Array<{ success: true; results: unknown[]; meta: object }> = [];
      let changed = false;
      for (const statement of statements) {
        const row = changed || statement.__sql.includes('WHERE NOT EXISTS') || statement.__sql.includes('UPDATE invite_codes')
          ? this.first(statement.__sql, statement.__args)
          : null;
        changed = row !== null;
        results.push({ success: true, results: row ? [row] : [], meta: {} });
      }
      return results;
    } catch (error) {
      this.users = users;
      this.sessions = sessions;
      this.invite.usedCount = usedCount;
      throw error;
    }
  }

  private first(sql: string, args: unknown[]): unknown {
    if (sql.includes('INSERT INTO login_failures') && sql.includes('SELECT')) {
      const email = String(args[0]);
      const active = this.failures.filter((f) => f.email === email && !f.expired).length;
      if (active >= Number(args[1])) return null;
      const row = { id: this.failures.length + 1 };
      this.failures.push({ ...row, email, expired: false });
      return row;
    }
    if (sql.includes('INSERT INTO users') && sql.includes('WHERE NOT EXISTS')) {
      if (this.users.length > 0) return null;
      const row = { id: 1, email: String(args[0]), is_admin: 1, daily_message_limit: 100 };
      this.users.push(row);
      return row;
    }
    if (sql.startsWith('SELECT id FROM users WHERE email')) {
      const user = this.users.find((u) => u.email === String(args[0]));
      return user ? { id: user.id } : null;
    }
    if (sql.includes('UPDATE invite_codes') && sql.includes('used_count = used_count + 1')) {
      if (
        String(args[0]) !== this.invite.code ||
        this.invite.disabled ||
        this.invite.usedCount >= this.invite.maxUses
      ) return null;
      this.invite.usedCount += 1;
      return { id: this.invite.id };
    }
    if (sql.includes('INSERT INTO users') && sql.includes('0 WHERE changes() = 1')) {
      if (this.failNextRegularInsert) {
        this.failNextRegularInsert = false;
        throw new Error('forced insert failure');
      }
      if (this.users.some((u) => u.email === String(args[0]))) throw new Error('UNIQUE users.email');
      const row = {
        id: this.users.length + 1,
        email: String(args[0]),
        is_admin: 0,
        daily_message_limit: 100,
      };
      this.users.push(row);
      return row;
    }
    if (sql.includes('INSERT INTO sessions') && sql.includes('WHERE changes() = 1')) {
      const row = { id: this.sessions.length + 1 };
      this.sessions.push({
        id: row.id,
        tokenHash: String(args[0]),
        userId: this.users[this.users.length - 1]!.id,
      });
      return row;
    }
    throw new Error(`Unexpected first SQL: ${sql}`);
  }

  private run(sql: string, args: unknown[]) {
    if (/DELETE FROM login_failures\s+WHERE created_at/.test(sql)) {
      this.failures = this.failures.filter((f) => !f.expired);
      return { meta: { changes: 1 } };
    }
    if (sql.includes('used_count = used_count - 1')) {
      if (Number(args[0]) === this.invite.id && this.invite.usedCount > 0) this.invite.usedCount -= 1;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected run SQL: ${sql}`);
  }
}

describe('reserveLoginAttempt', () => {
  it('并发请求只能原子占用前 5 个失败名额', async () => {
    const db = new AuthMemoryDb();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveLoginAttempt(db as unknown as D1Database, 'a@example.com', 5)),
    );

    expect(results.filter((id) => id !== null)).toHaveLength(5);
    expect(results.filter((id) => id === null)).toHaveLength(5);
  });

  it('占位前清理所有邮箱的过期失败记录', async () => {
    const db = new AuthMemoryDb();
    db.failures.push(
      { id: 1, email: 'old-1@example.com', expired: true },
      { id: 2, email: 'old-2@example.com', expired: true },
      { id: 3, email: 'live@example.com', expired: false },
    );

    await reserveLoginAttempt(db as unknown as D1Database, 'new@example.com', 5);

    expect(db.failures.some((failure) => failure.expired)).toBe(false);
    expect(db.failures.some((failure) => failure.email === 'live@example.com')).toBe(true);
  });
});

describe('createRegisteredUser', () => {
  it('空库并发无邀请码注册时只创建一个用户', async () => {
    const db = new AuthMemoryDb();
    const results = await Promise.all([
      createRegisteredUser(db as unknown as D1Database, 'first@example.com', 'hash', undefined, 'session-1'),
      createRegisteredUser(db as unknown as D1Database, 'second@example.com', 'hash', undefined, 'session-2'),
    ]);

    expect(results.filter((result) => result.kind === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'invite-required')).toHaveLength(1);
    expect(db.users).toHaveLength(1);
    expect(db.users[0]?.is_admin).toBe(1);
  });

  it('邀请码占用与用户插入在同一 batch 事务中回滚', async () => {
    const db = new AuthMemoryDb();
    db.users.push({ id: 1, email: 'admin@example.com', is_admin: 1, daily_message_limit: 100 });
    db.failNextRegularInsert = true;

    await expect(
      createRegisteredUser(db as unknown as D1Database, 'new@example.com', 'hash', 'INVITE', 'session'),
    ).rejects.toThrow('forced insert failure');
    expect(db.batchCalls).toBe(2);
    expect(db.invite.usedCount).toBe(0);
  });
});
