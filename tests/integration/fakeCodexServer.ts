import WebSocket, { WebSocketServer } from 'ws';

type JsonObject = { [key: string]: unknown };
type RequestHandler = (message: JsonObject, server: FakeCodexServer, ws: WebSocket) => void | Promise<void>;

export class FakeCodexServer {
  readonly requests: JsonObject[] = [];

  private readonly handlers = new Map<string, RequestHandler>();
  private readonly receivedResolvers: Array<(message: JsonObject) => boolean> = [];
  private readonly wss: WebSocketServer;
  private client: WebSocket | null = null;

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    this.installDefaultHandlers();
    this.wss.on('connection', (ws) => {
      this.client = ws;
      ws.on('message', async (raw) => {
        const message = JSON.parse(raw.toString()) as JsonObject;
        this.requests.push(message);
        this.resolveWaiters(message);

        if (typeof message.method !== 'string') {
          return;
        }

        const handler = this.handlers.get(message.method);
        if (handler !== undefined) {
          await handler(message, this, ws);
        }
      });
    });
  }

  static async start(port = 0, options: { autoPong?: boolean } = {}): Promise<FakeCodexServer> {
    const wss = new WebSocketServer({ port, autoPong: options.autoPong ?? true });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    return new FakeCodexServer(wss);
  }

  get url(): string {
    const address = this.wss.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Fake server is not listening on a TCP port');
    }

    return `ws://127.0.0.1:${address.port}`;
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  respond(id: unknown, result: unknown, ws = this.client): void {
    this.send({ id, result }, ws);
  }

  respondError(id: unknown, message: string, ws = this.client): void {
    this.send({ id, error: { code: -32000, message } }, ws);
  }

  sendNotification(method: string, params: unknown): void {
    this.send({ method, params });
  }

  sendServerRequest(id: number, method: string, params: unknown): void {
    this.send({ id, method, params });
  }

  sendRaw(raw: string): void {
    if (this.client === null || this.client.readyState !== WebSocket.OPEN) {
      throw new Error('No connected fake Codex client');
    }

    this.client.send(raw);
  }

  waitForRequest(method: string): Promise<JsonObject> {
    return this.waitForMessage((message) => message.method === method);
  }

  waitForClientErrorResponse(id: number): Promise<JsonObject> {
    return this.waitForMessage((message) => message.id === id && 'error' in message);
  }

  closeClients(): void {
    for (const client of this.wss.clients) {
      client.close();
    }
  }

  forceCloseClients(): void {
    for (const client of this.wss.clients) {
      client.terminate();
    }
  }

  async stop(): Promise<void> {
    this.closeClients();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private send(message: JsonObject, ws = this.client): void {
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      throw new Error('No connected fake Codex client');
    }

    ws.send(JSON.stringify(message));
  }

  private waitForMessage(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    const existing = this.requests.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const resolver = (message: JsonObject) => {
        if (!predicate(message)) {
          return false;
        }

        clearTimeout(timeout);
        resolve(message);
        return true;
      };
      const timeout = setTimeout(() => {
        const index = this.receivedResolvers.indexOf(resolver);
        if (index >= 0) {
          this.receivedResolvers.splice(index, 1);
        }
        reject(new Error('Timed out waiting for fake Codex message'));
      }, 1000);
      this.receivedResolvers.push(resolver);
    });
  }

  private resolveWaiters(message: JsonObject): void {
    for (let index = this.receivedResolvers.length - 1; index >= 0; index--) {
      const done = this.receivedResolvers[index]?.(message) ?? false;
      if (done) {
        this.receivedResolvers.splice(index, 1);
      }
    }
  }

  private installDefaultHandlers(): void {
    this.onRequest('initialize', (message, _server, ws) => {
      this.respond(message.id, {
        userAgent: 'Fake Codex',
        codexHome: '[fake]',
        platformFamily: 'windows',
        platformOs: 'windows'
      }, ws);
    });
    this.onRequest('thread/list', (message, _server, ws) => {
      this.respond(message.id, {
        data: [
          {
            id: 'thread-1',
            preview: 'Existing chat',
            cwd: 'C:\\Workspace\\Project',
            updatedAt: 1777643698,
            status: { type: 'idle' }
          }
        ]
      }, ws);
    });
    this.onRequest('thread/start', (message, _server, ws) => {
      const params = (message.params ?? {}) as { cwd?: string };
      this.respond(message.id, {
        thread: {
          id: params.cwd === undefined ? 'projectless-thread' : 'project-thread',
          preview: '',
          cwd: params.cwd ?? null,
          status: { type: 'idle' }
        }
      }, ws);
    });
    this.onRequest('thread/resume', (message, _server, ws) => {
      const params = (message.params ?? {}) as { threadId?: string };
      this.respond(message.id, {
        thread: {
          id: params.threadId ?? 'thread-1',
          preview: 'Existing chat',
          status: { type: 'idle' }
        }
      }, ws);
    });
    this.onRequest('thread/archive', (message, _server, ws) => {
      this.respond(message.id, {}, ws);
    });
    this.onRequest('turn/start', (message, _server, ws) => {
      this.respond(message.id, {
        turn: {
          id: 'turn-1',
          items: [],
          status: 'inProgress',
          error: null
        }
      }, ws);
    });
  }
}
