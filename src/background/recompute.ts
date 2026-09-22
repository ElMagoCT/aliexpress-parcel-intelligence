/**
 * Recompute: parcel states, predictions, consolidation groups, alerts + notifications.
 * Debounced; runs after ingest and after every poll.
 */
import { db } from '@/db/schema';
import type { Alert, Milestone, Order, Parcel, ParcelState, Prediction, TrackEvent } from '@/model/types';
import { MILESTONE_LABEL } from '@/model/types';
import { buildHistoryModel, currentMilestone, estimateDwellP90, estimateRemaining, type HistoryModel } from '@/engine/estimator';
import { classifyText, resolveSequence } from '@/engine/milestones';
import { PRE_SHIPMENT_CODES, PRE_SHIPMENT_TEXT, lookupCode } from '@/adapters/aliexpress';
import { detectConsolidation } from '@/engine/consolidation';
import { disputeWindow } from '@/engine/dispute';
import { DAY, fmtDate, groupBy } from '@/shared/util';

let timer: ReturnType<typeof setTimeout> | null = null;
export function scheduleRecompute(delayMs = 1500) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; recomputeAll().catch((e) => console.warn('[aepi] recompute failed', e)); }, delayMs);
}

let cachedModel: HistoryModel | null = null;
export function getHistoryModel(): HistoryModel | null { return cachedModel; }

export async function buildModel(): Promise<HistoryModel> {
  const parcels = await db.parcels.toArray();
  const events = await db.events.toArray();
  const byParcel = new Map<string, TrackEvent[]>(Object.entries(groupBy(events, (e) => e.parcelId)));
  cachedModel = buildHistoryModel(parcels, byParcel);
  return cachedModel;
}

/** Orders whose ids form a tight numeric run were paid in one checkout. */
export const CHECKOUT_MAX_GAP = 1_000_000;

export async function groupCheckouts(all: Order[]): Promise<number> {
  const sorted = all.filter((o) => /^\d{10,22}$/.test(o.orderId)).sort((a, b) => Number(a.orderId) - Number(b.orderId));
  let groups = 0;
  const flush = async (cluster: Order[]) => {
    const key = cluster.length >= 2 ? `ck_${cluster[0].orderId}` : null;
    if (key) groups++;
    for (const o of cluster) if (o.checkoutGroup !== key) { await db.orders.update(o.orderId, { checkoutGroup: key }); o.checkoutGroup = key; }
  };
  let cluster: Order[] = [];
  for (const o of sorted) {
    if (!cluster.length || Number(o.orderId) - Number(cluster[cluster.length - 1].orderId) <= CHECKOUT_MAX_GAP) cluster.push(o);
    else { await flush(cluster); cluster = [o]; }
  }
  if (cluster.length) await flush(cluster);
  return groups;
}

export function stateFor(milestone: Milestone | null, stalled: boolean, delivered: boolean): ParcelState {
  if (delivered || milestone === 'DELIVERED') return 'DELIVERED';
  if (milestone === 'RETURNED') return 'RETURNED';
  if (milestone === 'EXCEPTION') return 'EXCEPTION';
  if (stalled) return 'STALLED';
  if (milestone === 'OUT_FOR_DELIVERY') return 'OUT_FOR_DELIVERY';
  if (milestone && ['ARRIVED_DEST_COUNTRY', 'IMPORT_CUSTOMS', 'HANDED_TO_LOCAL_CARRIER', 'IN_TRANSIT_LOCAL'].includes(milestone)) return 'DEST_COUNTRY';
  if (milestone) return 'IN_TRANSIT';
  return 'PENDING';
}

export async function recomputeAll(): Promise<void> {
  const now = Date.now();
  const parcels = await db.parcels.toArray();
  const events = await db.events.toArray();
  const byParcel = new Map<string, TrackEvent[]>();
  for (const e of events) (byParcel.get(e.parcelId) ?? byParcel.set(e.parcelId, []).get(e.parcelId)!).push(e);
  for (const list of byParcel.values()) list.sort((a, b) => a.timestamp - b.timestamp);

  const orders = new Map((await db.orders.toArray()).map((o) => [o.orderId, o]));
  // 0a. Checkout grouping. AliExpress splits one cart into an order per seller and allocates their
  // ids consecutively (observed step: 20000); a separate checkout jumps by ~1e11. So a numeric run
  // with small gaps is one shopping trip.
  await groupCheckouts([...orders.values()]);
  // 0. Refunds → orders: sum finished refunds per order; a (near-)full refund flips the status.
  const refunds = await db.refunds.toArray();
  const byOrder = new Map<string, typeof refunds>();
  for (const r of refunds) if (r.orderId) (byOrder.get(r.orderId) ?? byOrder.set(r.orderId, []).get(r.orderId)!).push(r);
  for (const [oid, rs] of byOrder) {
    const o = orders.get(oid);
    if (!o) continue;
    const known = rs.filter((r) => r.refundAmount != null);
    const amount = known.length ? known.reduce((s, r) => s + (r.refundAmount ?? 0), 0) : null;
    const allFinished = rs.every((r) => /FINISH|SUCCESS|COMPLETE|status 4|Request complete/i.test(`${r.refundStatus ?? ''} ${r.caseStatus ?? ''}`));
    const patch: Partial<typeof o> = {};
    if (amount != null && amount !== o.refundAmount) patch.refundAmount = amount;
    const full = amount != null && o.orderTotal != null && amount >= o.orderTotal * 0.9;
    if (allFinished && (full || (amount == null && o.status !== 'SHIPPED')) && o.status !== 'REFUNDED') patch.status = 'REFUNDED';
    if (Object.keys(patch).length) { await db.orders.update(oid, { ...patch, updatedAt: now }); Object.assign(o, patch); }
  }
  // 1. Re-classify from code/text (rules improve over time), then sequence-resolve (customs direction etc.)
  for (const p of parcels) {
    const evs = byParcel.get(p.parcelId) ?? [];
    if (!evs.length) continue;
    for (const e of evs) {
      const pre = (e.code ? PRE_SHIPMENT_CODES.test(e.code) : false) || PRE_SHIPMENT_TEXT.test(e.rawText);
      const fresh = pre ? null : (e.code ? lookupCode(e.code) : null) ?? classifyText(e.rawText);
      if (fresh !== e.milestone && (fresh !== null || pre)) { e.milestone = fresh; await db.events.update(e.eventId, { milestone: fresh }); }
    }
    const resolved = resolveSequence(evs, p.destCountry);
    for (let i = 0; i < evs.length; i++) if (resolved[i] !== evs[i].milestone && resolved[i]) { evs[i].milestone = resolved[i]; await db.events.update(evs[i].eventId, { milestone: resolved[i] }); }
  }

  // Parcels of completed orders count as delivered even when the carrier never posted a final scan.
  const orderDone = new Set<string>();
  for (const p of parcels) {
    const evsAll = byParcel.get(p.parcelId) ?? [];
    // Repair: earlier builds copied the last scan time into deliveredAt for completed orders. That is not a delivery
    // timestamp and poisons the estimator — drop it unless a real DELIVERED scan or carrier status backs it.
    const linkedNow = p.orderIds.map((id) => orders.get(id)).filter((o): o is NonNullable<typeof o> => !!o);
    const ordersFinished = linkedNow.length > 0 && linkedNow.every((o) => o.status === 'COMPLETED' || o.status === 'DELIVERED');
    if (p.deliveredAt && !evsAll.some((e) => e.milestone === 'DELIVERED') && (!ordersFinished || evsAll.some((e) => e.timestamp > p.deliveredAt! + DAY) || (evsAll.length && Math.abs(p.deliveredAt - evsAll.at(-1)!.timestamp) < 60_000))) {
      p.deliveredAt = null;
      await db.parcels.update(p.parcelId, { deliveredAt: null });
    }
    if (p.deliveredAt) continue;
    const evs = byParcel.get(p.parcelId) ?? [];
    const linked = p.orderIds.map((id) => orders.get(id)).filter((o): o is NonNullable<typeof o> => !!o);
    const done = linked.length > 0 && linked.every((o) => o.status === 'COMPLETED' || o.status === 'DELIVERED');
    const deliveredEv = evs.find((e) => e.milestone === 'DELIVERED');
    if (deliveredEv) p.deliveredAt = deliveredEv.timestamp;
    if (done) orderDone.add(p.parcelId); // delivered for display, but NOT a training sample (no real delivery timestamp)
  }
  const model = buildHistoryModel(parcels, byParcel);
  cachedModel = model;
  const groups = detectConsolidation(parcels.filter((p) => p.state !== 'DELIVERED'), byParcel);
  const prevAlerts = await db.alerts.toArray();
  const alertsById = new Map(prevAlerts.map((a) => [a.alertId, a]));
  const newAlerts: Alert[] = [];
  const settings = await db.getSettings();

  for (const p of parcels) {
    const evs = byParcel.get(p.parcelId) ?? [];
    const last = evs.at(-1) ?? null;
    const milestone = currentMilestone(evs) ?? (p.shippedAt ? 'SELLER_SHIPPED' : null);
    const lastMilestoneEvent = milestone ? evs.filter((e) => e.milestone === milestone)[0] ?? null : null;
    const delivered = !!p.deliveredAt || milestone === 'DELIVERED' || evs.some((e) => e.milestone === 'DELIVERED') || orderDone.has(p.parcelId);
    const deliveredAt = p.deliveredAt ?? evs.find((e) => e.milestone === 'DELIVERED')?.timestamp ?? null;
    const lastGeo = [...evs].reverse().find((e) => e.lat != null) ?? null;

    let stalled = false;
    let dwellP90: number | null = null;
    let pred: Prediction | null = null;
    if (!delivered && milestone && milestone !== 'RETURNED') {
      const anchor = lastMilestoneEvent?.timestamp ?? last?.timestamp ?? p.shippedAt ?? now;
      dwellP90 = estimateDwellP90(model, p.serviceKey, milestone);
      const sinceLastScan = (now - (last?.timestamp ?? anchor)) / DAY;
      stalled = sinceLastScan > dwellP90 && milestone !== 'OUT_FOR_DELIVERY' ? true : sinceLastScan > Math.max(dwellP90, 2);
      const est = estimateRemaining(model, p.serviceKey, milestone);
      // Condition on elapsed time at this node: remaining can't be less than 0 from "now".
      const elapsed = (now - anchor) / DAY;
      const adj = (q: number) => Math.max(0.1, q - elapsed * 0.5) * DAY; // partial credit: time already spent at this node shortens the remainder
      pred = { parcelId: p.parcelId, generatedAt: now, p50: now + adj(est.q.p50), p80: now + adj(est.q.p80), p95: now + adj(est.q.p95), basis: est.basis, sampleSize: est.sampleSize, milestone, stalled, dwellP90Days: dwellP90 };
      await db.predictions.put(pred);
    } else {
      await db.predictions.delete(p.parcelId);
    }
    const state = stateFor(milestone, stalled, delivered);
    const patch: Partial<Parcel> = {
      lastEventAt: last?.timestamp ?? p.lastEventAt,
      lastMilestone: milestone,
      lastLocationText: last?.locationText ?? p.lastLocationText,
      lastLat: lastGeo?.lat ?? p.lastLat,
      lastLng: lastGeo?.lng ?? p.lastLng,
      state,
      deliveredAt: deliveredAt ?? p.deliveredAt,
      shippedAt: p.shippedAt ?? evs.find((e) => e.milestone === 'SELLER_SHIPPED' || e.milestone === 'ORIGIN_ACCEPTED')?.timestamp ?? evs[0]?.timestamp ?? null,
      consolidationGroup: groups.get(p.parcelId) ?? null,
      updatedAt: now,
    };
    if (state === 'DELIVERED' || state === 'RETURNED') {
      patch.nextPollAt = Number.MAX_SAFE_INTEGER;
      for (const a of prevAlerts) if (a.parcelId === p.parcelId && !a.dismissed && (a.kind === 'stalled' || a.kind === 'late' || a.kind === 'dispute_deadline' || a.kind === 'exception')) await db.alerts.update(a.alertId, { dismissed: true });
    }
    await db.parcels.update(p.parcelId, patch);

    // ── Alerts ──
    const order = p.orderIds.map((id) => orders.get(id)).find(Boolean);
    const label = order ? `Order ${order.orderId.slice(-6)}` : p.trackingNo;
    if (p.state !== 'DELIVERED' && state === 'DELIVERED' && deliveredAt && now - deliveredAt < 3 * DAY) newAlerts.push(mk('delivered', p, order?.orderId, 'info', `Delivered: ${label}`, `${p.trackingNo} was delivered ${fmtDate(deliveredAt)}.`));
    if (milestone && p.lastMilestone !== milestone && !delivered && p.lastMilestone !== null && last && now - last.timestamp < 3 * DAY) newAlerts.push(mk('milestone', p, order?.orderId, 'info', `${label}: ${MILESTONE_LABEL[milestone]}`, last?.rawText ?? ''));
    if (stalled && p.state !== 'STALLED' && last && now - last.timestamp < 60 * DAY) newAlerts.push(mk('stalled', p, order?.orderId, 'warn', `Stalled: ${label}`, `No scan for ${Math.round((now - (last?.timestamp ?? now)) / DAY)} days at "${milestone ? MILESTONE_LABEL[milestone] : '?'}" (P90 dwell ${dwellP90?.toFixed(1)}d).`));
    if (state === 'EXCEPTION' && p.state !== 'EXCEPTION') newAlerts.push(mk('exception', p, order?.orderId, 'warn', `Exception: ${label}`, last?.rawText ?? 'Carrier reported an exception.'));
    if (order && !delivered) {
      const dw = disputeWindow(order, p, now);
      if (dw && dw.urgency !== 'none') {
        const late = pred ? pred.p50 > dw.deadline : false;
        const sev: Alert['severity'] = dw.urgency === 'urgent' || (late && dw.urgency === 'soon') ? 'urgent' : 'warn';
        const id = `dispute:${p.parcelId}:${Math.ceil(dw.daysLeft)}`;
        if (!alertsById.has(id)) newAlerts.push({ alertId: id, kind: 'dispute_deadline', parcelId: p.parcelId, orderId: order.orderId, severity: sev, title: `${Math.max(0, Math.floor(dw.daysLeft))} days left to open a dispute — ${label}`, body: `${dw.estimated ? 'Estimated ' : ''}buyer protection ends ${fmtDate(dw.deadline)}.${late ? ' Predicted delivery is AFTER the deadline.' : ''}`, createdAt: now, dismissed: false, notified: false });
      }
      if (order.promisedDeliveryAt && pred && pred.p50 > order.promisedDeliveryAt + DAY && now > order.promisedDeliveryAt) {
        const id = `late:${p.parcelId}`;
        if (!alertsById.has(id)) newAlerts.push({ alertId: id, kind: 'late', parcelId: p.parcelId, orderId: order.orderId, severity: 'warn', title: `Running late — ${label}`, body: `AliExpress promised ${fmtDate(order.promisedDeliveryAt)}; your history says P50 ${fmtDate(pred.p50)}.`, createdAt: now, dismissed: false, notified: false });
      }
    }
  }
  if (settings.loggedOut && !alertsById.has('logged_out')) newAlerts.push({ alertId: 'logged_out', kind: 'logged_out', parcelId: null, orderId: null, severity: 'warn', title: 'Sign in to AliExpress to resume syncing.', body: 'The last sync hit a login page. Open aliexpress.com, sign in, then sync again.', createdAt: now, dismissed: false, notified: true });
  if (!settings.loggedOut && alertsById.has('logged_out')) await db.alerts.delete('logged_out');

  for (const a of newAlerts) {
    if (alertsById.has(a.alertId)) continue;
    await db.alerts.put(a);
    if (settings.notifications && !a.notified && a.kind !== 'milestone') notify(a);
  }
}

function mk(kind: Alert['kind'], p: Parcel, orderId: string | undefined, severity: Alert['severity'], title: string, body: string): Alert {
  return { alertId: `${kind}:${p.parcelId}:${Math.floor(Date.now() / (6 * 3600_000))}`, kind, parcelId: p.parcelId, orderId: orderId ?? null, severity, title, body, createdAt: Date.now(), dismissed: false, notified: false };
}

function notify(a: Alert) {
  try {
    chrome.notifications?.create(a.alertId, { type: 'basic', iconUrl: chrome.runtime.getURL('icon128.png'), title: a.title, message: a.body.slice(0, 200), priority: a.severity === 'urgent' ? 2 : 0 }, () => { void chrome.runtime.lastError; });
    void db.alerts.update(a.alertId, { notified: true });
  } catch { /* notifications unavailable */ }
}
