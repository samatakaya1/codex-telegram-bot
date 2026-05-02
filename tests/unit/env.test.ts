import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config/env.js';

const validEnv = {
  TELEGRAM_BOT_TOKEN: '123456:token',
  TELEGRAM_OWNER_ID: '42',
  CODEX_WS_URL: 'ws://127.0.0.1:18765',
  CODEX_GLOBAL_STATE_PATH: 'C:\\CodexHome\\.codex-global-state.json',
  PROJECTS_ROOT: 'C:\\Workspace',
  LOG_LEVEL: 'debug'
};

describe('parseConfig', () => {
  it('parses the owner-only MVP configuration', () => {
    const config = parseConfig(validEnv);

    expect(config.telegramBotToken).toBe('123456:token');
    expect(config.telegramOwnerId).toBe(42);
    expect(config.codexWsUrl).toBe('ws://127.0.0.1:18765');
    expect(config.codexGlobalStatePath).toBe('C:\\CodexHome\\.codex-global-state.json');
    expect(config.projectsRoot).toBe('C:\\Workspace');
    expect(config.promptConfigDir).toBe('prompt-configs');
    expect(config.logLevel).toBe('debug');
    expect(config.botRunMode).toBe('DEV');
  });

  it('parses a custom prompt config directory', () => {
    const config = parseConfig({ ...validEnv, PROMPT_CONFIG_DIR: 'C:\\Bot\\prompt-configs' });

    expect(config.promptConfigDir).toBe('C:\\Bot\\prompt-configs');
  });

  it('parses PROD bot run mode', () => {
    const config = parseConfig({ ...validEnv, BOT_RUN_MODE: 'PROD' });

    expect(config.botRunMode).toBe('PROD');
  });

  it('rejects a missing Telegram bot token', () => {
    expect(() => parseConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: '' })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('rejects a non-numeric owner id', () => {
    expect(() => parseConfig({ ...validEnv, TELEGRAM_OWNER_ID: 'owner' })).toThrow(/TELEGRAM_OWNER_ID/);
  });

  it('accepts any positive numeric owner id supplied by environment', () => {
    expect(parseConfig({ ...validEnv, TELEGRAM_OWNER_ID: '123' }).telegramOwnerId).toBe(123);
  });

  it('rejects non-websocket Codex URLs', () => {
    expect(() => parseConfig({ ...validEnv, CODEX_WS_URL: 'https://127.0.0.1:18765' })).toThrow(/CODEX_WS_URL/);
  });

  it('rejects log levels unsupported by pino', () => {
    expect(() => parseConfig({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('rejects unsupported bot run modes', () => {
    expect(() => parseConfig({ ...validEnv, BOT_RUN_MODE: 'STAGING' })).toThrow(/BOT_RUN_MODE/);
  });
});
