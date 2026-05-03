import { randomBytes } from 'node:crypto';

const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TRANSCRIPTION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CONFIRMATIONS = 50;
const SEND_PREFIX = 'vsend:';
const CANCEL_PREFIX = 'vcancel:';

type VoiceTurnKind = 'transcribing' | 'awaiting_confirmation';

type VoiceTurnRecord = {
  kind: VoiceTurnKind;
  threadId: string;
  telegramChatId: number;
  expiresAtMs: number;
  id: string;
  transcript?: string;
};

export type VoiceConfirmationAction = 'send' | 'cancel';

export type VoiceTranscriptionReservation = {
  id: string;
};

export type VoiceConfirmation = {
  id: string;
  sendCallbackData: string;
  cancelCallbackData: string;
};

export type ConsumedVoiceConfirmation = {
  action: VoiceConfirmationAction;
  threadId: string;
  telegramChatId: number;
  transcript: string;
};

export type ExpiredVoiceTurn = {
  threadId: string;
  telegramChatId: number;
};

type VoiceTurnStoreOptions = {
  idGenerator?: () => string;
  now?: () => number;
  confirmationTtlMs?: number;
  transcriptionTtlMs?: number;
  maxConfirmations?: number;
};

export class VoiceTurnStore {
  private readonly idGenerator: () => string;
  private readonly now: () => number;
  private readonly confirmationTtlMs: number;
  private readonly transcriptionTtlMs: number;
  private readonly maxConfirmations: number;
  private readonly recordsByThreadId = new Map<string, VoiceTurnRecord>();
  private readonly threadIdByConfirmationId = new Map<string, string>();

  constructor(options: VoiceTurnStoreOptions = {}) {
    this.idGenerator = options.idGenerator ?? createRandomId;
    this.now = options.now ?? (() => Date.now());
    this.confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.transcriptionTtlMs = options.transcriptionTtlMs ?? DEFAULT_TRANSCRIPTION_TTL_MS;
    this.maxConfirmations = options.maxConfirmations ?? DEFAULT_MAX_CONFIRMATIONS;
  }

  beginTranscription(params: { threadId: string; telegramChatId: number; nowMs?: number }): VoiceTranscriptionReservation | null {
    this.clearExpired(params.nowMs ?? this.now());
    if (this.isThreadBlocked(params.threadId)) {
      return null;
    }

    const id = this.idGenerator();
    this.recordsByThreadId.set(params.threadId, {
      kind: 'transcribing',
      id,
      threadId: params.threadId,
      telegramChatId: params.telegramChatId,
      expiresAtMs: (params.nowMs ?? this.now()) + this.transcriptionTtlMs
    });
    return { id };
  }

  awaitConfirmation(params: {
    threadId: string;
    telegramChatId: number;
    transcript: string;
    transcriptionId: string;
    nowMs?: number;
  }): VoiceConfirmation | null {
    const existing = this.recordsByThreadId.get(params.threadId);
    if (existing?.kind !== 'transcribing' || existing.id !== params.transcriptionId) {
      return null;
    }

    const id = this.idGenerator();
    this.recordsByThreadId.set(params.threadId, {
      kind: 'awaiting_confirmation',
      id,
      threadId: params.threadId,
      telegramChatId: params.telegramChatId,
      transcript: params.transcript,
      expiresAtMs: (params.nowMs ?? this.now()) + this.confirmationTtlMs
    });
    this.threadIdByConfirmationId.set(id, params.threadId);
    this.pruneOldestConfirmations();

    return {
      id,
      sendCallbackData: `${SEND_PREFIX}${id}`,
      cancelCallbackData: `${CANCEL_PREFIX}${id}`
    };
  }

  consume(callbackData: string | undefined): ConsumedVoiceConfirmation | null {
    this.clearExpired(this.now());
    const parsed = parseVoiceCallbackData(callbackData);
    if (parsed === null) {
      return null;
    }

    const threadId = this.threadIdByConfirmationId.get(parsed.id);
    if (threadId === undefined) {
      return null;
    }

    const record = this.recordsByThreadId.get(threadId);
    if (record?.kind !== 'awaiting_confirmation' || record.id !== parsed.id || record.transcript === undefined) {
      return null;
    }

    this.recordsByThreadId.delete(threadId);
    this.threadIdByConfirmationId.delete(parsed.id);
    return {
      action: parsed.action,
      threadId: record.threadId,
      telegramChatId: record.telegramChatId,
      transcript: record.transcript
    };
  }

  isThreadBlocked(threadId: string): boolean {
    this.clearExpired(this.now());
    return this.recordsByThreadId.has(threadId);
  }

  clearTranscription(threadId: string, transcriptionId: string): boolean {
    const record = this.recordsByThreadId.get(threadId);
    if (record?.kind !== 'transcribing' || record.id !== transcriptionId) {
      return false;
    }
    this.recordsByThreadId.delete(threadId);
    return true;
  }

  clearConfirmation(threadId: string, confirmationId: string): boolean {
    const record = this.recordsByThreadId.get(threadId);
    if (record?.kind !== 'awaiting_confirmation' || record.id !== confirmationId) {
      return false;
    }
    this.recordsByThreadId.delete(threadId);
    this.threadIdByConfirmationId.delete(confirmationId);
    return true;
  }

  clearThread(threadId: string): void {
    const record = this.recordsByThreadId.get(threadId);
    if (record?.id !== undefined) {
      this.threadIdByConfirmationId.delete(record.id);
    }
    this.recordsByThreadId.delete(threadId);
  }

  clearExpired(nowMs = this.now()): ExpiredVoiceTurn[] {
    const expired: ExpiredVoiceTurn[] = [];
    for (const record of this.recordsByThreadId.values()) {
      if (record.expiresAtMs <= nowMs) {
        expired.push({ threadId: record.threadId, telegramChatId: record.telegramChatId });
        this.clearThread(record.threadId);
      }
    }
    return expired;
  }

  private pruneOldestConfirmations(): void {
    const confirmations = [...this.recordsByThreadId.values()].filter((record) => record.kind === 'awaiting_confirmation');
    const overLimit = confirmations.length - this.maxConfirmations;
    if (overLimit <= 0) {
      return;
    }

    confirmations
      .sort((first, second) => first.expiresAtMs - second.expiresAtMs)
      .slice(0, overLimit)
      .forEach((record) => this.clearThread(record.threadId));
  }
}

function parseVoiceCallbackData(
  callbackData: string | undefined
): { action: VoiceConfirmationAction; id: string } | null {
  if (callbackData?.startsWith(SEND_PREFIX) === true) {
    return { action: 'send', id: callbackData.slice(SEND_PREFIX.length) };
  }
  if (callbackData?.startsWith(CANCEL_PREFIX) === true) {
    return { action: 'cancel', id: callbackData.slice(CANCEL_PREFIX.length) };
  }
  return null;
}

export function isVoiceCallbackData(callbackData: string | undefined): boolean {
  return callbackData?.startsWith(SEND_PREFIX) === true || callbackData?.startsWith(CANCEL_PREFIX) === true;
}

function createRandomId(): string {
  return randomBytes(16).toString('base64url');
}
