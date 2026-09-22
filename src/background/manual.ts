/**
 * Everything the user records by hand: parcels from other stores, items captured from a page, and
 * overriding a parcel's state when the carrier never will.
 */
import { db } from '@/db/schema';
import type { Item, ManualState, Order, Parcel, Platform } from '@/model/types';
import { detectCarrier } from '@/engine/carriers';
import { isAbandoned, recomputeAll, scheduleRecompute } from './recompute';

export interface ManualParcelInput {
  trackingNo?: string | null;
  title?: string | null;
  platform?: Platform;
  carrier?: string | null;
  price?: number | null;
  currency?: string | null;
  imageUrl?: string | null;
  sourceUrl?: string | null;
  orderId?: string | null;
  seller?: string | null;
  placedAt?: number | null;
}

const rid = () => Math.random().toString(36).slice(2, 8);

/**
 * Record a purchase and, when there's a tracking number, the parcel carrying it. Works with only a
 * title and a price (for spend tracking) or only a tracking number (for delivery tracking).
 */
export async function addManualParcel(input: ManualParcelInput): Promise<{ orderId: string; parcelId: string | null; carrier: string | null }> {
  const now = Date.now();
  const platform: Platform = input.platform ?? 'other';
  const tn = (input.trackingNo ?? '').trim().toUpperCase().replace(/[\s-]/g, '') || null;
  if (!tn && !input.title) throw new Error('needs at least a tracking number or a title');

  const orderId = (input.orderId ?? '').trim() || `m_${platform}_${now.toString(36)}${rid()}`;
  const existing = await db.orders.get(orderId);
  const order: Order = {
    ...(existing ?? {} as Order),
    orderId,
    platform,
    manual: true,
    sourceUrl: input.sourceUrl ?? existing?.sourceUrl ?? null,
    placedAt: input.placedAt ?? existing?.placedAt ?? now,
    sellerId: existing?.sellerId ?? null,
    sellerName: input.seller ?? existing?.sellerName ?? null,
    status: tn ? 'SHIPPED' : 'AWAITING_SHIPMENT',
    rawStatus: existing?.rawStatus ?? null,
    currency: input.currency ?? existing?.currency ?? 'USD',
    itemsSubtotal: input.price ?? existing?.itemsSubtotal ?? null,
    shippingCost: existing?.shippingCost ?? null,
    discount: existing?.discount ?? null,
    tax: existing?.tax ?? null,
    orderTotal: input.price ?? existing?.orderTotal ?? null,
    promisedDeliveryAt: existing?.promisedDeliveryAt ?? null,
    protectionEndsAt: existing?.protectionEndsAt ?? null,
    refundAmount: existing?.refundAmount ?? null,
    paymentMethod: existing?.paymentMethod ?? null,
    checkoutGroup: existing?.checkoutGroup ?? null,
    trackingNos: tn ? [tn] : existing?.trackingNos ?? [],
    updatedAt: now,
  };
  await db.orders.put(order);

  const itemId = `${orderId}:manual`;
  if (input.title) {
    const item: Item = {
      itemId, orderId, productId: null, title: input.title.slice(0, 300), sku: null, qty: 1,
      unitPrice: input.price ?? null, currency: order.currency, imageUrl: input.imageUrl ?? null, trackingNo: tn,
    };
    await db.items.put(item);
  }

  let parcelId: string | null = null;
  let carrierKey: string | null = null;
  if (tn) {
    const guess = detectCarrier(tn, input.carrier);
    carrierKey = input.carrier ?? guess.carrier.key;
    const prev = await db.parcels.get(tn);
    const parcel: Parcel = {
      ...(prev ?? {} as Parcel),
      parcelId: tn, trackingNo: tn, platform,
      carrier: carrierKey,
      manual: true,
      title: input.title ?? prev?.title ?? null,
      imageUrl: input.imageUrl ?? prev?.imageUrl ?? null,
      manualState: prev?.manualState ?? null,
      manualStateAt: prev?.manualStateAt ?? null,
      orderIds: [...new Set([...(prev?.orderIds ?? []), orderId])],
      itemIds: [...new Set([...(prev?.itemIds ?? []), ...(input.title ? [itemId] : [])])],
      logisticsService: prev?.logisticsService ?? guess.carrier.name,
      serviceKey: prev?.serviceKey ?? carrierKey,
      shipFromRegion: prev?.shipFromRegion ?? null,
      destCountry: prev?.destCountry ?? guess.country ?? null,
      shippedAt: prev?.shippedAt ?? input.placedAt ?? now,
      deliveredAt: prev?.deliveredAt ?? null,
      lastEventAt: prev?.lastEventAt ?? null,
      lastMilestone: prev?.lastMilestone ?? null,
      lastLocationText: prev?.lastLocationText ?? null,
      lastLat: prev?.lastLat ?? null, lastLng: prev?.lastLng ?? null,
      state: prev?.state ?? 'PENDING',
      // Only Cainiao numbers can be polled; the rest sit until the user opens the carrier's page.
      nextPollAt: guess.carrier.pollable ? now : Number.MAX_SAFE_INTEGER,
      pollFailures: prev?.pollFailures ?? 0,
      consolidationGroup: prev?.consolidationGroup ?? null,
      updatedAt: now,
    };
    await db.parcels.put(parcel);
    parcelId = tn;
  }
  scheduleRecompute(500);
  return { orderId, parcelId, carrier: carrierKey };
}

/** Mark a parcel delivered / lost / archived, or clear the override with null. */
export async function setParcelState(parcelId: string, state: ManualState | null): Promise<void> {
  const p = await db.parcels.get(parcelId);
  if (!p) throw new Error('no such parcel');
  const now = Date.now();
  await db.parcels.update(parcelId, {
    manualState: state,
    manualStateAt: state ? now : null,
    // A hand-marked delivery has no real arrival time; recompute keeps it out of the estimator.
    deliveredAt: state === 'delivered' ? p.deliveredAt ?? now : state ? p.deliveredAt : p.deliveredAt,
    nextPollAt: state ? Number.MAX_SAFE_INTEGER : now,
    pollFailures: 0,
    updatedAt: now,
  });
  // Clear alerts that no longer make sense.
  if (state) {
    for (const a of await db.alerts.where('parcelId').equals(parcelId).toArray()) {
      if (!a.dismissed) await db.alerts.update(a.alertId, { dismissed: true });
    }
  }
  await recomputeAll();
}

/** Parcels the carrier appears to have abandoned — old, still "active", no recent scan. */
export async function listAbandoned(): Promise<Parcel[]> {
  const now = Date.now();
  return (await db.parcels.toArray()).filter((p) => isAbandoned(p, now));
}

export async function closeAbandoned(state: ManualState = 'archived'): Promise<number> {
  const list = await listAbandoned();
  const now = Date.now();
  for (const p of list) {
    await db.parcels.update(p.parcelId, { manualState: state, manualStateAt: now, nextPollAt: Number.MAX_SAFE_INTEGER, updatedAt: now });
    for (const a of await db.alerts.where('parcelId').equals(p.parcelId).toArray()) {
      if (!a.dismissed) await db.alerts.update(a.alertId, { dismissed: true });
    }
  }
  if (list.length) await recomputeAll();
  return list.length;
}
