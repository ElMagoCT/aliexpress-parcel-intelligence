import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import type { Item, Parcel, TrackEvent } from '@/model/types';
import { useEventsByParcel, useItemsByParcel, useOrdersById, useParcels, usePredictionsById, useSettings, isActive } from '../lib/useData';
import { ParcelPanel, stateTag } from '../components/ParcelPanel';
import { routeFor, type Route } from '@/engine/route';
import { fmtDate, DAY } from '@/shared/util';
import world from '@/data/world-110m.json';
import { db } from '@/db/schema';

/**
 * Detailed base maps. Esri's public tile services need no key and accept requests from
 * chrome-extension:// pages (OpenStreetMap's servers 403 them and CARTO now requires a key).
 * The bundled vector world stays underneath so the map is never blank while tiles load.
 */
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const TILE_STYLES: Record<'dark' | 'streets' | 'satellite', { layers: { url: string; maxZoom: number; opacity?: number }[]; attribution: string; label: string }> = {
  dark: { label: 'Dark', attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors', layers: [{ url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, maxZoom: 16 }, { url: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, maxZoom: 16 }] },
  streets: { label: 'Streets', attribution: 'Esri, HERE, Garmin, USGS, © OpenStreetMap contributors', layers: [{ url: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19 }] },
  satellite: { label: 'Satellite', attribution: 'Esri, Maxar, Earthstar Geographics', layers: [{ url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19 }, { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19 }] },
};

interface Row { p: Parcel; route: Route; items: Item[]; itemCount: number; cls: string }

/**
 * Leaflet writes `stroke` as an SVG attribute, where `var(--accent)` would not resolve, so the
 * themed colours are read off the document and recomputed whenever the accent changes.
 */
function routeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const accent = v('--accent', '#6ea8ff');
  const accent2 = v('--accent2', '#9b7bff');
  const mix = (c: string, pct: number) => `color-mix(in oklab, ${c} ${pct}%, transparent)`;
  return { path: accent, pathDim: mix(accent, 28), sel: accent2, inferred: mix(accent2, 90), proj: mix(accent2, 55), faint: mix(accent, 20), faintAlt: mix(accent2, 30) };
}

function clsFor(p: Parcel) {
  return p.state === 'STALLED' ? 'warn' : p.state === 'EXCEPTION' || p.state === 'RETURNED' ? 'bad' : p.state === 'DELIVERED' || p.state === 'OUT_FOR_DELIVERY' ? 'ok' : '';
}

/** Grid clustering in pixel space (only for unselected, non-grouped markers). */
function cluster(map: L.Map, rows: Row[], nlFn: (lng: number) => number, cell = 44): { lat: number; lng: number; members: Row[] }[] {
  const buckets = new Map<string, Row[]>();
  for (const r of rows) { const c = r.route.current!; const pt = map.latLngToContainerPoint([c.lat, nlFn(c.lng)]); const k = `${Math.floor(pt.x / cell)}:${Math.floor(pt.y / cell)}`; (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(r); }
  return [...buckets.values()].map((members) => ({ lat: members.reduce((s, m) => s + m.route.current!.lat, 0) / members.length, lng: members.reduce((s, m) => s + m.route.current!.lng, 0) / members.length, members }));
}

export function MapView({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string | null) => void }) {
  const parcels = useParcels();
  const eventsBy = useEventsByParcel();
  const itemsBy = useItemsByParcel();
  const ordersBy = useOrdersById();
  const predsBy = usePredictionsById();
  const settings = useSettings();
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const tilesRef = useRef<L.LayerGroup | null>(null);
  const [showDelivered, setShowDelivered] = useState(false);
  const [zoomTick, setZoomTick] = useState(0);
  const now = Date.now();
  const home = settings.homeAddressCoords;
  const range = useMemo(() => {
    const starts = parcels.map((p) => p.shippedAt ?? eventsBy.get(p.parcelId)?.[0]?.timestamp ?? null).filter((x): x is number => !!x);
    return { min: starts.length ? Math.min(...starts) : now - 30 * DAY, max: now };
  }, [parcels, eventsBy, now]);
  const [t, setT] = useState<number>(now);
  const live = t >= range.max - 60_000;
  // Keep every coordinate within ±180° of home so China→Americas routes cross the Pacific, not Europe.
  const ref = home?.lng ?? -100;
  const nl = (lng: number) => { let x = lng; while (x - ref > 180) x -= 360; while (x - ref < -180) x += 360; return x; };
  const ll = (p: { lat: number; lng: number }): [number, number] => [p.lat, nl(p.lng)];

  // Map init: bundled vector world (no tiles, no network, no key) on a dark ground
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = L.map(mapEl.current, { zoomControl: false, worldCopyJump: false, attributionControl: true, minZoom: 1, maxZoom: 18 }).setView([30, -100], 2);
    // Vector world in its own pane BELOW the raster tiles (fallback while tiles load / offline). Three copies so a Pacific-centred view has land on both sides.
    map.createPane('world').style.zIndex = '150';
    for (const shift of [-360, 0, 360]) L.geoJSON(world as GeoJSON.FeatureCollection, { pane: 'world', style: { color: '#2b365f', weight: 0.8, fillColor: '#1a2447', fillOpacity: 1 }, interactive: false, coordsToLatLng: (c) => L.latLng(c[1], c[0] + shift) }).addTo(map);
    map.attributionControl.addAttribution('Natural Earth');
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    tilesRef.current = L.layerGroup().addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    (window as unknown as { __aepiMap?: L.Map }).__aepiMap = map; // debugging aid (dev preview)
    map.on('zoomend moveend', () => setZoomTick((z) => z + 1));
    setTimeout(() => map.invalidateSize(), 50);
  }, []);

  // Base map style (raster tiles over the vector world)
  useEffect(() => {
    const map = mapRef.current, tiles = tilesRef.current;
    if (!map || !tiles) return;
    tiles.clearLayers();
    const style = TILE_STYLES[settings.mapStyle] ?? TILE_STYLES.dark;
    for (const l of style.layers) L.tileLayer(l.url, { maxZoom: 18, maxNativeZoom: l.maxZoom, opacity: l.opacity ?? 1, attribution: style.attribution, crossOrigin: false }).addTo(tiles);
  }, [settings.mapStyle]);

  const rows = useMemo<Row[]>(() => parcels
    .filter((p) => showDelivered || isActive(p) || p.parcelId === selectedId)
    .map((p) => { const items = itemsBy.get(p.parcelId) ?? []; return { p, route: routeFor(p, eventsBy.get(p.parcelId) ?? [], home, t), items, itemCount: items.reduce((s, i) => s + i.qty, 0) || p.itemIds.length || 1, cls: clsFor(p) }; })
    .filter((r) => r.route.current), [parcels, showDelivered, selectedId, itemsBy, eventsBy, home, t]);

  const groups = useMemo(() => { const m = new Map<string, Row[]>(); for (const r of rows) if (r.p.consolidationGroup) (m.get(r.p.consolidationGroup) ?? m.set(r.p.consolidationGroup, []).get(r.p.consolidationGroup)!).push(r); return m; }, [rows]);

  // Draw
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!map || !layer) return;
    const COLORS = routeColors();
    layer.eachLayer((l) => { const m = l as L.Marker; if (typeof m.unbindTooltip === 'function') m.unbindTooltip(); });
    layer.clearLayers();
    if (home) L.marker(ll(home), { icon: L.divIcon({ className: '', html: '<div class="home" title="Home"></div>', iconSize: [14, 14] }), zIndexOffset: 500 }).addTo(layer);

    const drawRoute = (r: Row, strong: boolean) => {
      const pts = r.route.points;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const inferred = a.inferred || b.inferred;
        L.polyline([ll(a), ll(b)], { color: strong ? (inferred ? COLORS.inferred : COLORS.sel) : inferred ? COLORS.faintAlt : COLORS.pathDim, weight: strong ? 3.5 : 1.5, dashArray: inferred ? '5 7' : undefined, opacity: 1 }).addTo(layer);
      }
      if (strong) for (const pt of pts) L.circleMarker(ll(pt), { radius: pt.inferred ? 3 : 4, color: '#fff', weight: 1, fillColor: pt.inferred ? COLORS.inferred : COLORS.sel, fillOpacity: 1 }).bindTooltip(`${pt.label}<br><span style="opacity:.7">${fmtDate(pt.ts, { month: 'short', day: 'numeric', year: 'numeric' })}${pt.inferred ? ' · position inferred from milestone' : ''}</span>`, { direction: 'top' }).addTo(layer);
      // projected remainder to home
      const cur = r.route.current;
      if (cur && home && r.p.state !== 'DELIVERED' && (Math.abs(cur.lat - home.lat) > 0.05 || Math.abs(cur.lng - home.lng) > 0.05)) {
        L.polyline([ll(cur), ll(home)], { color: strong ? COLORS.proj : COLORS.faintAlt, weight: strong ? 2.5 : 1, dashArray: '2 8' }).addTo(layer);
      }
    };
    const sel = rows.find((r) => r.p.parcelId === selectedId);
    if (rows.length <= 25) for (const r of rows) if (r !== sel) drawRoute(r, false);
    if (sel) drawRoute(sel, true);

    const marker = (r: Row, strong: boolean) => {
      const c = r.route.current!;
      const pulse = r.p.state === 'OUT_FOR_DELIVERY' || r.p.state === 'STALLED';
      const mk = L.marker(ll(c), { icon: L.divIcon({ className: '', html: `<div class="pk ${r.cls} ${strong ? 'sel' : ''} ${pulse ? 'pulse' : ''}">${r.itemCount}</div>`, iconSize: [28, 28] }), zIndexOffset: strong ? 1000 : 0 });
      const pred = predsBy.get(r.p.parcelId);
      mk.bindTooltip(`<b>${r.items[0]?.title.slice(0, 50) ?? r.p.logisticsService ?? r.p.trackingNo}</b>${r.items.length > 1 ? ` +${r.items.length - 1} more` : ''}<br>${r.itemCount} item${r.itemCount === 1 ? '' : 's'} · ${r.p.logisticsService ?? ''}${pred ? `<br>ETA ${fmtDate(pred.p50)}–${fmtDate(pred.p80)}` : ''}`, { direction: 'top' });
      mk.on('click', () => onSelect(r.p.parcelId));
      mk.addTo(layer);
    };

    const grouped = new Set<string>();
    for (const [, members] of groups) {
      if (members.length < 2) continue;
      members.forEach((m) => grouped.add(m.p.parcelId));
      const m0 = members.find((m) => m.p.parcelId === selectedId) ?? members[0];
      const c = m0.route.current!;
      const total = members.reduce((s, m) => s + m.itemCount, 0);
      const mk = L.marker(ll(c), { icon: L.divIcon({ className: '', html: `<div class="pk group ${members.some((m) => m.p.parcelId === selectedId) ? 'sel' : ''}">${total}</div>`, iconSize: [32, 32] }), zIndexOffset: 900 });
      mk.bindTooltip(`${members.length} parcels moving as one · ${total} items`, { direction: 'top' });
      mk.on('click', () => onSelect(m0.p.parcelId));
      mk.addTo(layer);
    }
    const rest = rows.filter((r) => !grouped.has(r.p.parcelId));
    for (const c of cluster(map, rest, nl)) {
      const hasSel = c.members.some((m) => m.p.parcelId === selectedId);
      if (c.members.length > 1 && map.getZoom() < 9 && !hasSel) {
        const total = c.members.reduce((s, m) => s + m.itemCount, 0);
        const mk = L.marker([c.lat, nl(c.lng)], { icon: L.divIcon({ className: '', html: `<div class="cluster" title="${c.members.length} parcels here">${c.members.length}<small>${total} items</small></div>`, iconSize: [40, 40] }) });
        mk.on('click', () => map.setView([c.lat, nl(c.lng)], Math.min(map.getZoom() + 3, 10)));
        mk.addTo(layer);
        continue;
      }
      for (const r of c.members) marker(r, r.p.parcelId === selectedId);
    }
  }, [rows, groups, selectedId, home, zoomTick, predsBy, onSelect, settings.accent, settings.theme]);

  // Fit once (again when home appears); refit to the route when a parcel is picked
  // Initial framing: data arrives table by table (parcels, then events, then settings), so keep
  // re-fitting for the first few seconds after mount, then leave the user's viewport alone.
  const mountedAt = useRef(Date.now());
  const fitted = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !rows.length || selectedId) return;
    if (fitted.current && Date.now() - mountedAt.current > 4000) return;
    const pts: [number, number][] = rows.flatMap((r) => [ll(r.route.current!), ...(r.route.points.length ? [ll(r.route.points[0])] : [])]);
    if (home) pts.push(ll(home));
    (window as unknown as { __aepiFitPts?: unknown }).__aepiFitPts = pts;
    const id = setTimeout(() => { map.invalidateSize(); map.fitBounds(L.latLngBounds(pts).pad(0.12), { maxZoom: 5, animate: false }); }, 80);
    fitted.current = true;
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, home]);
  // Pick a parcel → centre on it; zoom follows how far it still has to go (far away = zoomed out).
  useEffect(() => {
    const map = mapRef.current;
    const sel = rows.find((r) => r.p.parcelId === selectedId);
    if (!map || !sel?.route.current) return;
    const cur = sel.route.current;
    const target = sel.p.state === 'DELIVERED' ? null : home ?? sel.route.dest;
    let zoom = 5;
    if (target) {
      const km = map.distance([cur.lat, cur.lng], [target.lat, target.lng]) / 1000;
      zoom = km > 6000 ? 3 : km > 2500 ? 4 : km > 1200 ? 5 : km > 500 ? 6 : km > 150 ? 7 : km > 40 ? 8 : 9;
    } else zoom = 7;
    if (document.visibilityState === 'hidden') map.setView(ll(cur), zoom, { animate: false }); // background tabs get no animation frames
    else map.flyTo(ll(cur), zoom, { duration: 0.7 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const selected = selectedId ? parcels.find((p) => p.parcelId === selectedId) : undefined;
  const active = parcels.filter(isActive);
  const listRows = useMemo(() => [...rows].sort((a, b) => (a.p.state === 'DELIVERED' ? 1 : 0) - (b.p.state === 'DELIVERED' ? 1 : 0) || (predsBy.get(a.p.parcelId)?.p50 ?? Infinity) - (predsBy.get(b.p.parcelId)?.p50 ?? Infinity)), [rows, predsBy]);

  return (
    <div className="mapwrap">
      <div className="mapcol">
        <div ref={mapEl} className="map" />
        <div className="legend">
          <span className="tag"><i className="sw solid" /> travelled</span>
          <span className="tag"><i className="sw dashed" /> inferred from milestones</span>
          <span className="tag"><i className="sw dotted" /> projected to home</span>
          {!home && <span className="tag warn">Set your home address in Settings for projected routes</span>}
        </div>
        <div className="styles">
          {(Object.keys(TILE_STYLES) as (keyof typeof TILE_STYLES)[]).map((k) => <button key={k} className={`btn sm ${settings.mapStyle === k ? 'primary' : ''}`} onClick={() => void db.patchSettings({ mapStyle: k })}>{TILE_STYLES[k].label}</button>)}
        </div>
        {selected && (
          <ParcelPanel parcel={selected} items={itemsBy.get(selected.parcelId) ?? []} orders={selected.orderIds.map((id) => ordersBy.get(id)).filter((o): o is NonNullable<typeof o> => !!o)} events={eventsBy.get(selected.parcelId) ?? []} pred={predsBy.get(selected.parcelId)} groupSize={selected.consolidationGroup ? parcels.filter((p) => p.consolidationGroup === selected.consolidationGroup).length : 1} onClose={() => onSelect(null)} />
        )}
        <div className="mapctl">
          <button className="btn sm" onClick={() => setT(range.max)} disabled={live}>Live</button>
          <button className="btn sm" title="One day back" onClick={() => setT((x) => Math.max(range.min, x - DAY))}>−1d</button>
          <input type="range" min={range.min} max={range.max} step={3600_000} value={t} onChange={(e) => setT(Number(e.target.value))} />
          <button className="btn sm" title="One day forward" onClick={() => setT((x) => Math.min(range.max, x + DAY))}>+1d</button>
          <input type="date" className="dateinp" min={new Date(range.min).toISOString().slice(0, 10)} max={new Date(range.max).toISOString().slice(0, 10)} value={new Date(t).toISOString().slice(0, 10)} onChange={(e) => { const d = Date.parse(e.target.value + 'T12:00:00'); if (!isNaN(d)) setT(Math.min(range.max, Math.max(range.min, d))); }} />
          <span className="t">{live ? 'Now' : fmtDate(t, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        </div>
      </div>
      <aside className="plist">
        <div className="plist-head">
          <div><strong>{active.length} active parcel{active.length === 1 ? '' : 's'}</strong><div className="muted" style={{ fontSize: 11 }}>{groups.size ? `${groups.size} consolidated · ` : ''}{active.reduce((s, p) => s + ((itemsBy.get(p.parcelId) ?? []).reduce((x, i) => x + i.qty, 0) || p.itemIds.length), 0)} items on the way</div></div>
          <label className="tag" style={{ cursor: 'pointer' }}><input type="checkbox" checked={showDelivered} onChange={(e) => setShowDelivered(e.target.checked)} style={{ margin: 0 }} /> delivered</label>
        </div>
        {!listRows.length && <div className="empty" style={{ margin: 12 }}>{parcels.length ? 'Nothing in transit.' : 'No parcels yet — run Backfill or browse your AliExpress orders.'}</div>}
        {listRows.map((r) => {
          const pred = predsBy.get(r.p.parcelId);
          const order = r.p.orderIds.map((id) => ordersBy.get(id)).find(Boolean);
          const isSel = r.p.parcelId === selectedId;
          return (
            <div key={r.p.parcelId} className={`pcard ${isSel ? 'sel' : ''}`} onClick={() => onSelect(isSel ? null : r.p.parcelId)}>
              <div className="pthumbs">
                {r.items.slice(0, 4).map((i) => i.imageUrl ? <img key={i.itemId} src={i.imageUrl} alt="" loading="lazy" /> : <span key={i.itemId} className="ph">▣</span>)}
                {!r.items.length && <span className="ph">▣</span>}
                <span className="pcount">{r.itemCount}</span>
              </div>
              <div className="pbody">
                <div className="ptitle">{r.items[0]?.title ?? r.p.logisticsService ?? r.p.trackingNo}{r.items.length > 1 ? <span className="muted"> +{r.items.length - 1} more</span> : null}</div>
                <div className="row" style={{ gap: 6 }}>{stateTag(r.p)}{r.p.orderIds.length > 1 && <span className="tag">{r.p.orderIds.length} orders</span>}</div>
                <div className="muted" style={{ fontSize: 11 }}>{r.p.logisticsService ?? 'unknown carrier'}{order?.sellerName ? ` · ${order.sellerName}` : ''}</div>
                <div className="peta">{pred ? <><strong>{fmtDate(pred.p50)} – {fmtDate(pred.p80)}</strong>{order?.promisedDeliveryAt && <span className="muted"> · AE {fmtDate(order.promisedDeliveryAt)}</span>}</> : r.p.state === 'DELIVERED' ? <span className="muted">delivered {fmtDate(r.p.deliveredAt ?? r.p.lastEventAt)}</span> : <span className="muted">no estimate yet</span>}</div>
                <div className="muted" style={{ fontSize: 11 }}>{r.route.current?.label}{r.route.current?.inferred ? ' · position inferred' : ''}</div>
              </div>
            </div>
          );
        })}
      </aside>
    </div>
  );
}

export type { TrackEvent };
