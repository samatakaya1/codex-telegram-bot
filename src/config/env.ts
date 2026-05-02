import { z } from 'zod';

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
  BOT_RUN_MODE: z.enum(['DEV', 'PROD']).default('DEV')
});

export type AppConfig = {
  telegramBotToken: string;
  telegramOwnerId: number;
  codexWsUrl: string;
  codexGlobalStatePath: string;
  projectsRoot: string;
  promptConfigDir: string;
  logLevel: string;
  botRunMode: 'DEV' | 'PROD';
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
    botRunMode: parsed.data.BOT_RUN_MODE
  };
}

