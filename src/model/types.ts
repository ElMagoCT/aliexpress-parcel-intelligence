/**
 * Normalized internal model. Nothing in here knows about AliExpress field names —
 * that knowledge lives exclusively in src/adapters/aliexpress.ts.
 */

export type Milestone =
  | 'SELLER_SHIPPED'
  | 'ORIGIN_ACCEPTED'
  | 'ORIGIN_DEPARTED'
  | 'EXPORT_CUSTOMS'
  | 'DEPARTED_ORIGIN_COUNTRY'
  | 'ARRIVED_DEST_COUNTRY'
  | 'IMPORT_CUSTOMS'
  | 'HANDED_TO_LOCAL_CARRIER'
  | 'IN_TRANSIT_LOCAL'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'EXCEPTION'
  | 'RETURNED';

/** Ordered by typical journey position. EXCEPTION / RETURNED are off-path. */
export const MILESTONE_ORDER: Milestone[] = [
  'SELLER_SHIPPED',
  'ORIGIN_ACCEPTED',
  'ORIGIN_DEPARTED',
  'EXPORT_CUSTOMS',
  'DEPARTED_ORIGIN_COUNTRY',
  'ARRIVED_DEST_COUNTRY',
  'IMPORT_CUSTOMS',
  'HANDED_TO_LOCAL_CARRIER',
  'IN_TRANSIT_LOCAL',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
];

export const MILESTONE_LABEL: Record<Milestone, string> = {
  SELLER_SHIPPED: 'Seller shipped',
  ORIGIN_ACCEPTED: 'Accepted by carrier',
  ORIGIN_DEPARTED: 'Left origin facility',
  EXPORT_CUSTOMS: 'Export customs',
  DEPARTED_ORIGIN_COUNTRY: 'Departed origin country',
  ARRIVED_DEST_COUNTRY: 'Arrived in destination country',
  IMPORT_CUSTOMS: 'Import customs',
  HANDED_TO_LOCAL_CARRIER: 'Handed to local carrier',
  IN_TRANSIT_LOCAL: 'Local transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  EXCEPTION: 'Exception',
  RETURNED: 'Returned',
};

export type OrderStatus =
  | 'AWAITING_PAYMENT'
  | 'AWAITING_SHIPMENT'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CLOSED'
  | 'DISPUTE'
  | 'REFUNDED'
  | 'UNKNOWN';

export type ParcelState = 'PENDING' | 'IN_TRANSIT' | 'DEST_COUNTRY' | 'OUT_FOR_DELIVERY' | 'STALLED' | 'DELIVERED' | 'EXCEPTION' | 'RETURNED' | 'CLOSED';

export interface Order {
  orderId: string;
  placedAt: number | null; // epoch ms
  sellerId: string | null;
  sellerName: string | null;
  status: OrderStatus;
  rawStatus: string | null;
  currency: string;
  itemsSubtotal: number | null;
  shippingCost: number | null;
  discount: number | null;
  tax: number | null;
  orderTotal: number | null;
  /** AliExpress's own promised delivery date, if any. */
  promisedDeliveryAt: number | null;
  /** Buyer-protection / dispute deadline if AliExpress exposes it. */
  protectionEndsAt: number | null;
  /** Amount refunded to you, when the payload exposed it (null = unknown; UI assumes full refund for REFUNDED orders). */
  refundAmount: number | null;
  /** How it was paid, from the order detail page. */
  paymentMethod: string | null;
  /** Orders paid in one checkout share this key. Computed, not from AliExpress. */
  checkoutGroup: string | null;
  /** True once the order-detail price block has been fetched (shipping/discount/tax are then real, not guessed). */
  pricingDetailed?: boolean;
  trackingNos: string[];
  updatedAt: number;
}

export interface Item {
  itemId: string; // orderId:productId:sku
  orderId: string;
  productId: string | null;
  title: string;
  sku: string | null;
  qty: number;
  unitPrice: number | null;
  currency: string | null;
  imageUrl: string | null;
  trackingNo: string | null;
}

export interface Parcel {
  parcelId: string; // == trackingNo normally
  trackingNo: string;
  orderIds: string[];
  itemIds: string[];
  logisticsService: string | null;
  serviceKey: string; // normalized service name used for statistics
  shipFromRegion: string | null;
  destCountry: string | null;
  shippedAt: number | null;
  deliveredAt: number | null;
  lastEventAt: number | null;
  lastMilestone: Milestone | null;
  lastLocationText: string | null;
  lastLat: number | null;
  lastLng: number | null;
  state: ParcelState;
  /** Poll scheduling. */
  nextPollAt: number;
  pollFailures: number;
  consolidationGroup: string | null;
  updatedAt: number;
}

export interface TrackEvent {
  eventId: string; // parcelId:timestamp:hash(rawText)
  parcelId: string;
  timestamp: number;
  rawText: string;
  locationText: string | null;
  milestone: Milestone | null;
  lat: number | null;
  lng: number | null;
  geoConfidence: number | null; // 0..1
  source: 'cainiao' | 'aliexpress' | 'manual';
  /** Carrier / platform action code when the payload had one (e.g. AE_LH_ARRIVE). */
  code?: string | null;
}

/** A return / refund / dispute case (AliExpress "reverse order line"). */
export interface Refund {
  refundId: string; // reverseOrderLineId
  reverseOrderId: string | null;
  orderId: string | null;
  orderLineId: string | null;
  itemTitle: string | null;
  itemImageUrl: string | null;
  itemUnitPrice: number | null;
  itemCount: number | null;
  currency: string | null;
  /** Actual refunded money when the detail was fetched; null = detail not fetched yet. */
  refundAmount: number | null;
  refundStatus: string | null; // FINISHED, ...
  caseStatus: string | null; // "Request complete", ...
  reverseType: string | null; // RETURN / REFUND
  solutionText: string | null;
  reason: string | null;
  requestedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

export interface GeoCacheEntry {
  normalizedText: string;
  lat: number | null;
  lng: number | null;
  source: 'gazetteer' | 'nominatim' | 'llm' | 'none';
  confidence: number;
  displayName?: string;
  cachedAt: number;
}

export interface TextCacheEntry {
  hash: string;
  rawText: string;
  milestone: Milestone | null;
  source: 'rules' | 'code' | 'llm' | 'unknown';
  cachedAt: number;
}

export interface Prediction {
  parcelId: string;
  generatedAt: number;
  p50: number; // epoch ms ETA
  p80: number;
  p95: number;
  basis: string;
  sampleSize: number;
  milestone: Milestone | null;
  stalled: boolean;
  dwellP90Days: number | null;
}

export interface Settings {
  id: 'settings';
  llmDailyBudget: number;
  llmCallsToday: number;
  llmCallsDay: string; // YYYY-MM-DD the counter belongs to
  syncIntervalMin: number;
  geocodingMode: 'gazetteer' | 'nominatim' | 'nominatim+llm';
  homeAddress: string | null;
  homeAddressCoords: { lat: number; lng: number } | null;
  displayCurrency: string;
  notifications: boolean;
  loggedOut: boolean;
  lastSyncAt: number | null;
  lastSyncResult: string | null;
  ratesUpdatedAt: number | null;
  rates: Record<string, number> | null; // units of currency per 1 USD
  /** Lets scripts on aliexpress.com pages query extension diagnostics via postMessage. Off by default. */
  debugChannel: boolean;
  /** Base map: Esri dark canvas (default), streets, or satellite imagery. */
  mapStyle: 'dark' | 'streets' | 'satellite';
  /** UI theme preset and accent colour. */
  theme: 'dark' | 'light' | 'offwhite';
  accent: string; // hex
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  llmDailyBudget: 5,
  llmCallsToday: 0,
  llmCallsDay: '',
  syncIntervalMin: 180,
  geocodingMode: 'gazetteer',
  homeAddress: null,
  homeAddressCoords: null,
  displayCurrency: 'USD',
  notifications: true,
  loggedOut: false,
  lastSyncAt: null,
  lastSyncResult: null,
  ratesUpdatedAt: null,
  rates: null,
  debugChannel: false,
  mapStyle: 'dark',
  theme: 'dark',
  accent: '#6ea8ff',
};

/** Every distinct URL shape we have seen carrying useful data. */
export interface EndpointRecord {
  key: string; // host + path + api name
  kind: 'orderList' | 'orderDetail' | 'logistics' | 'tracking' | 'freight' | 'refund' | 'unknown';
  urlTemplate: string; // last full URL seen (query preserved) — used for direct fetch
  method: string;
  hits: number;
  lastSeenAt: number;
  lastOrders: number;
  lastEvents: number;
  /** For mtop-style pagination: the query-param name that carried page number, if detected ('body.pageIndex' for POST bodies). */
  pageParam: string | null;
  /** Recorded POST body (form-encoded) so the call can be replayed with a new page / order id. */
  bodyTemplate: string | null;
}

export interface CaptureLogEntry {
  ts: number;
  path: string;
  via: string;
  method: string;
  bytes: number;
  orders: number;
  items: number;
  parcels: number;
  events: number;
  loginRequired: boolean;
  note?: string;
}

export interface BackfillState {
  active: boolean;
  phase: 'idle' | 'orders' | 'tracking' | 'done' | 'stopped' | 'error';
  tabId: number | null;
  pagesFetched: number;
  ordersFound: number;
  ordersAtStart: number;
  estimatedRemainingPages: number | null;
  trackingQueued: number;
  trackingDone: number;
  startedAt: number | null;
  updatedAt: number;
  lastError: string | null;
  exhaustedStreak: number;
}

export interface Alert {
  alertId: string;
  kind: 'stalled' | 'dispute_deadline' | 'late' | 'delivered' | 'exception' | 'milestone' | 'logged_out';
  parcelId: string | null;
  orderId: string | null;
  severity: 'info' | 'warn' | 'urgent';
  title: string;
  body: string;
  createdAt: number;
  dismissed: boolean;
  notified: boolean;
}
