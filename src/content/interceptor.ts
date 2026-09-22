/**
 * MAIN-world interceptor. Runs at document_start on AliExpress pages.
 * Monkey-patches fetch, XMLHttpRequest and mtop JSONP callbacks; mirrors matching
 * response payloads to the ISOLATED-world bridge via window.postMessage.
 * Must stay dependency-light: it runs inside the page's JS context.
 */
import { shouldCaptureUrl } from '@/adapters/aliexpress';
import type { CaptureEnvelope } from '@/shared/messages';

(() => {
  const w = window as Window & { __aepiInstalled?: boolean };
  if (w.__aepiInstalled) return;
  w.__aepiInstalled = true;

  const MAX_BODY = 6_000_000;
  const bodyToString = (b: unknown): string | null => {
    try {
      if (b == null) return null;
      if (typeof b === 'string') return b.length < 200_000 ? b : null;
      if (b instanceof URLSearchParams) return b.toString();
      if (b instanceof FormData) { const p = new URLSearchParams(); b.forEach((v, k) => { if (typeof v === 'string') p.append(k, v); }); return p.toString(); }
    } catch { /* ignore */ }
    return null;
  };
  const post = (url: string, method: string, body: string, via: CaptureEnvelope['via'], reqBody: string | null = null) => {
    if (!body || body.length > MAX_BODY) return;
    const env: CaptureEnvelope = { __aepi: 1, type: 'AEPI_CAPTURE', url, method, body, reqBody, via, ts: Date.now() };
    try { window.postMessage(env, '*'); } catch { /* ignore */ }
  };
  const abs = (u: string) => { try { return new URL(u, location.href).toString(); } catch { return u; } };

  // ── fetch ──
  const origFetch = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const p = origFetch.call(this, input as RequestInfo, init);
    try {
      const url = abs(typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url);
      if (shouldCaptureUrl(url)) {
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const reqBody = bodyToString(init?.body);
        p.then((res) => { try { res.clone().text().then((t) => post(res.url || url, method, t, 'fetch', reqBody)).catch(() => {}); } catch { /* ignore */ } }).catch(() => {});
      }
    } catch { /* ignore */ }
    return p;
  } as typeof window.fetch;

  // ── XHR ──
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (this: XMLHttpRequest & { __aepiUrl?: string; __aepiMethod?: string }, method: string, url: string | URL) {
    try { this.__aepiUrl = abs(String(url)); this.__aepiMethod = String(method).toUpperCase(); } catch { /* ignore */ }
    return origOpen.apply(this, arguments as unknown as Parameters<typeof origOpen>);
  } as typeof XHR.open;
  XHR.send = function (this: XMLHttpRequest & { __aepiUrl?: string; __aepiMethod?: string }, sendBody?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const url = this.__aepiUrl ?? '';
      if (shouldCaptureUrl(url)) {
        const reqBody = bodyToString(sendBody);
        this.addEventListener('loadend', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') post(this.responseURL || url, this.__aepiMethod ?? 'GET', this.responseText, 'xhr', reqBody);
            else if (this.responseType === 'json' && this.response != null) post(this.responseURL || url, this.__aepiMethod ?? 'GET', JSON.stringify(this.response), 'xhr', reqBody);
          } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }
    return origSend.apply(this, arguments as unknown as Parameters<typeof origSend>);
  };

  // ── JSONP (mtop's classic transport): wrap the callback named in the script URL ──
  const wrapJsonp = (script: HTMLScriptElement) => {
    try {
      const src = script.src;
      if (!src || !shouldCaptureUrl(src)) return;
      const cb = new URL(src).searchParams.get('callback');
      if (!cb || !/^[\w$]+$/.test(cb)) return;
      const g = window as unknown as Record<string, unknown>;
      const orig = g[cb];
      if (typeof orig !== 'function' || (orig as { __aepiWrapped?: boolean }).__aepiWrapped) return;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        try { post(src, 'GET', JSON.stringify(args[0]), 'jsonp'); } catch { /* ignore */ }
        return (orig as (...a: unknown[]) => unknown).apply(this, args);
      };
      (wrapped as { __aepiWrapped?: boolean }).__aepiWrapped = true;
      g[cb] = wrapped;
    } catch { /* ignore */ }
  };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => { if (n instanceof HTMLScriptElement) wrapJsonp(n); });
  });
  const startObserve = () => { try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch { /* ignore */ } };
  if (document.documentElement) startObserve(); else document.addEventListener('DOMContentLoaded', startObserve, { once: true });

  // ── Server-rendered initial state (runParams / __INIT_DATA__ etc.) ──
  const harvestGlobals = () => {
    const g = window as unknown as Record<string, unknown>;
    for (const key of ['runParams', '_d_c_', '__INIT_DATA__', '__INITIAL_STATE__', '__PRELOADED_STATE__', 'aeData', '_init_data_']) {
      try {
        const v = g[key];
        if (v && typeof v === 'object') {
          const s = JSON.stringify(v);
          if (/orderId|tradeOrderId|logisticsNo|mailNo|trackingNo|freight|shipping/i.test(s)) post(`${location.origin}${location.pathname}#${key}`, 'GET', s, 'runParams');
        }
      } catch { /* ignore */ }
    }
  };
  window.addEventListener('load', () => { setTimeout(harvestGlobals, 800); setTimeout(harvestGlobals, 4000); });
})();
