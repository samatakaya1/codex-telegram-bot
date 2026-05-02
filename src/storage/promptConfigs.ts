import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  promptConfigSchema,
  promptConfigValidationIssues,
  type PromptConfig,
  type PromptConfigValidationIssue
} from '../domain/promptConfigs.js';

export type PromptConfigStore = {
  getPromptConfig: (id: string) => Promise<PromptConfig | null>;
};

type PromptConfigLogger = {
  warn?: (payload: unknown, message?: string) => void;
};

type LoadPromptConfigsOptions = {
  dir: string;
  defaults: readonly PromptConfig[];
  logger?: PromptConfigLogger;
};

export function createFilePromptConfigStore(options: LoadPromptConfigsOptions): PromptConfigStore {
  return {
    async getPromptConfig(id: string): Promise<PromptConfig | null> {
      const configs = await loadPromptConfigs(options);
      return configs.get(id) ?? null;
    }
  };
}

export async function bootstrapPromptConfigDefaults(dir: string, defaults: readonly PromptConfig[]): Promise<void> {
  const resolvedDir = path.resolve(dir);
  await mkdir(resolvedDir, { recursive: true });

  for (const config of defaults) {
    const filePath = path.join(resolvedDir, `${config.id}.json`);
    try {
      await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }
}

export async function loadPromptConfigs(options: LoadPromptConfigsOptions): Promise<Map<string, PromptConfig>> {
  await bootstrapPromptConfigDefaults(options.dir, options.defaults);

  const configs = new Map<string, PromptConfig>();
  for (const config of options.defaults) {
    configs.set(config.id, config);
  }

  const resolvedDir = path.resolve(options.dir);
  const entries = await readdir(resolvedDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') {
      continue;
    }

    const filePath = path.join(resolvedDir, entry.name);
    const config = await readPromptConfigFile(filePath, options.logger);
    if (config !== null) {
      configs.set(config.id, config);
    }
  }

  return configs;
}

async function readPromptConfigFile(filePath: string, logger?: PromptConfigLogger): Promise<PromptConfig | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    warnInvalidPromptConfig(logger, filePath, 'Invalid JSON', error);
    return null;
  }

  const result = promptConfigSchema.safeParse(parsed);
  if (!result.success) {
    warnInvalidPromptConfig(logger, filePath, 'Schema validation failed', promptConfigValidationIssues(result.error));
    return null;
  }

  return result.data;
}

function warnInvalidPromptConfig(
  logger: PromptConfigLogger | undefined,
  filePath: string,
  reason: string,
  detail: unknown
): void {
  logger?.warn?.(
    {
      promptConfig: {
        filePath,
        reason,
        detail: sanitizePromptConfigErrorDetail(detail)
      }
    },
    'Prompt config ignored'
  );
}

function sanitizePromptConfigErrorDetail(detail: unknown): unknown {
  if (detail instanceof Error) {
    return { name: detail.name, message: detail.message };
  }

  if (Array.isArray(detail)) {
    return detail.map((issue) => {
      const validationIssue = issue as PromptConfigValidationIssue;
      return { path: validationIssue.path, message: validationIssue.message };
    });
  }

  return undefined;
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST';
}
