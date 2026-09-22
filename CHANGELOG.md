# Changelog

All notable changes to **Parcel Intelligence**.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version here is the one in
`manifest.config.ts`, which is what the Chrome Web Store sees.

---

## [1.4.1] — 2026-09-22

### Changed

- **Renamed to “Parcel Intelligence”.** The Web Store rejects names likely to suggest affiliation
  with another company, and the old name led with the AliExpress trademark. The brand stays in the
  description, where it is both allowed and searchable.
- The manifest description said "your own AliExpress orders" long after the extension started
  handling any store.
- The privacy policy now covers the toolbar popup: it reads the active tab, only on click, under
  Chrome's `activeTab` permission, shows what it found before anything is saved, and sends nothing
  anywhere.

### Fixed

- The build shipped the icons and the page interceptor twice — once at the root and once under
  `public/` — because Vite copies the public directory in addition to emitting the paths the
  manifest references. The build now keeps only the referenced copies and verifies every manifest
  reference resolves.

---

## [1.4.0] — 2026-09-22

Any store, any carrier, and a way to close out parcels nobody is ever going to scan again.

### Added

- **Mark a parcel delivered, lost or archived.** Cheap untracked shipping routinely stops scanning
  after dispatch, leaving parcels stuck on "the seller has shipped your package" forever. A manual
  state overrides whatever the carrier says, stops the polling, clears the parcel's alerts and can
  be undone. A hand-set delivery is deliberately kept out of the delivery estimates — it records
  when you clicked, not when the parcel arrived.
- **Bulk cleanup for abandoned parcels.** The parcel list offers to close everything with no scan
  in over 45 days, either as arrived or simply archived.
- **Any store, any carrier.** Orders and parcels now carry a store, and tracking numbers are
  identified across UPS, USPS, FedEx, DHL, Amazon Logistics, Royal Mail, Canada Post, Australia
  Post, 4PX, YunExpress, SF Express, Evri and any UPU/S10 number, which also yields the origin
  country. Each gets a working link to its own tracking page, with 17track as the fallback.
  Only AliExpress and Cainiao scans can be fetched automatically, and the UI says so rather than
  implying the rest will update.
- **A capture popup on the toolbar button.** On any shopping page it reads the item's image, title
  and price, plus any tracking number on the page, and saves it in a click. It uses the structured
  data sites already publish for search engines and social previews — JSON-LD, OpenGraph,
  microdata — falling back to visible text, rather than guessing at each retailer's private API.
- **Add a parcel by hand** from the parcel list, with live carrier identification as you type.
- **A time frame control and a per-store split in Finance**: all time, last 30/90 days, last 12
  months, this year, or any single year, combined with a store filter, plus a "spend by store"
  breakdown. Every figure, chart and table respects both.

### Fixed

- **Parcels with no scans were invisible.** The parcel list only showed parcels it could place on
  the map, so anything freshly added, or shipped but never scanned, silently never appeared.
  The list now shows every parcel and the map pins the ones it can place.

---

## [1.3.0] — 2026-09-22

The accent colour now re-tones the entire interface instead of tinting a few buttons.

### Changed

- **Every surface is mixed from the accent.** In dark mode the background, panels and the corner
  glow take their tone from it, so an orange accent gives a warm near-black rather than the same
  blue-black with orange buttons. In the light and off-white themes the cards carry the tint, which
  is where it reads best on a pale background. Base colours stay near-neutral and the accent is
  blended in at a few percent over large areas and more over small ones.
- The spend chart, the map's route lines, parcel markers, the time scrubber and every focus ring
  follow the accent as well. Leaflet writes `stroke` as an SVG attribute, where a CSS variable
  would not resolve, so the map reads the resolved colours off the document and redraws when the
  accent changes.

### Fixed

- **Cards stayed dark in the light and off-white themes.** `.card` painted a hardcoded dark
  gradient that ignored the theme entirely, so every panel on a white background was still
  near-black. This is why switching theme appeared to do so little.
- The map canvas, chart axes, grid, tooltip and several selection highlights were pinned to the
  original dark palette and ignored both the theme and the accent.

---

## [1.2.0] — 2026-09-22

Keeps itself up to date without being asked, and converts every currency.

### Added

- **Catch-up refresh on launch.** Runs when the browser starts, when the extension is installed or
  updated, and when the dashboard is opened. It does not re-read your whole history: it pages the
  order list only until two consecutive pages contain nothing new, then tops up what actually goes
  stale — tracking for active parcels, prices for orders never priced, new return cases and the
  exchange-rate table. A ten-minute floor means repeated worker restarts can't cause repeated
  fetching, and a switch in Settings turns the whole thing off.
- **An "Updated" column in Orders**, showing how long ago each order was last refreshed from
  AliExpress, with the exact timestamp on hover. Sortable, so the stalest rows can be brought to
  the top.

### Fixed

- **Amounts in other currencies were left unconverted.** Conversion depended on a rate table that
  only existed after granting an optional permission, so totals in EUR, PLN, BRL and the rest were
  silently dropped from every figure. A 166-currency table is now bundled with the extension, so
  everything converts out of the box; granting the permission simply swaps in fresher rates, and
  Finance says which of the two it is using.
- Order status showed AliExpress's raw enum (`WAIT_BUYER_ACCEPT_GOODS`) whenever the API sent a
  code rather than a label.

---

## [1.1.1] — 2026-09-21

Makes the 1.1.0 features actually reachable: returns no longer need a setup step, and the service
worker can no longer fail to start.

### Fixed

- **Returns/refunds needed an invisible prerequisite.** The sync only worked if you had already
  visited Account → Returns/refunds in that browser, because it replayed a request shape captured
  from that page. With no shape recorded it did nothing at all and said nothing. It now builds both
  reverse-order requests itself, reusing the signing parameters of any AliExpress request it has
  seen, and only falls back to briefly opening the Returns page in a background tab — reporting
  that it is doing so — when the server refuses the synthesised call.
- **The service worker could fail to start entirely.** It was loaded through
  `service-worker-loader.js`, which imported a hash-named chunk that imported two more. Every
  rebuild renames those chunks, so a stale or half-written set left Chrome unable to start the
  worker: no syncing, and every dashboard button silently dead. The worker is now built as one
  self-contained classic script with a stable name and no module graph.

### Changed

- The build emits `dist/service-worker.js` directly; `npm run build` gained a postbuild step that
  verifies the worker is self-contained before rewriting the manifest.

---

## [1.1.0] — 2026-09-21

Shipping costs, "ordered at the same time" detection, and an end to buttons that fail silently.

### Added

- **Shipping, coupons and tax per order.** AliExpress's order list carries only a grand total; the
  breakdown exists solely on `mtop.aliexpress.trade.buyer.order.detail`. A new **Fetch shipping &
  fees** button in Finance walks every order (about 1.4 s apart, with live progress) and stores
  Subtotal, Shipping, Coins, coupons and Additional charges. "Free shipping" is recorded as zero
  rather than unknown, so the shipping share is finally real.
- **Checkout grouping ("shopping trips").** AliExpress splits one cart into a separate order per
  seller and allocates their ids consecutively — an observed step of exactly 20000 — while a
  different checkout jumps by roughly 1e11. Orders are clustered into trips by that numeric gap.
  Finance gains a **Checkouts** tile and an *Ordered at the same time* table (date, orders,
  sellers, items, total, shipping); Orders gains a **"1 of N ordered together"** chip that filters
  to that trip.
- **Background-health banner.** The dashboard reads IndexedDB directly, so every view keeps
  rendering even when the MV3 service worker is dead — buttons then do nothing at all. The
  dashboard now pings the worker and says so plainly instead of failing in silence.
- **Job progress in the UI.** Long fetches (shipping, refunds, tracking) report what they are doing
  and what they finished with, polled from the background job registry.
- Payment method is captured from the order detail page.

### Fixed

- **"Refresh rates" did nothing.** It never requested the optional `open.er-api.com` host
  permission it needs, so it failed invisibly and every non-USD order stayed unconverted. It now
  asks Chrome for access and reports the outcome.
- **"Fetch refunds" did nothing visible.** It started a background job and reported neither
  progress nor errors. Both buttons now surface every outcome, including "needs the extension".
- Shipping share always read 0 % because the data source had never been fetched.

### Changed

- Test fixtures use synthetic account data with the same structure as the real payloads.

---

## [1.0.0] — 2026-09-21

First build verified end to end against a live AliExpress account, and the first packaged for the
Chrome Web Store. Everything in 0.1.0 was written defensively but from memory; this release is what
survived contact with the real site.

### Added

- **Returns and refunds.** `queryReverseOrderPageListForBuyer` for the cases and
  `reverseOrderLineRenderForBuyer` for the money actually refunded, with status, reason and
  channel. Finance shows net spend, refunded totals and return reasons; cancelled orders are
  excluded from every figure and listed separately.
- **Themes.** Dark, white and off-white, with a free accent colour.
- **Detailed base maps.** Esri Dark / Streets / Satellite, switchable, over a bundled offline
  vector world so the map is never blank.
- **Parcel sidebar** on the map, item-count markers, routes drawn as travelled / inferred /
  projected, click-to-centre with zoom scaled to remaining distance, and a date input on the
  time scrubber.
- Item thumbnails throughout, and a Diagnostics panel in Settings showing learned endpoints and
  recent captures.

### Fixed

- **Tracking was never captured.** AliExpress's tracking API is `mtop.ae.ld.querydetail`, which no
  URL pattern matched. Tracking numbers are not in the order list at all and are now fetched per
  order.
- **Order list pagination is a POST** with the page index buried in nested JSON; the interceptor
  now records request bodies and replays them.
- **Pre-shipment scans** ("Your order's been created") were being read as "seller shipped". They
  are kept as events but are never milestones, and AliExpress's `AE_*` carrier codes are mapped.
- Fabricated delivery timestamps from completed orders were poisoning the estimator.
- OpenStreetMap tile servers return 403 to `chrome-extension://` pages, and CARTO began requiring
  an API key. Both were replaced.
- MV3 tore down the service worker during long message handlers; long work now runs as detached
  jobs with a keepalive.
- The listing badge injected up to 16 copies into nested and zero-width containers; it is now one
  line under the visible delivery estimate.
- A `map.closeTooltip()` call with no open tooltip threw and blanked the whole map view.

### Security / privacy

- Dropped the `tabs` permission.
- The page-facing diagnostics channel is off by default and enabled only for unpacked installs or
  an explicit setting.
- Published privacy policy: <https://elmagoct.github.io/parcel-intelligence/privacy.html>

---

## [0.1.0] — 2026-09-20

Initial build: the whole extension in one pass, ten phases, shipped working before the next began.

### Added

- **Passive ingest.** A `MAIN`-world script patches `fetch`, `XMLHttpRequest` and mtop JSONP
  callbacks and mirrors matching payloads to the service worker, so browsing your own orders is
  enough to collect them. No DOM scraping as the primary strategy.
- **Endpoint registry.** Every intercepted URL shape is recorded so background syncs replay real
  request shapes rather than hardcoded guesses.
- **Backfill wizard.** Opens the orders page in a managed tab, paginates with jitter until
  exhausted, survives the tab closing or the worker being killed, and trickles tracking history
  oldest first.
- **Cainiao poller.** State-based cadence (3 h / 8 h / 24 h / stop), three concurrent at most,
  jitter, exponential backoff and a global pause on repeated failure.
- **Adapter isolation.** Every AliExpress URL pattern, field vocabulary, selector and the mtop
  request signer live in `src/adapters/aliexpress.ts`; parsing is structural, so renamed fields
  degrade instead of throwing.
- **Estimation engine.** Remaining-time quantiles per (service, milestone), shrunk toward pooled
  data then a baseline prior with weight `n / (n + 8)`, reported as a P50–P80 band and compared
  with AliExpress's promise. Dwell distributions flag stalls past P90.
- **Views.** Map with time scrubber, timeline, alerts with a buyer-protection countdown, sortable
  orders, finance with export, and settings.
- **Optional LLM.** Your own Anthropic key, `claude-haiku-4-5`, three narrow jobs, permanently
  cached, hard daily budget, and fully functional without a key.

### Known at the time

- Not yet verified against a live account; endpoint names and DOM selectors were written from
  memory.

[1.4.1]: https://github.com/ElMagoCT/aliexpress-parcel-intelligence/releases/tag/v1.4.1
[1.4.0]: https://github.com/ElMagoCT/aliexpress-parcel-intelligence/releases/tag/v1.4.0
[1.3.0]: https://github.com/ElMagoCT/aliexpress-parcel-intelligence/releases/tag/v1.3.0
[1.2.0]: https://github.com/ElMagoCT/aliexpress-parcel-intelligence/releases/tag/v1.2.0
[1.1.1]: https://github.com/ElMagoCT/aliexpress-parcel-intelligence/releases/tag/v1.1.1
[1.1.0]: https://github.com/ElMagoCT/aliexpress-parcel-intelligence/releases/tag/v1.1.0

> 0.1.0 and 1.0.0 were built before this repository existed, so they have no tags — their entries
> above are the record of what changed. Every release from 1.1.0 on is tagged.
