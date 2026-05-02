import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import WebSocket from 'ws';

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | string | number | boolean | null;

type ProtocolRecord = {
  name: string;
  request?: JsonValue;
  response?: JsonValue;
  notifications?: JsonValue[];
};

type PendingRequest = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

const DEFAULT_CODEX_WS_URL = 'ws://127.0.0.1:18765';
const FIXTURES_DIR = path.resolve('tests', 'fixtures', 'codex');
const PROTOCOL_DOC_PATH = path.resolve('docs', 'codex-protocol.md');

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  const exactKeys = new Set([
    'account',
    'branch',
    'codexhome',
    'cwd',
    'gitinfo',
    'instructionsources',
    'originurl',
    'plan',
    'ratelimits',
    'sha',
    'useragent',
    'writableroots'
  ]);

  return (
    exactKeys.has(normalized) ||
    normalized.includes('token') ||
    normalized.includes('authorization') ||
    normalized.includes('secret') ||
    normalized.includes('account') ||
    normalized.includes('credit') ||
    normalized.includes('email') ||
    normalized.includes('ratelimit') ||
    normalized.includes('residency') ||
    normalized === 'preview' ||
    normalized === 'name' ||
    normalized === 'text' ||
    normalized === 'path'
  );
}

function shouldRedactValueForKey(key: string, value: JsonValue): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = key.toLowerCase();
  if (normalized === 'error' && value.length > 0) {
    return true;
  }

  if (!['id', 'threadid', 'turnid', 'itemid', 'forkedfromid'].includes(normalized)) {
    return false;
  }

  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^(msg|rs)_[A-Za-z0-9_]+$/.test(value)
  );
}

function shouldRedactString(value: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(value) || /^Bearer\s+/i.test(value);
}

export function sanitizeProtocolRecord<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProtocolRecord(item)) as T;
  }

  if (isObject(value)) {
    const sanitized: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = shouldRedactKey(key) || shouldRedactValueForKey(key, entry) ? '[redacted]' : sanitizeProtocolRecord(entry);
    }
    return sanitized as T;
  }

  if (typeof value === 'string' && shouldRedactString(value)) {
    return '[redacted]' as T;
  }

  return value;
}

class SpikeClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: JsonValue[] = [];
  private nextId = 1;

  private constructor(private readonly ws: WebSocket) {
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as JsonObject;
      const id = typeof message.id === 'number' ? message.id : null;

      if (id !== null && this.pending.has(id)) {
        const pending = this.pending.get(id);
        this.pending.delete(id);

        if (pending === undefined) {
          return;
        }

        if ('error' in message) {
          pending.reject(new Error(JSON.stringify(message.error)));
          return;
        }

        pending.resolve((message.result ?? null) as JsonValue);
        return;
      }

      this.notifications.push(message);
    });

    this.ws.on('close', () => {
      for (const request of this.pending.values()) {
        request.reject(new Error('Codex app-server websocket closed'));
      }
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<SpikeClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new SpikeClient(ws)));
      ws.once('error', reject);
    });
  }

  request(method: string, params: JsonValue): Promise<{ request: JsonObject; response: JsonValue }> {
    const id = this.nextId++;
    const request = { id, method, params };

    const response = new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(request), (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });

    return response.then((result) => ({ request, response: result }));
  }

  async requestAllowError(method: string, params: JsonValue): Promise<{ request: JsonObject; response: JsonValue }> {
    const id = this.nextId++;
    const request = { id, method, params };

    const response = new Promise<JsonValue>((resolve) => {
      this.pending.set(id, {
        resolve,
        reject: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          resolve({ error: message });
        }
      });
      this.ws.send(JSON.stringify(request), (error) => {
        if (error) {
          this.pending.delete(id);
          resolve({ error: error.message });
        }
      });
    });

    return response.then((result) => ({ request, response: result }));
  }

  drainNotifications(): JsonValue[] {
    return this.notifications.splice(0, this.notifications.length);
  }

  close(): void {
    this.ws.close();
  }
}

function getFirstListedThreadId(response: JsonValue): string | null {
  if (!isObject(response) || !Array.isArray(response.data)) {
    return null;
  }

  for (const item of response.data) {
    if (isObject(item) && typeof item.id === 'string') {
      return item.id;
    }
  }

  return null;
}

function getThreadId(response: JsonValue): string {
  if (!isObject(response) || !isObject(response.thread) || typeof response.thread.id !== 'string') {
    throw new Error('thread response did not include thread.id');
  }

  return response.thread.id;
}

function getTurnId(response: JsonValue): string {
  if (!isObject(response) || !isObject(response.turn) || typeof response.turn.id !== 'string') {
    throw new Error('turn response did not include turn.id');
  }

  return response.turn.id;
}

async function readProjectlessThreadIds(globalStatePath: string): Promise<Set<string>> {
  try {
    const raw = await readFile(globalStatePath, 'utf8');
    const parsed = JSON.parse(raw) as { ['projectless-thread-ids']?: string[] };
    return new Set(parsed['projectless-thread-ids'] ?? []);
  } catch {
    return new Set();
  }
}

async function writeFixture(record: ProtocolRecord): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const fileName = `${record.name}.json`;
  await writeFile(
    path.join(FIXTURES_DIR, fileName),
    `${JSON.stringify(sanitizeProtocolRecord(record as unknown as JsonValue), null, 2)}\n`,
    'utf8'
  );
}

function fencedJson(value: JsonValue): string {
  return ['```json', JSON.stringify(sanitizeProtocolRecord(value), null, 2), '```'].join('\n');
}

async function writeProtocolDoc(records: ProtocolRecord[], notes: string[]): Promise<void> {
  const sections = records.map((record) => {
    const parts = [`## ${record.name}`];

    if (record.request !== undefined) {
      parts.push('Request:', fencedJson(record.request));
    }

    if (record.response !== undefined) {
      parts.push('Response:', fencedJson(record.response));
    }

    if (record.notifications !== undefined && record.notifications.length > 0) {
      parts.push('Notifications observed:', fencedJson(record.notifications));
    }

    return parts.join('\n\n');
  });

  const content = [
    '# Codex App-Server Protocol Notes',
    '',
    'Generated by `src/codex/protocolSpike.ts`.',
    '',
    'The spike creates real local Codex test threads. Cleanup is manual in Codex Desktop if these test threads should be removed.',
    '',
    '## Decisions',
    '',
    ...notes.map((note) => `- ${note}`),
    '',
    ...sections
  ].join('\n');

  await mkdir(path.dirname(PROTOCOL_DOC_PATH), { recursive: true });
  await writeFile(PROTOCOL_DOC_PATH, `${content}\n`, 'utf8');
}

async function waitForTurnCompleted(client: SpikeClient, turnId: string, timeoutMs: number): Promise<JsonValue[]> {
  const started = Date.now();
  const observed: JsonValue[] = [];

  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const notifications = client.drainNotifications();
    observed.push(...notifications);

    const completed = notifications.some((notification) => {
      return (
        isObject(notification) &&
        notification.method === 'turn/completed' &&
        isObject(notification.params) &&
        isObject(notification.params.turn) &&
        notification.params.turn.id === turnId
      );
    });

    if (completed) {
      return observed;
    }
  }

  throw new Error(`Timed out waiting for turn/completed for turn ${turnId}; observed ${observed.length} notifications`);
}

export async function runProtocolSpike(): Promise<void> {
  const codexWsUrl = process.env.CODEX_WS_URL ?? DEFAULT_CODEX_WS_URL;
  const globalStatePath = process.env.CODEX_GLOBAL_STATE_PATH ?? '';
  const spikeProjectCwd = process.env.PROTOCOL_SPIKE_PROJECT_CWD ?? '';
  if (globalStatePath.length === 0) {
    throw new Error('CODEX_GLOBAL_STATE_PATH is required for the protocol spike');
  }
  if (spikeProjectCwd.length === 0) {
    throw new Error('PROTOCOL_SPIKE_PROJECT_CWD is required for the protocol spike');
  }
  const client = await SpikeClient.connect(codexWsUrl);
  const records: ProtocolRecord[] = [];
  const notes: string[] = [];
  const sideEffects: string[] = [];

  try {
    const initialize = await client.request('initialize', {
      clientInfo: {
        name: 'codex-telegram-protocol-spike',
        title: 'Codex Telegram Protocol Spike',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: []
      }
    });
    records.push({ name: 'initialize', ...initialize, notifications: client.drainNotifications() });

    const listThreads = await client.request('thread/list', {
      limit: 10,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      useStateDbOnly: true
    });
    records.push({ name: 'thread-list', ...listThreads, notifications: client.drainNotifications() });

    const startProjectThread = await client.request('thread/start', {
      cwd: spikeProjectCwd,
      sessionStartSource: 'startup'
    });
    records.push({
      name: 'thread-start-project',
      ...startProjectThread,
      notifications: client.drainNotifications()
    });

    const projectThreadId = getThreadId(startProjectThread.response);
    sideEffects.push(`Created project spike thread: ${projectThreadId}`);

    const listedThreadId = getFirstListedThreadId(listThreads.response);
    const resumeTargetThreadId = listedThreadId ?? projectThreadId;
    const resumeProjectThread = await client.requestAllowError('thread/resume', {
      threadId: resumeTargetThreadId,
      excludeTurns: true
    });
    records.push({
      name: 'thread-resume-project',
      ...resumeProjectThread,
      notifications: client.drainNotifications()
    });
    if (listedThreadId === null) {
      notes.push('No existing listed thread was available for resume; resume against the newly created empty thread may fail until the thread has rollout history.');
    } else {
      notes.push('Existing selected chats must call `thread/resume` before storing selection. The spike intentionally does not send `turn/start` to a pre-existing listed user chat because that would mutate user conversation history.');
    }

    const beforeProjectless = await readProjectlessThreadIds(globalStatePath);
    const startProjectlessThread = await client.request('thread/start', {
      sessionStartSource: 'startup'
    });
    records.push({
      name: 'thread-start-projectless-candidate',
      ...startProjectlessThread,
      notifications: client.drainNotifications()
    });

    const projectlessThreadId = getThreadId(startProjectlessThread.response);
    sideEffects.push(`Created projectless candidate spike thread: ${projectlessThreadId}`);
    const afterProjectless = await readProjectlessThreadIds(globalStatePath);
    if (!beforeProjectless.has(projectlessThreadId) && afterProjectless.has(projectlessThreadId)) {
      notes.push('`thread/start` without `cwd` created a thread that appeared in `projectless-thread-ids`; projectless chat creation can be reconsidered.');
    } else {
      notes.push('`thread/start` without `cwd` did not prove projectless Desktop classification; the Telegram bot should not expose projectless chat creation unless this is confirmed by a future protocol spike.');
    }

    const turnStart = await client.request('turn/start', {
      threadId: projectThreadId,
      input: [
        {
          type: 'text',
          text: 'Protocol spike: reply exactly protocol-spike-ok and do not run commands.',
          text_elements: []
        }
      ]
    });
    const turnId = getTurnId(turnStart.response);
    sideEffects.push(`Created spike turn on project thread: ${turnId}`);
    const turnNotifications = await waitForTurnCompleted(client, turnId, 120000);
    records.push({
      name: 'turn-start-and-complete',
      ...turnStart,
      notifications: turnNotifications
    });
    notes.push('`turn/start` response includes `turn.id`; active Telegram responses must be correlated by `threadId` and `turnId`.');
    notes.push('Approval requests were not intentionally triggered by this spike. Until exact successful approval response shapes are captured, Telegram approval buttons must not be rendered.');
    notes.push('MVP approval fallback: notify the owner that approval is unsupported in Telegram, send a JSON-RPC error response to the server request id when one is present, never auto-approve, and clear busy state only on matching terminal turn event or confirmed app-server connection loss.');
    notes.push(...sideEffects.map((item) => `Side effect: ${item}. Cleanup is manual in Codex Desktop.`));

    await Promise.all(records.map((record) => writeFixture(record)));
    await writeProtocolDoc(records, notes);
  } finally {
    client.close();
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  runProtocolSpike().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Protocol spike failed: ${message}`);
    console.error(`Start Codex first: codex app-server --listen ${process.env.CODEX_WS_URL ?? DEFAULT_CODEX_WS_URL}`);
    process.exitCode = 1;
  });
}
