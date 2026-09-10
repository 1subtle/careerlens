const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_PHOTO_BYTES = 1024 * 1024;

export function isResumePhoto(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

export async function prepareResumePhoto(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('请选择 PNG 或 JPG 照片。');
  if (!file.size || file.size > MAX_SOURCE_BYTES)
    throw new Error('照片需小于 10 MB，请选择压缩后的图片。');
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
    (byte, i) => header[i] === byte
  );
  if (!jpeg && !png) throw new Error('文件内容不是有效的 PNG 或 JPG 照片。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('照片无法读取，请换一张图片。'));
      image.src = url;
    });
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height || width * height > 60_000_000)
      throw new Error('照片尺寸过大或无法读取，请先缩小图片。');
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 480;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理照片，请换一个浏览器重试。');
    const cropWidth = Math.min(width, (height * 3) / 4);
    const cropHeight = (cropWidth * 4) / 3;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      image,
      (width - cropWidth) / 2,
      (height - cropHeight) / 2,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );
    const photo = canvas.toDataURL('image/jpeg', 0.88);
    if (!isResumePhoto(photo) || Math.ceil((photo.split(',')[1].length * 3) / 4) > MAX_PHOTO_BYTES)
      throw new Error('照片处理失败，请选择较小的图片。');
    return photo;
  } finally {
    URL.revokeObjectURL(url);
  }
}
