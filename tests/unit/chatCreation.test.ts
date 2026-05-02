import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/config/env.js';
import type { CodexThread } from '../../src/codex/protocol.js';
import { createTelegramHandlers, type TelegramHandlerContext } from '../../src/telegram/handlers.js';

const ownerId = 42;
const safeProjectPath = 'C:\\Workspace\\New project';

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

function makeContext(overrides: Partial<TelegramHandlerContext> = {}) {
  const replies: string[] = [];
  const replyOptions: unknown[] = [];
  const ctx: TelegramHandlerContext = {
    fromId: ownerId,
    chatId: ownerId,
    chatType: 'private',
    text: '',
    reply: async (text, options) => {
      replies.push(text);
      replyOptions.push(options);
    },
    answerCallbackQuery: vi.fn(),
    ...overrides
  };
  return { ctx, replies, replyOptions };
}

function dependencies(projects = [{ name: 'New project', path: safeProjectPath }]) {
  const threads: CodexThread[] = [];
  return {
    codex: {
      connectionStatus: 'connected' as const,
      listThreads: vi.fn(async () => threads),
      resumeThread: vi.fn(async (threadId: string) => ({ id: threadId, cwd: safeProjectPath })),
      startThread: vi.fn(async (_params: { cwd?: string }): Promise<CodexThread> => ({ id: 'new-thread', preview: 'New chat' })),
      startTurn: vi.fn(async () => ({ turnId: 'turn-1' }))
    },
    readProjectlessThreadIds: vi.fn(async () => new Set<string>()),
    listProjects: vi.fn(async () => projects),
    updateCommandMenu: vi.fn(async () => undefined)
  };
}

describe('chat creation handlers', () => {
  it('creates and selects a project chat from a freshly validated project path', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const callbackData = handlers.callbackData.createProjectChat(safeProjectPath);
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.listProjects).toHaveBeenCalledWith('C:\\Workspace');
    expect(deps.codex.startThread).toHaveBeenCalledWith({ cwd: safeProjectPath });
    expect(handlers.getSelectedThread(ownerId)).toBe('new-thread');
    expect(deps.updateCommandMenu).toHaveBeenCalledWith(ownerId, true);
    expect(replies.join('\n')).toContain('Created project chat');
  });

  it('creates a new chat in the selected project and selects it', async () => {
    const deps = dependencies();
    deps.codex.startThread
      .mockResolvedValueOnce({ id: 'selected-thread', preview: 'Selected chat', cwd: safeProjectPath })
      .mockResolvedValueOnce({ id: 'new-thread', preview: 'New chat', cwd: safeProjectPath });
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const callbackData = handlers.callbackData.createProjectChat(safeProjectPath);
    const selected = makeContext({ callbackData });
    await handlers.handleCallback(selected.ctx);
    deps.updateCommandMenu.mockClear();

    const created = makeContext();
    await handlers.handleNewChat(created.ctx);

    expect(deps.codex.startThread).toHaveBeenNthCalledWith(1, { cwd: safeProjectPath });
    expect(deps.codex.startThread).toHaveBeenNthCalledWith(2, { cwd: safeProjectPath });
    expect(handlers.getSelectedThread(ownerId)).toBe('new-thread');
    expect(deps.updateCommandMenu).toHaveBeenCalledWith(ownerId, true);
    expect(created.replies.join('\n')).toContain('Created new chat');
  });

  it('creates a new chat in the project of a selected existing project chat', async () => {
    const deps = dependencies();
    deps.codex.listThreads.mockResolvedValueOnce([
      { id: 'project-1', preview: 'Project chat', cwd: safeProjectPath, updatedAt: 1 }
    ]);
    deps.codex.startThread.mockResolvedValueOnce({ id: 'new-thread', preview: 'New chat', cwd: safeProjectPath });
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', safeProjectPath);
    const list = makeContext();
    await handlers.handleProjectChats(list.ctx);
    const options = list.replyOptions[0] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    const selectCallbackData = options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(selectCallbackData).toBeDefined();
    await handlers.handleCallback(makeContext({ callbackData: selectCallbackData }).ctx);

    const created = makeContext();
    await handlers.handleNewChat(created.ctx);

    expect(deps.codex.startThread).toHaveBeenCalledWith({ cwd: safeProjectPath });
    expect(handlers.getSelectedThread(ownerId)).toBe('new-thread');
    expect(created.replies.join('\n')).toContain('Created new chat');
  });

  it('rejects new_chat when no project is selected', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext();

    await handlers.handleNewChat(ctx);

    expect(deps.codex.startThread).not.toHaveBeenCalled();
    expect(deps.updateCommandMenu).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('No project selected');
    expect(replies.join('\n')).toContain('/select_project');
  });

  it('rejects new_chat when the selected chat has no remembered project', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-without-project');
    const { ctx, replies } = makeContext();

    await handlers.handleNewChat(ctx);

    expect(deps.codex.startThread).not.toHaveBeenCalled();
    expect(deps.updateCommandMenu).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('No project selected');
  });

  it('rejects invalid project callback keys before creating a thread', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext({ callbackData: 'pc:missing' });

    await handlers.handleCallback(ctx);

    expect(deps.codex.startThread).not.toHaveBeenCalled();
    expect(deps.updateCommandMenu).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('expired');
  });

  it('rejects escaped or stale project paths that are absent from the fresh safe project list', async () => {
    const deps = dependencies([{ name: 'Other project', path: 'C:\\Workspace\\Other' }]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const callbackData = handlers.callbackData.createProjectChat('C:\\Workspace\\..\\Windows');
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.startThread).not.toHaveBeenCalled();
    expect(deps.updateCommandMenu).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('no longer available');
  });

  it('does not use locale collation to match distinct project paths', async () => {
    const deps = dependencies([{ name: 'Accent project', path: 'C:\\Workspace\\resume' }]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const callbackData = handlers.callbackData.createProjectChat('C:\\Workspace\\r\u00e9sum\u00e9');
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.startThread).not.toHaveBeenCalled();
    expect(deps.updateCommandMenu).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('no longer available');
  });

  it('matches callback project paths using Windows case-insensitive normalization', async () => {
    const deps = dependencies([{ name: 'New project', path: safeProjectPath }]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const callbackData = handlers.callbackData.createProjectChat('c:/workspace/new project');
    const { ctx } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.startThread).toHaveBeenCalledWith({ cwd: safeProjectPath });
  });

  it('does not expose legacy project chat creation from chat creation handlers', () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });

    expect('handleNewProjectChat' in handlers).toBe(false);
    expect(deps.codex.startThread).not.toHaveBeenCalled();
  });
});
