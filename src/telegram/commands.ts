export type TelegramCommandDefinition = {
  readonly command: string;
  readonly description: string;
};

export const BASE_TELEGRAM_COMMANDS = [
  { command: 'start', description: 'Show access result and help' },
  { command: 'help', description: 'Show available commands' },
  { command: 'status', description: 'Show Codex connection status and URL' },
  { command: 'limits', description: 'Show current Codex limit remaining' },
  { command: 'select_project', description: 'Choose a project' },
  { command: 'reboot', description: 'Restart Codex app-server and bot' }
] as const satisfies readonly TelegramCommandDefinition[];

export const ACTIVE_CHAT_TELEGRAM_COMMANDS = [
  { command: 'select_chat', description: 'List chats for the selected project' },
  { command: 'new_chat', description: 'Create another chat in the selected project' },
  { command: 'delete_chat', description: 'Delete a chat from the selected project' },
  { command: 'current', description: 'Show selected chat, context, and project' },
  { command: 'summary_chat', description: 'Ask Codex for selected chat summary' },
  { command: 'review_fix', description: 'Review and fix issues in the selected chat' },
  { command: 'commit', description: 'Commit and merge verified project changes' }
] as const satisfies readonly TelegramCommandDefinition[];

export const TELEGRAM_COMMANDS = [...BASE_TELEGRAM_COMMANDS, ...ACTIVE_CHAT_TELEGRAM_COMMANDS] as const;

export function telegramCommandsForState(hasSelectedChat: boolean): readonly TelegramCommandDefinition[] {
  return hasSelectedChat ? TELEGRAM_COMMANDS : BASE_TELEGRAM_COMMANDS;
}

export function helpTextForState(hasSelectedChat: boolean): string {
  return telegramCommandsForState(hasSelectedChat)
    .map(({ command, description }) => `/${command} - ${description}`)
    .join('\n');
}

export const HELP_TEXT = helpTextForState(true);
