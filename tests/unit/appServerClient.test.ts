import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from '../../src/codex/appServerClient.js';
import { ActiveTurnStore } from '../../src/domain/turns.js';

type FakeSocket = {
  readyState: number;
  close: () => void;
  terminate: () => void;
  send: (message: string, callback: (error?: Error) => void) => void;
};

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('CodexAppServerClient lifecycle', () => {
  it('discards sockets that open after the client was manually closed', async () => {
    const client = new CodexAppServerClient({
      url: 'ws://127.0.0.1:1',
      requestTimeoutMs: 10,
      reconnect: { enabled: false },
      heartbeat: { enabled: false }
    });
    const opened = deferred<FakeSocket>();
    const staleSocket: FakeSocket = {
      readyState: 1,
      close: vi.fn(),
      terminate: vi.fn(),
      send: vi.fn()
    };
    (client as unknown as { openSocket: () => Promise<typeof staleSocket> }).openSocket = () => opened.promise;

    const connectPromise = client.connect();
    client.close();
    opened.resolve(staleSocket);

    await expect(connectPromise).rejects.toThrow('closed before initialization');
    expect(staleSocket.terminate).toHaveBeenCalledTimes(1);
    expect(staleSocket.send).not.toHaveBeenCalled();
    expect(client.connectionStatus).toBe('disconnected');
  });
});

describe('ActiveTurnStore', () => {
  it('routes interleaved deltas to the initiating Telegram contexts', () => {
    const turns = new ActiveTurnStore();

    turns.start({
      turnId: 'turn-a',
      threadId: 'thread-a',
      telegramChatId: 1001,
      telegramMessageId: 11,
      selectedThreadId: 'thread-a'
    });
    turns.start({
      turnId: 'turn-b',
      threadId: 'thread-b',
      telegramChatId: 1002,
      telegramMessageId: 12,
      selectedThreadId: 'thread-b'
    });

    expect(turns.appendAgentDelta({ threadId: 'thread-b', turnId: 'turn-b', delta: 'B1' })?.telegramChatId).toBe(
      1002
    );
    expect(turns.appendAgentDelta({ threadId: 'thread-a', turnId: 'turn-a', delta: 'A1' })?.telegramChatId).toBe(
      1001
    );
    expect(turns.appendAgentDelta({ threadId: 'thread-b', turnId: 'turn-b', delta: 'B2' })?.accumulatedAssistantText).toBe(
      'B1B2'
    );

    expect(turns.getByTurnId('turn-a')?.accumulatedAssistantText).toBe('A1');
    expect(turns.getByTurnId('turn-b')?.accumulatedAssistantText).toBe('B1B2');
  });

  it('keeps the original Telegram destination even if selected chat changes later', () => {
    const turns = new ActiveTurnStore();

    turns.start({
      turnId: 'turn-1',
      threadId: 'thread-1',
      telegramChatId: 42,
      selectedThreadId: 'thread-1'
    });

    const completed = turns.complete({ threadId: 'thread-1', turnId: 'turn-1' });

    expect(completed?.telegramChatId).toBe(42);
    expect(completed?.selectedThreadId).toBe('thread-1');
  });

  it('ignores deltas that do not match both thread id and turn id', () => {
    const turns = new ActiveTurnStore();

    turns.start({
      turnId: 'turn-1',
      threadId: 'thread-1',
      telegramChatId: 42,
      selectedThreadId: 'thread-1'
    });

    expect(turns.appendAgentDelta({ threadId: 'other-thread', turnId: 'turn-1', delta: 'wrong' })).toBeNull();
    expect(turns.appendAgentDelta({ threadId: 'thread-1', turnId: 'other-turn', delta: 'wrong' })).toBeNull();
    expect(turns.getByTurnId('turn-1')?.accumulatedAssistantText).toBe('');
  });
});
