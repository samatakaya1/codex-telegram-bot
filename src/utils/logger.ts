import pino from 'pino';

import type { AppConfig } from '../config/env.js';

type LoggerOptions = {
  destination?: pino.DestinationStream;
};

export function createLogger(config: Pick<AppConfig, 'logLevel'>, options: LoggerOptions = {}) {
  return pino(
    {
      level: config.logLevel,
      redact: {
        paths: [
          'telegramBotToken',
          '*.telegramBotToken',
          'config.telegramBotToken',
          'TELEGRAM_BOT_TOKEN',
          '*.TELEGRAM_BOT_TOKEN',
          'botToken',
          '*.botToken',
          'BOT_TOKEN',
          '*.BOT_TOKEN',
          'token',
          '*.token',
          'authorization',
          '*.authorization',
          'Authorization',
          '*.Authorization',
          'headers.authorization',
          'headers.Authorization',
          '*.headers.authorization',
          '*.headers.Authorization',
          'error.headers.authorization',
          'error.headers.Authorization',
          'error.response.headers.authorization',
          'error.response.headers.Authorization',
          'error.config.headers.authorization',
          'error.config.headers.Authorization',
          'error.request.headers.authorization',
          'error.request.headers.Authorization',
          'payload',
          '*.payload',
          'error.payload',
          'error.response.payload',
          'error.request.payload',
          'description',
          '*.description',
          'error.description',
          'error.response.description',
          'update',
          '*.update',
          'telegramUpdate',
          '*.telegramUpdate',
          'codexEvent',
          '*.codexEvent',
          'approvalPayload',
          '*.approvalPayload',
          'approvalRequest',
          '*.approvalRequest',
          'transcript',
          '*.transcript',
          'voiceTranscript',
          '*.voiceTranscript',
          'audioPath',
          '*.audioPath',
          'modelPath',
          '*.modelPath',
          'whisperModelPath',
          '*.whisperModelPath',
          'WHISPER_MODEL_PATH',
          '*.WHISPER_MODEL_PATH',
          'path',
          '*.path',
          'filePath',
          '*.filePath',
          'tmpPath',
          '*.tmpPath',
          'downloadedPath',
          '*.downloadedPath',
          'fileUrl',
          '*.fileUrl',
          'file_path',
          '*.file_path',
          'telegramFilePath',
          '*.telegramFilePath',
          'stdout',
          '*.stdout',
          'stderr',
          '*.stderr'
        ],
        censor: '[redacted]'
      }
    },
    options.destination
  );
}

