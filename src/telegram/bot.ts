import { Bot, type Context, InlineKeyboard } from 'grammy';

import type { AppConfig } from '../config/env.js';
import type { CodexAppServerClient } from '../codex/appServerClient.js';
import { listProjects } from '../domain/projects.js';
import { DEFAULT_PROMPT_CONFIGS } from '../promptConfigs/defaults.js';
import { requestProcessReboot } from '../runtime/reboot.js';
import { readProjectlessThreadIds } from '../storage/codexGlobalState.js';
import { createFilePromptConfigStore, type PromptConfigStore } from '../storage/promptConfigs.js';
import { telegramCommandsForState } from './commands.js';
import { createTelegramHandlers, type TelegramHandlerContext } from './handlers.js';

type CreateTelegramBotOptions = {
  config: AppConfig;
  codex: CodexAppServerClient;
  logger?: {
    error: (payload: unknown, message?: string) => void;
    warn?: (payload: unknown, message?: string) => void;
  };
  promptConfigs?: PromptConfigStore;
  onRebootRequested?: () => Promise<void> | void;
};

type CommandMenuApi = {
  setMyCommands: (
    commands: ReturnType<typeof telegramCommandsForState>,
    other: { readonly scope: { readonly type: 'chat'; readonly chat_id: number } }
  ) => Promise<unknown> | unknown;
};

type CommandMenuLogger = {
  warn?: (payload: unknown, message?: string) => void;
};

export async function updateScopedTelegramCommandMenu(options: {
  api: CommandMenuApi;
  logger?: CommandMenuLogger;
  chatId: number;
  hasSelectedChat: boolean;
}): Promise<void> {
  try {
    await Promise.resolve(
      options.api.setMyCommands(telegramCommandsForState(options.hasSelectedChat), {
        scope: { type: 'chat', chat_id: options.chatId }
      })
    );
  } catch (error) {
    options.logger?.warn?.({ telegramError: sanitizeTelegramError(error) }, 'Telegram command menu update failed');
  }
}

export function createTelegramBot(options: CreateTelegramBotOptions): Bot {
  const bot = new Bot(options.config.telegramBotToken);
  const handlers = createTelegramHandlers({
    config: options.config,
    codex: options.codex,
    readProjectlessThreadIds,
    listProjects,
    promptConfigs:
      options.promptConfigs ??
      createFilePromptConfigStore({
        dir: options.config.promptConfigDir,
        defaults: DEFAULT_PROMPT_CONFIGS,
        logger: options.logger
      }),
    onRebootRequested: options.onRebootRequested ?? requestProcessReboot,
    onDeliveryError: (error) => options.logger?.error({ telegramError: sanitizeTelegramError(error) }, 'Telegram delivery failed'),
    updateCommandMenu: async (chatId, hasSelectedChat) => {
      await updateScopedTelegramCommandMenu({ api: bot.api, logger: options.logger, chatId, hasSelectedChat });
    }
  });

  bot.command('start', (ctx) => handlers.handleStart(toHandlerContext(ctx)));
  bot.command('help', (ctx) => handlers.handleHelp(toHandlerContext(ctx)));
  bot.command('status', (ctx) => handlers.handleStatus(toHandlerContext(ctx)));
  bot.command('limits', (ctx) => handlers.handleLimits(toHandlerContext(ctx)));
  bot.command('select_chat', (ctx) => handlers.handleProjectChats(toHandlerContext(ctx)));
  bot.command('select_project', (ctx) => handlers.handleSelectProject(toHandlerContext(ctx)));
  bot.command('new_chat', (ctx) => handlers.handleNewChat(toHandlerContext(ctx)));
  bot.command('delete_chat', (ctx) => handlers.handleDeleteChat(toHandlerContext(ctx)));
  bot.command('current', (ctx) => handlers.handleCurrent(toHandlerContext(ctx)));
  bot.command('summary_chat', (ctx) => handlers.handleSummaryChat(toHandlerContext(ctx)));
  bot.command('review_fix', (ctx) => handlers.handleReviewFix(toHandlerContext(ctx)));
  bot.command('commit', (ctx) => handlers.handleCommit(toHandlerContext(ctx)));
  bot.command('reboot', (ctx) => handlers.handleReboot(toHandlerContext(ctx)));
  bot.on('callback_query:data', (ctx) => handlers.handleCallback(toHandlerContext(ctx)));
  bot.on('message:text', (ctx) => handlers.handleText(toHandlerContext(ctx)));
  bot.catch(() => {
    // User-facing handlers catch expected failures; this keeps unexpected middleware errors from stopping polling.
  });

  return bot;
}

function toHandlerContext(ctx: Context): TelegramHandlerContext {
  return {
    fromId: ctx.from?.id,
    chatId: ctx.chat?.id,
    chatType: ctx.chat?.type,
    text: ctx.message?.text,
    callbackData: ctx.callbackQuery?.data,
    reply: async (text, options) => {
      await ctx.reply(text, options as Parameters<Context['reply']>[1]);
    },
    answerCallbackQuery: async (text) => {
      if (ctx.callbackQuery !== undefined) {
        await ctx.answerCallbackQuery(text === undefined ? undefined : { text });
      }
    },
    confirmUpdate: () => confirmTelegramUpdate(ctx)
  };
}

export async function confirmTelegramUpdate(ctx: Pick<Context, 'api' | 'update'>): Promise<void> {
  await ctx.api.getUpdates({ offset: ctx.update.update_id + 1, limit: 1, timeout: 0 });
}

export function projectKeyboard(projects: Array<{ name: string; callbackData: string }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const project of projects) {
    keyboard.text(project.name, project.callbackData).row();
  }
  return keyboard;
}

export function sanitizeTelegramError(error: unknown): Record<string, unknown> {
  const source = asRecord(error);
  const name = error instanceof Error ? error.name : typeof error;
  const sanitized: Record<string, unknown> = { name };

  const method = getString(source, 'method');
  if (method !== undefined) {
    sanitized.method = method;
  }

  const errorCode = getNumber(source, 'error_code') ?? getNumber(source, 'errorCode');
  if (errorCode !== undefined) {
    sanitized.errorCode = errorCode;
  }

  sanitized.hasPayload = source?.payload !== undefined;
  sanitized.hasDescription = typeof source?.description === 'string';
  return sanitized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function getString(source: Record<string, unknown> | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumber(source: Record<string, unknown> | null, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' ? value : undefined;
}
