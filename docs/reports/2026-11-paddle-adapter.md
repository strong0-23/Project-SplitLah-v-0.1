# Batch 2b (preparation): Paddle measurements, adapter design, Tesseract self-hosting

**Branch:** `engine-eval`. **Date:** 10–11 Nov 2026. **Status:** stopped at the approval gate.
Paddle is **not** in `package.json` or `bun.lock`; no Paddle code is in the app. Tesseract
self-hosting (approved 6 Nov) is implemented.

## 1. Summary

- **SDK:** `@paddleocr/paddleocr-js@0.4.2` (Apache-2.0), the package and pins the owner's sandbox
  used (`origin/parser-v2:tools/ocr-engine-sandbox`). It is the latest published version.
- **First-scan download** (code + runtime + models), lazy-loaded:
  - as the sandbox configured it: **54.3 MB raw, ≈ 30.2 MB over the wire with gzip,
    ≈ 27.2 MB with brotli**;
  - with the WASM-only ONNX Runtime build (recommended): **43.3 MB raw, ≈ 27.9 MB gzip,
    ≈ 25.9 MB brotli**.
  - The models (21.5 MB) are about 80% of the brotli figure. Their sizes come from the owner's
    sandbox record: the model host was **unreachable from this sandbox**.
- **Initial bundle:** unchanged if Paddle is reached only through `import()` (measured on a scratch
  build: the entry chunk holds only the import stub; Paddle code sits in separate chunks).
- **Tesseract self-hosting: done.** Worker, cores and `eng` model are served from `public/tesseract/`
  at pinned versions with no CDN fallback. A real OCR smoke test in headless Chrome passed **with
  jsDelivr blocked**, also under a CSP with no jsDelivr and no `blob:`.

## 2. Measured sizes

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
112.0 kB, lazy Tesseract chunk 19.0 kB) is unchanged by this branch because nothing is wired.
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

## 4. Adapter design: `src/lib/scan/paddle-engine.ts` (not written yet)

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

## 5. Tesseract self-hosting (implemented)

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

## 6. Owner approval needed

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
