import { useEffect, useMemo, useState } from 'react';
import { HARVESTER, type CapturedItem } from '@/adapters/pageCapture';
import { PLATFORM_LABEL, type Platform } from '@/model/types';
import { detectCarrier } from '@/engine/carriers';
import { bg } from '../dashboard/lib/bg';
import { db } from '@/db/schema';

type Phase = 'reading' | 'ready' | 'saving' | 'saved' | 'error';

/**
 * The toolbar popup: read whatever the page in front of you is selling (or shipping), let you
 * correct it, and store it. Works on any site — AliExpress is the only one synced automatically.
 */
export function Popup() {
  const [phase, setPhase] = useState<Phase>('reading');
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<CapturedItem | null>(null);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [tracking, setTracking] = useState('');
  const [platform, setPlatform] = useState<Platform>('other');
  const [found, setFound] = useState<string[]>([]);

  useEffect(() => { void (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('no active tab');
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: HARVESTER });
      const harvest = res?.result;
      if (!harvest) throw new Error('could not read this page');
      const r = await bg({ type: 'PARSE_PAGE', harvest });
      if (!r.ok) throw new Error((r as { error: string }).error);
      const it = (r as unknown as { item: CapturedItem }).item;
      setItem(it);
      setTitle(it.title ?? '');
      setPrice(it.price != null ? String(it.price) : '');
      setCurrency(it.currency ?? 'USD');
      setPlatform(it.platform);
      setFound(it.trackingNumbers);
      setTracking(it.trackingNumbers[0] ?? '');
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  })(); }, []);

  const carrier = useMemo(() => (tracking.trim() ? detectCarrier(tracking) : null), [tracking]);

  const save = async () => {
    setPhase('saving');
    const r = await bg({ type: 'ADD_PARCEL', input: {
      trackingNo: tracking.trim() || null,
      title: title.trim() || null,
      platform,
      price: price.trim() ? Number(price.replace(/[^\d.]/g, '')) : null,
      currency,
      imageUrl: item?.imageUrl ?? null,
      sourceUrl: item?.sourceUrl ?? null,
      orderId: item?.orderId ?? null,
    } });
    if (!r.ok) { setError((r as { error: string }).error); setPhase('error'); return; }
    setPhase('saved');
  };

  const openDashboard = () => { void bg({ type: 'OPEN_DASHBOARD' }); window.close(); };

  // Match the dashboard's theme so the popup doesn't look like a different product.
  useEffect(() => { void db.getSettings().then((s) => {
    document.documentElement.dataset.theme = s.theme ?? 'dark';
    document.documentElement.style.setProperty('--accent', s.accent || '#6ea8ff');
  }); }, []);

  if (phase === 'reading') return <div className="pop"><h1><span className="spin" /> Reading this page…</h1></div>;

  if (phase === 'error') return (
    <div className="pop">
      <h1>Couldn't read this page</h1>
      <div className="note">{error}</div>
      <div className="note">Chrome blocks extensions on its own pages and the Web Store. Try a normal shopping page.</div>
      <div className="foot"><button className="btn sm" onClick={openDashboard}>Open dashboard</button></div>
    </div>
  );

  if (phase === 'saved') return (
    <div className="pop">
      <h1><span className="ok">✓</span> Saved</h1>
      <div className="note">{tracking.trim() ? `Tracking ${tracking.trim()} via ${carrier?.carrier.name}.` : 'Added to your spend.'}</div>
      <div className="foot">
        <button className="btn primary sm" onClick={openDashboard}>Open dashboard</button>
        <button className="btn sm" onClick={() => window.close()}>Close</button>
      </div>
    </div>
  );

  return (
    <div className="pop">
      <h1>Capture from this page</h1>
      <div className="hero">
        {item?.imageUrl ? <img src={item.imageUrl} alt="" /> : <div className="ph">▣</div>}
        <label className="f" style={{ flex: 1 }}>Item
          <textarea value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is it?" />
        </label>
      </div>
      <div className="row2">
        <label className="f">Price
          <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" inputMode="decimal" />
        </label>
        <label className="f">Currency
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} />
        </label>
      </div>
      <label className="f">Store
        <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
          {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
        </select>
      </label>
      <label className="f">Tracking number <span className="muted">(optional)</span>
        <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Paste one, or leave blank" />
      </label>
      {found.length > 1 && (
        <div className="row" style={{ gap: 6 }}>
          {found.slice(0, 4).map((t) => <button key={t} className={`btn sm ${t === tracking ? 'primary' : ''}`} onClick={() => setTracking(t)}>{t.slice(0, 14)}…</button>)}
        </div>
      )}
      <div className="note">
        {tracking.trim()
          ? <>Carrier: <strong>{carrier?.carrier.name}</strong>{carrier?.carrier.pollable ? ' — scans will update automatically.' : ' — stored with a link to their tracking page; scans are not fetched.'}</>
          : found.length === 0 ? 'No tracking number found on this page. You can still save it to track the spend.' : ''}
      </div>
      <div className="foot">
        <button className="btn primary sm" onClick={() => void save()} disabled={phase === 'saving' || (!title.trim() && !tracking.trim())}>
          {phase === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button className="btn sm" onClick={openDashboard}>Dashboard</button>
      </div>
    </div>
  );
}
