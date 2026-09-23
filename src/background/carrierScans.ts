/**
 * Read scans from a carrier's own tracking page.
 *
 * Carrier APIs need contracts and keys, and every page renders differently, so the extension opens
 * the carrier's public tracking page in a background tab, reads what it renders, and closes it —
 * the same information the user would see by clicking the link, without them having to. The site
 * permission is optional and requested per carrier from the dashboard.
 */
import { db } from '@/db/schema';
import type { TrackEvent } from '@/model/types';
import { CARRIERS, carrierOrigin, detectCarrier } from '@/engine/carriers';
import { SCAN_HARVESTER, parseCarrierPage, type CarrierPageResult } from '@/adapters/carrierPage';
import { fnv1a, sleep } from '@/shared/util';
import { recomputeAll } from './recompute';

export interface CarrierFetchResult {
  ok: boolean;
  note: string;
  needsPermission?: string;
  scans: number;
  delivered: boolean;
}

/** Wait for a tab to finish loading, then a moment more for client-rendered content. */
async function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(700);
    try { if ((await chrome.tabs.get(tabId)).status === 'complete') break; } catch { return; }
  }
  await sleep(2500);
}

export async function fetchCarrierScans(parcelId: string): Promise<CarrierFetchResult> {
  const p = await db.parcels.get(parcelId);
  if (!p) return { ok: false, note: 'no such parcel', scans: 0, delivered: false };
  const carrier = CARRIERS[p.carrier ?? ''] ?? detectCarrier(p.trackingNo, p.logisticsService).carrier;
  const origin = carrierOrigin(carrier, p.trackingNo);
  if (!origin) return { ok: false, note: 'no tracking page known for this carrier', scans: 0, delivered: false };
  if (!(await chrome.permissions.contains({ origins: [origin] }).catch(() => false))) {
    return { ok: false, note: `needs permission for ${carrier.name}`, needsPermission: origin, scans: 0, delivered: false };
  }

  let tabId: number | undefined;
  try {
    tabId = (await chrome.tabs.create({ url: carrier.url(p.trackingNo), active: false })).id;
    if (tabId == null) return { ok: false, note: 'could not open the tracking page', scans: 0, delivered: false };
    await waitForLoad(tabId);
    // First pass also expands any "show details" toggle; the second pass reads what that revealed.
    await chrome.scripting.executeScript({ target: { tabId }, func: SCAN_HARVESTER }).catch(() => []);
    await sleep(2000);
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: SCAN_HARVESTER });
    const harvest = res?.result;
    if (!harvest) return { ok: false, note: 'could not read the tracking page', scans: 0, delivered: false };
    const parsed = parseCarrierPage(harvest);
    if (!parsed.usable) return { ok: false, note: `${carrier.name} has no record for this number yet`, scans: 0, delivered: false };
    const n = await ingestCarrierResult(parcelId, parsed);
    await recomputeAll();
    return { ok: true, note: 'ok', scans: n, delivered: parsed.delivered };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e), scans: 0, delivered: false };
  } finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch { /* already closed */ } }
  }
}

/** Store what the page gave us: dated scans as events, plus the facts about the parcel itself. */
export async function ingestCarrierResult(parcelId: string, r: CarrierPageResult): Promise<number> {
  const now = Date.now();
  let added = 0;
  for (const s of r.scans) {
    if (s.timestamp == null) continue; // undated milestone chips inform state, not history
    const eventId = `${parcelId}:${s.timestamp}:${fnv1a(s.rawText)}`;
    if (await db.events.get(eventId)) continue;
    const ev: TrackEvent = {
      eventId, parcelId, timestamp: s.timestamp, rawText: s.rawText,
      locationText: s.locationText, milestone: s.milestone,
      lat: null, lng: null, geoConfidence: null, source: 'carrier', code: null,
    };
    await db.events.put(ev);
    added++;
  }
  const p = await db.parcels.get(parcelId);
  if (p) {
    await db.parcels.update(parcelId, {
      logisticsService: r.service ?? p.logisticsService,
      // A delivery time read off the carrier's page is real, so it may train the estimator.
      deliveredAt: r.deliveredAt ?? p.deliveredAt,
      shippedAt: p.shippedAt ?? r.shippedAt,
      lastLocationText: r.lastLocation ?? p.lastLocationText,
      pollFailures: 0,
      updatedAt: now,
    });
  }
  return added;
}
