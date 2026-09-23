import type { BgMessage, BgResponse } from '@/shared/messages';
import type { BackfillState } from '@/model/types';

export const inExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

const idleBackfill: BackfillState = { active: false, phase: 'idle', tabId: null, pagesFetched: 0, ordersFound: 0, ordersAtStart: 0, estimatedRemainingPages: null, trackingQueued: 0, trackingDone: 0, startedAt: null, updatedAt: 0, lastError: null, exhaustedStreak: 0 };

/** Send a message to the service worker. In standalone preview mode, answer locally. */
export function bg(msg: BgMessage): Promise<BgResponse> {
  if (!inExtension) return shimAsync(msg);
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res: BgResponse) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'no response' });
        else resolve(res ?? { ok: false, error: 'empty response' });
      });
    } catch (e) { resolve({ ok: false, error: String(e) }); }
  });
}

/**
 * Standalone preview has no service worker. Anything that only touches the local database is run
 * for real so the preview is a genuine testbed; everything else gets a canned answer.
 */
async function shimAsync(msg: BgMessage): Promise<BgResponse> {
  try {
    switch (msg.type) {
      case 'SET_PARCEL_STATE': {
        const { setParcelState } = await import('@/background/manual');
        await setParcelState(msg.parcelId, msg.state);
        return { ok: true };
      }
      case 'ADD_PARCEL': {
        const { addManualParcel } = await import('@/background/manual');
        return { ok: true, ...(await addManualParcel(msg.input)) };
      }
      case 'CLOSE_ABANDONED': {
        const { closeAbandoned } = await import('@/background/manual');
        return { ok: true, closed: await closeAbandoned(msg.state ?? 'archived') };
      }
      case 'LIST_ABANDONED': {
        const { listAbandoned } = await import('@/background/manual');
        return { ok: true, parcels: await listAbandoned() };
      }
      case 'RECOMPUTE': {
        const { recomputeAll } = await import('@/background/recompute');
        await recomputeAll();
        return { ok: true };
      }
      case 'PARSE_PAGE': {
        const { parseShoppingPage } = await import('@/adapters/pageCapture');
        return { ok: true, item: parseShoppingPage(msg.harvest) };
      }
      case 'FETCH_CARRIER_SCANS':
        return { ok: true, result: { ok: false, note: 'Reading a carrier page needs the installed extension.', scans: 0, delivered: false } };
      default: return shim(msg);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function shim(msg: BgMessage): BgResponse {
  switch (msg.type) {
    case 'BACKFILL_GET_STATE': return { ok: true, state: idleBackfill };
    case 'BACKFILL_START': return { ok: true, state: { ...idleBackfill, active: true, phase: 'orders', pagesFetched: 3, ordersFound: 27, startedAt: Date.now() } };
    case 'GET_API_KEY_STATUS': return { ok: true, hasKey: false, hint: null };
    case 'EXPLAIN_PARCEL': return { ok: true, text: 'Preview mode: explanations need the extension context and an API key.' };
    case 'REQUEST_HOST_PERMISSION': return { ok: true, granted: false };
    default: return { ok: true };
  }
}

export async function requestOrigin(origin: string): Promise<boolean> {
  if (!inExtension) return false;
  try { return await chrome.permissions.request({ origins: [origin] }); } catch { return false; }
}
export async function hasOrigin(origin: string): Promise<boolean> {
  if (!inExtension) return false;
  try { return await chrome.permissions.contains({ origins: [origin] }); } catch { return false; }
}
