import { ProviderCallError } from './adapters/errors';

const MPEG1_BITRATES: Record<number, readonly number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};

const MPEG2_BITRATES: Record<number, readonly number[]> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function invalidMp3(): never {
  throw new ProviderCallError('invalid_model_output', 502);
}

function syncSafe(bytes: Uint8Array, offset: number): number {
  const parts = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
  if (parts.some((part) => part === undefined || (part & 0x80) !== 0)) invalidMp3();
  return ((parts[0]! << 21) | (parts[1]! << 14) | (parts[2]! << 7) | parts[3]!) >>> 0;
}

export function readMp3DurationMs(buffer: ArrayBuffer): number {
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    if (bytes[3]! < 2 || bytes[3]! > 4 || bytes[4] === 0xff) invalidMp3();
    const flags = bytes[5]!;
    const tagSize = syncSafe(bytes, 6);
    offset = 10 + tagSize + ((flags & 0x10) !== 0 ? 10 : 0);
    if (offset > bytes.length) invalidMp3();
  }

  let durationMs = 0;
  let frames = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) invalidMp3();
    const header = ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
    if ((header >>> 21) !== 0x7ff) invalidMp3();
    const versionBits = (header >>> 19) & 0b11;
    const layerBits = (header >>> 17) & 0b11;
    const bitrateIndex = (header >>> 12) & 0b1111;
    const sampleRateIndex = (header >>> 10) & 0b11;
    const padding = (header >>> 9) & 1;
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
      invalidMp3();
    }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    const bitrate = (version === 1 ? MPEG1_BITRATES[layer] : MPEG2_BITRATES[layer])?.[bitrateIndex];
    const baseRate = [44_100, 48_000, 32_000][sampleRateIndex];
    if (!bitrate || !baseRate) invalidMp3();
    const sampleRate = version === 1 ? baseRate : version === 2 ? baseRate / 2 : baseRate / 4;
    const frameLength = layer === 1
      ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4
      : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate * 1000) / sampleRate + padding);
    const samples = layer === 1 ? 384 : layer === 2 || version === 1 ? 1152 : 576;
    if (frameLength < 4 || offset + frameLength > bytes.length) invalidMp3();
    durationMs += (samples * 1000) / sampleRate;
    frames += 1;
    offset += frameLength;
  }
  if (frames === 0 || !Number.isFinite(durationMs) || durationMs <= 0) invalidMp3();
  return Math.round(durationMs);
}
