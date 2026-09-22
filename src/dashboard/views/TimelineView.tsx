import { useMemo } from 'react';
import { useEventsByParcel, useItemsByParcel, useOrdersById, useParcels, usePredictionsById, isActive } from '../lib/useData';
import { stateTag } from '../components/ParcelPanel';
import { fmtDate, DAY } from '@/shared/util';

export function TimelineView({ onSelect }: { onSelect: (id: string) => void }) {
  const parcels = useParcels();
  const preds = usePredictionsById();
  const orders = useOrdersById();
  const items = useItemsByParcel();
  const eventsBy = useEventsByParcel();
  const now = Date.now();
  const rows = useMemo(() => parcels.filter(isActive).map((p) => {
    const pred = preds.get(p.parcelId);
    const order = p.orderIds.map((id) => orders.get(id)).find(Boolean);
    const start = p.shippedAt ?? eventsBy.get(p.parcelId)?.[0]?.timestamp ?? p.updatedAt;
    const first = (items.get(p.parcelId) ?? [])[0];
    return { p, pred, order, start, sortKey: pred?.p50 ?? Number.MAX_SAFE_INTEGER, title: first?.title ?? p.logisticsService ?? p.trackingNo, img: first?.imageUrl ?? null };
  }).sort((a, b) => a.sortKey - b.sortKey), [parcels, preds, orders, items, eventsBy]);
  const min = Math.min(now - 7 * DAY, ...rows.map((r) => r.start));
  const max = Math.max(now + 7 * DAY, ...rows.map((r) => Math.max(r.pred?.p80 ?? 0, r.order?.promisedDeliveryAt ?? 0))) + 2 * DAY;
  const pct = (t: number) => `${((Math.min(Math.max(t, min), max) - min) / (max - min)) * 100}%`;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / (7 * DAY)) * 7 * DAY; t < max; t += 7 * DAY) ticks.push(t);
  return (
    <div className="page">
      <h1>Timeline</h1>
      <p className="sub">Every in-transit parcel, sorted by expected arrival. Bar = elapsed, shaded = your P50–P80 window, <span style={{ color: 'var(--warn)' }}>▍</span> = AliExpress's promise.</p>
      {!rows.length && <div className="empty">Nothing in transit.</div>}
      <div className="bars">
        {rows.map(({ p, pred, order, start, title, img }) => (
          <div className="bar" key={p.parcelId} onClick={() => onSelect(p.parcelId)}>
            <div className="row" style={{ gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>{img ? <img className="thumb" src={img} alt="" loading="lazy" /> : <span className="thumb ph">▣</span>}<div style={{ minWidth: 0 }}><div className="name" title={title}>{title}</div><div className="row" style={{ gap: 6, marginTop: 4 }}>{stateTag(p)}<span className="muted" style={{ fontSize: 11 }}>{p.logisticsService ?? ''}</span></div></div></div>
            <div className="track">
              <div className="el" style={{ width: pct(Math.min(now, pred?.p50 ?? now)) , left: pct(start), position: 'absolute' }} />
              <div className="el" style={{ left: pct(start), width: `calc(${pct(now)} - ${pct(start)})` }} />
              {pred && <div className="win" style={{ left: pct(pred.p50), width: `calc(${pct(pred.p80)} - ${pct(pred.p50)})` }} title={`P50 ${fmtDate(pred.p50)} · P80 ${fmtDate(pred.p80)}`} />}
              {order?.promisedDeliveryAt && <div className="promise" style={{ left: pct(order.promisedDeliveryAt) }} title={`AliExpress: ${fmtDate(order.promisedDeliveryAt)}`} />}
              <div className="today" style={{ left: pct(now) }} />
            </div>
            <div style={{ textAlign: 'right' }}>{pred ? <><div style={{ fontWeight: 600 }}>{fmtDate(pred.p50)}</div><div className="muted" style={{ fontSize: 11 }}>to {fmtDate(pred.p80)}</div></> : <span className="muted">no estimate</span>}</div>
          </div>
        ))}
      </div>
      {rows.length > 0 && <div className="axis" style={{ marginTop: 10 }}>{ticks.map((t) => <span key={t} style={{ left: pct(t) }}>{fmtDate(t)}</span>)}</div>}
    </div>
  );
}
