import { open, stat } from 'node:fs/promises';

export type CodexSessionModelInfo = {
  model: string;
  effort?: string;
};

export type CodexSessionTokenUsage = {
  usedTokens: number;
  contextWindowTokens: number;
};

export type CodexSessionModelInfoSnapshot = {
  modelInfo: CodexSessionModelInfo | null;
  mtimeMs: number;
  size: number;
  unchanged: boolean;
};

export type CodexSessionTokenUsageSnapshot = {
  tokenUsage: CodexSessionTokenUsage | null;
  mtimeMs: number;
  size: number;
  unchanged: boolean;
};

const SESSION_MODEL_SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_SESSION_MODEL_LINE_BYTES = 1024 * 1024;
const EMPTY_BUFFER = Buffer.alloc(0);
const LINE_FEED_BYTE = 0x0a;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function readCodexSessionModelInfo(
  sessionPath: string,
  options: { knownMtimeMs?: number; knownSize?: number } = {}
): Promise<CodexSessionModelInfoSnapshot> {
  return readCodexSessionLatest(sessionPath, modelInfoFromJsonLine, 'modelInfo', options);
}

export async function readCodexSessionTokenUsage(
  sessionPath: string,
  options: { knownMtimeMs?: number; knownSize?: number } = {}
): Promise<CodexSessionTokenUsageSnapshot> {
  return readCodexSessionLatest(sessionPath, tokenUsageFromJsonLine, 'tokenUsage', options);
}

async function readCodexSessionLatest<T, K extends string>(
  sessionPath: string,
  parseLine: (line: string) => T | null,
  resultKey: K,
  options: { knownMtimeMs?: number; knownSize?: number } = {}
): Promise<Record<K, T | null> & { mtimeMs: number; size: number; unchanged: boolean }> {
  const stats = await stat(sessionPath);
  if (options.knownMtimeMs === stats.mtimeMs && options.knownSize === stats.size) {
    return { [resultKey]: null, mtimeMs: stats.mtimeMs, size: stats.size, unchanged: true } as Record<K, T | null> & {
      mtimeMs: number;
      size: number;
      unchanged: boolean;
    };
  }

  const file = await open(sessionPath, 'r');
  try {
    let position = stats.size;
    let carry = EMPTY_BUFFER;
    let skippingOverlongLine = false;

    while (position > 0) {
      const bytesToRead = Math.min(position, SESSION_MODEL_SCAN_CHUNK_BYTES);
      position -= bytesToRead;

      const buffer = Buffer.alloc(bytesToRead);
      const result = await file.read(buffer, 0, bytesToRead, position);
      if (result.bytesRead === 0) {
        break;
      }

      const chunk = buffer.subarray(0, result.bytesRead);
      let scanEnd = chunk.length;
      let newlineIndex = lastIndexOfByte(chunk, LINE_FEED_BYTE, scanEnd - 1);

      while (newlineIndex !== -1) {
        if (skippingOverlongLine) {
          skippingOverlongLine = false;
          carry = EMPTY_BUFFER;
        } else {
          const value = valueFromLineParts(chunk.subarray(newlineIndex + 1, scanEnd), carry, parseLine);
          if (value !== null) {
            return { [resultKey]: value, mtimeMs: stats.mtimeMs, size: stats.size, unchanged: false } as Record<
              K,
              T | null
            > & { mtimeMs: number; size: number; unchanged: boolean };
          }
          carry = EMPTY_BUFFER;
        }

        scanEnd = newlineIndex;
        newlineIndex = lastIndexOfByte(chunk, LINE_FEED_BYTE, scanEnd - 1);
      }

      const prefix = chunk.subarray(0, scanEnd);
      if (position === 0) {
        if (!skippingOverlongLine) {
          const value = valueFromLineParts(prefix, carry, parseLine);
          if (value !== null) {
            return { [resultKey]: value, mtimeMs: stats.mtimeMs, size: stats.size, unchanged: false } as Record<
              K,
              T | null
            > & { mtimeMs: number; size: number; unchanged: boolean };
          }
        }
        carry = EMPTY_BUFFER;
        skippingOverlongLine = false;
      } else if (!skippingOverlongLine) {
        const nextCarryLength = prefix.length + carry.length;
        if (nextCarryLength > MAX_SESSION_MODEL_LINE_BYTES) {
          carry = EMPTY_BUFFER;
          skippingOverlongLine = true;
        } else {
          carry = carry.length === 0 ? Buffer.from(prefix) : Buffer.concat([prefix, carry], nextCarryLength);
        }
      }
    }
  } finally {
    await file.close();
  }

  return { [resultKey]: null, mtimeMs: stats.mtimeMs, size: stats.size, unchanged: false } as Record<K, T | null> & {
    mtimeMs: number;
    size: number;
    unchanged: boolean;
  };
}

function valueFromLineParts<T>(prefix: Buffer, suffix: Buffer, parseLine: (line: string) => T | null): T | null {
  const lineLength = prefix.length + suffix.length;
  if (lineLength > MAX_SESSION_MODEL_LINE_BYTES) {
    return null;
  }

  const line = suffix.length === 0 ? prefix.toString('utf8') : Buffer.concat([prefix, suffix], lineLength).toString('utf8');
  return parseLine(line);
}

function lastIndexOfByte(buffer: Buffer, byte: number, fromIndex: number): number {
  for (let index = Math.min(fromIndex, buffer.length - 1); index >= 0; index -= 1) {
    if (buffer[index] === byte) {
      return index;
    }
  }

  return -1;
}

function modelInfoFromJsonLine(line: string): CodexSessionModelInfo | null {
  if (line.trim().length === 0) {
    return null;
  }

  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(entry) || entry.type !== 'turn_context' || !isRecord(entry.payload)) {
    return null;
  }

  const model = nonEmptyString(entry.payload.model);
  if (model === undefined) {
    return null;
  }

  const effort = nonEmptyString(entry.payload.effort) ?? nonEmptyString(entry.payload.reasoning_effort);
  return effort === undefined ? { model } : { model, effort };
}

function tokenUsageFromJsonLine(line: string): CodexSessionTokenUsage | null {
  if (line.trim().length === 0) {
    return null;
  }

  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(entry) || entry.type !== 'event_msg' || !isRecord(entry.payload)) {
    return null;
  }

  if (entry.payload.type !== 'token_count' || !isRecord(entry.payload.info)) {
    return null;
  }

  const contextWindowTokens = finiteNonNegativeInteger(entry.payload.info.model_context_window);
  const lastTokenUsage = entry.payload.info.last_token_usage;
  const usedTokens = isRecord(lastTokenUsage) ? finiteNonNegativeInteger(lastTokenUsage.input_tokens) : undefined;

  if (contextWindowTokens === undefined || contextWindowTokens === 0 || usedTokens === undefined) {
    return null;
  }

  return { usedTokens, contextWindowTokens };
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}
