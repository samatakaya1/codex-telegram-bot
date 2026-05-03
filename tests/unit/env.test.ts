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
  it('parses the owner-only configuration', () => {
    const config = parseConfig(validEnv);

    expect(config.telegramBotToken).toBe('123456:token');
    expect(config.telegramOwnerId).toBe(42);
    expect(config.codexWsUrl).toBe('ws://127.0.0.1:18765');
    expect(config.codexGlobalStatePath).toBe('C:\\CodexHome\\.codex-global-state.json');
    expect(config.projectsRoot).toBe('C:\\Workspace');
    expect(config.promptConfigDir).toBe('prompt-configs');
    expect(config.logLevel).toBe('debug');
    expect(config.botRunMode).toBe('DEV');
    expect(config.voiceTranscription).toEqual({
      enabled: false,
      backend: 'faster-whisper',
      tmpDir: '.tmp/voice',
      maxFileMb: 20,
      maxDurationSeconds: 600,
      timeoutSeconds: 120,
      previewMaxChars: 3500,
      maxTextChars: 12000,
      fasterWhisperPython: '.local/voice/faster-whisper/.venv/Scripts/python.exe',
      hfHome: '.local/voice/hf-cache',
      whisperModelPath: '.local/voice/models/faster-whisper-large-v3',
      whisperDevice: 'cuda',
      whisperComputeType: 'float16',
      whisperLanguage: 'auto',
      whisperBeamSize: 5,
      whisperVadFilter: true
    });
  });

  it('parses a custom prompt config directory', () => {
    const config = parseConfig({ ...validEnv, PROMPT_CONFIG_DIR: 'C:\\Bot\\prompt-configs' });

    expect(config.promptConfigDir).toBe('C:\\Bot\\prompt-configs');
  });

  it('parses PROD bot run mode', () => {
    const config = parseConfig({ ...validEnv, BOT_RUN_MODE: 'PROD' });

    expect(config.botRunMode).toBe('PROD');
  });

  it('parses custom voice transcription settings', () => {
    const config = parseConfig({
      ...validEnv,
      VOICE_TRANSCRIPTION_ENABLED: 'true',
      VOICE_TRANSCRIPTION_TMP_DIR: 'C:\\Bot\\.tmp\\voice',
      VOICE_TRANSCRIPTION_MAX_FILE_MB: '7',
      VOICE_TRANSCRIPTION_MAX_DURATION_SECONDS: '90',
      VOICE_TRANSCRIPTION_TIMEOUT_SECONDS: '30',
      VOICE_TRANSCRIPTION_PREVIEW_MAX_CHARS: '1000',
      VOICE_TRANSCRIPTION_MAX_TEXT_CHARS: '2000',
      FASTER_WHISPER_PYTHON: 'C:\\Python\\python.exe',
      HF_HOME: 'C:\\Bot\\.cache\\hf',
      WHISPER_MODEL_PATH: 'C:\\Models\\large-v3',
      WHISPER_COMPUTE_TYPE: 'int8_float16',
      WHISPER_LANGUAGE: 'ru',
      WHISPER_BEAM_SIZE: '3',
      WHISPER_VAD_FILTER: 'false'
    });

    expect(config.voiceTranscription).toMatchObject({
      enabled: true,
      tmpDir: 'C:\\Bot\\.tmp\\voice',
      maxFileMb: 7,
      maxDurationSeconds: 90,
      timeoutSeconds: 30,
      previewMaxChars: 1000,
      maxTextChars: 2000,
      fasterWhisperPython: 'C:\\Python\\python.exe',
      hfHome: 'C:\\Bot\\.cache\\hf',
      whisperModelPath: 'C:\\Models\\large-v3',
      whisperDevice: 'cuda',
      whisperComputeType: 'int8_float16',
      whisperLanguage: 'ru',
      whisperBeamSize: 3,
      whisperVadFilter: false
    });
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

  it('rejects invalid voice transcription limits', () => {
    expect(() => parseConfig({ ...validEnv, VOICE_TRANSCRIPTION_MAX_FILE_MB: '0' })).toThrow(
      /VOICE_TRANSCRIPTION_MAX_FILE_MB/
    );
    expect(() => parseConfig({ ...validEnv, VOICE_TRANSCRIPTION_PREVIEW_MAX_CHARS: '5000' })).toThrow(
      /VOICE_TRANSCRIPTION_PREVIEW_MAX_CHARS/
    );
    expect(() => parseConfig({ ...validEnv, WHISPER_BEAM_SIZE: '0' })).toThrow(/WHISPER_BEAM_SIZE/);
    expect(() => parseConfig({ ...validEnv, WHISPER_DEVICE: 'cpu' })).toThrow(/WHISPER_DEVICE/);
  });
});
