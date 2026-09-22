/**
 * Service worker entry: message routing, alarms, tab lifecycle.
 */
import { db } from '@/db/schema';
import type { BgMessage, BgResponse, ListingEstimate } from '@/shared/messages';
import { ORDERS_PAGE_RE } from '@/adapters/aliexpress';
import { ingestCapture } from './ingest';
import { syncAllTracking, syncOrderDetails, syncOrders, syncRefunds, syncTrackingForOrders } from './sync';
import { getJobs, reapStaleJobs, startJob } from './jobs';
import { autoRefresh } from './autoRefresh';
import type { CaptureLogEntry } from '@/model/types';
import { backfillWatchdog, getBackfillState, onDriverProgress, onOrdersTabReady, onTabRemoved, startBackfill, stopBackfill, trickleTracking } from './backfill';
import { pollDueParcels, pollParcel } from './tracker';
import { geocodePendingEvents } from './geocode';
import { buildModel, getHistoryModel, recomputeAll, scheduleRecompute } from './recompute';
import { estimateTotal } from '@/engine/estimator';
import { serviceKeyFor } from '@/adapters/aliexpress';
import { getApiKey, llmExplainParcel, normalizeUnknownEvents, setApiKey } from './llm';
import { refreshRatesIfStale } from './rates';
import { exportAllJson, importAllJson, wipeAll } from './exportImport';

const DASHBOARD_URL = chrome.runtime.getURL('src/dashboard/index.html');

async function openDashboard() {
  const tabs = await chrome.tabs.query({ url: DASHBOARD_URL + '*' });
  if (tabs[0]?.id != null) { await chrome.tabs.update(tabs[0].id, { active: true }); if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true }); }
  else await chrome.tabs.create({ url: DASHBOARD_URL });
}

chrome.action.onClicked.addListener(() => { void openDashboard(); });

/** Register the MAIN-world interceptor as a self-contained IIFE (built by vite.interceptor.config.ts). */
async function registerInterceptor() {
  const id = 'aepi-interceptor-main';
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    const script: chrome.scripting.RegisteredContentScript = { id, js: ['public/interceptor.iife.js'], matches: ['*://*.aliexpress.com/*', '*://*.aliexpress.us/*'], runAt: 'document_start', world: 'MAIN', allFrames: true, persistAcrossSessions: true };
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  } catch (e) { console.warn('[aepi] interceptor registration failed', e); }
}

async function ensureAlarms() {
  const s = await db.getSettings();
  chrome.alarms.create('sync-orders', { periodInMinutes: Math.max(30, s.syncIntervalMin) });
  chrome.alarms.create('poll-tracking', { periodInMinutes: 30 });
  chrome.alarms.create('geocode', { periodInMinutes: 15 });
  chrome.alarms.create('rates', { periodInMinutes: 24 * 60 });
}

/** One entry point for every "the extension just came up" trigger; autoRefresh itself de-dupes. */
function catchUp(trigger: string, force = false) {
  return startJob('refresh', async (report) => autoRefresh(report, { trigger, force }));
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void ensureAlarms();
  void registerInterceptor();
  catchUp(`extension ${reason}`);
  if (reason === 'install') void chrome.tabs.create({ url: DASHBOARD_URL + '#/setup' });
});
chrome.runtime.onStartup.addListener(() => { void ensureAlarms(); void registerInterceptor(); void backfillWatchdog(); scheduleRecompute(3000); catchUp('browser start'); });

chrome.alarms.onAlarm.addListener((alarm) => {
  switch (alarm.name) {
    case 'sync-orders': void syncOrders(2).then(() => scheduleRecompute()); break;
    case 'poll-tracking': void pollDueParcels(); break;
    case 'geocode': void db.getSettings().then((s) => geocodePendingEvents({ network: s.geocodingMode !== 'gazetteer', llm: false })); break;
    case 'rates': void refreshRatesIfStale(); break;
    case 'backfill-watchdog': void backfillWatchdog(); break;
  }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.url && ORDERS_PAGE_RE.test(tab.url)) void onOrdersTabReady(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { void onTabRemoved(tabId); });

function respond(sendResponse: (r: BgResponse) => void, p: Promise<Record<string, unknown> | void>) {
  p.then((r) => sendResponse({ ok: true, ...(r ?? {}) })).catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
}

chrome.runtime.onMessage.addListener((msg: BgMessage, sender, sendResponse: (r: BgResponse) => void) => {
  switch (msg.type) {
    case 'CAPTURE':
      respond(sendResponse, ingestCapture(msg.url, msg.method, msg.body, msg.via, msg.reqBody ?? null).then((stats) => ({ stats })));
      return true;
    case 'PING': sendResponse({ ok: true, ts: Date.now() }); return false;
    case 'OPEN_DASHBOARD': respond(sendResponse, openDashboard()); return true;
    case 'SYNC_NOW':
      sendResponse({ ok: true, ...startJob('sync', async (report) => { await report('orders…'); const r = await syncOrders(3); await report(`orders: ${r.note} (${r.orders})`); const tr = await syncAllTracking(report, true, 60); await report('order pricing…'); const det = await syncOrderDetails(report, 60); await report('returns & refunds…'); const rf = await syncRefunds(report); void det; await report('polling carriers…'); const t = await pollDueParcels(); await recomputeAll(); void rf; return { sync: r, aeTracking: tr, tracking: t }; }) });
      return false;
    case 'SYNC_TRACKING':
      sendResponse({ ok: true, ...startJob('tracking', async (report) => { const tr = await syncAllTracking(report, false, 400); await recomputeAll(); return tr; }) });
      return false;
    case 'DEBUG_CHANNEL_ENABLED': respond(sendResponse, db.getSettings().then((s) => ({ enabled: !!s.debugChannel || !chrome.runtime.getManifest().update_url }))); return true; // unpacked (dev) installs always allow it
    case 'GET_JOBS': respond(sendResponse, getJobs().then((jobs) => ({ jobs }))); return true;
    case 'AUTO_REFRESH': sendResponse({ ok: true, ...catchUp(msg.trigger ?? 'dashboard opened', msg.force) }); return false;
    case 'SYNC_DETAILS':
      sendResponse({ ok: true, ...startJob('details', async (report) => { const r = await syncOrderDetails(report); await recomputeAll(); return r; }) });
      return false;
    case 'SYNC_REFUNDS':
      sendResponse({ ok: true, ...startJob('refunds', async (report) => { const r = await syncRefunds(report); await recomputeAll(); return r; }) });
      return false;
    case 'RELOAD_EXT': sendResponse({ ok: true }); setTimeout(() => chrome.runtime.reload(), 200); return false;
    case 'DIAG':
      respond(sendResponse, (async () => ({
        counts: { orders: await db.orders.count(), items: await db.items.count(), parcels: await db.parcels.count(), events: await db.events.count(), predictions: await db.predictions.count(), alerts: await db.alerts.count() },
        endpoints: (await db.endpoints.toArray()).map((e) => ({ key: e.key, kind: e.kind, method: e.method, hits: e.hits, pageParam: e.pageParam, hasBody: !!e.bodyTemplate, lastOrders: e.lastOrders, lastEvents: e.lastEvents })),
        captureLog: (await db.getKV<CaptureLogEntry[]>('captureLog', [])).slice(-15),
        backfill: await getBackfillState(),
        settings: (({ homeAddress, homeAddressCoords, loggedOut, lastSyncAt, lastSyncResult, geocodingMode }) => ({ homeAddress, homeAddressCoords, loggedOut, lastSyncAt, lastSyncResult, geocodingMode }))(await db.getSettings()),
        parcels: (await db.parcels.toArray()).slice(0, 30).map((p) => ({ tn: p.trackingNo, state: p.state, svc: p.logisticsService, orders: p.orderIds.length, items: p.itemIds.length, last: p.lastMilestone, lastAt: p.lastEventAt, delivered: p.deliveredAt })),
        stateCounts: (await db.parcels.toArray()).reduce<Record<string, number>>((acc, p) => { acc[p.state] = (acc[p.state] ?? 0) + 1; return acc; }, {}),
        sampleEvents: await (async () => { const ps = (await db.parcels.toArray()).slice(0, 3); const out: Record<string, unknown[]> = {}; for (const p of ps) out[p.trackingNo] = (await db.events.where('parcelId').equals(p.parcelId).sortBy('timestamp')).map((e) => ({ t: e.timestamp, m: e.milestone, c: e.code, x: e.rawText.slice(0, 50) })); return out; })(),
        sampleOrders: (await db.orders.orderBy('placedAt').reverse().limit(5).toArray()).map((o) => ({ id: o.orderId, status: o.status, total: o.orderTotal, cur: o.currency, seller: o.sellerName, tns: o.trackingNos.length, promised: o.promisedDeliveryAt, prot: o.protectionEndsAt })),
        dashboardUrl: DASHBOARD_URL,
        build: typeof __AEPI_BUILD__ === 'string' ? __AEPI_BUILD__ : 'dev',
        jobs: await getJobs(),
        itemsWithImage: await db.items.filter((i) => !!i.imageUrl).count(),
        autoRefresh: { enabled: (await db.getSettings()).autoRefreshOnLaunch, lastAt: (await db.getSettings()).lastAutoRefreshAt },
        pricing: { detailed: await db.orders.filter((o) => !!o.pricingDetailed).count(), withShipping: await db.orders.filter((o) => o.shippingCost != null).count(), checkoutGroups: new Set((await db.orders.toArray()).map((o) => o.checkoutGroup).filter(Boolean)).size },
        refunds: { count: await db.refunds.count(), withAmount: await db.refunds.filter((r) => r.refundAmount != null).count(), sample: (await db.refunds.limit(3).toArray()).map((r) => ({ amt: r.refundAmount, st: r.refundStatus, cs: r.caseStatus, type: r.reverseType, sol: r.solutionText })) },
        orderStatus: (await db.orders.toArray()).reduce<Record<string, number>>((acc, o) => { const k = `${o.status}:${o.rawStatus ?? ''}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
        ordersWithTracking: await db.orders.filter((o) => o.trackingNos.length > 0).count(),
        shipped: await (async () => { const os = (await db.orders.toArray()).filter((o) => o.status === 'SHIPPED'); const out = []; for (const o of os) { const ps = await db.parcels.where('trackingNo').anyOf(o.trackingNos.length ? o.trackingNos : ['-']).toArray(); out.push({ tns: o.trackingNos.length, placedDays: o.placedAt ? Math.round((Date.now() - o.placedAt) / 86400000) : null, parcels: ps.map((p) => ({ state: p.state, last: p.lastMilestone, ageDays: p.lastEventAt ? Math.round((Date.now() - p.lastEventAt) / 86400000) : null, delivered: !!p.deliveredAt, orders: p.orderIds.length })) }); } return out; })(),
        trackingChecked: Object.keys(await db.getKV<Record<string, number>>('trackingChecked', {})).length,
      }))());
      return true;
    case 'BACKFILL_START': respond(sendResponse, startBackfill().then((state) => ({ state }))); return true;
    case 'BACKFILL_STOP': respond(sendResponse, stopBackfill().then((state) => ({ state }))); return true;
    case 'BACKFILL_GET_STATE': respond(sendResponse, getBackfillState().then((state) => ({ state }))); return true;
    case 'BACKFILL_PROGRESS':
      respond(sendResponse, onDriverProgress(sender.tab?.id, msg.pagesFetched, msg.ordersOnPage, msg.exhausted).then((r) => ({ stop: r.stop })));
      return true;
    case 'ESTIMATE_FOR_LISTING':
      respond(sendResponse, (async () => {
        const model = getHistoryModel() ?? (await buildModel());
        const est = estimateTotal(model, serviceKeyFor(msg.service));
        const estimate: ListingEstimate = { p50Days: est.q.p50, p80Days: est.q.p80, p20Days: est.p20, sampleSize: est.sampleSize, basis: est.basis, aliexpressDays: msg.aliexpressDays };
        return { estimate };
      })());
      return true;
    case 'EXPLAIN_PARCEL': respond(sendResponse, llmExplainParcel(msg.parcelId).then((text) => ({ text }))); return true;
    case 'POLL_PARCEL': respond(sendResponse, pollParcel(msg.parcelId, { force: true }).then((r) => ({ result: r }))); return true;
    case 'RECOMPUTE': respond(sendResponse, recomputeAll()); return true;
    case 'GEOCODE_PENDING':
      respond(sendResponse, (async () => { const s = await db.getSettings(); const key = await getApiKey(); const r = await geocodePendingEvents({ network: s.geocodingMode !== 'gazetteer', llm: s.geocodingMode === 'nominatim+llm' && !!key, maxNetwork: 60 }); const n = key ? await normalizeUnknownEvents() : 0; await recomputeAll(); return { ...r, normalized: n }; })());
      return true;
    case 'WIPE_ALL': respond(sendResponse, wipeAll()); return true;
    case 'IMPORT_JSON': respond(sendResponse, importAllJson(msg.json).then((r) => { scheduleRecompute(); return r; })); return true;
    case 'SET_API_KEY': respond(sendResponse, setApiKey(msg.apiKey)); return true;
    case 'GET_API_KEY_STATUS': respond(sendResponse, getApiKey().then((k) => ({ hasKey: !!k, hint: k ? `…${k.slice(-4)}` : null }))); return true;
    case 'REQUEST_HOST_PERMISSION': respond(sendResponse, chrome.permissions.request({ origins: [msg.origin] }).then((granted) => ({ granted }))); return true;
    case 'REFRESH_RATES': respond(sendResponse, refreshRatesIfStale(true).then((rates) => ({ rates }))); return true;
    default: return false;
  }
});

// Expose export for the dashboard (large payloads go through the shared IndexedDB instead, but keep a path)
(globalThis as unknown as Record<string, unknown>).__aepiExport = exportAllJson;

void reapStaleJobs();
void ensureAlarms();
void registerInterceptor();
void backfillWatchdog();
void trickleTracking();
scheduleRecompute(2000);
