import { REBOOT_EXIT_CODE } from '../runtime/reboot.js';

export type BotRunMode = 'DEV' | 'PROD';

export type CommandSpec = {
  command: string;
  args: string[];
};

export type ProcessExitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export function npmCommand(platform: string = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function createAppServerPlan(codexWsUrl: string): CommandSpec {
  return {
    command: 'codex',
    args: ['app-server', '--listen', codexWsUrl]
  };
}

export function createBotPlan(mode: BotRunMode, platform: string = process.platform): CommandSpec[] {
  const npm = npmCommand(platform);
  if (mode === 'PROD') {
    return [
      { command: npm, args: ['run', 'build'] },
      { command: npm, args: ['start'] }
    ];
  }

  return [{ command: npm, args: ['run', 'dev'] }];
}

export function isRebootExit(result: ProcessExitResult): boolean {
  return result.code === REBOOT_EXIT_CODE && result.signal === null;
}

