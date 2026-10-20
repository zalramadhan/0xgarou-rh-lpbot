/** The currencies the bot can show money in. */
type DisplayCurrency = 'USD' | 'IDR' | 'SOL';

export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = ['USD', 'IDR', 'SOL'];

const DEFAULT_CURRENCY: DisplayCurrency = 'USD';

/** Falls back to USD for anything unknown. */
export function normalizeCurrency(value: unknown): DisplayCurrency {
  return DISPLAY_CURRENCIES.includes(value as DisplayCurrency) ? (value as DisplayCurrency) : DEFAULT_CURRENCY;
}
