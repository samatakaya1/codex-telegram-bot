import { pathToFileURL } from 'node:url';

import { parseConfig, type AppConfig } from './config/env.js';
import { CodexAppServerClient } from './codex/appServerClient.js';
import type { ServerRequest } from './codex/protocol.js';
import { CODEX_APPROVAL_REJECTION_MESSAGE, TELEGRAM_APPROVAL_UNAVAILABLE_MESSAGE } from './domain/approvals.js';
import { telegramCommandsForState, type TelegramCommandDefinition } from './telegram/commands.js';
import { createTelegramBot, sanitizeTelegramError } from './telegram/bot.js';
import { STARTUP_NOTIFICATION_MESSAGE, startupNotificationOptions } from './telegram/startup.js';
import { createLogger } from './utils/logger.js';

type StartupNotificationOptions = ReturnType<typeof startupNotificationOptions>;

type RuntimeStartOptions = {
  onStart?: () => Promise<void> | void;
};

type RuntimeBot = {
  api: {
    setMyCommands: (
      commands: readonly TelegramCommandDefinition[],
      other?: { readonly scope?: { readonly type: 'chat'; readonly chat_id: number } }
    ) => Promise<unknown> | unknown;
    sendMessage: (chatId: number, text: string, options?: StartupNotificationOptions) => Promise<unknown> | unknown;
  };
  start: (options?: RuntimeStartOptions) => Promise<void> | void;
  stop: () => Promise<void> | void;
};

type RuntimeCodexClient = {
  connect: () => Promise<void>;
  close: () => void;
};

type RuntimeLogger = {
  info: (payload: unknown, message?: string) => void;
  warn: (payload: unknown, message?: string) => void;
  error: (payload: unknown, message?: string) => void;
};

type ShutdownLogger = Pick<RuntimeLogger, 'info' | 'error'>;

type SignalTarget = {
  once: (signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) => unknown;
  off: (signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) => unknown;
};

type ShutdownDependencies = {
  bot: Pick<RuntimeBot, 'stop'>;
  codex: Pick<RuntimeCodexClient, 'close'>;
  logger: ShutdownLogger;
};

type ApprovalNotificationBot = {
  api: {
    sendMessage: (chatId: number, text: string) => Promise<unknown> | unknown;
  };
};

export type RuntimeShutdown = ((signal: NodeJS.Signals) => Promise<void>) & {
  isRequested: () => boolean;
};

type StartRuntimeDependencies = {
  bot: RuntimeBot;
  codex: RuntimeCodexClient;
  logger: RuntimeLogger;
  shutdown: RuntimeShutdown;
  telegramOwnerId: number;
};

type StartRuntimeResult = 'started' | 'shutdown-requested';

export async function run(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseConfig(env);
  const logger = createLogger(config);
  let bot: ReturnType<typeof createTelegramBot> | null = null;
  const codex = new CodexAppServerClient({
    url: config.codexWsUrl,
    approvalRequestHandler: createApprovalRequestHandler({
      config,
      logger,
      getBot: () => bot
    })
  });
  bot = createTelegramBot({ config, codex, logger });
  const shutdown = createRuntimeShutdown({ bot, codex, logger });
  const removeShutdownHandlers = setupGracefulShutdown({ bot, codex, logger, shutdown });

  logger.info(
    {
      codexWsUrl: config.codexWsUrl,
      projectsRoot: config.projectsRoot
    },
    'Starting Codex Telegram app-server bot'
  );

  try {
    await startRuntime({ bot, codex, logger, shutdown, telegramOwnerId: config.telegramOwnerId });
  } finally {
    removeShutdownHandlers();
    codex.close();
  }
}

export function createApprovalRequestHandler(deps: {
  config: Pick<AppConfig, 'telegramOwnerId'>;
  logger: Pick<RuntimeLogger, 'warn' | 'error'>;
  getBot: () => ApprovalNotificationBot | null;
}): (request: ServerRequest) => Promise<void> {
  return async (request) => {
    deps.logger.warn(
      {
        approvalRequest: {
          method: request.method,
          hasThread: request.threadId !== undefined,
          hasTurn: request.turnId !== undefined
        }
      },
      CODEX_APPROVAL_REJECTION_MESSAGE
    );

    const bot = deps.getBot();
    if (bot === null) {
      deps.logger.error({ telegramError: { name: 'BotNotReady' } }, 'Telegram approval notice failed');
      return;
    }

    try {
      await Promise.resolve(bot.api.sendMessage(deps.config.telegramOwnerId, TELEGRAM_APPROVAL_UNAVAILABLE_MESSAGE));
    } catch (error) {
      deps.logger.error({ telegramError: sanitizeTelegramError(error) }, 'Telegram approval notice failed');
    }
  };
}

export async function startRuntime(deps: StartRuntimeDependencies): Promise<StartRuntimeResult> {
  await connectCodex(deps.codex, deps.logger);
  if (deps.shutdown.isRequested()) {
    return 'shutdown-requested';
  }

  await configureTelegramCommandMenu(deps.bot, deps.logger, deps.telegramOwnerId);
  if (deps.shutdown.isRequested()) {
    return 'shutdown-requested';
  }

  await deps.bot.start({
    onStart: () => scheduleStartupNotification(deps.bot, deps.logger, deps.telegramOwnerId)
  });
  return 'started';
}

function scheduleStartupNotification(bot: RuntimeBot, logger: RuntimeLogger, telegramOwnerId: number): void {
  const notification = setImmediate(() => {
    void sendStartupNotification(bot, logger, telegramOwnerId);
  });
  notification.unref?.();
}

async function sendStartupNotification(bot: RuntimeBot, logger: RuntimeLogger, telegramOwnerId: number): Promise<void> {
  try {
    await Promise.resolve(
      bot.api.sendMessage(telegramOwnerId, STARTUP_NOTIFICATION_MESSAGE, startupNotificationOptions())
    );
  } catch (error) {
    logger.warn({ telegramError: sanitizeTelegramError(error) }, 'Telegram startup notification failed');
  }
}

async function configureTelegramCommandMenu(bot: RuntimeBot, logger: RuntimeLogger, telegramOwnerId: number): Promise<void> {
  const noChatCommands = telegramCommandsForState(false);
  await tryConfigureTelegramCommandMenu(logger, () => bot.api.setMyCommands(noChatCommands));
  await tryConfigureTelegramCommandMenu(logger, () =>
    bot.api.setMyCommands(noChatCommands, {
      scope: { type: 'chat', chat_id: telegramOwnerId }
    })
  );
}

async function tryConfigureTelegramCommandMenu(
  logger: RuntimeLogger,
  action: () => Promise<unknown> | unknown
): Promise<void> {
  try {
    await Promise.resolve(action());
  } catch (error) {
    logger.warn({ telegramError: sanitizeTelegramError(error) }, 'Telegram command menu registration failed');
  }
}

export function createRuntimeShutdown(deps: ShutdownDependencies): RuntimeShutdown {
  let stopping = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;

    deps.logger.info({ signal }, 'Stopping Codex Telegram app-server bot');

    try {
      await Promise.resolve(deps.bot.stop());
    } catch (error) {
      deps.logger.error({ error }, 'Telegram polling stop failed');
    }

    try {
      deps.codex.close();
    } catch (error) {
      deps.logger.error({ error }, 'Codex websocket close failed');
    }
  };

  shutdown.isRequested = () => stopping;
  return shutdown;
}

export function setupGracefulShutdown(
  deps: ShutdownDependencies & { signalTarget?: SignalTarget; shutdown?: RuntimeShutdown }
): () => void {
  const signalTarget = deps.signalTarget ?? process;
  const shutdown = deps.shutdown ?? createRuntimeShutdown(deps);
  const onSignal = (signal: NodeJS.Signals) => {
    void shutdown(signal);
  };

  signalTarget.once('SIGINT', onSignal);
  signalTarget.once('SIGTERM', onSignal);

  return () => {
    signalTarget.off('SIGINT', onSignal);
    signalTarget.off('SIGTERM', onSignal);
  };
}

async function connectCodex(codex: RuntimeCodexClient, logger: RuntimeLogger): Promise<void> {
  try {
    await codex.connect();
    logger.info({}, 'Connected to Codex app-server');
  } catch (error) {
    logger.warn({ error }, 'Codex app-server unavailable; reconnect will continue in the background');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  import('dotenv/config')
    .then(() => run())
    .catch((error: unknown) => {
      const logger = createLogger({ logLevel: 'error' });
      logger.error({ error }, 'Codex Telegram app-server bot failed');
      process.exitCode = 1;
    });
}
