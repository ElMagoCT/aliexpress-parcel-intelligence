import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.config';

export default defineConfig({
  define: { __AEPI_BUILD__: JSON.stringify(new Date().toISOString()) },
  plugins: [react(), crx({ manifest })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { dashboard: 'src/dashboard/index.html' },
    },
  },
  server: { port: 5199, strictPort: true, hmr: { port: 5199 } },
});
