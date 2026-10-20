import { InputFile, type Context } from 'grammy';
import { cardDataFromRecord } from '../card/data.js';
import { renderPnlCard } from '../card/pnlCard.js';
import { store } from '../store/store.js';
import { errorMessage } from '../utils/errors.js';
import { esc } from '../utils/format.js';
import { fmtPct } from '../utils/format.js';

/**
 * Sends the PnL card of a closed position as a photo.
 *
 * The card is rendered from the frozen close record, so it always shows the
 * numbers as they were when the position closed.
 */
export async function sendPnlCard(ctx: Context, id: string): Promise<void> {
  const chatId = ctx.chat!.id;
  const record = store.findClosed(chatId, id);
  if (!record) {
    await ctx.reply('Unknown closed position. Use /history to see the ids.');
    return;
  }

  try {
    const data = cardDataFromRecord(record);
    const png = renderPnlCard(data);
    const caption = [
      `<b>${esc(data.pair)}</b> · ${esc(data.reason)}`,
      `Net realized PnL ${fmtPct(data.pnlPct)}`,
    ].join('\n');
    await ctx.replyWithPhoto(new InputFile(png, `pnl-${record.id}.png`), {
      parse_mode: 'HTML',
      caption,
    });
  } catch (err) {
    await ctx.reply(`Could not render the card: ${esc(errorMessage(err))}`, { parse_mode: 'HTML' });
  }
}
