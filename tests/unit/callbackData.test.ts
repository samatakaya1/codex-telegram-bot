import { describe, expect, it } from 'vitest';

import { CallbackDataStore } from '../../src/telegram/callbackData.js';

describe('CallbackDataStore', () => {
  it('encodes long thread ids into compact select callback data', () => {
    const store = new CallbackDataStore();
    const threadId = 'thread-synthetic-id';
    const projectPath = 'C:\\Workspace\\Project';

    const callback = store.createSelectChat(threadId, projectPath);

    expect(callback.length).toBeLessThanOrEqual(64);
    expect(callback.startsWith('s:')).toBe(true);
    expect(callback).not.toContain(threadId);
    expect(callback).not.toContain(projectPath);
    expect(store.resolveSelectChat(callback)).toBe(threadId);
    expect(store.resolveSelectChatProjectPath(callback)).toBe(projectPath);
  });

  it('encodes project paths for project-chat callbacks without exposing the path', () => {
    const store = new CallbackDataStore();
    const projectPath = 'C:\\Workspace\\A very long project path with spaces';

    const callback = store.createProjectChat(projectPath);

    expect(callback.length).toBeLessThanOrEqual(64);
    expect(callback.startsWith('pc:')).toBe(true);
    expect(callback).not.toContain(projectPath);
    expect(store.resolveProjectChat(callback)).toBe(projectPath);
  });

  it('encodes delete-chat callbacks without exposing thread ids or project paths', () => {
    const store = new CallbackDataStore();
    const threadId = 'thread-synthetic-id';
    const projectPath = 'C:\\Workspace\\A very long project path with spaces';

    const chooseCallback = store.createDeleteChat(threadId, projectPath);
    const confirmCallback = store.createDeleteChatConfirm(threadId, projectPath, true);
    const cancelCallback = store.createDeleteChatConfirm(threadId, projectPath, false);

    expect(chooseCallback.length).toBeLessThanOrEqual(64);
    expect(chooseCallback.startsWith('d:')).toBe(true);
    expect(chooseCallback).not.toContain(threadId);
    expect(chooseCallback).not.toContain(projectPath);
    expect(store.resolveDeleteChat(chooseCallback)).toEqual({ threadId, projectPath });

    expect(confirmCallback.length).toBeLessThanOrEqual(64);
    expect(confirmCallback.startsWith('dc:')).toBe(true);
    expect(confirmCallback).not.toContain(threadId);
    expect(confirmCallback).not.toContain(projectPath);
    expect(store.resolveDeleteChatConfirm(confirmCallback)).toEqual({ threadId, projectPath, confirmed: true });
    expect(store.resolveDeleteChatConfirm(cancelCallback)).toEqual({ threadId, projectPath, confirmed: false });
  });

  it('returns null for stale or malformed callbacks', () => {
    const store = new CallbackDataStore();

    expect(store.resolveSelectChat('s:missing')).toBeNull();
    expect(store.resolveProjectChat('bad')).toBeNull();
    expect(store.resolveDeleteChat('d:missing')).toBeNull();
    expect(store.resolveDeleteChatConfirm('dc:missing')).toBeNull();
  });

  it('expires old callbacks and bounds stored callback entries', () => {
    let now = 1_000;
    const store = new CallbackDataStore({ maxEntries: 2, ttlMs: 100, now: () => now });

    const first = store.createSelectChat('thread-1');
    const second = store.createSelectChat('thread-2');
    const third = store.createSelectChat('thread-3');

    expect(store.resolveSelectChat(first)).toBeNull();
    expect(store.resolveSelectChat(second)).toBe('thread-2');
    expect(store.resolveSelectChat(third)).toBe('thread-3');

    now = 1_101;
    expect(store.resolveSelectChat(second)).toBeNull();
    expect(store.resolveDeleteChat(store.createDeleteChat('thread-4', 'C:\\Workspace\\Project'))).toEqual({
      threadId: 'thread-4',
      projectPath: 'C:\\Workspace\\Project'
    });
  });

  it('does not expose approval approve or reject callback helpers until protocol shapes are confirmed', () => {
    const store = new CallbackDataStore();

    expect('createApproval' in store).toBe(false);
    expect('resolveApproval' in store).toBe(false);
  });
});
