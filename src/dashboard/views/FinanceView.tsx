import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useItems, useJobs, useOrders, useRefunds, useSettings } from '../lib/useData';
import { convert, ratesFor } from '../lib/money';
import { inferCategory } from '@/engine/categories';
import { fmtMoney } from '@/shared/util';
import { bg, inExtension, requestOrigin } from '../lib/bg';
import { db } from '@/db/schema';

function download(name: string, text: string, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const csvEscape = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

const RATES_ORIGIN = 'https://open.er-api.com/*';
const JOB_LABEL: Record<string, string> = { details: 'Shipping & fees', refunds: 'Refunds', tracking: 'Tracking', sync: 'Sync' };

export function FinanceView() {
  const orders = useOrders();
  const items = useItems();
  const settings = useSettings();
  const cur = settings.displayCurrency;
  const real = useMemo(() => orders.filter((o) => o.status !== 'CLOSED' && o.status !== 'AWAITING_PAYMENT'), [orders]);
  const refundRows = useRefunds();
  const refunded = useMemo(() => orders.filter((o) => o.status === 'REFUNDED' || (o.refundAmount ?? 0) > 0), [orders]);
  const cancelled = useMemo(() => orders.filter((o) => o.status === 'CLOSED'), [orders]);
  const conv = (amt: number | null | undefined, from: string) => convert(amt, from, settings) ?? 0;
  const total = real.reduce((s, o) => s + conv(o.orderTotal, o.currency), 0);
  const refundedAmt = refunded.reduce((s, o) => s + conv(o.refundAmount ?? o.orderTotal, o.currency), 0);
  const refundAssumed = refunded.filter((o) => o.refundAmount == null).length;
  const casesPending = refundRows.filter((r) => r.refundAmount == null).length;
  const reasons = useMemo(() => { const m = new Map<string, number>(); for (const r of refundRows) { const k = r.reason ?? 'unknown reason'; m.set(k, (m.get(k) ?? 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); }, [refundRows]);
  const jobs = useJobs();
  const [status, setStatus] = useState<string | null>(null);
  const running = Object.values(jobs).filter((j) => j.state === 'running');
  const priced = real.filter((o) => o.pricingDetailed).length;
  const trips = useMemo(() => {
    const m = new Map<string, typeof real>();
    for (const o of real) { const k = o.checkoutGroup ?? `solo_${o.orderId}`; const arr = m.get(k) ?? []; arr.push(o); m.set(k, arr); }
    return [...m.entries()].map(([key, os]) => ({
      key, orders: os,
      placedAt: Math.min(...os.map((o) => o.placedAt ?? Number.MAX_SAFE_INTEGER)),
      total: os.reduce((x, o) => x + conv(o.orderTotal, o.currency), 0),
      shipping: os.reduce((x, o) => x + conv(o.shippingCost, o.currency), 0),
      sellers: new Set(os.map((o) => o.sellerName ?? '?')).size,
      items: items.filter((i) => os.some((o) => o.orderId === i.orderId)).reduce((x, i) => x + i.qty, 0),
    })).sort((a, b) => b.placedAt - a.placedAt);
  }, [real, items, settings]);
  const multiTrips = trips.filter((t) => t.orders.length > 1);
  const cancelledAmt = cancelled.reduce((s, o) => s + conv(o.orderTotal, o.currency), 0);
  const net = total - refundedAmt;
  const shipping = real.reduce((s, o) => s + conv(o.shippingCost, o.currency), 0);
  const unconverted = real.filter((o) => o.orderTotal != null && convert(o.orderTotal, o.currency, settings) == null).length;
  const rateInfo = ratesFor(settings);
  const currencies = new Set(real.map((o) => o.currency));
  const byMonth = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of real) { if (!o.placedAt) continue; const k = new Date(o.placedAt).toISOString().slice(0, 7); m.set(k, (m.get(k) ?? 0) + conv(o.orderTotal, o.currency)); }
    return [...m.entries()].sort().map(([month, spend]) => ({ month, spend: +spend.toFixed(2) }));
  }, [real, settings]);
  const bySeller = useMemo(() => { const m = new Map<string, { n: number; spend: number }>(); for (const o of real) { const k = o.sellerName ?? 'Unknown seller'; const v = m.get(k) ?? { n: 0, spend: 0 }; v.n++; v.spend += conv(o.orderTotal, o.currency); m.set(k, v); } return [...m.entries()].sort((a, b) => b[1].spend - a[1].spend).slice(0, 12); }, [real, settings]);
  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    const orderCur = new Map(orders.map((o) => [o.orderId, o.currency]));
    for (const it of items) { const c = inferCategory(it.title); m.set(c, (m.get(c) ?? 0) + conv((it.unitPrice ?? 0) * it.qty, it.currency ?? orderCur.get(it.orderId) ?? 'USD')); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items, orders, settings]);
  const aov = real.length ? total / real.length : 0;

  const startJob = (type: 'SYNC_DETAILS' | 'SYNC_REFUNDS', msg: string) => {
    if (!inExtension) { setStatus('Preview mode — this needs the installed extension.'); return; }
    setStatus(msg);
    void bg({ type }).then((r) => {
      if (!r.ok) { setStatus(`Failed: ${(r as { error: string }).error}`); return; }
      if ((r as { alreadyRunning?: boolean }).alreadyRunning) setStatus('Already running — progress below.');
    });
  };
  const doRates = () => {
    if (!inExtension) { setStatus('Preview mode — this needs the installed extension.'); return; }
    setStatus('Asking Chrome for access to the exchange-rate service…');
    void requestOrigin(RATES_ORIGIN).then(async (granted) => {
      if (!granted) { setStatus('Access declined, so rates cannot be fetched. Currencies stay unconverted.'); return; }
      setStatus('Fetching rates…');
      const r = await bg({ type: 'REFRESH_RATES' });
      const rates = r.ok ? (r as { rates?: Record<string, number> | null }).rates : null;
      setStatus(rates ? `Rates updated — ${Object.keys(rates).length} currencies.` : 'Rate service did not return anything. Try again in a minute.');
    });
  };
  const exportCsv = () => {
    const head = ['orderId', 'placedAt', 'seller', 'status', 'rawStatus', 'currency', 'itemsSubtotal', 'shipping', 'discount', 'tax', 'total', `total_${cur}`, 'refunded', 'trackingNos', 'items'];
    const rows = orders.map((o) => [o.orderId, o.placedAt ? new Date(o.placedAt).toISOString() : '', o.sellerName, o.status, o.rawStatus, o.currency, o.itemsSubtotal, o.shippingCost, o.discount, o.tax, o.orderTotal, convert(o.orderTotal, o.currency, settings)?.toFixed(2) ?? '', o.status === 'REFUNDED' ? (o.refundAmount ?? o.orderTotal) : '', o.trackingNos.join(' '), items.filter((i) => i.orderId === o.orderId).map((i) => `${i.qty}x ${i.title}`).join(' | ')]);
    download(`aliexpress-orders-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n'), 'text/csv');
  };
  const exportJson = async () => {
    const dump = { exportedAt: new Date().toISOString(), orders, items, parcels: await db.parcels.toArray(), events: await db.events.toArray() };
    download(`aliexpress-data-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(dump));
  };

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h1>Finance</h1><p className="sub">Lifetime AliExpress spend in {cur}{currencies.size > 1 ? ` · ${currencies.size} currencies converted` : ''} · {rateInfo.live ? `live rates from ${rateInfo.asOf}` : `bundled rates from ${rateInfo.asOf}`}{unconverted ? ` · ${unconverted} in an unknown currency` : ''}</p></div>
        <div className="row"><button className="btn sm" onClick={exportCsv}>Export CSV</button><button className="btn sm" onClick={() => void exportJson()}>Export JSON</button><button className="btn sm" onClick={doRates}>Refresh rates</button><button className="btn sm" onClick={() => startJob('SYNC_DETAILS', 'Fetching shipping and fees, one request per order…')} title="Reads each order's price breakdown — the order list has no shipping line">Fetch shipping &amp; fees</button><button className="btn sm" onClick={() => startJob('SYNC_REFUNDS', 'Fetching returns and refunds…')}>Fetch refunds</button></div>
      </div>
      {(status || running.length > 0) && (
        <div className="card" style={{ margin: '0 0 14px', borderColor: running.length ? 'rgba(110,168,255,.45)' : undefined }}>
          {running.map((j) => <div key={j.name} className="row" style={{ gap: 10 }}><span className="spin" />{JOB_LABEL[j.name] ?? j.name}: {j.progress || 'starting…'}</div>)}
          {status && <div className={running.length ? 'muted' : ''} style={{ fontSize: running.length ? 12 : 14, marginTop: running.length ? 6 : 0 }}>{status}</div>}
          {Object.values(jobs).filter((j) => j.state === 'error').map((j) => <div key={j.name} style={{ color: 'var(--warn)', fontSize: 13, marginTop: 6 }}>{JOB_LABEL[j.name] ?? j.name} stopped: {j.error}</div>)}
          {Object.values(jobs).filter((j) => j.state === 'done' && !running.length).map((j) => <div key={j.name} className="muted" style={{ fontSize: 12, marginTop: 4 }}>{JOB_LABEL[j.name] ?? j.name} finished: {j.progress}</div>)}
        </div>
      )}
      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <div className="card kpi"><div className="l">Net spend</div><div className="v">{fmtMoney(net, cur)}</div><div className="muted" style={{ fontSize: 12 }}>{fmtMoney(total, cur)} paid − {fmtMoney(refundedAmt, cur)} refunded</div></div>
        <div className="card kpi"><div className="l">Orders</div><div className="v">{real.length}</div><div className="muted" style={{ fontSize: 12 }}>{cancelled.length} cancelled, not counted</div></div>
        <div className="card kpi" style={{ borderColor: refunded.length ? 'rgba(52,211,153,.35)' : undefined }}><div className="l">Refunded</div><div className="v">{fmtMoney(refundedAmt, cur)}</div><div className="muted" style={{ fontSize: 12 }}>{refunded.length} order{refunded.length === 1 ? '' : 's'} · {refundRows.length} case{refundRows.length === 1 ? '' : 's'} · {real.length ? ((refunded.length / real.length) * 100).toFixed(1) : '0'}% of orders{refundAssumed ? ` · ${refundAssumed} assumed full` : ''}{casesPending ? ` · ${casesPending} amounts pending` : ''}</div></div>
        <div className="card kpi"><div className="l">Average order</div><div className="v">{fmtMoney(aov, cur)}</div></div>
        <div className="card kpi"><div className="l">Shipping share</div><div className="v">{priced ? (total ? `${((shipping / total) * 100).toFixed(1)}%` : '—') : '—'}</div><div className="muted" style={{ fontSize: 12 }}>{priced ? `${fmtMoney(shipping, cur)} across ${priced} priced order${priced === 1 ? '' : 's'}` : 'Not known yet — the order list has no shipping line. Click “Fetch shipping & fees”.'}</div></div>
        <div className="card kpi"><div className="l">Checkouts</div><div className="v">{trips.length}</div><div className="muted" style={{ fontSize: 12 }}>{multiTrips.length} with several orders at once</div></div>
        <div className="card kpi"><div className="l">Items</div><div className="v">{items.reduce((s, i) => s + i.qty, 0)}</div></div>
      </div>
      <div className="card" style={{ height: 300, marginBottom: 14 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>SPEND BY MONTH</div>
        {byMonth.length ? (
          <ResponsiveContainer width="100%" height="88%">
            <BarChart data={byMonth} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: '#8b93b8', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#8b93b8', fontSize: 11 }} axisLine={false} tickLine={false} width={56} tickFormatter={(v: number) => fmtMoney(v, cur).replace(/\.\d+$/, '')} />
              <Tooltip contentStyle={{ background: '#151d3a', border: '1px solid #263159', borderRadius: 10 }} formatter={(v) => fmtMoney(Number(v), cur)} cursor={{ fill: 'rgba(110,168,255,.08)' }} />
              <Bar dataKey="spend" fill="#6ea8ff" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <div className="empty">No dated orders yet.</div>}
      </div>
      {(refunded.length > 0 || cancelled.length > 0 || refundRows.length > 0) && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>REFUNDS & CANCELLATIONS</div>
          <table><thead><tr><th>Placed</th><th>Order</th><th>Seller</th><th>Status</th><th className="num">Paid</th><th className="num">Refunded</th></tr></thead><tbody>
            {[...refunded, ...cancelled].sort((a, b) => (b.placedAt ?? 0) - (a.placedAt ?? 0)).map((o) => (
              <tr key={o.orderId}><td style={{ whiteSpace: 'nowrap' }}>{o.placedAt ? new Date(o.placedAt).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : '—'}</td><td className="mono">{o.orderId}</td><td>{o.sellerName ?? '—'}</td><td><span className={`tag ${o.status === 'REFUNDED' ? 'ok' : ''}`}>{o.rawStatus ?? o.status.toLowerCase()}</span></td><td className="num">{o.status === 'CLOSED' ? <span className="muted">{fmtMoney(o.orderTotal, o.currency)} · not charged</span> : fmtMoney(o.orderTotal, o.currency)}</td><td className="num">{o.status === 'REFUNDED' ? <>{fmtMoney(o.refundAmount ?? o.orderTotal, o.currency)}{o.refundAmount == null && <span className="muted"> (assumed)</span>}</> : '—'}</td></tr>
            ))}
          </tbody></table>
          {cancelled.length > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Cancelled orders total {fmtMoney(cancelledAmt, cur)} and are excluded from every figure above.</div>}
          {reasons.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Return reasons: {reasons.map(([r, n]) => `${r} (${n})`).join(' · ')}</div>}
        </div>
      )}
      {multiTrips.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>ORDERED AT THE SAME TIME</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>AliExpress splits one cart into a separate order per seller. These were paid together.</div>
          <table><thead><tr><th>Placed</th><th className="num">Orders</th><th className="num">Sellers</th><th className="num">Items</th><th className="num">Total</th><th className="num">Shipping</th></tr></thead><tbody>
            {multiTrips.slice(0, 12).map((t) => (
              <tr key={t.key}>
                <td style={{ whiteSpace: 'nowrap' }}>{t.placedAt < Number.MAX_SAFE_INTEGER ? new Date(t.placedAt).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : '—'}</td>
                <td className="num">{t.orders.length}</td><td className="num">{t.sellers}</td><td className="num">{t.items}</td>
                <td className="num">{fmtMoney(t.total, cur)}</td>
                <td className="num">{t.orders.some((o) => o.pricingDetailed) ? fmtMoney(t.shipping, cur) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      <div className="split">
        <div className="card">
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>TOP SELLERS</div>
          <table><tbody>{bySeller.map(([s, v]) => <tr key={s}><td>{s}</td><td className="num muted">{v.n} orders</td><td className="num">{fmtMoney(v.spend, cur)}</td></tr>)}</tbody></table>
        </div>
        <div className="card">
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>SPEND BY INFERRED CATEGORY</div>
          <table><tbody>{byCategory.map(([c, v]) => <tr key={c}><td>{c}</td><td className="num">{fmtMoney(v, cur)}</td><td style={{ width: '40%' }}><div className="band" style={{ margin: 0 }}><div className="fill" style={{ left: 0, width: `${(v / (byCategory[0]?.[1] || 1)) * 100}%` }} /></div></td></tr>)}</tbody></table>
        </div>
      </div>
    </div>
  );
}
