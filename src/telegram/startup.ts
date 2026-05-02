export const STARTUP_NOTIFICATION_MESSAGE = 'Codex Telegram bridge started.';
export const SELECT_PROJECT_STARTUP_BUTTON_TEXT = 'Выбрать проект';
export const SELECT_PROJECT_STARTUP_CALLBACK_DATA = 'select_project';

export function startupNotificationOptions(): {
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
} {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: SELECT_PROJECT_STARTUP_BUTTON_TEXT, callback_data: SELECT_PROJECT_STARTUP_CALLBACK_DATA }]
      ]
    }
  };
}
