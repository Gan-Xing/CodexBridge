import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveFfmpegPath, resolveFfprobePath } from '../../../../core/media_tool_paths.js';

const execFileAsync = promisify(execFile);
const ffmpegPath = resolveFfmpegPath();
const ffprobePath = resolveFfprobePath();

export interface ProbedMediaInfo {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export async function probeMediaInfo(filePath: string): Promise<ProbedMediaInfo | null> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      filePath,
    ]);
    const parsed = JSON.parse(stdout || '{}') as {
      streams?: Array<Record<string, unknown>>;
      format?: Record<string, unknown>;
    };
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((stream) => stream?.codec_type === 'video') ?? null;
    const width = toNumberOrNull(videoStream?.width);
    const height = toNumberOrNull(videoStream?.height);
    const streamDurationMs = toDurationMs(videoStream?.duration);
    const formatDurationMs = toDurationMs(parsed.format?.duration);
    return {
      width,
      height,
      durationMs: streamDurationMs ?? formatDurationMs,
    };
  } catch {
    return null;
  }
}

export async function createVideoThumbnailJpeg(filePath: string): Promise<{
  filePath: string;
  cleanup: () => Promise<void>;
} | null> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexbridge-weixin-thumb-'));
  const outputPath = path.join(tempDir, 'thumb.jpg');
  try {
    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '0',
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=320:320:force_original_aspect_ratio=decrease',
      '-q:v',
      '2',
      outputPath,
    ]);
    return {
      filePath: outputPath,
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

export async function transcodeStillImageJpeg(filePath: string): Promise<{
  filePath: string;
  cleanup: () => Promise<void>;
} | null> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexbridge-weixin-image-'));
  const outputPath = path.join(tempDir, 'image.jpg');
  try {
    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-pix_fmt',
      'yuvj420p',
      '-q:v',
      '2',
      outputPath,
    ]);
    return {
      filePath: outputPath,
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

export async function normalizeStillImageForWeixin(filePath: string, options: {
  maxBytes: number;
  targetBytes?: number;
}): Promise<{
  filePath: string;
  cleanup: () => Promise<void>;
} | null> {
  const targetBytes = Math.min(options.targetBytes ?? options.maxBytes, options.maxBytes);
  const mediaInfo = await probeMediaInfo(filePath);
  const widthCandidates = buildWidthCandidates(mediaInfo?.width ?? null);
  const ext = path.extname(filePath) || '.img';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexbridge-weixin-image-'));

  let bestCandidatePath: string | null = null;
  let bestCandidateSize = Number.POSITIVE_INFINITY;

  try {
    for (const width of widthCandidates) {
      const outputPath = path.join(tempDir, `image-${width}${ext}`);
      await execFileAsync(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        filePath,
        '-vf',
        `scale=${width}:-2:flags=lanczos`,
        ...buildFormatArgs(ext),
        outputPath,
      ]);
      const stat = await fs.stat(outputPath);
      if (stat.size < bestCandidateSize) {
        bestCandidateSize = stat.size;
        bestCandidatePath = outputPath;
      }
      if (stat.size <= targetBytes) {
        return {
          filePath: outputPath,
          cleanup: async () => {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
          },
        };
      }
    }

    if (bestCandidatePath && bestCandidateSize <= options.maxBytes) {
      return {
        filePath: bestCandidatePath,
        cleanup: async () => {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        },
      };
    }
  } catch {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  return null;
}

function buildWidthCandidates(originalWidth: number | null): number[] {
  const fallback = [960, 896, 832, 768, 704, 640, 576, 512, 448, 384, 352, 320, 288, 272, 264, 256, 224, 192, 160, 128];
  const widths = new Set<number>();
  const normalizedWidth = Number.isFinite(originalWidth) && originalWidth && originalWidth > 0
    ? Math.floor(originalWidth)
    : null;

  if (normalizedWidth && normalizedWidth > 128) {
    let width = normalizedWidth;
    while (width > 128) {
      width = Math.floor((width * 9) / 10);
      width -= width % 8;
      if (width >= 128) {
        widths.add(width);
      }
    }
  }

  for (const candidate of fallback) {
    if (!normalizedWidth || candidate < normalizedWidth) {
      widths.add(candidate);
    }
  }

  return [...widths].sort((a, b) => b - a);
}

function buildFormatArgs(ext: string): string[] {
  const normalized = ext.toLowerCase();
  if (normalized === '.jpg' || normalized === '.jpeg') {
    return ['-pix_fmt', 'yuvj420p'];
  }
  return [];
}

function toNumberOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toDurationMs(value: unknown): number | null {
  const durationSeconds = Number(value);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  return Math.round(durationSeconds * 1000);
}
