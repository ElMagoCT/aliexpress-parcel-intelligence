// Standalone dashboard preview (no extension context): `npm run preview:dashboard`
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  root: 'src/dashboard',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5198, strictPort: true, open: false },
  define: { 'process.env': {} },
});
