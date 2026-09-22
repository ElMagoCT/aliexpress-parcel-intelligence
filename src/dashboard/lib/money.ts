import type { Settings } from '@/model/types';

/** Convert an amount between currencies using the cached USD-based rate table. */
export function convert(amount: number | null | undefined, from: string | null | undefined, settings: Settings): number | null {
  if (amount == null || !isFinite(amount)) return null;
  const to = settings.displayCurrency || 'USD';
  const f = (from || 'USD').toUpperCase();
  if (f === to) return amount;
  const rates = settings.rates;
  if (!rates) return f === 'USD' || to === 'USD' ? null : null;
  const rf = f === 'USD' ? 1 : rates[f];
  const rt = to === 'USD' ? 1 : rates[to];
  if (!rf || !rt) return null;
  return (amount / rf) * rt;
}
