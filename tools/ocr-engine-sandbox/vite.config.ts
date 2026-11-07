import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const repository = path.resolve(root, '../..');
const local = path.join(repository, 'receipt-regression.local/engine-comparison');
const manifest = JSON.parse(readFileSync(path.join(local, 'assets/manifest.json'), 'utf8'));
const assets = new Map<string, { file: string; type: string }>(manifest.assets.map((a: { name: string }) => [a.name, { file: path.join(local, 'assets', a.name), type: a.name.endsWith('.js') ? 'text/javascript' : a.name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' }]));
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) assets.set(name, { file: path.join(root, 'node_modules/onnxruntime-web/dist', name), type: name.endsWith('.mjs') ? 'text/javascript' : 'application/wasm' });
export default defineConfig({
  root, publicDir: false, cacheDir: path.join(root, '.vite'),
  define: { __FROZEN_MODULE_BASE__: JSON.stringify('/@fs/' + path.join(local, 'control-source/src/lib/').replace(/\\/g, '/') + '/') },
  server: { host: '127.0.0.1', port: 8082, strictPort: true, watch: null,
    fs: { allow: [root, path.join(local, 'control-source/src/lib'), path.join(repository, 'node_modules')], deny: ['**/.git/**', '**/.env*', '**/first-four/**', '**/browser-profile/**'] } },
  plugins: [
    { name: 'local-pinned-engine-assets', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = /^\/(?:engine-assets|ort-assets)\/([^/?]+)(?:\?.*)?$/.exec(request.url ?? '');
        if (!match) return next();
        const asset = assets.get(match[1]!);
        if (!asset || request.method !== 'GET') { response.statusCode = 403; response.end(); return; }
        response.setHeader('Content-Type', asset.type);
        response.setHeader('Cache-Control', 'no-store');
        response.end(readFileSync(asset.file));
      });
    } },
    { name: 'sandbox-never-production', apply: 'build', buildStart() { throw new Error('OCR engine sandbox is local-only and must not be built into production.'); } },
  ],
});
