import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/config/env.js';
import type { CodexThread, JsonValue } from '../../src/codex/protocol.js';
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

function dependencies() {
  return {
    codex: {
      connectionStatus: 'connected' as const,
      listThreads: vi.fn(async (): Promise<CodexThread[]> => [
        { id: 'projectless-1', preview: 'Outside project', updatedAt: 2 },
        { id: 'project-1', preview: 'Project chat', cwd: 'C:\\Workspace\\Project', updatedAt: 1 },
        { id: 'other-project-1', preview: 'Other project chat', cwd: 'C:\\Workspace\\Other', updatedAt: 3 }
      ]),
      resumeThread: vi.fn(async (threadId: string): Promise<CodexThread> => ({ id: threadId, preview: 'Resumed' })),
      startThread: vi.fn(async (): Promise<CodexThread> => ({ id: 'new-thread', preview: 'New chat' })),
      archiveThread: vi.fn(async () => undefined),
      startTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
      readRateLimits: vi.fn(async () => ({
        rateLimits: {
          limitId: 'codex',
          limitName: 'Codex',
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: Date.UTC(2026, 4, 1, 18, 30) / 1000
          }
        }
      })),
      getRateLimits: vi.fn((): JsonValue | null => null)
    },
    readProjectlessThreadIds: vi.fn(async () => new Set(['projectless-1'])),
    listProjects: vi.fn(async () => [
      { name: 'New project', path: 'C:\\Workspace\\New project' },
      { name: 'Project', path: 'C:\\Workspace\\Project' },
      { name: 'Other project', path: 'C:\\Workspace\\Other' }
    ]),
    updateCommandMenu: vi.fn(async () => undefined)
  };
}

describe('telegram handlers', () => {
  it('implements start, help, status, limits, select_project, new_chat, and current commands', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });

    const start = makeContext();
    await handlers.handleStart(start.ctx);
    expect(start.replies.join('\n')).toContain('/status');

    const help = makeContext();
    await handlers.handleHelp(help.ctx);
    expect(help.replies.join('\n')).not.toContain('/chats');
    expect(help.replies.join('\n')).toContain('/limits');
    expect(help.replies.join('\n')).toContain('/select_project');
    expect(help.replies.join('\n')).toContain('/reboot');
    expect(help.replies.join('\n')).not.toContain('/select_chat');
    expect(help.replies.join('\n')).not.toContain('/new_chat');
    expect(help.replies.join('\n')).not.toContain('/delete_chat');
    expect(help.replies.join('\n')).not.toContain('/current');
    expect(help.replies.join('\n')).not.toContain('/summary_chat');
    expect(help.replies.join('\n')).not.toContain('/projects');
    expect(help.replies.join('\n')).not.toContain('/new_project_chat');

    const status = makeContext();
    await handlers.handleStatus(status.ctx);
    expect(status.replies.join('\n')).toContain('connected');

    const limits = makeContext();
    await handlers.handleLimits(limits.ctx);
    expect(limits.replies.join('\n')).toContain('Codex limits:');
    expect(limits.replies.join('\n')).toContain('75% remaining');

    const currentBefore = makeContext();
    await handlers.handleCurrent(currentBefore.ctx);
    expect(currentBefore.replies.join('\n')).toContain('No chat selected');

    handlers.setSelectedThread(ownerId, 'thread-secret');
    const currentAfter = makeContext();
    await handlers.handleCurrent(currentAfter.ctx);
    expect(currentAfter.replies.join('\n')).toContain('Selected chat');
    expect(currentAfter.replies.join('\n')).toContain('Untitled chat');
    expect(currentAfter.replies.join('\n')).toContain('Unknown project');
    expect(currentAfter.replies.join('\n')).not.toContain('thread-secret');

    handlers.setSelectedThread(ownerId, 'thread-secret', 'C:\\Workspace\\Project');
    const selectedHelp = makeContext();
    await handlers.handleHelp(selectedHelp.ctx);
    expect(selectedHelp.replies.join('\n')).toContain('/select_chat');
    expect(selectedHelp.replies.join('\n')).toContain('/new_chat');
    expect(selectedHelp.replies.join('\n')).toContain('/delete_chat');
    expect(selectedHelp.replies.join('\n')).toContain('/current');
    expect(selectedHelp.replies.join('\n')).toContain('/summary_chat');

    const selectProject = makeContext();
    await handlers.handleSelectProject(selectProject.ctx);
    expect(selectProject.replies.join('\n')).toContain('New project');
  });

  it('does not expose projectless chat listing handlers or legacy project creation handlers', () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });

    expect('handleChats' in handlers).toBe(false);
    expect('handleProjects' in handlers).toBe(false);
    expect('handleNewProjectChat' in handlers).toBe(false);
  });

  it('rejects unauthorized users before Codex calls', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext({ fromId: 1, chatId: 1 });

    await handlers.handleProjectChats(ctx);

    expect(replies[0]).toContain('Access denied');
    expect(deps.codex.listThreads).not.toHaveBeenCalled();
  });

  it('rejects the allowed owner in a group before Codex calls', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext({ chatId: -100, chatType: 'group' });

    await handlers.handleProjectChats(ctx);

    expect(replies[0]).toContain('private chat');
    expect(deps.codex.listThreads).not.toHaveBeenCalled();
  });

  it('rejects select_chat before a project is selected', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies, replyOptions } = makeContext();

    await handlers.handleProjectChats(ctx);

    expect(deps.codex.listThreads).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('No project selected');
    expect(replies.join('\n')).toContain('/select_project');
    expect(JSON.stringify(replyOptions)).not.toContain('s:');
  });

  it('renders only chats from the selected project from /select_chat', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'c:/workspace/project');
    const { ctx, replies, replyOptions } = makeContext();

    await handlers.handleProjectChats(ctx);

    expect(replies.join('\n')).toContain('Project chats:');
    expect(replies.join('\n')).toContain('Project chat');
    expect(replies.join('\n')).not.toContain('Outside project');
    expect(replies.join('\n')).not.toContain('Other project chat');
    expect(JSON.stringify(replyOptions)).toContain('s:');
  });

  it('renders all selected project chats when Codex returns equivalent Windows project paths', async () => {
    const deps = dependencies();
    deps.codex.listThreads.mockResolvedValueOnce([
      { id: 'project-1', preview: 'Backslash path', cwd: 'C:\\Workspace\\Project', updatedAt: 2 },
      { id: 'project-2', preview: 'Forward slash path', cwd: 'c:/workspace/project', updatedAt: 1 },
      { id: 'other-project-1', preview: 'Other project chat', cwd: 'C:\\Workspace\\Other', updatedAt: 3 }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project\\');
    const { ctx, replies, replyOptions } = makeContext();

    await handlers.handleProjectChats(ctx);

    expect(replies.join('\n')).toContain('Backslash path');
    expect(replies.join('\n')).toContain('Forward slash path');
    expect(replies.join('\n')).not.toContain('Other project chat');
    expect(JSON.stringify(replyOptions).match(/s:/g)).toHaveLength(2);
  });

  it('reports when the selected project has no listed chats', async () => {
    const deps = dependencies();
    deps.listProjects.mockResolvedValueOnce([{ name: 'Missing', path: 'C:\\Workspace\\Missing' }]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Missing');
    const { ctx, replies, replyOptions } = makeContext();

    await handlers.handleProjectChats(ctx);

    expect(replies.join('\n')).toContain('No chats for this project found');
    expect(JSON.stringify(replyOptions)).not.toContain('s:');
  });

  it('revalidates the selected project before listing chats from /select_chat', async () => {
    const deps = dependencies();
    deps.listProjects.mockResolvedValueOnce([{ name: 'Other project', path: 'C:\\Workspace\\Other' }]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const { ctx, replies, replyOptions } = makeContext();

    await handlers.handleProjectChats(ctx);

    expect(deps.codex.listThreads).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('no longer available');
    expect(JSON.stringify(replyOptions)).not.toContain('s:');
  });

  it('rejects delete_chat before a project is selected', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies, replyOptions } = makeContext();

    await handlers.handleDeleteChat(ctx);

    expect(deps.codex.listThreads).not.toHaveBeenCalled();
    expect(deps.codex.archiveThread).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('No project selected');
    expect(replies.join('\n')).toContain('/select_project');
    expect(JSON.stringify(replyOptions)).not.toContain('d:');
  });

  it('revalidates the selected project before listing chats from /delete_chat', async () => {
    const deps = dependencies();
    deps.listProjects.mockResolvedValueOnce([{ name: 'Other project', path: 'C:\\Workspace\\Other' }]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const { ctx, replies, replyOptions } = makeContext();

    await handlers.handleDeleteChat(ctx);

    expect(deps.codex.listThreads).not.toHaveBeenCalled();
    expect(deps.codex.archiveThread).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('no longer available');
    expect(JSON.stringify(replyOptions)).not.toContain('d:');
  });

  it('rejects unauthorized delete_chat before Codex calls', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const { ctx, replies } = makeContext({ fromId: 1, chatId: 1 });

    await handlers.handleDeleteChat(ctx);

    expect(replies.join('\n')).toContain('Access denied');
    expect(deps.codex.listThreads).not.toHaveBeenCalled();
    expect(deps.codex.archiveThread).not.toHaveBeenCalled();
  });

  it('rejects delete_chat from groups before Codex calls', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const { ctx, replies } = makeContext({ chatId: -100, chatType: 'group' });

    await handlers.handleDeleteChat(ctx);

    expect(replies.join('\n')).toContain('private chat');
    expect(deps.codex.listThreads).not.toHaveBeenCalled();
    expect(deps.codex.archiveThread).not.toHaveBeenCalled();
  });

  it('renders only chats from the selected project from /delete_chat', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'c:/workspace/project');
    const { ctx, replies, replyOptions } = makeContext();

    await handlers.handleDeleteChat(ctx);

    expect(replies.join('\n')).toContain('Project chats to delete:');
    expect(replies.join('\n')).toContain('Project chat');
    expect(replies.join('\n')).not.toContain('Outside project');
    expect(replies.join('\n')).not.toContain('Other project chat');
    expect(JSON.stringify(replyOptions)).toContain('d:');
    expect(JSON.stringify(replyOptions)).not.toContain('project-1');
  });

  it('shows delete confirmation before archiving a chat', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createDeleteChat('project-1', 'C:\\Workspace\\Project');
    const { ctx, replies, replyOptions } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.archiveThread).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('Delete chat?');
    expect(replies.join('\n')).toContain('Project chat');
    const serializedOptions = JSON.stringify(replyOptions);
    expect(serializedOptions).toContain('dc:');
    expect(serializedOptions).not.toContain('project-1');
  });

  it('cancels delete confirmation without archiving', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createDeleteChatConfirm('project-1', 'C:\\Workspace\\Project', false);
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.archiveThread).not.toHaveBeenCalled();
    expect(handlers.getSelectedThread(ownerId)).toBe('selected-thread');
    expect(replies.join('\n')).toContain('Delete cancelled');
  });

  it('archives a non-selected project chat without changing the selected chat', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createDeleteChatConfirm('project-1', 'C:\\Workspace\\Project', true);
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.archiveThread).toHaveBeenCalledWith('project-1');
    expect(deps.codex.startThread).not.toHaveBeenCalled();
    expect(handlers.getSelectedThread(ownerId)).toBe('selected-thread');
    expect(replies.join('\n')).toContain('Deleted chat');
  });

  it('archives the selected chat and selects a replacement in the same project', async () => {
    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'replacement-thread',
      preview: 'Replacement chat',
      cwd: 'C:\\Workspace\\Project'
    });
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'project-1', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createDeleteChatConfirm('project-1', 'C:\\Workspace\\Project', true);
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.archiveThread).toHaveBeenCalledWith('project-1');
    expect(deps.codex.startThread).toHaveBeenCalledWith({ cwd: 'C:\\Workspace\\Project' });
    expect(handlers.getSelectedThread(ownerId)).toBe('replacement-thread');
    expect(replies.join('\n')).toContain('Deleted selected chat');
    expect(replies.join('\n')).toContain('Replacement chat');
  });

  it('clears only the selected thread when replacement creation fails after deleting the selected chat', async () => {
    const deps = dependencies();
    deps.codex.startThread
      .mockRejectedValueOnce(new Error('replacement failed'))
      .mockResolvedValueOnce({ id: 'later-thread', preview: 'Later chat', cwd: 'C:\\Workspace\\Project' });
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'project-1', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createDeleteChatConfirm('project-1', 'C:\\Workspace\\Project', true);
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.archiveThread).toHaveBeenCalledWith('project-1');
    expect(handlers.getSelectedThread(ownerId)).toBeNull();
    expect(replies.join('\n')).toContain('Deleted selected chat');
    expect(replies.join('\n')).toContain('/new_chat');

    const help = makeContext();
    await handlers.handleHelp(help.ctx);
    expect(help.replies.join('\n')).toContain('/delete_chat');

    const deleteList = makeContext();
    await handlers.handleDeleteChat(deleteList.ctx);
    expect(deleteList.replies.join('\n')).toContain('Project chats to delete:');
    expect(JSON.stringify(deleteList.replyOptions)).toContain('d:');

    await handlers.handleNewChat(makeContext().ctx);
    expect(deps.codex.startThread).toHaveBeenLastCalledWith({ cwd: 'C:\\Workspace\\Project' });
    expect(handlers.getSelectedThread(ownerId)).toBe('later-thread');
  });

  it('rejects deleting a busy thread', async () => {
    const deps = dependencies();
    let resolveTurn!: (value: { turnId: string }) => void;
    deps.codex.startTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
        })
    );
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'project-1', 'C:\\Workspace\\Project');
    const firstTurn = handlers.handleText(makeContext({ text: 'first turn' }).ctx);
    const callbackData = handlers.callbackData.createDeleteChatConfirm('project-1', 'C:\\Workspace\\Project', true);
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.archiveThread).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('already running');

    resolveTurn({ turnId: 'turn-1' });
    await firstTurn;
  });

  it('rejects delete callbacks for a different selected project', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createDeleteChatConfirm('other-project-1', 'C:\\Workspace\\Other', true);
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.archiveThread).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('no longer matches');
  });

  it('renders safe projects from /select_project', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies, replyOptions } = makeContext();

    await handlers.handleSelectProject(ctx);

    expect(replies.join('\n')).toContain('New project');
    expect(JSON.stringify(replyOptions)).toContain('pc:');
    expect(deps.listProjects).toHaveBeenCalledWith('C:\\Workspace');
  });

  it('truncates long chat and project labels before sending list messages', async () => {
    const longChatTitle = 'A'.repeat(5000);
    const longProjectName = 'B'.repeat(5000);
    const deps = dependencies();
    deps.codex.listThreads.mockResolvedValueOnce([
      { id: 'long-chat', preview: longChatTitle, cwd: 'C:\\Workspace\\Project', updatedAt: 1 }
    ]);
    deps.readProjectlessThreadIds.mockResolvedValueOnce(new Set());
    deps.listProjects
      .mockResolvedValueOnce([{ name: 'Project', path: 'C:\\Workspace\\Project' }])
      .mockResolvedValueOnce([{ name: longProjectName, path: 'C:\\Workspace\\Long' }]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');

    const chats = makeContext();
    await handlers.handleProjectChats(chats.ctx);
    const chatReplyOptions = JSON.stringify(chats.replyOptions);

    expect(chats.replies[0].length).toBeLessThan(3900);
    expect(chats.replies.join('\n')).not.toContain(longChatTitle);
    expect(chatReplyOptions).not.toContain(longChatTitle);
    expect(chats.replies.join('\n')).toContain('...');

    const projects = makeContext();
    await handlers.handleSelectProject(projects.ctx);
    const projectReplyOptions = JSON.stringify(projects.replyOptions);

    expect(projects.replies[0].length).toBeLessThan(3900);
    expect(projects.replies.join('\n')).not.toContain(longProjectName);
    expect(projectReplyOptions).not.toContain(longProjectName);
    expect(projects.replies.join('\n')).toContain('...');
  });

  it('returns user-safe messages when dependencies fail', async () => {
    const deps = dependencies();
    deps.codex.listThreads.mockRejectedValueOnce(new Error('Codex down'));
    deps.listProjects
      .mockResolvedValueOnce([{ name: 'Project', path: 'C:\\Workspace\\Project' }])
      .mockRejectedValueOnce(new Error('scan failed'));
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');

    const projectChats = makeContext();
    await handlers.handleProjectChats(projectChats.ctx);
    expect(projectChats.replies.join('\n')).toContain('Could not load project chats');

    const projects = makeContext();
    await handlers.handleSelectProject(projects.ctx);
    expect(projects.replies.join('\n')).toContain('Could not load projects');
  });

  it('falls back to cached limits when live limit read fails', async () => {
    const deps = dependencies();
    deps.codex.readRateLimits.mockRejectedValueOnce(new Error('Codex unavailable'));
    deps.codex.getRateLimits.mockReturnValueOnce({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: {
          usedPercent: 40,
          windowDurationMins: 60,
          resetsAt: Date.UTC(2026, 4, 1, 18, 30) / 1000
        }
      }
    });
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext();

    await handlers.handleLimits(ctx);

    expect(replies.join('\n')).toContain('Last cached limit update');
    expect(replies.join('\n')).toContain('60% remaining');
  });

  it('reports unavailable limits when live read fails and no cache exists', async () => {
    const deps = dependencies();
    deps.codex.readRateLimits.mockRejectedValueOnce(new Error('Codex unavailable'));
    deps.codex.getRateLimits.mockReturnValueOnce(null);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext();

    await handlers.handleLimits(ctx);

    expect(replies.join('\n')).toContain('Could not load Codex limits');
  });

  it('contains Telegram reply failures inside handlers', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx } = makeContext({
      reply: vi.fn(async () => {
        throw new Error('Telegram failed');
      })
    });

    await expect(handlers.handleStatus(ctx)).resolves.toBeUndefined();
  });

  it('select callback resumes the thread before storing selection', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext();

    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createSelectChat('project-1', 'C:\\Workspace\\Project');
    await handlers.handleCallback({ ...ctx, callbackData });

    expect(deps.codex.resumeThread).toHaveBeenCalledWith('project-1');
    expect(handlers.getSelectedThread(ownerId)).toBe('project-1');
    expect(deps.updateCommandMenu).toHaveBeenCalledWith(ownerId, true);
    expect(replies.join('\n')).toContain('Selected chat');
    expect(replies.join('\n')).not.toContain('project-1');
  });

  it('rejects select chat callbacks without project context', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createSelectChat('project-1');
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.resumeThread).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('Run /select_chat again');
  });

  it('rejects select chat callbacks for a different selected project', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createSelectChat('other-project-1', 'C:\\Workspace\\Other');
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.resumeThread).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('no longer matches');
  });

  it('rejects select chat callbacks when the thread is no longer in the selected project', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createSelectChat('missing-thread', 'C:\\Workspace\\Project');
    const { ctx, replies } = makeContext({ callbackData });

    await handlers.handleCallback(ctx);

    expect(deps.codex.resumeThread).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('no longer available');
  });

  it('shows the selected chat title and project from /current', async () => {
    const deps = dependencies();
    deps.codex.resumeThread.mockResolvedValueOnce({
      id: 'thread-secret',
      preview: 'Daily planning',
      cwd: 'C:\\Workspace\\Project'
    });
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    deps.codex.listThreads.mockResolvedValueOnce([
      { id: 'thread-secret', preview: 'Daily planning', cwd: 'C:\\Workspace\\Project', updatedAt: 1 }
    ]);
    const callbackData = handlers.callbackData.createSelectChat('thread-secret', 'C:\\Workspace\\Project');
    await handlers.handleCallback(makeContext({ callbackData }).ctx);

    const current = makeContext();
    await handlers.handleCurrent(current.ctx);

    expect(current.replies.join('\n')).toContain('Daily planning');
    expect(current.replies.join('\n')).toContain('C:\\Workspace\\Project');
    expect(current.replies.join('\n')).not.toContain('thread-secret');
  });

  it('uses a sanitized thread preview as the selected chat display title in /current', async () => {
    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'thread-with-preview',
      path: 'C:\\Users\\Owner\\.codex\\sessions\\rollout-2026-05-02T16-43-09-019de8ed.jsonl',
      cwd: 'C:\\Workspace\\Project'
    });
    deps.codex.listThreads.mockResolvedValueOnce([
      {
        id: 'thread-with-preview',
        preview:
          'User copied a Created new chat notification.\nSelected chat:\nChat: rollout-2026-05-02T16-43-09-019de8ed.jsonl\nProject: C:\\Workspace\\Project',
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'existing-thread', 'C:\\Workspace\\Project');
    await handlers.handleNewChat(makeContext().ctx);

    const current = makeContext();
    await handlers.handleCurrent(current.ctx);

    const response = current.replies.join('\n');
    expect(response).toContain('Selected chat: User copied a Created new chat notification');
    expect(response).not.toContain('Selected chat:\n');
    expect(response.match(/^Chat:/gm)).toBeNull();
    expect(response).not.toContain('Preview:');
    expect(response.match(/^Selected chat:/gm)).toHaveLength(1);
    expect(response.match(/^Project:/gm)).toHaveLength(1);
    expect(response).not.toContain('rollout-2026-05-02T16-43-09-019de8ed.jsonl');
  });

  it('shows selected chat model from the Codex session jsonl when thread metadata omits it', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-test.jsonl');
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5', effort: 'high' } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'xhigh' } })
      ].join('\n'),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'thread-with-model',
      path: sessionPath,
      cwd: 'C:\\Workspace\\Project'
    });
    deps.codex.listThreads.mockResolvedValueOnce([
      {
        id: 'thread-with-model',
        preview: 'Model check',
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'existing-thread', 'C:\\Workspace\\Project');
    await handlers.handleNewChat(makeContext().ctx);

    const current = makeContext();
    await handlers.handleCurrent(current.ctx);

    expect(current.replies.join('\n')).toContain('Model: gpt-5.5 xhigh');
  });

  it('shows selected chat context usage from the Codex session jsonl', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-context.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258400,
            last_token_usage: {
              input_tokens: 107394,
              output_tokens: 111,
              total_tokens: 107505
            },
            total_token_usage: {
              input_tokens: 5516408,
              output_tokens: 16303,
              total_tokens: 5532711
            }
          }
        }
      }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'thread-with-context',
      path: sessionPath,
      cwd: 'C:\\Workspace\\Project'
    });
    deps.codex.listThreads.mockResolvedValueOnce([
      {
        id: 'thread-with-context',
        preview: 'Context check',
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'existing-thread', 'C:\\Workspace\\Project');
    await handlers.handleNewChat(makeContext().ctx);

    const current = makeContext();
    await handlers.handleCurrent(current.ctx);

    expect(current.replies.join('\n')).toContain('Context: 107k / 258k (42%)');
  });

  it('clears selected chat context usage when the Codex session no longer has token count data', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-cleared-context.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258400,
            last_token_usage: {
              input_tokens: 107394,
              output_tokens: 111,
              total_tokens: 107505
            }
          }
        }
      }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.listThreads.mockResolvedValue([
      {
        id: 'thread-with-cleared-context',
        preview: 'Cleared context check',
        path: sessionPath,
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-with-cleared-context', 'C:\\Workspace\\Project');

    const first = makeContext();
    await handlers.handleCurrent(first.ctx);
    expect(first.replies.join('\n')).toContain('Context: 107k / 258k (42%)');

    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'xhigh' } }),
      'utf8'
    );

    const second = makeContext();
    await handlers.handleCurrent(second.ctx);
    expect(second.replies.join('\n')).toContain('Context: not available yet');
    expect(second.replies.join('\n')).not.toContain('Context: 107k / 258k');
  });

  it('refreshes selected chat context usage from newer Codex session token counts', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-changing-context.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258400,
            last_token_usage: { input_tokens: 64000 }
          }
        }
      }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.listThreads.mockResolvedValue([
      {
        id: 'thread-with-changing-context',
        preview: 'Changing context check',
        path: sessionPath,
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-with-changing-context', 'C:\\Workspace\\Project');

    const first = makeContext();
    await handlers.handleCurrent(first.ctx);
    expect(first.replies.join('\n')).toContain('Context: 64k / 258k (25%)');

    await appendFile(
      sessionPath,
      `\n${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258400,
            last_token_usage: { input_tokens: 107394 }
          }
        }
      })}`,
      'utf8'
    );

    const second = makeContext();
    await handlers.handleCurrent(second.ctx);
    expect(second.replies.join('\n')).toContain('Context: 107k / 258k (42%)');
  });

  it('does not show selected chat summary in current chat details', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-summary.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: 'turn_context',
        payload: {
          model: 'gpt-5.5',
          effort: 'xhigh',
          summary:
            'Implemented context token reporting.\nDiscussing how summary should appear in Telegram current chat notifications.'
        }
      }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'thread-with-summary',
      path: sessionPath,
      cwd: 'C:\\Workspace\\Project'
    });
    deps.codex.listThreads.mockResolvedValueOnce([
      {
        id: 'thread-with-summary',
        preview: 'Summary check',
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'existing-thread', 'C:\\Workspace\\Project');
    await handlers.handleNewChat(makeContext().ctx);

    const current = makeContext();
    await handlers.handleCurrent(current.ctx);

    const response = current.replies.join('\n');
    expect(response.match(/^Summary:/gm)).toBeNull();
    expect(response).not.toContain('/summary_chat');
  });

  it('starts a Codex turn when summary_chat is requested', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-for-summary', 'C:\\Workspace\\Project');

    const summary = makeContext();
    await handlers.handleSummaryChat(summary.ctx);

    expect(deps.codex.startTurn).toHaveBeenCalledWith({
      threadId: 'thread-for-summary',
      text: expect.stringContaining('current chat')
    });
    expect(deps.codex.startTurn).toHaveBeenCalledWith({
      threadId: 'thread-for-summary',
      text: expect.stringContaining('language previously used in this chat')
    });
    expect(deps.codex.startTurn).toHaveBeenCalledWith({
      threadId: 'thread-for-summary',
      text: expect.stringContaining('default to English')
    });
    expect(deps.codex.startTurn).toHaveBeenCalledWith({
      threadId: 'thread-for-summary',
      text: expect.stringContaining('new chat')
    });
    expect(summary.replies.join('\n')).toContain('Codex is preparing chat summary');
  });

  it('rejects summary_chat before a project chat is selected', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const summary = makeContext();

    await handlers.handleSummaryChat(summary.ctx);

    expect(deps.codex.startTurn).not.toHaveBeenCalled();
    expect(deps.updateCommandMenu).not.toHaveBeenCalled();
    expect(summary.replies.join('\n')).toContain('No chat selected');
  });

  it('directs users to create or select a chat after a project is selected', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    await handlers.handleCallback(makeContext({
      callbackData: handlers.callbackData.createSelectProject('C:\\Workspace\\Project')
    }).ctx);
    deps.updateCommandMenu.mockClear();

    const current = makeContext();
    await handlers.handleCurrent(current.ctx);

    const summary = makeContext();
    await handlers.handleSummaryChat(summary.ctx);

    const text = makeContext({ text: 'hello' });
    await handlers.handleText(text.ctx);

    const response = `${current.replies.join('\n')}\n${summary.replies.join('\n')}\n${text.replies.join('\n')}`;
    expect(response).toContain('No chat selected');
    expect(response).toContain('/new_chat');
    expect(response).toContain('/select_chat');
    expect(response).not.toContain('Use /select_project first');
    expect(deps.codex.startTurn).not.toHaveBeenCalled();
    expect(deps.updateCommandMenu).not.toHaveBeenCalled();
  });

  it('keeps active-chat commands hidden when the selected thread has no project', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-without-project');
    const help = makeContext();

    await handlers.handleHelp(help.ctx);

    expect(help.replies.join('\n')).toContain('/select_project');
    expect(help.replies.join('\n')).not.toContain('/select_chat');
    expect(help.replies.join('\n')).not.toContain('/new_chat');
    expect(help.replies.join('\n')).not.toContain('/delete_chat');
    expect(help.replies.join('\n')).not.toContain('/current');
    expect(help.replies.join('\n')).not.toContain('/summary_chat');
  });

  it('shows context as not available yet when token count is missing', async () => {
    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'thread-without-context',
      preview: 'Fresh chat',
      cwd: 'C:\\Workspace\\Project'
    });
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'existing-thread', 'C:\\Workspace\\Project');
    const created = makeContext();

    await handlers.handleNewChat(created.ctx);

    expect(created.replies.join('\n')).toContain('Context: not available yet');
  });

  it('rejects summary_chat while the selected thread is busy', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'busy-thread', 'C:\\Workspace\\Project');
    await handlers.handleText(makeContext({ text: 'first turn' }).ctx);

    const summary = makeContext();
    await handlers.handleSummaryChat(summary.ctx);

    expect(deps.codex.startTurn).toHaveBeenCalledTimes(1);
    expect(summary.replies.join('\n')).toContain('already running');
    expect(summary.replies.join('\n')).toContain('/summary_chat');
  });

  it('rejects summary_chat while a summary turn is still starting', async () => {
    const deps = dependencies();
    let resolveTurn!: (value: { turnId: string }) => void;
    deps.codex.startTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
        })
    );
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'pending-summary-thread', 'C:\\Workspace\\Project');

    const first = makeContext();
    const firstPromise = handlers.handleSummaryChat(first.ctx);
    const second = makeContext();
    await handlers.handleSummaryChat(second.ctx);

    expect(deps.codex.startTurn).toHaveBeenCalledTimes(1);
    expect(second.replies.join('\n')).toContain('already running');

    resolveTurn({ turnId: 'summary-turn-1' });
    await firstPromise;
  });

  it('shows selected chat model immediately after selecting an existing chat', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-selected.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'xhigh' } }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.resumeThread.mockResolvedValueOnce({
      id: 'thread-with-model',
      preview: 'Selected model chat',
      path: sessionPath,
      cwd: 'C:\\Workspace\\Project'
    });
    deps.codex.listThreads.mockResolvedValueOnce([
      { id: 'thread-with-model', preview: 'Selected model chat', cwd: 'C:\\Workspace\\Project', updatedAt: 1 }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const callbackData = handlers.callbackData.createSelectChat('thread-with-model', 'C:\\Workspace\\Project');
    const selected = makeContext({ callbackData });

    await handlers.handleCallback(selected.ctx);

    expect(selected.replies.join('\n')).toContain('Model: gpt-5.5 xhigh');
  });

  it('sanitizes model info before rendering it in Telegram', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-model-spoof.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: 'turn_context',
        payload: {
          model: 'gpt-5\nProject: C:\\Spoof',
          effort: 'xhigh\nSelected chat: spoof'
        }
      }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'thread-with-spoofed-model',
      path: sessionPath,
      cwd: 'C:\\Workspace\\Project'
    });
    deps.codex.listThreads.mockResolvedValueOnce([
      {
        id: 'thread-with-spoofed-model',
        preview: 'Model sanitization',
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'existing-thread', 'C:\\Workspace\\Project');
    await handlers.handleNewChat(makeContext().ctx);

    const current = makeContext();
    await handlers.handleCurrent(current.ctx);
    const response = current.replies.join('\n');

    expect(response.match(/^Project:/gm)).toHaveLength(1);
    expect(response.match(/^Selected chat:/gm)).toHaveLength(1);
    expect(response).toContain('Model: gpt-5 Project: C:\\Spoof xhigh Selected chat: spoof');
  });

  it('keeps the validated selected project when refreshing thread metadata', async () => {
    const deps = dependencies();
    deps.listProjects.mockResolvedValue([
      { name: 'Safe', path: 'C:\\Workspace\\Safe' }
    ]);
    deps.codex.resumeThread.mockResolvedValueOnce({
      id: 'thread-with-stale-cwd',
      preview: 'Safe project chat',
      cwd: 'C:\\Workspace\\Safe'
    });
    deps.codex.listThreads
      .mockResolvedValueOnce([
        {
          id: 'thread-with-stale-cwd',
          preview: 'Safe project chat',
          cwd: 'C:\\Workspace\\Safe',
          updatedAt: 1
        }
      ])
      .mockResolvedValueOnce([
        {
          id: 'thread-with-stale-cwd',
          preview: 'Safe project chat',
          cwd: 'C:\\Outside',
          updatedAt: 1
        }
      ]);
    deps.codex.startThread.mockResolvedValueOnce({ id: 'new-thread', preview: 'New chat', cwd: 'C:\\Workspace\\Safe' });
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    await handlers.handleCallback(makeContext({
      callbackData: handlers.callbackData.createSelectProject('C:\\Workspace\\Safe')
    }).ctx);
    const callbackData = handlers.callbackData.createSelectChat('thread-with-stale-cwd', 'C:\\Workspace\\Safe');
    await handlers.handleCallback(makeContext({ callbackData }).ctx);

    await handlers.handleNewChat(makeContext().ctx);

    expect(deps.codex.startThread).toHaveBeenCalledWith({ cwd: 'C:\\Workspace\\Safe' });
    expect(deps.codex.startThread).not.toHaveBeenCalledWith({ cwd: 'C:\\Outside' });
  });

  it('refreshes model info from newer Codex session jsonl turn contexts', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-refresh.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5', effort: 'high' } }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'thread-with-changing-model',
      path: sessionPath,
      cwd: 'C:\\Workspace\\Project'
    });
    deps.codex.listThreads.mockResolvedValue([
      {
        id: 'thread-with-changing-model',
        preview: 'Changing model',
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'existing-thread', 'C:\\Workspace\\Project');
    await handlers.handleNewChat(makeContext().ctx);

    const first = makeContext();
    await handlers.handleCurrent(first.ctx);
    expect(first.replies.join('\n')).toContain('Model: gpt-5 high');

    await appendFile(
      sessionPath,
      `\n${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'xhigh' } })}`,
      'utf8'
    );

    const second = makeContext();
    await handlers.handleCurrent(second.ctx);
    expect(second.replies.join('\n')).toContain('Model: gpt-5.5 xhigh');
  });

  it('uses safe one-line titles in /select_chat lists', async () => {
    const deps = dependencies();
    deps.codex.listThreads.mockResolvedValueOnce([
      {
        id: 'thread-with-multiline-preview',
        preview:
          'First line title\nSelected chat:\nChat: rollout-2026-05-02T16-43-09-019de8ed.jsonl\nProject: C:\\Workspace\\Project',
        path: 'C:\\Users\\Owner\\.codex\\sessions\\rollout-2026-05-02T16-43-09-019de8ed.jsonl',
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ] as CodexThread[]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');
    const list = makeContext();

    await handlers.handleProjectChats(list.ctx);

    const response = list.replies.join('\n');
    expect(response).toContain('1. First line title');
    expect(response.match(/^Selected chat:/gm)).toBeNull();
    expect(response).not.toContain('rollout-2026-05-02T16-43-09-019de8ed.jsonl');
    expect(JSON.stringify(list.replyOptions)).not.toContain('rollout-2026-05-02T16-43-09-019de8ed.jsonl');
  });

  it('prefers latest session jsonl model info over stale thread metadata', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-stale-metadata.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'xhigh' } }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'thread-with-stale-metadata',
      preview: 'Stale metadata',
      model: 'gpt-5',
      effort: 'low',
      path: sessionPath,
      cwd: 'C:\\Workspace\\Project'
    });
    deps.codex.listThreads.mockResolvedValue([
      {
        id: 'thread-with-stale-metadata',
        preview: 'Stale metadata',
        model: 'gpt-5',
        effort: 'low',
        path: sessionPath,
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ] as CodexThread[]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'existing-thread', 'C:\\Workspace\\Project');
    await handlers.handleNewChat(makeContext().ctx);

    const current = makeContext();
    await handlers.handleCurrent(current.ctx);

    expect(current.replies.join('\n')).toContain('Model: gpt-5.5 xhigh');
    expect(current.replies.join('\n')).not.toContain('Model: gpt-5 low');
  });

  it('prefers latest session jsonl model info in the new_chat response', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-new-chat-stale-metadata.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'xhigh' } }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'thread-with-stale-new-chat-metadata',
      preview: 'Stale new chat metadata',
      model: 'gpt-5',
      effort: 'low',
      path: sessionPath,
      cwd: 'C:\\Workspace\\Project'
    });
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'existing-thread', 'C:\\Workspace\\Project');
    const created = makeContext();

    await handlers.handleNewChat(created.ctx);

    expect(created.replies.join('\n')).toContain('Model: gpt-5.5 xhigh');
    expect(created.replies.join('\n')).not.toContain('Model: gpt-5 low');
  });

  it('keeps cached model info when a changed session tail has no turn context', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-no-context-tail.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5', effort: 'high' } }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.startThread.mockResolvedValueOnce({
      id: 'thread-with-large-tail',
      path: sessionPath,
      cwd: 'C:\\Workspace\\Project'
    });
    deps.codex.listThreads.mockResolvedValue([
      {
        id: 'thread-with-large-tail',
        preview: 'Large tail',
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'existing-thread', 'C:\\Workspace\\Project');
    await handlers.handleNewChat(makeContext().ctx);

    const first = makeContext();
    await handlers.handleCurrent(first.ctx);
    expect(first.replies.join('\n')).toContain('Model: gpt-5 high');

    await appendFile(sessionPath, `\n${'x'.repeat(1024 * 1024 + 16)}`, 'utf8');

    const second = makeContext();
    await handlers.handleCurrent(second.ctx);
    expect(second.replies.join('\n')).toContain('Model: gpt-5 high');
  });

  it('keeps jsonl model info over stale metadata when a changed session tail has no turn context', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-stale-metadata-large-tail.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'xhigh' } }),
      'utf8'
    );

    const deps = dependencies();
    deps.codex.listThreads.mockResolvedValue([
      {
        id: 'thread-with-stale-metadata-large-tail',
        preview: 'Stale metadata large tail',
        model: 'gpt-5',
        effort: 'low',
        path: sessionPath,
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ] as CodexThread[]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-with-stale-metadata-large-tail', 'C:\\Workspace\\Project');

    const first = makeContext();
    await handlers.handleCurrent(first.ctx);
    expect(first.replies.join('\n')).toContain('Model: gpt-5.5 xhigh');
    expect(first.replies.join('\n')).not.toContain('Model: gpt-5 low');

    await appendFile(sessionPath, `\n${'x'.repeat(1024 * 1024 + 16)}`, 'utf8');

    const second = makeContext();
    await handlers.handleCurrent(second.ctx);
    expect(second.replies.join('\n')).toContain('Model: gpt-5.5 xhigh');
    expect(second.replies.join('\n')).not.toContain('Model: gpt-5 low');
  });

  it('uses jsonl model info on a cold cache when stale metadata has a large session tail', async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-'));
    const sessionPath = path.join(sessionDir, 'rollout-2026-05-02T16-43-09-cold-large-tail.jsonl');
    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'xhigh' } }),
      'utf8'
    );
    await appendFile(sessionPath, `\n${'x'.repeat(1024 * 1024 + 16)}`, 'utf8');

    const deps = dependencies();
    deps.codex.listThreads.mockResolvedValue([
      {
        id: 'thread-with-cold-large-tail',
        preview: 'Cold large tail',
        model: 'gpt-5',
        effort: 'low',
        path: sessionPath,
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ] as CodexThread[]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-with-cold-large-tail', 'C:\\Workspace\\Project');

    const current = makeContext();
    await handlers.handleCurrent(current.ctx);

    expect(current.replies.join('\n')).toContain('Model: gpt-5.5 xhigh');
    expect(current.replies.join('\n')).not.toContain('Model: gpt-5 low');
  });

  it('does not use rollout jsonl filenames as display titles', async () => {
    const deps = dependencies();
    deps.codex.listThreads.mockResolvedValueOnce([
      {
        id: 'thread-with-rollout-name',
        name: 'rollout-2026-05-02T16-43-09-019de8ed-c3b3-73b3-9879-f4179a85c1ce.jsonl',
        cwd: 'C:\\Workspace\\Project',
        updatedAt: 1
      }
    ] as CodexThread[]);
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'selected-thread', 'C:\\Workspace\\Project');

    const list = makeContext();
    await handlers.handleProjectChats(list.ctx);

    const response = list.replies.join('\n');
    expect(response).toContain('1. Untitled chat');
    expect(response).not.toContain('rollout-2026-05-02T16-43-09');
    expect(JSON.stringify(list.replyOptions)).not.toContain('rollout-2026-05-02T16-43-09');
  });

  it('resume failure prevents selection', async () => {
    const deps = dependencies();
    deps.codex.resumeThread.mockRejectedValueOnce(new Error('resume failed'));
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext();

    await handlers.handleCallback(makeContext({
      callbackData: handlers.callbackData.createSelectProject('C:\\Workspace\\Project')
    }).ctx);
    deps.updateCommandMenu.mockClear();
    const callbackData = handlers.callbackData.createSelectChat('project-1', 'C:\\Workspace\\Project');
    await handlers.handleCallback({ ...ctx, callbackData });

    expect(handlers.getSelectedThread(ownerId)).toBeNull();
    expect(deps.updateCommandMenu).not.toHaveBeenCalled();
    expect(replies.join('\n')).toContain('Could not select chat');
  });

  it('stale callback returns a clear error', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext({ callbackData: 's:missing' });

    await handlers.handleCallback(ctx);

    expect(replies.join('\n')).toContain('expired');
  });

  it('rejects unauthorized callbacks before Codex calls', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const callbackData = handlers.callbackData.createSelectChat('project-1');
    const { ctx, replies } = makeContext({ fromId: 1, chatId: 1, callbackData });

    await handlers.handleCallback(ctx);

    expect(replies.join('\n')).toContain('Access denied');
    expect(deps.codex.resumeThread).not.toHaveBeenCalled();
    expect(deps.updateCommandMenu).not.toHaveBeenCalled();
  });

  it('rejects unauthorized new_chat before Codex calls', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext({ fromId: 1, chatId: 1 });

    await handlers.handleNewChat(ctx);

    expect(replies.join('\n')).toContain('Access denied');
    expect(deps.codex.startThread).not.toHaveBeenCalled();
  });

  it('requests reboot only for the owner in a private chat', async () => {
    const deps = dependencies();
    const calls: string[] = [];
    const onRebootRequested = vi.fn(async () => {
      calls.push('reboot');
    });
    const confirmUpdate = vi.fn(async () => {
      calls.push('confirm');
    });
    const handlers = createTelegramHandlers({ config: config(), ...deps, onRebootRequested });
    const { ctx, replies } = makeContext({
      reply: async (text) => {
        calls.push('reply');
        replies.push(text);
      },
      confirmUpdate
    });

    await handlers.handleReboot(ctx);

    expect(replies.join('\n')).toContain('Restarting');
    expect(confirmUpdate).toHaveBeenCalledTimes(1);
    expect(onRebootRequested).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['reply', 'confirm', 'reboot']);
  });

  it('does not reboot when the reboot update cannot be confirmed', async () => {
    const deps = dependencies();
    const onRebootRequested = vi.fn(async () => undefined);
    const confirmUpdate = vi.fn(async () => {
      throw new Error('confirm failed');
    });
    const onDeliveryError = vi.fn();
    const handlers = createTelegramHandlers({ config: config(), ...deps, onRebootRequested, onDeliveryError });
    const { ctx, replies } = makeContext({ confirmUpdate });

    await handlers.handleReboot(ctx);

    expect(replies.join('\n')).toContain('Restarting');
    expect(replies.join('\n')).toContain('Could not confirm reboot request');
    expect(onDeliveryError).toHaveBeenCalledWith(expect.any(Error));
    expect(onRebootRequested).not.toHaveBeenCalled();
  });

  it('still requests reboot when the Telegram restart reply fails', async () => {
    const deps = dependencies();
    const onRebootRequested = vi.fn(async () => undefined);
    const confirmUpdate = vi.fn(async () => undefined);
    const handlers = createTelegramHandlers({ config: config(), ...deps, onRebootRequested });
    const { ctx } = makeContext({
      reply: vi.fn(async () => {
        throw new Error('Telegram failed');
      }),
      confirmUpdate
    });

    await handlers.handleReboot(ctx);

    expect(confirmUpdate).toHaveBeenCalledTimes(1);
    expect(onRebootRequested).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthorized reboot before requesting restart', async () => {
    const deps = dependencies();
    const onRebootRequested = vi.fn(async () => undefined);
    const handlers = createTelegramHandlers({ config: config(), ...deps, onRebootRequested });
    const { ctx, replies } = makeContext({ fromId: 1, chatId: 1 });

    await handlers.handleReboot(ctx);

    expect(replies.join('\n')).toContain('Access denied');
    expect(onRebootRequested).not.toHaveBeenCalled();
  });

  it('rejects reboot from groups before requesting restart', async () => {
    const deps = dependencies();
    const onRebootRequested = vi.fn(async () => undefined);
    const handlers = createTelegramHandlers({ config: config(), ...deps, onRebootRequested });
    const { ctx, replies } = makeContext({ chatId: -100, chatType: 'group' });

    await handlers.handleReboot(ctx);

    expect(replies.join('\n')).toContain('private chat');
    expect(onRebootRequested).not.toHaveBeenCalled();
  });

  it('rejects non-owner new_chat before Codex calls', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext({ fromId: 1, chatId: 1 });

    await handlers.handleNewChat(ctx);

    expect(replies.join('\n')).toContain('Access denied');
    expect(deps.codex.startThread).not.toHaveBeenCalled();
  });

  it('rejects plain text from unauthorized users before future Codex send handling', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext({ fromId: 1, chatId: 1, text: 'hello' });

    await handlers.handleText(ctx);

    expect(replies.join('\n')).toContain('Access denied');
    expect(deps.codex.listThreads).not.toHaveBeenCalled();
  });

  it('rejects owner plain text before a chat is selected', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext({ text: 'hello' });

    await handlers.handleText(ctx);

    expect(replies.join('\n')).toContain('No chat selected');
    expect(replies.join('\n')).toContain('/select_chat');
    expect(replies.join('\n')).toContain('/select_project');
    expect(replies.join('\n')).not.toContain('/chats');
    expect(replies.join('\n')).not.toContain('/new_project_chat');
  });

  it('does not treat unknown slash commands as prompts', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext({ text: '/typo' });

    await handlers.handleText(ctx);

    expect(replies.join('\n')).toContain('Unknown command');
  });

  it('shows no-chat help for shorthand help text before a chat is selected', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });

    const question = makeContext({ text: '?' });
    await handlers.handleText(question.ctx);

    const slash = makeContext({ text: '/' });
    await handlers.handleText(slash.ctx);

    const response = `${question.replies.join('\n')}\n${slash.replies.join('\n')}`;
    expect(response).toContain('/status');
    expect(response).toContain('/select_project');
    expect(response).not.toContain('/select_chat');
    expect(response).not.toContain('/new_chat');
    expect(response).not.toContain('/delete_chat');
    expect(response).not.toContain('/current');
    expect(response).not.toContain('/summary_chat');
    expect(deps.codex.startTurn).not.toHaveBeenCalled();
  });

  it('shows help for shorthand help text instead of sending it as a Codex prompt', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-1', 'C:\\Workspace\\Project');

    const question = makeContext({ text: '?' });
    await handlers.handleText(question.ctx);

    const slash = makeContext({ text: '/' });
    await handlers.handleText(slash.ctx);

    expect(question.replies.join('\n')).toContain('/status');
    expect(question.replies.join('\n')).toContain('/new_chat');
    expect(question.replies.join('\n')).toContain('/delete_chat');
    expect(question.replies.join('\n')).toContain('/current');
    expect(question.replies.join('\n')).toContain('/summary_chat');
    expect(slash.replies.join('\n')).not.toContain('/chats');
    expect(slash.replies.join('\n')).not.toContain('/new_project_chat');
    expect(deps.codex.startTurn).not.toHaveBeenCalled();
  });
});
