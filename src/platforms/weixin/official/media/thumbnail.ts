import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProbedMediaInfo {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export async function probeMediaInfo(filePath: string): Promise<ProbedMediaInfo | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
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
    await execFileAsync('ffmpeg', [
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
