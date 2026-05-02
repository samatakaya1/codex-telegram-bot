import { readFile } from 'node:fs/promises';

type WarnLogger = {
  warn: (message: string) => void;
};

type ReadProjectlessOptions = {
  warn?: WarnLogger['warn'];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readProjectlessThreadIds(
  globalStatePath: string,
  options: ReadProjectlessOptions = {}
): Promise<Set<string>> {
  try {
    const raw = await readFile(globalStatePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      throw new Error('global state root is not an object');
    }

    const ids = parsed['projectless-thread-ids'];
    if (!Array.isArray(ids)) {
      throw new Error('projectless-thread-ids is not an array');
    }

    return new Set(ids.filter((id): id is string => typeof id === 'string'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.warn?.(`Could not read Codex projectless thread ids from ${globalStatePath}: ${message}`);
    return new Set();
  }
}
