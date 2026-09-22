/**
 * Carrier identification for tracking numbers from any store, not just AliExpress.
 *
 * Patterns are ordered most-specific first. Nothing here talks to a carrier API — the goal is to
 * label a number, offer a working "track on the carrier's site" link, and let the poller decide
 * whether it knows how to fetch scans for it (today: Cainiao only; everything else is stored and
 * linked out).
 */

export interface Carrier {
  key: string;
  name: string;
  /** Build the public tracking URL for a number. */
  url: (tn: string) => string;
  /** Can the extension fetch scan events for this carrier itself? */
  pollable: boolean;
}

const t17 = (tn: string) => `https://t.17track.net/en#nums=${encodeURIComponent(tn)}`;

export const CARRIERS: Record<string, Carrier> = {
  cainiao: { key: 'cainiao', name: 'Cainiao / AliExpress', pollable: true, url: (tn) => `https://global.cainiao.com/newDetail.htm?mailNoList=${encodeURIComponent(tn)}&lang=en-US` },
  usps: { key: 'usps', name: 'USPS', pollable: false, url: (tn) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tn)}` },
  ups: { key: 'ups', name: 'UPS', pollable: false, url: (tn) => `https://www.ups.com/track?tracknum=${encodeURIComponent(tn)}` },
  fedex: { key: 'fedex', name: 'FedEx', pollable: false, url: (tn) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tn)}` },
  dhl: { key: 'dhl', name: 'DHL', pollable: false, url: (tn) => `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(tn)}` },
  amazon: { key: 'amazon', name: 'Amazon Logistics', pollable: false, url: (tn) => `https://track.amazon.com/tracking/${encodeURIComponent(tn)}` },
  royalmail: { key: 'royalmail', name: 'Royal Mail', pollable: false, url: (tn) => `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(tn)}` },
  canadapost: { key: 'canadapost', name: 'Canada Post', pollable: false, url: (tn) => `https://www.canadapost-postescanada.ca/track-reperage/en#/resultList?searchFor=${encodeURIComponent(tn)}` },
  auspost: { key: 'auspost', name: 'Australia Post', pollable: false, url: (tn) => `https://auspost.com.au/mypost/track/#/details/${encodeURIComponent(tn)}` },
  yunexpress: { key: 'yunexpress', name: 'YunExpress', pollable: false, url: t17 },
  fourpx: { key: 'fourpx', name: '4PX', pollable: false, url: t17 },
  sfexpress: { key: 'sfexpress', name: 'SF Express', pollable: false, url: (tn) => `https://www.sf-express.com/we/ow/chn/en/waybill/detail/${encodeURIComponent(tn)}` },
  chinapost: { key: 'chinapost', name: 'China Post', pollable: false, url: t17 },
  evri: { key: 'evri', name: 'Evri', pollable: false, url: (tn) => `https://www.evri.com/track/parcel/${encodeURIComponent(tn)}` },
  dpd: { key: 'dpd', name: 'DPD', pollable: false, url: t17 },
  gls: { key: 'gls', name: 'GLS', pollable: false, url: t17 },
  postal: { key: 'postal', name: 'Postal (UPU)', pollable: false, url: t17 },
  unknown: { key: 'unknown', name: 'Unknown carrier', pollable: false, url: t17 },
};

/** ISO country of an S10 (UPU) number like `LX123456789CN`. */
export function s10Country(tn: string): string | null {
  const m = /^[A-Z]{2}\d{9}([A-Z]{2})$/.exec(tn);
  return m ? m[1] : null;
}

const RULES: [string, RegExp][] = [
  ['ups', /^1Z[0-9A-Z]{16}$/],
  ['amazon', /^TBA\d{10,15}$/],
  ['cainiao', /^(LP|LZ|SWX|CNAE|AE)[0-9A-Z]{8,26}$/],
  ['fourpx', /^4PX[0-9A-Z]{8,26}$/],
  ['yunexpress', /^(YT|YU)\d{10,18}$/],
  ['sfexpress', /^SF\d{10,15}$/],
  ['dhl', /^(GM|LX|RX|CN|JV|JJD)[0-9A-Z]{8,22}$/],
  ['evri', /^(H[0-9A-Z]{15}|\d{16})$/],
  ['usps', /^(94|93|92|95|82)\d{18,24}$/],
  ['usps', /^420\d{5,9}(94|93|92|95)\d{18,22}$/],
  ['fedex', /^\d{12}$|^\d{15}$|^\d{20}$|^\d{22}$/],
  ['canadapost', /^\d{16}$/],
  ['dhl', /^\d{10}$/],
];

export interface CarrierGuess { carrier: Carrier; confident: boolean; country: string | null }

/** Identify the carrier behind a tracking number. Falls back to the UPU country, then 17track. */
export function detectCarrier(trackingNo: string | null | undefined, hint?: string | null): CarrierGuess {
  const tn = (trackingNo ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!tn) return { carrier: CARRIERS.unknown, confident: false, country: null };

  // An explicit carrier/service name from the store beats any pattern.
  const h = (hint ?? '').toLowerCase();
  if (h) {
    const named: [string, RegExp][] = [
      ['cainiao', /cainiao|aliexpress|choice/], ['usps', /usps|united states postal/], ['ups', /\bups\b/],
      ['fedex', /fedex/], ['dhl', /dhl/], ['amazon', /amazon/], ['royalmail', /royal ?mail/],
      ['canadapost', /canada ?post/], ['auspost', /australia ?post|auspost/], ['yunexpress', /yun ?express/],
      ['fourpx', /4px/], ['sfexpress', /sf ?express/], ['chinapost', /china ?post|epacket/], ['evri', /evri|hermes/],
      ['dpd', /\bdpd\b/], ['gls', /\bgls\b/],
    ];
    const hit = named.find(([, re]) => re.test(h));
    if (hit) return { carrier: CARRIERS[hit[0]], confident: true, country: s10Country(tn) };
  }

  const country = s10Country(tn);
  for (const [key, re] of RULES) if (re.test(tn)) return { carrier: CARRIERS[key], confident: true, country };
  if (country) {
    // S10 is the universal postal format; the country tells us which postal operator handed it over.
    const byCountry: Record<string, string> = { CN: 'chinapost', GB: 'royalmail', CA: 'canadapost', AU: 'auspost', US: 'usps' };
    const key = byCountry[country];
    return { carrier: key ? CARRIERS[key] : CARRIERS.postal, confident: !!key, country };
  }
  return { carrier: CARRIERS.unknown, confident: false, country: null };
}

/** Tracking numbers found loose in page text (an order confirmation, a shipping email, …). */
export function findTrackingNumbers(text: string, limit = 12): string[] {
  const out = new Set<string>();
  const candidates = text.toUpperCase().match(/\b[0-9A-Z]{8,35}\b/g) ?? [];
  for (const c of candidates) {
    if (!/\d/.test(c)) continue;             // pure words are never tracking numbers
    if (/^\d{1,7}$/.test(c)) continue;       // too short to be one
    const g = detectCarrier(c);
    if (g.confident) out.add(c);
    if (out.size >= limit) break;
  }
  return [...out];
}
