import { useEffect, useState } from 'react';
import { MapView } from './views/MapView';
import { TimelineView } from './views/TimelineView';
import { AlertsView } from './views/AlertsView';
import { FinanceView } from './views/FinanceView';
import { OrdersView } from './views/OrdersView';
import { SettingsView } from './views/SettingsView';
import { SetupView } from './views/SetupView';
import { useAlerts, useBackgroundHealth, useParcels, useSettings, isActive } from './lib/useData';
import { bg, inExtension } from './lib/bg';
import { ORDERS_PAGE_URL } from '@/adapters/aliexpress';
import { ErrorBoundary } from './components/ErrorBoundary';

type Route = 'map' | 'timeline' | 'alerts' | 'orders' | 'finance' | 'settings' | 'setup';
const ROUTES: { id: Route; label: string; icon: string }[] = [
  { id: 'map', label: 'Map', icon: '◎' }, { id: 'timeline', label: 'Timeline', icon: '☰' }, { id: 'alerts', label: 'Alerts', icon: '⚠' },
  { id: 'orders', label: 'Orders', icon: '▤' }, { id: 'finance', label: 'Finance', icon: '◔' }, { id: 'setup', label: 'Backfill', icon: '⟳' }, { id: 'settings', label: 'Settings', icon: '⚙' },
];

function useRoute(): [Route, string | null, (r: Route, sel?: string | null) => void] {
  const parse = () => { const h = location.hash.replace(/^#\/?/, ''); const [r, q] = h.split('?'); const sel = q ? new URLSearchParams(q).get('p') : null; return [(ROUTES.some((x) => x.id === r) ? r : 'map') as Route, sel] as const; };
  const [state, setState] = useState(parse);
  useEffect(() => { const f = () => setState(parse); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return [state[0], state[1], (r, sel) => { location.hash = `/${r}${sel ? `?p=${encodeURIComponent(sel)}` : ''}`; }];
}

export function App() {
  const [route, selected, go] = useRoute();
  const parcels = useParcels();
  const alerts = useAlerts();
  const settings = useSettings();
  const health = useBackgroundHealth();
  const active = parcels.filter(isActive).length;
  const openAlerts = alerts.filter((a) => !a.dismissed);
  const urgent = openAlerts.some((a) => a.severity === 'urgent');
  // Opening the dashboard is a "launch" too; the background de-dupes against the 10-minute gap.
  useEffect(() => { if (inExtension) void bg({ type: 'AUTO_REFRESH', trigger: 'dashboard opened' }); }, []);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme ?? 'dark'; document.documentElement.style.setProperty('--accent', settings.accent || '#6ea8ff'); }, [settings.theme, settings.accent]);
  const counts: Partial<Record<Route, { n: number; cls: string }>> = {
    map: { n: active, cls: '' }, alerts: { n: openAlerts.length, cls: urgent ? 'bad' : openAlerts.length ? 'warn' : '' },
  };
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><span className="dot" /><span className="lbl">Parcel Intelligence</span></div>
        {ROUTES.map((r) => (
          <div key={r.id} className={`nav ${route === r.id ? 'active' : ''}`} onClick={() => go(r.id)} title={r.label}>
            <span>{r.icon}</span><span className="lbl">{r.label}</span>
            {counts[r.id]?.n ? <span className={`n ${counts[r.id]!.cls}`}>{counts[r.id]!.n}</span> : null}
          </div>
        ))}
        <div className="foot">{inExtension ? 'All data stays in this browser.' : 'Preview mode · demo data'}<br />{settings.lastSyncAt ? `Last sync ${new Date(settings.lastSyncAt).toLocaleTimeString()}` : 'Not synced yet'}</div>
      </aside>
      <main className="main">
        {inExtension && health === 'down' && (
          <div className="banner" style={{ background: 'linear-gradient(90deg, rgba(248,113,113,.22), rgba(251,191,36,.12))', borderColor: 'rgba(248,113,113,.45)' }}>
            <span>⚠</span>
            <span><strong>The extension's background worker isn't responding.</strong> Your saved data still shows, but syncing and every button here will do nothing until it restarts.</span>
            <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText('chrome://extensions').catch(() => {}); }}>Copy chrome://extensions</button>
            <button className="btn sm" onClick={() => location.reload()}>Recheck</button>
          </div>
        )}
        {settings.loggedOut && (
          <div className="banner">
            <span>⚠</span><span><strong>Sign in to AliExpress to resume syncing.</strong> The last sync hit a login page.</span>
            <a className="btn sm" href={ORDERS_PAGE_URL} target="_blank" rel="noreferrer">Open AliExpress</a>
            <button className="btn sm" onClick={() => void bg({ type: 'SYNC_NOW' })}>Retry sync</button>
          </div>
        )}
        <ErrorBoundary name={route}>
        {route === 'map' && <MapView selectedId={selected} onSelect={(id) => go('map', id)} />}
        {route === 'timeline' && <TimelineView onSelect={(id) => go('map', id)} />}
        {route === 'alerts' && <AlertsView onSelect={(id) => go('map', id)} />}
        {route === 'orders' && <OrdersView onSelect={(id) => go('map', id)} />}
        {route === 'finance' && <FinanceView />}
        {route === 'setup' && <SetupView />}
        {route === 'settings' && <SettingsView />}
        </ErrorBoundary>
      </main>
    </div>
  );
}
