/**
 * 用户级 API Key 的 AES-256-GCM 编解码。
 * 主密钥只来自 Worker Secret（AI_SETTINGS_ENCRYPTION_KEY），
 * 密文必须绑定 AAD（用户 + 服务类型），防止跨用户或跨服务替换。
 * 本模块不依赖 D1 与业务逻辑，方便独立测试。
 */
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importMasterKey(value: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw new Error('AI 设置加密主密钥必须是 Base64 编码的 32 字节值');
  }
  if (bytes.byteLength !== 32) throw new Error('AI 设置加密主密钥必须是 32 字节');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(
  masterKeyBase64: string,
  plaintext: string,
  aad: string,
): Promise<EncryptedSecret> {
  const key = await importMasterKey(masterKeyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      additionalData: encoder.encode(aad) as BufferSource,
    },
    key,
    encoder.encode(plaintext) as BufferSource,
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decryptSecret(
  masterKeyBase64: string,
  encrypted: EncryptedSecret,
  aad: string,
): Promise<string> {
  const key = await importMasterKey(masterKeyBase64);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(encrypted.iv) as BufferSource,
      additionalData: encoder.encode(aad) as BufferSource,
    },
    key,
    base64ToBytes(encrypted.ciphertext) as BufferSource,
  );
  return decoder.decode(plaintext);
}
