import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

type TelegramFile = {
  file_path?: string;
  file_size?: number;
};

type GetTelegramFile = (fileId: string) => Promise<TelegramFile>;
type FetchFile = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type DownloadedVoiceFile = {
  path: string;
  sizeBytes: number;
};

type TelegramVoiceDownloaderOptions = {
  botToken: string;
  tmpDir: string;
  maxFileBytes: number;
  downloadTimeoutMs?: number;
  getFile: GetTelegramFile;
  fetchFile?: FetchFile;
};

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const GENERATED_VOICE_TEMP_FILE_PATTERN = /^voice-[0-9a-f]{24}(?:\.[A-Za-z0-9]+)?$/;

export class TelegramVoiceDownloadError extends Error {
  constructor(
    readonly code: 'file_too_large' | 'invalid_file_path' | 'download_failed',
    message = 'Could not download Telegram voice file.'
  ) {
    super(message);
    this.name = 'TelegramVoiceDownloadError';
  }
}

export function createTelegramVoiceDownloader(options: TelegramVoiceDownloaderOptions) {
  const fetchFile = options.fetchFile ?? ((url: string, init?: { signal?: AbortSignal }) => fetch(url, init));
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  return {
    async download(params: { fileId: string; declaredSizeBytes?: number }): Promise<DownloadedVoiceFile> {
      assertWithinSizeLimit(params.declaredSizeBytes, options.maxFileBytes);

      const file = await options.getFile(params.fileId);
      assertWithinSizeLimit(file.file_size, options.maxFileBytes);

      const filePath = parseTelegramFilePath(file.file_path);
      const url = createTelegramFileUrl(options.botToken, filePath);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);
      timeout.unref?.();
      let response: Response;
      try {
        response = await fetchFile(url, { signal: controller.signal });
        if (!response.ok) {
          throw new TelegramVoiceDownloadError('download_failed');
        }

        const contentLength = numberFromHeader(response.headers.get('content-length'));
        assertWithinSizeLimit(contentLength, options.maxFileBytes);

        const bytes = await readResponseBytes(response, options.maxFileBytes, controller.signal);
        assertWithinSizeLimit(bytes.byteLength, options.maxFileBytes);

        await mkdir(options.tmpDir, { recursive: true });
        const outputPath = path.join(options.tmpDir, `voice-${randomBytes(12).toString('hex')}${extensionFromFilePath(filePath)}`);
        await writeFile(outputPath, bytes);
        return { path: outputPath, sizeBytes: bytes.byteLength };
      } catch (error) {
        if (error instanceof TelegramVoiceDownloadError) {
          throw error;
        }
        throw new TelegramVoiceDownloadError('download_failed');
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

export async function deleteDownloadedVoiceFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export async function cleanupOldVoiceTempFiles(params: {
  tmpDir: string;
  nowMs?: number;
  maxAgeMs: number;
}): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(params.tmpDir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  const nowMs = params.nowMs ?? Date.now();
  for (const entry of entries) {
    if (!GENERATED_VOICE_TEMP_FILE_PATTERN.test(entry)) {
      continue;
    }

    const filePath = path.join(params.tmpDir, entry);
    try {
      const fileStat = await stat(filePath);
      if (nowMs - fileStat.mtimeMs > params.maxAgeMs) {
        await rm(filePath, { force: true });
        removed.push(filePath);
      }
    } catch {
      // Best-effort cleanup should not block bot startup.
    }
  }
  return removed;
}

function assertWithinSizeLimit(sizeBytes: number | undefined, maxFileBytes: number): void {
  if (sizeBytes !== undefined && sizeBytes > maxFileBytes) {
    throw new TelegramVoiceDownloadError('file_too_large', 'Voice file is too large.');
  }
}

function parseTelegramFilePath(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.includes('..') || /^[\\/]/.test(value)) {
    throw new TelegramVoiceDownloadError('invalid_file_path');
  }
  return value.replace(/\\/g, '/');
}

function createTelegramFileUrl(botToken: string, filePath: string): string {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  return `https://api.telegram.org/file/bot${botToken}/${encodedPath}`;
}

async function readResponseBytes(response: Response, maxFileBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) {
    throw new TelegramVoiceDownloadError('download_failed');
  }

  const reader = response.body.getReader();
  const abortReader = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', abortReader, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      if (signal?.aborted === true) {
        throw new TelegramVoiceDownloadError('download_failed');
      }
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maxFileBytes) {
        await reader.cancel();
        throw new TelegramVoiceDownloadError('file_too_large', 'Voice file is too large.');
      }
      chunks.push(result.value);
    }
  } finally {
    signal?.removeEventListener('abort', abortReader);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function extensionFromFilePath(filePath: string): string {
  const extension = path.posix.extname(filePath);
  return extension.length === 0 ? '.ogg' : extension;
}

function numberFromHeader(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
