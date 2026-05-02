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
    expect(output).not.toContain('nested-token-secret');
  });
});

