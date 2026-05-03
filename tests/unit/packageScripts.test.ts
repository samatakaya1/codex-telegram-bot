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

  it('exposes local voice setup scripts without adding a second service entrypoint', async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.scripts?.['voice:doctor']).toBe('powershell -ExecutionPolicy Bypass -File scripts/voice/doctor.ps1');
    expect(packageJson.scripts?.['voice:setup']).toBe('powershell -ExecutionPolicy Bypass -File scripts/voice/setup.ps1');
    expect(packageJson.scripts?.['voice:model:download']).toBe(
      'powershell -ExecutionPolicy Bypass -File scripts/voice/download-model.ps1'
    );
    expect(packageJson.scripts?.['voice:smoke']).toBe('powershell -ExecutionPolicy Bypass -File scripts/voice/smoke.ps1');
    expect(packageJson.scripts).not.toHaveProperty('service:voice');
  });
});
