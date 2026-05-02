import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { REBOOT_EXIT_CODE } from '../../src/runtime/reboot.js';
import {
  createAppServerPlan,
  createBotPlan,
  isRebootExit,
  npmCommand
} from '../../src/supervisor/plan.js';
import { createForceKillPlan, createSpawnInvocation, stopChildProcess } from '../../src/supervisor/processes.js';
import { runSupervisorOnce, sendTelegramOwnerNotice, type ManagedProcess } from '../../src/supervisor/main.js';

describe('supervisor planning', () => {
  it('uses npm.cmd on Windows and npm elsewhere', () => {
    expect(npmCommand('win32')).toBe('npm.cmd');
    expect(npmCommand('linux')).toBe('npm');
  });

  it('creates an app-server command from the configured websocket URL', () => {
    expect(createAppServerPlan('ws://127.0.0.1:18765')).toEqual({
      command: 'codex',
      args: ['app-server', '--listen', 'ws://127.0.0.1:18765']
    });
  });

  it('maps DEV mode to npm run dev', () => {
    expect(createBotPlan('DEV', 'linux')).toEqual([{ command: 'npm', args: ['run', 'dev'] }]);
  });

  it('maps PROD mode to build then start', () => {
    expect(createBotPlan('PROD', 'win32')).toEqual([
      { command: 'npm.cmd', args: ['run', 'build'] },
      { command: 'npm.cmd', args: ['start'] }
    ]);
  });

  it('recognizes only the reserved reboot exit code as a restart request', () => {
    expect(isRebootExit({ code: REBOOT_EXIT_CODE, signal: null })).toBe(true);
    expect(isRebootExit({ code: 1, signal: null })).toBe(false);
    expect(isRebootExit({ code: null, signal: 'SIGTERM' })).toBe(false);
  });

  it('wraps Windows command shims through cmd.exe without requiring PowerShell', () => {
    expect(createSpawnInvocation({ command: 'npm.cmd', args: ['run', 'dev'] }, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'dev']
    });
    expect(createSpawnInvocation({ command: 'codex', args: ['--version'] }, 'linux', {})).toEqual({
      command: 'codex',
      args: ['--version']
    });
  });

  it('plans Windows process-tree force cleanup as a taskkill fallback', () => {
    expect(createForceKillPlan(1234, 'win32')).toEqual({
      command: 'taskkill.exe',
      args: ['/PID', '1234', '/T', '/F']
    });
    expect(createForceKillPlan(1234, 'linux')).toBeNull();
  });

  it('cancels the force-kill timer when a stopped child exits normally', async () => {
    vi.useFakeTimers();
    try {
      await withPlatform('linux', async () => {
        const child = processEventStub(1234);
        const forceKill = vi.fn(async () => undefined);
        const stop = stopChildProcess(child as unknown as ChildProcess, 'bot', forceKill);

        child.emit('exit', 0, null);
        await stop;
        await vi.advanceTimersByTimeAsync(5001);

        expect(forceKill).not.toHaveBeenCalled();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills the Windows command wrapper process tree immediately', async () => {
    await withPlatform('win32', async () => {
      const child = processEventStub(1234);
      const forceKill = vi.fn(async () => undefined);
      const stop = stopChildProcess(child as unknown as ChildProcess, 'app-server', forceKill);

      await Promise.resolve();

      expect(forceKill).toHaveBeenCalledWith(1234);
      expect(child.kill).not.toHaveBeenCalled();

      child.emit('exit', null, 'SIGTERM');
      await stop;
    });
  });

  it('sends supervisor notices directly through Telegram Bot API', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));

    await sendTelegramOwnerNotice({
      telegramBotToken: 'secret-token',
      telegramOwnerId: 42,
      text: 'Codex app-server exited unexpectedly',
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.telegram.org/botsecret-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: 42,
          text: 'Codex app-server exited unexpectedly'
        })
      })
    );
  });

  it('times out hung direct Telegram supervisor notices', async () => {
    await expect(
      sendTelegramOwnerNotice({
        telegramBotToken: 'secret-token',
        telegramOwnerId: 42,
        text: 'Codex app-server exited unexpectedly',
        fetchImpl: () => new Promise(() => undefined),
        timeoutMs: 1
      })
    ).rejects.toThrow();
  });
});

describe('runSupervisorOnce', () => {
  it('stops app-server and requests a restart when the bot exits with the reboot code', async () => {
    const appServer = processStub();
    const bot = processStub({ code: REBOOT_EXIT_CODE, signal: null });
    const start = vi.fn((name: string): ManagedProcess => (name === 'app-server' ? appServer : bot));

    await expect(
      runSupervisorOnce({
        codexWsUrl: 'ws://127.0.0.1:18765',
        botRunMode: 'DEV',
        start
      })
    ).resolves.toBe('reboot');

    expect(start).toHaveBeenCalledWith('app-server', {
      command: 'codex',
      args: ['app-server', '--listen', 'ws://127.0.0.1:18765']
    });
    expect(start).toHaveBeenCalledWith('bot', { command: expect.any(String), args: ['run', 'dev'] });
    expect(appServer.stop).toHaveBeenCalledTimes(1);
  });

  it('stops app-server and exits when the bot exits with a non-reboot code', async () => {
    const appServer = processStub();
    const bot = processStub({ code: 1, signal: null });
    const notifyOwner = vi.fn(async () => undefined);
    const start = vi.fn((name: string): ManagedProcess => (name === 'app-server' ? appServer : bot));

    await expect(
      runSupervisorOnce({
        codexWsUrl: 'ws://127.0.0.1:18765',
        botRunMode: 'DEV',
        start,
        notifyOwner
      })
    ).resolves.toBe('exit');

    expect(appServer.stop).toHaveBeenCalledTimes(1);
    expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining('Telegram bot process exited unexpectedly'));
  });

  it('notifies the owner when the bot exits cleanly outside the reboot path', async () => {
    const appServer = processStub();
    const bot = processStub({ code: 0, signal: null });
    const notifyOwner = vi.fn(async () => undefined);
    const start = vi.fn((name: string): ManagedProcess => (name === 'app-server' ? appServer : bot));

    await expect(
      runSupervisorOnce({
        codexWsUrl: 'ws://127.0.0.1:18765',
        botRunMode: 'DEV',
        start,
        notifyOwner
      })
    ).resolves.toBe('exit');

    expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining('Telegram bot process exited unexpectedly'));
  });

  it('notifies the owner when app-server exits and supervisor stops the bot', async () => {
    const appServer = processStub({ code: 1, signal: null });
    const bot = processStub();
    const notifyOwner = vi.fn(async () => undefined);
    const start = vi.fn((name: string): ManagedProcess => (name === 'app-server' ? appServer : bot));

    await expect(
      runSupervisorOnce({
        codexWsUrl: 'ws://127.0.0.1:18765',
        botRunMode: 'DEV',
        start,
        notifyOwner
      })
    ).resolves.toBe('exit');

    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining('Codex app-server exited unexpectedly'));
  });

  it('notifies the owner when app-server exits cleanly and supervisor stops the bot', async () => {
    const appServer = processStub({ code: 0, signal: null });
    const bot = processStub();
    const notifyOwner = vi.fn(async () => undefined);
    const start = vi.fn((name: string): ManagedProcess => (name === 'app-server' ? appServer : bot));

    await expect(
      runSupervisorOnce({
        codexWsUrl: 'ws://127.0.0.1:18765',
        botRunMode: 'DEV',
        start,
        notifyOwner
      })
    ).resolves.toBe('exit');

    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining('Codex app-server exited unexpectedly'));
  });

  it('does not let a hung owner notification block child cleanup', async () => {
    const appServer = processStub({ code: 1, signal: null });
    const bot = processStub();
    const start = vi.fn((name: string): ManagedProcess => (name === 'app-server' ? appServer : bot));

    await expect(
      runSupervisorOnce({
        codexWsUrl: 'ws://127.0.0.1:18765',
        botRunMode: 'DEV',
        start,
        notifyOwner: () => new Promise(() => undefined),
        ownerNotificationTimeoutMs: 1
      })
    ).resolves.toBe('exit');

    expect(bot.stop).toHaveBeenCalledTimes(1);
  });

  it('logs sanitized supervisor notification failures without raw Telegram tokens', async () => {
    const appServer = processStub({ code: 1, signal: null });
    const bot = processStub();
    const logger = { warn: vi.fn() };
    const start = vi.fn((name: string): ManagedProcess => (name === 'app-server' ? appServer : bot));

    await runSupervisorOnce({
      codexWsUrl: 'ws://127.0.0.1:18765',
      botRunMode: 'DEV',
      start,
      logger,
      notifyOwner: () => {
        throw new Error('https://api.telegram.org/botsecret-token/sendMessage failed');
      }
    });

    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-token');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationError: expect.objectContaining({ name: 'Error' })
      }),
      'Supervisor owner notification failed'
    );
  });

  it('runs build before start in PROD mode', async () => {
    const appServer = processStub();
    const build = processStub({ code: 0, signal: null });
    const bot = processStub({ code: REBOOT_EXIT_CODE, signal: null });
    const start = vi.fn((name: string): ManagedProcess => {
      if (name === 'app-server') {
        return appServer;
      }
      if (name === 'bot-build') {
        return build;
      }
      return bot;
    });

    await expect(
      runSupervisorOnce({
        codexWsUrl: 'ws://127.0.0.1:18765',
        botRunMode: 'PROD',
        start
      })
    ).resolves.toBe('reboot');

    expect(start.mock.calls.map(([name]) => name)).toEqual(['app-server', 'bot-build', 'bot']);
  });

  it('does not start the bot when the PROD build fails', async () => {
    const appServer = processStub();
    const build = processStub({ code: 1, signal: null });
    const start = vi.fn((name: string): ManagedProcess => (name === 'app-server' ? appServer : build));

    await expect(
      runSupervisorOnce({
        codexWsUrl: 'ws://127.0.0.1:18765',
        botRunMode: 'PROD',
        start
      })
    ).resolves.toBe('exit');

    expect(start.mock.calls.map(([name]) => name)).toEqual(['app-server', 'bot-build']);
    expect(appServer.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the running bot and app-server when a supervisor stop is requested', async () => {
    const stop = deferred<void>();
    const appServer = processStub();
    const bot = processStub();
    const start = vi.fn((name: string): ManagedProcess => (name === 'app-server' ? appServer : bot));
    const supervisor = runSupervisorOnce({
      codexWsUrl: 'ws://127.0.0.1:18765',
      botRunMode: 'DEV',
      start,
      stopSignal: stop.promise
    });

    await vi.waitFor(() => expect(start.mock.calls.map(([name]) => name)).toEqual(['app-server', 'bot']));
    stop.resolve();

    await expect(Promise.race([supervisor, sleep(50).then(() => 'timed-out')])).resolves.toBe('exit');
    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(appServer.stop).toHaveBeenCalledTimes(1);
  });
});

type ExitResult = { code: number | null; signal: NodeJS.Signals | null };

function processStub(exitResult?: ExitResult): ManagedProcess {
  return {
    waitForExit: exitResult === undefined ? new Promise(() => undefined) : Promise.resolve(exitResult),
    stop: vi.fn(async () => undefined)
  };
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ProcessEventStub = {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: string, listener: (...args: unknown[]) => void): ProcessEventStub;
  kill: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): void;
};

function processEventStub(pid: number): ProcessEventStub {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    pid,
    exitCode: null,
    signalCode: null,
    once(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    kill: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      const eventListeners = listeners.get(event) ?? [];
      listeners.delete(event);
      for (const listener of eventListeners) {
        listener(...args);
      }
    }
  };
}

async function withPlatform<T>(platform: NodeJS.Platform, callback: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await callback();
  } finally {
    if (original !== undefined) {
      Object.defineProperty(process, 'platform', original);
    }
  }
}
