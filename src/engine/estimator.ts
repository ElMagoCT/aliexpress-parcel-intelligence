import type { Milestone, Parcel, TrackEvent } from '@/model/types';
import { MILESTONE_ORDER } from '@/model/types';
import { DAY } from '@/shared/util';
import { milestoneIndex } from './milestones';

/**
 * Estimation engine. Predicts REMAINING days conditioned on current milestone,
 * re-estimated on every scan. Shrinks thin service-specific samples toward pooled
 * data, which is itself shrunk toward a baseline prior so the extension is useful
 * on day one.
 */

export const SHRINK_K = 8;
export const QS = [0.5, 0.8, 0.95] as const;
export type Quantiles = { p50: number; p80: number; p95: number };

/** Baseline priors: remaining days to delivery from each milestone (cross-border e-commerce, China→NA/EU). */
export const PRIOR_REMAINING: Record<Milestone, Quantiles> = {
  SELLER_SHIPPED: { p50: 21, p80: 32, p95: 45 },
  ORIGIN_ACCEPTED: { p50: 19, p80: 30, p95: 42 },
  ORIGIN_DEPARTED: { p50: 17, p80: 27, p95: 40 },
  EXPORT_CUSTOMS: { p50: 16, p80: 26, p95: 38 },
  DEPARTED_ORIGIN_COUNTRY: { p50: 13, p80: 21, p95: 32 },
  ARRIVED_DEST_COUNTRY: { p50: 6, p80: 11, p95: 18 },
  IMPORT_CUSTOMS: { p50: 5, p80: 10, p95: 16 },
  HANDED_TO_LOCAL_CARRIER: { p50: 3.5, p80: 6, p95: 10 },
  IN_TRANSIT_LOCAL: { p50: 2.5, p80: 4.5, p95: 8 },
  OUT_FOR_DELIVERY: { p50: 0.4, p80: 1, p95: 2.5 },
  DELIVERED: { p50: 0, p80: 0, p95: 0 },
  EXCEPTION: { p50: 7, p80: 14, p95: 30 },
  RETURNED: { p50: 30, p80: 45, p95: 60 },
};

/** Baseline priors: dwell days at a milestone before the next scan. */
export const PRIOR_DWELL: Record<Milestone, Quantiles> = {
  SELLER_SHIPPED: { p50: 1.5, p80: 3, p95: 6 },
  ORIGIN_ACCEPTED: { p50: 1, p80: 2.5, p95: 5 },
  ORIGIN_DEPARTED: { p50: 1.5, p80: 3, p95: 6 },
  EXPORT_CUSTOMS: { p50: 1, p80: 2.5, p95: 5 },
  DEPARTED_ORIGIN_COUNTRY: { p50: 5, p80: 9, p95: 16 },
  ARRIVED_DEST_COUNTRY: { p50: 1.5, p80: 3.5, p95: 7 },
  IMPORT_CUSTOMS: { p50: 1.5, p80: 3.5, p95: 7 },
  HANDED_TO_LOCAL_CARRIER: { p50: 1, p80: 2.5, p95: 5 },
  IN_TRANSIT_LOCAL: { p50: 1, p80: 2, p95: 4 },
  OUT_FOR_DELIVERY: { p50: 0.3, p80: 0.8, p95: 2 },
  DELIVERED: { p50: 0, p80: 0, p95: 0 },
  EXCEPTION: { p50: 3, p80: 7, p95: 14 },
  RETURNED: { p50: 10, p80: 20, p95: 40 },
};

/** Prior for total transit (ship → delivered) by service family, days. */
export const PRIOR_TOTAL: Record<string, Quantiles> = {
  default: { p50: 22, p80: 32, p95: 45 },
  aliexpress_standard_shipping: { p50: 20, p80: 29, p95: 40 },
  aliexpress_premium_shipping: { p50: 10, p80: 15, p95: 22 },
  aliexpress_saver_shipping: { p50: 28, p80: 40, p95: 55 },
  aliexpress_selection_standard: { p50: 16, p80: 24, p95: 34 },
  choice: { p50: 15, p80: 22, p95: 32 },
  cainiao: { p50: 22, p80: 32, p95: 45 },
  cainiao_super_economy: { p50: 30, p80: 45, p95: 60 },
  cainiao_super_economy_global: { p50: 30, p80: 45, p95: 60 },
  cainiao_standard: { p50: 20, p80: 30, p95: 42 },
  epacket: { p50: 18, p80: 27, p95: 38 },
  china_post: { p50: 32, p80: 48, p95: 65 },
  yanwen: { p50: 26, p80: 38, p95: 55 },
  '4px': { p50: 22, p80: 33, p95: 48 },
  sunyou: { p50: 26, p80: 38, p95: 55 },
  ems: { p50: 12, p80: 18, p95: 28 },
  dhl: { p50: 6, p80: 9, p95: 14 },
  fedex: { p50: 6, p80: 9, p95: 14 },
  ups: { p50: 6, p80: 9, p95: 14 },
};

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function quantilesOf(samples: number[]): Quantiles | null {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  return { p50: quantile(s, 0.5), p80: quantile(s, 0.8), p95: quantile(s, 0.95) };
}

export function blend(a: Quantiles | null, n: number, b: Quantiles): Quantiles {
  if (!a || n <= 0) return b;
  const w = n / (n + SHRINK_K);
  const mono = (q: Quantiles): Quantiles => ({ p50: q.p50, p80: Math.max(q.p50, q.p80), p95: Math.max(q.p80, q.p95, q.p50) });
  return mono({ p50: w * a.p50 + (1 - w) * b.p50, p80: w * a.p80 + (1 - w) * b.p80, p95: w * a.p95 + (1 - w) * b.p95 });
}

export interface HistorySample { serviceKey: string; milestone: Milestone; remainingDays: number }
export interface DwellSample { serviceKey: string; milestone: Milestone; dwellDays: number }
export interface TotalSample { serviceKey: string; shipFrom: string | null; totalDays: number }

export interface HistoryModel {
  remaining: Map<string, number[]>; // `${service}|${milestone}` → samples
  remainingPooled: Map<Milestone, number[]>;
  dwell: Map<string, number[]>;
  dwellPooled: Map<Milestone, number[]>;
  total: Map<string, number[]>; // service → total days
  totalPooled: number[];
  deliveredParcels: number;
}

/**
 * Build the empirical model from delivered parcels. For each delivered parcel, for each
 * milestone first reached at time t: remaining = deliveredAt − t. Dwell = time until the
 * next distinct milestone.
 */
export function buildHistoryModel(parcels: Parcel[], eventsByParcel: Map<string, TrackEvent[]>): HistoryModel {
  const model: HistoryModel = { remaining: new Map(), remainingPooled: new Map(), dwell: new Map(), dwellPooled: new Map(), total: new Map(), totalPooled: [], deliveredParcels: 0 };
  const push = (m: Map<string, number[]>, k: string, v: number) => { if (isFinite(v) && v >= 0 && v < 200) (m.get(k) ?? m.set(k, []).get(k)!).push(v); };
  const pushM = (m: Map<Milestone, number[]>, k: Milestone, v: number) => { if (isFinite(v) && v >= 0 && v < 200) (m.get(k) ?? m.set(k, []).get(k)!).push(v); };

  for (const p of parcels) {
    const evs = (eventsByParcel.get(p.parcelId) ?? []).filter((e) => e.milestone).sort((a, b) => a.timestamp - b.timestamp);
    // A hand-marked delivery records when the user clicked, not when the parcel arrived, so it is
    // never training data — but its dwell times up to that point still are.
    const manual = !!p.manualState;
    const delivered = manual ? null : p.deliveredAt ?? evs.find((e) => e.milestone === 'DELIVERED')?.timestamp ?? null;
    // Dwell samples are available for every parcel, delivered or not (completed dwells only).
    const firstAt = new Map<Milestone, number>();
    for (const e of evs) if (e.milestone && !firstAt.has(e.milestone)) firstAt.set(e.milestone, e.timestamp);
    const reached = [...firstAt.entries()].filter(([m]) => MILESTONE_ORDER.includes(m)).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < reached.length - 1; i++) {
      const [m, t] = reached[i];
      const dwell = (reached[i + 1][1] - t) / DAY;
      push(model.dwell, `${p.serviceKey}|${m}`, dwell);
      pushM(model.dwellPooled, m, dwell);
    }
    if (!delivered) continue;
    model.deliveredParcels++;
    for (const [m, t] of firstAt) {
      if (m === 'DELIVERED' || !MILESTONE_ORDER.includes(m)) continue;
      const rem = (delivered - t) / DAY;
      push(model.remaining, `${p.serviceKey}|${m}`, rem);
      pushM(model.remainingPooled, m, rem);
    }
    const start = p.shippedAt ?? firstAt.get('SELLER_SHIPPED') ?? evs[0]?.timestamp ?? null;
    if (start) {
      const tot = (delivered - start) / DAY;
      if (tot >= 0.5) { push(model.total, p.serviceKey, tot); if (isFinite(tot) && tot < 200) model.totalPooled.push(tot); }
    }
  }
  return model;
}

export interface RemainingEstimate { q: Quantiles; sampleSize: number; pooledSize: number; basis: string }

export function estimateRemaining(model: HistoryModel | null, serviceKey: string, milestone: Milestone): RemainingEstimate {
  const prior = PRIOR_REMAINING[milestone];
  if (!model) return { q: prior, sampleSize: 0, pooledSize: 0, basis: 'baseline prior (no history yet)' };
  const pooledSamples = model.remainingPooled.get(milestone) ?? [];
  const pooled = blend(quantilesOf(pooledSamples), pooledSamples.length, prior);
  const svcSamples = model.remaining.get(`${serviceKey}|${milestone}`) ?? [];
  const q = blend(quantilesOf(svcSamples), svcSamples.length, pooled);
  const w = svcSamples.length / (svcSamples.length + SHRINK_K);
  const basis = svcSamples.length
    ? `${svcSamples.length} of your ${prettyService(serviceKey)} parcels at this stage (weight ${w.toFixed(2)}) + ${pooledSamples.length} pooled + prior`
    : pooledSamples.length
      ? `${pooledSamples.length} of your parcels at this stage (any service) + prior`
      : 'baseline prior (no history at this stage yet)';
  return { q, sampleSize: svcSamples.length, pooledSize: pooledSamples.length, basis };
}

export function estimateDwellP90(model: HistoryModel | null, serviceKey: string, milestone: Milestone): number {
  const prior = PRIOR_DWELL[milestone];
  const priorP90 = prior.p80 + (prior.p95 - prior.p80) * (2 / 3);
  if (!model) return priorP90;
  const pooledSamples = model.dwellPooled.get(milestone) ?? [];
  const svcSamples = model.dwell.get(`${serviceKey}|${milestone}`) ?? [];
  const p90 = (s: number[]) => (s.length ? quantile([...s].sort((a, b) => a - b), 0.9) : null);
  const wP = pooledSamples.length / (pooledSamples.length + SHRINK_K);
  const pooled = pooledSamples.length ? wP * (p90(pooledSamples) as number) + (1 - wP) * priorP90 : priorP90;
  const wS = svcSamples.length / (svcSamples.length + SHRINK_K);
  return svcSamples.length ? wS * (p90(svcSamples) as number) + (1 - wS) * pooled : pooled;
}

export interface TotalEstimate { q: Quantiles; p20: number; sampleSize: number; basis: 'service' | 'pooled' | 'prior' }

/** Pre-purchase: total transit days for a service (from ship to delivery). */
export function estimateTotal(model: HistoryModel | null, serviceKey: string): TotalEstimate {
  const priorKey = Object.keys(PRIOR_TOTAL).find((k) => k !== 'default' && serviceKey.includes(k)) ?? 'default';
  const prior = PRIOR_TOTAL[priorKey];
  if (!model) return { q: prior, p20: prior.p50 * 0.75, sampleSize: 0, basis: 'prior' };
  const pooled = blend(quantilesOf(model.totalPooled), model.totalPooled.length, prior);
  const svc = [...model.total.entries()].filter(([k]) => k === serviceKey || (serviceKey !== 'unknown' && (k.includes(serviceKey) || serviceKey.includes(k)))).flatMap(([, v]) => v);
  const q = blend(quantilesOf(svc), svc.length, pooled);
  const sorted = [...(svc.length ? svc : model.totalPooled)].sort((a, b) => a - b);
  const p20 = sorted.length ? quantile(sorted, 0.2) : q.p50 * 0.75;
  return { q, p20: Math.min(p20, q.p50), sampleSize: svc.length || model.totalPooled.length, basis: svc.length ? 'service' : model.totalPooled.length ? 'pooled' : 'prior' };
}

export function prettyService(key: string): string {
  return key === 'unknown' ? 'unknown-service' : key.replace(/_/g, ' ');
}

/** Current milestone for prediction: furthest journey milestone; exceptions keep prior milestone. */
export function currentMilestone(events: TrackEvent[]): Milestone | null {
  let best: Milestone | null = null;
  for (const e of events) if (e.milestone && MILESTONE_ORDER.includes(e.milestone) && milestoneIndex(e.milestone) > milestoneIndex(best)) best = e.milestone;
  return best;
}
