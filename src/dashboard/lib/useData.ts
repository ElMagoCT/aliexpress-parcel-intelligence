import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Alert, Item, Order, Parcel, Prediction, Refund, Settings, TrackEvent } from '@/model/types';
import { DEFAULT_SETTINGS } from '@/model/types';
import { useEffect, useMemo, useState } from 'react';
import { bg } from './bg';
import type { JobStatus } from '@/background/jobs';

export const useParcels = () => useLiveQuery(() => db.parcels.toArray(), [], [] as Parcel[]);
export const useOrders = () => useLiveQuery(() => db.orders.toArray(), [], [] as Order[]);
export const useItems = () => useLiveQuery(() => db.items.toArray(), [], [] as Item[]);
export const useEvents = () => useLiveQuery(() => db.events.toArray(), [], [] as TrackEvent[]);
export const usePredictions = () => useLiveQuery(() => db.predictions.toArray(), [], [] as Prediction[]);
export const useRefunds = () => useLiveQuery(() => db.refunds.toArray(), [], [] as Refund[]);
export const useAlerts = () => useLiveQuery(() => db.alerts.orderBy('createdAt').reverse().toArray(), [], [] as Alert[]);
export const useSettings = (): Settings => useLiveQuery(() => db.getSettings(), [], DEFAULT_SETTINGS) ?? DEFAULT_SETTINGS;

/**
 * Is the extension's background service worker answering? The dashboard reads IndexedDB directly,
 * so every view still renders when the worker is dead — buttons just silently do nothing. This
 * turns that into a visible banner.
 */
export function useBackgroundHealth(): 'checking' | 'ok' | 'down' {
  const [state, setState] = useState<'checking' | 'ok' | 'down'>('checking');
  useEffect(() => {
    let alive = true;
    let misses = 0;
    const tick = async () => {
      const r = await bg({ type: 'PING' });
      if (!alive) return;
      if (r.ok) { misses = 0; setState('ok'); } else if (++misses >= 2) setState('down');
    };
    void tick();
    const id = setInterval(() => void tick(), 8000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return state;
}

/** Polls background job progress so long-running buttons can show what they are doing. */
export function useJobs(): Record<string, JobStatus> {
  const [jobs, setJobs] = useState<Record<string, JobStatus>>({});
  useEffect(() => {
    let alive = true;
    const tick = async () => { const r = await bg({ type: 'GET_JOBS' }); if (alive && r.ok) setJobs(((r as { jobs?: Record<string, JobStatus> }).jobs) ?? {}); };
    void tick();
    const id = setInterval(() => void tick(), 1500);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return jobs;
}

export function useEventsByParcel() {
  const events = useEvents();
  return useMemo(() => {
    const m = new Map<string, TrackEvent[]>();
    for (const e of events) (m.get(e.parcelId) ?? m.set(e.parcelId, []).get(e.parcelId)!).push(e);
    for (const l of m.values()) l.sort((a, b) => a.timestamp - b.timestamp);
    return m;
  }, [events]);
}

export function useItemsByParcel() {
  const items = useItems();
  const parcels = useParcels();
  return useMemo(() => {
    const byId = new Map(items.map((i) => [i.itemId, i]));
    const m = new Map<string, Item[]>();
    for (const p of parcels) {
      const list = p.itemIds.map((id) => byId.get(id)).filter((x): x is Item => !!x);
      if (!list.length) for (const i of items) if (i.trackingNo === p.trackingNo || (p.orderIds.includes(i.orderId) && !i.trackingNo)) list.push(i);
      m.set(p.parcelId, list);
    }
    return m;
  }, [items, parcels]);
}

export function useOrdersById() {
  const orders = useOrders();
  return useMemo(() => new Map(orders.map((o) => [o.orderId, o])), [orders]);
}

export function usePredictionsById() {
  const preds = usePredictions();
  return useMemo(() => new Map(preds.map((p) => [p.parcelId, p])), [preds]);
}

export const ACTIVE_STATES = new Set(['PENDING', 'IN_TRANSIT', 'DEST_COUNTRY', 'OUT_FOR_DELIVERY', 'STALLED', 'EXCEPTION']);
export const isActive = (p: Parcel) => ACTIVE_STATES.has(p.state);
