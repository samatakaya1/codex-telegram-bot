import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';

describe('logger', () => {
  it('redacts bot tokens, authorization headers, raw updates, raw codex events, and approval payloads', () => {
    const lines: string[] = [];
    const logger = createLogger(
      { logLevel: 'info' },
      {
        destination: {
          write(chunk: string) {
            lines.push(chunk);
          }
        }
      }
    );

    logger.info(
      {
        telegramBotToken: '123456:telegram-secret',
        TELEGRAM_BOT_TOKEN: 'env-telegram-secret',
        BOT_TOKEN: 'env-bot-secret',
        token: 'plain-token-secret',
        Authorization: 'authorization top-level-secret',
        headers: {
          authorization: 'authorization lower-secret',
          Authorization: 'authorization upper-secret'
        },
        error: {
          response: {
            headers: {
              authorization: 'authorization nested-response-secret'
            }
          },
          config: {
            headers: {
              Authorization: 'authorization nested-config-secret'
            }
          },
          request: {
            headers: {
              authorization: 'authorization nested-request-secret'
            }
          }
        },
        payload: { text: 'raw telegram payload' },
        description: 'raw telegram description',
        update: { message: { text: 'raw telegram update' } },
        telegramUpdate: { callback_query: { data: 'raw callback data' } },
        codexEvent: { method: 'turn/start', params: { text: 'raw codex event' } },
        approvalPayload: { command: 'raw approval payload' },
        approvalRequest: { method: 'approval/request', params: { command: 'raw approval params' } },
        transcript: 'raw voice transcript',
        voiceTranscript: 'raw voice transcript nested',
        audioPath: 'C:\\Bot\\.tmp\\voice\\secret.ogg',
        modelPath: 'C:\\Bot\\.local\\voice\\models\\secret-model',
        whisperModelPath: 'C:\\Bot\\.local\\voice\\models\\secret-whisper-model',
        WHISPER_MODEL_PATH: 'C:\\Bot\\.local\\voice\\models\\secret-env-model',
        path: 'C:\\Bot\\.tmp\\voice\\secret-path.ogg',
        filePath: 'C:\\Bot\\.tmp\\voice\\secret-file-path.ogg',
        tmpPath: 'C:\\Bot\\.tmp\\voice\\secret-tmp-path.ogg',
        downloadedPath: 'C:\\Bot\\.tmp\\voice\\secret-downloaded-path.ogg',
        fileUrl: 'https://api.telegram.org/file/bot123456:secret-token/voice/file.ogg',
        file_path: 'voice/file-secret.ogg',
        telegramFilePath: 'voice/telegram-secret.ogg',
        stdout: 'stdout with private transcript',
        stderr: 'stderr with private audio path',
        nested: { botToken: 'nested-token-secret' }
      },
      'redaction check'
    );

    const output = lines.join('');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('telegram-secret');
    expect(output).not.toContain('env-telegram-secret');
    expect(output).not.toContain('env-bot-secret');
    expect(output).not.toContain('plain-token-secret');
    expect(output).not.toContain('top-level-secret');
    expect(output).not.toContain('lower-secret');
    expect(output).not.toContain('upper-secret');
    expect(output).not.toContain('nested-response-secret');
    expect(output).not.toContain('nested-config-secret');
    expect(output).not.toContain('nested-request-secret');
    expect(output).not.toContain('raw telegram payload');
    expect(output).not.toContain('raw telegram description');
    expect(output).not.toContain('raw telegram update');
    expect(output).not.toContain('raw callback data');
    expect(output).not.toContain('raw codex event');
    expect(output).not.toContain('raw approval payload');
    expect(output).not.toContain('raw approval params');
    expect(output).not.toContain('raw voice transcript');
    expect(output).not.toContain('secret.ogg');
    expect(output).not.toContain('secret-model');
    expect(output).not.toContain('secret-whisper-model');
    expect(output).not.toContain('secret-env-model');
    expect(output).not.toContain('secret-path.ogg');
    expect(output).not.toContain('secret-file-path.ogg');
    expect(output).not.toContain('secret-tmp-path.ogg');
    expect(output).not.toContain('secret-downloaded-path.ogg');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('file-secret');
    expect(output).not.toContain('telegram-secret');
    expect(output).not.toContain('stdout with private transcript');
    expect(output).not.toContain('stderr with private audio path');
    expect(output).not.toContain('nested-token-secret');
  });
});

