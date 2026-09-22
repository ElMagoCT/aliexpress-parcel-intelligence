/**
 * Route reconstruction. AliExpress scans rarely carry a place name ("Your package arrived at
 * local airport"), so a parcel's path is rebuilt from what IS known: real geocoded scans when
 * present, otherwise the milestone sequence anchored on the origin hub, the destination-country
 * gateway nearest to home, and home itself. Inferred points are flagged so the map can draw them
 * differently and the panel can say so.
 */
import type { Milestone, Parcel, TrackEvent } from '@/model/types';
import { gazetteerLookup } from '@/background/geocode';

export interface RoutePoint { lat: number; lng: number; ts: number; inferred: boolean; label: string; milestone: Milestone | null; eventId: string | null }
export interface Route { points: RoutePoint[]; current: RoutePoint | null; origin: { lat: number; lng: number } | null; dest: { lat: number; lng: number } | null }

/** Typical first-mile export hubs by origin country/region. */
const ORIGIN_HUBS: Record<string, [number, number]> = {
  china: [22.5431, 114.0579], cn: [22.5431, 114.0579], 'mainland china': [22.5431, 114.0579], 'hong kong': [22.3193, 114.1694], hk: [22.3193, 114.1694],
  'united states': [34.0522, -118.2437], us: [34.0522, -118.2437], usa: [34.0522, -118.2437], spain: [40.4168, -3.7038], es: [40.4168, -3.7038], poland: [52.2297, 21.0122], pl: [52.2297, 21.0122],
  germany: [50.1109, 8.6821], de: [50.1109, 8.6821], france: [48.8566, 2.3522], fr: [48.8566, 2.3522], 'czech republic': [50.0755, 14.4378], cz: [50.0755, 14.4378], belgium: [50.6326, 5.5797], be: [50.6326, 5.5797],
  turkey: [41.0082, 28.9784], tr: [41.0082, 28.9784], korea: [37.4602, 126.4407], kr: [37.4602, 126.4407], japan: [35.7647, 140.3864], jp: [35.7647, 140.3864], vietnam: [10.8231, 106.6297], vn: [10.8231, 106.6297],
  'united kingdom': [51.47, -0.4543], uk: [51.47, -0.4543], gb: [51.47, -0.4543], italy: [45.63, 8.7231], it: [45.63, 8.7231], australia: [-33.9399, 151.1753], au: [-33.9399, 151.1753], brazil: [-23.4356, -46.4731], br: [-23.4356, -46.4731],
};

/** International gateways (airports / ISCs) by destination country; the one nearest home is used. */
const DEST_GATEWAYS: Record<string, [number, number][]> = {
  us: [[33.9425, -118.4081], [41.9742, -87.9073], [40.6413, -73.7781], [25.7959, -80.287], [37.6213, -122.379], [32.8998, -97.0403], [33.6407, -84.4277], [47.4502, -122.3088], [21.3187, -157.9225]],
  ca: [[43.6777, -79.6248], [49.1967, -123.1815], [45.4706, -73.7408]], gb: [[51.47, -0.4543]], ie: [[53.4264, -6.2499]], de: [[50.0379, 8.5622], [51.4239, 12.2364]], fr: [[49.0097, 2.5479]], es: [[40.4983, -3.5676]], it: [[45.63, 8.7231]], nl: [[52.3105, 4.7683]],
  be: [[50.6326, 5.5797]], pl: [[52.1657, 20.9671]], se: [[59.6498, 17.9238]], no: [[60.1976, 11.1004]], fi: [[60.3172, 24.9633]], dk: [[55.618, 12.656]], ch: [[47.4582, 8.5555]], at: [[48.1103, 16.5697]], cz: [[50.1008, 14.26]], hu: [[47.4298, 19.2611]], pt: [[38.7756, -9.1354]], gr: [[37.9364, 23.9445]],
  au: [[-33.9399, 151.1753], [-37.669, 144.841], [-27.3842, 153.1175], [-31.9385, 115.9672]], nz: [[-37.0082, 174.785]], br: [[-23.4356, -46.4731]], mx: [[19.4361, -99.0719]], jp: [[35.7647, 140.3864]], kr: [[37.4602, 126.4407]], il: [[32.0055, 34.8854]], tr: [[41.2753, 28.7519]], za: [[-26.1392, 28.246]], in: [[28.5562, 77.1]], sg: [[1.3644, 103.9915]], ae: [[25.2532, 55.3657]],
};

const COUNTRY_CODES: Record<string, string> = {
  'united states': 'us', usa: 'us', us: 'us', america: 'us', canada: 'ca', 'united kingdom': 'gb', uk: 'gb', 'great britain': 'gb', england: 'gb', ireland: 'ie', germany: 'de', deutschland: 'de', france: 'fr', spain: 'es', españa: 'es', italy: 'it', italia: 'it', netherlands: 'nl', belgium: 'be', poland: 'pl', polska: 'pl', sweden: 'se', norway: 'no', finland: 'fi', denmark: 'dk', switzerland: 'ch', austria: 'at', 'czech republic': 'cz', czechia: 'cz', hungary: 'hu', portugal: 'pt', greece: 'gr', australia: 'au', 'new zealand': 'nz', brazil: 'br', brasil: 'br', mexico: 'mx', japan: 'jp', korea: 'kr', 'south korea': 'kr', israel: 'il', turkey: 'tr', 'south africa': 'za', india: 'in', singapore: 'sg', 'united arab emirates': 'ae',
};

const dist2 = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + ((a[1] - b[1]) * Math.cos((a[0] * Math.PI) / 180)) ** 2;

export function countryCode(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  if (n.length === 2) return n;
  return COUNTRY_CODES[n] ?? null;
}

export function originHub(shipFrom: string | null | undefined): { lat: number; lng: number } | null {
  if (!shipFrom) return { lat: 22.5431, lng: 114.0579 }; // the overwhelming default for AliExpress
  const key = shipFrom.toLowerCase().trim();
  const hub = ORIGIN_HUBS[key];
  if (hub) return { lat: hub[0], lng: hub[1] };
  const g = gazetteerLookup(shipFrom);
  return g ? { lat: g.lat, lng: g.lng } : { lat: 22.5431, lng: 114.0579 };
}

export function destGateway(destCountry: string | null | undefined, home: { lat: number; lng: number } | null): { lat: number; lng: number } | null {
  const cc = countryCode(destCountry) ?? (home ? nearestCountryByHome(home) : null);
  const list = cc ? DEST_GATEWAYS[cc] : null;
  if (!list?.length) return home;
  const ref: [number, number] | null = home ? [home.lat, home.lng] : null;
  const best = ref ? list.reduce((b, g) => (dist2(g, ref) < dist2(b, ref) ? g : b), list[0]) : list[0];
  return { lat: best[0], lng: best[1] };
}

function nearestCountryByHome(home: { lat: number; lng: number }): string | null {
  let best: string | null = null, bd = Infinity;
  for (const [cc, list] of Object.entries(DEST_GATEWAYS)) for (const g of list) { const d = dist2(g, [home.lat, home.lng]); if (d < bd) { bd = d; best = cc; } }
  return bd < 400 ? best : null; // only when reasonably close (~20°)
}

/** Where a milestone sits along origin → gateway → home, as a fraction and an anchor. */
function anchorFor(m: Milestone | null): { leg: 'origin' | 'linehaul' | 'gateway' | 'local' | 'home' | null; t: number } {
  switch (m) {
    case 'SELLER_SHIPPED': case 'ORIGIN_ACCEPTED': case 'ORIGIN_DEPARTED': case 'EXPORT_CUSTOMS': return { leg: 'origin', t: 0 };
    case 'DEPARTED_ORIGIN_COUNTRY': return { leg: 'linehaul', t: 0.15 };
    case 'ARRIVED_DEST_COUNTRY': case 'IMPORT_CUSTOMS': return { leg: 'gateway', t: 0 };
    case 'HANDED_TO_LOCAL_CARRIER': return { leg: 'local', t: 0.35 };
    case 'IN_TRANSIT_LOCAL': return { leg: 'local', t: 0.65 };
    case 'OUT_FOR_DELIVERY': return { leg: 'local', t: 0.9 };
    case 'DELIVERED': return { leg: 'home', t: 1 };
    default: return { leg: null, t: 0 };
  }
}

const lerp = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, t: number) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });

/**
 * Build the route for a parcel. Real coordinates win; placeless scans are placed by milestone.
 * Points are chronological and de-duplicated by position; `current` is the newest point ≤ `at`.
 */
export function routeFor(parcel: Parcel, events: TrackEvent[], home: { lat: number; lng: number } | null, at = Date.now()): Route {
  const origin = originHub(parcel.shipFromRegion);
  const dest = home ?? destGateway(parcel.destCountry, null);
  const gateway = destGateway(parcel.destCountry, home) ?? dest;
  const sorted = [...events].filter((e) => e.timestamp <= at).sort((a, b) => a.timestamp - b.timestamp);
  const pts: RoutePoint[] = [];
  let lastReal: { lat: number; lng: number } | null = null;
  let furthest = -1;
  const order: Milestone[] = ['SELLER_SHIPPED', 'ORIGIN_ACCEPTED', 'ORIGIN_DEPARTED', 'EXPORT_CUSTOMS', 'DEPARTED_ORIGIN_COUNTRY', 'ARRIVED_DEST_COUNTRY', 'IMPORT_CUSTOMS', 'HANDED_TO_LOCAL_CARRIER', 'IN_TRANSIT_LOCAL', 'OUT_FOR_DELIVERY', 'DELIVERED'];
  for (const e of sorted) {
    if (e.lat != null && e.lng != null && (e.geoConfidence ?? 1) > 0.35) {
      lastReal = { lat: e.lat, lng: e.lng };
      pts.push({ lat: e.lat, lng: e.lng, ts: e.timestamp, inferred: false, label: e.locationText ?? e.rawText, milestone: e.milestone, eventId: e.eventId });
      continue;
    }
    const idx = e.milestone ? order.indexOf(e.milestone) : -1;
    if (idx < 0 || idx < furthest) continue; // pre-shipment / exception / backtracking noise: no new position
    furthest = idx;
    const a = anchorFor(e.milestone);
    let p: { lat: number; lng: number } | null = null;
    if (a.leg === 'origin' && origin) p = origin;
    else if (a.leg === 'linehaul' && origin && gateway) p = lerp(origin, gateway, a.t);
    else if (a.leg === 'gateway' && gateway) p = gateway;
    else if (a.leg === 'local' && gateway && dest) p = lerp(gateway, dest, a.t);
    else if (a.leg === 'home' && dest) p = dest;
    if (!p) continue;
    if (lastReal && a.leg === 'origin') p = lastReal; // don't jump back to the hub after a real scan
    pts.push({ ...p, ts: e.timestamp, inferred: true, label: e.rawText, milestone: e.milestone, eventId: e.eventId });
  }
  // Collapse consecutive points at (nearly) the same place, keep the latest timestamp there
  const collapsed: RoutePoint[] = [];
  for (const p of pts) {
    const last = collapsed.at(-1);
    if (last && Math.abs(last.lat - p.lat) < 0.05 && Math.abs(last.lng - p.lng) < 0.05) { collapsed[collapsed.length - 1] = { ...p, inferred: last.inferred && p.inferred }; continue; }
    collapsed.push(p);
  }
  return { points: collapsed, current: collapsed.at(-1) ?? null, origin, dest };
}
