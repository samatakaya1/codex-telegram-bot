import { describe, expect, it } from 'vitest';

import {
  CODEX_APPROVAL_REJECTION_MESSAGE,
  TELEGRAM_APPROVAL_UNAVAILABLE_MESSAGE,
  isApprovalUiEnabled
} from '../../src/domain/approvals.js';

describe('approval policy', () => {
  it('keeps Telegram approval UI disabled when exact protocol response shapes are not confirmed', () => {
    expect(isApprovalUiEnabled()).toBe(false);
  });

  it('keeps fail-closed messages sanitized and actionable', () => {
    const combined = `${CODEX_APPROVAL_REJECTION_MESSAGE}\n${TELEGRAM_APPROVAL_UNAVAILABLE_MESSAGE}`;

    expect(CODEX_APPROVAL_REJECTION_MESSAGE).toContain('not supported in Telegram');
    expect(TELEGRAM_APPROVAL_UNAVAILABLE_MESSAGE).toContain('not available in Telegram');
    expect(combined).toContain('Codex Desktop');
    expect(combined).not.toContain('thread-secret');
    expect(combined).not.toContain('run shell command');
  });
});
