import { describe, expect, it } from 'vitest';

import { VoiceTurnStore } from '../../src/domain/voiceTurns.js';

describe('VoiceTurnStore', () => {
  it('blocks a thread while voice is transcribing and clears it explicitly', () => {
    const store = new VoiceTurnStore({ idGenerator: () => 'voice-id', now: () => 1000 });

    expect(store.beginTranscription({ threadId: 'thread-1', telegramChatId: 42 })).toEqual({ id: 'voice-id' });

    expect(store.isThreadBlocked('thread-1')).toBe(true);
    expect(store.beginTranscription({ threadId: 'thread-1', telegramChatId: 42, nowMs: 1001 })).toBeNull();

    store.clearThread('thread-1');

    expect(store.isThreadBlocked('thread-1')).toBe(false);
  });

  it('moves a transcribing voice turn into awaiting confirmation with opaque callback data', () => {
    const store = new VoiceTurnStore({ idGenerator: () => 'voice-id', now: () => 1000 });

    const transcription = store.beginTranscription({ threadId: 'thread-1', telegramChatId: 42 });
    const confirmation = store.awaitConfirmation({
      threadId: 'thread-1',
      telegramChatId: 42,
      transcript: 'send this exact text',
      transcriptionId: transcription?.id ?? ''
    });

    expect(confirmation).toEqual({
      id: 'voice-id',
      sendCallbackData: 'vsend:voice-id',
      cancelCallbackData: 'vcancel:voice-id'
    });
    expect(confirmation?.sendCallbackData).not.toContain('send this exact text');
    expect(store.isThreadBlocked('thread-1')).toBe(true);
  });

  it('atomically consumes a pending confirmation once', () => {
    const store = new VoiceTurnStore({ idGenerator: () => 'voice-id', now: () => 1000 });
    const transcription = store.beginTranscription({ threadId: 'thread-1', telegramChatId: 42 });
    const confirmation = store.awaitConfirmation({
      threadId: 'thread-1',
      telegramChatId: 42,
      transcript: 'send this exact text',
      transcriptionId: transcription?.id ?? ''
    });

    const first = store.consume(confirmation?.sendCallbackData);
    const second = store.consume(confirmation?.sendCallbackData);

    expect(first).toMatchObject({
      action: 'send',
      threadId: 'thread-1',
      telegramChatId: 42,
      transcript: 'send this exact text'
    });
    expect(second).toBeNull();
    expect(store.isThreadBlocked('thread-1')).toBe(false);
  });

  it('expires stale confirmation records and unblocks their threads', () => {
    const store = new VoiceTurnStore({ idGenerator: () => 'voice-id', confirmationTtlMs: 1000 });
    const transcription = store.beginTranscription({ threadId: 'thread-1', telegramChatId: 42, nowMs: 1000 });
    store.awaitConfirmation({
      threadId: 'thread-1',
      telegramChatId: 42,
      transcript: 'stale text',
      nowMs: 2000,
      transcriptionId: transcription?.id ?? ''
    });

    const expired = store.clearExpired(3001);

    expect(expired).toEqual([{ threadId: 'thread-1', telegramChatId: 42 }]);
    expect(store.isThreadBlocked('thread-1')).toBe(false);
  });

  it('does not consume expired confirmation callbacks', () => {
    let nowMs = 1000;
    const store = new VoiceTurnStore({
      idGenerator: () => 'voice-id',
      confirmationTtlMs: 100,
      now: () => nowMs
    });
    const transcription = store.beginTranscription({ threadId: 'thread-1', telegramChatId: 42 });
    const confirmation = store.awaitConfirmation({
      threadId: 'thread-1',
      telegramChatId: 42,
      transcript: 'stale text',
      transcriptionId: transcription?.id ?? ''
    });

    nowMs = 1100;

    expect(store.consume(confirmation?.sendCallbackData)).toBeNull();
    expect(store.isThreadBlocked('thread-1')).toBe(false);
  });

  it('does not let a stale transcription complete or clear a newer transcription', () => {
    const ids = ['old-transcription', 'new-transcription', 'new-confirmation'];
    let nowMs = 1000;
    const store = new VoiceTurnStore({
      idGenerator: () => ids.shift() ?? 'unexpected-id',
      transcriptionTtlMs: 100,
      now: () => nowMs
    });
    const old = store.beginTranscription({ threadId: 'thread-1', telegramChatId: 42 });

    nowMs = 1101;
    expect(store.isThreadBlocked('thread-1')).toBe(false);
    const newer = store.beginTranscription({ threadId: 'thread-1', telegramChatId: 42 });

    expect(
      store.awaitConfirmation({
        threadId: 'thread-1',
        telegramChatId: 42,
        transcript: 'old transcript',
        transcriptionId: old?.id ?? ''
      })
    ).toBeNull();
    expect(store.isThreadBlocked('thread-1')).toBe(true);

    const confirmation = store.awaitConfirmation({
      threadId: 'thread-1',
      telegramChatId: 42,
      transcript: 'new transcript',
      transcriptionId: newer?.id ?? ''
    });

    expect(confirmation?.sendCallbackData).toBe('vsend:new-confirmation');
  });
});
