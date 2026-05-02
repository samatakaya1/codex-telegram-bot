import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type PackageJson = {
  scripts?: Record<string, string>;
};

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile('package.json', 'utf8')) as PackageJson;
}

describe('package scripts', () => {
  it('runs dev without watch so code edits do not restart the Telegram bot', async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.scripts?.dev).toBe('tsx src/main.ts');
    expect(packageJson.scripts?.dev).not.toContain('watch');
  });

  it('exposes a cross-platform supervisor service script', async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.scripts?.service).toBe('tsx src/supervisor/main.ts');
  });
});
