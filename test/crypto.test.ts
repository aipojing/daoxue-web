import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, generateToken, sha256Hex } from '../src/worker/auth/crypto';

describe('password hashing', () => {
  it('hash 后 verify 正确密码返回 true', async () => {
    const stored = await hashPassword('my-secret-pw');
    expect(stored.startsWith('pbkdf2$100000$')).toBe(true);
    expect(await verifyPassword('my-secret-pw', stored)).toBe(true);
  });

  it('错误密码返回 false', async () => {
    const stored = await hashPassword('my-secret-pw');
    expect(await verifyPassword('wrong-pw', stored)).toBe(false);
  });

  it('相同密码两次 hash 结果不同（随机盐）', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });

  it('格式损坏的存储值返回 false 而不是抛错', async () => {
    expect(await verifyPassword('pw', 'garbage')).toBe(false);
  });
});

describe('token', () => {
  it('generateToken 足够长且不重复', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).not.toBe(b);
  });

  it('sha256Hex 稳定输出', async () => {
    const h1 = await sha256Hex('abc');
    const h2 = await sha256Hex('abc');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
