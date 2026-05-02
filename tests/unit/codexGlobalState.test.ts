import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readProjectlessThreadIds } from '../../src/storage/codexGlobalState.js';

describe('readProjectlessThreadIds', () => {
  it('reads projectless-thread-ids as a Set without writing to the file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-global-state-'));
    const file = path.join(dir, '.codex-global-state.json');
    const original = JSON.stringify({
      'projectless-thread-ids': ['thread-a', 'thread-b', 123, null]
    });
    await writeFile(file, original, 'utf8');

    const ids = await readProjectlessThreadIds(file);

    expect(ids).toEqual(new Set(['thread-a', 'thread-b']));
    await expect(readFile(file, 'utf8')).resolves.toBe(original);
  });

  it('returns an empty set and warns when the file is missing or malformed', async () => {
    const warn = vi.fn();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-global-state-'));
    const malformed = path.join(dir, 'bad.json');
    const wrongShape = path.join(dir, 'wrong-shape.json');
    await writeFile(malformed, '{bad json', 'utf8');
    await writeFile(wrongShape, JSON.stringify({ 'projectless-thread-ids': 'bad' }), 'utf8');

    await expect(readProjectlessThreadIds(path.join(dir, 'missing.json'), { warn })).resolves.toEqual(new Set());
    await expect(readProjectlessThreadIds(malformed, { warn })).resolves.toEqual(new Set());
    await expect(readProjectlessThreadIds(wrongShape, { warn })).resolves.toEqual(new Set());
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
