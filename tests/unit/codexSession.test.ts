import { appendFile, mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readCodexSessionModelInfo,
  readCodexSessionTokenUsage
} from '../../src/storage/codexSession.js';

async function tempSessionPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-session-unit-'));
  return path.join(dir, 'rollout-2026-05-02T16-43-09-test.jsonl');
}

describe('codex session storage', () => {
  it('reads the latest turn context model info and supports reasoning_effort', async () => {
    const sessionPath = await tempSessionPath();
    await writeFile(
      sessionPath,
      [
        '{malformed json',
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5', effort: 'high' } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', reasoning_effort: 'xhigh' } })
      ].join('\n'),
      'utf8'
    );

    const snapshot = await readCodexSessionModelInfo(sessionPath);

    expect(snapshot.modelInfo).toEqual({ model: 'gpt-5.5', effort: 'xhigh' });
    expect(snapshot.unchanged).toBe(false);
  });

  it('returns unchanged when the caller already has the current mtime and size', async () => {
    const sessionPath = await tempSessionPath();
    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5', effort: 'high' } }),
      'utf8'
    );
    const stats = await stat(sessionPath);

    const snapshot = await readCodexSessionModelInfo(sessionPath, {
      knownMtimeMs: stats.mtimeMs,
      knownSize: stats.size
    });

    expect(snapshot.modelInfo).toBeNull();
    expect(snapshot.unchanged).toBe(true);
  });

  it('finds the latest turn context before a large trailing session tail', async () => {
    const sessionPath = await tempSessionPath();
    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'xhigh' } }),
      'utf8'
    );
    await appendFile(sessionPath, `\n${'x'.repeat(1024 * 1024 + 16)}`, 'utf8');

    const snapshot = await readCodexSessionModelInfo(sessionPath);

    expect(snapshot.modelInfo).toEqual({ model: 'gpt-5.5', effort: 'xhigh' });
    expect(snapshot.unchanged).toBe(false);
  });

  it('skips overlong trailing records while scanning for model info', async () => {
    const sessionPath = await tempSessionPath();
    await writeFile(
      sessionPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'xhigh' } }),
      'utf8'
    );
    await appendFile(
      sessionPath,
      `\n${JSON.stringify({
        type: 'turn_context',
        payload: { model: 'overlong-model', effort: 'low', padding: 'x'.repeat(1024 * 1024 + 16) }
      })}`,
      'utf8'
    );

    const snapshot = await readCodexSessionModelInfo(sessionPath);

    expect(snapshot.modelInfo).toEqual({ model: 'gpt-5.5', effort: 'xhigh' });
    expect(snapshot.unchanged).toBe(false);
  });

  it('reads the latest token count as current context usage', async () => {
    const sessionPath = await tempSessionPath();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              model_context_window: 258400,
              last_token_usage: {
                input_tokens: 64000,
                output_tokens: 100,
                total_tokens: 64100
              },
              total_token_usage: {
                input_tokens: 640000,
                output_tokens: 1000,
                total_tokens: 641000
              }
            }
          }
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              model_context_window: 258400,
              last_token_usage: {
                input_tokens: 107394,
                output_tokens: 111,
                total_tokens: 107505
              },
              total_token_usage: {
                input_tokens: 5516408,
                output_tokens: 16303,
                total_tokens: 5532711
              }
            }
          }
        })
      ].join('\n'),
      'utf8'
    );

    const snapshot = await readCodexSessionTokenUsage(sessionPath);

    expect(snapshot.tokenUsage).toEqual({ usedTokens: 107394, contextWindowTokens: 258400 });
    expect(snapshot.unchanged).toBe(false);
  });

});
