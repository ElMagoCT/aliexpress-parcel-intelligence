import type { BackfillState, Milestone, Prediction } from '@/model/types';

/** postMessage envelope from the MAIN-world interceptor to the ISOLATED bridge. */
export interface CaptureEnvelope {
  __aepi: 1;
  type: 'AEPI_CAPTURE';
  url: string;
  method: string;
  body: string; // raw response text (or JSON.stringify of a JSONP payload)
  reqBody: string | null; // POST body (form/JSON) when the page sent one — needed to replay paginated calls
  via: 'fetch' | 'xhr' | 'jsonp' | 'runParams';
  ts: number;
}

export type BgMessage =
  | { type: 'CAPTURE'; url: string; method: string; body: string; via: CaptureEnvelope['via']; pageUrl: string; reqBody?: string | null }
  | { type: 'DIAG' }
  | { type: 'DEBUG_CHANNEL_ENABLED' }
  | { type: 'SYNC_REFUNDS' }
  | { type: 'SYNC_DETAILS' }
  | { type: 'GET_JOBS' }
  | { type: 'RELOAD_EXT' }
  | { type: 'SYNC_TRACKING' }
  | { type: 'OPEN_DASHBOARD' }
  | { type: 'SYNC_NOW' }
  | { type: 'BACKFILL_START' }
  | { type: 'BACKFILL_STOP' }
  | { type: 'BACKFILL_PROGRESS'; pagesFetched: number; ordersOnPage: number; exhausted: boolean; note?: string }
  | { type: 'BACKFILL_GET_STATE' }
  | { type: 'ESTIMATE_FOR_LISTING'; service: string; shipFrom: string | null; aliexpressDays: number | null }
  | { type: 'EXPLAIN_PARCEL'; parcelId: string }
  | { type: 'POLL_PARCEL'; parcelId: string }
  | { type: 'RECOMPUTE' }
  | { type: 'WIPE_ALL' }
  | { type: 'IMPORT_JSON'; json: string }
  | { type: 'SET_API_KEY'; apiKey: string | null }
  | { type: 'GET_API_KEY_STATUS' }
  | { type: 'REQUEST_HOST_PERMISSION'; origin: string }
  | { type: 'REFRESH_RATES' }
  | { type: 'GEOCODE_PENDING' }
  | { type: 'PING' };

export interface ListingEstimate {
  p50Days: number;
  p80Days: number;
  p20Days: number;
  sampleSize: number;
  basis: 'service' | 'pooled' | 'prior';
  aliexpressDays: number | null;
}

export type BgResponse =
  | { ok: true; [k: string]: unknown }
  | { ok: false; error: string };

export interface BackfillDriverCommand {
  type: 'AEPI_DRIVER_START' | 'AEPI_DRIVER_STOP';
  state?: BackfillState;
}

export interface PredictionView extends Prediction {
  milestone: Milestone | null;
}
