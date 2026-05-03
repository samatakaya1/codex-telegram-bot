import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_VOICE_TRANSCRIPTION_CONFIG, type AppConfig } from '../../src/config/env.js';
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
    botRunMode: 'DEV',
    voiceTranscription: DEFAULT_VOICE_TRANSCRIPTION_CONFIG
  };
}

function makeContext(text = 'hello', overrides: Partial<TelegramHandlerContext> = {}) {
  const replies: string[] = [];
  const replyOptions: unknown[] = [];
  const ctx: TelegramHandlerContext = {
    fromId: ownerId,
    chatId: ownerId,
    chatType: 'private',
    text,
    reply: async (replyText, options) => {
      replies.push(replyText);
      replyOptions.push(options);
    },
    answerCallbackQuery: vi.fn(),
    ...overrides
  };
  return { ctx, replies, replyOptions };
}

function inlineButtons(replyOptions: unknown[]): Array<{ text: string; callback_data?: string }> {
  return replyOptions.flatMap((options) => {
    const candidate = options as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    };
    return candidate.reply_markup?.inline_keyboard?.flat() ?? [];
  });
}

function dependencies() {
  const deltaListeners: Array<(event: { threadId: string; turnId: string; delta: string }) => void> = [];
  const completedListeners: Array<(event: { threadId: string; turn: { id: string; status: string; error: null } }) => void> =
    [];
  const connectionStatusListeners: Array<
    (event: { previousStatus: string; status: string; reason?: string }) => void
  > = [];

  return {
    codex: {
      connectionStatus: 'connected' as const,
      listThreads: vi.fn(async () => []),
      resumeThread: vi.fn(async (threadId: string) => ({ id: threadId })),
      startThread: vi.fn(async () => ({ id: 'new-thread' })),
      startTurn: vi.fn(async (_params: { threadId: string; text: string }) => ({ turnId: 'turn-1' })),
      onAgentMessageDelta: vi.fn((listener: (event: { threadId: string; turnId: string; delta: string }) => void) => {
        deltaListeners.push(listener);
        return () => undefined;
      }),
      onTurnCompleted: vi.fn(
        (listener: (event: { threadId: string; turn: { id: string; status: string; error: null } }) => void) => {
          completedListeners.push(listener);
          return () => undefined;
        }
      ),
      onConnectionStatusChanged: vi.fn(
        (listener: (event: { previousStatus: string; status: string; reason?: string }) => void) => {
          connectionStatusListeners.push(listener);
          return () => undefined;
        }
      )
    },
    onDeliveryError: vi.fn(),
    readProjectlessThreadIds: vi.fn(async () => new Set<string>()),
    listProjects: vi.fn(async () => []),
    emitDelta(event: { threadId: string; turnId: string; delta: string }) {
      for (const listener of deltaListeners) {
        listener(event);
      }
    },
    emitCompleted(event: { threadId: string; turn: { id: string; status: string; error: null } }) {
      for (const listener of completedListeners) {
        listener(event);
      }
    },
    emitConnectionStatus(event: { previousStatus: string; status: string; reason?: string }) {
      for (const listener of connectionStatusListeners) {
        listener(event);
      }
    }
  };
}

describe('turn streaming delivery', () => {
  it('requires a selected chat before sending text', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext('ping');

    await handlers.handleText(ctx);

    expect(replies.join('\n')).toContain('No chat selected');
    expect(replies.join('\n')).toContain('/select_chat');
    expect(replies.join('\n')).toContain('/select_project');
    expect(replies.join('\n')).not.toContain('/new_project_chat');
    expect(deps.codex.startTurn).not.toHaveBeenCalled();
  });

  it('streams a Codex response after a confirmed voice transcript', async () => {
    const deps = {
      ...dependencies(),
      downloadVoiceFile: vi.fn(async () => ({ path: 'C:\\tmp\\voice.ogg', sizeBytes: 10 })),
      deleteVoiceFile: vi.fn(async () => undefined),
      transcribeVoice: vi.fn(async () => ({ text: 'voice prompt text' }))
    };
    const handlers = createTelegramHandlers({
      config: { ...config(), voiceTranscription: { ...DEFAULT_VOICE_TRANSCRIPTION_CONFIG, enabled: true } },
      ...deps
    });
    handlers.setSelectedThread(ownerId, 'thread-1', 'C:\\Workspace\\Project');
    const voice = makeContext('', { voice: { fileId: 'voice-file', durationSeconds: 2, fileSizeBytes: 10 } });

    await handlers.handleVoice(voice.ctx);
    const sendCallbackData = inlineButtons(voice.replyOptions).find((button) => button.text === 'Send to Codex')
      ?.callback_data;
    const confirm = makeContext('', { callbackData: sendCallbackData });
    await handlers.handleCallback(confirm.ctx);

    deps.emitDelta({ threadId: 'thread-1', turnId: 'turn-1', delta: 'voice answer' });
    deps.emitCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } });

    await vi.waitFor(() => expect(confirm.replies.join('\n')).toContain('voice answer'));
    expect(deps.codex.startTurn).toHaveBeenCalledWith({ threadId: 'thread-1', text: 'voice prompt text' });
  });

  it('rejects a second prompt while the selected thread is busy', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-1');

    await handlers.handleText(makeContext('first').ctx);
    const second = makeContext('second');
    await handlers.handleText(second.ctx);

    expect(deps.codex.startTurn).toHaveBeenCalledTimes(1);
    expect(second.replies.join('\n')).toContain('already running');
  });

  it('rejects a second prompt while the first startTurn is still pending', async () => {
    const deps = dependencies();
    let resolveTurn!: (value: { turnId: string }) => void;
    deps.codex.startTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
        })
    );
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-1');

    const first = makeContext('first');
    const firstPromise = handlers.handleText(first.ctx);
    const second = makeContext('second');
    await handlers.handleText(second.ctx);

    expect(deps.codex.startTurn).toHaveBeenCalledTimes(1);
    expect(second.replies.join('\n')).toContain('already running');

    resolveTurn({ turnId: 'turn-1' });
    await firstPromise;
  });

  it('sends the no-resend connection notice when app-server disconnects while startTurn is pending', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      let rejectTurn!: (error: Error) => void;
      deps.codex.startTurn.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectTurn = reject;
          })
      );
      const handlers = createTelegramHandlers({
        config: config(),
        ...deps,
        connectionLossGraceMs: 50
      });
      handlers.setSelectedThread(ownerId, 'thread-1');

      const first = makeContext('first');
      const firstPromise = handlers.handleText(first.ctx);
      await Promise.resolve();
      deps.emitConnectionStatus({
        previousStatus: 'connected',
        status: 'reconnecting',
        reason: 'websocket closed'
      });
      rejectTurn(new Error('websocket closed'));
      await vi.advanceTimersByTimeAsync(51);
      await firstPromise;

      expect(first.replies.join('\n')).toContain('Codex app-server disconnected');
      expect(first.replies.join('\n')).not.toContain('Could not start Codex turn');

      const second = makeContext('second');
      await handlers.handleText(second.ctx);
      expect(deps.codex.startTurn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a stale pending startTurn settle over a retry for the same thread', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      let rejectFirst!: (error: Error) => void;
      let resolveSecond!: (value: { turnId: string }) => void;
      deps.codex.startTurn
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectFirst = reject;
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve;
            })
        );
      const handlers = createTelegramHandlers({
        config: config(),
        ...deps,
        connectionLossGraceMs: 50
      });
      handlers.setSelectedThread(ownerId, 'thread-1');

      const first = makeContext('first');
      const firstPromise = handlers.handleText(first.ctx);
      await Promise.resolve();
      deps.emitConnectionStatus({
        previousStatus: 'connected',
        status: 'reconnecting',
        reason: 'websocket closed'
      });
      await vi.advanceTimersByTimeAsync(51);
      expect(first.replies.join('\n')).toContain('Codex app-server disconnected');

      const second = makeContext('second');
      const secondPromise = handlers.handleText(second.ctx);
      await Promise.resolve();
      rejectFirst(new Error('websocket closed'));
      await firstPromise;
      resolveSecond({ turnId: 'turn-2' });
      await secondPromise;

      expect(first.replies.join('\n')).not.toContain('Could not start Codex turn');
      expect(second.replies.join('\n')).toContain('Codex is working');
      deps.emitDelta({ threadId: 'thread-1', turnId: 'turn-2', delta: 'retry answer' });
      deps.emitCompleted({ threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', error: null } });
      await vi.waitFor(() => expect(second.replies.join('\n')).toContain('retry answer'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('aggregates matching deltas and sends final chunks on completion', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext('ping');
    handlers.setSelectedThread(ownerId, 'thread-1');

    await handlers.handleText(ctx);
    handlers.setSelectedThread(ownerId, 'thread-2');
    deps.emitDelta({ threadId: 'thread-2', turnId: 'turn-1', delta: 'wrong' });
    deps.emitDelta({ threadId: 'thread-1', turnId: 'other-turn', delta: 'wrong' });
    deps.emitDelta({ threadId: 'thread-1', turnId: 'turn-1', delta: 'pong' });
    deps.emitDelta({ threadId: 'thread-1', turnId: 'turn-1', delta: ' done' });
    deps.emitCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } });

    await vi.waitFor(() => expect(replies).toContain('pong done'));
    expect(deps.codex.startTurn).toHaveBeenCalledWith({ threadId: 'thread-1', text: 'ping' });
  });

  it('buffers fast turn events that arrive before startTurn resolves', async () => {
    const deps = dependencies();
    deps.codex.startTurn.mockImplementationOnce(async ({ threadId }) => {
      deps.emitDelta({ threadId, turnId: 'turn-fast', delta: 'fast answer' });
      deps.emitCompleted({ threadId, turn: { id: 'turn-fast', status: 'completed', error: null } });
      return { turnId: 'turn-fast' };
    });
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext('ping');
    handlers.setSelectedThread(ownerId, 'thread-1');

    await handlers.handleText(ctx);

    await vi.waitFor(() => expect(replies).toContain('fast answer'));
    const second = makeContext('second');
    await handlers.handleText(second.ctx);
    expect(deps.codex.startTurn).toHaveBeenCalledTimes(2);
  });

  it('splits long final answers into ordered Telegram chunks', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    const { ctx, replies } = makeContext('long');
    handlers.setSelectedThread(ownerId, 'thread-1');

    await handlers.handleText(ctx);
    deps.emitDelta({ threadId: 'thread-1', turnId: 'turn-1', delta: 'x'.repeat(3901) });
    deps.emitCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } });

    await vi.waitFor(() => expect(replies.filter((reply) => reply.startsWith('x')).length).toBe(2));
    expect(replies.filter((reply) => reply.startsWith('x')).map((reply) => reply.length)).toEqual([3900, 1]);
  });

  it('clears busy state after failed startTurn so the owner can retry', async () => {
    const deps = dependencies();
    deps.codex.startTurn.mockRejectedValueOnce(new Error('Codex unavailable'));
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-1');

    const first = makeContext('first');
    await handlers.handleText(first.ctx);
    const second = makeContext('second');
    await handlers.handleText(second.ctx);

    expect(first.replies.join('\n')).toContain('Could not start Codex turn');
    expect(deps.codex.startTurn).toHaveBeenCalledTimes(2);
    expect(second.replies.join('\n')).toContain('Codex is working');
  });

  it('sends a failure message and clears busy when Codex reports a failed turn', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps });
    handlers.setSelectedThread(ownerId, 'thread-1');

    const first = makeContext('first');
    await handlers.handleText(first.ctx);
    deps.emitCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: null } });
    await vi.waitFor(() => expect(first.replies.join('\n')).toContain('Codex turn failed'));

    const second = makeContext('second');
    await handlers.handleText(second.ctx);
    expect(deps.codex.startTurn).toHaveBeenCalledTimes(2);
  });

  it('keeps a long-running turn busy until Codex sends a terminal event', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      const handlers = createTelegramHandlers({ config: config(), ...deps });
      handlers.setSelectedThread(ownerId, 'thread-1');

      const first = makeContext('first');
      await handlers.handleText(first.ctx);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

      expect(first.replies.join('\n')).not.toContain('Codex turn timed out');

      const second = makeContext('second');
      await handlers.handleText(second.ctx);
      expect(second.replies.join('\n')).toContain('already running');
      expect(deps.codex.startTurn).toHaveBeenCalledTimes(1);

      deps.emitDelta({ threadId: 'thread-1', turnId: 'turn-1', delta: 'late answer' });
      deps.emitCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } });
      await vi.waitFor(() => expect(first.replies.join('\n')).toContain('late answer'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies the owner and clears busy when app-server disconnects during an active turn', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      const handlers = createTelegramHandlers({
        config: config(),
        ...deps,
        connectionLossGraceMs: 50
      });
      handlers.setSelectedThread(ownerId, 'thread-1');

      const first = makeContext('first');
      await handlers.handleText(first.ctx);
      deps.emitConnectionStatus({
        previousStatus: 'connected',
        status: 'reconnecting',
        reason: 'websocket closed'
      });
      await vi.advanceTimersByTimeAsync(51);

      expect(first.replies.join('\n')).toContain('Codex app-server disconnected');
      expect(first.replies.join('\n')).toContain('not resend');

      const second = makeContext('second');
      await handlers.handleText(second.ctx);
      expect(deps.codex.startTurn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the connection-loss failure scheduled even if app-server reconnects quickly', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      const handlers = createTelegramHandlers({
        config: config(),
        ...deps,
        connectionLossGraceMs: 50
      });
      handlers.setSelectedThread(ownerId, 'thread-1');

      const first = makeContext('first');
      await handlers.handleText(first.ctx);
      deps.emitConnectionStatus({
        previousStatus: 'connected',
        status: 'reconnecting',
        reason: 'websocket closed'
      });
      deps.emitConnectionStatus({
        previousStatus: 'reconnecting',
        status: 'connected',
        reason: 'initialize completed'
      });
      await vi.advanceTimersByTimeAsync(51);

      expect(first.replies.join('\n')).toContain('Codex app-server disconnected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not clear the connection-loss watchdog for a non-matching completed turn', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      const handlers = createTelegramHandlers({
        config: config(),
        ...deps,
        connectionLossGraceMs: 50
      });
      handlers.setSelectedThread(ownerId, 'thread-1');

      const first = makeContext('first');
      await handlers.handleText(first.ctx);
      deps.emitConnectionStatus({
        previousStatus: 'connected',
        status: 'reconnecting',
        reason: 'websocket closed'
      });
      deps.emitCompleted({ threadId: 'thread-1', turn: { id: 'other-turn', status: 'completed', error: null } });
      await vi.advanceTimersByTimeAsync(51);

      expect(first.replies.join('\n')).toContain('Codex app-server disconnected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries failed final Telegram chunk delivery before reporting success', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({ config: config(), ...deps, deliveryRetryDelayMs: 1 });
    const { ctx, replies } = makeContext('ping');
    let finalAttempts = 0;
    ctx.reply = vi.fn(async (text) => {
      if (text === 'pong') {
        finalAttempts += 1;
        if (finalAttempts === 1) {
          throw new Error('temporary Telegram failure');
        }
      }
      replies.push(text);
    });
    handlers.setSelectedThread(ownerId, 'thread-1');

    await handlers.handleText(ctx);
    deps.emitDelta({ threadId: 'thread-1', turnId: 'turn-1', delta: 'pong' });
    deps.emitCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } });

    await vi.waitFor(() => expect(replies).toContain('pong'));
    expect(finalAttempts).toBe(2);
    expect(deps.onDeliveryError).not.toHaveBeenCalled();
  });

  it('reports final Telegram delivery failure after retries are exhausted', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({
      config: config(),
      ...deps,
      deliveryRetryDelayMs: 1,
      deliveryRetryAttempts: 2
    });
    const { ctx } = makeContext('ping');
    ctx.reply = vi.fn(async (text) => {
      if (text === 'pong') {
        throw new Error('permanent Telegram failure');
      }
    });
    handlers.setSelectedThread(ownerId, 'thread-1');

    await handlers.handleText(ctx);
    deps.emitDelta({ threadId: 'thread-1', turnId: 'turn-1', delta: 'pong' });
    deps.emitCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } });

    await vi.waitFor(() => expect(deps.onDeliveryError).toHaveBeenCalledWith(expect.any(Error)));
  });

  it('reports failed-turn Telegram delivery failure after retries are exhausted', async () => {
    const deps = dependencies();
    const handlers = createTelegramHandlers({
      config: config(),
      ...deps,
      deliveryRetryDelayMs: 1,
      deliveryRetryAttempts: 1
    });
    const { ctx } = makeContext('ping');
    ctx.reply = vi.fn(async (text) => {
      if (text.startsWith('Codex turn failed')) {
        throw new Error('failed-turn delivery failed');
      }
    });
    handlers.setSelectedThread(ownerId, 'thread-1');

    await handlers.handleText(ctx);
    deps.emitCompleted({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: null } });

    await vi.waitFor(() => expect(deps.onDeliveryError).toHaveBeenCalledWith(expect.any(Error)));
  });
});
