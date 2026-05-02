import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createApprovalRequestHandler,
  createRuntimeShutdown,
  setupGracefulShutdown,
  startRuntime
} from '../../src/main.js';
import { TELEGRAM_APPROVAL_UNAVAILABLE_MESSAGE } from '../../src/domain/approvals.js';

describe('runtime shutdown', () => {
  it('stops Telegram polling and closes the Codex websocket once', async () => {
    const bot = { stop: vi.fn(async () => undefined) };
    const codex = { close: vi.fn() };
    const logger = { info: vi.fn(), error: vi.fn() };
    const shutdown = createRuntimeShutdown({ bot, codex, logger });

    await shutdown('SIGINT');
    await shutdown('SIGTERM');

    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(codex.close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'Stopping Codex Telegram app-server bot');
  });

  it('still closes Codex when Telegram stop fails', async () => {
    const bot = {
      stop: vi.fn(async () => {
        throw new Error('polling stop failed');
      })
    };
    const codex = { close: vi.fn() };
    const logger = { info: vi.fn(), error: vi.fn() };
    const shutdown = createRuntimeShutdown({ bot, codex, logger });

    await shutdown('SIGTERM');

    expect(codex.close).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith({ error: expect.any(Error) }, 'Telegram polling stop failed');
  });

  it('wires SIGINT and SIGTERM to graceful shutdown', async () => {
    const signalTarget = new EventEmitter();
    const bot = { stop: vi.fn(async () => undefined) };
    const codex = { close: vi.fn() };
    const logger = { info: vi.fn(), error: vi.fn() };

    const cleanup = setupGracefulShutdown({
      bot,
      codex,
      logger,
      signalTarget
    });

    signalTarget.emit('SIGINT', 'SIGINT');
    signalTarget.emit('SIGTERM', 'SIGTERM');

    await vi.waitFor(() => expect(bot.stop).toHaveBeenCalledTimes(1));
    expect(codex.close).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('does not start Telegram polling after shutdown is requested during startup', async () => {
    let releaseConnect: () => void = () => undefined;
    const bot = {
      api: { setMyCommands: vi.fn(async () => undefined) },
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    };
    const codex = {
      connect: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseConnect = resolve;
          })
      ),
      close: vi.fn()
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const shutdown = createRuntimeShutdown({ bot, codex, logger });

    const startup = startRuntime({ bot, codex, logger, shutdown, telegramOwnerId: 42 });
    await vi.waitFor(() => expect(codex.connect).toHaveBeenCalledTimes(1));

    await shutdown('SIGTERM');
    releaseConnect();

    await expect(startup).resolves.toBe('shutdown-requested');
    expect(bot.api.setMyCommands).not.toHaveBeenCalled();
    expect(bot.start).not.toHaveBeenCalled();
    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(codex.close).toHaveBeenCalledTimes(1);
  });

  it('registers the no-chat Telegram command menu before polling starts', async () => {
    const calls: string[] = [];
    const bot = {
      api: {
        setMyCommands: vi.fn(async () => {
          calls.push('commands');
        })
      },
      start: vi.fn(async () => {
        calls.push('start');
      }),
      stop: vi.fn(async () => undefined)
    };
    const codex = {
      connect: vi.fn(async () => undefined),
      close: vi.fn()
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const shutdown = createRuntimeShutdown({ bot, codex, logger });

    await expect(startRuntime({ bot, codex, logger, shutdown, telegramOwnerId: 42 })).resolves.toBe('started');

    const noChatCommands = [
      { command: 'start', description: 'Show access result and help' },
      { command: 'help', description: 'Show available commands' },
      { command: 'status', description: 'Show Codex connection status and URL' },
      { command: 'limits', description: 'Show current Codex limit remaining' },
      { command: 'select_project', description: 'Choose a project' },
      { command: 'reboot', description: 'Restart Codex app-server and bot' }
    ];
    expect(bot.api.setMyCommands).toHaveBeenNthCalledWith(1, noChatCommands);
    expect(bot.api.setMyCommands).toHaveBeenNthCalledWith(2, noChatCommands, {
      scope: { type: 'chat', chat_id: 42 }
    });
    expect(calls).toEqual(['commands', 'commands', 'start']);
  });

  it('continues startup when Telegram command menu registration fails', async () => {
    const bot = {
      api: {
        setMyCommands: vi.fn(async () => {
          throw Object.assign(new Error('telegram failed'), {
            payload: { token: 'secret' },
            description: 'raw telegram failure'
          });
        })
      },
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    };
    const codex = {
      connect: vi.fn(async () => undefined),
      close: vi.fn()
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const shutdown = createRuntimeShutdown({ bot, codex, logger });

    await expect(startRuntime({ bot, codex, logger, shutdown, telegramOwnerId: 42 })).resolves.toBe('started');

    expect(bot.start).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { telegramError: expect.objectContaining({ hasPayload: true, hasDescription: true }) },
      'Telegram command menu registration failed'
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('raw telegram failure');
  });

  it('still attempts the owner chat command menu reset when global registration fails', async () => {
    const bot = {
      api: {
        setMyCommands: vi
          .fn()
          .mockRejectedValueOnce(Object.assign(new Error('telegram failed'), { description: 'raw failure' }))
          .mockResolvedValueOnce(undefined)
      },
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    };
    const codex = {
      connect: vi.fn(async () => undefined),
      close: vi.fn()
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const shutdown = createRuntimeShutdown({ bot, codex, logger });

    await expect(startRuntime({ bot, codex, logger, shutdown, telegramOwnerId: 42 })).resolves.toBe('started');

    const noChatCommands = [
      { command: 'start', description: 'Show access result and help' },
      { command: 'help', description: 'Show available commands' },
      { command: 'status', description: 'Show Codex connection status and URL' },
      { command: 'limits', description: 'Show current Codex limit remaining' },
      { command: 'select_project', description: 'Choose a project' },
      { command: 'reboot', description: 'Restart Codex app-server and bot' }
    ];
    expect(bot.api.setMyCommands).toHaveBeenNthCalledWith(1, noChatCommands);
    expect(bot.api.setMyCommands).toHaveBeenNthCalledWith(2, noChatCommands, {
      scope: { type: 'chat', chat_id: 42 }
    });
    expect(bot.start).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { telegramError: expect.objectContaining({ hasDescription: true }) },
      'Telegram command menu registration failed'
    );
  });
});

describe('approval fallback notification', () => {
  it('notifies the Telegram owner with a sanitized fail-closed message', async () => {
    const bot = {
      api: {
        sendMessage: vi.fn(async () => undefined)
      }
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const handler = createApprovalRequestHandler({
      config: { telegramOwnerId: 42 },
      logger,
      getBot: () => bot
    });

    await handler({
      id: 1,
      method: 'approval/request',
      threadId: 'thread-secret',
      turnId: 'turn-secret',
      params: { command: 'raw approval command' }
    });

    expect(bot.api.sendMessage).toHaveBeenCalledWith(42, TELEGRAM_APPROVAL_UNAVAILABLE_MESSAGE);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('thread-secret');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('raw approval command');
  });

  it('logs sanitized approval notification failures', async () => {
    const bot = {
      api: {
        sendMessage: vi.fn(async () => {
          throw Object.assign(new Error('telegram failed'), {
            payload: { text: 'raw approval notice text' },
            description: 'raw telegram failure description'
          });
        })
      }
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const handler = createApprovalRequestHandler({
      config: { telegramOwnerId: 42 },
      logger,
      getBot: () => bot
    });

    await handler({ id: 1, method: 'approval/request' });

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('hasPayload');
    expect(logged).not.toContain('raw approval notice text');
    expect(logged).not.toContain('raw telegram failure description');
  });
});
