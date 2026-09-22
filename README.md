# Parcel Intelligence

[![version](https://img.shields.io/badge/version-1.1.0-6ea8ff)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-9b7bff)](LICENSE)

Website and privacy policy: <https://elmagoct.github.io/parcel-intelligence/> ·
Revision history: [CHANGELOG.md](CHANGELOG.md)

A Manifest V3 Chrome extension that passively harvests your own AliExpress order and tracking
data while you are logged in, stores everything locally in IndexedDB, and gives you a map-first
dashboard with delivery estimates built from *your* delivery history.

No backend, no accounts, no telemetry. Read-only against your own account.

## Install (unpacked)

```bash
export PATH="$HOME/.local/node-v24.19.0-darwin-arm64/bin:$PATH"
cd ~/Documents/Workspace/aliexpress-parcel-intel
npm install
npm run build          # → dist/
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the `dist/` folder.
2. The dashboard opens automatically on first install (`#/setup`). Later, click the toolbar icon.
3. Sign in to AliExpress in the same profile and browse your orders page once — data flows in
   passively from that moment. Or run **Backfill** for the full history.

## How data gets in

| Path | Where | What |
|---|---|---|
| **Passive interception** (primary) | `public/interceptor.iife.js` — MAIN world, registered at runtime by the service worker | Monkey-patches `fetch`, `XMLHttpRequest`, and mtop JSONP callbacks. Any response whose URL matches an order / logistics / freight pattern is mirrored via `postMessage` → `src/content/bridge.ts` → service worker. |
| **Direct fetch** (secondary) | `src/background/sync.ts` | Re-fetches endpoint shapes learned from real traffic (`endpoints` table) with `credentials: 'include'`, re-signing mtop URLs from the `_m_h5_tk` cookie. Never guesses URLs. |
| **Backfill wizard** | `src/background/backfill.ts` + bridge driver | Opens the orders page in a background tab, paginates at 1.5–3 s with jitter until exhausted, then trickles Cainiao history for every parcel, oldest first. State lives in `chrome.storage.local`; survives tab closure and service-worker restarts (watchdog alarm). Stop button in the tab and dashboard. |
| **Tracking poller** | `src/background/tracker.ts` | Cainiao `detail.json` (JSON or JSONP). Cadence by state: 3 h (destination country / out for delivery), 8 h (in transit), 24 h (stalled), stop when delivered. Max 3 concurrent, jitter, exponential backoff on 429/5xx, global pause after consecutive failures. |

Login redirects stop syncing cleanly and raise the *"Sign in to AliExpress to resume syncing"* banner. No retry-spam.

### The isolation rule

**Every** AliExpress-specific fact — URL patterns, JSON field vocabularies, DOM selectors for the
orders page and product listings, mtop signing — lives in `src/adapters/aliexpress.ts`. Parsing is
*structural*: it walks any payload and recognises order-like / item-like / event-like objects by
the keys they carry, so renamed paths degrade instead of breaking. Cainiao's endpoint shapes live
in `src/adapters/cainiao.ts`. Everything downstream consumes the normalised model in `src/model/types.ts`.

## Estimation engine (`src/engine/estimator.ts`)

- Predicts **remaining** days conditioned on the current milestone, re-estimated on every scan.
- Empirical distribution per `(service, milestone)` from delivered parcels, shrunk toward pooled
  data with `w = n / (n + 8)`, pooled shrunk toward a baseline prior — useful before backfill finishes.
- Reports **P50 / P80** as a band, flags divergence from AliExpress's promised date.
- Dwell distributions per milestone; a parcel past P90 dwell at its node is **stalled**.
- Milestones: regex rules (`src/engine/milestones.ts`) + carrier action codes + sequence
  resolution (customs direction, local vs origin sorting). Unknowns can go to the LLM fallback and
  are cached by text hash forever.
- Consolidation: tracking numbers sharing ≥ 80 % of `(minute, location)` scan nodes render as one
  grouped marker with "N parcels moving as one".

## UI

Map (default, time scrubber, solid travelled path, dashed projection to home, clustering),
Timeline (bars sorted by ETA with P50–P80 window and promise marker), Alerts (stalls, exceptions,
late, buyer-protection countdown with escalating urgency), Orders (sortable, split shipments
obvious), Finance (lifetime spend, by month/seller/category, shipping share, multi-currency,
CSV/JSON export), Backfill wizard, Settings (API key, LLM budget, sync interval, geocoding tier,
home address, export/import, wipe).

Listing pages get a badge next to each shipping option:
**Your history: 14–24 days** (P50 18) · AliExpress says 12 days · based on 9 similar parcels —
falling back to pooled / baseline with an explicit label.

## Optional network features (off by default)

| Feature | Host permission requested on enable |
|---|---|
| Nominatim geocoding, 1 req/s, cached forever | `nominatim.openstreetmap.org` |
| Weekly exchange-rate refresh | `open.er-api.com` |
| LLM fallbacks (`claude-haiku-4-5`, default 5 calls/day, hard stop) | `api.anthropic.com` |

The bundled gazetteer (`src/data/gazetteer.json`, ~740 names) resolves common logistics nodes
with zero network calls. Map tiles come from `tile.openstreetmap.org` as plain `<img>` loads.

## Development

```bash
npm run typecheck              # tsc
npm test                       # vitest — adapter, milestone rules, estimator, consolidation, gazetteer
npm run build                  # interceptor IIFE + CRXJS extension → dist/
npm run preview:dashboard      # dashboard alone at http://localhost:5198 with demo data (no extension needed)
python3 -m http.server 8799    # then open /tests/fixtures/interceptor-test.html to smoke-test the interceptor
```

### Verified against a live session (2026-09-20)

- Order list: `mtop.aliexpress.trade.buyer.order.list` — an "ultron" component tree keyed
  `pc_om_list_order_<orderId>.fields` (`orderId`, `statusText`, `orderDateText`, `totalPriceText`,
  `storeName`, `orderLines[]{productId, skuId, itemTitle, itemImgUrl, itemPriceText, quantity, skuAttrs[]}`).
  First page arrives by JSONP; "View orders" pagination is a **POST** whose form body carries
  `pageIndex` inside nested JSON. Tracking numbers are **not** in the list.
- Tracking: `mtop.ae.ld.querydetail` (`data.tradeOrderId`) — `module.trackingDetailLineList[]` with
  `mailNo`, `logisticsCarrierName`, `detailList[]{time, trackingDetailDesc, trackingPrimaryCode}`
  (codes like `AE_LH_ARRIVE`, `AE_GTMS_SIGNED`, `AE_LAST_MILE_HO_SUCCESS`), `etaInfo.endEtaTime`,
  `packageItemList[]`, `logisticsReceiverInfo`, and "Refund if no delivery before <date>".
  Pre-shipment nodes (`AE_ORDER_PLACED`, `AE_ORDER_PAID`, `AE_GWMS_*`) are kept as events but are
  never milestones. Some completed orders only ever expose those three nodes.
- Order detail: `mtop.aliexpress.trade.buyer.order.detail` (`data.tradeOrderId`) — an ultron tree whose
  `detail_order_price_block.priceDetails[]` carries `{title, value}` rows for Subtotal, Shipping
  ("Free shipping" means zero, not unknown), Coins, Multi-store coupon and Additional charges, plus
  `totalPrice`. **The order LIST has no shipping line at all**, which is why shipping share read 0%
  until this was added. One request per order; `detail_simple_order_info_component` also gives the
  payment method.
- Checkout grouping: AliExpress splits one cart into an order per seller and allocates their ids
  consecutively — observed step exactly 20000, while a separate checkout jumps by ~1e11. Orders are
  therefore clustered into "shopping trips" by numeric id gap (threshold 1e6). `paymentOutId` is
  unique per order and is *not* the link.
- Returns/refunds: `queryReverseOrderPageListForBuyer` (POST, `reverseStatus: 1` lists every case)
  and `reverseOrderLineRenderForBuyer` (POST, needs `terminalType` + `tradeOrderLineId`) for the
  actual refunded money under `reverseFinishInfo.refundInfo`.
- Product pages: the badge follows the visible `Delivery: Sep. 26 - Oct. 01 (78.2% ≤ 10 days)` line.
- OpenStreetMap's own tile servers return 403 to `chrome-extension://` pages (no acceptable
  Referer); the map uses CARTO's dark basemap instead.
- The dashboard reads IndexedDB directly, so every view keeps rendering even when the service
  worker is dead — buttons then do nothing at all. A background-health banner now says so instead
  of failing silently, and an unpacked extension needs a manual Reload in `chrome://extensions`
  for a rebuilt `dist/` to take effect.
- MV3 kills the service worker under long message handlers ("message channel closed"). Long work
  runs as detached jobs (`src/background/jobs.ts`) with a keepalive; the dashboard/diagnostics poll
  their progress.

### Things that were checked, and things that were not

- ✅ Interceptor captures fetch, XHR and JSONP in a real browser (smoke test page above).
- ✅ Dashboard views render against demo data with no console errors (standalone preview).
- ✅ 51 unit tests: structural order parsing, money/date shapes, JSONP, login detection, mtop
  re-signing (MD5 vectors), Cainiao shapes, 33 milestone phrasings, shrinkage maths, consolidation,
  dispute windows, gazetteer lookups.
- ✅ Live session: 195 orders, 200+ items with images, tracking for every shipped order, estimates on a
  product page, all confirmed through the Settings → Diagnostics panel.
- ⚠️ Cainiao's public `detail.json` is the fallback only; AliExpress's own tracking detail is richer
  and is polled first.

### Gotchas encoded in the code

- CRXJS's MAIN-world loader uses a relative dynamic `import()` that resolves against the page
  origin and 404s. The interceptor is therefore built separately as a self-contained IIFE
  (`vite.interceptor.config.ts`) and registered with `chrome.scripting.registerContentScripts`.
- mtop signing: `sign = md5(token & t & appKey & data)` where `token` is the first `_` segment of
  the `_m_h5_tk` cookie (needs the `cookies` permission). `type=jsonp` is rewritten to `originaljson`.
- Chrome allows setting `User-Agent` on `fetch` from extensions (needed for Nominatim's policy).


## Releasing

1. Update `CHANGELOG.md` with a new version section.
2. Bump `version` in `manifest.config.ts` (and `package.json` to match).
3. `npm run build`
4. `cd dist && zip -r ../parcel-intelligence-<version>.zip .`
5. Upload the zip in the Chrome Web Store dashboard, then tag: `git tag v<version> && git push --tags`

The store listing copy, permission justifications and promo art live in [`store/`](store/).

## Privacy

No account, no backend, no telemetry; all data stays in the browser profile. Full policy in
[PRIVACY.md](PRIVACY.md) and published at
<https://elmagoct.github.io/parcel-intelligence/privacy.html>.

## License

MIT — see [LICENSE](LICENSE).
