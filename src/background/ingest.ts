/**
 * Ingest: takes a parsed bundle from the adapter and merges it into Dexie.
 * Also maintains the endpoint registry so direct fetches can learn URL shapes.
 */
import { db } from '@/db/schema';
import type { CaptureLogEntry, Item, Order, Parcel, Refund, TrackEvent } from '@/model/types';
import type { ParsedBundle, RawTrackingEvent } from '@/adapters/aliexpress';
import { bodyHasPageIndex, detectPageParam, endpointKey, parsePayload, serviceKeyFor } from '@/adapters/aliexpress';
import { gazetteerLookup } from './geocode';
import { classifyText } from '@/engine/milestones';
import { fnv1a, uniq } from '@/shared/util';
import { scheduleRecompute } from './recompute';

export interface IngestStats { orders: number; items: number; parcels: number; events: number; refunds?: number; loginRequired: boolean }

export async function ingestCapture(url: string, method: string, body: string, via: string, reqBody: string | null = null): Promise<IngestStats> {
  const bundle = parsePayload(url, body);
  await recordEndpoint(url, method, bundle, reqBody);
  let stats: IngestStats;
  if (bundle.loginRequired) {
    await db.patchSettings({ loggedOut: true });
    stats = { orders: 0, items: 0, parcels: 0, events: 0, loginRequired: true };
  } else {
    stats = await ingestBundle(bundle, 'aliexpress');
    if (stats.orders || stats.events) await db.patchSettings({ loggedOut: false });
  }
  await appendCaptureLog({ ts: Date.now(), path: endpointKey(url), via, method, bytes: body.length, ...stats });
  return stats;
}

export async function appendCaptureLog(entry: CaptureLogEntry) {
  const log = await db.getKV<CaptureLogEntry[]>('captureLog', []);
  log.push(entry);
  await db.setKV('captureLog', log.slice(-40));
}

export async function recordEndpoint(url: string, method: string, bundle: ParsedBundle, reqBody: string | null = null) {
  if (!/^https?:/.test(url) || url.includes('#')) return;
  const key = endpointKey(url);
  const useful = bundle.orders.length + bundle.events.length + bundle.freight.length + bundle.parcels.length;
  const prev = await db.endpoints.get(key);
  if (!useful && !prev) return;
  const kind = bundle.kind === 'unknown' && bundle.orders.length ? 'orderList' : bundle.kind === 'unknown' && bundle.events.length ? 'tracking' : bundle.kind;
  // Prefer a template that can be replayed for pagination: a POST body carrying pageIndex beats the initial GET.
  const bodyPaged = bodyHasPageIndex(reqBody);
  const keepPrev = !!prev?.bodyTemplate && prev.pageParam === 'body.pageIndex' && !bodyPaged;
  await db.endpoints.put({
    key,
    kind,
    urlTemplate: useful && !keepPrev ? url : prev?.urlTemplate ?? url,
    method: keepPrev ? prev!.method : method,
    hits: (prev?.hits ?? 0) + 1,
    lastSeenAt: Date.now(),
    lastOrders: bundle.orders.length,
    lastEvents: bundle.events.length,
    pageParam: bodyPaged ? 'body.pageIndex' : keepPrev ? prev!.pageParam : detectPageParam(url) ?? prev?.pageParam ?? null,
    bodyTemplate: bodyPaged ? reqBody : keepPrev ? prev!.bodyTemplate : useful && reqBody ? reqBody : prev?.bodyTemplate ?? null,
  });
}

export async function ingestBundle(bundle: ParsedBundle, source: TrackEvent['source']): Promise<IngestStats> {
  const now = Date.now();
  const stats: IngestStats = { orders: 0, items: 0, parcels: 0, events: 0, loginRequired: false };
  if (bundle.refunds.length) {
    let n = 0;
    for (const h of bundle.refunds) {
      const prev = await db.refunds.get(h.refundId);
      const merged: Refund = { ...(prev ?? { refundId: h.refundId, reverseOrderId: null, orderId: null, orderLineId: null, itemTitle: null, itemImageUrl: null, itemUnitPrice: null, itemCount: null, currency: null, refundAmount: null, refundStatus: null, caseStatus: null, reverseType: null, solutionText: null, reason: null, requestedAt: null, finishedAt: null, updatedAt: 0 }), updatedAt: now };
      for (const k of Object.keys(h) as (keyof typeof h)[]) { if (k === 'detailed') continue; const v = h[k]; if (v != null && (h.detailed || (merged as unknown as Record<string, unknown>)[k] == null)) (merged as unknown as Record<string, unknown>)[k] = v; }
      await db.refunds.put(merged); n++;
    }
    stats.refunds = n;
    scheduleRecompute();
  }
  if (!bundle.orders.length && !bundle.parcels.length && !bundle.events.length && !bundle.protectionEndsAt) return stats;

  await db.transaction('rw', [db.orders, db.items, db.parcels, db.events], async () => {
    // Orders: merge, never clobber known values with nulls
    for (const o of bundle.orders) {
      const prev = await db.orders.get(o.orderId);
      const merged: Order = prev ? mergeOrder(prev, o) : o;
      await db.orders.put(merged);
      stats.orders++;
    }
    for (const it of bundle.items) {
      const prev = await db.items.get(it.itemId);
      await db.items.put(prev ? { ...prev, ...stripNulls(it) } as Item : it);
      stats.items++;
    }
    // Order-level facts carried by tracking payloads (promised ETA, protection deadline)
    const ctxOrderId = bundle.contextOrderId ?? bundle.parcels.find((p) => p.orderId)?.orderId ?? null;
    if (ctxOrderId) {
      const o = await db.orders.get(ctxOrderId);
      const promised = bundle.parcels.map((p) => p.promisedAt).find((x): x is number => !!x) ?? null;
      if (o) {
        const patch: Partial<Order> = {};
        if (bundle.protectionEndsAt && (!o.protectionEndsAt || Math.abs(o.protectionEndsAt - bundle.protectionEndsAt) > 3_600_000)) patch.protectionEndsAt = bundle.protectionEndsAt;
        if (promised && !o.promisedDeliveryAt) patch.promisedDeliveryAt = promised;
        const tns = uniq([...o.trackingNos, ...bundle.parcels.map((p) => p.trackingNo)]);
        if (tns.length !== o.trackingNos.length) patch.trackingNos = tns;
        if (Object.keys(patch).length) await db.orders.update(ctxOrderId, { ...patch, updatedAt: now });
      }
    }
    // Parcels
    for (const hint of bundle.parcels) {
      const id = hint.trackingNo;
      const prev = await db.parcels.get(id);
      const orderIds = uniq([...(prev?.orderIds ?? []), ...(hint.orderId ? [hint.orderId] : [])]);
      // Resolve product ids → item ids of the linked order(s)
      let resolved: string[] = [];
      if (hint.productIds.length && orderIds.length) {
        const orderItems = await db.items.where('orderId').anyOf(orderIds).toArray();
        resolved = orderItems.filter((i) => i.productId && hint.productIds.includes(i.productId)).map((i) => i.itemId);
        for (const i of orderItems) if (i.productId && hint.productIds.includes(i.productId) && !i.trackingNo) await db.items.update(i.itemId, { trackingNo: id });
      }
      const itemIds = uniq([...(prev?.itemIds ?? []), ...hint.itemIds, ...resolved]);
      const service = hint.logisticsService ?? prev?.logisticsService ?? null;
      const p: Parcel = {
        parcelId: id,
        trackingNo: id,
        orderIds,
        itemIds,
        logisticsService: service,
        serviceKey: serviceKeyFor(service),
        shipFromRegion: hint.shipFromRegion ?? prev?.shipFromRegion ?? null,
        destCountry: hint.destCountry ?? prev?.destCountry ?? null,
        shippedAt: prev?.shippedAt ?? hint.shippedAt ?? null,
        deliveredAt: prev?.deliveredAt ?? hint.deliveredAt ?? null,
        lastEventAt: prev?.lastEventAt ?? null,
        lastMilestone: prev?.lastMilestone ?? null,
        lastLocationText: prev?.lastLocationText ?? null,
        lastLat: prev?.lastLat ?? null,
        lastLng: prev?.lastLng ?? null,
        state: prev?.state ?? (hint.deliveredAt ? 'DELIVERED' : 'PENDING'),
        nextPollAt: prev?.nextPollAt ?? now,
        pollFailures: prev?.pollFailures ?? 0,
        consolidationGroup: prev?.consolidationGroup ?? null,
        updatedAt: now,
      };
      await db.parcels.put(p);
      stats.parcels++;
    }
    // Events from AliExpress logistics payloads (events without a tracking no. belong to the single parcel of this payload)
    const soleTn = bundle.parcels.length === 1 ? bundle.parcels[0].trackingNo : null;
    stats.events += await upsertEvents(bundle.events.map((e) => (e.trackingNo ? e : { ...e, trackingNo: soleTn })), source);
  });
  // Receiver address → home (only when the user hasn't set one)
  if (bundle.receiver?.city) {
    const s = await db.getSettings();
    if (!s.homeAddressCoords) {
      const label = [bundle.receiver.city, bundle.receiver.province, bundle.receiver.country].filter(Boolean).join(', ');
      const g = gazetteerLookup(bundle.receiver.city) ?? gazetteerLookup(label);
      await db.patchSettings({ homeAddress: label, homeAddressCoords: g ? { lat: g.lat, lng: g.lng } : null });
    }
  }
  scheduleRecompute();
  return stats;
}

export async function upsertEvents(raw: RawTrackingEvent[], source: TrackEvent['source']): Promise<number> {
  let n = 0;
  for (const ev of raw) {
    if (!ev.trackingNo) continue;
    const parcelId = ev.trackingNo.toUpperCase();
    const eventId = `${parcelId}:${ev.timestamp}:${fnv1a(ev.rawText)}`;
    const exists = await db.events.get(eventId);
    if (exists) continue;
    const milestone = ev.preShipment ? null : ev.codeMilestone ?? classifyText(ev.rawText);
    await db.events.put({ eventId, parcelId, timestamp: ev.timestamp, rawText: ev.rawText, locationText: ev.locationText, milestone, lat: null, lng: null, geoConfidence: null, source, code: ev.code });
    // Ensure a parcel row exists even when only tracking data arrived
    const p = await db.parcels.get(parcelId);
    if (!p) {
      await db.parcels.put({ parcelId, trackingNo: parcelId, orderIds: [], itemIds: [], logisticsService: null, serviceKey: 'unknown', shipFromRegion: null, destCountry: null, shippedAt: null, deliveredAt: null, lastEventAt: null, lastMilestone: null, lastLocationText: null, lastLat: null, lastLng: null, state: 'PENDING', nextPollAt: Date.now(), pollFailures: 0, consolidationGroup: null, updatedAt: Date.now() });
    }
    n++;
  }
  return n;
}

function stripNulls<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] != null && o[k] !== '') out[k] = o[k];
  return out;
}

function mergeOrder(prev: Order, next: Order): Order {
  const merged = { ...prev, ...stripNulls(next) } as Order;
  merged.trackingNos = uniq([...(prev.trackingNos ?? []), ...(next.trackingNos ?? [])]);
  if (next.status === 'UNKNOWN') merged.status = prev.status;
  return merged;
}
