import type { Context } from 'grammy';

/**
 * Answers a callback query — and never lets a failed answer stop the work.
 *
 * Telegram refuses an answer when the query has expired: *"query is too old
 * and response timeout expired or query ID is invalid"*. That happens when
 * the button was tapped while the bot was busy and the update reached it
 * late. A rejected answer is only a cosmetic problem (the little spinner in
 * the chat stays), so it must not take the action down with it: the PnL card
 * still has to be sent.
 */
export async function answer(
  ctx: Context,
  options?: Parameters<Context['answerCallbackQuery']>[0],
): Promise<void> {
  await ctx.answerCallbackQuery(options).catch(() => undefined);
}
