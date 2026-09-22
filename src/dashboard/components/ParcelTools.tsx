import { useState } from 'react';
import type { Parcel, Platform } from '@/model/types';
import { PLATFORM_LABEL } from '@/model/types';
import { detectCarrier } from '@/engine/carriers';
import { isAbandoned } from '@/background/recompute';
import { bg } from '../lib/bg';

/**
 * Two things the parcel list needs that the map itself can't provide: a way to clear out parcels
 * the carrier abandoned (common with cheap untracked shipping), and a way to add a parcel from a
 * store the extension doesn't sync.
 */
export function ParcelTools({ parcels }: { parcels: Parcel[] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tn, setTn] = useState('');
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [platform, setPlatform] = useState<Platform>('other');

  const stale = parcels.filter((p) => isAbandoned(p));
  const carrier = tn.trim() ? detectCarrier(tn) : null;

  const closeStale = async (state: 'delivered' | 'archived') => {
    setBusy(true);
    const r = await bg({ type: 'CLOSE_ABANDONED', state });
    setBusy(false);
    const n = (r as { closed?: number }).closed ?? 0;
    setMsg(r.ok ? `${n} parcel${n === 1 ? '' : 's'} ${state === 'delivered' ? 'marked delivered' : 'archived'}.` : 'Could not update them.');
  };

  const add = async () => {
    setBusy(true);
    const r = await bg({ type: 'ADD_PARCEL', input: { trackingNo: tn.trim() || null, title: title.trim() || null, platform, price: price.trim() ? Number(price.replace(/[^\d.]/g, '')) : null } });
    setBusy(false);
    if (!r.ok) { setMsg((r as { error: string }).error); return; }
    setMsg('Added.');
    setTn(''); setTitle(''); setPrice('');
    setOpen(false);
  };

  return (
    <div className="ptools">
      {stale.length > 0 && (
        <div className="stale">
          <div><strong>{stale.length} parcel{stale.length === 1 ? '' : 's'} with no scan in over 45 days.</strong>
            <div className="muted" style={{ fontSize: 11 }}>Cheap shipping often stops scanning after dispatch. Close them so they leave the map and stop being counted as late.</div>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            <button className="btn sm" disabled={busy} onClick={() => void closeStale('delivered')}>All arrived</button>
            <button className="btn sm" disabled={busy} onClick={() => void closeStale('archived')}>Just archive</button>
          </div>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="btn sm" onClick={() => setOpen((v) => !v)}>{open ? 'Cancel' : '+ Add a parcel'}</button>
        {msg && <span className="muted" style={{ fontSize: 11 }}>{msg}</span>}
      </div>
      {open && (
        <div className="addform">
          <label className="f">Tracking number <span className="muted">(any carrier)</span>
            <input value={tn} onChange={(e) => setTn(e.target.value)} placeholder="1Z… / 94… / LP…" />
          </label>
          <label className="f">What is it?
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <label className="f" style={{ flex: 1 }}>Price
              <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" inputMode="decimal" />
            </label>
            <label className="f" style={{ flex: 1 }}>Store
              <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
                {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
              </select>
            </label>
          </div>
          {carrier && <div className="muted" style={{ fontSize: 11 }}>Looks like <strong>{carrier.carrier.name}</strong>{carrier.carrier.pollable ? ' — scans update automatically.' : ' — stored with a link to their tracking page.'}</div>}
          <button className="btn primary sm" disabled={busy || (!tn.trim() && !title.trim())} onClick={() => void add()}>Add</button>
        </div>
      )}
    </div>
  );
}
