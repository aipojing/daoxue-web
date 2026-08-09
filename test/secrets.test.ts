import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/worker/lib/secrets';

// 固定测试主密钥，仅用于单元测试，禁止在生产使用
const masterKey = btoa('0123456789abcdef0123456789abcdef');

describe('AES-GCM 用户 Key 加密', () => {
  it('AES-GCM 可往返且相同明文每次产生不同密文', async () => {
    const first = await encryptSecret(masterKey, 'sk-personal', 'user-ai:v1:1:deepseek');
    const second = await encryptSecret(masterKey, 'sk-personal', 'user-ai:v1:1:deepseek');
    expect(first).not.toEqual(second);
    expect(await decryptSecret(masterKey, first, 'user-ai:v1:1:deepseek')).toBe('sk-personal');
  });

  it('密文不能换用户或换服务解密', async () => {
    const encrypted = await encryptSecret(masterKey, 'secret', 'user-ai:v1:1:deepseek');
    await expect(decryptSecret(masterKey, encrypted, 'user-ai:v1:2:deepseek')).rejects.toThrow();
    await expect(decryptSecret(masterKey, encrypted, 'user-ai:v1:1:vision')).rejects.toThrow();
  });

  it('错误的主密钥无法解密', async () => {
    const encrypted = await encryptSecret(masterKey, 'secret', 'user-ai:v1:1:deepseek');
    const wrongKey = btoa('fedcba9876543210fedcba9876543210');
    await expect(decryptSecret(wrongKey, encrypted, 'user-ai:v1:1:deepseek')).rejects.toThrow();
  });

  it.each(['', btoa('too-short'), 'not-base64!!!'])(
    '拒绝非 32 字节主密钥 %s',
    async (invalid) => {
      await expect(encryptSecret(invalid, 'secret', 'aad')).rejects.toThrow('32 字节');
      await expect(
        decryptSecret(invalid, { ciphertext: 'aa', iv: 'bb' }, 'aad'),
      ).rejects.toThrow('32 字节');
    },
  );

  it('密文或 IV 被篡改时解密失败', async () => {
    const encrypted = await encryptSecret(masterKey, 'secret', 'user-ai:v1:1:deepseek');
    const tamperedCiphertext = Buffer.from(encrypted.ciphertext, 'base64');
    tamperedCiphertext[0] = tamperedCiphertext[0]! ^ 0xff;
    await expect(
      decryptSecret(
        masterKey,
        { ciphertext: tamperedCiphertext.toString('base64'), iv: encrypted.iv },
        'user-ai:v1:1:deepseek',
      ),
    ).rejects.toThrow();
  });
});
