import EventEmitter from 'node:events';

import WebSocket from 'ws';

import type {
  AgentMessageDeltaNotification,
  CodexThread,
  JsonObject,
  JsonValue,
  ServerRequest,
  ThreadArchiveResponse,
  ThreadListResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnCompletedNotification,
  TurnStartResponse
} from './protocol.js';
import { CODEX_APPROVAL_REJECTION_MESSAGE } from '../domain/approvals.js';

type RequestId = number | string;

type PendingRequest = {
  method: string;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type Listener<T> = (notification: T) => void | Promise<void>;

type ReconnectOptions = {
  enabled?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
};

type HeartbeatOptions = {
  enabled?: boolean;
  intervalMs?: number;
};

type DeltaVisibility = {
  threadId: string;
  turnId: string;
  visible: boolean;
};

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type ConnectionStatusChangedEvent = {
  previousStatus: ConnectionStatus;
  status: ConnectionStatus;
  reason?: string;
};

export type CodexAppServerClientOptions = {
  url: string;
  requestTimeoutMs?: number;
  reconnect?: ReconnectOptions;
  heartbeat?: HeartbeatOptions;
  initializeParams?: JsonObject;
  approvalRequestHandler?: (request: ServerRequest) => void | Promise<void>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    Array.isArray(value) ||
    isObject(value)
  ) {
    return value as JsonValue;
  }

  return null;
}

function getStringParam(params: JsonValue | undefined, key: string): string | undefined {
  if (!isObject(params)) {
    return undefined;
  }

  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

function getTurnId(params: JsonValue | undefined): string | undefined {
  if (!isObject(params)) {
    return undefined;
  }

  const direct = params.turnId;
  if (typeof direct === 'string') {
    return direct;
  }

  const turn = params.turn;
  return isObject(turn) && typeof turn.id === 'string' ? turn.id : undefined;
}

export class CodexAppServerClient {
  private readonly events = new EventEmitter();
  private readonly requestTimeoutMs: number;
  private readonly reconnect: Required<ReconnectOptions>;
  private readonly heartbeat: Required<HeartbeatOptions>;
  private readonly initializeParams: JsonObject;
  private readonly approvalRequestHandler?: (request: ServerRequest) => void | Promise<void>;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly deltaVisibilityByItemId = new Map<string, DeltaVisibility>();
  private latestRateLimits: JsonValue | null = null;

  private ws: WebSocket | null = null;
  private nextId = 1;
  private manuallyClosed = false;
  private connectionGeneration = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatAlive = true;
  private nextCloseReason: string | undefined;
  private status: ConnectionStatus = 'disconnected';

  constructor(options: CodexAppServerClientOptions) {
    this.url = options.url;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.reconnect = {
      enabled: options.reconnect?.enabled ?? true,
      initialDelayMs: options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS,
      maxDelayMs: options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS
    };
    this.heartbeat = {
      enabled: options.heartbeat?.enabled ?? true,
      intervalMs: options.heartbeat?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    };
    this.initializeParams =
      options.initializeParams ??
      ({
        clientInfo: {
          name: 'codex-telegram-bot',
          title: 'Codex Telegram Bot',
          version: '0.1.0'
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: []
        }
      } satisfies JsonObject);
    this.approvalRequestHandler = options.approvalRequestHandler;
  }

  readonly url: string;

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  async connect(): Promise<void> {
    this.manuallyClosed = false;
    const generation = ++this.connectionGeneration;
    this.clearReconnectTimer();
    this.setStatus(this.status === 'reconnecting' ? 'reconnecting' : 'connecting', 'connect requested');

    try {
      const ws = await this.openSocket();
      if (this.manuallyClosed || generation !== this.connectionGeneration) {
        this.closeStaleSocket(ws);
        throw new Error('Codex app-server connection closed before initialization');
      }
      this.ws = ws;
      await this.request('initialize', this.initializeParams);
      this.reconnectAttempts = 0;
      this.setStatus('connected', 'initialize completed');
    } catch (error) {
      this.handleConnectFailure();
      throw error;
    }
  }

  close(): void {
    this.manuallyClosed = true;
    this.connectionGeneration += 1;
    this.clearReconnectTimer();
    this.rejectPending(new Error('Codex app-server websocket closed'));
    if (this.ws !== null) {
      this.ws.close();
      this.ws = null;
    }
    this.stopHeartbeat();
    this.setStatus('disconnected', 'manual close');
  }

  request<T = JsonValue>(method: string, params: JsonValue = {}): Promise<T> {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Codex app-server websocket is not connected'));
    }

    const id = this.nextId++;
    const message = { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timeout.unref?.();

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });

      this.ws?.send(JSON.stringify(message), (error) => {
        if (error != null) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async listThreads(): Promise<CodexThread[]> {
    const response = await this.request<ThreadListResponse>('thread/list', {
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      useStateDbOnly: true
    });
    return response.data;
  }

  async startThread(params: { cwd?: string }): Promise<CodexThread> {
    const response = await this.request<ThreadStartResponse>('thread/start', {
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      sessionStartSource: 'startup'
    });
    return response.thread;
  }

  async resumeThread(threadId: string): Promise<CodexThread> {
    const response = await this.request<ThreadResumeResponse>('thread/resume', {
      threadId,
      excludeTurns: true
    });
    return response.thread;
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request<ThreadArchiveResponse>('thread/archive', { threadId });
  }

  async startTurn(params: { threadId: string; text: string }): Promise<{ turnId: string }> {
    const response = await this.request<TurnStartResponse>('turn/start', {
      threadId: params.threadId,
      input: [
        {
          type: 'text',
          text: params.text,
          text_elements: []
        }
      ]
    });

    return { turnId: response.turn.id };
  }

  async readRateLimits(): Promise<JsonValue> {
    const response = await this.request<JsonValue>('account/rateLimits/read', {});
    this.latestRateLimits = response;
    return response;
  }

  getRateLimits(): JsonValue | null {
    return this.latestRateLimits;
  }

  onAgentMessageDelta(listener: Listener<AgentMessageDeltaNotification>): () => void {
    this.events.on('agentMessageDelta', listener);
    return () => this.events.off('agentMessageDelta', listener);
  }

  onTurnCompleted(listener: Listener<TurnCompletedNotification>): () => void {
    this.events.on('turnCompleted', listener);
    return () => this.events.off('turnCompleted', listener);
  }

  onNotification(listener: Listener<{ method: string; params?: JsonValue }>): () => void {
    this.events.on('notification', listener);
    return () => this.events.off('notification', listener);
  }

  onConnectionStatusChanged(listener: Listener<ConnectionStatusChangedEvent>): () => void {
    this.events.on('connectionStatusChanged', listener);
    return () => this.events.off('connectionStatusChanged', listener);
  }

  private openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let settled = false;

      ws.once('open', () => {
        settled = true;
        this.startHeartbeat(ws);
        resolve(ws);
      });
      ws.once('error', (error) => {
        if (!settled) {
          reject(error);
        }
      });
      ws.on('message', (raw) => this.handleRawMessage(ws, raw.toString()));
      ws.on('pong', () => {
        if (ws === this.ws) {
          this.heartbeatAlive = true;
        }
      });
      ws.on('close', () => this.handleClose(ws));
    });
  }

  private handleRawMessage(ws: WebSocket, raw: string): void {
    if (ws !== this.ws) {
      return;
    }

    let message: JsonObject;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed)) {
        throw new Error('Codex app-server sent a non-object websocket message');
      }
      message = parsed;
    } catch {
      this.closeForProtocolError();
      return;
    }

    const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined;

    if (id !== undefined && typeof message.method === 'string') {
      this.handleServerRequest(id, message.method, toJsonValue(message.params));
      return;
    }

    if (id !== undefined && this.pending.has(id)) {
      this.handleResponse(id, message);
      return;
    }

    if (typeof message.method === 'string') {
      this.handleNotification(message.method, toJsonValue(message.params));
    }
  }

  private handleResponse(id: RequestId, message: JsonObject): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(id);

    if ('error' in message) {
      const error = isObject(message.error) && typeof message.error.message === 'string'
        ? message.error.message
        : JSON.stringify(message.error);
      pending.reject(new Error(`Codex app-server ${pending.method} failed: ${error}`));
      return;
    }

    pending.resolve(toJsonValue(message.result));
  }

  private handleServerRequest(id: RequestId, method: string, params: JsonValue): void {
    const serverRequest: ServerRequest = {
      id,
      method,
      params,
      threadId: getStringParam(params, 'threadId'),
      turnId: getTurnId(params)
    };

    this.sendRaw({
      id,
      error: {
        code: -32000,
        message: CODEX_APPROVAL_REJECTION_MESSAGE
      }
    });

    try {
      void Promise.resolve(this.approvalRequestHandler?.(serverRequest)).catch(() => undefined);
    } catch {
      // The Codex server must still receive the fail-closed response if owner notification fails.
    }
  }

  private handleNotification(method: string, params: JsonValue): void {
    this.emitSafely('notification', { method, params });

    if (method === 'account/rateLimits/updated') {
      this.latestRateLimits = params;
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const delta = this.parseAgentMessageDelta(params);
      if (delta !== null) {
        this.emitSafely('agentMessageDelta', delta);
      }
      return;
    }

    if (method === 'item/started' || method === 'item/completed') {
      this.rememberItemVisibility(params);
      return;
    }

    if (method === 'turn/completed') {
      const completed = this.parseTurnCompleted(params);
      if (completed !== null) {
        this.emitSafely('turnCompleted', completed);
        this.forgetTurnItems(completed.threadId, completed.turn.id);
      }
    }
  }

  private parseAgentMessageDelta(params: JsonValue): AgentMessageDeltaNotification | null {
    if (
      !isObject(params) ||
      typeof params.threadId !== 'string' ||
      typeof params.turnId !== 'string' ||
      typeof params.delta !== 'string'
    ) {
      return null;
    }

    const delta = {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
      delta: params.delta
    };

    return this.shouldDispatchDelta(delta) ? delta : null;
  }

  private parseTurnCompleted(params: JsonValue): TurnCompletedNotification | null {
    if (!isObject(params) || typeof params.threadId !== 'string' || !isObject(params.turn)) {
      return null;
    }

    const id = params.turn.id;
    if (typeof id !== 'string') {
      return null;
    }

    return {
      threadId: params.threadId,
      turn: params.turn as TurnCompletedNotification['turn']
    };
  }

  private rememberItemVisibility(params: JsonValue): void {
    const metadata = this.parseItemVisibility(params);
    if (metadata === null) {
      return;
    }

    this.deltaVisibilityByItemId.set(metadata.itemId, {
      threadId: metadata.threadId,
      turnId: metadata.turnId,
      visible: metadata.visible
    });
  }

  private parseItemVisibility(
    params: JsonValue
  ): (DeltaVisibility & { itemId: string }) | null {
    if (
      !isObject(params) ||
      typeof params.threadId !== 'string' ||
      typeof params.turnId !== 'string' ||
      !isObject(params.item) ||
      typeof params.item.id !== 'string' ||
      typeof params.item.type !== 'string'
    ) {
      return null;
    }

    const phase = params.item.phase;
    return {
      itemId: params.item.id,
      threadId: params.threadId,
      turnId: params.turnId,
      visible:
        params.item.type === 'agentMessage' &&
        (phase === undefined || phase === null || phase === 'final_answer')
    };
  }

  private shouldDispatchDelta(delta: AgentMessageDeltaNotification): boolean {
    if (delta.itemId === undefined) {
      return true;
    }

    const visibility = this.deltaVisibilityByItemId.get(delta.itemId);
    if (visibility === undefined) {
      return true;
    }

    return visibility.threadId === delta.threadId && visibility.turnId === delta.turnId && visibility.visible;
  }

  private forgetTurnItems(threadId: string, turnId: string): void {
    for (const [itemId, visibility] of this.deltaVisibilityByItemId) {
      if (visibility.threadId === threadId && visibility.turnId === turnId) {
        this.deltaVisibilityByItemId.delete(itemId);
      }
    }
  }

  private handleClose(ws: WebSocket | null = this.ws): void {
    if (ws !== this.ws) {
      return;
    }

    const reason = this.nextCloseReason ?? 'websocket closed';
    this.nextCloseReason = undefined;
    this.stopHeartbeat();
    this.rejectPending(new Error('Codex app-server websocket closed'));
    this.ws = null;

    if (this.manuallyClosed) {
      this.setStatus('disconnected', reason);
      return;
    }

    if (this.reconnect.enabled) {
      this.scheduleReconnect(reason);
    } else {
      this.setStatus('disconnected', reason);
    }
  }

  private handleConnectFailure(): void {
    this.stopHeartbeat();
    this.rejectPending(new Error('Codex app-server websocket closed'));
    const ws = this.ws;
    this.ws = null;
    if (ws !== null && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      ws.close();
    }

    if (this.manuallyClosed) {
      this.setStatus('disconnected', 'connect failed');
      return;
    }

    if (this.reconnect.enabled) {
      this.scheduleReconnect('connect failed');
    } else {
      this.setStatus('disconnected', 'connect failed');
    }
  }

  private scheduleReconnect(reason = 'websocket closed'): void {
    this.setStatus('reconnecting', reason);
    if (this.reconnectTimer !== null) {
      return;
    }

    const delay = Math.min(
      this.reconnect.initialDelayMs * 2 ** this.reconnectAttempts,
      this.reconnect.maxDelayMs
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus, reason?: string): void {
    const previousStatus = this.status;
    this.status = status;
    if (previousStatus === status) {
      return;
    }

    this.emitSafely('connectionStatusChanged', {
      previousStatus,
      status,
      ...(reason === undefined ? {} : { reason })
    } satisfies ConnectionStatusChangedEvent);
  }

  private startHeartbeat(ws: WebSocket): void {
    if (!this.heartbeat.enabled) {
      return;
    }

    this.stopHeartbeat();
    this.heartbeatAlive = true;
    this.heartbeatTimer = setInterval(() => {
      if (ws !== this.ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!this.heartbeatAlive) {
        this.nextCloseReason = 'heartbeat timeout';
        ws.terminate();
        return;
      }

      this.heartbeatAlive = false;
      ws.ping();
    }, this.heartbeat.intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatAlive = true;
  }

  private closeStaleSocket(ws: WebSocket): void {
    this.stopHeartbeat();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }

  private closeForProtocolError(): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      return;
    }

    this.handleClose(this.ws);
  }

  private sendRaw(message: JsonObject): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify(message));
  }

  private emitSafely(eventName: string, payload: unknown): void {
    const listeners = this.events.listeners(eventName) as Array<(value: unknown) => unknown>;
    for (const listener of listeners) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          result.catch(() => undefined);
        }
      } catch {
        // Listener failures are isolated so one Telegram delivery failure cannot crash the client.
      }
    }
  }
}
