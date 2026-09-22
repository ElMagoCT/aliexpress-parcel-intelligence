/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AliExpress adapter — THE ONLY FILE that knows AliExpress' shapes.
 *
 *  • URL patterns for order / logistics / freight endpoints
 *  • JSON field paths (order, item, tracking, money, dates)
 *  • DOM selectors for the orders page and product listings
 *  • mtop request signing for direct service-worker fetches
 *
 *  Everything is written defensively: every field may be missing, renamed
 *  or reshaped. Parsers return partial results instead of throwing.
 *  Strategy is STRUCTURAL: instead of hard-coding one JSON path we walk the
 *  payload and recognise order-like / item-like / tracking-like objects by the
 *  keys they carry. Exact paths change; key vocabularies barely do.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { Item, Milestone, Order, OrderStatus } from '@/model/types';
import { isRecord, normalizeServiceKey, unwrapJsonp } from '@/shared/util';

// ───────────────────────────── URLs & patterns ─────────────────────────────

export const ORDERS_PAGE_URL = 'https://www.aliexpress.com/p/order/index.html';
export const ORDER_DETAIL_URL = (orderId: string) => `https://www.aliexpress.com/p/order/detail.html?orderId=${encodeURIComponent(orderId)}`;
export const TRACKING_PAGE_URL = (orderId: string) => `https://www.aliexpress.com/p/tracking/index.html?tradeOrderId=${encodeURIComponent(orderId)}`;
export const LOGIN_URL_RE = /(login\.aliexpress|\/login|passport\.aliexpress|havana|\/member\/login|\/user\/login|signin)/i;

export const HOST_RE = /(^|\.)aliexpress\.(com|us|ru)$/i;
export const PRODUCT_PAGE_RE = /\/(item|i)\/[^/]*?(\d{8,})\.html|\/item\/\d{8,}/i;
export const ORDERS_PAGE_RE = /\/p\/order\/(index|list)\.html|\/orderList|order\/list|\/p\/order\/?$/i;
export const ORDER_DETAIL_PAGE_RE = /\/p\/order\/detail\.html|orderDetail/i;

/** Response URLs worth mirroring. Deliberately broad — the classifier sorts the payloads. */
export const CAPTURE_URL_PATTERNS: RegExp[] = [
  /mtop\.[\w.]*order[\w.]*/i,
  /mtop\.[\w.]*trade[\w.]*/i,
  /mtop\.[\w.]*logistic[\w.]*/i,
  /mtop\.[\w.]*track[\w.]*/i,
  /mtop\.[\w.]*freight[\w.]*/i,
  /mtop\.[\w.]*shipping[\w.]*/i,
  /mtop\.[\w.]*delivery[\w.]*/i,
  /mtop\.[\w.]*buyer[\w.]*/i,
  /mtop\.ae\.ld\./i,
  /querydetail|queryDetail|logisticsDetail/i,
  /mtop\.[\w.]*\.reverse\.|refund|dispute|reverseorder/i,
  /\/orderList|\/order\/list|orderlist|order_list/i,
  /orderDetail|order\/detail/i,
  /logisticsdetail|logistics\/detail|tracking(detail|info|list)|\/tracking\//i,
  /freightCalculate|freight|shipping(Fee|Method|Option)/i,
  /getCartAndOrder|batchQueryOrder/i,
];

/** mtop APIs that match the broad patterns but never carry order/tracking data. */
export const CAPTURE_EXCLUDE_RE = /checkout\.|renderorder|\.cart\.|cart\.count|order\.count|recommend|\.render\/|cookie\.render|feedback|coupon|search|\.ad\.|traffic|log\./i;

export function shouldCaptureUrl(url: string): boolean {
  if (!url) return false;
  if (/\.(png|jpe?g|gif|webp|svg|css|woff2?|ttf|mp4)(\?|$)/i.test(url)) return false;
  if (CAPTURE_EXCLUDE_RE.test(url)) return false;
  return CAPTURE_URL_PATTERNS.some((re) => re.test(url));
}

export type EndpointKind = 'orderList' | 'orderDetail' | 'logistics' | 'tracking' | 'freight' | 'refund' | 'unknown';

export function classifyUrl(url: string): EndpointKind {
  const u = url.toLowerCase();
  if (/\.reverse\.|reverseorder|refund|dispute/.test(u)) return 'refund';
  if (/freight|shipping(fee|method|option)|deliveryoption/.test(u)) return 'freight';
  if (/mtop\.ae\.ld\.|querydetail|logisticsdetail|logistics|tracking|track\./.test(u)) return 'tracking';
  if (/orderdetail|order\.detail|order\/detail|detail\.html/.test(u)) return 'orderDetail';
  if (/orderlist|order\.list|order\/list|order_list|batchqueryorder|order\.query/.test(u)) return 'orderList';
  if (/order|trade/.test(u)) return 'orderList';
  return 'unknown';
}

/** A stable key for the endpoint registry: host + path + mtop api name. */
export function endpointKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/\d+\.\d+\/?$/, '/'); // strip mtop version segment
  } catch {
    return url.split('?')[0];
  }
}

/** Detect a page-number param in an mtop `data` blob or the query string. */
export function detectPageParam(url: string): string | null {
  try {
    const u = new URL(url);
    for (const k of u.searchParams.keys()) if (/^(page|pageNo|pageNum|pageIndex|currentPage|current|pageNumber)$/i.test(k)) return k;
    const data = u.searchParams.get('data');
    if (data) {
      const obj = JSON.parse(data);
      if (isRecord(obj)) {
        for (const k of Object.keys(obj)) if (/^(page|pageNo|pageNum|pageIndex|currentPage|current|pageNumber)$/i.test(k)) return `data.${k}`;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** Order id carried by a request URL (query param or inside the mtop `data` JSON). */
export function orderIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    for (const k of ['tradeOrderId', 'orderId', 'mainOrderId', 'orderNo']) { const v = u.searchParams.get(k); if (v && ID_RE.test(v)) return v; }
    const data = u.searchParams.get('data');
    if (data) { const m = data.match(/"(?:tradeOrderId|orderId|mainOrderId)"\s*:\s*"?(\d{10,22})"?/); if (m) return m[1]; }
  } catch { /* ignore */ }
  return null;
}

/** Replace one field inside the mtop `data` JSON of a URL template (e.g. tradeOrderId). */
export function withDataField(urlTemplate: string, key: string, value: string | number): string | null {
  try {
    const u = new URL(urlTemplate);
    const data = JSON.parse(u.searchParams.get('data') ?? '{}');
    if (!isRecord(data)) return null;
    data[key] = typeof data[key] === 'number' ? Number(value) : String(value);
    u.searchParams.set('data', JSON.stringify(data));
    return u.toString();
  } catch { return null; }
}

/** Detect a page-index inside a recorded POST body (ultron `data={"params":"…pageIndex…"}`). */
export function bodyHasPageIndex(body: string | null | undefined): boolean {
  return !!body && /pageIndex\\*"?\s*:\s*\\*"?\d+/.test(decodeURIComponentSafe(body));
}

/** Rewrite the page index inside a recorded POST body template (any JSON escaping depth). */
export function withBodyPage(bodyTemplate: string, page: number): string {
  const decoded = decodeURIComponentSafe(bodyTemplate);
  const replaced = decoded.replace(/(pageIndex\\*"\s*:\s*)(\\*"?)(\d+)/g, (_m, a: string, b: string) => `${a}${b}${page}`);
  return reencodeForm(replaced);
}

function decodeURIComponentSafe(s: string): string { try { return decodeURIComponent(s.replace(/\+/g, '%20')); } catch { return s; } }
function reencodeForm(decoded: string): string {
  // Body shape is `data=<json>` (optionally with other fields). Re-encode each value.
  return decoded.split('&').map((kv) => { const i = kv.indexOf('='); return i < 0 ? kv : `${kv.slice(0, i)}=${encodeURIComponent(kv.slice(i + 1))}`; }).join('&');
}

/** The `data` string an mtop request signs: from the POST body when present, else the URL. */
function mtopDataString(u: URL, body: string | null): string {
  if (body) { const decoded = decodeURIComponentSafe(body); const m = decoded.match(/(?:^|&)data=([\s\S]*?)(?:&|$)/); if (m) return m[1]; }
  return u.searchParams.get('data') ?? '{}';
}

export interface MtopTemplate { urlTemplate: string; method: string; bodyTemplate: string | null }

/** Build a fresh, correctly signed request from a recorded template. */
export function buildMtopRequest(t: MtopTemplate, token: string | null, now = Date.now()): { url: string; init: RequestInit } {
  const u = new URL(t.urlTemplate);
  const isMtop = /\/h5\/mtop\./.test(u.pathname);
  const body = t.bodyTemplate;
  if (isMtop && token) {
    const appKey = u.searchParams.get('appKey') ?? '12574478';
    const data = mtopDataString(u, body);
    const ts = String(now);
    u.searchParams.set('t', ts);
    u.searchParams.set('sign', md5(`${token}&${ts}&${appKey}&${data}`));
    u.searchParams.delete('callback');
    if (u.searchParams.get('type') === 'jsonp') u.searchParams.set('type', 'originaljson');
    if (u.searchParams.get('dataType') === 'jsonp') u.searchParams.set('dataType', 'json');
  }
  const init: RequestInit = { method: t.method || 'GET', credentials: 'include', redirect: 'follow', headers: { accept: 'application/json, text/plain, */*' } };
  if (body && init.method !== 'GET') { init.body = body; (init.headers as Record<string, string>)['content-type'] = 'application/x-www-form-urlencoded'; }
  return { url: u.toString(), init };
}

/** Rewrite a recorded URL so it asks for a specific page. Returns null when no pagination param is known. */
export function withPage(urlTemplate: string, pageParam: string, page: number): string | null {
  try {
    const u = new URL(urlTemplate);
    if (pageParam.startsWith('data.')) {
      const key = pageParam.slice(5);
      const data = JSON.parse(u.searchParams.get('data') ?? '{}');
      data[key] = typeof data[key] === 'string' ? String(page) : page;
      u.searchParams.set('data', JSON.stringify(data));
    } else {
      u.searchParams.set(pageParam, String(page));
    }
    return u.toString();
  } catch {
    return null;
  }
}

// ───────────────────────────── login detection ─────────────────────────────

export function looksLoggedOut(finalUrl: string, status: number, bodyText: string): boolean {
  if (LOGIN_URL_RE.test(finalUrl)) return true;
  if (status === 401 || status === 403) return true;
  const head = bodyText.slice(0, 4000);
  if (/FAIL_SYS_SESSION_EXPIRED|FAIL_SYS_ILLEGAL_ACCESS|NOT_LOGIN|SESSION_EXPIRED|USER_NOT_LOGIN|need.?login/i.test(head)) return true;
  if (/<title>[^<]*(sign in|log in|login)[^<]*<\/title>/i.test(head)) return true;
  return false;
}

export function isTokenExpired(bodyText: string): boolean {
  return /FAIL_SYS_TOKEN_EXOIRED|FAIL_SYS_TOKEN_EXPIRED|FAIL_SYS_TOKEN_EMPTY|FAIL_SYS_ILLEGAL_ACCESS/i.test(bodyText.slice(0, 2000));
}

// ───────────────────────────── small helpers ─────────────────────────────

const ID_RE = /^\d{10,22}$/;

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^\d.,-]/g, '');
    if (!cleaned) return null;
    // "1.234,56" → 1234.56 ; "1,234.56" → 1234.56 ; "12,34" → 12.34
    let s = cleaned;
    if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  return null;
}

/** Parse many date shapes: epoch ms/s, ISO, "2024-05-13 12:34:56", "May 13, 2024", "13.05.2024". */
export function parseDate(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (v > 1e12) return v; // ms
    if (v > 1e9) return v * 1000; // seconds
    return null;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^\d{13}$/.test(t)) return Number(t);
    if (/^\d{10}$/.test(t)) return Number(t) * 1000;
    let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) + new Date().getTimezoneOffset() * 60000;
    m = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0)).getTime();
    const d = Date.parse(t);
    if (!isNaN(d)) return d;
    // "Sat | Sep. 19 18:46" (AliExpress timeText, no year) → most recent occurrence not in the future
    const tt = t.match(/(?:^|\|\s*)([A-Z][a-z]{2})\.?\s+(\d{1,2})\s+(\d{1,2}):(\d{2})/);
    if (tt) { const y = new Date().getFullYear(); let d2 = new Date(`${tt[1]} ${tt[2]}, ${y} ${tt[3]}:${tt[4]}`).getTime(); if (d2 > Date.now() + 86400000) d2 = new Date(`${tt[1]} ${tt[2]}, ${y - 1} ${tt[3]}:${tt[4]}`).getTime(); if (!isNaN(d2)) return d2; }
  }
  if (isRecord(v)) {
    for (const k of ['time', 'timestamp', 'value', 'date', 'gmt', 'gmtCreate', 'utc']) if (k in v) return parseDate(v[k]);
  }
  return null;
}

interface Money { amount: number | null; currency: string | null }

const CURRENCY_SYMBOLS: Record<string, string> = {
  'US $': 'USD', 'US$': 'USD', '$': 'USD', '€': 'EUR', '£': 'GBP', 'C$': 'CAD', 'CA$': 'CAD', 'A$': 'AUD', 'AU$': 'AUD',
  '¥': 'CNY', 'CN¥': 'CNY', '₹': 'INR', 'R$': 'BRL', 'zł': 'PLN', 'kr': 'SEK', 'CHF': 'CHF', '₺': 'TRY', 'руб': 'RUB', '₽': 'RUB', 'Rp': 'IDR', 'MX$': 'MXN', 'NZ$': 'NZD', '₩': 'KRW', 'HK$': 'HKD', 'S$': 'SGD', '₪': 'ILS', 'RM': 'MYR', '₱': 'PHP', '฿': 'THB', '₫': 'VND',
};

export function parseMoney(v: unknown, fallbackCurrency: string | null = null): Money {
  if (v == null) return { amount: null, currency: fallbackCurrency };
  if (typeof v === 'number') return { amount: v, currency: fallbackCurrency };
  if (typeof v === 'string') {
    const cur = v.match(/\b([A-Z]{3})\b/)?.[1] ?? null;
    let sym: string | null = null;
    for (const s of Object.keys(CURRENCY_SYMBOLS).sort((a, b) => b.length - a.length)) if (v.includes(s)) { sym = CURRENCY_SYMBOLS[s]; break; }
    return { amount: num(v), currency: cur ?? sym ?? fallbackCurrency };
  }
  if (isRecord(v)) {
    const currency = str(v.currency ?? v.currencyCode ?? v.currencyType ?? v.cur) ?? fallbackCurrency;
    if ('cent' in v && num(v.cent) != null) return { amount: (num(v.cent) as number) / 100, currency };
    if ('centAmount' in v && num(v.centAmount) != null) return { amount: (num(v.centAmount) as number) / 100, currency };
    for (const k of ['value', 'amount', 'price', 'money', 'formatedAmount', 'formattedAmount', 'text', 'displayAmount', 'amountStr']) {
      if (k in v) {
        const inner = parseMoney(v[k], currency);
        if (inner.amount != null) return { amount: inner.amount, currency: inner.currency ?? currency };
      }
    }
  }
  return { amount: null, currency: fallbackCurrency };
}

/** Price-row values from the order-detail block: "$26.72", "-$2.93", "Free shipping", "Free". */
export function parseDetailMoney(v: unknown): number | null {
  if (typeof v === 'string' && /\bfree\b/i.test(v) && !/\d/.test(v)) return 0;
  return parseMoney(v).amount;
}

function findKey(obj: Record<string, unknown>, res: RegExp[]): unknown {
  for (const re of res) for (const k of Object.keys(obj)) if (re.test(k)) { const v = obj[k]; if (v != null && v !== '') return v; }
  return undefined;
}

function findString(obj: Record<string, unknown>, res: RegExp[]): string | null {
  const v = findKey(obj, res);
  const out = str(v) ?? (isRecord(v) ? str(v.text ?? v.name ?? v.value ?? v.title) : null);
  return out && /^[-–—\s]*$/.test(out) ? null : out;
}

// ───────────────────────────── status mapping ─────────────────────────────

export function normalizeOrderStatus(raw: string | null | undefined): OrderStatus {
  if (!raw) return 'UNKNOWN';
  const s = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (/WAIT_BUYER_PAY|AWAITING_PAYMENT|UNPAID|PLACE_ORDER_SUCCESS|TO_PAY/.test(s)) return 'AWAITING_PAYMENT';
  if (/WAIT_SELLER_SEND|AWAITING_SHIPMENT|TO_SHIP|PAY_SUCCESS|SELLER_PART_SEND|PROCESSING/.test(s)) return 'AWAITING_SHIPMENT';
  if (/WAIT_BUYER_ACCEPT|AWAITING_DELIVERY|SHIPPED|IN_TRANSIT|TO_RECEIVE|WAIT_GROUP/.test(s)) return 'SHIPPED';
  if (/IN_ISSUE|DISPUTE|IN_FROZEN|RISK_CONTROL/.test(s)) return 'DISPUTE';
  if (/REFUND|RETURN|RETURNED|MONEY_BACK|REFUNDING/.test(s)) return 'REFUNDED';
  if (/EXPIRED|TIMEOUT|TIME_OUT/.test(s)) return 'CLOSED';
  if (/FINISH|COMPLETED|COMPLETE|SUCCESS|RECEIVED|FUND_PROCESSING/.test(s)) return 'COMPLETED';
  if (/DELIVERED/.test(s)) return 'DELIVERED';
  if (/CANCEL|CLOSED|CLOSE|IN_CANCEL/.test(s)) return 'CLOSED';
  return 'UNKNOWN';
}

// ───────────────────────────── structural recognisers ─────────────────────────────

const ORDER_ID_KEYS = [/^(tradeOrderId|orderId|mainOrderId|orderNo|parentOrderId|bizOrderId)$/i];
const ORDER_STATUS_KEYS = [/^(orderStatus|orderStatusText|statusText|status|orderStatusDesc|statusDesc|bizStatus|orderState)$/i];
const ORDER_DATE_KEYS = [/^(gmtCreate|orderDate|orderDateText|createTime|createdAt|orderTime|placedAt|gmtPay|payTime|orderCreateTime|gmtCreateStr|createDate|packageMinCreateTime)$/i];
const ITEM_LIST_KEYS = [/^(subOrders|orderItems|itemList|productList|items|childOrderList|orderLineList|subOrderList|products|skuList|orderLines|lines)$/i];
const ITEM_ID_KEYS = [/^(productId|itemId|skuId|childOrderId|subOrderId|orderLineId|lineId)$/i];
const ITEM_TITLE_KEYS = [/^(title|productName|itemName|subject|productTitle|skuTitle|name|itemTitle)$/i];
const ITEM_QTY_KEYS = [/^(quantity|qty|buyCount|count|num|amount_quantity|itemQuantity|skuQuantity)$/i];
const ITEM_PRICE_KEYS = [/^(unitPrice|price|skuPrice|itemPrice|itemPriceText|actualPrice|salePrice|productPrice|actPrice|payPrice|dealPrice)$/i];
const ITEM_IMG_KEYS = [/^(imageUrl|productImage|picUrl|image|img|productImgUrl|itemImgUrl|imgUrl|skuImage|itemPic|pic|thumbnail|mainPic)$/i];
const ITEM_SKU_KEYS = [/^(skuAttr|skuAttrs|skuInfo|sku|skuText|attributes|specification|skuProps|skuDesc|propsText)$/i];
const TRACKING_KEYS = [/^(logisticsNo|mailNo|originMailNo|trackingNo|trackingNumber|logisticsTrackingNumber|lpNo|trackNumber|logisticsTrackingNo|internationalLogisticsNo|waybillNo|mailNumber)$/i];
const SERVICE_KEYS = [/^(logisticsServiceName|logisticsCarrierName|logisticsService|carrierName|serviceName|companyName|logisticsCompany|shippingMethod|deliveryMethod|carrier|logisticsCompanyName|shippingService|shipMethod|logisticsName|deliveryOptionName|serviceDesc)$/i];
const SHIP_FROM_KEYS = [/^(shipFrom|shipFromCountry|sendCountry|originCountry|shippingFrom|shipFromRegion|sendGoodsCountry|fromCountry|shipsFrom|origin|shipFromCode)$/i];
const SELLER_NAME_KEYS = [/^(storeName|sellerName|shopName|sellerNick|companyName|storeTitle|sellerStoreName)$/i];
const SELLER_ID_KEYS = [/^(sellerId|storeId|sellerAdminSeq|storeNo|sellerSeq|shopId|companyId)$/i];
const TOTAL_KEYS = [/^(orderAmount|totalAmount|totalPriceText|orderTotal|payAmount|actualPayAmount|totalPayAmount|realPayAmount|paymentAmount|orderPrice|totalPrice|amount|grandTotal|orderAmt|actualFee)$/i];
const SUBTOTAL_KEYS = [/^(productAmount|itemsSubtotal|productTotalAmount|goodsAmount|subtotal|itemTotal|productsAmount|totalProductAmount|itemAmount|productPrice)$/i];
const SHIPPING_KEYS = [/^(shippingFee|shippingCost|logisticsAmount|freightAmount|freightFee|deliveryFee|shippingAmount|logisticsFee|postFee|totalShippingFee)$/i];
const DISCOUNT_KEYS = [/^(discountAmount|discount|couponAmount|totalDiscount|promotionAmount|promotionDiscount|reduceAmount|savedAmount|totalCoupon)$/i];
const REFUND_KEYS = [/^(refundAmount|refundedAmount|refundTotal|totalRefund|returnAmount|refundFee|refundMoney|actualRefundAmount|refundPrice)$/i];
const TAX_KEYS = [/^(taxAmount|tax|vatAmount|vat|dutyAmount|totalTax|taxFee|gst)$/i];
const PROMISED_KEYS = [/^(deliveryDate|estimatedDeliveryDate|expectedDeliveryDate|promiseDeliveryDate|deliveryTime|estimatedDelivery|deliveryPromise|eta|promisedDate|latestDeliveryDate|expectedDelivery|guaranteedDeliveryTime|arrivalTime)$/i];
const PROTECTION_KEYS = [/^(buyerProtectionEndTime|protectionEndDate|buyerProtectionDate|remainTime|confirmDeadline|autoConfirmTime|orderProtectionEndTime|guaranteeEndTime|disputeDeadline|protectionTime|purchaseProtectionTime|buyerProtectionEndDate)$/i];
const EVENT_LIST_KEYS = [/^(detailList|traceList|trackingDetails|events|eventList|logisticsTraceList|traces|nodeList|trackingList|details|logisticsDetailList|list|trackList|checkpoints)$/i];
const EVENT_TIME_KEYS = [/^(eventDate|time|timeStr|date|gmtTime|eventTime|occurTime|traceTime|dateTime|acceptTime|scanTime|timestamp|createTime)$/i];
const EVENT_DESC_KEYS = [/^(trackingDetailDesc|eventDesc|desc|description|standerdDesc|standardDesc|nodeDesc|content|message|statusDesc|text|event|remark|trackingDesc|trackingName|status|title)$/i];
const EVENT_LOC_KEYS = [/^(address|location|city|place|eventLocation|locationText|acceptAddress|scanLocation|site|country|region|node|position)$/i];
const EVENT_CODE_KEYS = [/^(trackingPrimaryCode|trackingSecondCode|actionCode|nodeCode|eventCode|statusCode|code|milestone|action|nodeName|groupCode|stage)$/i];

export function isOrderLike(o: Record<string, unknown>): boolean {
  const id = str(findKey(o, ORDER_ID_KEYS));
  if (!id || !ID_RE.test(id)) return false;
  const hasStatus = findKey(o, ORDER_STATUS_KEYS) !== undefined;
  const hasDate = findKey(o, ORDER_DATE_KEYS) !== undefined;
  const list = findKey(o, ITEM_LIST_KEYS);
  const hasItems = Array.isArray(list) && list.some((x) => isRecord(x) && isItemLike(x));
  const hasMoney = findKey(o, TOTAL_KEYS) !== undefined;
  return (hasStatus && (hasDate || hasItems || hasMoney)) || (hasItems && (hasDate || hasMoney));
}

export function isItemLike(o: Record<string, unknown>): boolean {
  const title = findString(o, ITEM_TITLE_KEYS);
  const hasId = findKey(o, ITEM_ID_KEYS) !== undefined;
  const hasPrice = findKey(o, ITEM_PRICE_KEYS) !== undefined;
  const hasQty = findKey(o, ITEM_QTY_KEYS) !== undefined;
  return !!title && (hasId || hasPrice || hasQty);
}

function isEventLike(o: Record<string, unknown>): boolean {
  const t = findKey(o, EVENT_TIME_KEYS);
  const d = findString(o, EVENT_DESC_KEYS);
  return t !== undefined && !!d && parseDate(t) != null;
}

// ───────────────────────────── output shapes ─────────────────────────────

export interface RawTrackingEvent {
  trackingNo: string | null;
  timestamp: number;
  rawText: string;
  locationText: string | null;
  code: string | null;
  /** Pre-shipment node (order created / paid / packing): keep as an event, never a milestone. */
  preShipment: boolean;
  /** Milestone hinted by a carrier code, if the code table knows it. */
  codeMilestone: Milestone | null;
}

export interface ParcelHint {
  trackingNo: string;
  orderId: string | null;
  itemIds: string[];
  /** Product ids of items in this parcel (resolved to itemIds at ingest). */
  productIds: string[];
  /** AliExpress's promised delivery window end for this parcel. */
  promisedAt: number | null;
  logisticsService: string | null;
  shipFromRegion: string | null;
  destCountry: string | null;
  shippedAt: number | null;
  deliveredAt: number | null;
}

export interface FreightOption {
  service: string;
  shipFrom: string | null;
  minDays: number | null;
  maxDays: number | null;
  fee: Money;
}

export interface RefundHint {
  refundId: string;
  reverseOrderId: string | null;
  orderId: string | null;
  orderLineId: string | null;
  itemTitle: string | null;
  itemImageUrl: string | null;
  itemUnitPrice: number | null;
  itemCount: number | null;
  currency: string | null;
  refundAmount: number | null;
  refundStatus: string | null;
  caseStatus: string | null;
  reverseType: string | null;
  solutionText: string | null;
  reason: string | null;
  requestedAt: number | null;
  finishedAt: number | null;
  /** true when this came from the detail API (amount authoritative). */
  detailed: boolean;
}

export interface ParsedBundle {
  kind: EndpointKind;
  orders: Order[];
  refunds: RefundHint[];
  items: Item[];
  parcels: ParcelHint[];
  events: RawTrackingEvent[];
  freight: FreightOption[];
  /** Pagination signals when present. */
  page: number | null;
  totalPages: number | null;
  totalOrders: number | null;
  hasMore: boolean | null;
  loginRequired: boolean;
  /** Order id carried by the request (e.g. querydetail?data={tradeOrderId}). */
  contextOrderId: string | null;
  /** "Refund if no delivery before <date>" seen in the payload. */
  protectionEndsAt: number | null;
  /** Receiver address seen in a tracking payload (city/province/country). */
  receiver: { city: string | null; province: string | null; country: string | null; zip: string | null } | null;
}

function emptyBundle(kind: EndpointKind): ParsedBundle {
  return { kind, orders: [], refunds: [], items: [], parcels: [], events: [], freight: [], page: null, totalPages: null, totalOrders: null, hasMore: null, loginRequired: false, contextOrderId: null, protectionEndsAt: null, receiver: null };
}

// ───────────────────────────── extraction ─────────────────────────────

function extractTrackingNos(o: Record<string, unknown>, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > 3) return out;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (TRACKING_KEYS.some((re) => re.test(k))) {
      if (typeof v === 'string' && /^[A-Z0-9]{8,30}$/i.test(v.trim())) out.add(v.trim().toUpperCase());
      else if (Array.isArray(v)) v.forEach((x) => typeof x === 'string' && /^[A-Z0-9]{8,30}$/i.test(x) && out.add(x.trim().toUpperCase()));
    } else if (isRecord(v) && /logistic|shipping|delivery|package|parcel|track/i.test(k)) {
      extractTrackingNos(v, depth + 1, out);
    } else if (Array.isArray(v) && /logistic|shipping|delivery|package|parcel|track/i.test(k)) {
      v.forEach((x) => isRecord(x) && extractTrackingNos(x, depth + 1, out));
    }
  }
  return out;
}

function findSeller(o: Record<string, unknown>): { id: string | null; name: string | null } {
  let name = findString(o, SELLER_NAME_KEYS);
  let id = str(findKey(o, SELLER_ID_KEYS));
  for (const k of ['seller', 'store', 'storeInfo', 'sellerInfo', 'shop', 'shopInfo', 'sellerDTO', 'storeDTO']) {
    const sub = o[k];
    if (isRecord(sub)) {
      name ||= findString(sub, SELLER_NAME_KEYS) ?? str(sub.name) ?? str(sub.title);
      id ||= str(findKey(sub, SELLER_ID_KEYS)) ?? str(sub.id);
    }
  }
  return { id, name };
}

function firstMoney(o: Record<string, unknown>, keys: RegExp[], fallbackCur: string | null): Money {
  const v = findKey(o, keys);
  if (v === undefined) return { amount: null, currency: fallbackCur };
  return parseMoney(v, fallbackCur);
}

function detectCurrency(o: Record<string, unknown>): string | null {
  const direct = str(findKey(o, [/^(currency|currencyCode|orderCurrency|payCurrency|currencyType)$/i]));
  if (direct && /^[A-Z]{3}$/.test(direct)) return direct;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (isRecord(v)) {
      const c = str(v.currency ?? v.currencyCode);
      if (c && /^[A-Z]{3}$/.test(c)) return c;
    }
  }
  return null;
}

function parseItem(raw: Record<string, unknown>, orderId: string, currency: string | null, idx: number): Item | null {
  const title = findString(raw, ITEM_TITLE_KEYS);
  if (!title) return null;
  const productId = str(findKey(raw, [/^(productId|itemId|productID)$/i]));
  const skuRaw = findKey(raw, ITEM_SKU_KEYS);
  let sku: string | null = null;
  if (typeof skuRaw === 'string') sku = skuRaw;
  else if (Array.isArray(skuRaw)) sku = skuRaw.map((x) => (isRecord(x) ? `${str(x.name ?? x.attrName ?? x.key) ?? ''}:${str(x.value ?? x.attrValue ?? x.text) ?? ''}` : str(x))).filter(Boolean).join('; ');
  else if (isRecord(skuRaw)) sku = str(skuRaw.text ?? skuRaw.desc ?? skuRaw.name);
  const qty = num(findKey(raw, ITEM_QTY_KEYS)) ?? 1;
  const price = firstMoney(raw, ITEM_PRICE_KEYS, currency);
  let img = findString(raw, ITEM_IMG_KEYS);
  if (img && img.startsWith('//')) img = 'https:' + img;
  const tracking = [...extractTrackingNos(raw)][0] ?? null;
  const skuId = str(findKey(raw, [/^(skuId|childOrderId|subOrderId|orderLineId)$/i]));
  const itemId = `${orderId}:${productId ?? 'p' + idx}:${skuId ?? sku ?? idx}`;
  return { itemId, orderId, productId, title, sku, qty: Math.max(1, Math.round(qty)), unitPrice: price.amount, currency: price.currency ?? currency, imageUrl: img, trackingNo: tracking };
}

/** Parse one order-like object plus its items and parcel hints. */
export function parseOrderObject(raw: Record<string, unknown>, now = Date.now()): { order: Order; items: Item[]; parcels: ParcelHint[] } | null {
  const orderId = str(findKey(raw, ORDER_ID_KEYS));
  if (!orderId || !ID_RE.test(orderId)) return null;
  const currency = detectCurrency(raw) ?? 'USD';
  const total = firstMoney(raw, TOTAL_KEYS, currency);
  const priceBlock = ['priceInfo', 'orderPrice', 'amountInfo', 'price', 'payment', 'paymentInfo', 'orderAmountInfo', 'priceDetail'].map((k) => raw[k]).find(isRecord) as Record<string, unknown> | undefined;
  const src = priceBlock ?? raw;
  const subtotal = firstMoney(src, SUBTOTAL_KEYS, currency);
  const shipping = firstMoney(src, SHIPPING_KEYS, currency);
  const discount = firstMoney(src, DISCOUNT_KEYS, currency);
  const tax = firstMoney(src, TAX_KEYS, currency);
  const refund = firstMoney(raw, REFUND_KEYS, currency).amount ?? firstMoney(src, REFUND_KEYS, currency).amount;
  const total2 = total.amount == null && priceBlock ? firstMoney(priceBlock, TOTAL_KEYS, currency) : total;
  const seller = findSeller(raw);
  const rawStatus = findString(raw, ORDER_STATUS_KEYS);
  const list = findKey(raw, ITEM_LIST_KEYS);
  const items: Item[] = [];
  if (Array.isArray(list)) {
    list.forEach((x, i) => { if (isRecord(x)) { const it = parseItem(x, orderId, total2.currency ?? currency, i); if (it) items.push(it); } });
  } else if (isItemLike(raw)) {
    const it = parseItem(raw, orderId, currency, 0); if (it) items.push(it);
  }
  const trackingNos = new Set<string>([...extractTrackingNos(raw), ...items.map((i) => i.trackingNo).filter((x): x is string => !!x)]);
  const listArr: unknown[] = Array.isArray(list) ? list : [];
  const service = findString(raw, SERVICE_KEYS) ?? listArr.map((x) => (isRecord(x) ? findString(x, SERVICE_KEYS) : null)).find(Boolean) ?? null;
  const shipFrom = findString(raw, SHIP_FROM_KEYS) ?? (Array.isArray(list) ? list.map((x) => (isRecord(x) ? findString(x, SHIP_FROM_KEYS) : null)).find(Boolean) ?? null : null);
  const shippedAt = parseDate(findKey(raw, [/^(gmtSend|sendTime|shipTime|shippedAt|deliveryStartTime|sendGoodsTime|shipDate|gmtShip)$/i]));
  const deliveredAt = parseDate(findKey(raw, [/^(gmtReceive|receiveTime|deliveredAt|signTime|gmtSign|finishTime|gmtFinish|completeTime|confirmTime)$/i]));
  const promised = findKey(raw, PROMISED_KEYS);
  const protection = findKey(raw, PROTECTION_KEYS);

  const itemsSubtotal = subtotal.amount ?? (items.length && items.every((i) => i.unitPrice != null) ? items.reduce((s, i) => s + (i.unitPrice ?? 0) * i.qty, 0) : null);
  const order: Order = {
    orderId,
    placedAt: parseDate(findKey(raw, ORDER_DATE_KEYS)),
    sellerId: seller.id,
    sellerName: seller.name,
    status: normalizeOrderStatus(rawStatus),
    rawStatus,
    currency: total2.currency ?? currency,
    itemsSubtotal,
    shippingCost: shipping.amount,
    discount: discount.amount,
    tax: tax.amount,
    orderTotal: total2.amount ?? (itemsSubtotal != null ? itemsSubtotal + (shipping.amount ?? 0) - (discount.amount ?? 0) + (tax.amount ?? 0) : null),
    promisedDeliveryAt: parsePromised(promised, now),
    protectionEndsAt: parseProtection(protection, now),
    refundAmount: refund,
    paymentMethod: null,
    checkoutGroup: null,
    trackingNos: [...trackingNos],
    updatedAt: now,
  };
  const parcels: ParcelHint[] = [...trackingNos].map((trackingNo) => ({
    trackingNo,
    orderId,
    itemIds: items.filter((i) => !i.trackingNo || i.trackingNo === trackingNo).map((i) => i.itemId),
    productIds: items.filter((i) => !i.trackingNo || i.trackingNo === trackingNo).map((i) => i.productId).filter((x): x is string => !!x),
    promisedAt: order.promisedDeliveryAt,
    logisticsService: service,
    shipFromRegion: shipFrom,
    destCountry: findString(raw, [/^(destCountry|destinationCountry|receiveCountry|shipToCountry|country|toCountry|deliveryCountry)$/i]),
    shippedAt,
    deliveredAt: order.status === 'COMPLETED' || order.status === 'DELIVERED' ? deliveredAt : null,
  }));
  return { order, items, parcels };
}

function parsePromised(v: unknown, now: number): number | null {
  const d = parseDate(v);
  if (d && d > now - 400 * 86400000) return d;
  if (typeof v === 'string') {
    // "Delivery: Jun 12 - Jun 30" → take the later date; "12-25 days" → now + 25d
    const range = v.match(/(\w{3,9}\.? \d{1,2})(?:,? (\d{4}))?\s*[-–]\s*(\w{3,9}\.? \d{1,2})(?:,? (\d{4}))?/);
    if (range) {
      const year = range[4] ?? range[2] ?? String(new Date(now).getFullYear());
      const t = Date.parse(`${range[3]}, ${year}`);
      if (!isNaN(t)) return t;
    }
    const days = v.match(/(\d{1,3})\s*(?:-|–|to)?\s*(\d{1,3})?\s*days?/i);
    if (days) return now + Number(days[2] ?? days[1]) * 86400000;
  }
  return null;
}

function parseProtection(v: unknown, now: number): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && v < 1e9 && v > 0) return now + v * (v < 1e6 ? 1000 : 1); // remaining seconds / ms
  const d = parseDate(v);
  if (d && d > 946684800000) return d;
  if (typeof v === 'string') {
    const m = v.match(/(\d+)\s*days?/i);
    if (m) return now + Number(m[1]) * 86400000;
  }
  return null;
}

/** Codes that are real tracking nodes but precede shipment — never a milestone, never text-classified. */
export const PRE_SHIPMENT_CODES = /^(AE_)?(ORDER_PLACED|ORDER_PAID|ORDER_CREATED|GWMS_ACCEPT|GWMS_PACKAGE|GWMS_PACKAGING|WAIT_SELLER_SEND|PAYMENT_SUCCESS|ORDER_CONFIRMED|PREPARING|PROCESSING)$/i;
export const PRE_SHIPMENT_TEXT = /order(?:'s| has| was| is)? (?:been )?(?:created|placed|paid|confirmed)|package is being prepared|being (?:prepared|packed)|ready to be shipped|processing in warehouse|payment (?:received|confirmed|successful)|awaiting shipment/i;

/** Cainiao / AliExpress action codes → milestone, when the code table knows them. */
export const CODE_MILESTONES: Record<string, Milestone> = {
  // AliExpress platform codes (mtop.ae.ld.querydetail, 2026)
  ORDER_SHIPPED: 'SELLER_SHIPPED', GWMS_OUTBOUND: 'SELLER_SHIPPED', GWMS_OUTBOUND_SUCCESS: 'SELLER_SHIPPED', CONSIGN_SUCCESS: 'SELLER_SHIPPED',
  PICK_UP_SUCCESS: 'ORIGIN_ACCEPTED', PICK_UP: 'ORIGIN_ACCEPTED', CW_SIGN_IN_SUCCESS: 'ORIGIN_ACCEPTED', CW_SIGN_IN: 'ORIGIN_ACCEPTED', CW_INBOUND_SUCCESS: 'ORIGIN_ACCEPTED',
  CW_OUTBOUND_SUCCESS: 'ORIGIN_DEPARTED', CW_OUTBOUND: 'ORIGIN_DEPARTED', LH_HO_AIRLINE_SUCCESS: 'ORIGIN_DEPARTED',
  GTMS_DELIVERING: 'OUT_FOR_DELIVERY', GTMS_SIGNED: 'DELIVERED', GTMS_SIGN: 'DELIVERED', GTMS_FAILED: 'EXCEPTION', GTMS_RETURN: 'RETURNED',
  LAST_MILE_HO_SUCCESS: 'HANDED_TO_LOCAL_CARRIER', LAST_MILE_HO: 'HANDED_TO_LOCAL_CARRIER', LAST_MILE_HI_SUCCESS: 'IN_TRANSIT_LOCAL', LAST_MILE_HI: 'IN_TRANSIT_LOCAL', LAST_MILE_INTRANSIT: 'IN_TRANSIT_LOCAL',
  CC_HO_IN_SUCCESS: 'IMPORT_CUSTOMS',
  CREATE: 'SELLER_SHIPPED', ORDER_CREATED: 'SELLER_SHIPPED', CONSIGN: 'SELLER_SHIPPED', WAIT_FOR_PICK_UP: 'SELLER_SHIPPED', SHIPPING: 'SELLER_SHIPPED', INFO_RECEIVED: 'SELLER_SHIPPED',
  GOT: 'ORIGIN_ACCEPTED', PICKUP: 'ORIGIN_ACCEPTED', SC_INBOUND_SUCCESS: 'ORIGIN_ACCEPTED', WAREHOUSE_ACCEPT: 'ORIGIN_ACCEPTED', ACCEPT: 'ORIGIN_ACCEPTED', ORIGIN: 'ORIGIN_ACCEPTED',
  SC_OUTBOUND_SUCCESS: 'ORIGIN_DEPARTED', LH_HO_IN_SUCCESS: 'ORIGIN_DEPARTED', DEPART: 'ORIGIN_DEPARTED', OUTBOUND: 'ORIGIN_DEPARTED',
  CC_EX_START: 'EXPORT_CUSTOMS', CC_EX_SUCCESS: 'EXPORT_CUSTOMS', EXPORT_CUSTOMS: 'EXPORT_CUSTOMS', CUSTOMS_DEPART: 'EXPORT_CUSTOMS',
  LH_HO_AIRLINE: 'ORIGIN_DEPARTED', LH_DEPART: 'DEPARTED_ORIGIN_COUNTRY', DEPART_FROM_ORIGINAL_COUNTRY: 'DEPARTED_ORIGIN_COUNTRY', DEPARTURE: 'DEPARTED_ORIGIN_COUNTRY', LH_HO_TRANSIT: 'DEPARTED_ORIGIN_COUNTRY',
  LH_ARRIVE: 'ARRIVED_DEST_COUNTRY', ARRIVED_AT_DEST_COUNTRY: 'ARRIVED_DEST_COUNTRY', ARRIVAL: 'ARRIVED_DEST_COUNTRY', DEST_ARRIVE: 'ARRIVED_DEST_COUNTRY',
  CC_IM_START: 'IMPORT_CUSTOMS', CC_IM_SUCCESS: 'IMPORT_CUSTOMS', IMPORT_CUSTOMS: 'IMPORT_CUSTOMS', CUSTOMS_ARRIVED: 'IMPORT_CUSTOMS', CLEARANCE: 'IMPORT_CUSTOMS',
  CC_HO_OUT_SUCCESS: 'HANDED_TO_LOCAL_CARRIER', LOCAL_HANDOVER: 'HANDED_TO_LOCAL_CARRIER', HANDOVER: 'HANDED_TO_LOCAL_CARRIER', DELIVERY_HO: 'HANDED_TO_LOCAL_CARRIER',
  TRANSIT: 'IN_TRANSIT_LOCAL', TRANSPORT: 'IN_TRANSIT_LOCAL', LOCAL_TRANSIT: 'IN_TRANSIT_LOCAL', IN_TRANSIT: 'IN_TRANSIT_LOCAL',
  DELIVERING: 'OUT_FOR_DELIVERY', OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY', DISPATCHED: 'OUT_FOR_DELIVERY', ARRIVED_AT_PICKUP_POINT: 'OUT_FOR_DELIVERY',
  SIGNED: 'DELIVERED', DELIVERED: 'DELIVERED', SIGN: 'DELIVERED', PICKED_UP_BY_RECIPIENT: 'DELIVERED',
  FAILED: 'EXCEPTION', EXCEPTION: 'EXCEPTION', DELIVERY_FAILED: 'EXCEPTION', ABNORMAL: 'EXCEPTION', LOST: 'EXCEPTION',
  RETURN: 'RETURNED', RETURNED: 'RETURNED', RETURNING: 'RETURNED', RETURN_TO_SENDER: 'RETURNED',
};

export function lookupCode(codeUpper: string): Milestone | null {
  const noPrefix = codeUpper.replace(/^(AE|CN|CNG|LP)_/, '');
  const noSuffix = codeUpper.replace(/_(SUCCESS|START|FINISH|DONE|COMPLETE|FAIL(ED)?)$/, '');
  const bare = noPrefix.replace(/_(SUCCESS|START|FINISH|DONE|COMPLETE|FAIL(ED)?)$/, '');
  for (const c of [codeUpper, noPrefix, noSuffix, bare]) if (CODE_MILESTONES[c]) return CODE_MILESTONES[c];
  if (/_FAIL/.test(codeUpper)) return 'EXCEPTION';
  return null;
}

function parseEventObject(raw: Record<string, unknown>, trackingNo: string | null): RawTrackingEvent | null {
  const ts = parseDate(findKey(raw, EVENT_TIME_KEYS));
  const desc = findString(raw, EVENT_DESC_KEYS);
  if (!ts || !desc) return null;
  let loc = findString(raw, EVENT_LOC_KEYS);
  if (loc && /^\d+$/.test(loc)) loc = null;
  let code = str(findKey(raw, EVENT_CODE_KEYS));
  const group = raw.group;
  if (!code && isRecord(group)) code = str(group.nodeCode ?? group.code ?? group.nodeDesc);
  const codeUpper = code?.toUpperCase().replace(/[\s-]+/g, '_') ?? null;
  const preShipment = (codeUpper ? PRE_SHIPMENT_CODES.test(codeUpper) : false) || PRE_SHIPMENT_TEXT.test(desc);
  return { trackingNo, timestamp: ts, rawText: desc, locationText: loc, code: codeUpper, preShipment, codeMilestone: preShipment ? null : codeUpper ? lookupCode(codeUpper) : null };
}

/** Walk any payload; collect orders, items, tracking events and freight options. */
export function parsePayload(url: string, bodyText: string, now = Date.now()): ParsedBundle {
  const kind = classifyUrl(url);
  const bundle = emptyBundle(kind);
  bundle.contextOrderId = orderIdFromUrl(url);
  if (!bodyText) return bundle;
  const prot = bodyText.match(/no delivery (?:before|by) ([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})/);
  if (prot) { const t = Date.parse(prot[1].replace('.', '')); if (!isNaN(t)) bundle.protectionEndsAt = t; }
  if (looksLoggedOut(url, 200, bodyText) && !/^\s*[[{]/.test(bodyText)) { bundle.loginRequired = true; return bundle; }
  const payload = unwrapJsonp(bodyText);
  if (payload === undefined) return bundle;
  if (isRecord(payload) && Array.isArray(payload.ret) && payload.ret.some((r) => typeof r === 'string' && /SESSION_EXPIRED|NOT_LOGIN|ILLEGAL_ACCESS/i.test(r))) {
    bundle.loginRequired = true;
  }

  if (kind === 'refund') { bundle.refunds = parseReversePayload(payload); if (bundle.refunds.length) { const total = isRecord(payload) && isRecord(payload.data) && isRecord((payload.data as Record<string, unknown>).module) ? (payload.data as Record<string, unknown>).module as Record<string, unknown> : null; if (total) { bundle.totalPages = num(total.pages) ?? null; bundle.page = num(total.pageNum) ?? null; bundle.totalOrders = num(total.total) ?? null; } return bundle; } }
  const seenOrders = new Set<string>();
  const walk = (node: unknown, depth: number, ctxTracking: string | null): void => {
    if (depth > 14 || node == null) return;
    if (Array.isArray(node)) {
      // Event lists: arrays where most members are event-like
      const recs = node.filter(isRecord);
      if (recs.length >= 1 && recs.filter(isEventLike).length >= Math.max(1, Math.ceil(recs.length * 0.6)) && !recs.some(isOrderLike)) {
        for (const r of recs) { const ev = parseEventObject(r, ctxTracking); if (ev) bundle.events.push(ev); }
        return;
      }
      for (const x of node) walk(x, depth + 1, ctxTracking);
      return;
    }
    if (!isRecord(node)) return;

    if (isOrderLike(node)) {
      const parsed = parseOrderObject(node, now);
      if (parsed && !seenOrders.has(parsed.order.orderId)) {
        seenOrders.add(parsed.order.orderId);
        bundle.orders.push(parsed.order);
        bundle.items.push(...parsed.items);
        bundle.parcels.push(...parsed.parcels);
      }
      // still walk inside for nested logistics/event lists
    }

    // Tracking context for descendants
    const tn = [...extractTrackingNos(node, 3)][0] ?? null;
    const ctx = tn ?? ctxTracking;

    // Parcel hint from a logistics-ish object with tracking + service
    if (tn && (findKey(node, SERVICE_KEYS) !== undefined || findKey(node, SHIP_FROM_KEYS) !== undefined || findKey(node, EVENT_LIST_KEYS) !== undefined)) {
      const orderId = str(findKey(node, ORDER_ID_KEYS));
      if (!bundle.parcels.some((p) => p.trackingNo === tn && (!orderId || p.orderId === orderId))) {
        const pkgItems = (['packageItemList', 'itemList', 'items', 'orderLines', 'productList'].map((k) => node[k]).find(Array.isArray) as unknown[] | undefined) ?? [];
        const eta = isRecord(node.etaInfo) ? node.etaInfo : null;
        bundle.parcels.push({
          trackingNo: tn,
          orderId: orderId && ID_RE.test(orderId) ? orderId : bundle.contextOrderId,
          itemIds: [],
          productIds: pkgItems.map((x) => (isRecord(x) ? str(x.productId ?? x.itemId) : null)).filter((x): x is string => !!x),
          promisedAt: eta ? parseDate(eta.endEtaTime ?? eta.etaTimeStamp ?? eta.beginEtaTime) : null,
          logisticsService: findString(node, SERVICE_KEYS),
          shipFromRegion: findString(node, SHIP_FROM_KEYS),
          destCountry: findString(node, [/^(destCountry|destinationCountry|receiveCountry|shipToCountry|toCountry|destCountryCode)$/i]),
          shippedAt: parseDate(findKey(node, [/^(gmtSend|sendTime|shipTime|shippedAt|gmtShip)$/i])),
          deliveredAt: parseDate(findKey(node, [/^(gmtSign|signTime|deliveredAt|receiveTime)$/i])),
        });
      }
    }

    // Receiver address (tracking payloads)
    if (!bundle.receiver && isRecord(node.logisticsReceiverInfo)) {
      const r = node.logisticsReceiverInfo as Record<string, unknown>;
      bundle.receiver = { city: str(r.city), province: str(r.province ?? r.state), country: str(r.country), zip: str(r.zipCode ?? r.zip ?? r.postCode) };
    }
    // Freight options (listing pages)
    if (isFreightLike(node)) {
      const f = parseFreight(node);
      if (f) bundle.freight.push(f);
    }

    // Pagination signals
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (/^(totalPage|totalPages|pageCount)$/i.test(k)) bundle.totalPages = num(v) ?? bundle.totalPages;
      else if (/^(totalCount|totalNum|total|totalItem|totalOrders|orderCount)$/i.test(k) && typeof v !== 'object') bundle.totalOrders = num(v) ?? bundle.totalOrders;
      else if (/^(currentPage|pageNo|page|pageNum|pageIndex)$/i.test(k) && typeof v !== 'object') bundle.page = num(v) ?? bundle.page;
      else if (/^(hasMore|hasNext|hasNextPage|nextPage|isEnd|end|hasNextOrder)$/i.test(k)) {
        if (typeof v === 'boolean') bundle.hasMore = /isEnd|^end$/i.test(k) ? !v : v;
        else if (typeof v === 'string' && /^(true|false)$/i.test(v)) bundle.hasMore = /isEnd|^end$/i.test(k) ? v.toLowerCase() === 'false' : v.toLowerCase() === 'true';
      }
    }

    for (const k of Object.keys(node)) walk(node[k], depth + 1, ctx);
  };
  walk(payload, 0, null);

  // Order-detail price block: authoritative shipping / discount / tax. Appended last so it wins the merge.
  if (kind === 'orderDetail') {
    const detailed = parseOrderDetailUltron(payload, now);
    if (detailed) {
      bundle.orders = bundle.orders.filter((o) => o.orderId !== detailed.orderId);
      bundle.orders.push(detailed);
    }
  }

  // Deduplicate events
  const seen = new Set<string>();
  bundle.events = bundle.events.filter((e) => { const k = `${e.trackingNo}|${e.timestamp}|${e.rawText}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return bundle;
}

// ───────────────────────────── order detail (price breakdown) ─────────────────────────────

const PRICE_ROW_RULES: [keyof OrderPricing, RegExp][] = [
  ['shippingCost', /shipping|freight|postage|delivery fee/i],
  ['tax', /\btax\b|additional charge|duty|duties|vat|customs|import fee/i],
  ['discount', /coupon|coin|discount|promo|saving|voucher|reward|credit|off\b/i],
  ['itemsSubtotal', /subtotal|item.?total|products? total|goods/i],
];

export interface OrderPricing {
  itemsSubtotal: number | null;
  shippingCost: number | null;
  discount: number | null;
  tax: number | null;
  orderTotal: number | null;
  currency: string | null;
}

/** Read `detail_order_price_block` → priceDetails[] + totalPrice from the ultron detail tree. */
export function parsePriceBlock(fields: Record<string, unknown>): OrderPricing {
  const out: OrderPricing = { itemsSubtotal: null, shippingCost: null, discount: null, tax: null, orderTotal: null, currency: null };
  const rows = Array.isArray(fields.priceDetails) ? fields.priceDetails.filter(isRecord) : [];
  for (const row of rows) {
    const title = str(row.title) ?? '';
    const amount = parseDetailMoney(row.value);
    if (amount == null || !title) continue;
    const hit = PRICE_ROW_RULES.find(([, re]) => re.test(title));
    if (!hit) continue;
    if (hit[0] === 'discount') out.discount = (out.discount ?? 0) + Math.abs(amount);
    else if (hit[0] === 'tax') out.tax = (out.tax ?? 0) + amount;
    else if (hit[0] === 'shippingCost') { if (out.shippingCost == null) out.shippingCost = amount; }
    else if (out.itemsSubtotal == null) out.itemsSubtotal = amount;
  }
  const total = isRecord(fields.totalPrice) ? fields.totalPrice : null;
  if (total) {
    out.orderTotal = parseDetailMoney(total.value) ?? out.orderTotal;
    out.currency = str(total.currencyCode) ?? out.currency;
  }
  return out;
}

/**
 * Parse `mtop.aliexpress.trade.buyer.order.detail` — an ultron component tree keyed by tag.
 * Gives the price breakdown (the order LIST has no shipping line at all) plus payment method.
 */
export function parseOrderDetailUltron(payload: unknown, now = Date.now()): Order | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  const tree = isRecord(data.data) ? data.data : data;
  const byTag = (tag: string): Record<string, unknown> | null => {
    for (const v of Object.values(tree)) if (isRecord(v) && v.tag === tag && isRecord(v.fields)) return v.fields as Record<string, unknown>;
    return null;
  };
  const price = byTag('detail_order_price_block');
  const info = byTag('detail_simple_order_info_component');
  const status = byTag('detail_order_status_block');
  if (!price && !info) return null;
  const orderId = str(info?.tradeOrderId) ?? str(status?.orderId);
  if (!orderId || !ID_RE.test(orderId)) return null;
  const p = price ? parsePriceBlock(price) : { itemsSubtotal: null, shippingCost: null, discount: null, tax: null, orderTotal: null, currency: null };
  return {
    orderId,
    placedAt: parseDate(info?.orderCreatTime ?? info?.payTime),
    sellerId: null,
    sellerName: null,
    status: 'UNKNOWN',
    rawStatus: null,
    currency: p.currency ?? 'USD',
    itemsSubtotal: p.itemsSubtotal,
    shippingCost: p.shippingCost,
    discount: p.discount,
    tax: p.tax,
    orderTotal: p.orderTotal,
    promisedDeliveryAt: null,
    protectionEndsAt: null,
    refundAmount: null,
    paymentMethod: str(info?.paymentMethod),
    checkoutGroup: null,
    pricingDetailed: !!price,
    trackingNos: [],
    updatedAt: now,
  };
}

/**
 * Build a fresh GET mtop URL for `api` by reusing the appKey/jsv of any mtop URL already seen.
 * Lets the order-detail sync run before the user has ever opened an order detail page.
 */
export function synthesizeMtopGet(baseTemplate: string, api: string, data: Record<string, unknown>): string | null {
  try {
    const u = new URL(baseTemplate);
    if (!/\/h5\/mtop\./.test(u.pathname)) return null;
    u.pathname = `/h5/${api}/1.0/`;
    u.searchParams.set('api', api);
    u.searchParams.set('v', '1.0');
    u.searchParams.set('data', JSON.stringify(data));
    u.searchParams.set('type', 'originaljson');
    u.searchParams.set('dataType', 'json');
    for (const k of ['callback', 'post', 'isSec', 'method', 'ecode', 'needLogin']) u.searchParams.delete(k);
    return u.toString();
  } catch { return null; }
}

/** Build a fresh POST mtop request (url + form body) for `api`, reusing a known appKey/jsv. */
export function synthesizeMtopPost(baseTemplate: string, api: string, data: Record<string, unknown>): { url: string; body: string } | null {
  const url = synthesizeMtopGet(baseTemplate, api, {});
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.delete('data');
    return { url: u.toString(), body: `data=${encodeURIComponent(JSON.stringify(data))}` };
  } catch { return null; }
}

/** Returns/refunds APIs, and the request bodies AliExpress' own pages send (observed 2026-09-21). */
export const REVERSE_LIST_API = 'mtop.aliexpress.buyer.reverse.queryReverseOrderPageListForBuyer';
export const REVERSE_DETAIL_API = 'mtop.aliexpress.buyer.reverse.reverseOrderLineRenderForBuyer';
export const REFUNDS_PAGE_URL = 'https://m.aliexpress.com/p/refund-dispute/list.html';
/** `reverseStatus: 1` is the "all cases" bucket; 2/3 are in-progress sub-filters. */
export const reverseListBody = (pageNo: number, size: number, shipTo: string) =>
  ({ _lang: 'en_US', pageNo, shopName: '', reverseStatus: 1, tradeOrderId: '', size, sortOrder: 'DESC', shipTo });
export const reverseDetailBody = (ids: { reverseOrderLineId: string; reverseOrderId: string | null; tradeOrderId: string | null; tradeOrderLineId: string | null }, shipTo: string) =>
  ({ _lang: 'en_US', terminalType: 'PC', reverseOrderLineId: ids.reverseOrderLineId, reverseOrderId: ids.reverseOrderId ?? '', tradeOrderId: ids.tradeOrderId ?? '', tradeOrderLineId: ids.tradeOrderLineId ?? '', shipTo });

/** "GMT-0700" for the current machine, the shape AliExpress' own calls use. */
export function mtopTimeZone(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `GMT${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
}

// ───────────────────────────── returns / refunds (reverse orders) ─────────────────────────────

function moneyOf(v: unknown): { amount: number | null; currency: string | null } {
  if (!isRecord(v)) return parseMoney(v);
  if (v.cent != null) return { amount: (num(v.cent) as number) / 100, currency: str(v.currency) };
  if (v.unit != null) return { amount: num(v.unit), currency: str(v.currency) };
  return parseMoney(v);
}

/**
 * queryReverseOrderPageListForBuyer → module.items[].reverseOrderLines[]   (list, no amounts)
 * reverseOrderLineRenderForBuyer      → module.{reverseFinishInfo.refundInfo…, reachSolution…} (detail, amounts)
 */
export function parseReversePayload(payload: unknown): RefundHint[] {
  const out: RefundHint[] = [];
  if (!isRecord(payload)) return out;
  const data = isRecord(payload.data) ? payload.data : payload;
  const mod = isRecord(data.module) ? data.module : data;
  const lineToHint = (line: Record<string, unknown>, shop: string | null): RefundHint | null => {
    const id = str(line.reverseOrderLineId);
    if (!id) return null;
    const item = isRecord(line.aeItemDTO) ? line.aeItemDTO : isRecord(line.item) ? line.item : {};
    const price = moneyOf(item.itemUnitPrice);
    let img = str(item.itemPicUrl ?? item.itemPic ?? item.itemImgUrl);
    if (img?.startsWith('//')) img = 'https:' + img;
    return {
      refundId: id, reverseOrderId: str(line.reverseOrderId), orderId: str(line.tradeOrderId), orderLineId: str(line.tradeOrderLineId),
      itemTitle: str(item.itemTitle), itemImageUrl: img, itemUnitPrice: price.amount, itemCount: num(item.itemCount) ?? null, currency: price.currency,
      refundAmount: null, refundStatus: null, caseStatus: str(line.reverseStatusText) ?? (line.reverseStatus != null ? `status ${String(line.reverseStatus)}` : null),
      reverseType: str(line.reverseType), solutionText: str(line.solutionTypeText) ?? (line.solutionType != null ? `solution ${String(line.solutionType)}` : null), reason: null,
      requestedAt: parseDate(line.gmtCreate ?? line.gmtCreateFormat), finishedAt: null, detailed: false, ...(shop ? {} : {}),
    };
  };
  // List shape
  const items = Array.isArray(mod.items) ? mod.items : Array.isArray(mod.reverseOrderList) ? mod.reverseOrderList : null;
  if (items) {
    for (const it of items) {
      if (!isRecord(it)) continue;
      const shop = str(it.shopName);
      const lines = Array.isArray(it.reverseOrderLines) ? it.reverseOrderLines : [it];
      for (const l of lines) if (isRecord(l)) { const h = lineToHint(l, shop); if (h) out.push(h); }
    }
    return out;
  }
  // Detail shape
  if (mod.reverseOrderLineId) {
    const h = lineToHint(mod, null);
    if (!h) return out;
    const finish = isRecord(mod.reverseFinishInfo) ? mod.reverseFinishInfo : {};
    const rinfo = isRecord(finish.refundInfo) ? finish.refundInfo : {};
    const details = isRecord(rinfo.refundDetails) ? rinfo.refundDetails : {};
    const reach = isRecord(mod.reachSolution) ? mod.reachSolution : {};
    const cash = moneyOf(details.cashMoney ?? details.totalMoney ?? reach.refundMoney);
    const chan = Array.isArray(rinfo.refundChannelDetails) ? rinfo.refundChannelDetails.filter(isRecord) : [];
    const chanSum = chan.reduce((s, c) => s + (moneyOf(c.money).amount ?? 0), 0);
    h.refundAmount = cash.amount ?? (chanSum || null);
    h.currency = cash.currency ?? h.currency;
    h.refundStatus = str(rinfo.refundNewestStatus) ?? (chan.length ? str(chan[0].refundStatus) : null);
    h.caseStatus = str(mod.reverseDetailStatusText) ?? h.caseStatus;
    h.solutionText = str(reach.solutionTypeText) ?? h.solutionText;
    h.reason = isRecord(mod.applyReason) ? str(mod.applyReason.reasonName) : null;
    h.finishedAt = parseDate(rinfo.refundNewestTime ?? (chan[0]?.aeRefundFinishTime));
    h.requestedAt = h.requestedAt ?? parseDate(mod.gmtCreateTimestamp ?? mod.gmtCreate);
    h.detailed = true;
    out.push(h);
  }
  return out;
}

/** Replace one top-level field inside a flat `data=<json>` POST body (reverse-order APIs). */
export function withBodyField(bodyTemplate: string, key: string, value: unknown): string | null {
  try {
    const decoded = decodeURIComponentSafe(bodyTemplate);
    const m = decoded.match(/(?:^|&)data=([\s\S]*?)(?=&|$)/);
    if (!m) return null;
    const obj = JSON.parse(m[1]);
    if (!isRecord(obj)) return null;
    obj[key] = value;
    return reencodeForm(decoded.replace(m[1], JSON.stringify(obj)));
  } catch { return null; }
}

// ───────────────────────────── freight (listing) parsing ─────────────────────────────

function isFreightLike(o: Record<string, unknown>): boolean {
  const service = findString(o, SERVICE_KEYS) ?? str(o.company ?? o.serviceName ?? o.deliveryOptionCode ?? o.serviceCode);
  const days = findKey(o, [/^(deliveryDayMin|deliveryDayMax|minDeliveryDays|maxDeliveryDays|estimatedDays|deliveryDays|time|deliveryTime|deliveryDate|estimatedDelivery|deliveryDateDisplay|deliveryDayText)$/i]);
  return !!service && days !== undefined && findKey(o, ORDER_ID_KEYS) === undefined;
}

function parseFreight(o: Record<string, unknown>): FreightOption | null {
  const service = findString(o, SERVICE_KEYS) ?? str(o.company ?? o.serviceName ?? o.deliveryOptionCode ?? o.serviceCode);
  if (!service) return null;
  let min = num(findKey(o, [/^(deliveryDayMin|minDeliveryDays|minDays)$/i]));
  let max = num(findKey(o, [/^(deliveryDayMax|maxDeliveryDays|maxDays)$/i]));
  if (min == null && max == null) {
    const text = findString(o, [/^(time|deliveryTime|estimatedDays|deliveryDays|deliveryDateDisplay|deliveryDayText|estimatedDelivery|deliveryDate)$/i]);
    const m = text?.match(/(\d{1,3})\s*[-–~]\s*(\d{1,3})\s*days?/i) ?? text?.match(/(\d{1,3})\s*days?/i);
    if (m) { min = Number(m[1]); max = Number(m[2] ?? m[1]); }
  }
  const fee = firstMoney(o, [/^(freightAmount|shippingFee|fee|price|amount|freight|cost|displayAmount|formattedAmount)$/i], null);
  return { service, shipFrom: findString(o, SHIP_FROM_KEYS), minDays: min, maxDays: max, fee };
}

// ───────────────────────────── DOM: product listing ─────────────────────────────

export interface ListingShippingOption {
  el: HTMLElement;
  service: string;
  aliexpressDays: number | null;
  promiseText: string | null;
}

/** Best-effort extraction of the ship-from region from a product page. */
export function readListingShipFrom(doc: Document): string | null {
  const candidates = doc.querySelectorAll('[class*="ship-from"], [class*="shipFrom"], [class*="ships-from"], [class*="dynamic-shipping"], [data-pl*="ship"]');
  for (const el of candidates) {
    const m = el.textContent?.match(/(?:ships?|shipping)\s+from[:\s]+([A-Za-z .]+)/i);
    if (m) return m[1].trim();
  }
  const m = doc.body?.innerText?.match(/(?:Ships?|Shipping)\s+from[:\s]+([A-Za-z .]{2,40}?)(?:\n|\s{2,}|to\b|$)/i);
  return m ? m[1].trim() : null;
}

const NOT_A_DELIVERY_LINE = /refund|return|coupon|damaged|lost|protection|guarantee|warranty|dispute|review/i;

/** Days until the later date of a "Sep. 26 - Oct. 01" style range, or the "N days" figure in the text. */
export function promiseDaysFromText(text: string, now = Date.now()): number | null {
  const le = text.match(/[≤<]=?\s*(\d{1,3})\s*days?/i);
  if (le) return Number(le[1]);
  const range = text.match(/([A-Z][a-z]{2,8})\.?\s+(\d{1,2})\s*[-–]\s*(?:([A-Z][a-z]{2,8})\.?\s+)?(\d{1,2})/);
  if (range) {
    const year = new Date(now).getFullYear();
    const month = (range[3] ?? range[1]).replace('.', '');
    let t = Date.parse(`${month} ${range[4]}, ${year}`);
    if (!isNaN(t)) { if (t < now - 30 * 86400000) t = Date.parse(`${month} ${range[4]}, ${year + 1}`); return Math.max(1, Math.round((t - now) / 86400000)); }
  }
  const days = text.match(/(\d{1,3})\s*[-–~]\s*(\d{1,3})\s*days?/i) ?? text.match(/(?:in|within)\s+(\d{1,3})\s*days?/i);
  if (days) return Number(days[2] ?? days[1]);
  return null;
}

/**
 * Find the visible "Delivery: …" line(s) on a product page — the exact element the badge should
 * follow. Filters hidden (zero-width) nodes and refund/return/coupon lines. Selector knowledge lives here.
 */
export function readListingShippingOptions(doc: Document): ListingShippingOption[] {
  const out: ListingShippingOption[] = [];
  const seen = new Set<HTMLElement>();
  const candidates = doc.querySelectorAll<HTMLElement>('[class*="dynamic-shipping-line"], [class*="dynamic-shipping"] span, [class*="shipping--"] span, [class*="delivery--"] span, [class*="shipping"] strong, [class*="delivery"] strong');
  const service = findListingService(doc);
  for (const el of candidates) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 140) continue;
    if (!/^(?:estimated )?delivery\s*[:：]|^arrives?\b|\bdelivery (?:in|within) \d/i.test(text)) continue;
    if (NOT_A_DELIVERY_LINE.test(text)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 8) continue;
    // Prefer the outermost line element that still only contains this text (avoid nested span+strong duplicates)
    let target = el;
    while (target.parentElement && (target.parentElement.innerText || '').replace(/\s+/g, ' ').trim() === text && !/dynamic-shipping$|shipping--content|shipping--item/.test(target.parentElement.className)) target = target.parentElement;
    if (seen.has(target) || [...seen].some((x) => x.contains(target) || target.contains(x))) continue;
    seen.add(target);
    out.push({ el: target, service, aliexpressDays: promiseDaysFromText(text), promiseText: text });
  }
  return out;
}

function findListingService(doc: Document): string {
  const t = doc.body?.innerText ?? '';
  const m = t.match(/(AliExpress (?:Standard|Premium|Saver|Selection|Choice)[\w ]{0,20}|Cainiao[\w ]{0,20}|ePacket|China Post[\w ]{0,12}|Yanwen[\w ]{0,12}|4PX[\w ]{0,12}|SunYou[\w ]{0,12}|DHL|FedEx|UPS\b|EMS\b)/);
  if (m) return m[1].trim();
  if (/\bChoice\b/.test(t)) return 'Choice';
  if (/Fast delivery/i.test(t)) return 'Fast delivery';
  return 'Standard';
}

// ───────────────────────────── DOM: orders page (backfill driver) ─────────────────────────────

/** Find a "load more" / next page control on the orders page. */
export function findLoadMoreControl(doc: Document): HTMLElement | null {
  const sel = [
    'button[class*="load-more"]', '[class*="loadMore"]', '[class*="load-more"]', 'button[class*="more"]',
    '.comet-pagination-next:not(.comet-pagination-disabled)', 'li[title="Next Page"]:not([aria-disabled="true"]) button', '.next-btn:not([disabled])', 'a[class*="next"]:not([class*="disabled"])',
    '[class*="pagination"] [class*="next"]:not([class*="disabled"]):not([aria-disabled="true"])',
  ];
  for (const s of sel) {
    const el = doc.querySelector<HTMLElement>(s);
    if (el && el.offsetParent !== null && !(el as HTMLButtonElement).disabled) return el;
  }
  const byText = [...doc.querySelectorAll<HTMLElement>('button, a, div[role="button"], span[role="button"]')].find((e) => /^(load more|view more|view orders|view more orders|show more|more orders|next|next page|see more)$/i.test((e.textContent ?? '').trim()));
  return byText && byText.offsetParent !== null ? byText : null;
}

/** Count rendered order cards on the orders page (progress + exhaustion detection). */
export function countRenderedOrders(doc: Document): number {
  const sel = ['[class*="order-item"]', '[class*="orderItem"]', '[class*="order-card"]', '[class*="orderCard"]', '[data-order-id]', '[class*="order-list"] > div', '[class*="order-block"]'];
  let best = 0;
  for (const s of sel) best = Math.max(best, doc.querySelectorAll(s).length);
  best = Math.max(best, (doc.body?.innerText?.match(/(?:Order ID|Ref\.? ?Number)[:\s]*\d{10,}/gi) ?? []).length);
  return best;
}

/** Order IDs visible in the rendered orders page (DOM fallback, used only for progress accounting). */
export function readRenderedOrderIds(doc: Document): string[] {
  const ids = new Set<string>();
  doc.querySelectorAll<HTMLElement>('[data-order-id]').forEach((e) => { const v = e.dataset.orderId; if (v && ID_RE.test(v)) ids.add(v); });
  for (const m of (doc.body?.innerText ?? '').matchAll(/(?:Order ID|Ref\.? ?Number)[:\s]*(\d{10,22})/gi)) ids.add(m[1]);
  doc.querySelectorAll<HTMLAnchorElement>('a[href*="orderId="]').forEach((a) => { const m = a.href.match(/orderId=(\d{10,22})/); if (m) ids.add(m[1]); });
  return [...ids];
}

/** Does this orders page look exhausted (end-of-list marker, no next control)? */
export function looksExhausted(doc: Document): boolean {
  if (findLoadMoreControl(doc)) return false;
  const t = doc.body?.innerText ?? '';
  return /no more orders|you'?ve reached the end|end of list|that'?s all|no orders found/i.test(t) || true;
}

// ───────────────────────────── mtop signing (direct fetch) ─────────────────────────────

/**
 * mtop requests are signed: sign = md5(`${token}&${t}&${appKey}&${data}`) where token is the
 * first segment of the `_m_h5_tk` cookie. Given a recorded URL template we refresh t + sign.
 */
export function resignMtopUrl(urlTemplate: string, token: string | null, now = Date.now()): string {
  try {
    const u = new URL(urlTemplate);
    if (!/\/h5\/mtop\./.test(u.pathname) || !token) return u.toString();
    const appKey = u.searchParams.get('appKey') ?? '12574478';
    const data = u.searchParams.get('data') ?? '{}';
    const t = String(now);
    u.searchParams.set('t', t);
    u.searchParams.set('sign', md5(`${token}&${t}&${appKey}&${data}`));
    u.searchParams.delete('callback');
    if (u.searchParams.get('type') === 'jsonp') u.searchParams.set('type', 'originaljson');
    return u.toString();
  } catch {
    return urlTemplate;
  }
}

export function serviceKeyFor(service: string | null | undefined): string {
  return normalizeServiceKey(service);
}

// Compact MD5 (RFC 1321) — needed only for mtop signing.
export function md5(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const words: number[] = [];
  for (let i = 0; i < utf8.length; i++) words[i >> 2] = (words[i >> 2] ?? 0) | (utf8[i] << ((i % 4) * 8));
  const bitLen = utf8.length * 8;
  words[bitLen >> 5] = (words[bitLen >> 5] ?? 0) | (0x80 << (bitLen % 32));
  words[(((bitLen + 64) >>> 9) << 4) + 14] = bitLen;
  for (let i = 0; i < words.length; i++) words[i] = words[i] ?? 0;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  const add = (x: number, y: number) => { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); };
  const rol = (n: number, s: number) => (n << s) | (n >>> (32 - s));
  const cmn = (q: number, aa: number, bb: number, x: number, s: number, t: number) => add(rol(add(add(aa, q), add(x, t)), s), bb);
  const ff = (aa: number, bb: number, cc: number, dd: number, x: number, s: number, t: number) => cmn((bb & cc) | (~bb & dd), aa, bb, x, s, t);
  const gg = (aa: number, bb: number, cc: number, dd: number, x: number, s: number, t: number) => cmn((bb & dd) | (cc & ~dd), aa, bb, x, s, t);
  const hh = (aa: number, bb: number, cc: number, dd: number, x: number, s: number, t: number) => cmn(bb ^ cc ^ dd, aa, bb, x, s, t);
  const ii = (aa: number, bb: number, cc: number, dd: number, x: number, s: number, t: number) => cmn(cc ^ (bb | ~dd), aa, bb, x, s, t);
  for (let i = 0; i < words.length; i += 16) {
    const [oa, ob, oc, od] = [a, b, c, d];
    a = ff(a, b, c, d, words[i], 7, -680876936); d = ff(d, a, b, c, words[i + 1], 12, -389564586); c = ff(c, d, a, b, words[i + 2], 17, 606105819); b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, words[i + 4], 7, -176418897); d = ff(d, a, b, c, words[i + 5], 12, 1200080426); c = ff(c, d, a, b, words[i + 6], 17, -1473231341); b = ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416); d = ff(d, a, b, c, words[i + 9], 12, -1958414417); c = ff(c, d, a, b, words[i + 10], 17, -42063); b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682); d = ff(d, a, b, c, words[i + 13], 12, -40341101); c = ff(c, d, a, b, words[i + 14], 17, -1502002290); b = ff(b, c, d, a, words[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, words[i + 1], 5, -165796510); d = gg(d, a, b, c, words[i + 6], 9, -1069501632); c = gg(c, d, a, b, words[i + 11], 14, 643717713); b = gg(b, c, d, a, words[i], 20, -373897302);
    a = gg(a, b, c, d, words[i + 5], 5, -701558691); d = gg(d, a, b, c, words[i + 10], 9, 38016083); c = gg(c, d, a, b, words[i + 15], 14, -660478335); b = gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = gg(a, b, c, d, words[i + 9], 5, 568446438); d = gg(d, a, b, c, words[i + 14], 9, -1019803690); c = gg(c, d, a, b, words[i + 3], 14, -187363961); b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467); d = gg(d, a, b, c, words[i + 2], 9, -51403784); c = gg(c, d, a, b, words[i + 7], 14, 1735328473); b = gg(b, c, d, a, words[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, words[i + 5], 4, -378558); d = hh(d, a, b, c, words[i + 8], 11, -2022574463); c = hh(c, d, a, b, words[i + 11], 16, 1839030562); b = hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060); d = hh(d, a, b, c, words[i + 4], 11, 1272893353); c = hh(c, d, a, b, words[i + 7], 16, -155497632); b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, words[i + 13], 4, 681279174); d = hh(d, a, b, c, words[i], 11, -358537222); c = hh(c, d, a, b, words[i + 3], 16, -722521979); b = hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = hh(a, b, c, d, words[i + 9], 4, -640364487); d = hh(d, a, b, c, words[i + 12], 11, -421815835); c = hh(c, d, a, b, words[i + 15], 16, 530742520); b = hh(b, c, d, a, words[i + 2], 23, -995338651);
    a = ii(a, b, c, d, words[i], 6, -198630844); d = ii(d, a, b, c, words[i + 7], 10, 1126891415); c = ii(c, d, a, b, words[i + 14], 15, -1416354905); b = ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571); d = ii(d, a, b, c, words[i + 3], 10, -1894986606); c = ii(c, d, a, b, words[i + 10], 15, -1051523); b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359); d = ii(d, a, b, c, words[i + 15], 10, -30611744); c = ii(c, d, a, b, words[i + 6], 15, -1560198380); b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, words[i + 4], 6, -145523070); d = ii(d, a, b, c, words[i + 11], 10, -1120210379); c = ii(c, d, a, b, words[i + 2], 15, 718787259); b = ii(b, c, d, a, words[i + 9], 21, -343485551);
    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  return [a, b, c, d].map((n) => { let s = ''; for (let j = 0; j < 4; j++) s += ((n >> (j * 8)) & 0xff).toString(16).padStart(2, '0'); return s; }).join('');
}
