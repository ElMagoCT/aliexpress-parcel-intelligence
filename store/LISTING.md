# Chrome Web Store listing — everything you need

Folder contents:

| File | Use |
|---|---|
| `parcel-intelligence-1.1.1.zip` | Upload as the package (Store dashboard → Package → Upload new package). Built from `dist/`, manifest at the zip root. |
| `icon-128.png` | Store icon (128×128 PNG, required). `icon-512.png` is a hi-res source if you want to edit it. |
| `screenshots/1-map.png … 5-orders.png` | Screenshots, 1280×800 PNG (Store accepts 1280×800 or 640×400; up to 5). Upload in this order. |
| `promo-small-440x280.png` | Small promo tile (440×280). Optional but shown in search/category pages. |
| `promo-marquee-1400x560.png` | Marquee promo tile (1400×560). Optional; needed to be featured. |
| `PRIVACY.md` | Local copy of the policy. **It is already published** at https://elmagoct.github.io/parcel-intelligence/privacy.html — paste that into the "Privacy policy" field. |
| `assets-src/` | Editable sources (icon SVG, promo HTML). |

## One-time setup

1. Developer account: https://chrome.google.com/webstore/devconsole — one-time $5 registration fee, must verify your email. Use the Google account you want to publish under (a dedicated one is fine).
2. Privacy policy is already live at https://elmagoct.github.io/parcel-intelligence/privacy.html (repo: https://github.com/ElMagoCT/parcel-intelligence).
3. In the dev console: **New item** → upload the zip.

## Store listing fields (copy/paste)

**Name** (max 45): `AliExpress Parcel Intelligence`

**Summary** (max 132):
`See every AliExpress parcel on a map, get delivery estimates learned from your own history, and track spend. 100% local.`

**Homepage URL:** `https://elmagoct.github.io/parcel-intelligence/`

**Privacy policy URL:** `https://elmagoct.github.io/parcel-intelligence/privacy.html`

**Category:** Shopping (alternative: Productivity)

**Language:** English

**Description:**

```
Every parcel you've ordered on AliExpress, on one map — with delivery estimates that come from
YOUR delivery history, not AliExpress's optimistic promise.

WHAT IT DOES
• Map: every active parcel at its last known position, the route it has travelled, and the
  projected remainder to your door. Consolidated shipments (several orders in one box) show as one.
• Delivery estimates: a P50–P80 window per parcel, re-estimated on every scan, built from how
  long your past parcels actually took from the same stage with the same carrier. Compared
  side-by-side with AliExpress's promised date.
• Timeline: all in-transit parcels as bars sorted by expected arrival.
• Alerts: stalled parcels, exceptions, running-late warnings, and a buyer-protection countdown
  so you never miss the window to open a dispute.
• Finance: lifetime spend, spend by month, seller and category, shipping share, refunds and
  cancellations, average order value, CSV/JSON export. Multi-currency.
• On product pages: "Your history: 14–24 days" next to each shipping option, based on your
  own parcels with that carrier.
• Themes: dark, white, off-white, and any accent colour.

HOW IT WORKS
While you browse your AliExpress orders (signed in, in your own browser), the extension reads
the same order and tracking data AliExpress shows you and keeps a local copy. A one-click
Backfill walks your whole order history. Everything is stored in your browser — no account,
no server, no telemetry.

OPTIONAL
Bring your own Anthropic API key to classify unusual carrier scan text, geocode odd location
names, or get a plain-language explanation of a parcel's journey. Off by default; the extension
is fully functional without it.

PRIVACY
Your data never leaves your browser. See the privacy policy for the complete list of network
requests (AliExpress itself, Cainiao public tracking, map tiles, and the optional services above).

Not affiliated with AliExpress, Alibaba or Cainiao.
```

## Privacy practices tab (required answers)

**Single purpose description:**
`Displays the user's own AliExpress orders and parcel tracking on a local map/dashboard with delivery estimates and spend analytics.`

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage`, `unlimitedStorage` | Stores the user's order, parcel and scan history locally (IndexedDB / chrome.storage). Histories of a few hundred orders exceed the default quota. |
| `alarms` | Schedules periodic background refresh of orders and parcel tracking. |
| `notifications` | Notifies the user of deliveries, stalled parcels and approaching buyer-protection deadlines. |
| `scripting` | Registers the main-world script that mirrors AliExpress' own order/tracking JSON responses so the extension never has to scrape the page. |
| `cookies` | Reads the `_m_h5_tk` token cookie on aliexpress.com, which is required to sign AliExpress API requests when refreshing orders in the background with the user's own session. |
| Host `*://*.aliexpress.com/*`, `*://*.aliexpress.us/*` | Reading the user's own order and tracking data on AliExpress, injecting the delivery-estimate badge on product pages. |
| Host `*://global.cainiao.com/*`, `*://*.cainiao.com/*` | Public parcel tracking lookups by tracking number. |
| Optional hosts (nominatim.openstreetmap.org, open.er-api.com, api.anthropic.com) | Requested at runtime only when the user enables geocoding, currency conversion or the LLM helper in Settings. |

**Remote code:** No, I am not using remote code. (All code is in the package; map tiles are images.)

**Data usage — what is collected:** tick **"Website content"** and **"Personally identifiable information"**? → Recommended: tick **Website content** (order/tracking data read from aliexpress.com) and **Financial and payment information** is *not* collected (order totals are read but never transmitted — the disclosure is about data *sent to the developer or third parties*). If the reviewer's form insists on listing handled data, state that all data stays on-device.

**Certifications (tick all three):**
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

## Distribution

- Visibility: Public (or Unlisted while you test with friends).
- Regions: all.
- Pricing: free.

## Before you submit — checklist

- [ ] Load `dist/` unpacked in a fresh Chrome profile once and click through Map, Timeline, Finance, Settings; open aliexpress.com and confirm orders arrive.
- [x] Privacy policy URL is live: https://elmagoct.github.io/parcel-intelligence/privacy.html
- [ ] `manifest.json` version is `1.1.1` (bump for every future upload; see CHANGELOG.md).
- [ ] Review takes ~1–3 business days for a first submission; `cookies` + broad host permissions usually trigger a manual review — the justifications above address it.

## Source

Public repository: https://github.com/ElMagoCT/aliexpress-parcel-intelligence
Revision history: https://github.com/ElMagoCT/aliexpress-parcel-intelligence/blob/main/CHANGELOG.md

## Updating later

`npm run build`, then `cd dist && zip -r ../release.zip .`, bump `version` in `manifest.config.ts` first.
