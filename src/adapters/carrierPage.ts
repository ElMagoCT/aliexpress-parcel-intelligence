/**
 * Read a parcel's progress off a carrier's own tracking page.
 *
 * Carriers do not offer a free API without keys and contracts, and each renders its page
 * differently — so rather than encode one scraper per carrier, this reads the rendered text the
 * user themselves sees. What is always present is a status, a delivery date and place when
 * delivered, and usually a list of dated scans. Milestone wording is handed to the same classifier
 * the AliExpress scans use, so a carrier that phrases things unusually degrades to "unclassified"
 * rather than breaking.
 *
 * The page half (`SCAN_HARVESTER`) collects raw text only; parsing lives here so it can be tested.
 */
import type { Milestone } from '@/model/types';
import { classifyText } from '@/engine/milestones';

export interface CarrierPageHarvest { url: string; title: string; text: string }

export interface CarrierScan { timestamp: number | null; rawText: string; locationText: string | null; milestone: Milestone | null }

export interface CarrierPageResult {
  trackingNo: string | null;
  /** What the carrier says overall. */
  statusText: string | null;
  delivered: boolean;
  deliveredAt: number | null;
  shippedAt: number | null;
  service: string | null;
  lastLocation: string | null;
  scans: CarrierScan[];
  /** False when the page showed nothing recognisable (wrong page, bot wall, number not found). */
  usable: boolean;
}

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const DATE_RES = [
  new RegExp(`\\b(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\\s+(${MONTHS})\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, 'i'),
  new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, 'i'),
  /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
  /\b(\d{4})-(\d{2})-(\d{2})\b/,
];
const TIME_RE = /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i;

/** A date written any of the usual ways. Missing years resolve to the most recent past occurrence. */
export function parseLooseDate(line: string, now = Date.now()): number | null {
  const iso = line.match(DATE_RES[3]);
  if (iso) return Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00`);
  const slash = line.match(DATE_RES[2]);
  if (slash) {
    const t = new Date(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2]), 12).getTime();
    return isNaN(t) ? null : t;
  }
  const named = line.match(DATE_RES[0]) ?? line.match(DATE_RES[1]);
  if (!named) return null;
  const year = named[3] ? Number(named[3]) : new Date(now).getFullYear();
  let t = new Date(`${named[1]} ${named[2]}, ${year} 12:00:00`).getTime();
  if (isNaN(t)) return null;
  if (!named[3] && t > now + 2 * 86400000) t = new Date(`${named[1]} ${named[2]}, ${year - 1} 12:00:00`).getTime();
  return isNaN(t) ? null : t;
}

/** Fold "6:02 P.M." into a date already parsed from the same block. */
export function applyTime(dateMs: number, line: string): number {
  const m = line.match(TIME_RE);
  if (!m) return dateMs;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = (m[3] ?? '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const d = new Date(dateMs);
  d.setHours(h, min, 0, 0);
  return d.getTime();
}

const NOISE = /^(completed|active|at|delivered to:?|skip to|log ?in|tracking no|copy tracking|content_copy|check|close|chevron|keyboard_arrow|arrow_circle|lock|support|shipping|help|about|cookie|privacy|terms|sign in|create a profile|menu|search)\b/i;
const LOCATION_RE = /^[A-Z][A-Za-z .'-]*,\s*[A-Z]{2}\b|^[A-Z][A-Z .'-]{2,}(?:\s+[A-Z]{2}\b|\s+(?:DISTRIBUTION|SORTING|PROCESSING|REGIONAL|FACILITY|CENTER|CENTRE|HUB|DEPOT|AIRPORT)\b)/;

/** Pull whatever a carrier's tracking page is willing to show. */
export function parseCarrierPage(h: CarrierPageHarvest, now = Date.now()): CarrierPageResult {
  const out: CarrierPageResult = {
    trackingNo: h.text.match(/\b(1Z[0-9A-Z]{16}|[A-Z]{2}\d{9}[A-Z]{2}|\d{12,26}|TBA\d{10,15})\b/)?.[1] ?? null,
    statusText: null, delivered: false, deliveredAt: null, shippedAt: null,
    service: null, lastLocation: null, scans: [], usable: false,
  };
  const lines = h.text.split('\n').map((l) => l.trim()).filter(Boolean);
  const lower = h.text.toLowerCase();

  // Carriers that could not find the number, or that served a bot wall, say so plainly.
  if (/not (?:be )?found|no (?:tracking )?information|unable to (?:locate|track)|check the number|invalid tracking/i.test(lower) && !/delivered/i.test(lower)) return out;

  out.delivered = /\bdelivered\b/i.test(lower) && !/not delivered|delivery failed|undeliverable/i.test(lower);
  out.statusText = lines.find((l) => /^(delivered|in transit|out for delivery|label created|exception|returned to sender|pre-?shipment|shipped)\b/i.test(l)) ?? null;

  // Labelled fields most carriers render as "<label>\n<value>".
  const fieldAfter = (labels: RegExp): string | null => {
    for (let i = 0; i < lines.length - 1; i++) if (labels.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) if (!NOISE.test(lines[j])) return lines[j];
    }
    return null;
  };
  out.service = fieldAfter(/^service$|^service type$|^shipping method$/i);
  const shipped = fieldAfter(/shipped\s*\/?\s*billed on|ship date|shipped on|pickup date/i);
  if (shipped) out.shippedAt = parseLooseDate(shipped, now);
  const to = fieldAfter(/^delivered to:?$|^destination$|^delivered at$/i);
  if (to && LOCATION_RE.test(to)) out.lastLocation = to;

  // Scan rows: a date line, then the nearby description and place.
  for (let i = 0; i < lines.length; i++) {
    const date = parseLooseDate(lines[i], now);
    if (date == null) continue;
    // A bare label like "Shipped / Billed On" followed by a date is a field, not a scan.
    if (i > 0 && /shipped\s*\/?\s*billed|ship date|estimated|scheduled|expected/i.test(lines[i - 1])) continue;
    let ts = applyTime(date, lines[i]);
    let desc: string | null = null;
    let loc: string | null = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const l = lines[j];
      if (TIME_RE.test(l) && l.length < 20) { ts = applyTime(ts, l); continue; }
      if (NOISE.test(l)) continue;
      if (!desc && l.length > 3) { desc = l.replace(/\s+at$/, '').trim(); if (TIME_RE.test(desc)) ts = applyTime(ts, desc); continue; }
      if (!loc && LOCATION_RE.test(l)) { loc = l; break; }
    }
    if (!desc) continue;
    out.scans.push({ timestamp: ts, rawText: desc, locationText: loc ?? out.lastLocation, milestone: classifyText(desc) });
  }

  // Milestone chips ("Label Created / On the Way / Out for Delivery / Delivered") carry no dates,
  // but they still tell us how far the parcel got. Add any milestone the dated scans missed.
  const have = new Set(out.scans.map((s) => s.milestone).filter(Boolean));
  for (const l of lines) {
    if (l.length > 60) continue;
    const m = classifyText(l);
    if (m && !have.has(m)) { have.add(m); out.scans.push({ timestamp: null, rawText: l, locationText: out.lastLocation, milestone: m }); }
  }

  // The delivery timestamp is the most valuable single fact on the page.
  const deliveredScan = out.scans.filter((s) => s.milestone === 'DELIVERED' && s.timestamp).sort((a, b) => b.timestamp! - a.timestamp!)[0];
  if (deliveredScan) out.deliveredAt = deliveredScan.timestamp;
  else if (out.delivered) {
    const dated = out.scans.filter((s) => s.timestamp).sort((a, b) => b.timestamp! - a.timestamp!)[0];
    out.deliveredAt = dated?.timestamp ?? null;
  }
  out.usable = out.scans.length > 0 || out.delivered || !!out.statusText;
  return out;
}

/** Injected into the carrier's tab. Self-contained: it is serialised, not bundled. */
export function SCAN_HARVESTER(): CarrierPageHarvest {
  // Expand anything hidden behind a "show details"-style toggle before reading.
  const toggles = [...document.querySelectorAll<HTMLElement>('button, a, [role="button"]')]
    .filter((e) => /show (?:more|details|all)|view (?:more|details|all)|travel history|tracking history|see more/i.test((e.innerText || '').trim()))
    .slice(0, 3);
  toggles.forEach((t) => { try { t.click(); } catch { /* ignore */ } });
  return { url: location.href, title: document.title || '', text: (document.body?.innerText || '').slice(0, 30000) };
}
