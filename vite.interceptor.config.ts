// Builds the MAIN-world interceptor as a single self-contained IIFE (no dynamic imports —
// those resolve against the page origin in the main world and 404). The service worker
// registers public/interceptor.iife.js via chrome.scripting.registerContentScripts.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: false,
    minify: true,
    target: 'es2020',
    lib: { entry: 'src/content/interceptor.ts', name: 'aepiInterceptor', formats: ['iife'], fileName: () => 'interceptor.iife.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
