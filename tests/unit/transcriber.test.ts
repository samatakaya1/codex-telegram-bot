import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_VOICE_TRANSCRIPTION_CONFIG } from '../../src/config/env.js';
import { createFasterWhisperTranscriber, VoiceTranscriptionError } from '../../src/voice/transcriber.js';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.map((dir) => rm(dir, { force: true, recursive: true })));
  createdDirs.length = 0;
});

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voice-transcriber-'));
  createdDirs.push(dir);
  return dir;
}

describe('createFasterWhisperTranscriber', () => {
  it('invokes the local faster-whisper helper with configured arguments', async () => {
    const runProcess = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ text: 'распознанный текст', language: 'ru', durationSeconds: 3.1 }),
      stderr: ''
    }));
    const transcriber = createFasterWhisperTranscriber(
      {
        ...DEFAULT_VOICE_TRANSCRIPTION_CONFIG,
        fasterWhisperPython: 'C:\\Python\\python.exe',
        hfHome: 'C:\\Bot\\.cache\\hf',
        whisperModelPath: 'C:\\Models\\large-v3',
        whisperLanguage: 'ru',
        whisperBeamSize: 3,
        whisperVadFilter: false
      },
      { runProcess, helperPath: 'tools/voice/faster-whisper/transcribe.py' }
    );

    const result = await transcriber.transcribe('C:\\Bot\\.tmp\\voice\\input.ogg');

    expect(result).toEqual({ text: 'распознанный текст', language: 'ru', durationSeconds: 3.1 });
    expect(runProcess).toHaveBeenCalledWith({
      command: 'C:\\Python\\python.exe',
      args: [
        'tools/voice/faster-whisper/transcribe.py',
        '--audio',
        'C:\\Bot\\.tmp\\voice\\input.ogg',
        '--model',
        'C:\\Models\\large-v3',
        '--device',
        'cuda',
        '--compute-type',
        'float16',
        '--language',
        'ru',
        '--beam-size',
        '3',
        '--vad-filter',
        'false'
      ],
      env: { HF_HOME: 'C:\\Bot\\.cache\\hf', PYTHONIOENCODING: 'utf-8' },
      timeoutMs: 120000,
      maxStdoutChars: 64_000
    });
  });

  it('returns empty transcripts so Telegram can show a precise empty-voice message', async () => {
    const runProcess = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ text: '   ' }),
      stderr: ''
    }));
    const transcriber = createFasterWhisperTranscriber(DEFAULT_VOICE_TRANSCRIPTION_CONFIG, { runProcess });

    await expect(transcriber.transcribe('C:\\secret\\voice.ogg')).resolves.toMatchObject({ text: '' });
  });

  it('rejects non-zero helper exits with sanitized errors', async () => {
    const runProcess = vi.fn(async () => ({
      exitCode: 2,
      stdout: '{"text":"private transcript"}',
      stderr: 'failed on C:\\secret\\voice.ogg'
    }));
    const transcriber = createFasterWhisperTranscriber(DEFAULT_VOICE_TRANSCRIPTION_CONFIG, { runProcess });

    await expect(transcriber.transcribe('C:\\secret\\voice.ogg')).rejects.toThrow(
      'Voice transcription failed. Check local voice setup and try again.'
    );
    await expect(transcriber.transcribe('C:\\secret\\voice.ogg')).rejects.toBeInstanceOf(VoiceTranscriptionError);
    await expect(transcriber.transcribe('C:\\secret\\voice.ogg')).rejects.not.toThrow('private transcript');
    await expect(transcriber.transcribe('C:\\secret\\voice.ogg')).rejects.not.toThrow('voice.ogg');
  });

  it('attaches sanitized helper stderr details to non-zero exits', async () => {
    const runProcess = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: JSON.stringify({
        error: 'transcription_failed',
        errorType: 'RuntimeError',
        errorCode: 'audio_decode_failed'
      })
    }));
    const transcriber = createFasterWhisperTranscriber(DEFAULT_VOICE_TRANSCRIPTION_CONFIG, { runProcess });

    await expect(transcriber.transcribe('C:\\secret\\voice.ogg')).rejects.toMatchObject({
      code: 'helper_failed',
      details: {
        helperErrorCode: 'audio_decode_failed',
        helperErrorType: 'RuntimeError'
      }
    });
  });

  it('rejects invalid JSON output as a sanitized helper failure', async () => {
    const runProcess = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'not json with private transcript',
      stderr: ''
    }));
    const transcriber = createFasterWhisperTranscriber(DEFAULT_VOICE_TRANSCRIPTION_CONFIG, { runProcess });

    await expect(transcriber.transcribe('C:\\secret\\voice.ogg')).rejects.toMatchObject({
      code: 'invalid_output'
    });
  });

  it('parses long injected helper transcripts', async () => {
    const longTranscript = 'x'.repeat(70_000);
    const runProcess = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ text: longTranscript }),
      stderr: 'diagnostic output that may be capped'
    }));
    const transcriber = createFasterWhisperTranscriber(DEFAULT_VOICE_TRANSCRIPTION_CONFIG, { runProcess });

    await expect(transcriber.transcribe('C:\\secret\\voice.ogg')).resolves.toMatchObject({ text: longTranscript });
  });

  it('does not truncate real helper stdout below the configured transcript cap', async () => {
    const dir = await tempDir();
    const helperPath = path.join(dir, 'long-output-helper.cjs');
    await writeFile(
      helperPath,
      "const text = 'x'.repeat(70000);\nprocess.stdout.write(JSON.stringify({ text }));\n",
      'utf8'
    );
    const transcriber = createFasterWhisperTranscriber(
      {
        ...DEFAULT_VOICE_TRANSCRIPTION_CONFIG,
        fasterWhisperPython: process.execPath,
        maxTextChars: 75_000
      },
      { helperPath }
    );

    await expect(transcriber.transcribe('C:\\secret\\voice.ogg')).resolves.toMatchObject({ text: 'x'.repeat(70_000) });
  });

  it('does not expose ambient secrets to the helper process environment', async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '123456:secret-token';
    try {
      const dir = await tempDir();
      const helperPath = path.join(dir, 'env-helper.cjs');
      await writeFile(
        helperPath,
        [
          'const payload = {',
          '  hasTelegramToken: process.env.TELEGRAM_BOT_TOKEN !== undefined,',
          '  hfHome: process.env.HF_HOME,',
          '  pythonIoEncoding: process.env.PYTHONIOENCODING',
          '};',
          'process.stdout.write(JSON.stringify({ text: JSON.stringify(payload) }));'
        ].join('\n'),
        'utf8'
      );
      const transcriber = createFasterWhisperTranscriber(
        {
          ...DEFAULT_VOICE_TRANSCRIPTION_CONFIG,
          fasterWhisperPython: process.execPath,
          hfHome: 'C:\\Bot\\.cache\\hf'
        },
        { helperPath }
      );

      const result = await transcriber.transcribe('C:\\secret\\voice.ogg');

      expect(JSON.parse(result.text)).toEqual({
        hasTelegramToken: false,
        hfHome: 'C:\\Bot\\.cache\\hf',
        pythonIoEncoding: 'utf-8'
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
    }
  });
});
