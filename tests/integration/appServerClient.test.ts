import { createServer } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from '../../src/codex/appServerClient.js';
import { ActiveTurnStore } from '../../src/domain/turns.js';
import { FakeCodexServer } from './fakeCodexServer.js';

describe('CodexAppServerClient', () => {
  let server: FakeCodexServer | null = null;
  let client: CodexAppServerClient | null = null;

  afterEach(async () => {
    client?.close();
    await server?.stop();
    client = null;
    server = null;
  });

  async function connectClient(options: Partial<ConstructorParameters<typeof CodexAppServerClient>[0]> = {}) {
    server = await FakeCodexServer.start();
    client = new CodexAppServerClient({
      url: server.url,
      requestTimeoutMs: 500,
      reconnect: { enabled: false },
      ...options
    });
    await client.connect();
    return { client, server };
  }

  async function getUnusedPort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to allocate an unused TCP port');
    }
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => (error == null ? resolve() : reject(error)));
    });
    return address.port;
  }

  it('initializes on connect and lists threads through matching request ids', async () => {
    const { client, server } = await connectClient();

    await server.waitForRequest('initialize');
    const threads = await client.listThreads();
    const listRequest = await server.waitForRequest('thread/list');

    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe('thread-1');
    expect(listRequest.params).toMatchObject({
      archived: false,
      useStateDbOnly: true,
      sortKey: 'updated_at',
      sortDirection: 'desc'
    });
    expect(client.connectionStatus).toBe('connected');
  });

  it('wraps Codex thread and turn methods with documented params', async () => {
    const { client, server } = await connectClient();

    const projectThread = await client.startThread({ cwd: 'C:\\Workspace\\New project' });
    const resumedThread = await client.resumeThread('thread-1');
    const turn = await client.startTurn({ threadId: projectThread.id, text: 'hello' });
    await client.archiveThread(projectThread.id);

    const startRequest = await server.waitForRequest('thread/start');
    const resumeRequest = await server.waitForRequest('thread/resume');
    const turnRequest = await server.waitForRequest('turn/start');
    const archiveRequest = await server.waitForRequest('thread/archive');

    expect(projectThread.id).toBe('project-thread');
    expect(resumedThread.id).toBe('thread-1');
    expect(turn.turnId).toBe('turn-1');
    expect(startRequest.params).toMatchObject({ cwd: 'C:\\Workspace\\New project' });
    expect(resumeRequest.params).toMatchObject({ threadId: 'thread-1', excludeTurns: true });
    expect(turnRequest.params).toMatchObject({
      threadId: 'project-thread',
      input: [{ type: 'text', text: 'hello', text_elements: [] }]
    });
    expect(archiveRequest.params).toEqual({ threadId: 'project-thread' });
  });

  it('dispatches agent deltas and turn completion notifications', async () => {
    const { client, server } = await connectClient();
    const deltaListener = vi.fn();
    const completedListener = vi.fn();

    client.onAgentMessageDelta(deltaListener);
    client.onTurnCompleted(completedListener);

    server.sendNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      delta: 'hello'
    });
    server.sendNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', error: null }
    });

    await vi.waitFor(() => expect(deltaListener).toHaveBeenCalledWith(expect.objectContaining({ delta: 'hello' })));
    expect(completedListener).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1', turn: expect.objectContaining({ id: 'turn-1' }) })
    );
  });

  it('dispatches only final answer agent deltas when item phases are known', async () => {
    const { client, server } = await connectClient();
    const deltaListener = vi.fn();

    client.onAgentMessageDelta(deltaListener);

    server.sendNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'reasoning-message',
        type: 'agentMessage',
        phase: 'reasoning'
      }
    });
    server.sendNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'reasoning-message',
      delta: 'internal reasoning'
    });
    server.sendNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'final-message',
        type: 'agentMessage',
        phase: 'final_answer'
      }
    });
    server.sendNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'final-message',
      delta: 'public answer'
    });

    await vi.waitFor(() => expect(deltaListener).toHaveBeenCalledWith(expect.objectContaining({ delta: 'public answer' })));
    expect(deltaListener).toHaveBeenCalledTimes(1);
  });

  it('reads account rate limits and caches rate limit notifications', async () => {
    const { client, server } = await connectClient();
    const readSnapshot = {
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1777660200 }
      }
    };
    const notificationSnapshot = {
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1777663800 }
      }
    };
    server.onRequest('account/rateLimits/read', (message, fakeServer) => {
      fakeServer.respond(message.id, readSnapshot);
    });

    expect(client.getRateLimits()).toBeNull();
    await expect(client.readRateLimits()).resolves.toEqual(readSnapshot);
    expect(client.getRateLimits()).toEqual(readSnapshot);

    server.sendNotification('account/rateLimits/updated', notificationSnapshot);

    await vi.waitFor(() => expect(client.getRateLimits()).toEqual(notificationSnapshot));
  });

  it('routes interleaved fake app-server deltas through active turn contexts', async () => {
    const { client, server } = await connectClient();
    const turns = new ActiveTurnStore();

    turns.start({
      threadId: 'thread-a',
      turnId: 'turn-a',
      telegramChatId: 1001,
      telegramMessageId: 11,
      selectedThreadId: 'thread-a'
    });
    turns.start({
      threadId: 'thread-b',
      turnId: 'turn-b',
      telegramChatId: 1002,
      telegramMessageId: 12,
      selectedThreadId: 'thread-b'
    });
    client.onAgentMessageDelta((event) => {
      turns.appendAgentDelta(event);
    });

    server.sendNotification('item/agentMessage/delta', {
      threadId: 'thread-b',
      turnId: 'turn-b',
      delta: 'B1'
    });
    server.sendNotification('item/agentMessage/delta', {
      threadId: 'thread-a',
      turnId: 'turn-a',
      delta: 'A1'
    });
    server.sendNotification('item/agentMessage/delta', {
      threadId: 'thread-b',
      turnId: 'turn-b',
      delta: 'B2'
    });

    await vi.waitFor(() => expect(turns.getByTurnId('turn-b')?.accumulatedAssistantText).toBe('B1B2'));
    expect(turns.getByTurnId('turn-a')).toMatchObject({
      telegramChatId: 1001,
      telegramMessageId: 11,
      accumulatedAssistantText: 'A1'
    });
    expect(turns.getByTurnId('turn-b')).toMatchObject({
      telegramChatId: 1002,
      telegramMessageId: 12,
      accumulatedAssistantText: 'B1B2'
    });
  });

  it('routes server requests before pending responses when ids collide', async () => {
    const approvalHandler = vi.fn();
    const { client, server } = await connectClient({ approvalRequestHandler: approvalHandler });
    server.onRequest('thread/list', (message, fakeServer) => {
      fakeServer.sendServerRequest(message.id as number, 'approval/request', {
        threadId: 'thread-1',
        turnId: 'turn-1'
      });
    });

    const pending = client.listThreads();
    const response = await server.waitForClientErrorResponse(2);

    expect(response.error).toMatchObject({ message: expect.stringContaining('not supported in Telegram') });
    expect(approvalHandler).toHaveBeenCalledWith(expect.objectContaining({ id: 2, method: 'approval/request' }));
    await expect(pending).rejects.toThrow('Codex app-server request timed out: thread/list');
  });

  it('still fails server requests closed when owner notification throws', async () => {
    const approvalHandler = vi.fn(() => {
      throw new Error('notify failed');
    });
    const { server } = await connectClient({ approvalRequestHandler: approvalHandler });

    server.sendServerRequest(100, 'approval/request', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      summary: 'Need approval'
    });

    const response = await server.waitForClientErrorResponse(100);

    expect(approvalHandler).toHaveBeenCalled();
    expect(response.error).toMatchObject({
      message: expect.stringContaining('not supported in Telegram')
    });
  });

  it('fails server requests closed and notifies the approval handler', async () => {
    const approvalHandler = vi.fn();
    const { client, server } = await connectClient({ approvalRequestHandler: approvalHandler });

    server.sendServerRequest(99, 'approval/request', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      summary: 'Need approval'
    });

    const response = await server.waitForClientErrorResponse(99);

    expect(approvalHandler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 99, method: 'approval/request', threadId: 'thread-1', turnId: 'turn-1' })
    );
    expect(response.error).toMatchObject({
      message: expect.stringContaining('not supported in Telegram')
    });
  });

  it('rejects JSON-RPC errors and timed-out requests with user-safe messages', async () => {
    const { client, server } = await connectClient({ requestTimeoutMs: 25 });
    server.onRequest('thread/resume', (message, fakeServer) => {
      fakeServer.respondError(message.id, 'resume failed');
    });
    server.onRequest('thread/list', () => undefined);

    await expect(client.resumeThread('thread-1')).rejects.toThrow('thread/resume failed: resume failed');
    await expect(client.listThreads()).rejects.toThrow('Codex app-server request timed out: thread/list');
  });

  it('contains malformed inbound websocket messages and reconnects', async () => {
    const { client, server } = await connectClient({
      reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 1000 }
    });

    server.sendRaw('{bad json');

    await vi.waitFor(() => expect(client.connectionStatus).toBe('reconnecting'));
  });

  it('contains sync and async listener failures while dispatching notifications', async () => {
    const { client, server } = await connectClient();
    const secondListener = vi.fn();

    client.onAgentMessageDelta(() => {
      throw new Error('sync listener failed');
    });
    client.onAgentMessageDelta(async () => {
      throw new Error('async listener failed');
    });
    client.onAgentMessageDelta(secondListener);

    server.sendNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'hello'
    });

    await vi.waitFor(() => expect(secondListener).toHaveBeenCalledWith(expect.objectContaining({ delta: 'hello' })));
    expect(client.connectionStatus).toBe('connected');
  });

  it('rejects pending requests when the app-server disconnects', async () => {
    const { client, server } = await connectClient();
    server.onRequest('thread/list', () => undefined);

    const pending = client.listThreads();
    await server.waitForRequest('thread/list');
    server.closeClients();

    await expect(pending).rejects.toThrow('websocket closed');
  });

  it('enters reconnecting status with bounded backoff after an unexpected disconnect', async () => {
    const { client, server } = await connectClient({
      reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 1000 }
    });
    const statusListener = vi.fn();

    client.onConnectionStatusChanged(statusListener);

    server.closeClients();

    await vi.waitFor(() => expect(client.connectionStatus).toBe('reconnecting'));
    expect(statusListener).toHaveBeenCalledWith({
      previousStatus: 'connected',
      status: 'reconnecting',
      reason: 'websocket closed'
    });
  });

  it('uses heartbeat as a fallback to detect stale app-server sockets', async () => {
    server = await FakeCodexServer.start(0, { autoPong: false });
    client = new CodexAppServerClient({
      url: server.url,
      requestTimeoutMs: 500,
      reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 1000 },
      heartbeat: { intervalMs: 10 }
    });
    const statusListener = vi.fn();
    client.onConnectionStatusChanged(statusListener);

    await client.connect();

    await vi.waitFor(() => expect(client?.connectionStatus).toBe('reconnecting'), { timeout: 500 });
    expect(statusListener).toHaveBeenCalledWith({
      previousStatus: 'connected',
      status: 'reconnecting',
      reason: 'heartbeat timeout'
    });
  });

  it('closes and reconnects when initialize times out after websocket open', async () => {
    server = await FakeCodexServer.start();
    server.onRequest('initialize', () => undefined);
    client = new CodexAppServerClient({
      url: server.url,
      requestTimeoutMs: 25,
      reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 1000 }
    });

    await expect(client.connect()).rejects.toThrow('initialize');
    expect(client.connectionStatus).toBe('reconnecting');
  });

  it('ignores delayed close events from stale sockets after reconnect succeeds', async () => {
    const { client, server } = await connectClient({
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 100 }
    });
    const oldSocket = (client as unknown as { ws: unknown }).ws;

    server.forceCloseClients();
    await vi.waitFor(() => expect(client.connectionStatus).toBe('reconnecting'), { timeout: 1000 });
    await vi.waitFor(() => expect(client.connectionStatus).toBe('connected'), { timeout: 2000 });

    (client as unknown as { handleClose: (ws: unknown) => void }).handleClose(oldSocket);
    expect(client.connectionStatus).toBe('connected');
    expect(await client.listThreads()).toHaveLength(1);
  });

  it('starts reconnecting after initial app-server outage and recovers when the port becomes available', async () => {
    const port = await getUnusedPort();
    client = new CodexAppServerClient({
      url: `ws://127.0.0.1:${port}`,
      requestTimeoutMs: 200,
      reconnect: { enabled: true, initialDelayMs: 25, maxDelayMs: 25 }
    });

    await expect(client.connect()).rejects.toBeTruthy();
    expect(client.connectionStatus).toBe('reconnecting');

    server = await FakeCodexServer.start(port);

    await vi.waitFor(() => expect(client?.connectionStatus).toBe('connected'), { timeout: 1000 });
    await server.waitForRequest('initialize');
  });
});
