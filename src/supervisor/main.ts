import { pathToFileURL } from 'node:url';

import { parseConfig } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import {
  createAppServerPlan,
  createBotPlan,
  isRebootExit,
  type BotRunMode,
  type CommandSpec,
  type ProcessExitResult
} from './plan.js';
import { startManagedProcess, type ManagedProcess } from './processes.js';

export type { ManagedProcess } from './processes.js';

type SupervisorOutcome = 'reboot' | 'exit';

type ProcessStarter = (name: string, spec: CommandSpec) => ManagedProcess;

type SupervisorLogger = {
  info?: (payload: unknown, message?: string) => void;
  warn?: (payload: unknown, message?: string) => void;
  error?: (payload: unknown, message?: string) => void;
};

type OwnerNotifier = (text: string) => Promise<void> | void;

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number }>;

const DEFAULT_OWNER_NOTIFICATION_TIMEOUT_MS = 5000;

export type RunSupervisorOnceOptions = {
  codexWsUrl: string;
  botRunMode: BotRunMode;
  start?: ProcessStarter;
  logger?: SupervisorLogger;
  stopSignal?: Promise<void>;
  notifyOwner?: OwnerNotifier;
  ownerNotificationTimeoutMs?: number;
};

export async function runSupervisorOnce(options: RunSupervisorOnceOptions): Promise<SupervisorOutcome> {
  const start = options.start ?? startManagedProcess;
  const appServer = start('app-server', createAppServerPlan(options.codexWsUrl));

  try {
    const botPlans = createBotPlan(options.botRunMode);
    const buildPlans = botPlans.slice(0, -1);
    const botPlan = botPlans[botPlans.length - 1];

    for (const [index, buildPlan] of buildPlans.entries()) {
      const build = start(index === 0 ? 'bot-build' : `bot-build-${index + 1}`, buildPlan);
      const buildResult = await waitForCommandOrAppServerExit(build, appServer, options.stopSignal);
      if (
        buildResult.kind === 'app-server' ||
        buildResult.kind === 'stop' ||
        buildResult.result.code !== 0 ||
        buildResult.result.signal !== null
      ) {
        if (buildResult.kind === 'app-server') {
          await notifyOwnerSafely(
            options,
            `Codex app-server exited unexpectedly during bot startup (code ${formatExitCode(buildResult.result)}). Supervisor stopped startup.`
          );
        } else if (buildResult.kind === 'command') {
          await notifyOwnerSafely(
            options,
            `Telegram bot build exited unexpectedly (code ${formatExitCode(buildResult.result)}). Supervisor stopped Codex app-server.`
          );
        }
        if (buildResult.kind === 'app-server' || buildResult.kind === 'stop') {
          await build.stop();
        }
        return 'exit';
      }
    }

    const bot = start('bot', botPlan);
    const botResult = await waitForCommandOrAppServerExit(bot, appServer, options.stopSignal);
    if (botResult.kind === 'app-server' || botResult.kind === 'stop') {
      if (botResult.kind === 'app-server') {
        await notifyOwnerSafely(
          options,
          `Codex app-server exited unexpectedly (code ${formatExitCode(botResult.result)}). Supervisor stopped the Telegram bot.`
        );
      }
      await bot.stop();
      return 'exit';
    }

    if (isRebootExit(botResult.result)) {
      return 'reboot';
    }

    await notifyOwnerSafely(
      options,
      `Telegram bot process exited unexpectedly (code ${formatExitCode(botResult.result)}). Supervisor stopped Codex app-server.`
    );

    return 'exit';
  } finally {
    await appServer.stop();
  }
}

export async function runSupervisor(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseConfig(env);
  const logger = createLogger(config);
  let stopping = false;
  let requestStop: () => void = () => undefined;
  const stopSignal = new Promise<void>((resolve) => {
    requestStop = resolve;
  });

  const stop = () => {
    stopping = true;
    requestStop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    do {
      logger.info(
        {
          codexWsUrl: config.codexWsUrl,
          botRunMode: config.botRunMode
        },
        'Starting Codex Telegram supervisor'
      );

      const outcome = await runSupervisorOnce({
        codexWsUrl: config.codexWsUrl,
        botRunMode: config.botRunMode,
        logger,
        stopSignal,
        notifyOwner: (text) =>
          sendTelegramOwnerNotice({
            telegramBotToken: config.telegramBotToken,
            telegramOwnerId: config.telegramOwnerId,
            text
          })
      });

      if (outcome !== 'reboot') {
        return;
      }

      logger.info({}, 'Restarting Codex app-server and bot');
    } while (!stopping);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

export async function sendTelegramOwnerNotice(options: {
  telegramBotToken: string;
  telegramOwnerId: number;
  text: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  let response;
  try {
    response = await Promise.race([
      fetchImpl(`https://api.telegram.org/bot${options.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: options.telegramOwnerId,
          text: options.text
        }),
        signal: controller.signal
      }),
      new Promise<{ ok: boolean; status: number }>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Telegram supervisor notice timed out'));
        }, options.timeoutMs ?? DEFAULT_OWNER_NOTIFICATION_TIMEOUT_MS);
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }

  if (!response.ok) {
    throw new Error(`Telegram supervisor notice failed with status ${response.status}`);
  }
}

async function waitForCommandOrAppServerExit(
  command: ManagedProcess,
  appServer: ManagedProcess,
  stopSignal?: Promise<void>
): Promise<
  | { kind: 'command'; result: ProcessExitResult }
  | { kind: 'app-server'; result: ProcessExitResult }
  | { kind: 'stop' }
> {
  const waits: Array<
    Promise<
      | { kind: 'command'; result: ProcessExitResult }
      | { kind: 'app-server'; result: ProcessExitResult }
      | { kind: 'stop' }
    >
  > = [
    command.waitForExit.then((result) => ({ kind: 'command' as const, result })),
    appServer.waitForExit.then((result) => ({ kind: 'app-server' as const, result }))
  ];

  if (stopSignal !== undefined) {
    waits.push(stopSignal.then(() => ({ kind: 'stop' as const })));
  }

  return Promise.race(waits);
}

async function notifyOwnerSafely(options: RunSupervisorOnceOptions, text: string): Promise<void> {
  try {
    await withTimeout(
      Promise.resolve(options.notifyOwner?.(text)),
      options.ownerNotificationTimeoutMs ?? DEFAULT_OWNER_NOTIFICATION_TIMEOUT_MS
    );
  } catch (error) {
    options.logger?.warn?.({ notificationError: sanitizeNotificationError(error) }, 'Supervisor owner notification failed');
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Supervisor owner notification timed out')), timeoutMs);
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function sanitizeNotificationError(error: unknown): Record<string, unknown> {
  return {
    name: error instanceof Error ? error.name : typeof error
  };
}

function formatExitCode(result: ProcessExitResult): string {
  if (result.signal !== null) {
    return `signal ${result.signal}`;
  }

  return String(result.code);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  import('dotenv/config')
    .then(() => runSupervisor())
    .catch((error: unknown) => {
      const logger = createLogger({ logLevel: 'error' });
      logger.error({ error }, 'Codex Telegram supervisor failed');
      process.exitCode = 1;
    });
}

