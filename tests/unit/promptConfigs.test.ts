import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { promptConfigSchema } from '../../src/domain/promptConfigs.js';
import {
  COMMIT_PROMPT_CONFIG,
  DEFAULT_PROMPT_CONFIGS,
  REVIEW_FIX_PROMPT_CONFIG
} from '../../src/promptConfigs/defaults.js';
import {
  bootstrapPromptConfigDefaults,
  loadPromptConfigs
} from '../../src/storage/promptConfigs.js';
import type { PromptConfig } from '../../src/domain/promptConfigs.js';

const defaultReviewFixConfig: PromptConfig = {
  schemaVersion: 1,
  id: 'review_fix',
  title: 'Review Fix',
  description: 'Review current work.',
  triggers: ['/review_fix'],
  telegramMenuCommand: 'review_fix',
  requiresSelectedChat: true,
  workingMessage: 'Starting review/fix cycle...',
  prompt: 'Default review prompt',
  enabled: true
};

async function tempPromptConfigDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'prompt-configs-unit-'));
}

describe('prompt config storage', () => {
  it('keeps the shipped review_fix default valid and underscore-only', () => {
    expect(promptConfigSchema.safeParse(REVIEW_FIX_PROMPT_CONFIG).success).toBe(true);
    expect(REVIEW_FIX_PROMPT_CONFIG.id).toBe('review_fix');
    expect(REVIEW_FIX_PROMPT_CONFIG.triggers).toEqual(['/review_fix']);
    expect(REVIEW_FIX_PROMPT_CONFIG.telegramMenuCommand).toBe('review_fix');
  });

  it('keeps the shipped commit default valid and aligned with commit safety decisions', () => {
    expect(promptConfigSchema.safeParse(COMMIT_PROMPT_CONFIG).success).toBe(true);
    expect(COMMIT_PROMPT_CONFIG.id).toBe('commit');
    expect(COMMIT_PROMPT_CONFIG.triggers).toEqual(['/commit']);
    expect(COMMIT_PROMPT_CONFIG.telegramMenuCommand).toBe('commit');
    expect(COMMIT_PROMPT_CONFIG.prompt).toContain('git fetch');
    expect(COMMIT_PROMPT_CONFIG.prompt).toContain('If the source branch is the integration branch');
    expect(COMMIT_PROMPT_CONFIG.prompt).toContain('merge commit');
  });

  it('bootstraps all built-in default prompt files', async () => {
    const dir = await tempPromptConfigDir();
    await bootstrapPromptConfigDefaults(dir, DEFAULT_PROMPT_CONFIGS);

    await expect(readFile(path.join(dir, 'review_fix.json'), 'utf8')).resolves.toContain('"id": "review_fix"');
    await expect(readFile(path.join(dir, 'commit.json'), 'utf8')).resolves.toContain('"id": "commit"');
  });

  it('bootstraps editable default files without overwriting user edits', async () => {
    const dir = await tempPromptConfigDir();
    await bootstrapPromptConfigDefaults(dir, [defaultReviewFixConfig]);
    const file = path.join(dir, 'review_fix.json');

    const editedConfig = {
      ...defaultReviewFixConfig,
      prompt: 'User edited prompt'
    };
    await writeFile(file, `${JSON.stringify(editedConfig, null, 2)}\n`, 'utf8');

    await bootstrapPromptConfigDefaults(dir, [defaultReviewFixConfig]);

    await expect(readFile(file, 'utf8')).resolves.toContain('User edited prompt');
  });

  it('loads a valid user override instead of the built-in default', async () => {
    const dir = await tempPromptConfigDir();
    await bootstrapPromptConfigDefaults(dir, [defaultReviewFixConfig]);
    await writeFile(
      path.join(dir, 'review_fix.json'),
      `${JSON.stringify({ ...defaultReviewFixConfig, prompt: 'Override prompt' }, null, 2)}\n`,
      'utf8'
    );

    const configs = await loadPromptConfigs({ dir, defaults: [defaultReviewFixConfig] });

    expect(configs.get('review_fix')?.prompt).toBe('Override prompt');
  });

  it('loads additional valid user prompt configs', async () => {
    const dir = await tempPromptConfigDir();
    await bootstrapPromptConfigDefaults(dir, [defaultReviewFixConfig]);
    await writeFile(
      path.join(dir, 'custom_review.json'),
      `${JSON.stringify(
        {
          ...defaultReviewFixConfig,
          id: 'custom_review',
          title: 'Custom Review',
          triggers: ['/custom_review'],
          telegramMenuCommand: 'custom_review',
          prompt: 'Custom review prompt'
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const configs = await loadPromptConfigs({ dir, defaults: [defaultReviewFixConfig] });

    expect(configs.get('custom_review')?.prompt).toBe('Custom review prompt');
  });

  it('falls back to the built-in default when a user override is malformed', async () => {
    const dir = await tempPromptConfigDir();
    const logger = { warn: vi.fn() };
    await bootstrapPromptConfigDefaults(dir, [defaultReviewFixConfig]);
    await writeFile(path.join(dir, 'review_fix.json'), '{ "prompt": "secret malformed prompt"', 'utf8');

    const configs = await loadPromptConfigs({ dir, defaults: [defaultReviewFixConfig], logger });

    expect(configs.get('review_fix')?.prompt).toBe('Default review prompt');
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret malformed prompt');
  });

  it('rejects unsupported schema versions without losing the built-in default', async () => {
    const dir = await tempPromptConfigDir();
    const logger = { warn: vi.fn() };
    await bootstrapPromptConfigDefaults(dir, [defaultReviewFixConfig]);
    await writeFile(
      path.join(dir, 'review_fix.json'),
      `${JSON.stringify({ ...defaultReviewFixConfig, schemaVersion: 2, prompt: 'schema v2 prompt' }, null, 2)}\n`,
      'utf8'
    );

    const configs = await loadPromptConfigs({ dir, defaults: [defaultReviewFixConfig], logger });

    expect(configs.get('review_fix')?.prompt).toBe('Default review prompt');
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('schema v2 prompt');
  });

  it('rejects hyphenated slash triggers without losing the built-in default', async () => {
    const dir = await tempPromptConfigDir();
    const logger = { warn: vi.fn() };
    await bootstrapPromptConfigDefaults(dir, [defaultReviewFixConfig]);
    await writeFile(
      path.join(dir, 'review_fix.json'),
      `${JSON.stringify({ ...defaultReviewFixConfig, triggers: ['/review-fix'], prompt: 'hyphen trigger prompt' }, null, 2)}\n`,
      'utf8'
    );

    const configs = await loadPromptConfigs({ dir, defaults: [defaultReviewFixConfig], logger });

    expect(configs.get('review_fix')?.prompt).toBe('Default review prompt');
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('hyphen trigger prompt');
  });
});
