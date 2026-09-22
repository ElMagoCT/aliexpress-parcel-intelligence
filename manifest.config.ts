import { defineManifest } from '@crxjs/vite-plugin';

/** MV3 manifest. All AliExpress-specific match patterns are mirrored in src/adapters/aliexpress.ts. */
export default defineManifest({
  manifest_version: 3,
  name: 'Parcel Intelligence',
  description:
    'Every parcel you order, from any store, on one map — with delivery estimates from your own history. All data stays local.',
  version: '1.4.1',
  minimum_chrome_version: '116',
  icons: { 16: 'public/icon16.png', 32: 'public/icon32.png', 48: 'public/icon48.png', 128: 'public/icon128.png' },
  action: { default_title: 'Parcel Intelligence', default_popup: 'src/popup/index.html', default_icon: { 16: 'public/icon16.png', 32: 'public/icon32.png', 48: 'public/icon48.png' } },
  // Prebuilt single file (vite.sw.config.ts) rather than a chain of hash-named chunks — see that file.
  background: { service_worker: 'public/service-worker.js' },
  // activeTab lets the popup read the page you are looking at, only when you click the icon.
  permissions: ['storage', 'unlimitedStorage', 'alarms', 'notifications', 'scripting', 'cookies', 'activeTab'],
  host_permissions: [
    '*://*.aliexpress.com/*',
    '*://*.aliexpress.us/*',
    '*://global.cainiao.com/*',
    '*://*.cainiao.com/*',
  ],
  optional_host_permissions: [
    'https://nominatim.openstreetmap.org/*',
    'https://api.anthropic.com/*',
    'https://open.er-api.com/*',
  ],
  // The MAIN-world interceptor (public/interceptor.iife.js) is registered at runtime by the
  // service worker with chrome.scripting — see src/background/index.ts (registerInterceptor).
  content_scripts: [
    {
      // ISOLATED world: bridges postMessage → service worker, drives backfill, injects listing badges.
      matches: ['*://*.aliexpress.com/*', '*://*.aliexpress.us/*'],
      js: ['src/content/bridge.ts'],
      run_at: 'document_start',
      all_frames: true,
    },
  ],
  web_accessible_resources: [
    { resources: ['src/dashboard/index.html', 'public/interceptor.iife.js'], matches: ['*://*.aliexpress.com/*', '*://*.aliexpress.us/*'] },
  ],
});
