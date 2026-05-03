import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig, VoiceTranscriptionConfig } from '../config/env.js';
import type { AgentMessageDeltaNotification, CodexThread, JsonValue, TurnCompletedNotification } from '../codex/protocol.js';
import { TELEGRAM_APPROVAL_UNAVAILABLE_MESSAGE } from '../domain/approvals.js';
import { splitTelegramText } from '../domain/messages.js';
import type { PromptConfig } from '../domain/promptConfigs.js';
import type { ProjectSummary } from '../domain/projects.js';
import { formatRateLimits } from '../domain/rateLimits.js';
import { ActiveTurnStore } from '../domain/turns.js';
import { isVoiceCallbackData, VoiceTurnStore } from '../domain/voiceTurns.js';
import { DEFAULT_PROMPT_CONFIGS } from '../promptConfigs/defaults.js';
import {
  readCodexSessionModelInfo,
  readCodexSessionTokenUsage,
  type CodexSessionModelInfo,
  type CodexSessionTokenUsage
} from '../storage/codexSession.js';
import type { PromptConfigStore } from '../storage/promptConfigs.js';
import { checkTelegramAccess } from './access.js';
import { CallbackDataStore } from './callbackData.js';
import { helpTextForState } from './commands.js';
import { SELECT_PROJECT_STARTUP_CALLBACK_DATA } from './startup.js';

export type TelegramHandlerContext = {
  fromId?: number;
  chatId?: number;
  chatType?: string;
  text?: string;
  voice?: TelegramVoiceMessage;
  callbackData?: string;
  reply: (text: string, options?: unknown) => Promise<void>;
  answerCallbackQuery?: (text?: string) => Promise<void> | void;
  confirmUpdate?: () => Promise<void> | void;
};

export type TelegramVoiceMessage = {
  fileId: string;
  fileUniqueId?: string;
  durationSeconds: number;
  mimeType?: string;
  fileSizeBytes?: number;
};

type InlineKeyboardOption = {
  reply_markup: {
    inline_keyboard: Array<Array<InlineKeyboardButtonOption>>;
  };
};

type InlineKeyboardButtonOption =
  | { text: string; callback_data: string }
  | { text: string; copy_text: { text: string } };

type ConnectionStatusChangedEvent = {
  previousStatus: string;
  status: string;
  reason?: string;
};

export type TelegramHandlersDependencies = {
  config: AppConfig;
  codex: {
    connectionStatus: string;
    listThreads: () => Promise<CodexThread[]>;
    resumeThread: (threadId: string) => Promise<CodexThread>;
    startThread: (params: { cwd?: string }) => Promise<CodexThread>;
    archiveThread?: (threadId: string) => Promise<void>;
    startTurn: (params: { threadId: string; text: string }) => Promise<{ turnId: string }>;
    readRateLimits?: () => Promise<JsonValue>;
    getRateLimits?: () => JsonValue | null;
    onAgentMessageDelta?: (listener: (event: AgentMessageDeltaNotification) => void) => () => void;
    onTurnCompleted?: (listener: (event: TurnCompletedNotification) => void) => () => void;
    onConnectionStatusChanged?: (listener: (event: ConnectionStatusChangedEvent) => void) => () => void;
  };
  readProjectlessThreadIds: (path: string) => Promise<Set<string>>;
  listProjects: (root: string) => Promise<ProjectSummary[]>;
  callbackData?: CallbackDataStore;
  promptConfigs?: PromptConfigStore;
  voiceTurns?: VoiceTurnStore;
  downloadVoiceFile?: (params: { fileId: string; declaredSizeBytes?: number }) => Promise<{ path: string; sizeBytes: number }>;
  deleteVoiceFile?: (path: string) => Promise<void>;
  transcribeVoice?: (audioPath: string) => Promise<{ text: string; language?: string; durationSeconds?: number }>;
  logger?: {
    warn?: (payload: unknown, message?: string) => void;
  };
  connectionLossGraceMs?: number;
  deliveryRetryAttempts?: number;
  deliveryRetryDelayMs?: number;
  onDeliveryError?: (error: Error) => void;
  onRebootRequested?: () => Promise<void> | void;
  updateCommandMenu?: (chatId: number, hasSelectedChat: boolean) => Promise<void> | void;
};

export type TelegramHandlers = ReturnType<typeof createTelegramHandlers>;

const MAX_LIST_ITEMS = 20;
const MAX_LABEL_LENGTH = 80;
const DEFAULT_CONNECTION_LOSS_GRACE_MS = 5000;
const DEFAULT_DELIVERY_RETRY_ATTEMPTS = 2;
const DEFAULT_DELIVERY_RETRY_DELAY_MS = 250;
const CODEX_CONNECTION_LOST_MESSAGE =
  'Codex app-server disconnected while processing this request. I will not resend it automatically. Check /status and retry if needed.';
const VOICE_DISABLED_MESSAGE = 'Voice transcription is disabled. Enable VOICE_TRANSCRIPTION_ENABLED and run local voice setup first.';
const VOICE_UNAVAILABLE_MESSAGE = 'Voice transcription is not configured. Run npm run voice:doctor and check local voice setup.';
const VOICE_BUSY_MESSAGE = 'A Codex turn or voice prompt is already running for this chat. Wait for it to finish.';
const VOICE_TRANSCRIPTION_FAILED_MESSAGE = 'Could not transcribe this voice message. Check local voice setup and try again.';
const VOICE_EMPTY_MESSAGE = 'Voice transcription was empty. Please try again.';
const VOICE_TOO_LARGE_MESSAGE = 'Voice message is too large for local transcription.';
const VOICE_TOO_LONG_MESSAGE = 'Voice message is too long for local transcription.';
const VOICE_TRANSCRIPTION_TTL_BUFFER_MS = 30 * 1000;
const TELEGRAM_COPY_TEXT_MAX_CHARS = 256;
const SUMMARY_CHAT_PROMPT =
  [
    'Provide a concise status summary of this current chat for Telegram.',
    'Answer in the language previously used in this chat; if there are no previous messages, default to English.',
    'If this is a new chat with no prior context, say that there is no context because this is a new chat.',
    'Include the current goal, completed work, current state, blockers if any, and recommended next steps.',
    'Keep it brief and factual.'
  ].join(' ');
const SUMMARY_CHAT_WORKING_MESSAGE = 'Codex is preparing chat summary...';
const REVIEW_FIX_CONFIG_ID = 'review_fix';
const COMMIT_CONFIG_ID = 'commit';
const CREATE_PROJECT_CHAT_BUTTON = 'Создать новый чат';
const SELECT_PROJECT_CHAT_BUTTON = 'Выбрать чат';
const PROJECT_UNAVAILABLE_MESSAGE = 'This project is no longer available. Run /select_project again.';

type PromptBackedCommandOptions = {
  configId: string;
  command: string;
  configFileName: string;
};

type SelectedChat = {
  threadId: string;
  title?: string;
  modelInfo?: CodexSessionModelInfo;
  modelInfoSource?: 'thread' | 'session';
  modelInfoSessionMtimeMs?: number;
  modelInfoSessionSize?: number;
  tokenUsage?: CodexSessionTokenUsage;
  tokenUsageSessionMtimeMs?: number;
  tokenUsageSessionSize?: number;
  sessionPath?: string;
  projectPath?: string;
};

type PendingTurnContext = {
  threadId: string;
  telegramChatId: number;
  selectedThreadId: string;
  reply: (text: string, options?: unknown) => Promise<void>;
  bufferedDeltas: AgentMessageDeltaNotification[];
  bufferedCompletions: TurnCompletedNotification[];
};

export function createTelegramHandlers(deps: TelegramHandlersDependencies) {
  const callbackData = deps.callbackData ?? new CallbackDataStore();
  const promptConfigs =
    deps.promptConfigs ??
    ({
      async getPromptConfig(id: string) {
        return DEFAULT_PROMPT_CONFIGS.find((config) => config.id === id) ?? null;
      }
    } satisfies PromptConfigStore);
  const selectedChats = new Map<number, SelectedChat>();
  const selectedProjects = new Map<number, string>();
  const activeTurns = new ActiveTurnStore();
  const voiceTurns =
    deps.voiceTurns ??
    new VoiceTurnStore({
      transcriptionTtlMs: voiceTranscriptionTtlMs(deps.config.voiceTranscription)
    });
  const pendingTurnThreadIds = new Set<string>();
  const pendingTurnContexts = new Map<string, PendingTurnContext>();
  const connectionLossTimers = new Map<string, ReturnType<typeof setTimeout>>();

  deps.codex.onAgentMessageDelta?.((event) => {
    if (activeTurns.appendAgentDelta(event) !== null) {
      return;
    }

    const pending = pendingTurnContexts.get(event.threadId);
    if (pending !== undefined) {
      pending.bufferedDeltas.push(event);
    }
  });

  deps.codex.onTurnCompleted?.((event) => {
    void handleTurnCompleted(event).catch((error: unknown) => reportDeliveryError(error));
  });

  deps.codex.onConnectionStatusChanged?.((event) => {
    handleConnectionStatusChanged(event);
  });

  async function requireAccess(ctx: TelegramHandlerContext): Promise<boolean> {
    const access = checkTelegramAccess({
      ownerId: deps.config.telegramOwnerId,
      fromId: ctx.fromId,
      chatId: ctx.chatId,
      chatType: ctx.chatType
    });

    if (!access.ok) {
      await safeReply(ctx, access.message);
      return false;
    }

    return true;
  }

  function ownerChatKey(ctx: TelegramHandlerContext): number {
    return ctx.chatId ?? deps.config.telegramOwnerId;
  }

  function selectedProjectPath(chatId: number): string | undefined {
    return selectedProjects.get(chatId) ?? selectedChats.get(chatId)?.projectPath;
  }

  function hasSelectedProject(ctx: TelegramHandlerContext): boolean {
    return selectedProjectPath(ownerChatKey(ctx)) !== undefined;
  }

  function stateAwareHelpText(ctx: TelegramHandlerContext): string {
    return helpTextForState(hasSelectedProject(ctx));
  }

  function noChatSelectedMessage(chatId: number): string {
    return selectedProjectPath(chatId) === undefined
      ? 'No chat selected. Use /select_project first, then /select_chat.'
      : 'No chat selected. Use /new_chat to create one or /select_chat to choose an existing chat.';
  }

  function isThreadUnavailable(threadId: string): boolean {
    return pendingTurnThreadIds.has(threadId) || activeTurns.isThreadBusy(threadId) || voiceTurns.isThreadBlocked(threadId);
  }

  async function updateCommandMenu(chatId: number, hasChat: boolean): Promise<void> {
    try {
      await Promise.resolve(deps.updateCommandMenu?.(chatId, hasChat));
    } catch (error) {
      reportDeliveryError(error);
    }
  }

  function projectActionKeyboard(projectPath: string): InlineKeyboardOption {
    return keyboard([
      [{ text: CREATE_PROJECT_CHAT_BUTTON, callback_data: callbackData.createProjectNewChat(projectPath) }],
      [{ text: SELECT_PROJECT_CHAT_BUTTON, callback_data: callbackData.createProjectSelectChat(projectPath) }]
    ]);
  }

  async function handleStart(ctx: TelegramHandlerContext): Promise<void> {
    if (await requireAccess(ctx)) {
      await safeReply(ctx, `Codex Telegram bridge ready.\n${stateAwareHelpText(ctx)}`);
    }
  }

  async function handleHelp(ctx: TelegramHandlerContext): Promise<void> {
    if (await requireAccess(ctx)) {
      await safeReply(ctx, stateAwareHelpText(ctx));
    }
  }

  async function handleStatus(ctx: TelegramHandlerContext): Promise<void> {
    if (await requireAccess(ctx)) {
      await safeReply(ctx, `Codex: ${deps.codex.connectionStatus}\nURL: ${deps.config.codexWsUrl}`);
    }
  }

  async function handleLimits(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    try {
      const snapshot = await deps.codex.readRateLimits?.();
      if (snapshot !== undefined) {
        await safeReply(ctx, formatRateLimits(snapshot));
        return;
      }
    } catch {
      const cached = deps.codex.getRateLimits?.() ?? null;
      if (cached !== null) {
        await safeReply(ctx, `${formatRateLimits(cached)}\nLast cached limit update; live read failed.`);
        return;
      }
      await safeReply(ctx, 'Could not load Codex limits. Try again after Codex reconnects.');
      return;
    }

    const cached = deps.codex.getRateLimits?.() ?? null;
    await safeReply(ctx, cached === null ? 'No Codex limit data is available yet.' : formatRateLimits(cached));
  }

  async function handleProjectChats(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    const projectPath = selectedProjectPath(ownerChatKey(ctx));
    if (projectPath === undefined) {
      await safeReply(ctx, 'No project selected. Use /select_project first, then /select_chat.');
      return;
    }

    try {
      const safeProject = await findSafeProject(projectPath);
      if (safeProject === undefined) {
        await safeReply(ctx, PROJECT_UNAVAILABLE_MESSAGE);
        return;
      }

      await replyProjectChats(ctx, safeProject.path);
    } catch {
      await safeReply(ctx, 'Could not load project chats. Check Codex app-server and try again.');
    }
  }

  async function handleSelectProject(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    try {
      const projects = await deps.listProjects(deps.config.projectsRoot);
      if (projects.length === 0) {
        await safeReply(ctx, 'No safe projects found.');
        return;
      }

      const visible = projects.slice(0, MAX_LIST_ITEMS);
      const rows = visible.map((project) => [
        { text: truncateLabel(project.name), callback_data: callbackData.createSelectProject(project.path) }
      ]);
      const names = visible.map((project, index) => `${index + 1}. ${truncateLabel(project.name)}`);
      await safeReply(ctx, `Projects:\n${names.join('\n')}`, keyboard(rows));
    } catch {
      await safeReply(ctx, 'Could not load projects. Check the configured projects root and try again.');
    }
  }

  async function handleNewChat(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    const projectPath = selectedProjectPath(ownerChatKey(ctx));
    if (projectPath === undefined) {
      await safeReply(ctx, 'No project selected. Use /select_project first.');
      return;
    }

    try {
      const safeProject = await findSafeProject(projectPath);
      if (safeProject === undefined) {
        await safeReply(ctx, PROJECT_UNAVAILABLE_MESSAGE);
        return;
      }

      await createNewChatInProject(ctx, safeProject.path);
    } catch {
      await safeReply(ctx, 'Could not create a new chat for the selected project.');
    }
  }

  async function handleDeleteChat(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    const chatId = ownerChatKey(ctx);
    const projectPath = selectedProjectPath(chatId);
    if (projectPath === undefined) {
      await safeReply(ctx, 'No project selected. Use /select_project first.');
      return;
    }

    try {
      const safeProject = await findSafeProject(projectPath);
      if (safeProject === undefined) {
        await safeReply(ctx, PROJECT_UNAVAILABLE_MESSAGE);
        return;
      }

      const projectThreads = await listProjectThreads(safeProject.path);

      if (projectThreads.length === 0) {
        await safeReply(ctx, 'No chats for this project found. Use /new_chat to create one.');
        return;
      }

      const rows = projectThreads.slice(0, MAX_LIST_ITEMS).map((thread) => {
        const title = displayTitleFromThread(thread) ?? 'Untitled chat';
        return [{ text: title, callback_data: callbackData.createDeleteChat(thread.id, safeProject.path) }];
      });
      const titles = projectThreads.slice(0, MAX_LIST_ITEMS).map((thread, index) => {
        return `${index + 1}. ${displayTitleFromThread(thread) ?? 'Untitled chat'}`;
      });

      await safeReply(ctx, `Project chats to delete:\n${titles.join('\n')}`, keyboard(rows));
    } catch {
      await safeReply(ctx, 'Could not load project chats. Check Codex app-server and try again.');
    }
  }

  async function listProjectThreads(projectPath: string): Promise<CodexThread[]> {
    const threads = await deps.codex.listThreads();
    const selectedProject = normalizePathForIdentity(projectPath);
    return threads.filter((thread) => {
      const threadProjectPath = projectPathFromThread(thread);
      return threadProjectPath !== undefined && normalizePathForIdentity(threadProjectPath) === selectedProject;
    });
  }

  function callbackMatchesSelectedProject(chatId: number, callbackProjectPath: string): boolean {
    const projectPath = selectedProjectPath(chatId);
    return projectPath !== undefined && normalizePathForIdentity(projectPath) === normalizePathForIdentity(callbackProjectPath);
  }

  async function handleCurrent(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    const selected = selectedChats.get(ownerChatKey(ctx));
    if (selected === undefined) {
      await safeReply(ctx, noChatSelectedMessage(ownerChatKey(ctx)));
      return;
    }

    const refreshed = await refreshSelectedChat(ownerChatKey(ctx), selected);
    await safeReply(ctx, formatCurrentChat(refreshed));
  }

  async function handleSummaryChat(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    const selected = selectedChats.get(ownerChatKey(ctx));
    if (selected === undefined) {
      await safeReply(ctx, noChatSelectedMessage(ownerChatKey(ctx)));
      return;
    }

    if (isThreadUnavailable(selected.threadId)) {
      await safeReply(ctx, 'A Codex turn is already running for this chat. Wait for it to finish before requesting /summary_chat.');
      return;
    }

    await startCodexTurn(ctx, selected, SUMMARY_CHAT_PROMPT, SUMMARY_CHAT_WORKING_MESSAGE);
  }

  async function handleReviewFix(ctx: TelegramHandlerContext): Promise<void> {
    await handlePromptBackedCommand(ctx, {
      configId: REVIEW_FIX_CONFIG_ID,
      command: '/review_fix',
      configFileName: 'review_fix.json'
    });
  }

  async function handleCommit(ctx: TelegramHandlerContext): Promise<void> {
    await handlePromptBackedCommand(ctx, {
      configId: COMMIT_CONFIG_ID,
      command: '/commit',
      configFileName: 'commit.json'
    });
  }

  async function handlePromptBackedCommand(
    ctx: TelegramHandlerContext,
    options: PromptBackedCommandOptions
  ): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    const chatId = ownerChatKey(ctx);
    const selected = selectedChats.get(chatId);
    if (selected === undefined) {
      await safeReply(ctx, noChatSelectedMessage(chatId));
      return;
    }

    if (selectedProjectPath(chatId) === undefined) {
      await safeReply(ctx, 'No project selected. Use /select_project first.');
      return;
    }

    if (isThreadUnavailable(selected.threadId)) {
      await safeReply(
        ctx,
        `A Codex turn is already running for this chat. Wait for it to finish before requesting ${options.command}.`
      );
      return;
    }

    const pending = reservePendingTurn(ctx, selected);
    if (pending === null) {
      await safeReply(
        ctx,
        `A Codex turn is already running for this chat. Wait for it to finish before requesting ${options.command}.`
      );
      return;
    }

    let config: PromptConfig | null;
    try {
      config = await promptConfigs.getPromptConfig(options.configId);
    } catch {
      if (releasePendingTurn(selected.threadId, pending)) {
        await safeReply(
          ctx,
          `Could not load ${options.command} prompt config. Check prompt-configs/${options.configFileName} and try again.`
        );
      }
      return;
    }

    if (config === null || !config.enabled) {
      if (releasePendingTurn(selected.threadId, pending)) {
        await safeReply(
          ctx,
          `${options.command} prompt config is unavailable. Check prompt-configs/${options.configFileName} and try again.`
        );
      }
      return;
    }

    await startReservedCodexTurn(ctx, selected, pending, config.prompt, config.workingMessage);
  }

  async function handleCallback(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    if (isVoiceCallbackData(ctx.callbackData)) {
      await handleVoiceConfirmationCallback(ctx);
      return;
    }

    if (ctx.callbackData?.startsWith('a:') === true) {
      await answerCallback(ctx, 'Approval unavailable');
      await safeReply(ctx, TELEGRAM_APPROVAL_UNAVAILABLE_MESSAGE);
      return;
    }

    if (ctx.callbackData === SELECT_PROJECT_STARTUP_CALLBACK_DATA) {
      await answerCallback(ctx, 'Select project');
      await handleSelectProject(ctx);
      return;
    }

    const selectedThreadId = callbackData.resolveSelectChat(ctx.callbackData);
    if (selectedThreadId !== null) {
      await handleSelectChatCallback(ctx, selectedThreadId);
      return;
    }

    const deleteChat = callbackData.resolveDeleteChat(ctx.callbackData);
    if (deleteChat !== null) {
      await handleDeleteChatCallback(ctx, deleteChat.threadId, deleteChat.projectPath);
      return;
    }

    const deleteConfirm = callbackData.resolveDeleteChatConfirm(ctx.callbackData);
    if (deleteConfirm !== null) {
      await handleDeleteChatConfirmCallback(ctx, deleteConfirm);
      return;
    }

    const projectNewChatPath = callbackData.resolveProjectNewChat(ctx.callbackData);
    if (projectNewChatPath !== null) {
      await handleProjectNewChatCallback(ctx, projectNewChatPath);
      return;
    }

    const projectSelectChatPath = callbackData.resolveProjectSelectChat(ctx.callbackData);
    if (projectSelectChatPath !== null) {
      await handleProjectSelectChatCallback(ctx, projectSelectChatPath);
      return;
    }

    const projectPath = callbackData.resolveSelectProject(ctx.callbackData);
    if (projectPath !== null) {
      await handleSelectProjectCallback(ctx, projectPath);
      return;
    }

    await safeReply(ctx, 'This button expired. Run the command again.');
  }

  async function handleVoice(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    if (!deps.config.voiceTranscription.enabled) {
      await safeReply(ctx, VOICE_DISABLED_MESSAGE);
      return;
    }

    if (deps.downloadVoiceFile === undefined || deps.transcribeVoice === undefined) {
      await safeReply(ctx, VOICE_UNAVAILABLE_MESSAGE);
      return;
    }

    const selected = selectedChats.get(ownerChatKey(ctx));
    if (selected === undefined) {
      await safeReply(ctx, noChatSelectedMessage(ownerChatKey(ctx)));
      return;
    }

    if (isThreadUnavailable(selected.threadId)) {
      await safeReply(ctx, VOICE_BUSY_MESSAGE);
      return;
    }

    const voice = ctx.voice;
    if (voice === undefined) {
      await safeReply(ctx, 'No voice message found.');
      return;
    }

    const maxFileBytes = deps.config.voiceTranscription.maxFileMb * 1024 * 1024;
    if (voice.fileSizeBytes !== undefined && voice.fileSizeBytes > maxFileBytes) {
      await safeReply(ctx, VOICE_TOO_LARGE_MESSAGE);
      return;
    }

    if (voice.durationSeconds > deps.config.voiceTranscription.maxDurationSeconds) {
      await safeReply(ctx, VOICE_TOO_LONG_MESSAGE);
      return;
    }

    const transcription = voiceTurns.beginTranscription({ threadId: selected.threadId, telegramChatId: ownerChatKey(ctx) });
    if (transcription === null) {
      await safeReply(ctx, VOICE_BUSY_MESSAGE);
      return;
    }

    let downloadedPath: string | undefined;
    let downloadedSizeBytes: number | undefined;
    try {
      const downloaded = await deps.downloadVoiceFile({
        fileId: voice.fileId,
        declaredSizeBytes: voice.fileSizeBytes
      });
      downloadedPath = downloaded.path;
      downloadedSizeBytes = downloaded.sizeBytes;
      const transcript = await deps.transcribeVoice(downloaded.path);
      if (
        transcript.durationSeconds !== undefined &&
        transcript.durationSeconds > deps.config.voiceTranscription.maxDurationSeconds
      ) {
        if (!voiceTurns.clearTranscription(selected.threadId, transcription.id)) {
          return;
        }
        await safeReply(ctx, VOICE_TOO_LONG_MESSAGE);
        return;
      }

      const text = transcript.text.trim();
      if (text.length === 0) {
        if (!voiceTurns.clearTranscription(selected.threadId, transcription.id)) {
          return;
        }
        await safeReply(ctx, VOICE_EMPTY_MESSAGE);
        return;
      }

      if (text.length > deps.config.voiceTranscription.maxTextChars) {
        if (!voiceTurns.clearTranscription(selected.threadId, transcription.id)) {
          return;
        }
        await safeReply(ctx, 'Voice transcript is too long to send to Codex.');
        return;
      }

      const confirmation = voiceTurns.awaitConfirmation({
        threadId: selected.threadId,
        telegramChatId: ownerChatKey(ctx),
        transcript: text,
        transcriptionId: transcription.id
      });
      if (confirmation === null) {
        return;
      }
      const previewSent = await tryReply(ctx, formatVoiceConfirmationPreview(text, deps.config.voiceTranscription), keyboard([
        [{ text: 'Send to Codex', callback_data: confirmation.sendCallbackData }],
        [voiceCopyButton(text)],
        [{ text: 'Cancel', callback_data: confirmation.cancelCallbackData }]
      ]));
      if (!previewSent) {
        voiceTurns.clearConfirmation(selected.threadId, confirmation.id);
      }
    } catch (error) {
      if (!voiceTurns.clearTranscription(selected.threadId, transcription.id)) {
        return;
      }
      deps.logger?.warn?.(
        {
          voiceTranscriptionError: sanitizeVoiceTranscriptionError(error),
          voiceAudio: {
            hasDownloadedFile: downloadedPath !== undefined,
            sizeBytes: downloadedSizeBytes,
            kind: downloadedPath === undefined ? undefined : await readVoiceAudioKind(downloadedPath)
          }
        },
        'Voice transcription failed'
      );
      await safeReply(ctx, voiceTranscriptionFailureMessage(error));
    } finally {
      if (downloadedPath !== undefined) {
        await deleteVoiceFile(downloadedPath);
      }
    }
  }

  async function handleVoiceConfirmationCallback(ctx: TelegramHandlerContext): Promise<void> {
    const consumed = voiceTurns.consume(ctx.callbackData);
    if (consumed === null) {
      await answerCallback(ctx, 'Expired');
      await safeReply(ctx, 'This voice prompt expired. Send the voice message again.');
      return;
    }

    if (consumed.telegramChatId !== ownerChatKey(ctx)) {
      await answerCallback(ctx, 'Expired');
      await safeReply(ctx, 'This voice prompt no longer matches this chat.');
      return;
    }

    if (consumed.action === 'cancel') {
      await answerCallback(ctx, 'Cancelled');
      await safeReply(ctx, 'Voice prompt cancelled.');
      return;
    }

    const selected = selectedChats.get(ownerChatKey(ctx));
    if (selected === undefined || selected.threadId !== consumed.threadId) {
      await answerCallback(ctx, 'Expired');
      await safeReply(ctx, 'This voice prompt no longer matches the selected chat.');
      return;
    }

    if (isThreadUnavailable(consumed.threadId)) {
      await answerCallback(ctx, 'Busy');
      await safeReply(ctx, VOICE_BUSY_MESSAGE);
      return;
    }

    const pending = reservePendingTurn(ctx, selected);
    if (pending === null) {
      await answerCallback(ctx, 'Busy');
      await safeReply(ctx, VOICE_BUSY_MESSAGE);
      return;
    }

    try {
      await answerCallback(ctx, 'Sending');
    } catch (error) {
      reportDeliveryError(error);
    }
    await startReservedCodexTurn(ctx, selected, pending, consumed.transcript, 'Codex is working...');
  }

  async function handleText(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    const text = ctx.text?.trim() ?? '';
    if (text === '?' || text === '/') {
      await safeReply(ctx, stateAwareHelpText(ctx));
      return;
    }

    if (text.startsWith('/')) {
      await safeReply(ctx, 'Unknown command. Use /help to see available commands.');
      return;
    }

    const selected = selectedChats.get(ownerChatKey(ctx));
    if (selected === undefined) {
      await safeReply(ctx, noChatSelectedMessage(ownerChatKey(ctx)));
      return;
    }

    if (isThreadUnavailable(selected.threadId)) {
      await safeReply(ctx, 'A Codex turn is already running for this chat. Wait for it to finish.');
      return;
    }

    await startCodexTurn(ctx, selected, text);
  }

  async function handleReboot(ctx: TelegramHandlerContext): Promise<void> {
    if (!(await requireAccess(ctx))) {
      return;
    }

    await safeReply(ctx, 'Restarting Codex app-server and Telegram bot...');
    try {
      await Promise.resolve(ctx.confirmUpdate?.());
    } catch (error) {
      reportDeliveryError(error);
      await safeReply(ctx, 'Could not confirm reboot request with Telegram. Restart cancelled; try /reboot again.');
      return;
    }
    await deps.onRebootRequested?.();
  }

  function setSelectedChat(chatId: number, thread: CodexThread, projectPath?: string): void {
    const modelInfo = modelInfoFromThread(thread);
    storeSelectedChat(chatId, {
      threadId: thread.id,
      title: displayTitleFromThread(thread),
      modelInfo,
      modelInfoSource: modelInfo === undefined ? undefined : 'thread',
      sessionPath: sessionPathFromThread(thread),
      projectPath: projectPath ?? projectPathFromThread(thread)
    });
  }

  function storeSelectedChat(chatId: number, selected: SelectedChat): void {
    selectedChats.set(chatId, selected);
    if (selected.projectPath !== undefined) {
      selectedProjects.set(chatId, selected.projectPath);
    }
  }

  function clearSelectedChatThread(chatId: number, projectPath?: string): void {
    selectedChats.delete(chatId);
    if (projectPath !== undefined) {
      selectedProjects.set(chatId, projectPath);
    }
  }

  async function replyProjectChats(ctx: TelegramHandlerContext, projectPath: string): Promise<void> {
    const threads = await deps.codex.listThreads();
    const selectedProject = normalizePathForIdentity(projectPath);
    const projectThreads = threads.filter((thread) => {
      const projectPath = projectPathFromThread(thread);
      return projectPath !== undefined && normalizePathForIdentity(projectPath) === selectedProject;
    });

    if (projectThreads.length === 0) {
      await safeReply(ctx, 'No chats for this project found. Use /new_chat to create one.');
      return;
    }

    const rows = projectThreads.slice(0, MAX_LIST_ITEMS).map((thread) => {
      const title = displayTitleFromThread(thread) ?? 'Untitled chat';
      return [{ text: title, callback_data: callbackData.createSelectChat(thread.id, projectPath) }];
    });
    const titles = projectThreads.slice(0, MAX_LIST_ITEMS).map((thread, index) => {
      return `${index + 1}. ${displayTitleFromThread(thread) ?? 'Untitled chat'}`;
    });

    await safeReply(ctx, `Project chats:\n${titles.join('\n')}`, keyboard(rows));
  }

  async function refreshSelectedChat(chatId: number, selected: SelectedChat): Promise<SelectedChat> {
    try {
      const threads = await deps.codex.listThreads();
      const thread = threads.find((candidate) => candidate.id === selected.threadId);
      if (thread === undefined) {
        return refreshSelectedModelInfo(chatId, selected);
      }

      const sessionPath = sessionPathFromThread(thread) ?? selected.sessionPath;
      const sessionPathChanged = sessionPath !== selected.sessionPath;
      const useCachedSessionModel = selected.modelInfoSource === 'session' && !sessionPathChanged;
      const threadModelInfo = useCachedSessionModel ? undefined : modelInfoFromThread(thread);
      const refreshed: SelectedChat = {
        threadId: selected.threadId,
        title: displayTitleFromThread(thread) ?? selected.title,
        modelInfo: threadModelInfo ?? (sessionPathChanged ? undefined : selected.modelInfo),
        modelInfoSource: threadModelInfo === undefined ? (sessionPathChanged ? undefined : selected.modelInfoSource) : 'thread',
        modelInfoSessionMtimeMs: sessionPathChanged ? undefined : selected.modelInfoSessionMtimeMs,
        modelInfoSessionSize: sessionPathChanged ? undefined : selected.modelInfoSessionSize,
        tokenUsage: sessionPathChanged ? undefined : selected.tokenUsage,
        tokenUsageSessionMtimeMs: sessionPathChanged ? undefined : selected.tokenUsageSessionMtimeMs,
        tokenUsageSessionSize: sessionPathChanged ? undefined : selected.tokenUsageSessionSize,
        sessionPath,
        projectPath: selected.projectPath ?? projectPathFromThread(thread)
      };
      return refreshSelectedModelInfo(chatId, refreshed);
    } catch {
      return refreshSelectedModelInfo(chatId, selected);
    }
  }

  async function refreshSelectedModelInfo(chatId: number, selected: SelectedChat): Promise<SelectedChat> {
    if (selected.sessionPath === undefined) {
      storeSelectedChat(chatId, selected);
      return selected;
    }

    try {
      const snapshot = await readCodexSessionModelInfo(selected.sessionPath, {
        knownMtimeMs: selected.modelInfoSessionMtimeMs,
        knownSize: selected.modelInfoSessionSize
      });
      const refreshed = snapshot.unchanged
        ? selected
        : {
          ...selected,
          modelInfo: snapshot.modelInfo ?? selected.modelInfo,
          modelInfoSource: snapshot.modelInfo === null ? selected.modelInfoSource : 'session',
          modelInfoSessionMtimeMs: snapshot.mtimeMs,
          modelInfoSessionSize: snapshot.size
        };
      return refreshSelectedTokenUsage(chatId, refreshed);
    } catch {
      return refreshSelectedTokenUsage(chatId, selected);
    }
  }

  async function refreshSelectedTokenUsage(chatId: number, selected: SelectedChat): Promise<SelectedChat> {
    if (selected.sessionPath === undefined) {
      storeSelectedChat(chatId, selected);
      return selected;
    }

    try {
      const snapshot = await readCodexSessionTokenUsage(selected.sessionPath, {
        knownMtimeMs: selected.tokenUsageSessionMtimeMs,
        knownSize: selected.tokenUsageSessionSize
      });
      const refreshed = snapshot.unchanged
        ? selected
        : {
          ...selected,
          tokenUsage: snapshot.tokenUsage ?? undefined,
          tokenUsageSessionMtimeMs: snapshot.mtimeMs,
          tokenUsageSessionSize: snapshot.size
        };
      storeSelectedChat(chatId, refreshed);
      return refreshed;
    } catch {
      storeSelectedChat(chatId, selected);
      return selected;
    }
  }

  async function handleSelectChatCallback(ctx: TelegramHandlerContext, threadId: string): Promise<void> {
    try {
      const callbackProjectPath = callbackData.resolveSelectChatProjectPath(ctx.callbackData);
      if (callbackProjectPath === null) {
        await safeReply(ctx, 'This chat button no longer has project context. Run /select_chat again.');
        return;
      }

      const safeProject = await findSafeProject(callbackProjectPath);
      if (safeProject === undefined) {
        await safeReply(ctx, PROJECT_UNAVAILABLE_MESSAGE);
        return;
      }

      const chatId = ownerChatKey(ctx);
      if (!callbackMatchesSelectedProject(chatId, safeProject.path)) {
        await safeReply(ctx, 'This chat button no longer matches the selected project. Run /select_chat again.');
        return;
      }

      const projectThreads = await listProjectThreads(safeProject.path);
      if (!projectThreads.some((thread) => thread.id === threadId)) {
        await safeReply(ctx, 'This chat is no longer available. Run /select_chat again.');
        return;
      }

      const thread = await deps.codex.resumeThread(threadId);
      setSelectedChat(chatId, thread, safeProject.path);
      const selected = await refreshSelectedChat(chatId, selectedChats.get(chatId)!);
      await updateCommandMenu(chatId, selected.projectPath !== undefined);
      await answerCallback(ctx, 'Selected');
      await safeReply(ctx, formatCurrentChat(selected));
    } catch {
      await safeReply(ctx, 'Could not select chat. Try /select_chat again.');
    }
  }

  async function handleDeleteChatCallback(
    ctx: TelegramHandlerContext,
    threadId: string,
    callbackProjectPath: string
  ): Promise<void> {
    const chatId = ownerChatKey(ctx);
    if (!callbackMatchesSelectedProject(chatId, callbackProjectPath)) {
      await safeReply(ctx, 'This delete button no longer matches the selected project. Run /delete_chat again.');
      return;
    }

    try {
      const projectThreads = await listProjectThreads(callbackProjectPath);
      const thread = projectThreads.find((candidate) => candidate.id === threadId);
      if (thread === undefined) {
        await safeReply(ctx, 'This chat is no longer available. Run /delete_chat again.');
        return;
      }

      const title = displayTitleFromThread(thread) ?? 'Untitled chat';
      await answerCallback(ctx, 'Confirm delete');
      await safeReply(ctx, `Delete chat?\n${title}`, keyboard([
        [
          {
            text: 'Yes, delete',
            callback_data: callbackData.createDeleteChatConfirm(threadId, callbackProjectPath, true)
          }
        ],
        [
          {
            text: 'No',
            callback_data: callbackData.createDeleteChatConfirm(threadId, callbackProjectPath, false)
          }
        ]
      ]));
    } catch {
      await safeReply(ctx, 'Could not load chat details. Run /delete_chat again.');
    }
  }

  async function handleDeleteChatConfirmCallback(
    ctx: TelegramHandlerContext,
    deleteConfirm: { threadId: string; projectPath: string; confirmed: boolean }
  ): Promise<void> {
    const chatId = ownerChatKey(ctx);
    if (!callbackMatchesSelectedProject(chatId, deleteConfirm.projectPath)) {
      await safeReply(ctx, 'This delete button no longer matches the selected project. Run /delete_chat again.');
      return;
    }

    if (!deleteConfirm.confirmed) {
      await answerCallback(ctx, 'Cancelled');
      await safeReply(ctx, 'Delete cancelled.');
      return;
    }

    if (isThreadUnavailable(deleteConfirm.threadId)) {
      await safeReply(ctx, 'A Codex turn is already running for this chat. Wait for it to finish before deleting it.');
      return;
    }

    if (deps.codex.archiveThread === undefined) {
      await safeReply(ctx, 'Could not delete chat. Check Codex app-server and try again.');
      return;
    }

    const selected = selectedChats.get(chatId);
    const deletingSelectedChat = selected?.threadId === deleteConfirm.threadId;

    try {
      await deps.codex.archiveThread(deleteConfirm.threadId);
    } catch {
      await safeReply(ctx, 'Could not delete chat. Check Codex app-server and try again.');
      return;
    }

    if (!deletingSelectedChat) {
      await answerCallback(ctx, 'Deleted');
      await safeReply(ctx, 'Deleted chat.');
      return;
    }

    try {
      const replacement = await deps.codex.startThread({ cwd: deleteConfirm.projectPath });
      setSelectedChat(chatId, replacement, deleteConfirm.projectPath);
      const refreshed = await refreshSelectedModelInfo(chatId, selectedChats.get(chatId)!);
      await updateCommandMenu(chatId, refreshed.projectPath !== undefined);
      await answerCallback(ctx, 'Deleted');
      await safeReply(ctx, `Deleted selected chat.\n${formatCurrentChat(refreshed)}`);
    } catch {
      clearSelectedChatThread(chatId, deleteConfirm.projectPath);
      await updateCommandMenu(chatId, true);
      await answerCallback(ctx, 'Deleted');
      await safeReply(ctx, 'Deleted selected chat, but could not create a replacement. Use /new_chat or /select_chat.');
    }
  }

  async function findSafeProject(requestedProjectPath: string): Promise<ProjectSummary | undefined> {
    const projects = await deps.listProjects(deps.config.projectsRoot);
    return projects.find((project) => {
      return normalizePathForIdentity(project.path) === normalizePathForIdentity(requestedProjectPath);
    });
  }

  async function handleSelectProjectCallback(ctx: TelegramHandlerContext, requestedProjectPath: string): Promise<void> {
    try {
      const safeProject = await findSafeProject(requestedProjectPath);

      if (safeProject === undefined) {
        await safeReply(ctx, PROJECT_UNAVAILABLE_MESSAGE);
        return;
      }

      const chatId = ownerChatKey(ctx);
      clearSelectedChatThread(chatId, safeProject.path);
      await updateCommandMenu(chatId, true);
      await answerCallback(ctx, 'Selected');
      await safeReply(ctx, `Selected project: ${truncateLabel(safeProject.name)}`, projectActionKeyboard(safeProject.path));
    } catch {
      await safeReply(ctx, 'Could not select project. Check the configured projects root and try again.');
    }
  }

  async function handleProjectNewChatCallback(ctx: TelegramHandlerContext, requestedProjectPath: string): Promise<void> {
    try {
      const safeProject = await findSafeProject(requestedProjectPath);
      if (safeProject === undefined) {
        await safeReply(ctx, PROJECT_UNAVAILABLE_MESSAGE);
        return;
      }

      const chatId = ownerChatKey(ctx);
      if (!callbackMatchesSelectedProject(chatId, safeProject.path)) {
        await safeReply(ctx, 'This project action no longer matches the selected project. Run /select_project again.');
        return;
      }

      clearSelectedChatThread(chatId, safeProject.path);
      await answerCallback(ctx, 'Create chat');
      await createNewChatInProject(ctx, safeProject.path);
    } catch {
      await safeReply(ctx, 'Could not create a new chat for the selected project.');
    }
  }

  async function handleProjectSelectChatCallback(ctx: TelegramHandlerContext, requestedProjectPath: string): Promise<void> {
    try {
      const safeProject = await findSafeProject(requestedProjectPath);
      if (safeProject === undefined) {
        await safeReply(ctx, PROJECT_UNAVAILABLE_MESSAGE);
        return;
      }

      const chatId = ownerChatKey(ctx);
      if (!callbackMatchesSelectedProject(chatId, safeProject.path)) {
        await safeReply(ctx, 'This project action no longer matches the selected project. Run /select_project again.');
        return;
      }

      clearSelectedChatThread(chatId, safeProject.path);
      await updateCommandMenu(chatId, true);
      await answerCallback(ctx, 'Select chat');
      await replyProjectChats(ctx, safeProject.path);
    } catch {
      await safeReply(ctx, 'Could not load project chats. Check Codex app-server and try again.');
    }
  }

  async function createNewChatInProject(ctx: TelegramHandlerContext, projectPath: string): Promise<void> {
    const thread = await deps.codex.startThread({ cwd: projectPath });
    const chatId = ownerChatKey(ctx);
    setSelectedChat(chatId, thread, projectPath);
    const refreshed = await refreshSelectedModelInfo(chatId, selectedChats.get(chatId)!);
    await updateCommandMenu(chatId, refreshed.projectPath !== undefined);
    await safeReply(ctx, `Created new chat.\n${formatCurrentChat(refreshed)}`);
  }

  async function startCodexTurn(
    ctx: TelegramHandlerContext,
    selected: SelectedChat,
    text: string,
    workingMessage = 'Codex is working...'
  ): Promise<void> {
    const pending = reservePendingTurn(ctx, selected);
    if (pending === null) {
      await safeReply(ctx, 'A Codex turn is already running for this chat. Wait for it to finish.');
      return;
    }
    await startReservedCodexTurn(ctx, selected, pending, text, workingMessage);
  }

  function reservePendingTurn(ctx: TelegramHandlerContext, selected: SelectedChat): PendingTurnContext | null {
    if (pendingTurnThreadIds.has(selected.threadId) || activeTurns.isThreadBusy(selected.threadId)) {
      return null;
    }

    const chatId = ownerChatKey(ctx);
    const pending: PendingTurnContext = {
      threadId: selected.threadId,
      telegramChatId: chatId,
      selectedThreadId: selected.threadId,
      reply: ctx.reply,
      bufferedDeltas: [],
      bufferedCompletions: []
    };

    pendingTurnThreadIds.add(selected.threadId);
    pendingTurnContexts.set(selected.threadId, pending);
    return pending;
  }

  function releasePendingTurn(threadId: string, pending: PendingTurnContext): boolean {
    if (pendingTurnContexts.get(threadId) !== pending) {
      return false;
    }

    pendingTurnContexts.delete(threadId);
    pendingTurnThreadIds.delete(threadId);
    return true;
  }

  async function startReservedCodexTurn(
    ctx: TelegramHandlerContext,
    selected: SelectedChat,
    pending: PendingTurnContext,
    text: string,
    workingMessage: string
  ): Promise<void> {
    try {
      const started = await deps.codex.startTurn({ threadId: selected.threadId, text });
      if (pendingTurnContexts.get(selected.threadId) !== pending) {
        return;
      }

      pendingTurnContexts.delete(selected.threadId);
      pendingTurnThreadIds.delete(selected.threadId);
      activeTurns.start({
        threadId: selected.threadId,
        turnId: started.turnId,
        telegramChatId: pending.telegramChatId,
        selectedThreadId: selected.threadId,
        reply: ctx.reply
      });

      await safeReply(ctx, workingMessage);
      for (const delta of pending.bufferedDeltas) {
        activeTurns.appendAgentDelta(delta);
      }
      for (const completion of pending.bufferedCompletions) {
        await handleTurnCompleted(completion);
      }
    } catch {
      if (pendingTurnContexts.get(selected.threadId) === pending) {
        if (connectionLossTimers.has(selected.threadId)) {
          return;
        }
        if (releasePendingTurn(selected.threadId, pending)) {
          await safeReply(ctx, 'Could not start Codex turn. Check /status and try again.');
        }
      }
    }
  }

  async function handleTurnCompleted(event: TurnCompletedNotification): Promise<void> {
    const turnId = event.turn.id;
    const active = activeTurns.getByTurnId(turnId);
    if (active === undefined || active.threadId !== event.threadId) {
      const pending = pendingTurnContexts.get(event.threadId);
      if (pending !== undefined) {
        pending.bufferedCompletions.push(event);
      }
      return;
    }

    clearConnectionLossTimer(event.threadId);
    const completed = event.turn.status === 'completed' ? activeTurns.complete({ threadId: event.threadId, turnId }) : activeTurns.fail({ threadId: event.threadId, turnId });
    if (completed === null) {
      return;
    }

    if (event.turn.status === 'completed') {
      for (const chunk of splitTelegramText(completed.accumulatedAssistantText)) {
        await replyWithRetries(completed.reply ?? (() => Promise.resolve()), chunk);
      }
      return;
    }

    await replyWithRetries(completed.reply ?? (() => Promise.resolve()), 'Codex turn failed. Check Codex Desktop or CLI for details.');
  }

  function handleConnectionStatusChanged(event: ConnectionStatusChangedEvent): void {
    if (event.status !== 'reconnecting' && event.status !== 'disconnected') {
      return;
    }

    const affectedThreadIds = new Set<string>();
    for (const turn of activeTurns.listActive()) {
      affectedThreadIds.add(turn.threadId);
    }
    for (const threadId of pendingTurnThreadIds) {
      affectedThreadIds.add(threadId);
    }

    for (const threadId of affectedThreadIds) {
      if (!connectionLossTimers.has(threadId)) {
        connectionLossTimers.set(
          threadId,
          setTimeout(() => {
            void failThreadForConnectionLoss(threadId).catch((error: unknown) => reportDeliveryError(error));
          }, deps.connectionLossGraceMs ?? DEFAULT_CONNECTION_LOSS_GRACE_MS)
        );
      }
    }
  }

  async function failThreadForConnectionLoss(threadId: string): Promise<void> {
    connectionLossTimers.delete(threadId);
    const pending = pendingTurnContexts.get(threadId);
    if (pending !== undefined) {
      pendingTurnContexts.delete(threadId);
      pendingTurnThreadIds.delete(threadId);
      await replyWithRetries(pending.reply, CODEX_CONNECTION_LOST_MESSAGE);
      return;
    }

    const active = activeTurns.markThreadIdle(threadId);
    if (active !== null) {
      await replyWithRetries(active.reply ?? (() => Promise.resolve()), CODEX_CONNECTION_LOST_MESSAGE);
    }
  }

  function clearConnectionLossTimer(threadId: string): void {
    const timer = connectionLossTimers.get(threadId);
    if (timer !== undefined) {
      clearTimeout(timer);
      connectionLossTimers.delete(threadId);
    }
  }

  async function answerCallback(ctx: TelegramHandlerContext, text?: string): Promise<void> {
    try {
      await ctx.answerCallbackQuery?.(text);
    } catch (error) {
      reportDeliveryError(error);
    }
  }
  async function safeReply(ctx: TelegramHandlerContext, text: string, options?: unknown): Promise<void> {
    await tryReply(ctx, text, options);
  }

  async function tryReply(ctx: TelegramHandlerContext, text: string, options?: unknown): Promise<boolean> {
    try {
      await ctx.reply(text, options);
      return true;
    } catch (error) {
      reportDeliveryError(error);
      return false;
    }
  }

  async function deleteVoiceFile(filePath: string): Promise<void> {
    try {
      await Promise.resolve(deps.deleteVoiceFile?.(filePath));
    } catch (error) {
      reportDeliveryError(error);
    }
  }

  async function replyWithRetries(reply: (text: string, options?: unknown) => Promise<void>, text: string): Promise<void> {
    const attempts = deps.deliveryRetryAttempts ?? DEFAULT_DELIVERY_RETRY_ATTEMPTS;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await reply(text);
        return;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) {
          await sleep(deps.deliveryRetryDelayMs ?? DEFAULT_DELIVERY_RETRY_DELAY_MS);
        }
      }
    }

    reportDeliveryError(lastError);
  }

  function reportDeliveryError(error: unknown): void {
    deps.onDeliveryError?.(error instanceof Error ? error : new Error(String(error)));
  }

  return {
    callbackData,
    handleStart,
    handleHelp,
    handleStatus,
    handleLimits,
    handleProjectChats,
    handleSelectProject,
    handleNewChat,
    handleDeleteChat,
    handleCurrent,
    handleSummaryChat,
    handleReviewFix,
    handleCommit,
    handleCallback,
    handleVoice,
    handleText,
    handleReboot,
    getSelectedThread(chatId: number): string | null {
      return selectedChats.get(chatId)?.threadId ?? null;
    },
    setSelectedThread(chatId: number, threadId: string, projectPath?: string): void {
      selectedChats.set(chatId, { threadId, projectPath });
      if (projectPath === undefined) {
        selectedProjects.delete(chatId);
      } else {
        selectedProjects.set(chatId, projectPath);
      }
    }
  };
}


function keyboard(rows: InlineKeyboardOption['reply_markup']['inline_keyboard']): InlineKeyboardOption {
  return { reply_markup: { inline_keyboard: rows } };
}

function voiceCopyButton(text: string): InlineKeyboardButtonOption {
  const characters = Array.from(text);
  const copyText = characters.slice(0, TELEGRAM_COPY_TEXT_MAX_CHARS).join('');
  return {
    text: characters.length > TELEGRAM_COPY_TEXT_MAX_CHARS ? 'Copy first 256' : 'Copy',
    copy_text: { text: copyText }
  };
}

function nameFromThread(thread: CodexThread): string | undefined {
  if (typeof thread.name === 'string' && thread.name.trim().length > 0) {
    return thread.name.trim();
  }
  return undefined;
}

function previewFromThread(thread: CodexThread): string | undefined {
  if (typeof thread.preview === 'string' && thread.preview.trim().length > 0) {
    return thread.preview.trim();
  }
  return undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function modelInfoFromThread(thread: CodexThread): CodexSessionModelInfo | undefined {
  const model = stringFromUnknown(thread.model);
  if (model === undefined) {
    return undefined;
  }

  const effort = stringFromUnknown(thread.effort) ?? stringFromUnknown(thread.reasoning_effort);
  return effort === undefined ? { model } : { model, effort };
}

function sessionPathFromThread(thread: CodexThread): string | undefined {
  const sessionPath = stringFromUnknown(thread.path);
  return sessionPath !== undefined && path.extname(sessionPath).toLowerCase() === '.jsonl' ? sessionPath : undefined;
}

function displayTitleFromThread(thread: CodexThread): string | undefined {
  const name = nameFromThread(thread);
  if (name !== undefined) {
    const title = displayTitleCandidate(name);
    if (title !== undefined) {
      return title;
    }
  }

  const preview = previewFromThread(thread);
  if (preview !== undefined) {
    return displayTitleCandidate(firstLine(preview));
  }

  return undefined;
}

function projectPathFromThread(thread: CodexThread): string | undefined {
  return typeof thread.cwd === 'string' && thread.cwd.trim().length > 0 ? thread.cwd : undefined;
}

function formatCurrentChat(selectedChat: SelectedChat): string {
  const lines = [`Selected chat: ${selectedChat.title ?? 'Untitled chat'}`];
  const modelLine = formatModelInfo(selectedChat.modelInfo);
  if (modelLine !== undefined) {
    lines.push(modelLine);
  }
  lines.push(formatContextUsage(selectedChat.tokenUsage));
  lines.push(`Project: ${selectedChat.projectPath ?? 'Unknown project'}`);
  return lines.join('\n');
}

function formatVoiceConfirmationPreview(text: string, config: Pick<VoiceTranscriptionConfig, 'previewMaxChars'>): string {
  const normalized = text.trim();
  if (normalized.length <= config.previewMaxChars) {
    return `Voice transcribed. Send this to Codex?\n\n${normalized}`;
  }

  return [
    'Voice transcribed. Send this to Codex?',
    '',
    normalized.slice(0, config.previewMaxChars),
    '',
    'Preview truncated for Telegram. Full transcript will be sent to Codex.'
  ].join('\n');
}

function truncateLabel(value: string): string {
  return value.length <= MAX_LABEL_LENGTH ? value : `${value.slice(0, MAX_LABEL_LENGTH - 3)}...`;
}

function voiceTranscriptionTtlMs(config: Pick<VoiceTranscriptionConfig, 'timeoutSeconds'>): number {
  return config.timeoutSeconds * 1000 + VOICE_TRANSCRIPTION_TTL_BUFFER_MS;
}

function isVoiceFileTooLargeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'file_too_large';
}

function isVoiceEmptyTranscriptError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'empty_transcript';
}

function voiceTranscriptionFailureMessage(error: unknown): string {
  if (isVoiceFileTooLargeError(error)) {
    return VOICE_TOO_LARGE_MESSAGE;
  }
  if (isVoiceEmptyTranscriptError(error)) {
    return VOICE_EMPTY_MESSAGE;
  }
  return VOICE_TRANSCRIPTION_FAILED_MESSAGE;
}

function sanitizeVoiceTranscriptionError(error: unknown): {
  name: string;
  code?: string;
  helperErrorCode?: string;
  helperErrorType?: string;
} {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  const details = typeof error === 'object' && error !== null && 'details' in error ? error.details : undefined;
  const helperErrorCode =
    typeof details === 'object' && details !== null && 'helperErrorCode' in details && typeof details.helperErrorCode === 'string'
      ? details.helperErrorCode
      : undefined;
  const helperErrorType =
    typeof details === 'object' && details !== null && 'helperErrorType' in details && typeof details.helperErrorType === 'string'
      ? details.helperErrorType
      : undefined;
  return { name, code, helperErrorCode, helperErrorType };
}

async function readVoiceAudioKind(filePath: string): Promise<'empty' | 'html' | 'json' | 'ogg' | 'unknown'> {
  try {
    const bytes = await readFile(filePath);
    if (bytes.length === 0) {
      return 'empty';
    }

    const prefix = bytes.subarray(0, 8);
    const ascii = prefix.toString('ascii').trimStart();
    if (prefix.subarray(0, 4).toString('ascii') === 'OggS') {
      return 'ogg';
    }
    if (ascii.startsWith('<')) {
      return 'html';
    }
    if (ascii.startsWith('{') || ascii.startsWith('[')) {
      return 'json';
    }
  } catch {
    return 'unknown';
  }

  return 'unknown';
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function firstLine(value: string): string {
  return singleLine(value.split(/\r?\n/, 1)[0] ?? value);
}

function displayTitleCandidate(value: string): string | undefined {
  const candidate = singleLine(value);
  if (candidate.length === 0 || isRolloutSessionFileName(candidate)) {
    return undefined;
  }

  return truncateLabel(candidate);
}

function isRolloutSessionFileName(value: string): boolean {
  return /^rollout-\d{4}-\d{2}-\d{2}t.+\.jsonl$/i.test(path.basename(value));
}

function formatModelInfo(modelInfo: CodexSessionModelInfo | undefined): string | undefined {
  if (modelInfo === undefined) {
    return undefined;
  }

  const model = singleLine(modelInfo.model);
  const effort = modelInfo.effort === undefined ? undefined : singleLine(modelInfo.effort);
  return `Model: ${truncateLabel(effort === undefined ? model : `${model} ${effort}`)}`;
}

function formatContextUsage(tokenUsage: CodexSessionTokenUsage | undefined): string {
  if (tokenUsage === undefined) {
    return 'Context: not available yet';
  }

  const used = formatTokenCount(tokenUsage.usedTokens);
  const window = formatTokenCount(tokenUsage.contextWindowTokens);
  const percent = Math.round((tokenUsage.usedTokens / tokenUsage.contextWindowTokens) * 100);
  return `Context: ${used} / ${window} (${percent}%)`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }

  return `${Math.round(tokens / 1000)}k`;
}

function normalizePathForIdentity(value: string): string {
  const normalized = path.win32.normalize(value);
  const root = path.win32.parse(normalized).root;
  const withoutTrailingSeparators = normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized;
  return withoutTrailingSeparators.toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
