// Builds the service worker as ONE self-contained classic script.
//
// CRXJS otherwise emits a `service-worker-loader.js` that imports a hash-named chunk, which in turn
// imports more hash-named chunks. Every rebuild renames them, so a reload that races a rebuild — or
// any stale loader — leaves Chrome unable to start the worker at all, and the whole extension goes
// quiet with no obvious cause. One file with a stable name removes that entire class of failure.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  define: { __AEPI_BUILD__: JSON.stringify(new Date().toISOString()) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: false,
    minify: true,
    target: 'es2022',
    lib: { entry: 'src/background/index.ts', name: 'aepiServiceWorker', formats: ['iife'], fileName: () => 'service-worker.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
