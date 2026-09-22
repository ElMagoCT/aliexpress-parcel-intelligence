/**
 * Cainiao global tracking adapter. Knows the public tracking JSON endpoint and its
 * two response shapes (plain JSON / JSONP with callback). Reuses the AliExpress
 * structural event parser so field-name drift is handled in one place.
 */
import type { RawTrackingEvent } from './aliexpress';
import { parsePayload } from './aliexpress';
import { isRecord, unwrapJsonp } from '@/shared/util';

export const CAINIAO_DETAIL_URLS = (trackingNo: string): string[] => [
  `https://global.cainiao.com/global/detail.json?mailNoList=${encodeURIComponent(trackingNo)}&lang=en-US`,
  `https://global.cainiao.com/global/detail.json?mailNos=${encodeURIComponent(trackingNo)}&lang=en-US`,
  `https://global.cainiao.com/global/detail.json?mailNoList=${encodeURIComponent(trackingNo)}&lang=en-US&callback=jsonp_aepi`,
];

export const CAINIAO_PAGE_URL = (trackingNo: string) => `https://global.cainiao.com/newDetail.htm?mailNoList=${encodeURIComponent(trackingNo)}&lang=en-US`;

export interface CainiaoResult {
  ok: boolean;
  trackingNo: string;
  events: RawTrackingEvent[];
  status: string | null;
  statusDesc: string | null;
  originCountry: string | null;
  destCountry: string | null;
  serviceName: string | null;
  delivered: boolean;
  closed: boolean;
  error: string | null;
}

export function parseCainiao(trackingNo: string, bodyText: string): CainiaoResult {
  const res: CainiaoResult = { ok: false, trackingNo, events: [], status: null, statusDesc: null, originCountry: null, destCountry: null, serviceName: null, delivered: false, closed: false, error: null };
  const payload = unwrapJsonp(bodyText);
  if (payload === undefined) {
    // HTML page? try embedded JSON blobs
    const m = bodyText.match(/detail(?:List|Data)?\s*[:=]\s*(\{[\s\S]*?\})\s*[;,]\s*\n/);
    if (m) return parseCainiao(trackingNo, m[1]);
    res.error = 'unparseable';
    return res;
  }
  if (isRecord(payload) && payload.success === false) { res.error = String(payload.errorMsg ?? payload.message ?? 'cainiao error'); return res; }
  const modules = isRecord(payload) ? (payload.module ?? payload.data ?? payload.result ?? payload) : payload;
  const list = Array.isArray(modules) ? modules : [modules];
  for (const mod of list) {
    if (!isRecord(mod)) continue;
    const mail = String(mod.mailNo ?? mod.trackingNo ?? mod.mailNoList ?? trackingNo).toUpperCase();
    if (mail && mail !== trackingNo.toUpperCase() && list.length > 1) continue;
    res.status = strOrNull(mod.status) ?? strOrNull(mod.statusCode);
    res.statusDesc = strOrNull(mod.statusDesc) ?? strOrNull(mod.statusText);
    res.originCountry = strOrNull(mod.originCountry) ?? strOrNull(mod.originCountryName) ?? strOrNull(mod.sendCountry);
    res.destCountry = strOrNull(mod.destCountry) ?? strOrNull(mod.destCountryName) ?? strOrNull(mod.receiveCountry);
    const gs = mod.globalCombinedLogisticsTraceDTO ?? mod.logisticsCompany ?? mod.cpName ?? mod.companyName ?? mod.serviceName;
    res.serviceName = isRecord(gs) ? strOrNull(gs.serviceName ?? gs.cpName) : strOrNull(gs);
    if (/SIGNED|DELIVERED|SIGNIN|FINISH/i.test(res.status ?? '') || /delivered|signed/i.test(res.statusDesc ?? '')) res.delivered = true;
    if (/RETURN|CLOSED|EXPIRED|CANCEL/i.test(res.status ?? '')) res.closed = true;
  }
  const bundle = parsePayload('https://global.cainiao.com/global/detail.json', JSON.stringify(payload));
  res.events = bundle.events.map((e) => ({ ...e, trackingNo }));
  // Cainiao lists newest-first; normalise to oldest-first.
  res.events.sort((a, b) => a.timestamp - b.timestamp);
  res.ok = res.events.length > 0 || !!res.status;
  if (!res.ok) res.error = 'no events';
  return res;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;
}
