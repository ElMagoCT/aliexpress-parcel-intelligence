/**
 * Cainiao tracking poller: state-based cadence, max 3 concurrent, jitter, exponential
 * backoff on 429/5xx, global pause after consecutive failures.
 */
import { db } from '@/db/schema';
import type { Parcel, ParcelState } from '@/model/types';
import { CAINIAO_DETAIL_URLS, parseCainiao } from '@/adapters/cainiao';
import { ingestBundle, upsertEvents } from './ingest';
import { parsePayload, withDataField } from '@/adapters/aliexpress';
import { directFetch } from './sync';
import { scheduleRecompute } from './recompute';
import { HOUR, jitter, sleep } from '@/shared/util';

const MAX_CONCURRENT = 3;
const PAUSE_KEY = 'trackerPausedUntil';
const FAIL_KEY = 'trackerConsecutiveFailures';

export function pollIntervalFor(state: ParcelState): number | null {
  switch (state) {
    case 'OUT_FOR_DELIVERY':
    case 'DEST_COUNTRY': return 3 * HOUR;
    case 'IN_TRANSIT':
    case 'PENDING':
    case 'EXCEPTION': return 8 * HOUR;
    case 'STALLED': return 24 * HOUR;
    case 'DELIVERED':
    case 'RETURNED':
    case 'CLOSED': return null;
  }
}

export interface PollResult { ok: boolean; events: number; paused: boolean; error: string | null }

export async function pollParcel(parcelId: string, opts: { force?: boolean } = {}): Promise<PollResult> {
  const p = await db.parcels.get(parcelId);
  if (!p) return { ok: false, events: 0, paused: false, error: 'no parcel' };
  const pausedUntil = await db.getKV<number>(PAUSE_KEY, 0);
  if (!opts.force && pausedUntil > Date.now()) return { ok: false, events: 0, paused: true, error: 'paused' };
  let lastErr: string | null = null;
  // 1. AliExpress's own tracking detail (learned template) — richest source, includes carrier codes + ETA.
  if (p.orderIds.length) {
    const eps = (await db.endpoints.where('kind').equals('tracking').toArray()).filter((e) => /aliexpress\.(com|us)/.test(e.urlTemplate) && /tradeOrderId/.test(decodeURIComponent(e.urlTemplate))).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const url = eps[0] ? withDataField(eps[0].urlTemplate, 'tradeOrderId', p.orderIds[0]) : null;
    if (url) {
      try {
        const r = await directFetch(url, eps[0].method, null);
        if (r.status === 429 || r.status >= 500) { await registerFailure(r.status); return { ok: false, events: 0, paused: true, error: `HTTP ${r.status}` }; }
        const bundle = parsePayload(url, r.text);
        if (!bundle.loginRequired && (bundle.events.length || bundle.parcels.length)) {
          const s = await ingestBundle(bundle, 'aliexpress');
          await db.setKV(FAIL_KEY, 0);
          await db.parcels.update(parcelId, { pollFailures: 0, updatedAt: Date.now() });
          scheduleRecompute();
          if (s.events || bundle.events.length) return { ok: true, events: s.events, paused: false, error: null };
        }
        if (bundle.loginRequired) await db.patchSettings({ loggedOut: true });
      } catch (e) { lastErr = String(e); }
    }
  }
  // 2. Cainiao public tracking
  for (const url of CAINIAO_DETAIL_URLS(p.trackingNo)) {
    try {
      await sleep(jitter(400, 0.8));
      const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
      if (res.status === 429 || res.status >= 500) { lastErr = `HTTP ${res.status}`; await registerFailure(res.status); return { ok: false, events: 0, paused: true, error: lastErr }; }
      const text = await res.text();
      const parsed = parseCainiao(p.trackingNo, text);
      if (!parsed.ok) { lastErr = parsed.error; continue; }
      await db.setKV(FAIL_KEY, 0);
      const n = await upsertEvents(parsed.events, 'cainiao');
      const patch: Partial<Parcel> = { pollFailures: 0, updatedAt: Date.now() };
      if (parsed.destCountry && !p.destCountry) patch.destCountry = parsed.destCountry;
      if (parsed.originCountry && !p.shipFromRegion) patch.shipFromRegion = parsed.originCountry;
      if (parsed.serviceName && !p.logisticsService) { patch.logisticsService = parsed.serviceName; }
      if (parsed.delivered && !p.deliveredAt) patch.deliveredAt = parsed.events.at(-1)?.timestamp ?? Date.now();
      await db.parcels.update(parcelId, patch);
      scheduleRecompute();
      return { ok: true, events: n, paused: false, error: null };
    } catch (e) {
      lastErr = String(e);
    }
  }
  await db.parcels.update(parcelId, { pollFailures: (p.pollFailures ?? 0) + 1, nextPollAt: Date.now() + Math.min(24, 2 ** Math.min(p.pollFailures + 1, 5)) * HOUR, updatedAt: Date.now() });
  return { ok: false, events: 0, paused: false, error: lastErr };
}

async function registerFailure(status: number) {
  const n = (await db.getKV<number>(FAIL_KEY, 0)) + 1;
  await db.setKV(FAIL_KEY, n);
  if (n >= 3 || status === 429) {
    const backoff = Math.min(6 * HOUR, 10 * 60_000 * 2 ** Math.min(n, 5));
    await db.setKV(PAUSE_KEY, Date.now() + backoff);
  }
}

/** Poll every parcel that is due, respecting concurrency and the global pause. */
export async function pollDueParcels(limit = 40): Promise<{ polled: number; paused: boolean }> {
  const settings = await db.getSettings();
  if (settings.loggedOut) { /* Cainiao is public; continue regardless */ }
  const pausedUntil = await db.getKV<number>(PAUSE_KEY, 0);
  if (pausedUntil > Date.now()) return { polled: 0, paused: true };
  const now = Date.now();
  const due = (await db.parcels.where('nextPollAt').belowOrEqual(now).toArray())
    .filter((p) => pollIntervalFor(p.state) !== null)
    .sort((a, b) => a.nextPollAt - b.nextPollAt)
    .slice(0, limit);
  let polled = 0;
  let paused = false;
  const queue = [...due];
  const worker = async () => {
    while (queue.length && !paused) {
      const p = queue.shift()!;
      const r = await pollParcel(p.parcelId);
      polled++;
      if (r.paused) { paused = true; break; }
      const iv = pollIntervalFor((await db.parcels.get(p.parcelId))?.state ?? p.state);
      if (iv) await db.parcels.update(p.parcelId, { nextPollAt: Date.now() + jitter(iv, 0.2) });
      await sleep(jitter(1200, 0.5));
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, worker));
  return { polled, paused };
}
