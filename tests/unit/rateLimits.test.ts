import { describe, expect, it } from 'vitest';

import { formatRateLimits } from '../../src/domain/rateLimits.js';

describe('formatRateLimits', () => {
  it('renders remaining percentage and reset time for current Codex limits', () => {
    const primaryReset = Date.UTC(2026, 4, 1, 18, 30) / 1000;
    const secondaryReset = Date.UTC(2026, 4, 2, 9, 0) / 1000;

    expect(
      formatRateLimits({
        rateLimits: {
          limitId: 'codex',
          limitName: 'Codex',
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: primaryReset
          },
          secondary: {
            usedPercent: 99.6,
            windowDurationMins: 10080,
            resetsAt: secondaryReset
          },
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: '12.50'
          }
        }
      })
    ).toBe(
      [
        'Codex limits:',
        '- Codex primary (5h): 75% remaining, 25% used; resets 2026-05-01 18:30 UTC',
        '- Codex secondary (7d): 0.4% remaining, 99.6% used; resets 2026-05-02 09:00 UTC',
        'Credits: 12.50'
      ].join('\n')
    );
  });

  it('falls back to rateLimitsByLimitId when no current limit is present', () => {
    const reset = Date.UTC(2026, 4, 1, 18, 30) / 1000;

    expect(
      formatRateLimits({
        rateLimitsByLimitId: {
          codex_bengalfox: {
            limitId: 'codex_bengalfox',
            limitName: 'GPT-5.5',
            primary: {
              usedPercent: 40,
              windowDurationMins: 60,
              resetsAt: reset
            }
          }
        }
      })
    ).toContain('- GPT-5.5 primary (1h): 60% remaining, 40% used; resets 2026-05-01 18:30 UTC');
  });

  it('returns a clear message when the snapshot has no usable limit windows', () => {
    expect(formatRateLimits({ rateLimits: { limitId: 'codex' } })).toBe(
      ['Codex limits:', 'No rate limit details available yet.'].join('\n')
    );
  });
});
