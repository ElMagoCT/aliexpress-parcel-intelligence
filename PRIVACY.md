# Privacy Policy — AliExpress Parcel Intelligence

_Last updated: 2026-09-20_

AliExpress Parcel Intelligence is a browser extension that shows you your own AliExpress orders,
parcels and spending on a map and dashboard. It is built around one rule: **your data never
leaves your browser.**

## What the extension reads

While you are signed in to AliExpress in your own browser, the extension reads the order,
tracking and returns/refunds information that AliExpress already sends to your browser (order
list, order tracking detail, returns/refunds list). On product pages it reads the shipping
options shown to you in order to display a delivery estimate next to them.

## Where it is stored

Everything is stored locally in your browser profile (IndexedDB and `chrome.storage.local`).
Nothing is uploaded to the developer or to any third party. There is no account, no analytics,
no telemetry and no remote code.

## Network requests the extension makes

- **aliexpress.com / aliexpress.us** — the same order and tracking endpoints your browser
  already uses, with your own session, to refresh your orders and parcels.
- **global.cainiao.com** — public parcel tracking lookups by tracking number (fallback).
- **Map tiles** from Esri's public tile services (server.arcgisonline.com) to draw the base map.
  Tile requests contain only the map area being viewed.

Optional, **off by default and only if you enable them in Settings**:

- **nominatim.openstreetmap.org** — geocoding of scan location names the bundled gazetteer
  does not know (place names only, one request per second).
- **open.er-api.com** — weekly exchange rates so spend can be shown in one currency.
- **api.anthropic.com** — if you enter your own Anthropic API key, unrecognised scan texts and
  location names, and the on-demand "Explain this parcel" button, are sent to the model. Your key
  is stored only in `chrome.storage.local` and is never synced or transmitted anywhere else.

## What the developer receives

Nothing. The developer has no server and receives no data from the extension.

## Data control

Settings provides full export to JSON, import, and a **Wipe everything** button that deletes all
locally stored data. Uninstalling the extension deletes its storage.

## Contact

Questions: open an issue on the project's repository or email the developer address listed on the
Chrome Web Store page.


Published at: https://elmagoct.github.io/parcel-intelligence/privacy.html
