import { useEffect, useState } from 'react';
import type { BackfillState } from '@/model/types';
import { bg, inExtension } from '../lib/bg';
import { useOrders, useParcels, useEvents } from '../lib/useData';
import { ORDERS_PAGE_URL } from '@/adapters/aliexpress';
import { fmtDateTime } from '@/shared/util';

export function SetupView() {
  const [state, setState] = useState<BackfillState | null>(null);
  const orders = useOrders();
  const parcels = useParcels();
  const events = useEvents();
  const refresh = () => void bg({ type: 'BACKFILL_GET_STATE' }).then((r) => r.ok && setState((r as unknown as { state: BackfillState }).state));
  useEffect(() => { refresh(); const id = setInterval(refresh, 2000); return () => clearInterval(id); }, []);
  const start = async () => { const r = await bg({ type: 'BACKFILL_START' }); if (r.ok) setState((r as unknown as { state: BackfillState }).state); };
  const stop = async () => { const r = await bg({ type: 'BACKFILL_STOP' }); if (r.ok) setState((r as unknown as { state: BackfillState }).state); };
  const running = !!state?.active;
  const elapsedMin = state?.startedAt ? Math.round((Date.now() - state.startedAt) / 60000) : 0;
  const perPage = state && state.pagesFetched ? state.ordersFound / state.pagesFetched : 0;
  const remaining = state?.estimatedRemainingPages != null ? `${state.estimatedRemainingPages} pages` : running && perPage > 0 ? 'unknown — paginating until the list is exhausted' : '—';
  return (
    <div className="page">
      <h1>Backfill your full history</h1>
      <p className="sub">Opens your AliExpress orders page in a background tab and pages through everything at 1.5–3 s per page while the interceptor captures the JSON. Resumable; you can close the tab or Chrome and it will pick up where it left off.</p>
      <div className="steps" style={{ marginBottom: 16 }}>
        <div className="card step"><span className="no">1</span><h3>Be signed in</h3><p className="muted">Open <a href={ORDERS_PAGE_URL} target="_blank" rel="noreferrer">your orders page</a> once and make sure it loads without a login prompt. Read-only: the extension never posts anything.</p></div>
        <div className="card step"><span className="no">2</span><h3>Run the backfill</h3><p className="muted">Pages the order list until exhausted, then complements with direct fetches using the endpoint shapes it just learned.</p></div>
        <div className="card step"><span className="no">3</span><h3>Tracking trickle</h3><p className="muted">Then pulls Cainiao history for every parcel, oldest first, one every few seconds. Estimates improve as delivered history accumulates.</p></div>
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{running ? (state?.phase === 'tracking' ? 'Backfilling tracking history…' : 'Scanning orders…') : state?.phase === 'done' ? 'Backfill complete' : state?.phase === 'stopped' ? 'Stopped' : state?.phase === 'error' ? 'Paused after an error' : 'Not started'}</div>
            <div className="muted" style={{ fontSize: 12 }}>{state?.lastError ? `Note: ${state.lastError}` : running ? `Running for ${elapsedMin} min · keep Chrome open` : 'Takes a few minutes for a few hundred orders.'}</div>
          </div>
          <div className="row">
            {!running && <button className="btn primary" onClick={() => void start()} disabled={!inExtension}>{state?.phase === 'stopped' || state?.phase === 'error' ? 'Resume backfill' : 'Start backfill'}</button>}
            {running && <button className="btn danger" onClick={() => void stop()}>Stop</button>}
          </div>
        </div>
        <div className="grid kpis" style={{ marginTop: 16 }}>
          <div className="kpi"><div className="l">Pages fetched</div><div className="v">{state?.pagesFetched ?? 0}</div></div>
          <div className="kpi"><div className="l">Orders found this run</div><div className="v">{state?.ordersFound ?? 0}</div></div>
          <div className="kpi"><div className="l">Estimated remaining</div><div className="v" style={{ fontSize: 16 }}>{remaining}</div></div>
          <div className="kpi"><div className="l">Tracking backfilled</div><div className="v">{state?.trackingDone ?? 0}<span className="muted" style={{ fontSize: 14 }}> / {(state?.trackingDone ?? 0) + (state?.trackingQueued ?? 0)}</span></div></div>
        </div>
        <div className={`progress ${running && state?.phase === 'orders' ? 'indeterminate' : ''}`} style={{ marginTop: 14 }}>
          <div style={{ width: state?.phase === 'tracking' ? `${(100 * (state.trackingDone ?? 0)) / Math.max(1, (state.trackingDone ?? 0) + (state.trackingQueued ?? 0))}%` : state?.phase === 'done' ? '100%' : running ? undefined : '0%' }} />
        </div>
        {!inExtension && <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Preview mode: backfill needs the extension context.</div>}
      </div>
      <div className="grid kpis" style={{ marginTop: 16 }}>
        <div className="card kpi"><div className="l">Orders in library</div><div className="v">{orders.length}</div></div>
        <div className="card kpi"><div className="l">Parcels</div><div className="v">{parcels.length}</div><div className="muted" style={{ fontSize: 12 }}>{parcels.filter((p) => p.state === 'DELIVERED').length} delivered (training data)</div></div>
        <div className="card kpi"><div className="l">Scan events</div><div className="v">{events.length}</div><div className="muted" style={{ fontSize: 12 }}>{state?.updatedAt ? `updated ${fmtDateTime(state.updatedAt)}` : ''}</div></div>
      </div>
    </div>
  );
}
