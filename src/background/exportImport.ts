import { db } from '@/db/schema';

export async function exportAllJson(): Promise<string> {
  const dump = {
    version: 1,
    exportedAt: new Date().toISOString(),
    orders: await db.orders.toArray(),
    items: await db.items.toArray(),
    parcels: await db.parcels.toArray(),
    events: await db.events.toArray(),
    geocache: await db.geocache.toArray(),
    textcache: await db.textcache.toArray(),
    predictions: await db.predictions.toArray(),
    endpoints: await db.endpoints.toArray(),
    alerts: await db.alerts.toArray(),
    settings: [await db.getSettings()],
  };
  return JSON.stringify(dump);
}

export async function importAllJson(json: string): Promise<{ tables: number; rows: number }> {
  const data = JSON.parse(json) as Record<string, unknown[]>;
  let tables = 0, rows = 0;
  const tableNames = ['orders', 'items', 'parcels', 'events', 'geocache', 'textcache', 'predictions', 'endpoints', 'alerts'] as const;
  await db.transaction('rw', db.tables, async () => {
    for (const t of tableNames) {
      const arr = data[t];
      if (Array.isArray(arr) && arr.length) { await (db as unknown as Record<string, { bulkPut: (a: unknown[]) => Promise<unknown> }>)[t].bulkPut(arr); tables++; rows += arr.length; }
    }
    const s = data.settings;
    if (Array.isArray(s) && s[0]) { await db.patchSettings(s[0] as Record<string, never>); tables++; rows++; }
  });
  return { tables, rows };
}

export async function wipeAll(): Promise<void> {
  await db.transaction('rw', db.tables, async () => { for (const t of db.tables) await t.clear(); });
  await chrome.storage.local.clear();
}
