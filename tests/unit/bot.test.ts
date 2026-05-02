import type { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

import { confirmTelegramUpdate, sanitizeTelegramError, updateScopedTelegramCommandMenu } from '../../src/telegram/bot.js';

describe('confirmTelegramUpdate', () => {
  it('confirms the current Telegram update by requesting the next offset', async () => {
    const api = { getUpdates: vi.fn(async () => []) };

    await confirmTelegramUpdate({
      api,
      update: { update_id: 123 }
    } as unknown as Pick<Context, 'api' | 'update'>);

    expect(api.getUpdates).toHaveBeenCalledWith({ offset: 124, limit: 1, timeout: 0 });
  });
});

describe('sanitizeTelegramError', () => {
  it('keeps Telegram API error logs free of outgoing payload text', () => {
    const sanitized = sanitizeTelegramError(
      Object.assign(new Error('Call to sendMessage failed'), {
        error_code: 400,
        method: 'sendMessage',
        payload: {
          chat_id: 42,
          text: 'private assistant response'
        },
        description: 'Bad Request with private assistant response'
      })
    );

    const serialized = JSON.stringify(sanitized);
    expect(serialized).toContain('sendMessage');
    expect(serialized).toContain('hasPayload');
    expect(serialized).not.toContain('42');
    expect(serialized).not.toContain('private assistant response');
    expect(serialized).not.toContain('Bad Request');
  });
});

describe('updateScopedTelegramCommandMenu', () => {
  it('sets active-chat commands for the requested Telegram chat scope', async () => {
    const api = { setMyCommands: vi.fn(async () => true) };
    const logger = { warn: vi.fn() };

    await updateScopedTelegramCommandMenu({ api, logger, chatId: 42, hasSelectedChat: true });

    expect(api.setMyCommands).toHaveBeenCalledWith(
      [
        { command: 'start', description: 'Show access result and help' },
        { command: 'help', description: 'Show available commands' },
        { command: 'status', description: 'Show Codex connection status and URL' },
        { command: 'limits', description: 'Show current Codex limit remaining' },
        { command: 'select_project', description: 'Choose a project' },
        { command: 'reboot', description: 'Restart Codex app-server and bot' },
        { command: 'select_chat', description: 'List chats for the selected project' },
        { command: 'new_chat', description: 'Create another chat in the selected project' },
        { command: 'delete_chat', description: 'Delete a chat from the selected project' },
        { command: 'current', description: 'Show selected chat, context, and project' },
        { command: 'summary_chat', description: 'Ask Codex for selected chat summary' },
        { command: 'review_fix', description: 'Review and fix issues in the selected chat' },
        { command: 'commit', description: 'Commit and merge verified project changes' }
      ],
      { scope: { type: 'chat', chat_id: 42 } }
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('sets base-only commands for the requested Telegram chat scope without a selected chat', async () => {
    const api = { setMyCommands: vi.fn(async () => true) };

    await updateScopedTelegramCommandMenu({ api, chatId: 42, hasSelectedChat: false });

    expect(api.setMyCommands).toHaveBeenCalledWith(
      [
        { command: 'start', description: 'Show access result and help' },
        { command: 'help', description: 'Show available commands' },
        { command: 'status', description: 'Show Codex connection status and URL' },
        { command: 'limits', description: 'Show current Codex limit remaining' },
        { command: 'select_project', description: 'Choose a project' },
        { command: 'reboot', description: 'Restart Codex app-server and bot' }
      ],
      { scope: { type: 'chat', chat_id: 42 } }
    );
  });

  it('logs sanitized command menu update failures', async () => {
    const api = {
      setMyCommands: vi.fn(async () => {
        throw Object.assign(new Error('telegram failed'), {
          payload: { text: 'secret command menu payload' },
          description: 'raw telegram failure'
        });
      })
    };
    const logger = { warn: vi.fn() };

    await updateScopedTelegramCommandMenu({ api, logger, chatId: 42, hasSelectedChat: true });

    expect(logger.warn).toHaveBeenCalledWith(
      { telegramError: expect.objectContaining({ hasPayload: true, hasDescription: true }) },
      'Telegram command menu update failed'
    );
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain('secret command menu payload');
    expect(logged).not.toContain('raw telegram failure');
  });
});
