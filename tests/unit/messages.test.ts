import { describe, expect, it } from 'vitest';

import { splitTelegramText } from '../../src/domain/messages.js';

describe('splitTelegramText', () => {
  it('keeps chunks below 3900 characters and preserves content order', () => {
    const text = 'a'.repeat(3900) + 'b'.repeat(3900) + 'c';

    const chunks = splitTelegramText(text);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 3900)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('returns a single fallback chunk for empty output', () => {
    expect(splitTelegramText('')).toEqual(['(no assistant text)']);
  });
});
