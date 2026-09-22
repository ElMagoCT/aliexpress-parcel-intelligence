/**
 * Catch-up refresh.
 *
 * Runs when the browser starts, when the extension is installed or updated, and when the dashboard
 * is opened. It does NOT re-read your whole order history — it pages the order list only until two
 * consecutive pages contain nothing new, then tops up the things that go stale: tracking for active
 * parcels, prices for orders never priced, new return cases, and the exchange-rate table.
 */
import { db } from '@/db/schema';
import { pollDueParcels } from './tracker';
import { recomputeAll } from './recompute';
import { refreshRatesIfStale } from './rates';
import { syncOrderDetails, syncOrders, syncRefunds, syncTrackingForOrders } from './sync';

/** Don't repeat a catch-up more often than this, however many times the worker restarts. */
export const MIN_REFRESH_GAP_MS = 10 * 60_000;

export interface AutoRefreshResult {
  ran: boolean;
  reason: string;
  newOrders: number;
  pagesRead: number;
  trackingFetched: number;
  parcelsPolled: number;
  priced: number;
  refundCases: number;
  note: string;
}

const skip = (reason: string): AutoRefreshResult =>
  ({ ran: false, reason, newOrders: 0, pagesRead: 0, trackingFetched: 0, parcelsPolled: 0, priced: 0, refundCases: 0, note: reason });

export async function autoRefresh(report: (p: string) => Promise<void>, opts: { trigger: string; force?: boolean } = { trigger: 'manual' }): Promise<AutoRefreshResult> {
  const s = await db.getSettings();
  if (!opts.force && !s.autoRefreshOnLaunch) return skip('auto-refresh is switched off in Settings');
  if (!opts.force && s.lastAutoRefreshAt && Date.now() - s.lastAutoRefreshAt < MIN_REFRESH_GAP_MS) {
    return skip(`already refreshed ${Math.round((Date.now() - s.lastAutoRefreshAt) / 60_000)} min ago`);
  }
  const out: AutoRefreshResult = { ran: true, reason: opts.trigger, newOrders: 0, pagesRead: 0, trackingFetched: 0, parcelsPolled: 0, priced: 0, refundCases: 0, note: 'ok' };
  // Claim the slot up front so two triggers (browser start + dashboard opening) can't both run.
  await db.patchSettings({ lastAutoRefreshAt: Date.now() });

  await report('checking for new orders…');
  const orders = await syncOrders(40, 1, { untilKnown: true });
  out.newOrders = orders.orders;
  out.pagesRead = orders.pagesRead;
  if (orders.loggedOut) { out.note = 'Sign in to AliExpress to resume syncing.'; return out; }
  if (!orders.ok) out.note = orders.note;

  await report(`${out.newOrders} new order${out.newOrders === 1 ? '' : 's'} · fetching tracking…`);
  const tr = await syncTrackingForOrders(20, true);
  out.trackingFetched = tr.fetched;

  const poll = await pollDueParcels(30);
  out.parcelsPolled = poll.polled;

  await report('pricing new orders…');
  const det = await syncOrderDetails(report, 40);
  out.priced = det.fetched;

  await report('checking returns & refunds…');
  try { const rf = await syncRefunds(report); out.refundCases = rf.cases; } catch { /* never block the rest */ }

  await refreshRatesIfStale();
  await recomputeAll();
  await db.patchSettings({ lastAutoRefreshAt: Date.now(), lastSyncAt: Date.now() });
  await report(`up to date — ${out.newOrders} new orders, ${out.priced} priced, ${out.parcelsPolled} parcels polled`);
  return out;
}
