import { useMemo, useState } from 'react';
import { useItems, useOrders, useParcels, useSettings } from '../lib/useData';
import { stateTag } from '../components/ParcelPanel';
import { fmtAgo, fmtDate, fmtDateTime, fmtMoney } from '@/shared/util';
import { PLATFORM_LABEL, type Platform } from '@/model/types';
import { convert } from '../lib/money';

/** AliExpress usually sends a human label ("Awaiting delivery"); fall back when it sends a code. */
function prettyStatus(o: { rawStatus: string | null; status: string }): string {
  const raw = o.rawStatus?.trim();
  if (raw && !/^[A-Z][A-Z0-9_]{3,}$/.test(raw)) return raw;
  return o.status.toLowerCase().replace(/_/g, ' ');
}

type Key = 'placedAt' | 'sellerName' | 'orderTotal' | 'status' | 'items' | 'updatedAt';

export function OrdersView({ onSelect }: { onSelect: (id: string) => void }) {
  const orders = useOrders();
  const items = useItems();
  const parcels = useParcels();
  const settings = useSettings();
  const [sort, setSort] = useState<{ k: Key; d: 1 | -1 }>({ k: 'placedAt', d: -1 });
  const [q, setQ] = useState('');
  const [flt, setFlt] = useState<'all' | 'SHIPPED' | 'COMPLETED' | 'REFUNDED' | 'CLOSED'>('all');
  const [trip, setTrip] = useState<string | null>(null);
  const [plat, setPlat] = useState<'all' | Platform>('all');
  const tripSizes = useMemo(() => { const m = new Map<string, number>(); for (const o of orders) if (o.checkoutGroup) m.set(o.checkoutGroup, (m.get(o.checkoutGroup) ?? 0) + 1); return m; }, [orders]);
  const itemsBy = useMemo(() => { const m = new Map<string, typeof items>(); for (const i of items) (m.get(i.orderId) ?? m.set(i.orderId, []).get(i.orderId)!).push(i); return m; }, [items]);
  const parcelsBy = useMemo(() => { const m = new Map<string, typeof parcels>(); for (const p of parcels) for (const o of p.orderIds) (m.get(o) ?? m.set(o, []).get(o)!).push(p); return m; }, [parcels]);
  const rows = useMemo(() => {
    const f = q.toLowerCase();
    return orders.filter((o) => plat === 'all' || (o.platform ?? 'other') === plat).filter((o) => !trip || o.checkoutGroup === trip).filter((o) => flt === 'all' || o.status === flt).filter((o) => !f || o.orderId.includes(f) || o.sellerName?.toLowerCase().includes(f) || (itemsBy.get(o.orderId) ?? []).some((i) => i.title.toLowerCase().includes(f)))
      .sort((a, b) => {
        const va = sort.k === 'items' ? (itemsBy.get(a.orderId)?.length ?? 0) : sort.k === 'orderTotal' ? convert(a.orderTotal, a.currency, settings) ?? -1 : (a[sort.k] ?? '');
        const vb = sort.k === 'items' ? (itemsBy.get(b.orderId)?.length ?? 0) : sort.k === 'orderTotal' ? convert(b.orderTotal, b.currency, settings) ?? -1 : (b[sort.k] ?? '');
        return (va < vb ? -1 : va > vb ? 1 : 0) * sort.d;
      });
  }, [orders, q, flt, trip, plat, sort, itemsBy, settings]);
  const th = (k: Key, label: string, num = false) => <th className={`${num ? 'num' : ''} ${sort.k === k ? 'active' : ''}`} onClick={() => setSort((s) => ({ k, d: s.k === k ? (s.d === 1 ? -1 : 1) : -1 }))}>{label}{sort.k === k ? (sort.d === 1 ? ' ↑' : ' ↓') : ''}</th>;
  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between' }}><div><h1>Orders</h1><p className="sub">{orders.length} orders · split shipments are shown as multiple parcels per row.</p></div><input placeholder="Search seller, item, order id…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 280 }} /></div>
      {new Set(orders.map((o) => o.platform ?? 'other')).size > 1 && (
        <div className="row" style={{ marginBottom: 8, gap: 6 }}>
          <button className={`btn sm ${plat === 'all' ? 'primary' : ''}`} onClick={() => setPlat('all')}>All stores</button>
          {[...new Set(orders.map((o) => o.platform ?? 'other'))].map((pf) => (
            <button key={pf} className={`btn sm ${plat === pf ? 'primary' : ''}`} onClick={() => setPlat(pf)}>{PLATFORM_LABEL[pf]} <span style={{ opacity: .7 }}>{orders.filter((o) => (o.platform ?? 'other') === pf).length}</span></button>
          ))}
        </div>
      )}
      <div className="row" style={{ marginBottom: 10, gap: 6 }}>{([['all', 'All'], ['SHIPPED', 'In transit'], ['COMPLETED', 'Completed'], ['REFUNDED', 'Refunded / returned'], ['CLOSED', 'Cancelled']] as const).map(([k, l]) => <button key={k} className={`btn sm ${flt === k ? 'primary' : ''}`} onClick={() => setFlt(k)}>{l} <span style={{ opacity: .7 }}>{k === 'all' ? orders.length : orders.filter((o) => o.status === k).length}</span></button>)}</div>
      {trip && <div className="card" style={{ marginBottom: 10, borderColor: 'rgba(110,168,255,.45)' }}><div className="row" style={{ justifyContent: 'space-between' }}><span>Showing one checkout &middot; {tripSizes.get(trip)} orders paid together</span><button className="btn sm" onClick={() => setTrip(null)}>Show all orders</button></div></div>}
      {!orders.length && <div className="empty">No orders yet. Run Backfill, or just browse your AliExpress orders page — data flows in automatically.</div>}
      {orders.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table>
            <thead><tr>{th('placedAt', 'Placed')}<th>Order</th>{th('sellerName', 'Seller')}<th>Items</th><th>Parcels</th>{th('status', 'Status')}{th('orderTotal', `Total (${settings.displayCurrency})`, true)}{th('updatedAt', 'Updated')}</tr></thead>
            <tbody>
              {rows.map((o) => {
                const its = itemsBy.get(o.orderId) ?? [];
                const ps = parcelsBy.get(o.orderId) ?? [];
                const conv = convert(o.orderTotal, o.currency, settings);
                return (
                  <tr key={o.orderId}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(o.placedAt, { year: '2-digit', month: 'short', day: 'numeric' })}</td>
                    <td className="mono">{o.orderId}{o.checkoutGroup && (tripSizes.get(o.checkoutGroup) ?? 0) > 1 && <div><span className="tag" style={{ cursor: 'pointer', marginTop: 4 }} title="Paid together in one checkout" onClick={(e) => { e.stopPropagation(); setTrip(o.checkoutGroup); }}>1 of {tripSizes.get(o.checkoutGroup)} ordered together</span></div>}</td>
                    <td>{o.sellerName ?? <span className="muted">—</span>}{(o.platform ?? 'aliexpress') !== 'aliexpress' && <div><span className="tag info" style={{ marginTop: 4 }}>{PLATFORM_LABEL[o.platform ?? 'other']}</span></div>}</td>
                    <td title={its.map((i) => `${i.qty}× ${i.title}`).join('\n')}><div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><div className="thumbs">{its.slice(0, 3).map((i) => i.imageUrl ? <img key={i.itemId} src={i.imageUrl} alt="" loading="lazy" /> : <span key={i.itemId} className="ph">▣</span>)}{its.length > 3 && <span className="more">+{its.length - 3}</span>}</div><div className="muted" style={{ fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{its[0]?.title}</div></div></td>
                    <td>{ps.length ? <div className="row" style={{ gap: 6 }}>{ps.map((p) => <span key={p.parcelId} style={{ cursor: 'pointer' }} onClick={() => onSelect(p.parcelId)}>{stateTag(p)}</span>)}{ps.length > 1 && <span className="tag warn">split ×{ps.length}</span>}</div> : <span className="muted">—</span>}</td>
                    <td><span className={`tag ${o.status === 'REFUNDED' ? 'ok' : o.status === 'CLOSED' ? 'bad' : ''}`}>{prettyStatus(o)}</span>{o.status === 'REFUNDED' && <div className="muted" style={{ fontSize: 11 }}>refunded {fmtMoney(o.refundAmount ?? o.orderTotal, o.currency)}{o.refundAmount == null ? ' (assumed)' : ''}</div>}</td>
                    <td className="num" title={`${fmtMoney(o.itemsSubtotal, o.currency)} items + ${fmtMoney(o.shippingCost, o.currency)} shipping − ${fmtMoney(o.discount, o.currency)} discount + ${fmtMoney(o.tax, o.currency)} tax`}>{conv != null ? fmtMoney(conv, settings.displayCurrency) : fmtMoney(o.orderTotal, o.currency)}<div className="muted" style={{ fontSize: 11 }}>{o.currency !== settings.displayCurrency ? fmtMoney(o.orderTotal, o.currency) : `ship ${fmtMoney(o.shippingCost ?? 0, o.currency)}`}</div></td>
                    <td className="muted" style={{ whiteSpace: 'nowrap', fontSize: 12 }} title={`Last refreshed from AliExpress: ${fmtDateTime(o.updatedAt)}`}>{fmtAgo(o.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
