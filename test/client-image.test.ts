import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressImageToDataUrl } from '../src/client/lib/image';

function file(type: string, size: number): File {
  return { type, size } as File;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compressImageToDataUrl', () => {
  it('在解码前拒绝非图片和超过 20MB 的文件', async () => {
    const createImageBitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', createImageBitmap);

    await expect(compressImageToDataUrl(file('text/plain', 12))).rejects.toThrow('请选择图片文件');
    await expect(compressImageToDataUrl(file('image/png', 20 * 1024 * 1024 + 1))).rejects.toThrow('图片太大');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('将 bitmap 解码失败转为用户可读错误', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));

    await expect(compressImageToDataUrl(file('image/png', 100))).rejects.toThrow('无法读取图片');
  });

  it('转 JPEG 前铺白色背景，并在成功后关闭 bitmap', async () => {
    const close = vi.fn();
    const bitmap = { width: 800, height: 600, close };
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const context = { fillStyle: '', fillRect, drawImage };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(context),
      toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,AAAA'),
    };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    vi.stubGlobal('document', { createElement: vi.fn().mockReturnValue(canvas) });

    await expect(compressImageToDataUrl(file('image/png', 100))).resolves.toBe('data:image/jpeg;base64,AAAA');

    expect(context.fillStyle).toBe('#ffffff');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 800, 600);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 800, 600);
    expect(fillRect.mock.invocationCallOrder[0]).toBeLessThan(drawImage.mock.invocationCallOrder[0]!);
    expect(close).toHaveBeenCalledOnce();
  });

  it('画布初始化失败时也关闭 bitmap', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 10, height: 10, close }));
    vi.stubGlobal('document', {
      createElement: vi.fn().mockReturnValue({ width: 0, height: 0, getContext: () => null }),
    });

    await expect(compressImageToDataUrl(file('image/png', 100))).rejects.toThrow('当前浏览器不支持图片处理');
    expect(close).toHaveBeenCalledOnce();
  });
});
