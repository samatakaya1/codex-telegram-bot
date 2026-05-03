import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupOldVoiceTempFiles,
  createTelegramVoiceDownloader,
  deleteDownloadedVoiceFile
} from '../../src/voice/telegramFileDownloader.js';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.map((dir) => rm(dir, { force: true, recursive: true })));
  createdDirs.length = 0;
});

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voice-downloader-'));
  createdDirs.push(dir);
  return dir;
}

function responseFromBytes(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return new Response(bytes, { status: 200, headers });
}

describe('createTelegramVoiceDownloader', () => {
  it('rejects declared oversized files before calling Telegram getFile', async () => {
    const getFile = vi.fn();
    const fetchFile = vi.fn();
    const downloader = createTelegramVoiceDownloader({
      botToken: '123456:secret-token',
      tmpDir: await tempDir(),
      maxFileBytes: 10,
      getFile,
      fetchFile
    });

    await expect(downloader.download({ fileId: 'voice-file', declaredSizeBytes: 11 })).rejects.toMatchObject({
      code: 'file_too_large'
    });
    expect(getFile).not.toHaveBeenCalled();
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('rejects invalid Telegram file paths without exposing them', async () => {
    const downloader = createTelegramVoiceDownloader({
      botToken: '123456:secret-token',
      tmpDir: await tempDir(),
      maxFileBytes: 100,
      getFile: vi.fn(async () => ({ file_path: '../secret.ogg' })),
      fetchFile: vi.fn()
    });

    await expect(downloader.download({ fileId: 'voice-file' })).rejects.toThrow('Could not download Telegram voice file.');
    await expect(downloader.download({ fileId: 'voice-file' })).rejects.not.toThrow('secret.ogg');
  });

  it('rejects content-length over the byte cap before reading the body', async () => {
    const fetchFile = vi.fn(async () => responseFromBytes(new Uint8Array([1, 2, 3]), { 'content-length': '11' }));
    const downloader = createTelegramVoiceDownloader({
      botToken: '123456:secret-token',
      tmpDir: await tempDir(),
      maxFileBytes: 10,
      getFile: vi.fn(async () => ({ file_path: 'voice/file.ogg' })),
      fetchFile
    });

    await expect(downloader.download({ fileId: 'voice-file' })).rejects.toMatchObject({ code: 'file_too_large' });
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  it('caps streaming downloads and does not leak the Telegram file URL in errors', async () => {
    const fetchFile = vi.fn(async () => responseFromBytes(new Uint8Array([1, 2, 3, 4])));
    const downloader = createTelegramVoiceDownloader({
      botToken: '123456:secret-token',
      tmpDir: await tempDir(),
      maxFileBytes: 3,
      getFile: vi.fn(async () => ({ file_path: 'voice/file-secret.ogg' })),
      fetchFile
    });

    await expect(downloader.download({ fileId: 'voice-file' })).rejects.toThrow('Voice file is too large.');
    await expect(downloader.download({ fileId: 'voice-file' })).rejects.not.toThrow('secret-token');
    await expect(downloader.download({ fileId: 'voice-file' })).rejects.not.toThrow('file-secret');
  });

  it('rejects body-less responses without buffering arrayBuffer', async () => {
    const arrayBuffer = vi.fn(async () => new Uint8Array(100).buffer);
    const fetchFile = vi.fn(
      async () =>
        ({
          ok: true,
          headers: new Headers(),
          body: null,
          arrayBuffer
        }) as unknown as Response
    );
    const downloader = createTelegramVoiceDownloader({
      botToken: '123456:secret-token',
      tmpDir: await tempDir(),
      maxFileBytes: 10,
      getFile: vi.fn(async () => ({ file_path: 'voice/file.ogg' })),
      fetchFile
    });

    await expect(downloader.download({ fileId: 'voice-file' })).rejects.toMatchObject({ code: 'download_failed' });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('aborts stalled Telegram file fetches', async () => {
    vi.useFakeTimers();
    try {
      const downloader = createTelegramVoiceDownloader({
        botToken: '123456:secret-token',
        tmpDir: await tempDir(),
        maxFileBytes: 10,
        downloadTimeoutMs: 100,
        getFile: vi.fn(async () => ({ file_path: 'voice/file.ogg' })),
        fetchFile: vi.fn(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })
        )
      });

      const download = downloader.download({ fileId: 'voice-file' });
      const expectation = expect(download).rejects.toMatchObject({ code: 'download_failed' });
      await vi.advanceTimersByTimeAsync(101);

      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes downloaded bytes to a temp file and deletes it on request', async () => {
    const dir = await tempDir();
    const downloader = createTelegramVoiceDownloader({
      botToken: '123456:secret-token',
      tmpDir: dir,
      maxFileBytes: 10,
      getFile: vi.fn(async () => ({ file_path: 'voice/file.ogg' })),
      fetchFile: vi.fn(async () => responseFromBytes(new Uint8Array([1, 2, 3])))
    });

    const downloaded = await downloader.download({ fileId: 'voice-file' });

    expect(downloaded.sizeBytes).toBe(3);
    expect(path.dirname(downloaded.path)).toBe(dir);
    expect(await readFile(downloaded.path)).toEqual(Buffer.from([1, 2, 3]));

    await deleteDownloadedVoiceFile(downloaded.path);

    await expect(stat(downloaded.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('cleanupOldVoiceTempFiles', () => {
  it('removes stale generated voice temp files and leaves unrelated voice-prefixed files', async () => {
    const dir = await tempDir();
    const stale = path.join(dir, 'voice-1234567890abcdef12345678.ogg');
    const fresh = path.join(dir, 'voice-abcdefabcdefabcdefabcdef.ogg');
    const unrelated = path.join(dir, 'voice-old.ogg');
    await writeFile(stale, 'old');
    await writeFile(fresh, 'new');
    await writeFile(unrelated, 'unrelated');

    const removed = await cleanupOldVoiceTempFiles({ tmpDir: dir, nowMs: Date.now() + 60_000, maxAgeMs: 1 });

    expect(removed).toContain(stale);
    expect(removed).not.toContain(unrelated);
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('unrelated');
  });
});
