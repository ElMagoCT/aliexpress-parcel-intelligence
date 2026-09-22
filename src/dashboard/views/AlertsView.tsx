import { db } from '@/db/schema';
import { useAlerts, useOrdersById, useParcels, isActive } from '../lib/useData';
import { disputeWindow } from '@/engine/dispute';
import { fmtDate, fmtDateTime } from '@/shared/util';

export function AlertsView({ onSelect }: { onSelect: (id: string) => void }) {
  const alerts = useAlerts();
  const parcels = useParcels();
  const orders = useOrdersById();
  const open = alerts.filter((a) => !a.dismissed);
  const countdowns = parcels.filter(isActive).map((p) => ({ p, order: p.orderIds.map((id) => orders.get(id)).find(Boolean) })).map((x) => ({ ...x, dw: disputeWindow(x.order, x.p) })).filter((x) => x.dw).sort((a, b) => a.dw!.daysLeft - b.dw!.daysLeft).slice(0, 8);
  return (
    <div className="page">
      <h1>Alerts</h1>
      <p className="sub">Stalls, exceptions, late parcels and buyer-protection deadlines.</p>
      <div className="split">
        <div>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}><strong>Open alerts ({open.length})</strong>{open.length > 0 && <button className="btn sm" onClick={() => void db.alerts.where('dismissed').equals(0).modify({ dismissed: true }).catch(() => Promise.all(open.map((a) => db.alerts.update(a.alertId, { dismissed: true }))))}>Dismiss all</button>}</div>
          {!open.length && <div className="empty">All quiet.</div>}
          {open.map((a) => (
            <div className={`alert ${a.severity}`} key={a.alertId}>
              <div className="sev" />
              <div onClick={() => a.parcelId && onSelect(a.parcelId)} style={{ cursor: a.parcelId ? 'pointer' : 'default' }}>
                <div style={{ fontWeight: 600 }}>{a.title}</div>
                <div className="muted" style={{ fontSize: 12 }}>{a.body}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{fmtDateTime(a.createdAt)}</div>
              </div>
              <button className="btn sm" onClick={() => void db.alerts.update(a.alertId, { dismissed: true })}>Dismiss</button>
            </div>
          ))}
        </div>
        <div>
          <strong>Buyer protection countdown</strong>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Days left to open a dispute, soonest first.</div>
          {!countdowns.length && <div className="empty">No open orders with a deadline.</div>}
          {countdowns.map(({ p, order, dw }) => (
            <div className="card" key={p.parcelId} style={{ marginBottom: 8, cursor: 'pointer', borderColor: dw!.urgency === 'urgent' ? 'rgba(248,113,113,.5)' : dw!.urgency === 'soon' ? 'rgba(251,191,36,.4)' : undefined }} onClick={() => onSelect(p.parcelId)}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div><div style={{ fontWeight: 600 }}>{order?.sellerName ?? p.logisticsService ?? p.trackingNo}</div><div className="muted" style={{ fontSize: 12 }}>Order {order?.orderId} · ends {fmtDate(dw!.deadline)}{dw!.estimated ? ' (est.)' : ''}</div></div>
                <div className={`countdown ${dw!.urgency}`}>{Math.max(0, Math.floor(dw!.daysLeft))}d</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
