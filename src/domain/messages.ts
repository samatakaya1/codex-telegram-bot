const TELEGRAM_SAFE_CHUNK_SIZE = 3900;
const EMPTY_ASSISTANT_TEXT = '(no assistant text)';

export function splitTelegramText(text: string, maxLength = TELEGRAM_SAFE_CHUNK_SIZE): string[] {
  if (text.length === 0) {
    return [EMPTY_ASSISTANT_TEXT];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength));
  }

  return chunks;
}
