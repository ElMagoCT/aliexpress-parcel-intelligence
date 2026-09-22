import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } }, permissions: { contains: async () => false }, runtime: { getURL: (p: string) => p, getManifest: () => ({}) }, alarms: { create: () => {}, clear: () => {} }, notifications: { create: () => {} } });
import { classifyText, resolveSequence } from '@/engine/milestones';
import { blend, buildHistoryModel, estimateDwellP90, estimateRemaining, estimateTotal, quantile, PRIOR_REMAINING } from '@/engine/estimator';
import { detectConsolidation } from '@/engine/consolidation';
import { disputeWindow } from '@/engine/dispute';
import type { Parcel, TrackEvent } from '@/model/types';
import { DAY } from '@/shared/util';

describe('milestone rules', () => {
  const cases: [string, string][] = [
    ['Shipment information received', 'SELLER_SHIPPED'], ['Seller has shipped your order', 'SELLER_SHIPPED'],
    ['Received by logistics company', 'ORIGIN_ACCEPTED'], ['Arrived at sorting center [Shenzhen]', 'ORIGIN_ACCEPTED'], ['Package picked up', 'ORIGIN_ACCEPTED'],
    ['Departed from sorting center', 'ORIGIN_DEPARTED'], ['Left origin facility', 'ORIGIN_DEPARTED'], ['Handed over to linehaul', 'ORIGIN_DEPARTED'],
    ['Export customs clearance completed', 'EXPORT_CUSTOMS'], ['Cleared customs', 'EXPORT_CUSTOMS'],
    ['Departed from country of origin', 'DEPARTED_ORIGIN_COUNTRY'], ['Flight has departed', 'DEPARTED_ORIGIN_COUNTRY'], ['Hand over to airline', 'DEPARTED_ORIGIN_COUNTRY'],
    ['Arrived at destination country', 'ARRIVED_DEST_COUNTRY'], ['Processed Through Facility ISC LOS ANGELES CA (USPS)', 'ARRIVED_DEST_COUNTRY'], ['Arrived in the United States', 'ARRIVED_DEST_COUNTRY'],
    ['Import customs clearance completed', 'IMPORT_CUSTOMS'], ['Held by customs', 'IMPORT_CUSTOMS'],
    ['Handed over to local carrier', 'HANDED_TO_LOCAL_CARRIER'], ['Delivered to local carrier', 'HANDED_TO_LOCAL_CARRIER'], ['Accepted by USPS', 'HANDED_TO_LOCAL_CARRIER'], ['USPS in possession of item', 'HANDED_TO_LOCAL_CARRIER'],
    ['Arrived at USPS Regional Facility', 'IN_TRANSIT_LOCAL'], ['In transit to next facility', 'IN_TRANSIT_LOCAL'], ['Arrived at Post Office', 'IN_TRANSIT_LOCAL'],
    ['Out for Delivery', 'OUT_FOR_DELIVERY'], ['Available for pickup', 'OUT_FOR_DELIVERY'], ['Delivery attempted', 'OUT_FOR_DELIVERY'],
    ['Delivered, In/At Mailbox', 'DELIVERED'], ['Delivered', 'DELIVERED'], ['Package was received by recipient', 'DELIVERED'], ['Signed', 'DELIVERED'],
    ['Delivery failed: incorrect address', 'EXCEPTION'], ['Returned to sender', 'RETURNED'], ['Parcel is being returned', 'RETURNED'],
  ];
  for (const [text, m] of cases) it(`"${text}" → ${m}`, () => expect(classifyText(text)).toBe(m));
  it('returns null for gibberish', () => expect(classifyText('lorem ipsum dolor')).toBeNull());
  it('resolves customs direction from sequence', () => {
    const seq = [
      { milestone: 'ORIGIN_ACCEPTED', rawText: 'a', locationText: 'Shenzhen' }, { milestone: 'EXPORT_CUSTOMS', rawText: 'Customs clearance completed', locationText: 'Shenzhen' },
      { milestone: 'DEPARTED_ORIGIN_COUNTRY', rawText: 'c', locationText: 'HK' }, { milestone: 'ARRIVED_DEST_COUNTRY', rawText: 'd', locationText: 'Chicago' },
      { milestone: 'EXPORT_CUSTOMS', rawText: 'Customs clearance completed', locationText: 'Chicago' }, { milestone: 'IN_TRANSIT_LOCAL', rawText: 'e', locationText: 'Chicago' },
    ] as const;
    const r = resolveSequence(seq.map((s) => ({ ...s })), 'US');
    expect(r[1]).toBe('EXPORT_CUSTOMS');
    expect(r[4]).toBe('IMPORT_CUSTOMS');
  });
});

function mkParcel(id: string, serviceKey: string, shippedAt: number, deliveredAt: number | null): Parcel {
  return { parcelId: id, trackingNo: id, orderIds: [], itemIds: [], logisticsService: serviceKey, serviceKey, shipFromRegion: 'CN', destCountry: 'US', shippedAt, deliveredAt, lastEventAt: null, lastMilestone: null, lastLocationText: null, lastLat: null, lastLng: null, state: deliveredAt ? 'DELIVERED' : 'IN_TRANSIT', nextPollAt: 0, pollFailures: 0, consolidationGroup: null, updatedAt: 0 };
}
function ev(parcelId: string, t: number, milestone: TrackEvent['milestone'], loc = 'x'): TrackEvent {
  return { eventId: `${parcelId}:${t}`, parcelId, timestamp: t, rawText: milestone ?? '', locationText: loc, milestone, lat: null, lng: null, geoConfidence: null, source: 'cainiao' };
}

describe('estimator', () => {
  it('quantiles + shrinkage blend', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    const b = blend({ p50: 10, p80: 12, p95: 14 }, 8, { p50: 20, p80: 24, p95: 30 });
    expect(b.p50).toBeCloseTo(15); // weight 8/(8+8) = .5
    expect(b.p80).toBeGreaterThanOrEqual(b.p50);
  });
  it('falls back to priors with no history, learns from delivered parcels', () => {
    const prior = estimateRemaining(null, 'x', 'ARRIVED_DEST_COUNTRY');
    expect(prior.q).toEqual(PRIOR_REMAINING.ARRIVED_DEST_COUNTRY);
    const t0 = Date.UTC(2026, 0, 1);
    const parcels: Parcel[] = [];
    const events = new Map<string, TrackEvent[]>();
    for (let i = 0; i < 20; i++) {
      const id = `P${i}`;
      const delivered = t0 + (20 + (i % 5)) * DAY;
      parcels.push(mkParcel(id, 'aliexpress_standard_shipping', t0, delivered));
      events.set(id, [ev(id, t0, 'SELLER_SHIPPED'), ev(id, t0 + 2 * DAY, 'DEPARTED_ORIGIN_COUNTRY'), ev(id, t0 + 14 * DAY, 'ARRIVED_DEST_COUNTRY'), ev(id, delivered, 'DELIVERED')]);
    }
    const model = buildHistoryModel(parcels, events);
    expect(model.deliveredParcels).toBe(20);
    const est = estimateRemaining(model, 'aliexpress_standard_shipping', 'ARRIVED_DEST_COUNTRY');
    // empirical remaining is 6–10 days (median 8), prior p50 6 → blended near 8 with weight 20/28
    expect(est.sampleSize).toBe(20);
    expect(est.q.p50).toBeGreaterThan(6.5);
    expect(est.q.p50).toBeLessThan(9);
    expect(est.basis).toMatch(/20 of your/);
    // Service with no history falls back to pooled (same numbers here)
    const other = estimateRemaining(model, 'yanwen', 'ARRIVED_DEST_COUNTRY');
    expect(other.sampleSize).toBe(0);
    expect(other.pooledSize).toBe(20);
    const dwell = estimateDwellP90(model, 'aliexpress_standard_shipping', 'DEPARTED_ORIGIN_COUNTRY');
    expect(dwell).toBeGreaterThan(9); // observed 12d dwell pulls the prior P90 (~13.7) — stays in that range
    const tot = estimateTotal(model, 'aliexpress_standard_shipping');
    expect(tot.basis).toBe('service');
    expect(tot.q.p50).toBeGreaterThan(19);
    expect(tot.q.p50).toBeLessThan(24);
    expect(tot.p20).toBeLessThanOrEqual(tot.q.p50);
  });
});

describe('consolidation + dispute', () => {
  it('groups parcels whose scans travel together', () => {
    const t0 = Date.UTC(2026, 5, 1);
    const a = mkParcel('A', 's', t0, null), b = mkParcel('B', 's', t0, null), c = mkParcel('C', 's', t0, null);
    const shared = [ev('A', t0, 'ORIGIN_ACCEPTED', 'Shenzhen'), ev('A', t0 + DAY, 'ORIGIN_DEPARTED', 'Shenzhen'), ev('A', t0 + 3 * DAY, 'DEPARTED_ORIGIN_COUNTRY', 'HK'), ev('A', t0 + 9 * DAY, 'ARRIVED_DEST_COUNTRY', 'LA')];
    const events = new Map<string, TrackEvent[]>([
      ['A', shared], ['B', shared.map((e) => ({ ...e, parcelId: 'B', eventId: 'B' + e.timestamp }))],
      ['C', [ev('C', t0 + 5 * DAY, 'ORIGIN_ACCEPTED', 'Yiwu'), ev('C', t0 + 6 * DAY, 'ORIGIN_DEPARTED', 'Yiwu'), ev('C', t0 + 8 * DAY, 'DEPARTED_ORIGIN_COUNTRY', 'Shanghai')]],
    ]);
    const g = detectConsolidation([a, b, c], events);
    expect(g.get('A')).toBeDefined();
    expect(g.get('A')).toBe(g.get('B'));
    expect(g.get('C')).toBeUndefined();
  });
  it('computes dispute windows with estimation flag', () => {
    const now = Date.UTC(2026, 8, 20);
    const order = { orderId: '1', placedAt: now - 50 * DAY, sellerId: null, sellerName: null, status: 'SHIPPED' as const, rawStatus: null, currency: 'USD', itemsSubtotal: 1, shippingCost: 0, discount: 0, tax: 0, orderTotal: 1, promisedDeliveryAt: null, protectionEndsAt: null, refundAmount: null, paymentMethod: null, checkoutGroup: null, trackingNos: [], updatedAt: now };
    const dw = disputeWindow(order, mkParcel('P', 'aliexpress_standard_shipping', now - 48 * DAY, null), now)!;
    expect(dw.estimated).toBe(true);
    expect(Math.round(dw.daysLeft)).toBe(12);
    expect(dw.urgency).toBe('watch');
    const dw2 = disputeWindow({ ...order, protectionEndsAt: now + 2 * DAY }, null, now)!;
    expect(dw2.estimated).toBe(false);
    expect(dw2.urgency).toBe('urgent');
    expect(disputeWindow({ ...order, status: 'COMPLETED' }, null, now)).toBeNull();
  });
});

describe('checkout grouping', () => {
  it('splits real AliExpress order ids into shopping trips', async () => {
    // Synthetic ids with the structure observed on a live account: one cart split per seller gets
    // consecutive ids (step 20000, sometimes skipping a slot); a different checkout jumps by ~1e11.
    const ids = [
      '8000111222400000', '8000111222420000', '8000111222440000', '8000111222460000', '8000111222500000', '8000111222520000',
      '8000999888450000',
      '8000222333010000', '8000222333030000', '8000222333070000', '8000222333270000', '8000222333530000',
    ];
    const { groupCheckouts } = await import('@/background/recompute');
    const { db } = await import('@/db/schema');
    await db.orders.clear();
    const rows = ids.map((orderId) => ({ ...mkOrderRow(orderId) }));
    await db.orders.bulkPut(rows);
    await groupCheckouts(rows);
    const after = await db.orders.toArray();
    const groups = new Map<string, number>();
    for (const o of after) if (o.checkoutGroup) groups.set(o.checkoutGroup, (groups.get(o.checkoutGroup) ?? 0) + 1);
    expect([...groups.values()].sort((a, b) => a - b)).toEqual([5, 6]); // 6-order trip + 5-order trip
    expect(after.find((o) => o.orderId === '8000999888450000')!.checkoutGroup).toBeNull(); // lone checkout
    const tripA = after.filter((o) => o.orderId.startsWith('8000111222'));
    expect(tripA).toHaveLength(6);
    expect(new Set(tripA.map((o) => o.checkoutGroup)).size).toBe(1); // all six land in one trip
  });
});

function mkOrderRow(orderId: string) {
  return { orderId, placedAt: Date.UTC(2026, 8, 13), sellerId: null, sellerName: null, status: 'COMPLETED' as const, rawStatus: null, currency: 'USD', itemsSubtotal: 1, shippingCost: null, discount: null, tax: null, orderTotal: 1, promisedDeliveryAt: null, protectionEndsAt: null, refundAmount: null, paymentMethod: null, checkoutGroup: null, trackingNos: [], updatedAt: 0 };
}
