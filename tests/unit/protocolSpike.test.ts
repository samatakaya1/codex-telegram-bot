import { describe, expect, it } from 'vitest';

import { sanitizeProtocolRecord } from '../../src/codex/protocolSpike.js';

describe('sanitizeProtocolRecord', () => {
  it('redacts token-like strings and authorization headers before writing fixtures', () => {
    const sanitized = sanitizeProtocolRecord({
      token: '123456:telegram-secret',
      headers: {
        authorization: 'authorization-sample'
      },
      nested: {
        botToken: '999:secret',
        safe: 'keep'
      }
    });

    expect(sanitized).toEqual({
      token: '[redacted]',
      headers: {
        authorization: '[redacted]'
      },
      nested: {
        botToken: '[redacted]',
        safe: 'keep'
      }
    });
  });

  it('redacts local account, repository, and filesystem metadata', () => {
    const sanitized = sanitizeProtocolRecord({
      codexHome: '<USERPROFILE>\\.codex',
      cwd: 'C:\\Workspace\\New project',
      instructionSources: ['<USERPROFILE>\\.codex\\AGENTS.md'],
      writableRoots: ['C:\\Workspace\\New project'],
      gitInfo: {
        sha: '9bbce013ad1974690f228077d7caa75223968bd8',
        branch: 'codex/telegram-app-server',
        originUrl: 'https://example.com/private.git'
      },
      account: {
        plan: 'pro',
        rateLimits: {
          remaining: 42
        }
      },
      safeShapeField: 'keep'
    });

    expect(sanitized).toEqual({
      codexHome: '[redacted]',
      cwd: '[redacted]',
      instructionSources: '[redacted]',
      writableRoots: '[redacted]',
      gitInfo: '[redacted]',
      account: '[redacted]',
      safeShapeField: 'keep'
    });
  });

  it('redacts local protocol identifiers and environment metadata', () => {
    const sanitized = sanitizeProtocolRecord({
      id: 1,
      threadId: '00000000-0000-0000-0000-000000000000',
      turnId: '11111111-1111-1111-1111-111111111111',
      itemId: 'msg_short',
      item: {
        id: 'rs_short'
      },
      userAgent: 'Codex Desktop/test (Synthetic OS; x86_64) unknown',
      error: 'Synthetic local protocol error'
    });

    expect(sanitized).toEqual({
      id: 1,
      threadId: '[redacted]',
      turnId: '[redacted]',
      itemId: '[redacted]',
      item: {
        id: '[redacted]'
      },
      userAgent: '[redacted]',
      error: '[redacted]'
    });
  });
});

