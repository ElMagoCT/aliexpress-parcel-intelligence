/**
 * Geocoding: gazetteer → Nominatim (1 req/s, cached forever) → LLM batch fallback.
 * Never re-geocodes a cached string.
 */
import { db } from '@/db/schema';
import type { GeoCacheEntry } from '@/model/types';
import gazetteerRaw from '@/data/gazetteer.json';
import { normalizeText, sleep } from '@/shared/util';
import { llmGeocode } from './llm';

type Gaz = Record<string, { lat: number; lng: number; cc: string; c: number }>;
const gazetteer = gazetteerRaw as Gaz;
const gazKeys = Object.keys(gazetteer).sort((a, b) => b.length - a.length);

const NOISE = /\b(sorting cent(er|re)|sort(ing)? facility|processing cent(er|re)|distribution cent(er|re)|delivery (station|office|depot|unit)|post office|warehouse|hub|facility|airport|international|customs|terminal|cainiao|usps|isc|regional|network|logistics|cent(er|re)|office|station|depot|unit|branch|city|province|district|county|area|region|the|of|at|in|to|from)\b/gi;

export function gazetteerLookup(text: string): { lat: number; lng: number; confidence: number } | null {
  const norm = normalizeText(text);
  if (!norm) return null;
  if (gazetteer[norm]) return { lat: gazetteer[norm].lat, lng: gazetteer[norm].lng, confidence: gazetteer[norm].c };
  // Try comma-separated parts, most specific first
  const parts = norm.split(/[,/|-]/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) if (gazetteer[part]) return { lat: gazetteer[part].lat, lng: gazetteer[part].lng, confidence: gazetteer[part].c * 0.95 };
  // Strip logistics noise words and try again
  const stripped = norm.replace(NOISE, ' ').replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped && gazetteer[stripped]) return { lat: gazetteer[stripped].lat, lng: gazetteer[stripped].lng, confidence: gazetteer[stripped].c * 0.9 };
  // Substring scan (longest key wins), only for keys ≥ 4 chars to avoid false hits
  const padded = ` ${norm} `;
  for (const k of gazKeys) {
    if (k.length < 4) continue;
    if (padded.includes(` ${k} `) || padded.includes(` ${k},`) || padded.includes(`,${k} `)) return { lat: gazetteer[k].lat, lng: gazetteer[k].lng, confidence: gazetteer[k].c * 0.8 };
  }
  return null;
}

let nominatimLast = 0;
async function nominatim(text: string): Promise<{ lat: number; lng: number; displayName: string } | null> {
  const has = await chrome.permissions.contains({ origins: ['https://nominatim.openstreetmap.org/*'] }).catch(() => false);
  if (!has) return null;
  const wait = nominatimLast + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  nominatimLast = Date.now();
  const q = text.replace(NOISE, ' ').replace(/\s+/g, ' ').trim() || text;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'AliExpressParcelIntel/0.1 (browser extension; local use)', accept: 'application/json' } });
    if (res.status === 429) { nominatimLast = Date.now() + 30_000; return null; }
    if (!res.ok) return null;
    const arr = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    if (!arr.length) return null;
    return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), displayName: arr[0].display_name };
  } catch { return null; }
}

export async function geocodeText(text: string, allowNetwork: boolean): Promise<GeoCacheEntry> {
  const key = normalizeText(text);
  const cached = await db.geocache.get(key);
  if (cached && (cached.lat != null || !allowNetwork || cached.source === 'llm' || cached.source === 'nominatim')) return cached;
  const g = gazetteerLookup(text);
  if (g) {
    const entry: GeoCacheEntry = { normalizedText: key, lat: g.lat, lng: g.lng, source: 'gazetteer', confidence: g.confidence, cachedAt: Date.now() };
    await db.geocache.put(entry);
    return entry;
  }
  const settings = await db.getSettings();
  if (allowNetwork && settings.geocodingMode !== 'gazetteer') {
    const n = await nominatim(text);
    if (n) {
      const entry: GeoCacheEntry = { normalizedText: key, lat: n.lat, lng: n.lng, source: 'nominatim', confidence: 0.7, displayName: n.displayName, cachedAt: Date.now() };
      await db.geocache.put(entry);
      return entry;
    }
  }
  const miss: GeoCacheEntry = { normalizedText: key, lat: null, lng: null, source: 'none', confidence: 0, cachedAt: Date.now() };
  if (!cached) await db.geocache.put(miss);
  return miss;
}

/** Geocode every event lacking coordinates. Gazetteer first for all, then network tiers for the leftovers. */
export async function geocodePendingEvents(opts: { network: boolean; llm: boolean; maxNetwork?: number } = { network: false, llm: false }): Promise<{ resolved: number; unresolved: number }> {
  const pending = await db.events.filter((e) => e.lat == null && !!(e.locationText || e.rawText)).toArray();
  let resolved = 0;
  const unresolvedTexts = new Map<string, string[]>(); // normalized → eventIds
  for (const e of pending) {
    const text = e.locationText ?? extractLocationFromText(e.rawText);
    if (!text) continue;
    const entry = await geocodeText(text, false);
    if (entry.lat != null && entry.lng != null) {
      await db.events.update(e.eventId, { lat: entry.lat, lng: entry.lng, geoConfidence: entry.confidence });
      resolved++;
    } else {
      const arr = unresolvedTexts.get(text) ?? [];
      arr.push(e.eventId);
      unresolvedTexts.set(text, arr);
    }
  }
  if (opts.network) {
    let budget = opts.maxNetwork ?? 25;
    for (const [text, ids] of unresolvedTexts) {
      if (budget-- <= 0) break;
      const cached = await db.geocache.get(normalizeText(text));
      if (cached?.source === 'nominatim' || cached?.source === 'llm') continue; // already tried network
      const entry = await geocodeText(text, true);
      if (entry.lat != null && entry.lng != null) {
        for (const id of ids) await db.events.update(id, { lat: entry.lat, lng: entry.lng, geoConfidence: entry.confidence });
        resolved += ids.length;
        unresolvedTexts.delete(text);
      } else {
        await db.geocache.put({ ...entry, source: 'nominatim' }); // mark as network-tried
      }
    }
  }
  if (opts.llm && unresolvedTexts.size) {
    const texts = [...unresolvedTexts.keys()].slice(0, 40);
    const results = await llmGeocode(texts);
    for (const [text, coords] of Object.entries(results)) {
      const ids = unresolvedTexts.get(text) ?? [];
      const entry: GeoCacheEntry = { normalizedText: normalizeText(text), lat: coords?.lat ?? null, lng: coords?.lng ?? null, source: 'llm', confidence: coords ? 0.6 : 0, cachedAt: Date.now() };
      await db.geocache.put(entry);
      if (coords) { for (const id of ids) await db.events.update(id, { lat: coords.lat, lng: coords.lng, geoConfidence: 0.6 }); resolved += ids.length; unresolvedTexts.delete(text); }
    }
  }
  return { resolved, unresolved: [...unresolvedTexts.values()].reduce((s, a) => s + a.length, 0) };
}

/** Pull a place out of scan text like "Departed from Shenzhen sorting center" or "[Los Angeles, CA] Arrived". */
export function extractLocationFromText(raw: string): string | null {
  const bracket = raw.match(/\[([^\]]{2,60})\]/);
  if (bracket) return bracket[1];
  const m = raw.match(/(?:arrived (?:at|in)|departed (?:from)?|left|in|at|to|processed through(?: facility)?)\s+(?:the\s+)?([A-Z][A-Za-z'.\- ]{2,40}(?:,\s*[A-Z]{2})?)/);
  if (m) return m[1].trim();
  const caps = raw.match(/\b([A-Z][A-Z .]{3,30})\b(?:,|\s|$)/);
  if (caps && !/^(ISC|USPS|DHL|UPS|EMS|CN|US|SHIPMENT|PACKAGE|DELIVERED|IN TRANSIT|OUT FOR DELIVERY)$/.test(caps[1].trim())) return caps[1].trim();
  return null;
}
