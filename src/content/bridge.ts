/**
 * ISOLATED-world content script. Four jobs:
 *  1. Forward captured payloads from the MAIN-world interceptor to the service worker.
 *  2. Drive the backfill (auto-paginate the orders page) when the SW asks.
 *  3. Inject a single "Your history" delivery badge under the Delivery line on product listings.
 *  4. Diagnostics channel: the page (or a dev tool driving it) can ask for extension state via postMessage.
 */
import type { BgMessage, BgResponse, CaptureEnvelope, ListingEstimate } from '@/shared/messages';
import {
  ORDERS_PAGE_RE, PRODUCT_PAGE_RE, countRenderedOrders, findLoadMoreControl, readListingShipFrom, readListingShippingOptions, readRenderedOrderIds,
} from '@/adapters/aliexpress';
import { randBetween, sleep } from '@/shared/util';

const send = (msg: BgMessage): Promise<BgResponse> => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage(msg, (res: BgResponse) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'no response' });
      else resolve(res ?? { ok: false, error: 'empty' });
    });
  } catch (e) { resolve({ ok: false, error: String(e) }); }
});

// Make the extension discoverable from the page (dashboard URL for debugging / deep links).
try { document.documentElement.dataset.aepiExt = chrome.runtime.id; } catch { /* ignore */ }

// ── 1. Capture forwarding ──
window.addEventListener('message', (ev: MessageEvent<CaptureEnvelope & { type: string; cmd?: BgMessage }>) => {
  if (ev.source !== window || !ev.data || ev.data.__aepi !== 1) return;
  if (ev.data.type === 'AEPI_CAPTURE') {
    const { url, method, body, via, reqBody } = ev.data;
    void send({ type: 'CAPTURE', url, method, body, via, pageUrl: location.href, reqBody: reqBody ?? null }).then((res) => {
      const stats = res.ok ? (res as { stats?: Record<string, number> }).stats : null;
      console.debug('[aepi] capture', via, shortPath(url), body.length, 'B →', res.ok ? JSON.stringify(stats) : res.error);
    });
    return;
  }
  // ── 4. Diagnostics / command channel (same-window only; only when the user enabled it in Settings) ──
  if (ev.data.type === 'AEPI_CMD' && ev.data.cmd && /^(DIAG|RELOAD_EXT|POLL_PARCEL|SYNC_NOW|SYNC_TRACKING|SYNC_REFUNDS|SYNC_DETAILS|GET_JOBS|BACKFILL_START|BACKFILL_STOP|BACKFILL_GET_STATE|RECOMPUTE|GEOCODE_PENDING|PING|OPEN_DASHBOARD)$/.test(ev.data.cmd.type)) {
    const id = (ev.data as { id?: string }).id;
    void send({ type: 'DEBUG_CHANNEL_ENABLED' }).then((g) => {
      if (!g.ok || !(g as { enabled?: boolean }).enabled) { window.postMessage({ __aepi: 1, type: 'AEPI_CMD_RESULT', id, res: { ok: false, error: 'debug channel disabled (Settings → Diagnostics)' } }, '*'); return; }
      void send(ev.data.cmd!).then((res) => window.postMessage({ __aepi: 1, type: 'AEPI_CMD_RESULT', id, res }, '*'));
    });
  }
});

function shortPath(url: string) { try { const u = new URL(url); return u.host + u.pathname; } catch { return url.slice(0, 80); } }

// ── 2. Backfill driver ──
let driving = false;
let stopRequested = false;

async function driveBackfill() {
  if (driving) return;
  driving = true;
  stopRequested = false;
  let pages = 0;
  let stagnant = 0;
  let lastCount = -1;
  const seen = new Set<string>();
  showOverlay('Backfill running… scanning your orders. Keep this tab open.');
  try {
    await sleep(2500);
    while (!stopRequested) {
      readRenderedOrderIds(document).forEach((i) => seen.add(i));
      const count = Math.max(countRenderedOrders(document), seen.size);
      const grew = count > lastCount;
      lastCount = count;
      stagnant = grew ? 0 : stagnant + 1;
      pages++;
      const control = findLoadMoreControl(document);
      const exhausted = !control && stagnant >= 2;
      const res = await send({ type: 'BACKFILL_PROGRESS', pagesFetched: pages, ordersOnPage: count, exhausted, note: control ? 'paginating' : 'scrolling' });
      if (!res.ok || (res as { stop?: boolean }).stop) break;
      updateOverlay(`Backfill: page ${pages} · ${count} orders on this page so far`);
      if (exhausted) break;
      if (control) { control.scrollIntoView({ block: 'center' }); control.click(); }
      else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      await sleep(randBetween(1500, 3000));
      if (stagnant >= 4) { await send({ type: 'BACKFILL_PROGRESS', pagesFetched: pages, ordersOnPage: count, exhausted: true, note: 'no growth after 4 rounds' }); break; }
    }
  } finally {
    driving = false;
    hideOverlay();
  }
}

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
  if (msg?.type === 'AEPI_DRIVER_START') { void driveBackfill(); sendResponse({ ok: true }); return true; }
  if (msg?.type === 'AEPI_DRIVER_STOP') { stopRequested = true; sendResponse({ ok: true }); return true; }
  if (msg?.type === 'AEPI_PING') { sendResponse({ ok: true, ordersPage: ORDERS_PAGE_RE.test(location.href), driving }); return true; }
  return false;
});

let overlay: HTMLDivElement | null = null;
function showOverlay(text: string) {
  if (overlay) { updateOverlay(text); return; }
  overlay = document.createElement('div');
  overlay.id = 'aepi-backfill-overlay';
  overlay.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#111827;color:#f9fafb;font:13px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center;max-width:420px';
  const span = document.createElement('span'); span.className = 'aepi-text'; span.textContent = text;
  const btn = document.createElement('button'); btn.textContent = 'Stop'; btn.style.cssText = 'background:#ef4444;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:600 12px system-ui';
  btn.onclick = () => { stopRequested = true; void send({ type: 'BACKFILL_STOP' }); };
  overlay.append(span, btn);
  document.documentElement.appendChild(overlay);
}
function updateOverlay(text: string) { const s = overlay?.querySelector('.aepi-text'); if (s) s.textContent = text; }
function hideOverlay() { overlay?.remove(); overlay = null; }

// ── 3. Listing badge: exactly one small badge under each visible "Delivery:" line ──
let badgeTimer: number | null = null;
let badgeBusy = false;

async function injectBadges() {
  if (badgeBusy || !PRODUCT_PAGE_RE.test(location.href)) return;
  badgeBusy = true;
  try {
    const options = readListingShippingOptions(document).filter((o) => !o.el.nextElementSibling?.classList.contains('aepi-badge') && !o.el.querySelector('.aepi-badge'));
    if (!options.length) return;
    const shipFrom = readListingShipFrom(document);
    for (const opt of options.slice(0, 2)) {
      const res = await send({ type: 'ESTIMATE_FOR_LISTING', service: opt.service, shipFrom, aliexpressDays: opt.aliexpressDays });
      if (!res.ok) continue;
      const est = (res as { estimate?: ListingEstimate }).estimate;
      if (!est) continue;
      if (opt.el.nextElementSibling?.classList.contains('aepi-badge')) continue;
      const badge = document.createElement('div');
      badge.className = 'aepi-badge';
      badge.style.cssText = 'display:inline-block;box-sizing:border-box;max-width:100%;margin:4px 0 2px;padding:4px 9px;border-radius:8px;background:#eef2ff;color:#1e293b;font:12px/1.35 system-ui,sans-serif;border:1px solid #c7d2fe;white-space:normal;text-align:left';
      const lo = Math.round(est.p20Days), mid = Math.round(est.p50Days), hi = Math.round(est.p80Days);
      const basis = est.basis === 'service' ? `based on ${est.sampleSize} similar parcels` : est.basis === 'pooled' ? `no ${opt.service} history — pooled from ${est.sampleSize} of your parcels` : 'no history yet — baseline estimate';
      const vs = est.aliexpressDays != null ? ` · AliExpress says ${est.aliexpressDays} days` : '';
      badge.innerHTML = `<strong>Your history: ${lo}–${hi} days</strong> (P50 ${mid})${vs} · <span style="opacity:.7">${basis}</span>`;
      opt.el.insertAdjacentElement('afterend', badge);
    }
  } finally { badgeBusy = false; }
}

function scheduleBadges() {
  if (badgeTimer) window.clearTimeout(badgeTimer);
  badgeTimer = window.setTimeout(() => { void injectBadges(); }, 1200);
}

if (PRODUCT_PAGE_RE.test(location.href)) {
  window.addEventListener('load', scheduleBadges);
  const mo = new MutationObserver((muts) => { if (muts.some((m) => ![...m.addedNodes].every((n) => (n as HTMLElement).classList?.contains('aepi-badge')))) scheduleBadges(); });
  const start = () => { try { mo.observe(document.body, { childList: true, subtree: true }); } catch { /* ignore */ } };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
}
