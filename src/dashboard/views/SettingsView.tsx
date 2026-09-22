import { useEffect, useState } from 'react';
import { db } from '@/db/schema';
import { useSettings, useEvents } from '../lib/useData';
import { bg, hasOrigin, inExtension, requestOrigin } from '../lib/bg';
import { gazetteerLookup } from '@/background/geocode';
import { fmtAgo, fmtDateTime, todayKey } from '@/shared/util';
import type { CaptureLogEntry, EndpointRecord } from '@/model/types';

const NOMINATIM = 'https://nominatim.openstreetmap.org/*';
const ANTHROPIC = 'https://api.anthropic.com/*';
const RATES = 'https://open.er-api.com/*';

export function SettingsView() {
  const s = useSettings();
  const events = useEvents();
  const [key, setKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<{ hasKey: boolean; hint: string | null }>({ hasKey: false, hint: null });
  const [perm, setPerm] = useState({ nominatim: false, anthropic: false, rates: false });
  const [msg, setMsg] = useState<string | null>(null);
  const [home, setHome] = useState(s.homeAddress ?? '');
  const [endpoints, setEndpoints] = useState(0);
  const [diag, setDiag] = useState<{ log: CaptureLogEntry[]; eps: EndpointRecord[] } | null>(null);
  const loadDiag = async () => setDiag({ log: (await db.getKV<CaptureLogEntry[]>('captureLog', [])).slice().reverse(), eps: await db.endpoints.toArray() });
  useEffect(() => { setHome(s.homeAddress ?? ''); }, [s.homeAddress]);
  useEffect(() => {
    void bg({ type: 'GET_API_KEY_STATUS' }).then((r) => r.ok && setKeyStatus(r as unknown as { hasKey: boolean; hint: string | null }));
    void Promise.all([hasOrigin(NOMINATIM), hasOrigin(ANTHROPIC), hasOrigin(RATES)]).then(([n, a, r]) => setPerm({ nominatim: n, anthropic: a, rates: r }));
    void db.endpoints.count().then(setEndpoints);
    void loadDiag();
  }, []);
  const llmUsed = s.llmCallsDay === todayKey() ? s.llmCallsToday : 0;
  const unclassified = events.filter((e) => !e.milestone).length;
  const ungeocoded = events.filter((e) => e.lat == null).length;

  const saveKey = async () => { await bg({ type: 'SET_API_KEY', apiKey: key.trim() || null }); if (key.trim()) { const g = await requestOrigin(ANTHROPIC); setPerm((p) => ({ ...p, anthropic: g })); } setKey(''); const r = await bg({ type: 'GET_API_KEY_STATUS' }); if (r.ok) setKeyStatus(r as unknown as typeof keyStatus); setMsg('API key saved locally.'); };
  const saveHome = async () => {
    const g = gazetteerLookup(home);
    let coords = g ? { lat: g.lat, lng: g.lng } : null;
    if (!coords && perm.nominatim && inExtension) {
      try { const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(home)}`, { headers: { 'User-Agent': 'AliExpressParcelIntel/0.1 (local browser extension)' } }); const arr = (await res.json()) as { lat: string; lon: string }[]; if (arr[0]) coords = { lat: +arr[0].lat, lng: +arr[0].lon }; } catch { /* ignore */ }
    }
    const m = home.match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
    if (m) coords = { lat: +m[1], lng: +m[2] };
    await db.patchSettings({ homeAddress: home || null, homeAddressCoords: coords });
    setMsg(coords ? `Home set to ${coords.lat.toFixed(3)}, ${coords.lng.toFixed(3)}.` : 'Saved, but could not geocode — try "City, Country" or "lat, lng", or enable Nominatim.');
  };
  const exportAll = async () => {
    const dump = { version: 1, exportedAt: new Date().toISOString(), orders: await db.orders.toArray(), items: await db.items.toArray(), parcels: await db.parcels.toArray(), events: await db.events.toArray(), geocache: await db.geocache.toArray(), textcache: await db.textcache.toArray(), predictions: await db.predictions.toArray(), endpoints: await db.endpoints.toArray(), alerts: await db.alerts.toArray(), settings: [s] };
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(dump)], { type: 'application/json' })); a.download = `parcel-intel-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  };
  const importAll = async (file: File) => { const json = await file.text(); const r = await bg({ type: 'IMPORT_JSON', json }); setMsg(r.ok ? `Imported ${(r as { rows?: number }).rows ?? ''} rows.` : `Import failed: ${(r as { error: string }).error}`); };
  const wipe = async () => { if (!confirm('Delete ALL locally stored orders, parcels, events, caches and settings? This cannot be undone.')) return; await bg({ type: 'WIPE_ALL' }); if (!inExtension) { for (const t of db.tables) await t.clear(); } setMsg('Everything wiped.'); };

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="sub">Everything is stored in this browser profile only. Nothing is synced or sent anywhere unless you enable it here.</p>
      {msg && <div className="card" style={{ marginBottom: 12, borderColor: 'rgba(52,211,153,.4)' }}>{msg}</div>}
      <div className="split">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Sync</h3>
          <label className="f">Background order sync interval (minutes)<input type="number" min={30} step={30} value={s.syncIntervalMin} onChange={(e) => void db.patchSettings({ syncIntervalMin: Math.max(30, Number(e.target.value) || 180) })} /></label>
          <label className="f" style={{ flexDirection: 'row', alignItems: 'center', margin: '10px 0' }}><input type="checkbox" checked={s.autoRefreshOnLaunch} onChange={(e) => void db.patchSettings({ autoRefreshOnLaunch: e.target.checked })} /> Catch up automatically when the extension starts and when this dashboard opens (new orders only, not the whole history)</label>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Last catch-up: {s.lastAutoRefreshAt ? fmtAgo(s.lastAutoRefreshAt) : 'never'}</div>
          <div className="muted" style={{ fontSize: 12, margin: '8px 0' }}>Tracking polls follow parcel state (3h / 8h / 24h) automatically. {endpoints} endpoint shape{endpoints === 1 ? '' : 's'} learned from real traffic.</div>
          <label className="f" style={{ flexDirection: 'row', alignItems: 'center' }}><input type="checkbox" checked={s.notifications} onChange={(e) => void db.patchSettings({ notifications: e.target.checked })} /> Chrome notifications for deliveries, stalls and deadlines</label>
          <div className="row" style={{ marginTop: 10 }}><button className="btn sm" onClick={() => void bg({ type: 'SYNC_NOW' }).then((r) => setMsg(r.ok ? 'Sync finished.' : `Sync failed: ${(r as { error: string }).error}`))}>Sync now</button><button className="btn sm" onClick={() => void bg({ type: 'RECOMPUTE' })}>Recompute estimates</button></div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Home & currency</h3>
          <label className="f">Home address (for projected routes) — city, country or "lat, lng"<div className="row"><input value={home} onChange={(e) => setHome(e.target.value)} placeholder="Chicago, IL" /><button className="btn sm" onClick={() => void saveHome()}>Save</button></div></label>
          <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>{s.homeAddressCoords ? `Pinned at ${s.homeAddressCoords.lat.toFixed(3)}, ${s.homeAddressCoords.lng.toFixed(3)}` : 'Not set — projected (dashed) routes are hidden.'}</div>
          <label className="f">Display currency<select value={s.displayCurrency} onChange={(e) => void db.patchSettings({ displayCurrency: e.target.value })}>{['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CNY', 'JPY', 'BRL', 'MXN', 'PLN', 'SEK', 'CHF', 'ILS', 'TRY', 'INR', 'KRW', 'NZD'].map((c) => <option key={c}>{c}</option>)}</select></label>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={() => void requestOrigin(RATES).then((g) => { setPerm((p) => ({ ...p, rates: g })); if (g) void bg({ type: 'REFRESH_RATES' }); })}>{perm.rates ? 'Rates enabled ✓' : 'Enable weekly rate refresh (open.er-api.com)'}</button>
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Appearance</h3>
          <label className="f">Theme<select value={s.theme} onChange={(e) => void db.patchSettings({ theme: e.target.value as typeof s.theme })}><option value="dark">Dark</option><option value="light">White</option><option value="offwhite">Off-white</option></select></label>
          <div className="muted" style={{ fontSize: 12, margin: '10px 0 6px' }}>Accent colour</div>
          <div className="row" style={{ gap: 12 }}>
            <div className="swatches">{['#6ea8ff', '#9b7bff', '#34d399', '#fbbf24', '#f97316', '#f87171', '#ec4899', '#22d3ee', '#a3e635', '#e2e8f0'].map((c) => <button key={c} className={`swatch ${s.accent === c ? 'sel' : ''}`} style={{ background: c }} title={c} onClick={() => void db.patchSettings({ accent: c })} />)}</div>
            <label className="row" style={{ gap: 6, fontSize: 12 }}><input type="color" value={s.accent} onChange={(e) => void db.patchSettings({ accent: e.target.value })} style={{ width: 40, height: 32, padding: 2 }} /> custom</label>
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Geocoding</h3>
          <label className="f">Tiers<select value={s.geocodingMode} onChange={(e) => void db.patchSettings({ geocodingMode: e.target.value as typeof s.geocodingMode })}><option value="gazetteer">Bundled gazetteer only (zero network)</option><option value="nominatim">+ Nominatim (1 req/s, cached forever)</option><option value="nominatim+llm">+ Nominatim + LLM fallback</option></select></label>
          <div className="row" style={{ marginTop: 10 }}>
            {s.geocodingMode !== 'gazetteer' && <button className="btn sm" onClick={() => void requestOrigin(NOMINATIM).then((g) => setPerm((p) => ({ ...p, nominatim: g })))}>{perm.nominatim ? 'Nominatim allowed ✓' : 'Grant nominatim.openstreetmap.org'}</button>}
            <button className="btn sm" onClick={() => void bg({ type: 'GEOCODE_PENDING' }).then((r) => setMsg(r.ok ? `Geocoded ${(r as { resolved?: number }).resolved} scans, ${(r as { unresolved?: number }).unresolved} still unresolved.` : `Failed: ${(r as { error: string }).error}`))}>Geocode pending now</button>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{ungeocoded} scans without coordinates · {unclassified} scans without a milestone.</div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>LLM (optional)</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Used only for scan text the rules miss, geocoding misses, and the "Explain" button. Uses claude-haiku-4-5. Key lives in chrome.storage.local, never synced.</div>
          <label className="f">Anthropic API key {keyStatus.hasKey && <span className="tag ok">saved {keyStatus.hint}</span>}<div className="row"><input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={keyStatus.hasKey ? 'Enter a new key to replace' : 'sk-ant-…'} /><button className="btn sm" onClick={() => void saveKey()}>{key ? 'Save' : keyStatus.hasKey ? 'Remove' : 'Save'}</button></div></label>
          <label className="f" style={{ marginTop: 10 }}>Daily call budget<input type="number" min={0} max={200} value={s.llmDailyBudget} onChange={(e) => void db.patchSettings({ llmDailyBudget: Math.max(0, Number(e.target.value) || 0) })} /></label>
          <div style={{ marginTop: 10 }}><div className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}><span>Calls today</span><strong>{llmUsed} / {s.llmDailyBudget}</strong></div><div className="progress"><div style={{ width: `${Math.min(100, (llmUsed / Math.max(1, s.llmDailyBudget)) * 100)}%`, background: llmUsed >= s.llmDailyBudget ? 'var(--bad)' : undefined }} /></div></div>
        </div>
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>Diagnostics</h3><div className="row"><button className="btn sm" onClick={() => void bg({ type: 'SYNC_TRACKING' }).then(() => loadDiag())}>Fetch AliExpress tracking for all orders</button><button className="btn sm" onClick={() => void loadDiag()}>Refresh</button></div></div>
          <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>What the interceptor has seen. If this stays empty while you browse aliexpress.com, the content scripts are not running — reload the extension.</div>
          <label className="f" style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}><input type="checkbox" checked={s.debugChannel} onChange={(e) => void db.patchSettings({ debugChannel: e.target.checked })} /> Developer diagnostics channel (lets a page on aliexpress.com query this extension's status via postMessage — leave off unless debugging)</label>
          <div className="split">
            <div>
              <div className="muted" style={{ fontSize: 11 }}>LEARNED ENDPOINTS</div>
              <table><tbody>{(diag?.eps ?? []).map((e) => <tr key={e.key}><td className="mono" style={{ fontSize: 11 }}>{e.key.replace(/^[^/]+\/h5\//, '')}</td><td><span className="tag">{e.kind}</span></td><td className="muted">{e.method}{e.pageParam ? ` · ${e.pageParam}` : ''}</td><td className="num">{e.hits}×</td></tr>)}{!diag?.eps.length && <tr><td className="muted">none yet</td></tr>}</tbody></table>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>RECENT CAPTURES</div>
              <table><tbody>{(diag?.log ?? []).slice(0, 12).map((l, i) => <tr key={i}><td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(l.ts)}</td><td className="mono" style={{ fontSize: 11 }}>{l.path.replace(/^[^/]+\/h5\//, '')}</td><td className="muted">{l.via} · {Math.round(l.bytes / 1024)} KB</td><td style={{ whiteSpace: 'nowrap' }}>{l.loginRequired ? <span className="tag bad">login</span> : `${l.orders}o ${l.items}i ${l.parcels}p ${l.events}e`}</td></tr>)}{!diag?.log.length && <tr><td className="muted">none yet</td></tr>}</tbody></table>
            </div>
          </div>
        </div>
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h3 style={{ marginTop: 0 }}>Data</h3>
          <div className="row">
            <button className="btn" onClick={() => void exportAll()}>Export everything (JSON)</button>
            <label className="btn">Import JSON<input type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && void importAll(e.target.files[0])} /></label>
            <button className="btn danger" onClick={() => void wipe()}>Wipe everything</button>
          </div>
        </div>
      </div>
    </div>
  );
}
