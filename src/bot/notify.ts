import type { Api, InlineKeyboard } from 'grammy';
import { createLogger } from '../logger.js';

const log = createLogger('notify');

let api: Api | undefined;

export function setBotApi(next: Api): void {
  api = next;
}

/** Sends a message to a chat; failures are logged, never thrown at the caller. */
export async function notify(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
  if (!api) {
    log.warn('notify() called before the bot was started');
    return;
  }
  try {
    await api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    log.warn(`failed to notify chat ${chatId}`, err);
  }
}
