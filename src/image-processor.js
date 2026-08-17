import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import exifr from 'exifr';

const accepted = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export class ImageProcessor {
  constructor(config) { this.config = config; }

  async process(tempPath, mimeType, assetId, originalName, discoveredAt) {
    if (!accepted.has(mimeType)) throw new Error(`不支持的图片格式：${mimeType}`);
    await fs.mkdir(this.config.imageDir, { recursive: true });
    const input = await fs.readFile(tempPath);
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    const metadata = await sharp(input, { limitInputPixels: 100_000_000 }).metadata();
    const exif = await exifr.parse(input, {
      tiff: true, exif: true, gps: true, ifd0: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'latitude', 'longitude', 'Make', 'Model', 'LensModel'],
    }).catch(() => ({}));
    const base = path.join(this.config.imageDir, assetId);
    const masterPath = `${base}.webp`;
    const thumbnailPath = `${base}.thumb.webp`;
    const normalized = sharp(input, { limitInputPixels: 100_000_000 }).rotate();
    await normalized.clone().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84, effort: 4 }).toFile(masterPath);
    await normalized.clone().resize({ width: 480, height: 480, fit: 'cover', position: 'attention', withoutEnlargement: true })
      .webp({ quality: 76, effort: 3 }).toFile(thumbnailPath);
    const output = await sharp(masterPath).metadata();
    if (!output.width || !output.height || output.format !== 'webp') throw new Error('压缩主图校验失败');
    const date = exif?.DateTimeOriginal || exif?.CreateDate;
    return {
      hash, masterPath, thumbnailPath, width: output.width, height: output.height,
      facts: {
        originalName, inputWidth: metadata.width ?? null, inputHeight: metadata.height ?? null,
        orientation: metadata.orientation ?? null, format: metadata.format ?? null,
        discoveredAt, exifDateTaken: date instanceof Date ? date.toISOString() : null,
        offsetTimeOriginal: exif?.OffsetTimeOriginal ?? null,
        latitude: finite(exif?.latitude), longitude: finite(exif?.longitude),
        make: exif?.Make ?? null, model: exif?.Model ?? null, lens: exif?.LensModel ?? null,
      },
    };
  }
}

function finite(value) { return Number.isFinite(value) ? value : null; }
