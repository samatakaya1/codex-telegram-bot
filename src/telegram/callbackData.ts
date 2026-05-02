type CallbackKind = 's' | 'pc' | 'a' | 'd' | 'dc';

type BaseStoreEntry = {
  createdAt: number;
};

type StoreEntry = BaseStoreEntry & {
  value: string;
};

type SelectChatStoreEntry = StoreEntry & {
  projectPath?: string;
};

export type DeleteChatCallback = {
  threadId: string;
  projectPath: string;
};

export type DeleteChatConfirmCallback = DeleteChatCallback & {
  confirmed: boolean;
};

type DeleteChatStoreEntry = BaseStoreEntry & DeleteChatCallback;

type DeleteChatConfirmStoreEntry = BaseStoreEntry & DeleteChatConfirmCallback;

type CallbackDataStoreOptions = {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class CallbackDataStore {
  private nextId = 1;
  private readonly selectChats = new Map<string, SelectChatStoreEntry>();
  private readonly projectChats = new Map<string, StoreEntry>();
  private readonly deleteChats = new Map<string, DeleteChatStoreEntry>();
  private readonly deleteChatConfirms = new Map<string, DeleteChatConfirmStoreEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: CallbackDataStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  createSelectChat(threadId: string, projectPath?: string): string {
    const key = this.createKey();
    this.setBounded(
      this.selectChats,
      key,
      projectPath === undefined
        ? { value: threadId, createdAt: this.now() }
        : { value: threadId, projectPath, createdAt: this.now() }
    );
    return `s:${key}`;
  }

  resolveSelectChat(callbackData: string | undefined): string | null {
    const key = parseCallback(callbackData, 's');
    return key === null ? null : this.getFresh(this.selectChats, key);
  }

  resolveSelectChatProjectPath(callbackData: string | undefined): string | null {
    const key = parseCallback(callbackData, 's');
    if (key === null) {
      return null;
    }

    const entry = this.getFreshEntry(this.selectChats, key);
    return entry?.projectPath ?? null;
  }

  createProjectChat(projectPath: string): string {
    const key = this.createKey();
    this.setBounded(this.projectChats, key, { value: projectPath, createdAt: this.now() });
    return `pc:${key}`;
  }

  resolveProjectChat(callbackData: string | undefined): string | null {
    const key = parseCallback(callbackData, 'pc');
    return key === null ? null : this.getFresh(this.projectChats, key);
  }

  createDeleteChat(threadId: string, projectPath: string): string {
    const key = this.createKey();
    this.setBounded(this.deleteChats, key, { threadId, projectPath, createdAt: this.now() });
    return `d:${key}`;
  }

  resolveDeleteChat(callbackData: string | undefined): DeleteChatCallback | null {
    const key = parseCallback(callbackData, 'd');
    if (key === null) {
      return null;
    }

    const entry = this.getFreshEntry(this.deleteChats, key);
    return entry === null ? null : { threadId: entry.threadId, projectPath: entry.projectPath };
  }

  createDeleteChatConfirm(threadId: string, projectPath: string, confirmed: boolean): string {
    const key = this.createKey();
    this.setBounded(this.deleteChatConfirms, key, { threadId, projectPath, confirmed, createdAt: this.now() });
    return `dc:${key}`;
  }

  resolveDeleteChatConfirm(callbackData: string | undefined): DeleteChatConfirmCallback | null {
    const key = parseCallback(callbackData, 'dc');
    if (key === null) {
      return null;
    }

    const entry = this.getFreshEntry(this.deleteChatConfirms, key);
    return entry === null
      ? null
      : { threadId: entry.threadId, projectPath: entry.projectPath, confirmed: entry.confirmed };
  }

  private createKey(): string {
    return (this.nextId++).toString(36);
  }

  private setBounded<TEntry extends BaseStoreEntry>(map: Map<string, TEntry>, key: string, entry: TEntry): void {
    this.pruneExpired(map);
    map.set(key, entry);
    while (map.size > this.maxEntries) {
      const oldestKey = map.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      map.delete(oldestKey);
    }
  }

  private getFresh(map: Map<string, StoreEntry>, key: string): string | null {
    return this.getFreshEntry(map, key)?.value ?? null;
  }

  private getFreshEntry<TEntry extends BaseStoreEntry>(map: Map<string, TEntry>, key: string): TEntry | null {
    const entry = map.get(key);
    if (entry === undefined) {
      return null;
    }

    if (this.now() - entry.createdAt > this.ttlMs) {
      map.delete(key);
      return null;
    }

    return entry;
  }

  private pruneExpired<TEntry extends BaseStoreEntry>(map: Map<string, TEntry>): void {
    const now = this.now();
    for (const [key, entry] of map) {
      if (now - entry.createdAt > this.ttlMs) {
        map.delete(key);
      }
    }
  }
}

function parseCallback(callbackData: string | undefined, kind: CallbackKind): string | null {
  if (callbackData === undefined) {
    return null;
  }

  const prefix = `${kind}:`;
  if (!callbackData.startsWith(prefix)) {
    return null;
  }

  const key = callbackData.slice(prefix.length);
  return key.length > 0 && !key.includes(':') ? key : null;
}
