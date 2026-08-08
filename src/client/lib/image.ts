const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function compressImageToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > MAX_FILE_BYTES) throw new Error('图片太大（超过 20MB），请换一张或先压缩');

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('无法读取图片，请换一张试试');

  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持图片处理');

    // 透明 PNG 直接转 JPEG 会把透明区域变黑，先铺白底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('图片处理失败，请重试');
    return dataUrl;
  } finally {
    bitmap.close();
  }
}
