import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/config/env.js';
import { createTelegramHandlers, type TelegramHandlerContext } from '../../src/telegram/handlers.js';

const ownerId = 42;

function config(): AppConfig {
  return {
    telegramBotToken: 'token',
    telegramOwnerId: ownerId,
    codexWsUrl: 'ws://127.0.0.1:18765',
    codexGlobalStatePath: 'C:\\CodexState\\.codex-global-state.json',
    projectsRoot: 'C:\\Workspace',
    logLevel: 'info',
    botRunMode: 'DEV'
  };
}

describe('chat creation integration flow', () => {
  it('shows project action buttons, creates a chat from the create action, and selects the new thread', async () => {
    const replies: string[] = [];
    const replyOptions: unknown[] = [];
    const ctx: TelegramHandlerContext = {
      fromId: ownerId,
      chatId: ownerId,
      chatType: 'private',
      reply: async (text, options) => {
        replies.push(text);
        replyOptions.push(options);
      },
      answerCallbackQuery: vi.fn()
    };
    const deps = {
      config: config(),
      codex: {
        connectionStatus: 'connected' as const,
        listThreads: vi.fn(async () => []),
        resumeThread: vi.fn(async (threadId: string) => ({ id: threadId })),
        startThread: vi.fn(async () => ({ id: 'created-thread', preview: 'Created' })),
        startTurn: vi.fn(async () => ({ turnId: 'turn-1' }))
      },
      readProjectlessThreadIds: vi.fn(async () => new Set<string>()),
      listProjects: vi.fn(async () => [{ name: 'New project', path: 'C:\\Workspace\\New project' }])
    };
    const handlers = createTelegramHandlers(deps);

    await handlers.handleSelectProject(ctx);
    const options = replyOptions[0] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    };
    const projectCallbackData = options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;

    expect(projectCallbackData).toBeDefined();
    await handlers.handleCallback({ ...ctx, callbackData: projectCallbackData });
    expect(deps.codex.startThread).not.toHaveBeenCalled();

    const actionOptions = replyOptions[1] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    };
    const createChatCallbackData = actionOptions.reply_markup?.inline_keyboard
      ?.flat()
      .find((button) => button.text === 'Создать новый чат')?.callback_data;
    expect(createChatCallbackData).toBeDefined();
    await handlers.handleCallback({ ...ctx, callbackData: createChatCallbackData });

    expect(deps.codex.startThread).toHaveBeenCalledWith({ cwd: 'C:\\Workspace\\New project' });
    expect(handlers.getSelectedThread(ownerId)).toBe('created-thread');
    expect(replies.join('\n')).toContain('Created new chat');
  });

  it('creates a chat in the currently selected project', async () => {
    const replies: string[] = [];
    const replyOptions: unknown[] = [];
    const ctx: TelegramHandlerContext = {
      fromId: ownerId,
      chatId: ownerId,
      chatType: 'private',
      reply: async (text, options) => {
        replies.push(text);
        replyOptions.push(options);
      },
      answerCallbackQuery: vi.fn()
    };
    const deps = {
      config: config(),
      codex: {
        connectionStatus: 'connected' as const,
        listThreads: vi.fn(async () => []),
        resumeThread: vi.fn(async (threadId: string) => ({ id: threadId })),
        startThread: vi
          .fn()
          .mockResolvedValueOnce({ id: 'selected-thread', preview: 'Selected' })
          .mockResolvedValueOnce({ id: 'created-thread', preview: 'Created' }),
        startTurn: vi.fn(async () => ({ turnId: 'turn-1' }))
      },
      readProjectlessThreadIds: vi.fn(async () => new Set<string>()),
      listProjects: vi.fn(async () => [{ name: 'New project', path: 'C:\\Workspace\\New project' }])
    };
    const handlers = createTelegramHandlers(deps);

    await handlers.handleSelectProject(ctx);
    const options = replyOptions[0] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    const callbackData = options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    await handlers.handleCallback({ ...ctx, callbackData });
    await handlers.handleNewChat(ctx);

    expect(deps.codex.startThread).toHaveBeenNthCalledWith(1, { cwd: 'C:\\Workspace\\New project' });
    expect(handlers.getSelectedThread(ownerId)).toBe('selected-thread');
    expect(replies.join('\n')).toContain('Created new chat');
  });
});
