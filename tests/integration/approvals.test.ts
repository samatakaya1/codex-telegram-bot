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
    promptConfigDir: 'prompt-configs',
    logLevel: 'info',
    botRunMode: 'DEV'
  };
}

function makeContext(callbackData: string, overrides: Partial<TelegramHandlerContext> = {}) {
  const replies: string[] = [];
  const ctx: TelegramHandlerContext = {
    fromId: ownerId,
    chatId: ownerId,
    chatType: 'private',
    callbackData,
    reply: async (text) => {
      replies.push(text);
    },
    answerCallbackQuery: vi.fn(),
    ...overrides
  };
  return { ctx, replies };
}

function makeHandlers() {
  const codex = {
    connectionStatus: 'connected',
    listThreads: vi.fn(async () => []),
    resumeThread: vi.fn(async (threadId: string) => ({ id: threadId })),
    startThread: vi.fn(async () => ({ id: 'thread-1' })),
    startTurn: vi.fn(async () => ({ turnId: 'turn-1' }))
  };
  const handlers = createTelegramHandlers({
    config: config(),
    codex,
    readProjectlessThreadIds: vi.fn(async () => new Set<string>()),
    listProjects: vi.fn(async () => [])
  });
  return { handlers, codex };
}

describe('approval callbacks', () => {
  it('does not render or accept Telegram approval callbacks in fail-closed mode', async () => {
    const { handlers, codex } = makeHandlers();
    const { ctx, replies } = makeContext('a:unsupported:yes');

    await handlers.handleCallback(ctx);

    const replyText = replies.join('\n');
    expect(replyText).toContain('Approval actions are not available');
    expect(replyText).not.toContain('a:unsupported:yes');
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Approval unavailable');
    expect(codex.listThreads).not.toHaveBeenCalled();
    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
  });

  it('rejects unauthorized and group approval callbacks before Codex calls', async () => {
    const unauthorized = makeHandlers();
    const unauthorizedContext = makeContext('a:secret:yes', { fromId: 1, chatId: 1 });

    await unauthorized.handlers.handleCallback(unauthorizedContext.ctx);

    expect(unauthorizedContext.replies.join('\n')).toContain('Access denied');
    expect(unauthorizedContext.ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(unauthorized.codex.resumeThread).not.toHaveBeenCalled();
    expect(unauthorized.codex.startThread).not.toHaveBeenCalled();
    expect(unauthorized.codex.startTurn).not.toHaveBeenCalled();

    const group = makeHandlers();
    const groupContext = makeContext('a:secret:no', { chatId: -100, chatType: 'group' });

    await group.handlers.handleCallback(groupContext.ctx);

    expect(groupContext.replies.join('\n')).toContain('private chat');
    expect(groupContext.ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(group.codex.resumeThread).not.toHaveBeenCalled();
    expect(group.codex.startThread).not.toHaveBeenCalled();
    expect(group.codex.startTurn).not.toHaveBeenCalled();
  });
});
