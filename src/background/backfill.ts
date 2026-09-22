/**
 * Full-history backfill. Opens the orders page in a managed tab and lets the bridge
 * content script paginate while the interceptor captures. State is persisted in
 * chrome.storage.local so it survives SW restarts and tab closure.
 */
import { db } from '@/db/schema';
import type { BackfillState } from '@/model/types';
import { ORDERS_PAGE_URL, ORDERS_PAGE_RE } from '@/adapters/aliexpress';
import { syncOrders, syncTrackingForOrders } from './sync';
import { pollParcel } from './tracker';
import { jitter, sleep } from '@/shared/util';
import { startJob } from './jobs';

const KEY = 'backfillState';
const DEFAULT: BackfillState = { active: false, phase: 'idle', tabId: null, pagesFetched: 0, ordersFound: 0, ordersAtStart: 0, estimatedRemainingPages: null, trackingQueued: 0, trackingDone: 0, startedAt: null, updatedAt: 0, lastError: null, exhaustedStreak: 0 };

export async function getBackfillState(): Promise<BackfillState> {
  const r = await chrome.storage.local.get(KEY);
  return { ...DEFAULT, ...((r[KEY] as Partial<BackfillState>) ?? {}) };
}
async function setState(patch: Partial<BackfillState>): Promise<BackfillState> {
  const cur = await getBackfillState();
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function startBackfill(): Promise<BackfillState> {
  const cur = await getBackfillState();
  if (cur.active && cur.tabId != null) {
    try { await chrome.tabs.get(cur.tabId); return cur; } catch { /* tab gone, restart */ }
  }
  const ordersAtStart = await db.orders.count();
  const tab = await chrome.tabs.create({ url: ORDERS_PAGE_URL, active: false });
  const st = await setState({ active: true, phase: 'orders', tabId: tab.id ?? null, pagesFetched: 0, ordersFound: 0, ordersAtStart, startedAt: Date.now(), lastError: null, exhaustedStreak: 0, trackingDone: 0, trackingQueued: 0 });
  chrome.alarms.create('backfill-watchdog', { periodInMinutes: 1 });
  return st;
}

export async function stopBackfill(reason = 'stopped'): Promise<BackfillState> {
  const cur = await getBackfillState();
  if (cur.tabId != null) { try { await chrome.tabs.sendMessage(cur.tabId, { type: 'AEPI_DRIVER_STOP' }); } catch { /* ignore */ } }
  chrome.alarms.clear('backfill-watchdog');
  return setState({ active: false, phase: reason === 'done' ? 'done' : 'stopped', tabId: null });
}

/** Called when the managed tab has loaded the orders page. */
export async function onOrdersTabReady(tabId: number) {
  const st = await getBackfillState();
  if (!st.active || st.tabId !== tabId || st.phase !== 'orders') return;
  try { await chrome.tabs.sendMessage(tabId, { type: 'AEPI_DRIVER_START', state: st }); } catch (e) { await setState({ lastError: `driver start failed: ${String(e)}` }); }
}

export async function onDriverProgress(tabId: number | undefined, pagesFetched: number, ordersOnPage: number, exhausted: boolean): Promise<{ stop: boolean }> {
  const st = await getBackfillState();
  if (!st.active) return { stop: true };
  const total = await db.orders.count();
  const found = Math.max(total - st.ordersAtStart, 0);
  const perPage = pagesFetched > 0 ? Math.max(ordersOnPage / pagesFetched, 1) : 10;
  const remaining = exhausted ? 0 : null;
  const next = await setState({ pagesFetched, ordersFound: found, estimatedRemainingPages: remaining, exhaustedStreak: exhausted ? st.exhaustedStreak + 1 : 0 });
  void perPage;
  if (exhausted) { void finishOrdersPhase(); return { stop: true }; }
  return { stop: !next.active };
}

async function finishOrdersPhase() {
  startJob('backfill-finish', async (report) => { await finishOrdersPhaseInner(report); });
}

async function finishOrdersPhaseInner(report: (p: string) => Promise<void>) {
  const st = await getBackfillState();
  if (!st.active) return;
  await report('complementing order list with direct fetches');
  // Complement with direct fetches (learned endpoint) in case the DOM driver missed pages.
  try { await syncOrders(60, 1); } catch { /* best effort */ }
  if (st.tabId != null) { try { await chrome.tabs.remove(st.tabId); } catch { /* ignore */ } }
  // Tracking numbers live on AliExpress's tracking page, not in the order list → fetch per order, oldest first.
  let missing = (await db.orders.toArray()).filter((o) => !o.trackingNos.length && o.status !== 'AWAITING_PAYMENT' && o.status !== 'CLOSED').length;
  await setState({ phase: 'tracking', tabId: null, trackingQueued: missing, trackingDone: 0, ordersFound: Math.max((await db.orders.count()) - st.ordersAtStart, 0), lastError: null });
  for (let i = 0; i < 40 && missing > 0; i++) {
    const cur = await getBackfillState();
    if (!cur.active) return;
    const r = await syncTrackingForOrders(10, true);
    await report(`tracking for orders: ${cur.trackingDone + r.fetched} done, ${missing} to go`);
    if (!r.fetched) { await setState({ lastError: r.note === 'ok' ? null : r.note }); break; }
    missing = (await db.orders.toArray()).filter((o) => !o.trackingNos.length && o.status !== 'AWAITING_PAYMENT' && o.status !== 'CLOSED').length;
    await setState({ trackingDone: cur.trackingDone + r.fetched, trackingQueued: missing });
  }
  const parcels = await db.parcels.toArray();
  const queue = parcels.filter((p) => p.state !== 'DELIVERED' || !p.lastEventAt).sort((a, b) => (a.shippedAt ?? 0) - (b.shippedAt ?? 0));
  await setState({ trackingQueued: queue.length, trackingDone: 0 });
  void trickleTracking();
}

let trickling = false;
/** Backfill tracking history for every parcel, oldest first, at a slow trickle. Resumable: re-reads state each step. */
export async function trickleTracking() {
  if (trickling) return;
  trickling = true;
  try {
    while (true) {
      const st = await getBackfillState();
      if (!st.active || st.phase !== 'tracking') break;
      const kv = await db.getKV<string[]>('backfillTrackingDone', []);
      const done = new Set(kv);
      const parcels = (await db.parcels.toArray()).filter((p) => !done.has(p.parcelId)).sort((a, b) => (a.shippedAt ?? 0) - (b.shippedAt ?? 0));
      if (!parcels.length) { await db.setKV('backfillTrackingDone', []); await stopBackfill('done'); break; }
      const p = parcels[0];
      const r = await pollParcel(p.parcelId, { force: true });
      done.add(p.parcelId);
      await db.setKV('backfillTrackingDone', [...done]);
      await setState({ trackingDone: st.trackingDone + 1, trackingQueued: parcels.length - 1 });
      if (r.paused) { await sleep(60_000); }
      await sleep(jitter(4000, 0.5));
    }
  } finally { trickling = false; }
}

/** Watchdog alarm: resumes after SW restarts or tab loss. */
export async function backfillWatchdog() {
  const st = await getBackfillState();
  if (!st.active) { chrome.alarms.clear('backfill-watchdog'); return; }
  if (st.phase === 'tracking') { void trickleTracking(); return; }
  if (st.phase === 'orders') {
    let tabOk = false;
    if (st.tabId != null) {
      try {
        const t = await chrome.tabs.get(st.tabId);
        tabOk = !!t.url && ORDERS_PAGE_RE.test(t.url);
        if (tabOk && t.status === 'complete') {
          const pong = await chrome.tabs.sendMessage(st.tabId, { type: 'AEPI_PING' }).catch(() => null);
          if (pong) await onOrdersTabReady(st.tabId);
        }
      } catch { tabOk = false; }
    }
    // Orders phase has run long enough (or the driver stopped reporting): move on instead of reopening tabs forever.
    if (st.startedAt && Date.now() - st.startedAt > 25 * 60_000 || Date.now() - st.updatedAt > 8 * 60_000) { void finishOrdersPhase(); return; }
    if (!tabOk && st.tabId == null) {
      const tab = await chrome.tabs.create({ url: ORDERS_PAGE_URL, active: false });
      await setState({ tabId: tab.id ?? null, lastError: 'orders tab reopened by watchdog' });
    } else if (!tabOk) {
      await setState({ lastError: 'orders tab navigated away — finishing with direct fetches' });
      void finishOrdersPhase();
    }
  }
}

export async function onTabRemoved(tabId: number) {
  const st = await getBackfillState();
  if (st.active && st.tabId === tabId && st.phase === 'orders') await setState({ tabId: null, lastError: 'orders tab closed — watchdog will reopen it' });
}
