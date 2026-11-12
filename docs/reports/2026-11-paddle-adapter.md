# Batch 2b: PaddleOCR adapter (dev-only), model self-hosting, Tesseract self-hosting

**Branch:** `engine-eval` (PR #4). **Dates:** 10–11 Nov 2026. **Status:** Phase 2b complete.
Paddle is wired in as a **dev-only** challenger engine behind `?engine=paddle`; Tesseract is still
the only engine in production builds. Phase 2c (the comparison run) has **not** been started.

> **Superseded, 11 Nov 2026: Paddle removed.** Paddle did not replace Tesseract in the Phase 2c
> comparison (docs/reports/2026-11-engine-comparison.md §6), and the owner had it removed on
> `cleanup/remove-paddle`. Everything Paddle-specific in this report (adapter, worker, models,
> packages, engine switch, build variable, Vite plugin) no longer exists. The Tesseract
> self-hosting in §8 is unchanged and still current. This report is kept as a record.

## Update 2026-11-11: merged with `main`, Paddle files out of production builds

This section supersedes the earlier text where they differ (notably §4's note that the model
archives ship with every build, and §9 items 2, 3 and 7).

**Merge.** `origin/main` (Batch D deploy, PR #3; canvas-blocked fix, PR #5) was merged into
`engine-eval` as a merge commit (no rebase). Conflicts:
- `ScanStep.tsx`: both imports kept (`CANVAS_BLOCKED_MESSAGE` and `engineFactoryFor`); the canvas
  probe in `scan.ts` runs for either engine.
- `AGENTS.md`, `docs/MODULES.md`: both sides' notes and rows kept.
- `bun.lock`: regenerated, not hand-merged: main's lockfile + `bun install` (Bun 1.4.4) against the
  merged `package.json`. The result has exactly the packages and versions engine-eval had, with
  the 14 Lovable-mirror (`europe-west4-npm.pkg.dev`) URLs gone. All 615 package integrity hashes
  were checked against `registry.npmjs.org` (615 match, 0 mismatches). A frozen install from an
  empty cache in a fresh clone succeeds (see the PR).

**Decision b: Paddle files only with the switch on** (DECISIONS.md, 11 Nov 2026).
- The model archives moved from `public/paddle/` to `paddle-models/` (same bytes and hashes).
- `vite.config.ts` plugin `splitlah:paddle-models` serves them at `/paddle/` in `npm run dev` and
  copies them into the client output only when the switch is compiled in (same condition as
  `engine-select.ts`). Paddle code, worker and ONNX Runtime were already absent without the switch.
- Cloudflare build variables apply to every branch, so the switch is refused on the production
  branch: `engineSwitchForBuild` (tested) returns "blocked" when `WORKERS_CI_BRANCH` is `main`, and
  the plugin compiles `VITE_SPLITLAH_ENGINE_SWITCH` as "" for that build. Owner steps for preview
  builds are in docs/DEPLOY.md, "Builds with Paddle on".

| Build (`npm run build`, this branch) | Static (`.output/public`) | Files | Worker (`.output/server`) | Paddle files |
|---|---:|---:|---:|---|
| Production (no switch) | 11,610,781 B | 15 | 1,774,548 B (upload 1,732.59 KiB, gzip 386.95 KiB) | none |
| Before this update (no switch) | 33,156,806 B | | 1,775,242 B | 2 model archives |
| Switch on (`VITE_SPLITLAH_ENGINE_SWITCH=on`) | 66,257,249 B | | 1,782,987 B | archives 21,544,960 B + `paddle.worker` 10,526,306 + ORT `.wasm` 11,210,254 + `.mjs` 20,856 + SDK `worker-entry` 11,341,486 (never loaded) + adapter chunks |
| Switch requested, `WORKERS_CI_BRANCH=main` | identical to production (`diff -r` of `.output/public`: no differences) | | | none |

The only Paddle mention left in a production build is a source comment in the SSR routes chunk.

**Smoke tests (11 Nov)**, synthetic receipt (invented text, 3 items, total 23.38) rendered onto a
canvas in headless Chrome; Chrome ran with `--no-proxy-server` and
`--host-resolver-rules=MAP * ~NOTFOUND` (localhost excepted); probe fetches to jsDelivr and Paddle's
official model host failed. Served with `npx wrangler@4.154.0 dev --config cloudflare/wrangler.jsonc`
(headers on, main's current CSP).

| Build, URL | Engine files requested | Result | Scan time |
|---|---|---|---:|
| Switch on, `/?engine=paddle` | same-origin only: adapter, `paddle.worker`, both `/paddle/*.tar`, ORT `.mjs`/`.wasm` | 3 items, "Matches the receipt total exactly", split into 2 people and summary OK, 0 CSP violations | 9.5 s |
| Switch on, `/` (Tesseract) | `/tesseract/…` only | same result, 0 CSP violations | 3.4 s |
| Production, `/?engine=paddle` | `/tesseract/…` only (switch ignored); `/paddle/PP-OCRv5_mobile_det.tar` → 404 | same result | 3.3 s |
| `npm run dev`, `/?engine=paddle` | models served by the plugin (SHA-256 matches) | same result | 10.4 s |

The only external request the app made was its Google Fonts stylesheet (blocked by the test
network; not engine-related). Not verified: a real Cloudflare preview build (needs the dashboard
variable), phones, Safari, Firefox.

**Decision c: pins.** `@paddleocr/paddleocr-js` `0.4.2` and `onnxruntime-web` `1.22.0`, exact.
`bun.lock` has one `onnxruntime-web` entry, 1.22.0, which also satisfies the SDK's `^1.22.0`. The
pin test now also fails if a nested copy appears under the SDK.

**Decision d: load limit.** Paddle keeps 120 s, still PROVISIONAL until the Phase 2c phone timings.

**CSP.** Not changed on this branch. Dropping jsDelivr and `blob:` is a separate PR
(`security/csp-tighten`) that depends on this one.

**Checks on the merged branch:** `tsc --noEmit`, `vitest run` (291 tests), `eslint src/lib/scan`,
`vite build`, `receipts:test` (29 tests) and the Wrangler dry-run all pass.

## 1. Summary

- **Owner decisions applied (11 Nov 2026)**, recorded in `docs/DECISIONS.md`: SDK added at exactly
  `@paddleocr/paddleocr-js@0.4.2`, WASM-only runtime; models only from the app's own origin; Paddle in
  a Web Worker; Paddle load limit 120 s (provisional), Tesseract keeps 60 s; dev-only switch; no
  parser-v2 UI/storage features for the MVP.
- **Adapter implemented**: `paddle-engine.ts` (behind `OcrEngine`, reached only through `import()`),
  `paddle-runtime.ts` + `paddle.worker.ts` (SDK in the app's own module worker), `paddle-assets.ts`
  (pins and settings), `engine-select.ts` (dev switch). No parser change (D5).
- **Contract tests**: 20 tests with a fake SDK and an in-process worker running the real worker-side
  code (§5). All pass.
- **Real Paddle OCR smoke test**: a computer-rendered synthetic receipt scanned in headless Chrome
  with every external host unresolvable. It reconciled exactly (3 items, total 23.38). **Cold
  ≈ 8.9 s, warm ≈ 8.9 s** on a desktop over localhost; Tesseract on the same harness 3.9 s / 3.6 s
  (§6).
- **Initial client bundle**: no Paddle code. The production entry chunk is byte-identical apart from a
  chunk-name hash; the routes chunk grows by **50 bytes** (the generic per-engine load limit in
  `scan.ts`) (§4).
- **Deploy size**: production build 33.16 MB static + 1.77 MB Worker (the Paddle wiring adds only
  those 50 bytes; the model archives were already committed). A switch-enabled build is 66.26 MB.
  Largest file 16.7 MB (15.9 MiB): every file is under Cloudflare's 25 MiB limit (§4).
- **CSP** (not edited): jsDelivr and `blob:` can be dropped; Paddle needs neither (§7).

## 2. Measured sizes (scratch measurements, 10 Nov)

Measured in `/tmp/paddle-measure` (outside the repo) from `npm ci` of the sandbox's
`package.json` + `package-lock.json`, and a scratch Vite 8 build whose entry reaches Paddle only via
`import()`. Gzip level 9 and brotli quality 11, both measured with Node zlib.

### Install (developer machine)

| Item | Size |
|---|---:|
| `node_modules` after `npm ci` (23 packages) | 137.2 MB |
| of which `onnxruntime-web` 1.22.0 | 94.0 MB |
| `@paddleocr/paddleocr-js` 0.4.2 (unpacked; registry `unpackedSize` agrees) | 23.8 MB |
| `@techstark/opencv-js` 4.10.0-release.1 | 11.8 MB |

### What a browser downloads on the first Paddle scan

| File (scratch build) | Raw | gzip | brotli | Notes |
|---|---:|---:|---:|---|
| SDK + OpenCV.js chunk | 10,473,650 | 3,405,014 | 2,480,148 | OpenCV.js alone is 10,378,215 |
| ONNX Runtime JS, default bundle (`ort.bundle.min`) | 390,727 | 104,605 | 88,052 | What the SDK's `import("onnxruntime-web")` resolves to |
| ONNX Runtime WASM, default (`ort-wasm-simd-threaded.jsep.wasm`) | 21,872,216 | 5,121,037 | 3,037,447 | Includes WebGPU (JSEP) support |
| Lazy entry stub | 801 | 430 | 389 | |
| PP-OCRv5 mobile **det** model archive (.tar) | 4,843,520 | not measured | not measured | Owner's sandbox record (PROVENANCE.md, SHA-256 `781056…bc30`) |
| PP-OCRv5 mobile **rec** model archive (.tar, includes the character dictionary in its config) | 16,701,440 | not measured | not measured | Owner's sandbox record (SHA-256 `f7e792…ba8c`) |
| **Total, default build** | **54,282,354** | **≈ 30.18 MB** | **≈ 27.15 MB** | Models counted uncompressed |

WASM-only variant (Vite alias `onnxruntime-web` → its `ort.wasm.bundle.min.mjs` export; the SDK
code is unchanged):

| File | Raw | gzip | brotli |
|---|---:|---:|---:|
| ONNX Runtime JS (`ort.wasm.bundle.min`) | 46,274 | 14,773 | 13,298 |
| ONNX Runtime WASM (`ort-wasm-simd-threaded.wasm`) | 11,210,254 | 2,892,500 | 1,838,155 |
| SDK + OpenCV.js, stub, models | as above | | |
| **Total, WASM-only** | **43,275,949** | **≈ 27.86 MB** | **≈ 25.88 MB** |

Which WASM file is fetched was worked out from the bundles (the default bundle references
`ort-wasm-simd-threaded.jsep.wasm`; the WASM-only bundle references `ort-wasm-simd-threaded`); it
was **not observed in a browser** here, because model loading can't start without the model files.

### Deploy size (static assets) and limits

- The build also emits the SDK's `worker-entry-*.js` (11,341,486 bytes), even with `worker: false`,
  because the SDK references it with `new URL(…)`. With models self-hosted the added deploy size is
  **≈ 65.6 MB** (default) or **≈ 54.6 MB** (WASM-only). Tesseract self-hosting adds 10.98 MB.
- Cloudflare Workers static assets (official limits page, fetched 10 Nov 2026): **25 MiB per file**,
  20,000 files (Free) / 100,000 (Paid). The largest Paddle file is 21.87 MB (20.9 MiB), so every file
  fits. The same page gives a 64 MiB uncompressed limit for the Worker bundle itself.
- **Risk:** the SSR build already bundles `tesseract.js` into the server output
  (`.output/server/_libs/tesseract.js+unenv.mjs`, 28.7 kB) although only the browser calls it. If
  Paddle's 10.5 MB SDK chunk is pulled into the server bundle the same way, the Worker grows by that
  much. When wiring, check the server output and keep the SDK out of SSR.

### Initial bundle

Scratch build: the entry chunk is 2,052 bytes and holds only `import("./paddle-entry")`; everything
Paddle-related is in lazy chunks. The app's current client entry (`index-*.js` 403.3 kB, routes
112.0 kB, lazy Tesseract chunk 19.0 kB) was unchanged at the time because nothing was wired (see §4 for the measured result).
The adapter must reach the SDK only through `import()` inside `load`, like the Tesseract adapter.

### Hosts reachable from this sandbox

| Host | Result |
|---|---|
| registry.npmjs.org | reachable: packages, integrity and signatures checked |
| paddle-model-ecology.bj.bcebos.com (official model archives) | **blocked (proxy 403)**; model sizes not re-measured |
| huggingface.co (official model cards) | **blocked (proxy 403)** |
| cdn.jsdelivr.net | **blocked (proxy 403)** |

Third-party npm packages that repackage PaddleOCR models exist; I did not use them, as they are not
the official source.

## 3. Licences and provenance

| Component | Version | Licence | Integrity / signature (checked here) |
|---|---|---|---|
| `@paddleocr/paddleocr-js` | 0.4.2 | Apache-2.0 | sha512 `vpwSaF…3EQ==` matches the sandbox lockfile; npm registry signature valid |
| `onnxruntime-web` (+ `onnxruntime-common`) | 1.22.0 | MIT | sha512 matches lockfile; signature valid |
| `@techstark/opencv-js` | 4.10.0-release.1 | Apache-2.0 | signature valid |
| `clipper-lib` | 6.4.2 | BSL-1.0 (package says "BSL") | lockfile |
| `js-yaml` / `argparse` | 4.1.0 / 2.0.1 | MIT / Python-2.0 | lockfile |
| `protobufjs`, `long`, `flatbuffers`, `guid-typescript`, `platform` | lockfile | BSD-3-Clause, Apache-2.0, Apache-2.0, ISC, MIT | lockfile |
| PP-OCRv5_mobile_det / _rec | — | Apache-2.0 (official model cards, per sandbox PROVENANCE) | not re-checked: host blocked |

Note: the SDK's built-in default for ONNX Runtime files points at jsDelivr
`onnxruntime-web@1.24.3`, while its dependency range resolves to 1.22.0 in the lockfile. The
adapter must set `ortOptions.wasmPaths` to self-hosted files that match the installed version
(the sandbox did this).

## 3a. Implementation

Design as planned in the earlier version of this report, with these choices:

| Piece | What it does |
|---|---|
| `engine-select.ts` | `ENGINE_SWITCH_ENABLED = import.meta.env.DEV \|\| import.meta.env.VITE_SPLITLAH_ENGINE_SWITCH === "on"` (build-time constants). `engineFactoryFor()` reads `location.search` only when enabled and returns a lazy engine for `?engine=paddle`; otherwise `undefined` (Tesseract). The lazy engine `import()`s `paddle-engine.ts` on first `load`, and prefixes its statuses with `[dev]` so a developer sees which engine runs. |
| `paddle-engine.ts` | Main-thread `OcrEngine`: creates `new Worker(new URL("./paddle.worker.ts", import.meta.url), { type: "module" })`, sends `load`/`recognize` requests with ids, rejects all pending requests on `terminate()` or a worker crash. `terminate()` ends the worker (real cancellation, frees all SDK memory), is idempotent and safe during `load`/`recognize`. `loadTimeoutMs = 120000`. |
| `paddle-runtime.ts` | Worker-side handler, SDK injected: `PaddleOCR.create({... worker: false, initialize: false, ortOptions: { backend: "wasm", numThreads: 1, simd: true, wasmPaths } })`, `initialize()`, then `predict` with the fixed "Paddle960" settings. The image input is always disposed. |
| `paddle.worker.ts` | Imports the SDK dynamically; decodes the Blob with `createImageBitmap` + `OffscreenCanvas` into an OpenCV Mat (the SDK's own Blob path needs a DOM canvas, which workers lack). ONNX Runtime's `.mjs` glue and `.wasm` are emitted by Vite from the installed `onnxruntime-web` via `new URL(…, import.meta.url)`, so they always match the runtime JS and are same-origin. |
| `scan.ts` / `types.ts` | `OcrEngine.loadTimeoutMs?` (optional, additive). The load race uses it; the overall scan limit grows by the extra load time, so recognition keeps its budget. Tesseract sets nothing: 60 s as before. |
| `vite.config.ts` | Alias `onnxruntime-web` → `onnxruntime-web/wasm` (WASM-only bundle). |
| `ScanStep.tsx` | One change: passes `engineFactoryFor()` to `scanReceipt`. In production this compiles to `undefined`. |
| `package.json` | `@paddleocr/paddleocr-js: "0.4.2"` and `onnxruntime-web: "1.22.0"` (exact). onnxruntime-web is the version the SDK already resolves to; it is pinned directly because the alias and worker reference its files, and a test checks both pins against `node_modules`. |

Word boxes: each Paddle segment becomes one `OcrWord` (polygon → bbox, score 0..1 → confidence
0..100, empty text dropped, text unchanged); `OcrPage.text` is the segments top-to-bottom, then
left-to-right. `layout.ts` turned them into the same rows as Tesseract's in the smoke test.

### How to run Paddle (developers only)

- `npm run dev`, then open `/?engine=paddle` (verified: same result as below).
- Or a preview build: `VITE_SPLITLAH_ENGINE_SWITCH=on npm run build`. **Never set this variable for
  the production deploy.** Without it, `?engine=paddle` is ignored and nothing Paddle is built.

## 3b. Adapter design notes (written before implementation, 10 Nov)

Implements `OcrEngine` from `types.ts`. No parser change (D5).

**`createPaddleEngine(): OcrEngine`**, `name: "paddle"`.

- **`load(onProgress)`**
  - `const { PaddleOCR } = await import("@paddleocr/paddleocr-js")`: dynamic import only.
  - `PaddleOCR.create({ lang: "en", ocrVersion: "PP-OCRv5", textDetectionModelName: "PP-OCRv5_mobile_det", textRecognitionModelName: "PP-OCRv5_mobile_rec", textDetectionModelAsset: { url: "/paddle/<ver>/PP-OCRv5_mobile_det.tar" }, textRecognitionModelAsset: { url: "/paddle/<ver>/PP-OCRv5_mobile_rec.tar" }, textDetectionBatchSize: 1, textRecognitionBatchSize: 1, ortOptions: { backend: "wasm", numThreads: 1, simd: true, wasmPaths: "/paddle/<ver>/ort/" }, initialize: false, worker: <see below> })`, then `await ocr.initialize()`.
  - Model and runtime URLs are same-origin and pinned (self-hosting, brief 2b step 5), with a
    SHA-256 manifest and test like `tesseract-assets.ts`. No CDN fallback.
  - The SDK reports no download progress, so progress is reported per phase ("Loading text
    recogniser", "Loading models", "Ready").
  - Check `dead` after each await, so a `terminate()` during load stops the engine (same pattern as
    Tesseract).
- **`recognize(image, layout)`**
  - `const [res] = await ocr.predict(image, { textDetLimitSideLen: 960, textDetLimitType: "max", textDetMaxSideLimit: 4000, textDetThresh: 0.3, textDetBoxThresh: 0.6, textDetUnclipRatio: 2, textRecScoreThresh: 0 })`.
    These are the "Paddle960" settings from the sandbox; `predict` accepts a `Blob`.
  - The image is the one `scan.ts` already prepared (rotation, crop, flattening, pixel budget), so
    both engines see the same pixels.
  - `layout` has no Paddle equivalent (Paddle detects text lines, not page modes). It is ignored,
    except that `"sparse"` (used for orientation probes) may use the same settings.
- **Word boxes.** Each `res.items[i]` is `{ poly: [x, y][], text, score }`, usually a text segment
  rather than a single word. Map it to `OcrWord`:
  - `bbox` = min/max of the polygon's x and y;
  - `confidence = score × 100`, so it is on Tesseract's 0–100 scale (`scan.ts` orientation scoring
    uses `> 70`);
  - `text` unchanged.

  `layout.ts` `groupRows` / `rowText` already group boxes into rows and mark wide gaps as column
  breaks, so segments work as "words". `OcrPage.text` = items in reading order (top-to-bottom, then
  left-to-right), joined with newlines, as the fallback when there are no boxes. No text repair in
  the adapter. parser-v2's `adapter.ts` (geometry-only, shared skew) is a candidate if `groupRows`
  proves weaker on Paddle boxes, but only on evidence from the 2c run.
- **`terminate()`**: sets `dead`, then `await ocr.dispose()` (frees ONNX sessions and OpenCV mats).
  Safe to call twice, and while `load` or `recognize` is in flight: dispose runs once the in-flight
  call settles.
- **Cancellation and timeout.** `predict` takes no `AbortSignal`. `scan.ts` already races each stage
  against the signal and its timeouts, and calls `terminate()`, so the user sees "cancelled" or
  "timed out" at once. But:
  - With `worker: false` (what the sandbox measured), inference runs **on the main thread**, cannot
    be interrupted, and can freeze the UI for seconds on a phone.
  - With `worker: true`, the SDK's `WorkerBackedPaddleOCR` runs in a Web Worker, so the UI stays
    responsive. `terminate()` → `dispose()` ends the worker, which is real cancellation. The cost is
    that its 11.3 MB `worker-entry` bundle replaces the main-thread SDK chunk, and the CSP needs
    `worker-src 'self'` (already in the deploy CSP).
  - **Recommended: worker mode**, verified in Phase 2c on phones.
- **Load timeout.** `LOAD_TIMEOUT_MS` is 60 s. A ≈ 26–30 MB first download may exceed it on slow
  mobile data. Raising it only for Paddle is an owner decision (it changes behaviour).
- **Dev-only switch** (brief 2b step 2): `?engine=paddle` read in `ScanStep`'s call to
  `scanReceipt(…, createEngine)`, honoured only when `import.meta.env.DEV` (or an explicit dev
  flag). The default stays Tesseract.
- **Contract tests** (brief 2b step 4), with a fake SDK injected through a small factory parameter:
  - cancel and timeout during load and recognize;
  - `dispose` called exactly once on terminate;
  - word boxes in `OcrWord` format (polygon → bbox, score × 100);
  - empty result → `{ text: "", words: [] }`.

## 4. Bundle and deploy size (measured on this branch, 11 Nov 2026)

Builds: `npx vite build` (production), and `VITE_SPLITLAH_ENGINE_SWITCH=on npx vite build`
(switch compiled in). Baseline: the same build of the previous `engine-eval` head (49ab33e).

### Initial client bundle

| Chunk | Baseline | This branch (production) |
|---|---:|---:|
| `index-*.js` (entry) | 403,340 | 403,340 (content identical apart from the routes chunk's hashed name) |
| `routes-*.js` | 112,048 | 112,098 (+50: `engine.loadTimeoutMs ?? 60000` and the extended overall limit in `scan.ts`; `engineFactoryFor()` compiles to `void 0`) |
| `src-*.js` (lazy Tesseract adapter) | 18,977 | 18,977 |
| Paddle chunks, worker, ONNX Runtime | none | **none** |

The production client output contains no "paddle", no `location.search` read and no worker for
Paddle. The server (SSR) bundle contains no Paddle code either: only the static-asset manifest
entries for `public/paddle/*` and a comment. With the switch compiled in, the entry chunk is 403,370
and routes 112,910; Paddle code is only in lazy chunks and the worker.

### Deploy size and Cloudflare limits

| Build | Static assets (`.output/public`) | Worker (`.output/server`) | Files | Largest file |
|---|---:|---:|---:|---|
| Production (this branch) | 33,155,316 B | 1,769,200 B | 51 (whole `.output`) | `paddle/PP-OCRv5_mobile_rec.tar` 16,701,440 B (15.9 MiB) |
| Switch enabled (dev/preview only) | 66,256,755 B | — | — | same |

Switch-enabled build, Paddle files: `paddle.worker-*.js` 10,526,326 (SDK + OpenCV.js),
`ort-wasm-simd-threaded-*.wasm` 11,210,254, `ort-wasm-simd-threaded-*.mjs` 20,850, the adapter
1,690, and the SDK's own `worker-entry-*.js` 11,341,486, which is emitted because the SDK references
it with `new URL()` but is **never loaded** (SDK worker mode is off). Every file is under Cloudflare's
25 MiB per-file limit.

Note: the two model archives (21.5 MB) are in `public/` and so are deployed with every build,
production included, although production never loads them. See §9.

### What a browser downloads on the first Paddle scan (measured in the smoke test)

Same-origin only: the adapter chunk, `paddle.worker-*.js`, both model archives, ONNX Runtime's
`.mjs` and `.wasm`. Raw ≈ 43.3 MB; ≈ 25.9 MB with brotli, ≈ 27.9 MB with gzip (sizes from §2).

## 5. Contract tests (`src/lib/scan/paddle-engine.test.ts`, 20 tests, all pass)

A fake SDK and an in-process "worker" that runs the real `paddle-runtime.ts` handler. No real
model, image or receipt.

- **Word-box format**: polygon → bbox, score → 0..100, empty text dropped, reading-order text; empty
  result → `{ text: "", words: [] }`.
- **Load**: same-origin model and runtime URLs only (no bcebos, jsDelivr, Hugging Face, unpkg), SDK
  worker off, WASM backend, one thread; fails cleanly if OpenCV is missing.
- **Recognize**: fixed settings; the image input is disposed on success and on SDK failure.
- **Terminate**: ends the worker, rejects a running recognition, is safe to repeat; terminate during
  load stops the load; a crashed worker fails the pending request; the lazy dev engine stops if
  terminated before it loads.
- **Through the real `runOcr` workflow**: end-to-end read; **cancel** during recognition ends the
  worker; **timeout**: still loading after 61 s (Tesseract's limit), fails at 120 s with stage
  `load` and ends the worker; the overall limit is extended by 60 s so recognition keeps its time.
- **Dev switch**: only `?engine=paddle` with the switch enabled selects Paddle; reads the page's
  query when none is passed.
- **Pins**: model archives match their size and SHA-256; `package.json` pins and installed versions
  of the SDK and ONNX Runtime match `paddle-assets.ts`.

## 6. Real Paddle OCR smoke test

**Setup.** Synthetic receipt (invented text: EXAMPLE CAFE, 3 items, subtotal 19.50, service 1.95,
GST 1.93, total 23.38) rendered as text onto a 700×632 canvas in headless Chrome and saved as PNG.
Never a real receipt. The switch-enabled build was served locally (same client assets; nitro
`node-server` preset only so it could run without Wrangler). Playwright drove the real UI: upload →
"Read receipt" → Review. Chrome ran with `--host-resolver-rules=MAP * ~NOTFOUND` (only localhost
resolves); probe fetches to jsDelivr and Paddle's official model host both failed.

**Result.** Every run reached Review with all 3 items, subtotal 19.50, service 1.95, GST 1.93,
calculated total 23.38, "Matches the receipt total exactly". The only requests for engine files were
same-origin (`/assets/paddle-engine-*`, `/assets/paddle.worker-*`, `/paddle/*.tar`,
`/assets/ort-wasm-simd-threaded-*.mjs/.wasm`). No external engine request was made.

| Run (desktop, localhost, no throttling) | Total | Engine ready | Orientation probes | Final read | `recognize` calls |
|---|---:|---:|---:|---:|---:|
| Paddle, cold (new browser profile) | 8.9 s | 1.6 s | 5.6 s | 1.7 s | 4 |
| Paddle, warm (same tab, HTTP cache warm) | 8.9 s | 1.5 s | 5.5 s | 1.9 s | 4 |
| Paddle under a page CSP without jsDelivr/`blob:` | 9.6 s / 9.6 s | | | | 4 |
| Paddle on `npm run dev` | 10.9 s / 9.2 s | | | | 4 |
| Tesseract, same harness, page CSP | 3.9 s / 3.6 s | | | | |

Notes:
- "Warm" still re-creates the engine: `scan.ts` terminates the engine after every scan, so Paddle
  re-initialises (≈ 1.5 s here) on each scan. Over localhost the download time is near zero; on a
  phone the cold scan adds the ≈ 26 MB download.
- Most of Paddle's time is the **orientation probes** (3 low-resolution `recognize` calls before the
  final read). The shared orientation score counts confident words; Paddle returns phrases, so it
  reaches the early-stop threshold less often. This is engine tuning for Phase 2c, not changed here.
- ONNX Runtime logs "Removing initializer … not used" warnings while loading the models; harmless.
- Not verified: phones, Safari, Firefox, throttled networks, real photos.

## 7. CSP (`src/lib/security-headers.ts` on `main`; not edited)

Tested by adding the CSP to the HTML responses, as the deploy does.

| Change | Evidence | Recommendation |
|---|---|---|
| Drop `https://cdn.jsdelivr.net` from `script-src` and `connect-src` | Both engines scanned with `connect-src 'self'` and no jsDelivr in `script-src` | **Do it** once this PR is merged (Tesseract is self-hosted) |
| Drop `blob:` from `worker-src` | Both engines scanned with `worker-src 'self'` | **Do it** (Tesseract uses `workerBlobURL: false`; Paddle uses a same-origin module worker) |
| `'wasm-unsafe-eval'` on the page | Both engines also scanned **without** it, because all WebAssembly runs inside the workers | Can be dropped; verify on the deployed preview in Safari and Firefox first |
| Paddle: `blob:` | Not needed | — |
| Paddle: `'wasm-unsafe-eval'` / `'unsafe-eval'` | Static assets (including worker scripts) are served **without** a CSP (`public/_headers` sets only `nosniff` and `Referrer-Policy`), so the worker has no policy of its own. When the test gave the worker script the same CSP, Paddle failed to start; it worked once `'unsafe-eval'` was added. Cause: OpenCV.js (embind) builds functions with `Function(...)`. | Keep CSP off static worker scripts, or exempt `/assets/paddle.worker-*` in dev/preview builds only. Never add `'unsafe-eval'` to the page policy. Production never ships Paddle |

## 8. Tesseract self-hosting (implemented in 2b preparation)

**Before:** tesseract.js 5.1.1 defaults: worker from
`cdn.jsdelivr.net/npm/tesseract.js@v5.1.1/dist/worker.min.js` (started via a `blob:` URL), core
from `cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.1/` (SIMD-LSTM or LSTM `.wasm.js`, chosen per
device), model from `cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`.
The model is then cached in IndexedDB by tesseract.js.

**Now:** the same files, from the app's own static assets:

| File (`public/…`) | Source (npm) | Bytes | gzip | brotli |
|---|---|---:|---:|---:|
| `tesseract/5.1.1/worker.min.js` | tesseract.js 5.1.1 | 123,724 | 35,096 | 28,240 |
| `tesseract/5.1.1/core/tesseract-core-simd-lstm.wasm.js` | tesseract.js-core 5.1.1 | 3,938,657 | 1,461,088 | 1,125,491 |
| `tesseract/5.1.1/core/tesseract-core-lstm.wasm.js` (non-SIMD devices) | tesseract.js-core 5.1.1 | 3,938,277 | 1,460,459 | 1,125,956 |
| `tesseract/lang/eng/4.0.0_best_int/eng.traineddata.gz` | @tesseract.js-data/eng 1.0.0 | 2,952,873 | (already gzip) | |
| **Added deploy size** (+ licence files) | | **10,953,531** | | |

A device downloads the worker, **one** core and the model: about **7.0 MB raw, ≈ 4.4 MB gzip**.

- **Integrity.**
  - Tarball sha512 values match `bun.lock` (tesseract.js, tesseract.js-core) and the registry.
  - npm registry ECDSA signatures were verified for all three packages.
  - The worker and core files are byte-identical to `node_modules`.
  - `tesseract-assets.ts` pins each file's size and SHA-256. `tesseract-assets.test.ts` checks them,
    checks that the versions match the installed packages, and checks that the adapter passes only
    same-origin paths with `workerBlobURL: false`.
  - No CDN fallback.
  - Licences: Apache-2.0 (tesseract.js, core); the `eng` model is tessdata (Apache-2.0; npm package
    MIT). Licence files are copied next to the assets.
- **Real OCR smoke test** (synthetic receipt rendered as text onto a canvas; never a real receipt).
  The app's `scanReceipt` with the default engine ran in headless Chrome 153 against a scratch Vite
  dev server serving the repo's `public/`, with `cdn.jsdelivr.net` made unresolvable:
  - a probe fetch to jsDelivr failed, confirming it was blocked;
  - the only Tesseract requests were the three same-origin files;
  - 3 items, subtotal 19.50, service 1.95, GST 1.93, total 23.38, no warnings, 1 pass, ≈ 1.2 s;
  - **re-run under a CSP of `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'`** (no jsDelivr, no `blob:`): same result, no external
    requests.
- **CSP on `deploy/cloudflare`** (`src/lib/security-headers.ts`, not edited): the current policy
  still allows self-hosting (`'self'` is in `script-src`, `worker-src` and `connect-src`). Once this
  branch is merged, `https://cdn.jsdelivr.net` can be removed from `script-src` and `connect-src`,
  and `blob:` from `worker-src`.
- **Caching / offline.**
  - The model is stored in IndexedDB after the first load, as before.
  - The worker and core rely on the HTTP cache only. Nitro's generated `_headers` marks only
    `/assets/*` immutable; the `/tesseract/<version>/` paths are versioned, so the deploy branch could
    add an immutable rule for them.
  - Full offline use (brief: "download once, then work offline") would need a service worker. That
    is **not done** and not verified.
- **`vite build`**: `public/tesseract/` is copied to `.output/public/tesseract/` (10.98 MB).

## 9. For the owner

1. **Phase 2c not started.** It needs your gate (verified reference drafts and explicit authorisation).
2. ~~Paddle model archives deployed with production~~ **Done 11 Nov**: see the update above.
3. ~~`onnxruntime-web@1.22.0` pinned directly~~ **Confirmed 11 Nov** (DECISIONS.md).
4. **CSP follow-up on `main`** (§7): drop jsDelivr and `blob:`; consider dropping `'wasm-unsafe-eval'`
   after a preview check.
5. **120 s Paddle load limit** stays provisional until the 2c phone timings.
6. **Orientation probes** make Paddle ≈ 2.5× slower than Tesseract on desktop (§6). Whether to tune
   them for Paddle is a 2c question.
7. ~~This branch is behind `main`~~ **Merged 11 Nov**; `bun.lock` regenerated from the public
   registry.
8. Offline service worker for the engine files: still deferred (unchanged recommendation).

<details><summary>Approval list from the preparation stage (10 Nov), now decided</summary>

1. **Add the Paddle SDK** as a dependency:
   - packages: `@paddleocr/paddleocr-js@0.4.2`, which brings `onnxruntime-web@1.22.0`,
     `@techstark/opencv-js@4.10.0-release.1`, `clipper-lib@6.4.2`, `js-yaml@4.1.0` and 18 more
     (23 packages, 137 MB in `node_modules`);
   - total first-scan download (lazy): **≈ 43.3 MB raw / ≈ 25.9 MB brotli** with the WASM-only
     runtime, or **≈ 54.3 MB / ≈ 27.2 MB** with the default runtime, models included;
   - **≈ 55–66 MB added to the deploy**;
   - *Recommendation: approve, for the dev-only comparison only, with the WASM-only runtime alias.*
2. **Self-host the Paddle model archives** (21.5 MB, two files): they must come from the official
   host, which is blocked here. Bring them in from your PC (the sandbox's pinned copies with the
   SHA-256 above), or allow that host. *Recommendation: use your pinned copies.*
3. **Worker mode vs main thread** for Paddle. *Recommendation: worker mode (responsive UI, real
   cancellation), confirmed in 2c.*
4. **Paddle load timeout** above 60 s for the first download. *Recommendation: decide after the 2c
   phone timings.*
5. **Tesseract assets committed to git** (10.95 MB of binaries, permanent in history once merged).
   *Recommendation: accept: it works on both Lovable and Cloudflare with no build step.*
6. **CSP follow-up on `deploy/cloudflare`:** drop jsDelivr and `blob:` after this merges.
   *Recommendation: yes, in that branch's next change.*
7. **Offline service worker** for the engine files. *Recommendation: defer past MVP.*

</details>
