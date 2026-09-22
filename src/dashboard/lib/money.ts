import type { Settings } from '@/model/types';
import bundled from '@/data/rates.json';

/**
 * Exchange rates. A table is bundled with the extension so every amount converts out of the box;
 * it is replaced by a freshly fetched one once the user allows the rate service in Settings.
 */
export const BUNDLED_RATES = bundled as { asOf: string; base: string; rates: Record<string, number> };

export function ratesFor(settings: Settings): { rates: Record<string, number>; live: boolean; asOf: string } {
  if (settings.rates && Object.keys(settings.rates).length) {
    return { rates: settings.rates, live: true, asOf: settings.ratesUpdatedAt ? new Date(settings.ratesUpdatedAt).toLocaleDateString() : '' };
  }
  return { rates: BUNDLED_RATES.rates, live: false, asOf: BUNDLED_RATES.asOf };
}

/** Convert an amount into the user's display currency. Returns null only for an unknown currency. */
export function convert(amount: number | null | undefined, from: string | null | undefined, settings: Settings): number | null {
  if (amount == null || !isFinite(amount)) return null;
  const to = (settings.displayCurrency || 'USD').toUpperCase();
  const f = (from || 'USD').toUpperCase();
  if (f === to) return amount;
  const { rates } = ratesFor(settings);
  const rf = f === 'USD' ? 1 : rates[f];
  const rt = to === 'USD' ? 1 : rates[to];
  if (!rf || !rt) return null;
  return (amount / rf) * rt;
}
