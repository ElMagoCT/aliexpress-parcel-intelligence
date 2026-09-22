/**
 * Long-running work (tracking sync, backfill phases) must not hold a message channel open:
 * Chrome tears the MV3 service worker down and the caller sees "message channel closed".
 * Jobs run detached, keep the worker alive with a periodic extension-API call, and publish
 * progress into the kv table so the dashboard / diagnostics can poll it.
 */
import { db } from '@/db/schema';

export interface JobStatus { name: string; state: 'running' | 'done' | 'error'; startedAt: number; updatedAt: number; progress: string; result?: unknown; error?: string }

const running = new Map<string, Promise<unknown>>();
let keepalive: ReturnType<typeof setInterval> | null = null;

function ensureKeepalive() {
  if (keepalive) return;
  keepalive = setInterval(() => { if (!running.size) { clearInterval(keepalive!); keepalive = null; return; } try { void chrome.runtime.getPlatformInfo(); } catch { /* ignore */ } }, 20_000);
}

export async function setJob(name: string, patch: Partial<JobStatus>) {
  const jobs = await db.getKV<Record<string, JobStatus>>('jobs', {});
  const cur = jobs[name] ?? { name, state: 'running', startedAt: Date.now(), updatedAt: Date.now(), progress: '' };
  jobs[name] = { ...cur, ...patch, updatedAt: Date.now() };
  await db.setKV('jobs', jobs);
}

export async function getJobs(): Promise<Record<string, JobStatus>> { return db.getKV<Record<string, JobStatus>>('jobs', {}); }

/** On worker start: anything still marked running was interrupted by a worker restart. */
export async function reapStaleJobs() {
  const jobs = await getJobs();
  let changed = false;
  for (const j of Object.values(jobs)) if (j.state === 'running' && !running.has(j.name)) { j.state = 'error'; j.error = 'interrupted (service worker restarted)'; j.updatedAt = Date.now(); changed = true; }
  if (changed) await db.setKV('jobs', jobs);
}

/** Start (or join) a named job. Returns immediately; poll getJobs() for progress. */
export function startJob<T>(name: string, fn: (report: (progress: string) => Promise<void>) => Promise<T>): { started: boolean; alreadyRunning: boolean } {
  if (running.has(name)) return { started: false, alreadyRunning: true };
  const p = (async () => {
    await setJob(name, { state: 'running', startedAt: Date.now(), progress: 'starting', error: undefined, result: undefined });
    try {
      const result = await fn((progress) => setJob(name, { progress }));
      await setJob(name, { state: 'done', progress: 'done', result });
      return result;
    } catch (e) {
      await setJob(name, { state: 'error', error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally { running.delete(name); }
  })();
  running.set(name, p.catch(() => undefined));
  ensureKeepalive();
  return { started: true, alreadyRunning: false };
}
