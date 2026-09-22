/**
 * Standalone preview support: when the dashboard is opened outside the extension (plain
 * browser tab via `npm run preview:dashboard`) seed a realistic demo dataset so every view
 * can be exercised and screenshotted. Never runs inside the extension.
 */
import { db } from '@/db/schema';
import type { Item, Order, Parcel, TrackEvent } from '@/model/types';
import { classifyText } from '@/engine/milestones';
import { gazetteerLookup, extractLocationFromText } from '@/background/geocode';
import { recomputeAll } from '@/background/recompute';
import { fnv1a, DAY, HOUR } from '@/shared/util';
import { inExtension } from './bg';

type Leg = [daysAgo: number, text: string, loc: string];

const LEGS = {
  standard: (d: number): Leg[] => [
    [d, 'Shipment information received', 'Shenzhen'], [d - 1, 'Package received by carrier — arrived at sorting center', 'Shenzhen'],
    [d - 2, 'Departed from sorting center', 'Shenzhen'], [d - 3, 'Export customs clearance completed', 'Hong Kong'],
    [d - 4, 'Departed from country of origin', 'Hong Kong'], [d - 9, 'Arrived at destination country — Processed Through Facility ISC LOS ANGELES CA (USPS)', 'ISC Los Angeles CA(USPS)'],
    [d - 10, 'Import customs clearance completed', 'Los Angeles'], [d - 11, 'Handed over to local carrier — Accepted by USPS', 'Los Angeles CA'],
    [d - 12, 'Arrived at USPS Regional Facility', 'Chicago IL'], [d - 13, 'Arrived at Post Office', 'Chicago IL'],
    [d - 13.5, 'Out for Delivery', 'Chicago IL'], [d - 13.7, 'Delivered, In/At Mailbox', 'Chicago IL'],
  ],
  eu: (d: number): Leg[] => [
    [d, 'Shipment information received', 'Yiwu'], [d - 1, 'Arrived at sorting center', 'Yiwu'], [d - 2, 'Departed from sorting center', 'Hangzhou'],
    [d - 3, 'Export customs clearance completed', 'Hangzhou'], [d - 4, 'Departed from country of origin', 'Shanghai'], [d - 8, 'Arrived at destination country', 'Liège'],
    [d - 9, 'Import customs clearance completed', 'Liège'], [d - 10, 'Handed over to local carrier', 'Frankfurt'], [d - 11, 'Arrived at delivery depot', 'Munich'], [d - 12, 'Out for delivery', 'Munich'], [d - 12.3, 'Delivered', 'Munich'],
  ],
};

function tnGen(i: number) { return `LP00${(123456789 + i * 7919).toString().padStart(9, '0')}`; }

export async function ensureDemoIfStandalone() {
  if (inExtension) return;
  if ((await db.orders.count()) > 0 && !location.hash.includes('reseed')) return;
  await db.transaction('rw', db.tables, async () => { for (const t of db.tables) await t.clear(); });
  const now = Date.now();
  const orders: Order[] = [], items: Item[] = [], parcels: Parcel[] = [], events: TrackEvent[] = [];
  const sellers = ['Shenzhen Tech Store', 'Yiwu Crafts Co', 'GoBuild Robotics', 'Hangzhou Cable Factory', 'MakerLab Official', 'Ningbo Tools'];
  const titles: [string, string, number][] = [
    ['ESP32-S3 DevKit N16R8 WiFi Bluetooth Module', 'Electronics', 6.42], ['Mecanum Wheel 100mm Set of 4 Aluminum', 'Robotics', 38.9], ['USB-C 100W Braided Cable 2m', 'Electronics', 3.15],
    ['Digital Caliper 150mm Stainless', 'Tools', 12.6], ['Guitar Capo Aluminum Alloy', 'Music', 2.9], ['REV-compatible 15mm Extrusion 420mm x4', 'Robotics', 21.4],
    ['Hex Socket Screw Assortment M3 M4 500pcs', 'Tools', 7.8], ['OLED 1.3" I2C Display SH1106', 'Electronics', 2.35], ['Servo MG996R Metal Gear x2', 'Robotics', 9.6],
    ['Heat Shrink Tubing Kit 530pcs', 'Tools', 4.2], ['Piano Sustain Pedal Universal', 'Music', 11.5], ['LiPo Battery 3S 2200mAh', 'Electronics', 14.7],
  ];
  const services = ['AliExpress Standard Shipping', 'Cainiao Super Economy Global', 'AliExpress Selection Standard', 'Choice'];
  let ei = 0;
  for (let i = 0; i < 34; i++) {
    const placedDaysAgo = i < 10 ? 4 + i * 3 + (i % 3) * 2 : 40 + (i - 10) * 11;
    const delivered = i >= 10;
    const eu = i % 7 === 3;
    const legs = (eu ? LEGS.eu : LEGS.standard)(placedDaysAgo - 2);
    let shownLegs: Leg[] = delivered ? legs : legs.slice(0, Math.max(2, Math.min(legs.length - 1, 3 + (i % 6))));
    if (!delivered) { const shift = shownLegs[shownLegs.length - 1][0] - (0.4 + (i % 3) * 0.6); shownLegs = shownLegs.map(([d, t, l]) => [d - shift, t, l] as Leg); }
    // Ids mimic AliExpress: orders from one checkout are consecutive (step 20000), new checkouts jump far.
    const trip = Math.floor(i / 4);
    const orderId = String(3040000000000000 + trip * 90000000 + (i % 4) * 20000);
    const seller = sellers[i % sellers.length];
    const nItems = 1 + (i % 3);
    const currency = eu ? 'EUR' : 'USD';
    let subtotal = 0;
    const tn = tnGen(i);
    for (let k = 0; k < nItems; k++) {
      const t = titles[(i + k * 5) % titles.length];
      const qty = 1 + ((i + k) % 2);
      subtotal += t[2] * qty;
      items.push({ itemId: `${orderId}:${1005000000 + i * 13 + k}:${k}`, orderId, productId: String(1005000000 + i * 13 + k), title: t[0], sku: k % 2 ? 'Color: Black' : null, qty, unitPrice: t[2], currency, imageUrl: null, trackingNo: tn });
    }
    const shipping = i % 4 === 0 ? 0 : 2.99;
    const placedAt = now - placedDaysAgo * DAY;
    orders.push({ orderId, platform: 'aliexpress', placedAt, sellerId: String(100 + (i % sellers.length)), sellerName: seller, status: delivered ? 'COMPLETED' : 'SHIPPED', rawStatus: delivered ? 'FINISH' : 'WAIT_BUYER_ACCEPT_GOODS', currency, itemsSubtotal: +subtotal.toFixed(2), shippingCost: shipping, discount: i % 5 === 0 ? 1.5 : 0, tax: +(subtotal * 0.086).toFixed(2), orderTotal: +(subtotal + shipping + subtotal * 0.086 - (i % 5 === 0 ? 1.5 : 0)).toFixed(2), promisedDeliveryAt: placedAt + (eu ? 16 : 14) * DAY, protectionEndsAt: i % 6 === 1 ? now + 5 * DAY : null, refundAmount: null, paymentMethod: i % 3 ? 'Google Pay' : 'Visa ****4242', checkoutGroup: null, pricingDetailed: true, trackingNos: [tn], updatedAt: now });
    const service = services[i % services.length];
    parcels.push({ parcelId: tn, trackingNo: tn, platform: 'aliexpress', carrier: 'cainiao', manualState: null, manualStateAt: null, orderIds: [orderId], itemIds: items.filter((it) => it.orderId === orderId).map((it) => it.itemId), logisticsService: service, serviceKey: service.toLowerCase().replace(/[^a-z0-9]+/g, '_'), shipFromRegion: 'China', destCountry: eu ? 'Germany' : 'United States', shippedAt: placedAt + 2 * DAY, deliveredAt: null, lastEventAt: null, lastMilestone: null, lastLocationText: null, lastLat: null, lastLng: null, state: 'PENDING', nextPollAt: now + DAY, pollFailures: 0, consolidationGroup: null, updatedAt: now });
    for (const [daysAgo, text, loc] of shownLegs) {
      const ts = now - daysAgo * DAY - (ei++ % 5) * HOUR;
      const g = gazetteerLookup(loc) ?? gazetteerLookup(extractLocationFromText(text) ?? '');
      events.push({ eventId: `${tn}:${ts}:${fnv1a(text)}`, parcelId: tn, timestamp: ts, rawText: text, locationText: loc, milestone: classifyText(text), lat: g?.lat ?? null, lng: g?.lng ?? null, geoConfidence: g?.confidence ?? null, source: 'cainiao' });
    }
  }
  // Purchases from other stores, captured by hand — these exercise the multi-store views.
  const otherStores: [string, string, string, number, string][] = [
    ['amazon', 'Amazon', 'TBA305421997654', 24.99, 'Anker USB-C Charger 65W'],
    ['ebay', 'eBay', '9405511899223197428490', 41.5, 'Vintage Nixie Tube IN-14 (pair)'],
    ['temu', 'Temu', '1Z999AA10123456784', 8.75, 'Silicone Cable Ties 50pcs'],
  ];
  otherStores.forEach(([pf, seller, tn, amount, name], k) => {
    const oid = `m_${pf}_demo${k}`;
    const placed = now - (9 + k * 12) * DAY;
    orders.push({ orderId: oid, platform: pf as Order['platform'], manual: true, sourceUrl: null, placedAt: placed, sellerId: null, sellerName: seller, status: 'SHIPPED', rawStatus: null, currency: 'USD', itemsSubtotal: amount, shippingCost: 0, discount: null, tax: null, orderTotal: amount, promisedDeliveryAt: null, protectionEndsAt: null, refundAmount: null, paymentMethod: null, checkoutGroup: null, trackingNos: [tn], updatedAt: now });
    items.push({ itemId: `${oid}:manual`, orderId: oid, productId: null, title: name, sku: null, qty: 1, unitPrice: amount, currency: 'USD', imageUrl: null, trackingNo: tn });
    parcels.push({ parcelId: tn, trackingNo: tn, platform: pf as Order['platform'], carrier: null, manual: true, title: name, imageUrl: null, manualState: null, manualStateAt: null, orderIds: [oid], itemIds: [`${oid}:manual`], logisticsService: null, serviceKey: 'manual', shipFromRegion: null, destCountry: 'United States', shippedAt: placed, deliveredAt: null, lastEventAt: null, lastMilestone: null, lastLocationText: null, lastLat: null, lastLng: null, state: 'PENDING', nextPollAt: Number.MAX_SAFE_INTEGER, pollFailures: 0, consolidationGroup: null, updatedAt: now });
  });
  // One parcel the carrier gave up on months ago, to exercise the stale-cleanup banner.
  const dead = parcels[6];
  for (const e of events.filter((e) => e.parcelId === dead.parcelId)) e.timestamp = now - (70 + (e.timestamp % 5)) * DAY;
  dead.shippedAt = now - 75 * DAY;

  // A refunded order and a cancelled one for the finance view
  orders[7] = { ...orders[7], status: 'REFUNDED', rawStatus: 'Refund processed', refundAmount: orders[7].orderTotal };
  orders[9] = { ...orders[9], status: 'CLOSED', rawStatus: 'Canceled' };
  orders[13] = { ...orders[13], status: 'REFUNDED', rawStatus: 'Returned', refundAmount: +(((orders[13].orderTotal ?? 0) * 0.6)).toFixed(2) };
  // A consolidated pair: two tracking numbers sharing the same scans
  const base = parcels[2];
  const twin = { ...base, parcelId: 'LP00TWIN00001', trackingNo: 'LP00TWIN00001', orderIds: [orders[5].orderId], itemIds: [items.find((i) => i.orderId === orders[5].orderId)!.itemId] };
  parcels.push(twin);
  for (const e of events.filter((e) => e.parcelId === base.parcelId)) events.push({ ...e, eventId: `${twin.parcelId}:${e.timestamp}:${fnv1a(e.rawText)}`, parcelId: twin.parcelId });
  // An AliExpress-style parcel with no place names in its scans (position must be inferred)
  const pl = parcels[4];
  for (const e of events.filter((e) => e.parcelId === pl.parcelId)) { e.locationText = null; e.lat = null; e.lng = null; e.geoConfidence = null; }
  // A stalled parcel: last scan 12 days ago at export customs
  const st = parcels[1];
  const stEvents = events.filter((e) => e.parcelId === st.parcelId);
  for (const e of stEvents) e.timestamp -= 10 * DAY;
  await db.orders.bulkPut(orders); await db.items.bulkPut(items); await db.parcels.bulkPut(parcels); await db.events.bulkPut(events);
  await db.patchSettings({ homeAddress: 'Chicago, IL', homeAddressCoords: { lat: 41.8781, lng: -87.6298 }, rates: { USD: 1, EUR: 0.92, GBP: 0.79, CNY: 7.1, CAD: 1.36 }, ratesUpdatedAt: now });
  await recomputeAll();
}
