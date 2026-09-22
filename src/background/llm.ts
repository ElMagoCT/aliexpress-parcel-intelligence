/**
 * Strictly minimal LLM usage. Three jobs only: scan-text normalisation, geocoding fallback,
 * on-demand parcel explanation. Hard daily budget, cached forever, never on routine sync.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/db/schema';
import type { Milestone } from '@/model/types';
import { MILESTONE_ORDER } from '@/model/types';
import { sha256, todayKey } from '@/shared/util';

const MODEL = 'claude-haiku-4-5';
const KEY_NAME = 'anthropicApiKey';

export async function getApiKey(): Promise<string | null> {
  const r = await chrome.storage.local.get(KEY_NAME);
  return (r[KEY_NAME] as string | undefined) || null;
}
export async function setApiKey(key: string | null) {
  if (key) await chrome.storage.local.set({ [KEY_NAME]: key.trim() });
  else await chrome.storage.local.remove(KEY_NAME);
}

/** Reserve one call against the daily budget. Returns false (and does nothing) when exhausted. */
async function reserveCall(): Promise<boolean> {
  const s = await db.getSettings();
  const today = todayKey();
  let used = s.llmCallsDay === today ? s.llmCallsToday : 0;
  if (used >= s.llmDailyBudget) { await db.patchSettings({ llmCallsDay: today, llmCallsToday: used }); return false; }
  used++;
  await db.patchSettings({ llmCallsDay: today, llmCallsToday: used });
  return true;
}

async function client(): Promise<Anthropic | null> {
  const key = await getApiKey();
  if (!key) return null;
  const has = await chrome.permissions.contains({ origins: ['https://api.anthropic.com/*'] }).catch(() => true);
  if (!has) return null;
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 45_000 });
}

async function jsonCall(system: string, user: string, maxTokens: number): Promise<unknown | null> {
  const c = await client();
  if (!c) return null;
  if (!(await reserveCall())) return null;
  try {
    const res = await c.messages.create({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    const m = text.match(/[[{][\s\S]*[\]}]/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) await db.patchSettings({ lastSyncResult: 'LLM: invalid API key' });
    console.warn('[aepi] llm call failed', e);
    return null;
  }
}

/** Job 1: normalise up to 40 unknown scan strings → milestone. Cached by hash forever. */
export async function llmNormalizeTexts(texts: string[]): Promise<Record<string, Milestone | null>> {
  const out: Record<string, Milestone | null> = {};
  const todo: string[] = [];
  for (const t of texts.slice(0, 40)) {
    const h = await sha256(t);
    const c = await db.textcache.get(h);
    if (c) out[t] = c.milestone; else todo.push(t);
  }
  if (!todo.length) return out;
  const system = `You classify parcel tracking scan text into exactly one milestone from this list: ${MILESTONE_ORDER.join(', ')}, EXCEPTION, RETURNED, or null if genuinely unclear. Respond with ONLY a JSON object mapping each input index (as a string) to the milestone string or null. No prose.`;
  const user = JSON.stringify(Object.fromEntries(todo.map((t, i) => [String(i), t])));
  const res = (await jsonCall(system, user, 600)) as Record<string, string | null> | null;
  for (let i = 0; i < todo.length; i++) {
    const v = res?.[String(i)] ?? null;
    const m = v && (MILESTONE_ORDER as string[]).concat(['EXCEPTION', 'RETURNED']).includes(v) ? (v as Milestone) : null;
    out[todo[i]] = m;
    if (res) await db.textcache.put({ hash: await sha256(todo[i]), rawText: todo[i], milestone: m, source: 'llm', cachedAt: Date.now() });
  }
  return out;
}

/** Job 2: geocode up to 40 location strings → {lat,lng}. Caller caches. */
export async function llmGeocode(texts: string[]): Promise<Record<string, { lat: number; lng: number } | null>> {
  const out: Record<string, { lat: number; lng: number } | null> = {};
  if (!texts.length) return out;
  const system = 'You geocode logistics location strings (cities, airports, sorting hubs, ISC facilities). Respond with ONLY a JSON object mapping each input index (as a string) to {"lat": number, "lng": number} or null when the place cannot be identified. Approximate city-centre coordinates are fine. No prose.';
  const user = JSON.stringify(Object.fromEntries(texts.slice(0, 40).map((t, i) => [String(i), t])));
  const res = (await jsonCall(system, user, 1500)) as Record<string, { lat?: number; lng?: number } | null> | null;
  texts.slice(0, 40).forEach((t, i) => {
    const v = res?.[String(i)];
    out[t] = v && typeof v.lat === 'number' && typeof v.lng === 'number' && Math.abs(v.lat) <= 90 && Math.abs(v.lng) <= 180 ? { lat: v.lat, lng: v.lng } : res ? null : null;
    if (!res) delete out[t];
  });
  return out;
}

/** Job 3: on-demand plain-language explanation of an unusual journey. */
export async function llmExplainParcel(parcelId: string): Promise<string> {
  const p = await db.parcels.get(parcelId);
  if (!p) return 'Parcel not found.';
  const evs = (await db.events.where('parcelId').equals(parcelId).toArray()).sort((a, b) => a.timestamp - b.timestamp);
  const pred = await db.predictions.get(parcelId);
  const c = await client();
  if (!c) return 'Add an Anthropic API key in Settings to use explanations.';
  if (!(await reserveCall())) return 'Daily LLM budget exhausted — raise it in Settings or try tomorrow.';
  const lines = evs.map((e) => `${new Date(e.timestamp).toISOString().slice(0, 16)} | ${e.milestone ?? '?'} | ${e.locationText ?? ''} | ${e.rawText}`).join('\n');
  try {
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: 'You explain cross-border parcel journeys to a shopper in 3-5 short plain sentences. Point out anything unusual (long dwell, backtracking, customs holds, re-routing) and what typically happens next. No headings, no bullet lists, no markdown.',
      messages: [{ role: 'user', content: `Service: ${p.logisticsService ?? 'unknown'}\nFrom: ${p.shipFromRegion ?? '?'} → ${p.destCountry ?? '?'}\nCurrent state: ${p.state}\nPredicted delivery P50/P80: ${pred ? `${new Date(pred.p50).toDateString()} / ${new Date(pred.p80).toDateString()}` : 'n/a'}\nScans:\n${lines}` }],
    });
    return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim() || 'No explanation returned.';
  } catch (e) {
    return `Explanation failed: ${e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : String(e)}`;
  }
}

/** Run the LLM normaliser over uncategorised events (never on a routine sync — user-triggered). */
export async function normalizeUnknownEvents(): Promise<number> {
  const unknown = await db.events.filter((e) => e.milestone == null).toArray();
  const texts = [...new Set(unknown.map((e) => e.rawText))].slice(0, 40);
  if (!texts.length) return 0;
  const map = await llmNormalizeTexts(texts);
  let n = 0;
  for (const e of unknown) { const m = map[e.rawText]; if (m) { await db.events.update(e.eventId, { milestone: m }); n++; } }
  return n;
}
