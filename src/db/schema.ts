import Dexie, { type Table } from 'dexie';
import type {
  Alert, EndpointRecord, GeoCacheEntry, Item, Order, Parcel, Prediction, Refund, Settings, TextCacheEntry, TrackEvent,
} from '@/model/types';
import { DEFAULT_SETTINGS } from '@/model/types';

export interface KV { key: string; value: unknown; }

export class ParcelDB extends Dexie {
  orders!: Table<Order, string>;
  items!: Table<Item, string>;
  parcels!: Table<Parcel, string>;
  events!: Table<TrackEvent, string>;
  geocache!: Table<GeoCacheEntry, string>;
  textcache!: Table<TextCacheEntry, string>;
  predictions!: Table<Prediction, string>;
  settings!: Table<Settings, string>;
  endpoints!: Table<EndpointRecord, string>;
  alerts!: Table<Alert, string>;
  refunds!: Table<Refund, string>;
  kv!: Table<KV, string>;

  constructor(name = 'aliexpress-parcel-intel') {
    super(name);
    this.version(1).stores({
      orders: 'orderId, placedAt, sellerId, status, *trackingNos',
      items: 'itemId, orderId, productId, trackingNo',
      parcels: 'parcelId, trackingNo, state, nextPollAt, serviceKey, *orderIds, consolidationGroup',
      events: 'eventId, parcelId, timestamp, [parcelId+timestamp]',
      geocache: 'normalizedText',
      textcache: 'hash',
      predictions: 'parcelId',
      settings: 'id',
      endpoints: 'key, kind, lastSeenAt',
      alerts: 'alertId, kind, parcelId, createdAt, dismissed',
      kv: 'key',
    });
    this.version(2).stores({
      refunds: 'refundId, orderId, refundStatus, finishedAt',
    });
  }

  async getSettings(): Promise<Settings> {
    const s = await this.settings.get('settings');
    return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
  }

  async patchSettings(patch: Partial<Settings>): Promise<Settings> {
    const cur = await this.getSettings();
    const next = { ...cur, ...patch, id: 'settings' as const };
    await this.settings.put(next);
    return next;
  }

  async getKV<T>(key: string, fallback: T): Promise<T> {
    const row = await this.kv.get(key);
    return row ? (row.value as T) : fallback;
  }

  async setKV(key: string, value: unknown) {
    await this.kv.put({ key, value });
  }
}

export const db = new ParcelDB();
