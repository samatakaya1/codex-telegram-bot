import { describe, expect, it } from 'vitest';

import {
  BusyThreadStore,
  classifyThreads,
  markThreadBusy,
  markThreadIdle,
  isThreadBusy,
  resetDefaultBusyThreadStoreForTests
} from '../../src/domain/chats.js';
import type { CodexThread } from '../../src/codex/protocol.js';

describe('classifyThreads', () => {
  const threads: CodexThread[] = [
    { id: 'chat-1', preview: 'Projectless', updatedAt: 3 },
    { id: 'chat-2', preview: 'Project A', cwd: 'C:\\Workspace\\A', updatedAt: 2 },
    { id: 'chat-3', name: 'Project B', cwd: 'C:\\Workspace\\B', updatedAt: 1 }
  ];

  it('classifies projectless chats only when ids are listed in global state', () => {
    const classified = classifyThreads(threads, new Set(['chat-1', 'unknown-id']));

    expect(classified.projectless.map((chat) => chat.id)).toEqual(['chat-1']);
    expect(Object.keys(classified.project).sort()).toEqual(['C:\\Workspace\\A', 'C:\\Workspace\\B']);
    expect(classified.project['C:\\Workspace\\A']?.map((chat) => chat.id)).toEqual(['chat-2']);
  });

  it('uses a stable display title when preview or name is missing', () => {
    const classified = classifyThreads([{ id: 'chat-1' }], new Set(['chat-1']));

    expect(classified.projectless[0]?.title).toBe('chat-1');
  });

  it('handles malicious or inherited project path keys without crashing', () => {
    const classified = classifyThreads(
      [
        { id: 'chat-1', cwd: '__proto__', preview: 'Proto' },
        { id: 'chat-2', cwd: 'constructor', preview: 'Constructor' }
      ],
      new Set()
    );

    expect(classified.project['__proto__']?.map((chat) => chat.id)).toEqual(['chat-1']);
    expect(classified.project['constructor']?.map((chat) => chat.id)).toEqual(['chat-2']);
  });
});

describe('BusyThreadStore', () => {
  it('rejects a second busy mark until the thread is marked idle', () => {
    const busy = new BusyThreadStore();

    busy.markThreadBusy('thread-1');

    expect(busy.isThreadBusy('thread-1')).toBe(true);
    expect(() => busy.markThreadBusy('thread-1')).toThrow('already has a running turn');

    busy.markThreadIdle('thread-1');
    expect(busy.isThreadBusy('thread-1')).toBe(false);
    expect(() => busy.markThreadBusy('thread-1')).not.toThrow();
  });

  it('exports default busy-state functions for simple application wiring', () => {
    resetDefaultBusyThreadStoreForTests();

    markThreadBusy('thread-1');

    expect(isThreadBusy('thread-1')).toBe(true);
    markThreadIdle('thread-1');
    expect(isThreadBusy('thread-1')).toBe(false);
  });
});
