import type { Parcel, TrackEvent } from '@/model/types';
import { normalizeText } from '@/shared/util';

/**
 * Consolidated-shipment detection: distinct tracking numbers whose scan sequences share
 * ≥ 80 % of (timestamp-minute, location) nodes are travelling together.
 */
export function detectConsolidation(parcels: Parcel[], eventsByParcel: Map<string, TrackEvent[]>, threshold = 0.8): Map<string, string> {
  const sigs = new Map<string, Set<string>>();
  for (const p of parcels) {
    const evs = eventsByParcel.get(p.parcelId) ?? [];
    const sig = new Set<string>();
    for (const e of evs) {
      const minute = Math.round(e.timestamp / 60000);
      sig.add(`${minute}|${normalizeText(e.locationText ?? e.rawText).slice(0, 40)}`);
    }
    if (sig.size >= 3) sigs.set(p.parcelId, sig);
  }
  const ids = [...sigs.keys()];
  const parent = new Map<string, string>(ids.map((i) => [i, i]));
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = sigs.get(ids[i])!, b = sigs.get(ids[j])!;
      let shared = 0;
      for (const s of a) if (b.has(s)) shared++;
      const ratio = shared / Math.min(a.size, b.size);
      if (ratio >= threshold) union(ids[i], ids[j]);
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) { const r = find(id); (groups.get(r) ?? groups.set(r, []).get(r)!).push(id); }
  const out = new Map<string, string>();
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const gid = 'grp_' + members.slice().sort().join('+').slice(0, 60);
    for (const m of members) out.set(m, gid);
  }
  return out;
}
