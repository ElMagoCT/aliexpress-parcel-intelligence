export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export function jitter(baseMs: number, spread = 0.3): number {
  const j = (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.round(baseMs * (1 + j)));
}

export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export function randBetween(minMs: number, maxMs: number) {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

/** SHA-256 hex via WebCrypto; falls back to FNV-1a when crypto.subtle is unavailable (tests). */
export async function sha256(text: string): Promise<string> {
  try {
    if (globalThis.crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through */ }
  return fnv1a(text);
}

export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ,.'/-]/gu, '').trim();
}

export function normalizeServiceKey(service: string | null | undefined): string {
  if (!service) return 'unknown';
  return service
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_') || 'unknown';
}

export function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function fmtDate(ts: number | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(undefined, opts);
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function daysBetween(a: number, b: number): number {
  return (b - a) / DAY;
}

/** "just now", "6m ago", "3h ago", "2d ago" — for last-updated stamps. */
export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = s / 86400;
  if (d < 30) return `${Math.round(d)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

export function fmtDays(d: number): string {
  if (!isFinite(d)) return '—';
  if (Math.abs(d) < 1) return `${Math.round(d * 24)}h`;
  return `${Math.round(d)}d`;
}

export function fmtMoney(amount: number | null | undefined, currency = 'USD'): string {
  if (amount == null || !isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function groupBy<T, K extends string | number>(arr: T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const t of arr) (out[key(t)] ||= []).push(t);
  return out;
}

export function safeJsonParse(text: string): unknown | undefined {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Strip a JSONP wrapper like `mtopjsonp3({...})` or `callback({...});` */
export function unwrapJsonp(text: string): unknown | undefined {
  const t = text.trim();
  const direct = safeJsonParse(t);
  if (direct !== undefined) return direct;
  const m = t.match(/^[\w$.]+\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/);
  if (m) return safeJsonParse(m[1]);
  return undefined;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
