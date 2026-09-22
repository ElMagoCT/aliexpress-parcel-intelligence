/**
 * Capture an item from any shopping page.
 *
 * The extension only speaks AliExpress natively. For every other store this reads the structured
 * data sites already publish for search engines and social previews — JSON-LD `Product`, OpenGraph,
 * microdata — and falls back to visible text. That is deliberately generic: guessing at each
 * retailer's private API would break constantly, whereas these three formats are near-universal
 * and stable.
 *
 * The page half (`HARVESTER`) only collects raw signals; all parsing happens here so it can be
 * tested without a browser.
 */
import type { Platform } from '@/model/types';
import { findTrackingNumbers } from '@/engine/carriers';

export interface PageHarvest {
  url: string;
  title: string;
  /** <meta name|property> → content */
  metas: Record<string, string>;
  /** Parsed contents of every <script type="application/ld+json"> */
  jsonLd: unknown[];
  /** Visible text, truncated. */
  text: string;
  /** Candidate images, largest rendered first. */
  images: string[];
}

export interface CapturedItem {
  platform: Platform;
  title: string | null;
  imageUrl: string | null;
  price: number | null;
  currency: string | null;
  trackingNumbers: string[];
  orderId: string | null;
  sourceUrl: string;
}

const HOSTS: [RegExp, Platform][] = [
  [/aliexpress\./i, 'aliexpress'], [/amazon\.|amzn\./i, 'amazon'], [/ebay\./i, 'ebay'],
  [/temu\./i, 'temu'], [/shein\./i, 'shein'], [/etsy\./i, 'etsy'],
  [/walmart\./i, 'walmart'], [/alibaba\./i, 'alibaba'],
];

export function platformFromUrl(url: string): Platform {
  try {
    const host = new URL(url).hostname;
    return HOSTS.find(([re]) => re.test(host))?.[1] ?? 'other';
  } catch { return 'other'; }
}

const CURRENCY_SIGNS: Record<string, string> = { $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₺': 'TRY', '₽': 'RUB', 'R$': 'BRL', 'C$': 'CAD', 'A$': 'AUD' };

/** "US $12.34", "€ 1.234,56", "12,34 zł" → a number plus the currency when it can be told. */
export function parsePriceText(text: string): { price: number | null; currency: string | null } {
  if (!text) return { price: null, currency: null };
  const iso = text.match(/\b([A-Z]{3})\b/)?.[1] ?? null;
  let currency = iso && /^(USD|EUR|GBP|JPY|CNY|CAD|AUD|BRL|MXN|PLN|SEK|CHF|TRY|INR|KRW|ILS|NZD|RUB|HKD|SGD|ZAR|NOK|DKK|CZK|HUF|RON|THB|PHP|VND|IDR|MYR|AED|SAR|UAH)$/.test(iso) ? iso : null;
  if (!currency) {
    for (const sign of Object.keys(CURRENCY_SIGNS).sort((a, b) => b.length - a.length)) {
      if (text.includes(sign)) { currency = CURRENCY_SIGNS[sign]; break; }
    }
  }
  const m = text.match(/\d[\d., \s]*\d|\d/);
  if (!m) return { price: null, currency };
  let n = m[0].replace(/[\s ]/g, '');
  // Decide which separator is the decimal one: the last separator with 1-2 trailing digits wins.
  if (/[.,]\d{1,2}$/.test(n)) {
    const sep = n.slice(n.length - 3).match(/[.,]/)?.[0];
    n = sep === ',' ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
  } else n = n.replace(/[.,]/g, '');
  const price = parseFloat(n);
  return { price: isFinite(price) ? price : null, currency };
}

function walkJsonLd(nodes: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown, d = 0) => {
    if (d > 6 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => visit(x, d + 1)); return; }
    if (typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    out.push(o);
    for (const k of ['@graph', 'mainEntity', 'itemListElement', 'hasPart']) if (o[k]) visit(o[k], d + 1);
  };
  nodes.forEach((n) => visit(n));
  return out;
}

const typeOf = (o: Record<string, unknown>): string => {
  const t = o['@type'];
  return (Array.isArray(t) ? t.join(' ') : String(t ?? '')).toLowerCase();
};

export function parseShoppingPage(h: PageHarvest): CapturedItem {
  const out: CapturedItem = {
    platform: platformFromUrl(h.url), title: null, imageUrl: null, price: null,
    currency: null, trackingNumbers: [], orderId: null, sourceUrl: h.url,
  };
  const meta = (...keys: string[]) => { for (const k of keys) { const v = h.metas[k.toLowerCase()]; if (v) return v; } return null; };

  // 1. JSON-LD Product is the most reliable when a site publishes it.
  const nodes = walkJsonLd(h.jsonLd);
  const product = nodes.find((o) => /product/.test(typeOf(o)));
  if (product) {
    out.title = str(product.name) ?? out.title;
    out.imageUrl = firstImage(product.image) ?? out.imageUrl;
    const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    if (offers && typeof offers === 'object') {
      const o = offers as Record<string, unknown>;
      const p = parsePriceText(String(o.price ?? o.lowPrice ?? ''));
      out.price = p.price ?? out.price;
      out.currency = str(o.priceCurrency) ?? p.currency ?? out.currency;
    }
  }
  const orderNode = nodes.find((o) => /order|parceldelivery/.test(typeOf(o)));
  if (orderNode) out.orderId = str(orderNode.orderNumber) ?? str(orderNode.identifier) ?? out.orderId;

  // 2. OpenGraph / microdata.
  out.title ||= meta('og:title', 'twitter:title', 'title');
  out.imageUrl ||= meta('og:image', 'og:image:secure_url', 'twitter:image', 'image');
  if (out.price == null) {
    const p = parsePriceText(meta('product:price:amount', 'og:price:amount', 'twitter:data1', 'price') ?? '');
    out.price = p.price;
    out.currency ||= meta('product:price:currency', 'og:price:currency') ?? p.currency;
  }
  out.title ||= h.title || null;

  // 3. Visible text, as a last resort for price and always for tracking numbers.
  if (out.price == null) {
    const m = h.text.match(/(?:US\s*)?[$£€¥₹₩]\s?\d[\d.,]{0,12}|\b\d[\d.,]{0,12}\s?(?:USD|EUR|GBP|CAD|AUD|PLN|BRL|zł)\b/);
    if (m) { const p = parsePriceText(m[0]); out.price = p.price; out.currency ||= p.currency; }
  }
  out.trackingNumbers = findTrackingNumbers(h.text);
  out.orderId ||= h.text.match(/\b(?:order(?:\s*(?:id|number|#))?|ref\.?\s*number)\s*[:#]?\s*([A-Z0-9-]{6,25})\b/i)?.[1] ?? null;
  if (!out.imageUrl && h.images.length) out.imageUrl = h.images[0];
  if (out.imageUrl?.startsWith('//')) out.imageUrl = 'https:' + out.imageUrl;
  if (out.title) out.title = out.title.replace(/\s+/g, ' ').trim().slice(0, 200);
  return out;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;
}
function firstImage(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstImage(v[0]);
  if (v && typeof v === 'object') return str((v as Record<string, unknown>).url ?? (v as Record<string, unknown>).contentUrl);
  return null;
}

/**
 * Injected into the active tab by the popup. Must be self-contained — it is serialised, not bundled.
 */
export function HARVESTER(): PageHarvest {
  const metas: Record<string, string> = {};
  document.querySelectorAll('meta').forEach((m) => {
    const k = (m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop') || '').toLowerCase();
    const v = m.getAttribute('content') || '';
    if (k && v && !metas[k]) metas[k] = v;
  });
  document.querySelectorAll('[itemprop]').forEach((el) => {
    const k = (el.getAttribute('itemprop') || '').toLowerCase();
    const v = el.getAttribute('content') || (el as HTMLElement).innerText || '';
    if (k && v && !metas[k]) metas[k] = v.slice(0, 200);
  });
  const jsonLd: unknown[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try { jsonLd.push(JSON.parse(s.textContent || '')); } catch { /* sites ship broken JSON-LD all the time */ }
  });
  const images = [...document.images]
    .filter((i) => i.naturalWidth >= 150 && i.naturalHeight >= 150 && i.src.startsWith('http'))
    .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)
    .slice(0, 8)
    .map((i) => i.src);
  return {
    url: location.href,
    title: document.title || '',
    metas,
    jsonLd,
    text: (document.body?.innerText || '').slice(0, 20000),
    images,
  };
}
