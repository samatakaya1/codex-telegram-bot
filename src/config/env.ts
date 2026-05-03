import { z } from 'zod';

const booleanEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

function integerEnv(name: string, min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/, `${name} must be numeric`)
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value) && value >= min && value <= max, `${name} must be between ${min} and ${max}`);
}

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_OWNER_ID: z
    .string()
    .regex(/^\d+$/, 'TELEGRAM_OWNER_ID must be numeric')
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value) && value > 0, 'TELEGRAM_OWNER_ID must be a positive safe integer'),
  CODEX_WS_URL: z
    .string()
    .trim()
    .url('CODEX_WS_URL must be a valid websocket URL')
    .refine((value) => value.startsWith('ws://') || value.startsWith('wss://'), 'CODEX_WS_URL must start with ws:// or wss://'),
  CODEX_GLOBAL_STATE_PATH: z.string().trim().min(1, 'CODEX_GLOBAL_STATE_PATH is required'),
  PROJECTS_ROOT: z.string().trim().min(1, 'PROJECTS_ROOT is required'),
  PROMPT_CONFIG_DIR: z.string().trim().min(1, 'PROMPT_CONFIG_DIR must not be empty').default('prompt-configs'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  BOT_RUN_MODE: z.enum(['DEV', 'PROD']).default('DEV'),
  VOICE_TRANSCRIPTION_ENABLED: booleanEnv.default('false'),
  VOICE_TRANSCRIPTION_BACKEND: z.literal('faster-whisper').default('faster-whisper'),
  VOICE_TRANSCRIPTION_TMP_DIR: z.string().trim().min(1, 'VOICE_TRANSCRIPTION_TMP_DIR must not be empty').default('.tmp/voice'),
  VOICE_TRANSCRIPTION_MAX_FILE_MB: integerEnv('VOICE_TRANSCRIPTION_MAX_FILE_MB', 1, 20).default('20'),
  VOICE_TRANSCRIPTION_MAX_DURATION_SECONDS: integerEnv('VOICE_TRANSCRIPTION_MAX_DURATION_SECONDS', 1, 3600).default('600'),
  VOICE_TRANSCRIPTION_TIMEOUT_SECONDS: integerEnv('VOICE_TRANSCRIPTION_TIMEOUT_SECONDS', 1, 1800).default('120'),
  VOICE_TRANSCRIPTION_PREVIEW_MAX_CHARS: integerEnv('VOICE_TRANSCRIPTION_PREVIEW_MAX_CHARS', 1, 3900).default('3500'),
  VOICE_TRANSCRIPTION_MAX_TEXT_CHARS: integerEnv('VOICE_TRANSCRIPTION_MAX_TEXT_CHARS', 1, 100000).default('12000'),
  FASTER_WHISPER_PYTHON: z
    .string()
    .trim()
    .min(1, 'FASTER_WHISPER_PYTHON must not be empty')
    .default('.local/voice/faster-whisper/.venv/Scripts/python.exe'),
  HF_HOME: z.string().trim().min(1, 'HF_HOME must not be empty').default('.local/voice/hf-cache'),
  WHISPER_MODEL_PATH: z
    .string()
    .trim()
    .min(1, 'WHISPER_MODEL_PATH must not be empty')
    .default('.local/voice/models/faster-whisper-large-v3'),
  WHISPER_DEVICE: z.literal('cuda').default('cuda'),
  WHISPER_COMPUTE_TYPE: z.enum(['float16', 'float32', 'int8', 'int8_float16']).default('float16'),
  WHISPER_LANGUAGE: z.string().trim().min(1, 'WHISPER_LANGUAGE must not be empty').default('auto'),
  WHISPER_BEAM_SIZE: integerEnv('WHISPER_BEAM_SIZE', 1, 10).default('5'),
  WHISPER_VAD_FILTER: booleanEnv.default('true')
});

export type VoiceTranscriptionConfig = {
  enabled: boolean;
  backend: 'faster-whisper';
  tmpDir: string;
  maxFileMb: number;
  maxDurationSeconds: number;
  timeoutSeconds: number;
  previewMaxChars: number;
  maxTextChars: number;
  fasterWhisperPython: string;
  hfHome: string;
  whisperModelPath: string;
  whisperDevice: 'cuda';
  whisperComputeType: 'float16' | 'float32' | 'int8' | 'int8_float16';
  whisperLanguage: string;
  whisperBeamSize: number;
  whisperVadFilter: boolean;
};

export const DEFAULT_VOICE_TRANSCRIPTION_CONFIG: VoiceTranscriptionConfig = {
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
};

export type AppConfig = {
  telegramBotToken: string;
  telegramOwnerId: number;
  codexWsUrl: string;
  codexGlobalStatePath: string;
  projectsRoot: string;
  promptConfigDir: string;
  logLevel: string;
  botRunMode: 'DEV' | 'PROD';
  voiceTranscription: VoiceTranscriptionConfig;
};

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  return {
    telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
    telegramOwnerId: parsed.data.TELEGRAM_OWNER_ID,
    codexWsUrl: parsed.data.CODEX_WS_URL,
    codexGlobalStatePath: parsed.data.CODEX_GLOBAL_STATE_PATH,
    projectsRoot: parsed.data.PROJECTS_ROOT,
    promptConfigDir: parsed.data.PROMPT_CONFIG_DIR,
    logLevel: parsed.data.LOG_LEVEL,
    botRunMode: parsed.data.BOT_RUN_MODE,
    voiceTranscription: {
      ...DEFAULT_VOICE_TRANSCRIPTION_CONFIG,
      enabled: parsed.data.VOICE_TRANSCRIPTION_ENABLED,
      backend: parsed.data.VOICE_TRANSCRIPTION_BACKEND,
      tmpDir: parsed.data.VOICE_TRANSCRIPTION_TMP_DIR,
      maxFileMb: parsed.data.VOICE_TRANSCRIPTION_MAX_FILE_MB,
      maxDurationSeconds: parsed.data.VOICE_TRANSCRIPTION_MAX_DURATION_SECONDS,
      timeoutSeconds: parsed.data.VOICE_TRANSCRIPTION_TIMEOUT_SECONDS,
      previewMaxChars: parsed.data.VOICE_TRANSCRIPTION_PREVIEW_MAX_CHARS,
      maxTextChars: parsed.data.VOICE_TRANSCRIPTION_MAX_TEXT_CHARS,
      fasterWhisperPython: parsed.data.FASTER_WHISPER_PYTHON,
      hfHome: parsed.data.HF_HOME,
      whisperModelPath: parsed.data.WHISPER_MODEL_PATH,
      whisperDevice: parsed.data.WHISPER_DEVICE,
      whisperComputeType: parsed.data.WHISPER_COMPUTE_TYPE,
      whisperLanguage: parsed.data.WHISPER_LANGUAGE,
      whisperBeamSize: parsed.data.WHISPER_BEAM_SIZE,
      whisperVadFilter: parsed.data.WHISPER_VAD_FILTER
    }
  };
}

