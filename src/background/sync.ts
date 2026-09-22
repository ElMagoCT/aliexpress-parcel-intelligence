/**
 * Secondary acquisition: direct fetches from the service worker using the session cookies
 * and the endpoint shapes learned from real traffic (URL + POST body templates, re-signed).
 */
import { db } from '@/db/schema';
import type { EndpointRecord } from '@/model/types';
import { ORDERS_PAGE_URL, REFUNDS_PAGE_URL, REVERSE_DETAIL_API, REVERSE_LIST_API, buildMtopRequest, isTokenExpired, looksLoggedOut, mtopTimeZone, parsePayload, reverseDetailBody, reverseListBody, synthesizeMtopGet, synthesizeMtopPost, withBodyField, withBodyPage, withDataField, withPage } from '@/adapters/aliexpress';
import { ingestBundle, recordEndpoint } from './ingest';
import { jitter, sleep } from '@/shared/util';

export interface SyncResult { ok: boolean; orders: number; events: number; loggedOut: boolean; note: string }

async function mtopToken(): Promise<string | null> {
  try {
    for (const url of ['https://www.aliexpress.com/', 'https://acs.aliexpress.com/', 'https://www.aliexpress.us/']) {
      const c = await chrome.cookies.get({ url, name: '_m_h5_tk' });
      if (c?.value) return c.value.split('_')[0];
    }
  } catch { /* no cookies permission */ }
  return null;
}

export async function directFetch(url: string, method = 'GET', bodyTemplate: string | null = null): Promise<{ status: number; text: string; finalUrl: string }> {
  const token = await mtopToken();
  const { url: signed, init } = buildMtopRequest({ urlTemplate: url, method, bodyTemplate }, token);
  const res = await fetch(signed, init);
  const text = await res.text();
  return { status: res.status, text, finalUrl: res.url };
}

async function fetchWithRetry(url: string, method: string, body: string | null) {
  let r = await directFetch(url, method, body);
  if (isTokenExpired(r.text)) { await sleep(500); r = await directFetch(url, method, body); } // mtop rotates _m_h5_tk on that response
  return r;
}

function pageRequest(ep: EndpointRecord, page: number): { url: string; body: string | null } | null {
  if (ep.pageParam === 'body.pageIndex' && ep.bodyTemplate) return { url: ep.urlTemplate, body: withBodyPage(ep.bodyTemplate, page) };
  if (ep.pageParam) { const u = withPage(ep.urlTemplate, ep.pageParam, page); return u ? { url: u, body: ep.bodyTemplate } : null; }
  return page === 1 ? { url: ep.urlTemplate, body: ep.bodyTemplate } : null;
}

/** Re-fetch the learned order-list endpoint, paginating while pages yield orders. */
export async function syncOrders(maxPages = 3, startPage = 1): Promise<SyncResult & { lastPage: number; exhausted: boolean }> {
  const endpoints = (await db.endpoints.where('kind').equals('orderList').toArray()).sort((a, b) => (b.pageParam ? 1 : 0) - (a.pageParam ? 1 : 0) || b.lastSeenAt - a.lastSeenAt);
  if (!endpoints.length) return { ok: false, orders: 0, events: 0, loggedOut: false, note: `No order endpoint learned yet — open ${ORDERS_PAGE_URL} once while logged in.`, lastPage: 0, exhausted: false };
  const ep = endpoints[0];
  let orders = 0, events = 0, lastPage = startPage - 1, exhausted = false;
  for (let page = startPage; page < startPage + maxPages; page++) {
    const req = pageRequest(ep, page);
    if (!req) { exhausted = page > 1; break; }
    let r: { status: number; text: string; finalUrl: string };
    try { r = await fetchWithRetry(req.url, ep.method, req.body); } catch (e) { return { ok: false, orders, events, loggedOut: false, note: `fetch failed: ${String(e)}`, lastPage, exhausted }; }
    if (looksLoggedOut(r.finalUrl, r.status, r.text)) { await db.patchSettings({ loggedOut: true }); return { ok: false, orders, events, loggedOut: true, note: 'Login required', lastPage, exhausted }; }
    if (r.status >= 500 || r.status === 429) return { ok: false, orders, events, loggedOut: false, note: `HTTP ${r.status}`, lastPage, exhausted };
    const bundle = parsePayload(req.url, r.text);
    if (bundle.loginRequired) { await db.patchSettings({ loggedOut: true }); return { ok: false, orders, events, loggedOut: true, note: 'Login required', lastPage, exhausted }; }
    await recordEndpoint(req.url, ep.method, bundle, ep.pageParam === 'body.pageIndex' ? ep.bodyTemplate : req.body);
    const s = await ingestBundle(bundle, 'aliexpress');
    orders += s.orders; events += s.events; lastPage = page;
    if (bundle.hasMore === false || bundle.orders.length === 0 || !ep.pageParam) { exhausted = bundle.hasMore === false || bundle.orders.length === 0; break; }
    await sleep(jitter(2200, 0.4));
  }
  await db.patchSettings({ loggedOut: false, lastSyncAt: Date.now(), lastSyncResult: `${orders} orders, ${events} events` });
  return { ok: true, orders, events, loggedOut: false, note: 'ok', lastPage, exhausted };
}

/**
 * Fetch AliExpress's own tracking detail for orders that still lack a tracking number (or whose
 * parcels are active), using the querydetail template learned from one visit to a tracking page.
 */
/** Ship-to country as AliExpress' own calls send it; read back from a learned request, else US. */
async function shipToCountry(): Promise<string> {
  for (const e of await db.endpoints.toArray()) {
    const hay = decodeURIComponent(e.urlTemplate) + ' ' + decodeURIComponent(e.bodyTemplate ?? '');
    const m = hay.match(/"ship(?:To|ToCountry)\\*"\s*:\s*\\*"([A-Z]{2})"/);
    if (m) return m[1];
  }
  return 'US';
}

/**
 * Order-detail price breakdown. The order LIST carries only a total — shipping, coupons and tax
 * exist solely on `mtop.aliexpress.trade.buyer.order.detail`, one request per order.
 */
export async function syncOrderDetails(report: (p: string) => Promise<void>, limit = 500): Promise<{ fetched: number; withShipping: number; note: string }> {
  const eps = await db.endpoints.toArray();
  const learned = eps.filter((e) => e.kind === 'orderDetail' && /order\.detail/i.test(e.key) && /tradeOrderId/.test(decodeURIComponent(e.urlTemplate))).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  const base = learned ?? eps.filter((e) => /\/h5\/mtop\./.test(e.urlTemplate)).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  if (!base) return { fetched: 0, withShipping: 0, note: `No AliExpress request shape learned yet — open ${ORDERS_PAGE_URL} once while signed in.` };
  const country = await shipToCountry();
  const tz = mtopTimeZone();
  const todo = (await db.orders.toArray())
    .filter((o) => !o.pricingDetailed && o.status !== 'AWAITING_PAYMENT')
    .sort((a, b) => (b.placedAt ?? 0) - (a.placedAt ?? 0))
    .slice(0, limit);
  if (!todo.length) return { fetched: 0, withShipping: 0, note: 'nothing to fetch' };
  let fetched = 0, withShipping = 0, misses = 0;
  for (const o of todo) {
    const url = learned
      ? withDataField(learned.urlTemplate, 'tradeOrderId', o.orderId)
      : synthesizeMtopGet(base.urlTemplate, 'mtop.aliexpress.trade.buyer.order.detail', { tradeOrderId: o.orderId, clientPlatform: 'pc', shipToCountry: country, _lang: 'en_US', timeZone: tz });
    if (!url) return { fetched, withShipping, note: 'could not build the detail request' };
    try {
      const r = await fetchWithRetry(url, learned?.method ?? 'GET', null);
      if (looksLoggedOut(r.finalUrl, r.status, r.text)) { await db.patchSettings({ loggedOut: true }); return { fetched, withShipping, note: 'Login required' }; }
      if (r.status === 429 || r.status >= 500) return { fetched, withShipping, note: `HTTP ${r.status} — paused, try again later` };
      const bundle = parsePayload(url, r.text);
      const parsed = bundle.orders.find((x) => x.orderId === o.orderId && x.pricingDetailed);
      if (parsed) { await ingestBundle(bundle, 'aliexpress'); fetched++; if (parsed.shippingCost != null) withShipping++; misses = 0; }
      else if (++misses >= 5) return { fetched, withShipping, note: 'order detail returned nothing usable — open one order\'s Details page once so the exact request shape can be learned' };
    } catch (e) { return { fetched, withShipping, note: `fetch failed: ${String(e)}` }; }
    if (fetched % 5 === 0) await report(`${fetched} of ${todo.length} orders priced · ${withShipping} with a shipping line`);
    await sleep(jitter(1400, 0.5));
  }
  await report(`${fetched} of ${todo.length} orders priced · ${withShipping} with a shipping line`);
  return { fetched, withShipping, note: 'ok' };
}

/**
 * Returns / refunds. Needs the two reverse-order templates learned from one visit to the
 * Returns/refunds page (list) and one case detail page (detail). Fetches every finished case
 * (reverseStatus 1 = all) and each case's detail for the actual refunded amount.
 */
/**
 * Open a page in a background tab just long enough for the MAIN-world interceptor to record the
 * request shapes it makes, then close it. Used when a synthesised request isn't accepted.
 * `chrome.tabs.create/remove` need no "tabs" permission.
 */
async function learnFromPage(url: string, matches: (e: EndpointRecord) => boolean, report: (p: string) => Promise<void>, timeoutMs = 30_000): Promise<boolean> {
  const has = async () => (await db.endpoints.toArray()).some(matches);
  if (await has()) return true;
  await report('opening your AliExpress Returns page to learn the request format…');
  let tabId: number | undefined;
  try {
    tabId = (await chrome.tabs.create({ url, active: false })).id;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (await has()) return true;
    }
    return false;
  } catch { return false; } finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch { /* already gone */ } }
  }
}

const isReverseList = (e: EndpointRecord) => e.kind === 'refund' && /pagelist/i.test(e.key) && !!e.bodyTemplate;
const isReverseDetail = (e: EndpointRecord) => e.kind === 'refund' && /render/i.test(e.key) && !!e.bodyTemplate;

export async function syncRefunds(report: (p: string) => Promise<void>): Promise<{ cases: number; detailed: number; note: string }> {
  const anyMtop = () => db.endpoints.toArray().then((es) => es.filter((e) => /\/h5\/mtop\./.test(e.urlTemplate)).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]);
  const base = await anyMtop();
  if (!base) return { cases: 0, detailed: 0, note: `No AliExpress request shape learned yet — open ${ORDERS_PAGE_URL} once while signed in.` };
  const shipTo = await shipToCountry();
  let cases = 0, detailed = 0;

  // The list call: build it ourselves; only fall back to opening the Returns page if that is refused.
  const listReq = async (page: number): Promise<{ url: string; method: string; body: string } | null> => {
    const learned = (await db.endpoints.toArray()).filter(isReverseList).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    if (learned) {
      let body = withBodyField(learned.bodyTemplate!, 'reverseStatus', 1);
      body = body && withBodyField(body, 'pageNo', page);
      body = body && withBodyField(body, 'size', 20);
      if (body) return { url: learned.urlTemplate, method: learned.method || 'POST', body };
    }
    const syn = synthesizeMtopPost(base.urlTemplate, REVERSE_LIST_API, reverseListBody(page, 20, shipTo));
    return syn ? { url: syn.url, method: 'POST', body: syn.body } : null;
  };

  for (let page = 1; page <= 30; page++) {
    let req = await listReq(page);
    if (!req) return { cases, detailed, note: 'could not build the returns request' };
    let r = await fetchWithRetry(req.url, req.method, req.body);
    let bundle = parsePayload(req.url, r.text);
    // Nothing usable on the first page: learn the exact shape from the real page, then retry once.
    if (page === 1 && !bundle.refunds.length) {
      const learned = await learnFromPage(REFUNDS_PAGE_URL, isReverseList, report);
      if (learned) {
        req = await listReq(page);
        if (req) { r = await fetchWithRetry(req.url, req.method, req.body); bundle = parsePayload(req.url, r.text); }
      }
    }
    if (looksLoggedOut(r.finalUrl, r.status, r.text)) { await db.patchSettings({ loggedOut: true }); return { cases, detailed, note: 'Login required' }; }
    if (r.status === 429 || r.status >= 500) return { cases, detailed, note: `HTTP ${r.status} — paused, try again later` };
    if (!bundle.refunds.length) {
      if (page === 1) return { cases, detailed, note: 'AliExpress returned no return/refund cases for this account.' };
      break;
    }
    await ingestBundle(bundle, 'aliexpress');
    cases += bundle.refunds.length;
    await report(`${cases} return/refund case${cases === 1 ? '' : 's'} found`);
    if (bundle.totalPages != null && page >= bundle.totalPages) break;
    await sleep(jitter(1800, 0.4));
  }

  // Per-case detail carries the money actually refunded.
  const todo = (await db.refunds.toArray()).filter((x) => x.refundAmount == null && x.orderId && x.orderLineId);
  for (const rf of todo) {
    const learned = (await db.endpoints.toArray()).filter(isReverseDetail).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    let req: { url: string; method: string; body: string } | null = null;
    if (learned) {
      let body = withBodyField(learned.bodyTemplate!, 'reverseOrderLineId', rf.refundId);
      body = body && withBodyField(body, 'reverseOrderId', rf.reverseOrderId ?? '');
      body = body && withBodyField(body, 'tradeOrderId', rf.orderId ?? '');
      body = body && withBodyField(body, 'tradeOrderLineId', rf.orderLineId ?? '');
      if (body) req = { url: learned.urlTemplate, method: learned.method || 'POST', body };
    }
    if (!req) {
      const syn = synthesizeMtopPost(base.urlTemplate, REVERSE_DETAIL_API, reverseDetailBody({ reverseOrderLineId: rf.refundId, reverseOrderId: rf.reverseOrderId, tradeOrderId: rf.orderId, tradeOrderLineId: rf.orderLineId }, shipTo));
      if (syn) req = { url: syn.url, method: 'POST', body: syn.body };
    }
    if (!req) break;
    try {
      const r = await fetchWithRetry(req.url, req.method, req.body);
      if (r.status === 429 || r.status >= 500) return { cases, detailed, note: `HTTP ${r.status} — paused, try again later` };
      const b = parsePayload(req.url, r.text);
      if (b.refunds.length) { await ingestBundle(b, 'aliexpress'); detailed++; }
    } catch (e) { return { cases, detailed, note: `fetch failed: ${String(e)}` }; }
    await report(`${cases} cases · ${detailed} refund amounts fetched`);
    await sleep(jitter(1500, 0.5));
  }
  return { cases, detailed, note: cases ? 'ok' : 'no cases' };
}

/** Run the per-order tracking fetch until nothing is left (or a stop condition), reporting progress. */
export async function syncAllTracking(report: (p: string) => Promise<void>, onlyMissing = true, maxOrders = 400): Promise<{ fetched: number; parcels: number; events: number; note: string }> {
  let fetched = 0, parcels = 0, events = 0, note = 'ok';
  for (let round = 0; round < Math.ceil(maxOrders / 10); round++) {
    const r = await syncTrackingForOrders(10, onlyMissing);
    fetched += r.fetched; parcels += r.parcels; events += r.events; note = r.note;
    await report(`${fetched} orders fetched · ${parcels} parcels · ${events} scans${r.note !== 'ok' ? ` · ${r.note}` : ''}`);
    if (!r.fetched || r.note === 'Login required' || /^HTTP/.test(r.note)) break;
  }
  return { fetched, parcels, events, note };
}

export async function syncTrackingForOrders(limit = 15, onlyMissing = true): Promise<{ fetched: number; parcels: number; events: number; note: string }> {
  const eps = (await db.endpoints.where('kind').equals('tracking').toArray()).filter((e) => /aliexpress\.(com|us)/.test(e.urlTemplate) && /tradeOrderId/.test(decodeURIComponent(e.urlTemplate))).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (!eps.length) return { fetched: 0, parcels: 0, events: 0, note: 'No AliExpress tracking endpoint learned yet — open one order\'s "Track status" page once.' };
  const ep = eps[0];
  // Orders already checked that yielded no parcel (never shipped / tracking gone) — skip for a week.
  const checked = await db.getKV<Record<string, number>>('trackingChecked', {});
  const weekAgo = Date.now() - 7 * 86_400_000;
  const orders = (await db.orders.toArray()).filter((o) => o.status !== 'AWAITING_PAYMENT' && o.status !== 'CLOSED' && o.status !== 'REFUNDED' && !(checked[o.orderId] && checked[o.orderId] > weekAgo && !o.trackingNos.length));
  const activeParcelOrders = new Set((await db.parcels.toArray()).filter((p) => p.state !== 'DELIVERED' && p.state !== 'RETURNED' && p.state !== 'CLOSED').flatMap((p) => p.orderIds));
  const rank = (o: typeof orders[number]) => (o.status === 'SHIPPED' || o.status === 'AWAITING_SHIPMENT' || activeParcelOrders.has(o.orderId) ? 0 : 1);
  const todo = orders.filter((o) => !o.trackingNos.length || activeParcelOrders.has(o.orderId) || (!onlyMissing && o.status !== 'COMPLETED' && o.status !== 'DELIVERED'))
    .sort((a, b) => rank(a) - rank(b) || (b.placedAt ?? 0) - (a.placedAt ?? 0)) // active orders first, then newest completed
    .slice(0, limit);
  let fetched = 0, parcels = 0, events = 0;
  for (const o of todo) {
    const url = withDataField(ep.urlTemplate, 'tradeOrderId', o.orderId);
    if (!url) break;
    try {
      const r = await fetchWithRetry(url, ep.method, null);
      if (looksLoggedOut(r.finalUrl, r.status, r.text)) { await db.patchSettings({ loggedOut: true }); return { fetched, parcels, events, note: 'Login required' }; }
      if (r.status === 429 || r.status >= 500) return { fetched, parcels, events, note: `HTTP ${r.status}` };
      const bundle = parsePayload(url, r.text);
      const s = await ingestBundle(bundle, 'aliexpress');
      fetched++; parcels += s.parcels; events += s.events;
      if (!bundle.parcels.length) { checked[o.orderId] = Date.now(); await db.setKV('trackingChecked', checked); }
    } catch (e) { return { fetched, parcels, events, note: `fetch failed: ${String(e)}` }; }
    await sleep(jitter(2500, 0.5));
  }
  return { fetched, parcels, events, note: todo.length ? 'ok' : 'nothing to fetch' };
}
