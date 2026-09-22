import { db } from '@/db/schema';
import { DAY } from '@/shared/util';

/** Exchange rates (units per USD), refreshed at most weekly. Needs the optional open.er-api.com permission. */
export async function refreshRatesIfStale(force = false): Promise<Record<string, number> | null> {
  const s = await db.getSettings();
  if (!force && s.rates && s.ratesUpdatedAt && Date.now() - s.ratesUpdatedAt < 7 * DAY) return s.rates;
  const has = await chrome.permissions.contains({ origins: ['https://open.er-api.com/*'] }).catch(() => false);
  if (!has) return s.rates;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) return s.rates;
    const j = (await res.json()) as { rates?: Record<string, number> };
    if (j.rates) { await db.patchSettings({ rates: j.rates, ratesUpdatedAt: Date.now() }); return j.rates; }
  } catch { /* ignore */ }
  return s.rates;
}
