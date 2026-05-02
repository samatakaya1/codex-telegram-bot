import { spawn, type ChildProcess } from 'node:child_process';

import type { CommandSpec, ProcessExitResult } from './plan.js';

const FORCE_KILL_TIMEOUT_MS = 5000;

export type ManagedProcess = {
  waitForExit: Promise<ProcessExitResult>;
  stop: () => Promise<void>;
};

export function startManagedProcess(name: string, spec: CommandSpec): ManagedProcess {
  let child: ChildProcess;
  try {
    const invocation = createSpawnInvocation(spec);
    child = spawn(invocation.command, invocation.args, {
      stdio: 'inherit',
      windowsHide: true,
      env: process.env
    });
  } catch {
    return {
      waitForExit: Promise.resolve({ code: 1, signal: null }),
      stop: async () => undefined
    };
  }

  const waitForExit = new Promise<ProcessExitResult>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
    child.once('error', () => {
      resolve({ code: 1, signal: null });
    });
  });

  return {
    waitForExit,
    stop: () => stopChildProcess(child, name)
  };
}

export function createSpawnInvocation(
  spec: CommandSpec,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env
): CommandSpec {
  if (platform !== 'win32') {
    return spec;
  }

  return {
    command: env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', spec.command, ...spec.args]
  };
}

export function createForceKillPlan(pid: number, platform: string = process.platform): CommandSpec | null {
  if (platform !== 'win32') {
    return null;
  }

  return {
    command: 'taskkill.exe',
    args: ['/PID', String(pid), '/T', '/F']
  };
}

export async function forceKillProcess(pid: number, platform: string = process.platform): Promise<void> {
  const forceKillPlan = createForceKillPlan(pid, platform);
  if (forceKillPlan !== null) {
    const invocation = createSpawnInvocation(forceKillPlan, platform);
    const forceKill = spawn(invocation.command, invocation.args, {
      stdio: 'ignore',
      windowsHide: true
    });
    await waitForExitOrError(forceKill);
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process may have exited between the timeout and the force-kill attempt.
  }
}

export async function stopChildProcess(
  child: ChildProcess,
  _name = 'process',
  forceKill: (pid: number) => Promise<void> = forceKillProcess
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (!settled) {
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        resolve();
      }
    };

    child.once('exit', settle);
    if (process.platform === 'win32' && child.pid !== undefined) {
      void forceKill(child.pid).then(settle, settle);
      timeout = setTimeout(settle, FORCE_KILL_TIMEOUT_MS);
      timeout.unref?.();
      return;
    }

    child.kill();
    timeout = setTimeout(() => {
      if (child.pid !== undefined) {
        void forceKill(child.pid).finally(settle);
        return;
      }
      settle();
    }, FORCE_KILL_TIMEOUT_MS);
    timeout.unref?.();
  });
}

function waitForExitOrError(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
}
