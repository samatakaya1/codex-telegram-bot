import type { CodexThread } from '../codex/protocol.js';

export type ChatSummary = {
  id: string;
  title: string;
  preview?: string;
  projectPath?: string;
  updatedAt?: number;
};

export type ClassifiedChats = {
  projectless: ChatSummary[];
  project: Record<string, ChatSummary[]>;
};

function titleForThread(thread: CodexThread): string {
  if (typeof thread.name === 'string' && thread.name.trim().length > 0) {
    return thread.name.trim();
  }

  if (typeof thread.preview === 'string' && thread.preview.trim().length > 0) {
    return thread.preview.trim();
  }

  return thread.id;
}

function projectPathForThread(thread: CodexThread): string {
  if (typeof thread.cwd === 'string' && thread.cwd.trim().length > 0) {
    return thread.cwd;
  }

  if (typeof thread.path === 'string' && thread.path.trim().length > 0) {
    return thread.path;
  }

  return '(unknown project)';
}

function summarizeThread(thread: CodexThread): ChatSummary {
  return {
    id: thread.id,
    title: titleForThread(thread),
    preview: typeof thread.preview === 'string' ? thread.preview : undefined,
    projectPath:
      typeof thread.cwd === 'string' && thread.cwd.length > 0
        ? thread.cwd
        : typeof thread.path === 'string' && thread.path.length > 0
          ? thread.path
          : undefined,
    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : undefined
  };
}

const titleCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function byUpdatedDescThenTitle(left: ChatSummary, right: ChatSummary): number {
  const leftUpdated = left.updatedAt ?? 0;
  const rightUpdated = right.updatedAt ?? 0;
  if (leftUpdated !== rightUpdated) {
    return rightUpdated - leftUpdated;
  }

  return titleCollator.compare(left.title, right.title);
}

export function classifyThreads(threads: CodexThread[], projectlessIds: Set<string>): ClassifiedChats {
  const classified: ClassifiedChats = {
    projectless: [],
    project: Object.create(null) as Record<string, ChatSummary[]>
  };

  for (const thread of threads) {
    const summary = summarizeThread(thread);
    if (projectlessIds.has(thread.id)) {
      classified.projectless.push(summary);
      continue;
    }

    const projectPath = projectPathForThread(thread);
    classified.project[projectPath] ??= [];
    classified.project[projectPath].push(summary);
  }

  classified.projectless.sort(byUpdatedDescThenTitle);
  for (const chats of Object.values(classified.project)) {
    chats.sort(byUpdatedDescThenTitle);
  }

  return classified;
}

export class BusyThreadStore {
  private readonly busyThreadIds = new Set<string>();

  markThreadBusy(threadId: string): void {
    if (this.busyThreadIds.has(threadId)) {
      throw new Error(`Thread ${threadId} already has a running turn`);
    }

    this.busyThreadIds.add(threadId);
  }

  markThreadIdle(threadId: string): void {
    this.busyThreadIds.delete(threadId);
  }

  isThreadBusy(threadId: string): boolean {
    return this.busyThreadIds.has(threadId);
  }

  clear(): void {
    this.busyThreadIds.clear();
  }
}

const defaultBusyThreadStore = new BusyThreadStore();

export function markThreadBusy(threadId: string): void {
  defaultBusyThreadStore.markThreadBusy(threadId);
}

export function markThreadIdle(threadId: string): void {
  defaultBusyThreadStore.markThreadIdle(threadId);
}

export function isThreadBusy(threadId: string): boolean {
  return defaultBusyThreadStore.isThreadBusy(threadId);
}

export function resetDefaultBusyThreadStoreForTests(): void {
  defaultBusyThreadStore.clear();
}
