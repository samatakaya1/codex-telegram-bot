export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel' | string;

export type AccessInput = {
  ownerId: number;
  fromId?: number;
  chatId?: number;
  chatType?: TelegramChatType;
};

export type AccessResult =
  | { ok: true }
  | { ok: false; reason: 'unauthorized' | 'private_chat_required' | 'private_chat_mismatch'; message: string };

export function checkTelegramAccess(input: AccessInput): AccessResult {
  if (input.fromId !== input.ownerId) {
    return {
      ok: false,
      reason: 'unauthorized',
      message: 'Access denied.'
    };
  }

  if (input.chatType !== 'private') {
    return {
      ok: false,
      reason: 'private_chat_required',
      message: 'This bot only works in your private chat.'
    };
  }

  if (input.chatId !== undefined && input.chatId !== input.ownerId) {
    return {
      ok: false,
      reason: 'private_chat_mismatch',
      message: 'Access denied for this private chat.'
    };
  }

  return { ok: true };
}
