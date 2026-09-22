/**
 * Point the manifest at the standalone service worker and drop CRXJS's loader indirection.
 *
 * `vite.sw.config.ts` builds the whole worker into one self-contained IIFE at public/service-worker.js,
 * which Vite copies to dist/. CRXJS separately re-bundles it behind `service-worker-loader.js` +
 * a hash-named chunk. Every rebuild renames that chunk, so a stale or half-written loader/chunk pair
 * leaves Chrome unable to start the worker at all — the extension then goes quiet, with no syncing
 * and every dashboard button dead. One stable file removes that whole class of failure.
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const WORKER = 'service-worker.js';
const workerPath = join(dist, WORKER);
if (!existsSync(workerPath)) { console.error(`postbuild: ${workerPath} missing — did vite.sw.config.ts run?`); process.exit(1); }

const code = readFileSync(workerPath, 'utf8');
const relImports = [...code.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)].map((m) => m[1]);
if (relImports.length) { console.error(`postbuild: worker is not self-contained (${relImports.slice(0, 3).join(', ')})`); process.exit(1); }

const manifestPath = join(dist, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const loaderRel = manifest.background?.service_worker;

// Drop the loader and the chunk it pointed at.
if (loaderRel && loaderRel !== WORKER) {
  const loaderPath = join(dist, loaderRel);
  if (existsSync(loaderPath)) {
    for (const m of readFileSync(loaderPath, 'utf8').matchAll(/import\s+['"](.+?)['"]/g)) {
      rmSync(join(dist, m[1].replace(/^\.\//, '')), { force: true });
    }
    rmSync(loaderPath, { force: true });
  }
}
// Vite copies public/ to the dist root, and CRXJS also emits a public/ copy for manifest-referenced
// paths — so the 418 kB worker would ship twice. The manifest points at the root one.
rmSync(join(dist, 'public', WORKER), { force: true });
manifest.background = { service_worker: WORKER }; // classic script: no module graph that can go stale
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`postbuild: background.service_worker → ${WORKER} (${(Buffer.byteLength(code) / 1024).toFixed(0)} kB, self-contained)`);
