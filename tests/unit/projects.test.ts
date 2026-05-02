import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { listProjects } from '../../src/domain/projects.js';

describe('listProjects', () => {
  async function makeRoot() {
    return mkdtemp(path.join(os.tmpdir(), 'codex-projects-'));
  }

  it('returns canonical immediate child directories sorted by name, including spaces', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'Project B'));
    await mkdir(path.join(root, 'Project A'));
    await mkdir(path.join(root, 'With spaces'));
    await writeFile(path.join(root, 'not-a-directory.txt'), '', 'utf8');

    const projects = await listProjects(root);

    expect(projects.map((project) => project.name)).toEqual(['Project A', 'Project B', 'With spaces']);
    expect(projects.every((project) => path.isAbsolute(project.path))).toBe(true);
  });

  it('rejects hidden, system, reparse, and root-escaping directories', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'Visible'));
    await mkdir(path.join(root, '.hidden'));
    await mkdir(path.join(root, 'SystemDir'));
    await mkdir(path.join(root, 'Junction'));
    await mkdir(path.join(root, 'Escapes'));

    const projects = await listProjects(root, {
      readWindowsAttributes: async (candidatePath) => ({
        hidden: path.basename(candidatePath) === '.hidden',
        system: path.basename(candidatePath) === 'SystemDir'
      }),
      isReparsePoint: async (candidatePath) => path.basename(candidatePath) === 'Junction',
      realpath: async (candidatePath) =>
        path.basename(candidatePath) === 'Escapes' ? path.resolve(root, '..', 'outside') : candidatePath
    });

    expect(projects.map((project) => project.name)).toEqual(['Visible']);
  });

  it('rejects a real filesystem symlink or junction when the platform permits creating one', async () => {
    const root = await makeRoot();
    const target = path.join(root, 'Target');
    const link = path.join(root, 'Link');
    await mkdir(target);

    try {
      await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const projects = await listProjects(root);

    expect(projects.map((project) => project.name)).toEqual(['Target']);
  });

  it('skips unreadable project directories with a warning', async () => {
    const warn = vi.fn();
    const root = await makeRoot();
    await mkdir(path.join(root, 'Allowed'));
    await mkdir(path.join(root, 'Denied'));

    const projects = await listProjects(root, {
      warn,
      canReadDirectory: async (candidatePath) => path.basename(candidatePath) !== 'Denied'
    });

    expect(projects.map((project) => project.name)).toEqual(['Allowed']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Denied'));
  });

  it('uses actual directory listing to prove default read access', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'Allowed'));

    const projects = await listProjects(root, {
      readWindowsAttributes: async () => ({ hidden: false, system: false }),
      isReparsePoint: async () => false
    });

    expect(projects.map((project) => project.name)).toEqual(['Allowed']);
  });
});
