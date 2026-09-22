import { useState } from 'react';
import type { Item, Order, Parcel, Prediction, TrackEvent } from '@/model/types';
import { MILESTONE_LABEL } from '@/model/types';
import { disputeWindow } from '@/engine/dispute';
import { fmtDate, fmtDateTime, DAY } from '@/shared/util';
import { CARRIERS, detectCarrier } from '@/engine/carriers';
import { PLATFORM_LABEL } from '@/model/types';
import { bg } from '../lib/bg';

export function stateTag(p: Parcel) {
  if (p.manualState) {
    const label = p.manualState === 'delivered' ? 'Delivered (by you)' : p.manualState === 'lost' ? 'Lost' : 'Closed';
    return <span className={`tag ${p.manualState === 'delivered' ? 'ok' : p.manualState === 'lost' ? 'bad' : ''}`}>{label}</span>;
  }
  const map: Record<Parcel['state'], [string, string]> = {
    PENDING: ['Awaiting first scan', 'info'], IN_TRANSIT: ['In transit', 'info'], DEST_COUNTRY: ['In your country', 'ok'], OUT_FOR_DELIVERY: ['Out for delivery', 'ok'],
    STALLED: ['Stalled', 'warn'], DELIVERED: ['Delivered', 'ok'], EXCEPTION: ['Exception', 'bad'], RETURNED: ['Returned', 'bad'], CLOSED: ['Closed', ''],
  };
  const [label, cls] = map[p.state];
  return <span className={`tag ${cls}`}>{label}</span>;
}

export function EtaBand({ pred, order, now = Date.now() }: { pred: Prediction | undefined; order: Order | undefined; now?: number }) {
  if (!pred) return null;
  const start = now, end = Math.max(pred.p95, order?.promisedDeliveryAt ?? 0, pred.p80) + DAY;
  const pct = (t: number) => `${Math.max(0, Math.min(100, ((t - start) / (end - start)) * 100))}%`;
  const diverges = order?.promisedDeliveryAt ? Math.abs(pred.p50 - order.promisedDeliveryAt) > 2 * DAY : false;
  return (
    <div className="eta">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><div className="muted" style={{ fontSize: 11 }}>YOUR ESTIMATE (P50 – P80)</div><div className="big">{fmtDate(pred.p50)} – {fmtDate(pred.p80)}</div></div>
        {order?.promisedDeliveryAt && <div style={{ textAlign: 'right' }}><div className="muted" style={{ fontSize: 11 }}>ALIEXPRESS SAYS</div><div style={{ fontWeight: 600, color: diverges ? 'var(--warn)' : 'inherit' }}>{fmtDate(order.promisedDeliveryAt)}</div></div>}
      </div>
      <div className="band">
        <div className="fill" style={{ left: pct(pred.p50), width: `calc(${pct(pred.p80)} - ${pct(pred.p50)})` }} />
        {order?.promisedDeliveryAt && <div className="mark" style={{ left: pct(order.promisedDeliveryAt) }} title="AliExpress promised date" />}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>{diverges ? (pred.p50 > (order!.promisedDeliveryAt ?? 0) ? 'Later than promised · ' : 'Earlier than promised · ') : ''}{pred.basis}</div>
    </div>
  );
}

export function ParcelPanel({ parcel, items, orders, events, pred, groupSize, onClose }: { parcel: Parcel; items: Item[]; orders: Order[]; events: TrackEvent[]; pred: Prediction | undefined; groupSize: number; onClose: () => void }) {
  const [explain, setExplain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const order = orders[0];
  const dw = disputeWindow(order, parcel);
  const doExplain = async () => { setBusy(true); const r = await bg({ type: 'EXPLAIN_PARCEL', parcelId: parcel.parcelId }); setExplain(r.ok ? String((r as { text?: string }).text ?? '') : `Error: ${(r as { error: string }).error}`); setBusy(false); };
  const poll = async () => { setBusy(true); await bg({ type: 'POLL_PARCEL', parcelId: parcel.parcelId }); setBusy(false); };
  const mark = async (state: 'delivered' | 'lost' | 'archived' | null) => { setBusy(true); await bg({ type: 'SET_PARCEL_STATE', parcelId: parcel.parcelId, state }); setBusy(false); };
  const carrier = CARRIERS[parcel.carrier ?? ''] ?? detectCarrier(parcel.trackingNo, parcel.logisticsService).carrier;
  return (
    <div className="panel">
      <button className="close" onClick={onClose}>×</button>
      <h2>{parcel.logisticsService ?? 'Parcel'}</h2>
      <div className="row" style={{ gap: 8 }}>
        {stateTag(parcel)}
        <span className="tag mono">{parcel.trackingNo}</span>
        {parcel.platform && parcel.platform !== 'aliexpress' && <span className="tag info">{PLATFORM_LABEL[parcel.platform]}</span>}
        {groupSize > 1 && <span className="tag warn">{groupSize} parcels moving as one</span>}
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{parcel.shipFromRegion ?? '?'} → {parcel.destCountry ?? 'you'} · shipped {fmtDate(parcel.shippedAt)}{parcel.deliveredAt ? ` · delivered ${fmtDate(parcel.deliveredAt)}` : ''}</div>
      <div className="items">
        {items.length ? items.map((it) => (
          <div className="item" key={it.itemId}>
            {it.imageUrl ? <img src={it.imageUrl} alt="" /> : <div className="ph">▣</div>}
            <div><div className="t">{it.title}</div><div className="muted" style={{ fontSize: 11 }}>{it.qty} × {it.unitPrice != null ? `${it.currency ?? ''} ${it.unitPrice}` : '—'}{it.sku ? ` · ${it.sku}` : ''}</div></div>
          </div>
        )) : <div className="muted">Items not captured yet — open the order on AliExpress once.</div>}
      </div>
      {orders.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{orders.length > 1 ? `${orders.length} orders in this parcel: ` : 'Order '}{orders.map((o) => o.orderId).join(', ')}{order?.sellerName ? ` · ${order.sellerName}` : ''}</div>}
      <EtaBand pred={pred} order={order} />
      {dw && (
        <div className="eta" style={{ borderLeft: `3px solid var(--${dw.urgency === 'urgent' ? 'bad' : dw.urgency === 'soon' ? 'warn' : 'info'})` }}>
          <div className="muted" style={{ fontSize: 11 }}>BUYER PROTECTION</div>
          <div className={`countdown ${dw.urgency}`}>{Math.max(0, Math.floor(dw.daysLeft))} days</div>
          <div className="muted" style={{ fontSize: 12 }}>to open a dispute · ends {fmtDate(dw.deadline)}{dw.estimated ? ' (estimated from ship date)' : ''}</div>
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={poll} disabled={busy}>Refresh tracking</button>
        <button className="btn sm" onClick={doExplain} disabled={busy}>Explain this parcel</button>
        <a className="btn sm" href={carrier.url(parcel.trackingNo)} target="_blank" rel="noreferrer">{carrier.name} ↗</a>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        {parcel.manualState ? (
          <button className="btn sm" onClick={() => void mark(null)} disabled={busy}>Undo “{parcel.manualState}” &amp; resume tracking</button>
        ) : (
          <>
            <button className="btn sm" onClick={() => void mark('delivered')} disabled={busy} title="For parcels that arrived but were never scanned as delivered">Mark delivered</button>
            <button className="btn sm" onClick={() => void mark('lost')} disabled={busy}>Mark lost</button>
            <button className="btn sm" onClick={() => void mark('archived')} disabled={busy} title="Stop tracking without claiming it arrived">Archive</button>
          </>
        )}
      </div>
      {parcel.manualState && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>You marked this {parcel.manualState} on {fmtDate(parcel.manualStateAt)}. It no longer polls, and a hand-set delivery date is kept out of the delivery estimates.</div>}
      {!carrier.pollable && !parcel.orderIds.length && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{carrier.name} scans can't be read automatically — use the link above.</div>}
      {explain && <div className="explain">{explain}</div>}
      <ul className="tl">
        {[...events].reverse().map((e) => (
          <li key={e.eventId} className={e.lat != null ? 'geo' : ''}>
            <div>{e.milestone ? <strong>{MILESTONE_LABEL[e.milestone]}</strong> : <span className="muted">Unclassified</span>}{e.locationText ? <span className="muted"> · {e.locationText}</span> : null}</div>
            <div>{e.rawText}</div>
            <div className="when">{fmtDateTime(e.timestamp)}</div>
          </li>
        ))}
        {!events.length && <li className="muted">No scans yet.</li>}
      </ul>
    </div>
  );
}
