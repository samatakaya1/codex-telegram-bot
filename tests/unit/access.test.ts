import { describe, expect, it } from 'vitest';

import { checkTelegramAccess } from '../../src/telegram/access.js';

const ownerId = 42;

describe('checkTelegramAccess', () => {
  it('allows only the configured owner in a private chat', () => {
    expect(
      checkTelegramAccess({
        ownerId,
        fromId: ownerId,
        chatId: ownerId,
        chatType: 'private'
      })
    ).toEqual({ ok: true });
  });

  it('rejects unauthorized users before Codex can be called', () => {
    expect(
      checkTelegramAccess({
        ownerId,
        fromId: 1,
        chatId: 1,
        chatType: 'private'
      })
    ).toMatchObject({ ok: false, reason: 'unauthorized' });
  });

  it('rejects group chats even when the sender is the owner', () => {
    expect(
      checkTelegramAccess({
        ownerId,
        fromId: ownerId,
        chatId: -100,
        chatType: 'supergroup'
      })
    ).toMatchObject({ ok: false, reason: 'private_chat_required' });
  });

  it('rejects private chats whose chat id does not match the owner when provided', () => {
    expect(
      checkTelegramAccess({
        ownerId,
        fromId: ownerId,
        chatId: 123,
        chatType: 'private'
      })
    ).toMatchObject({ ok: false, reason: 'private_chat_mismatch' });
  });
});
