import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type WarnLogger = {
  warn: (message: string) => void;
};

export type ProjectSummary = {
  name: string;
  path: string;
};

export type WindowsAttributes = {
  hidden: boolean;
  system: boolean;
};

export type ListProjectsOptions = {
  warn?: WarnLogger['warn'];
  readWindowsAttributes?: (candidatePath: string) => Promise<WindowsAttributes>;
  isReparsePoint?: (candidatePath: string) => Promise<boolean>;
  canReadDirectory?: (candidatePath: string) => Promise<boolean>;
  realpath?: (candidatePath: string) => Promise<string>;
};

function normalizeForCompare(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const normalizedParent = normalizeForCompare(path.resolve(parent));
  const normalizedCandidate = normalizeForCompare(path.resolve(candidate));
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function defaultReadWindowsAttributes(candidatePath: string): Promise<WindowsAttributes> {
  const name = path.basename(candidatePath);
  if (process.platform !== 'win32') {
    return {
      hidden: name.startsWith('.'),
      system: false
    };
  }

  try {
    const { stdout } = await execFileAsync('attrib', [candidatePath], { windowsHide: true });
    const pathStart = stdout.search(/[A-Za-z]:[\\/]/);
    const flagPart = pathStart >= 0 ? stdout.slice(0, pathStart) : stdout.split(/\r?\n/)[0] ?? '';
    const flags = flagPart.replace(/\s+/g, '').toUpperCase();
    return {
      hidden: name.startsWith('.') || flags.includes('H'),
      system: flags.includes('S')
    };
  } catch {
    return {
      hidden: name.startsWith('.'),
      system: false
    };
  }
}

async function defaultIsReparsePoint(candidatePath: string): Promise<boolean> {
  const stats = await lstat(candidatePath);
  if (stats.isSymbolicLink()) {
    return true;
  }

  if (process.platform !== 'win32') {
    return false;
  }

  const script = [
    '$item = Get-Item -LiteralPath $env:CODEX_PROJECT_PATH -Force',
    'if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { "true" } else { "false" }'
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: { ...process.env, CODEX_PROJECT_PATH: candidatePath },
      windowsHide: true
    }
  );

  return stdout.trim().toLowerCase() === 'true';
}

async function defaultCanReadDirectory(candidatePath: string): Promise<boolean> {
  try {
    await readdir(candidatePath);
    return true;
  } catch {
    return false;
  }
}

const projectNameCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export async function listProjects(root: string, options: ListProjectsOptions = {}): Promise<ProjectSummary[]> {
  const warn = options.warn;
  const readAttributes = options.readWindowsAttributes ?? defaultReadWindowsAttributes;
  const isReparsePoint = options.isReparsePoint ?? defaultIsReparsePoint;
  const canReadDirectory = options.canReadDirectory ?? defaultCanReadDirectory;
  const resolveRealpath = options.realpath ?? realpath;

  let rootRealPath: string;
  try {
    rootRealPath = await resolveRealpath(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn?.(`Could not read projects root ${root}: ${message}`);
    return [];
  }

  let entries;
  try {
    entries = await readdir(rootRealPath, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn?.(`Could not list projects root ${rootRealPath}: ${message}`);
    return [];
  }

  const projects: ProjectSummary[] = [];
  for (const entry of entries) {
    const candidatePath = path.join(rootRealPath, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }

    try {
      const attributes = await readAttributes(candidatePath);
      if (entry.name.startsWith('.') || attributes.hidden || attributes.system) {
        continue;
      }

      if (await isReparsePoint(candidatePath)) {
        continue;
      }

      const candidateRealPath = await resolveRealpath(candidatePath);
      if (!isInsideOrEqual(rootRealPath, candidateRealPath)) {
        continue;
      }

      if (!(await canReadDirectory(candidateRealPath))) {
        warn?.(`Skipping unreadable project directory ${candidateRealPath}`);
        continue;
      }

      projects.push({
        name: entry.name,
        path: candidateRealPath
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn?.(`Skipping project directory ${candidatePath}: ${message}`);
    }
  }

  projects.sort((left, right) => projectNameCollator.compare(left.name, right.name));
  return projects;
}
