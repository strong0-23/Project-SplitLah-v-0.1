# Modules

How Splitlah's code is split up. Money is always integer cents; rates are integer basis points.

## App layers

| Layer | Path | Notes |
|---|---|---|
| Bill maths | `src/lib/bill.ts`, `src/lib/money.ts` | Pure. `computeTotals` is the one source of truth for totals and the split. |
| Data types and defaults | `src/lib/types.ts`, `src/lib/defaults.ts` | `Receipt`, `ReceiptItem`, … |
| Persistence | `src/lib/storage.ts` | Schema-versioned, structured data only. Never images. |
| State | `src/hooks/use-bill.tsx` | Shared wizard state. |
| Receipt scanning | `src/lib/scan/*` | Feature module, below. |
| UI | `src/components/splitlah/*`, `src/routes/*` | Wizard step in `?step=`. `ScanStep.tsx` only calls `scanReceipt`. |

## Receipt scanning: `src/lib/scan/`

UI code imports `@/lib/scan` (`index.ts`) only.

| File | Responsibility | Kind |
|---|---|---|
| `types.ts` | Contracts: `OcrEngine`, `OcrPage`/`OcrWord`/`BBox`, `LayoutHint`, `ScanOptions`, `OcrError`, `OcrCancelled` | pure |
| `image.ts` | Lighting flattening, paper-bounds detection on raw pixel arrays | pure |
| `canvas.ts` | Decode, rotate, crop, scale to a pixel budget (so long receipts stay legible), preview, file validation. Canvas read-back probe (`assertCanvasReadable`): a tiny known pattern is drawn and read back; if a privacy/anti-fingerprinting setting blanks or randomises it, preview and scan stop with `CANVAS_BLOCKED_MESSAGE` (stage `decode`) instead of showing a black image. A pass is remembered for the page session; a failure is re-checked next time | DOM adapter |
| `tesseract-engine.ts` | Tesseract.js behind `OcrEngine`; SDK is lazy-imported in `load`; worker, core and `eng` model come from the app's own static assets | SDK adapter |
| `engine-select.ts` | Dev-only engine switch: `engineFactoryFor()` returns a lazy PaddleOCR engine for `?engine=paddle` when the switch is compiled in (dev server, or `VITE_SPLITLAH_ENGINE_SWITCH=on`); otherwise `undefined` (Tesseract). Folds to `undefined` in production builds | adapter (URL) |
| `paddle-engine.ts` | PaddleOCR behind `OcrEngine` (dev-only challenger), main-thread side: starts the worker, request/response messages, `terminate()` ends the worker. Maps Paddle segments to `OcrWord` (`paddleItemsToPage`). Reached only via `import()` from `engine-select.ts` | SDK adapter |
| `paddle-runtime.ts` | Worker-side message handler: creates the SDK, loads models, runs `predict` with fixed settings; SDK and image decoding injected (fake SDK in tests) | SDK adapter |
| `paddle.worker.ts` | Web Worker entry: dynamic-imports `@paddleocr/paddleocr-js`, decodes the Blob on an `OffscreenCanvas`, points ONNX Runtime at its self-built same-origin files | worker |
| `paddle-assets.ts` | Pinned Paddle settings: SDK/runtime versions, model archives (`paddle-models/`, served at `/paddle/`) with size + SHA-256, create options, predict settings, the provisional 120 s load limit, and `engineSwitchForBuild` (switch refused on the production branch). Also imported by `vite.config.ts` | pure |
| `tesseract-assets.ts` | Pinned self-hosted Tesseract files (`public/tesseract/`): versions, paths, size + SHA-256 manifest, same-origin URLs | pure |
| `layout.ts` | Word boxes → reading-order rows; wide gaps kept as a two-space column mark | pure |
| `numbers.ts` | Locale-aware amounts (1,234.56 / 1.234,56 / zero-decimal), negatives, OCR digit fixes, currency detection | pure |
| `lexicon.ts` | Receipt vocabulary (EN, MS/ID, DE/FR/ES/IT/NL), label classifier with a tail-word check and finite OCR label repair (`normaliseLabelWords`: T0TAL, TOTA1, G5T), item header and Qty-column detection (`qtyColumnsOf`), address, modifier, note-vocabulary (`NOT_A_NOTE`) and tax-marker patterns | pure |
| `items.ts` | Item-row shapes: qty/unit/total columns, `2 @ 3.50 7.00`, `x2`, weighed goods. A bare number is a quantity only under a Qty heading or when unit × number = total (D7); a decimal/fractional number stays in the name, flagged. An amount after `@` is a unit price: alone, the line total is unknown (Batch 2a) | pure |
| `reconcile.ts` | Tax inclusive vs exclusive from printed numbers; charge-vs-rate check (`checkChargeRates`, P5); parse consistency score; `isConsistent` reuses `computeTotals` | pure |
| `parse.ts` | Section state machine (header → items → summary → footer): lines → draft `Receipt` + warnings | pure |
| `scan.ts` | Workflow: decode → load engine → orient → crop/flatten → recognise → optional 2nd pass. Cancellable (`AbortSignal`), time-bounded, engine injected. With `deps.pool` the engine is leased from the pool (load skipped when already loaded; released on success, discarded on any failure); without one it is single-use | workflow |
| `engine-pool.ts` | Keeps one loaded engine between scans in a page session: reuse for the same factory, dispose after 3 min idle, on `pagehide`, on engine change and on error/cancel/timeout; forwards engine progress to the scan using it; single-use engine for a concurrent scan. `sharedEnginePool()` is the page's pool | workflow |
| `index.ts` | Public API: `scanReceipt`, `parseReceiptText`, `parseReceiptLines`, `validateImageFile`, `preparePreview`, error types | — |

Tests (synthetic text only): `receipt-types.test.ts` (one fixture per receipt style and per real-receipt pattern P1–P5; each must reconcile with `computeTotals`), `parser-v2-port.test.ts` (parser-v2's parser tests, adapted), `parser-v2-port-2a.test.ts` (the remaining parser-v2 parsing rules, Batch 2a), `tesseract-assets.test.ts` (self-hosted files match their manifest and the installed packages; the adapter uses same-origin paths only), `parse.test.ts`, `modules.test.ts`, `scan.test.ts` (workflow with a fake engine), `paddle-engine.test.ts` (Paddle adapter contract with a fake SDK and an in-process worker: word-box format, cancel, timeout, terminate; the dev switch; model archive hashes; exact package pins), `canvas.test.ts` (read-back probe with mocked canvases returning zeros, white, noise or throwing; preview and scan both stop), `ScanStep.test.tsx` (the message is shown and no preview). `src/test/setup.ts` marks the probe as passed before each test, because other tests mock canvases with fixed pixels; probe tests turn that off.

## Build: `vite.config.ts` plugin `splitlah:paddle-models`

Decides at build time whether the dev engine switch is compiled in (same condition as
`engine-select.ts`; refused on the production branch via `engineSwitchForBuild`). Only then does it
serve `paddle-models/*.tar` at `/paddle/` (dev server) or emit them into the client output (build).
Without the switch, a build contains no Paddle files. See docs/DEPLOY.md, "Builds with Paddle on".

## Dev-only tool: `tools/receipt-regression/`

Local harness for the owner's scored runs (`npm run receipts:dev`, `receipts:test`, `receipts:check`). It refuses production builds, and the app's normal build never imports it (the only link is the dev page below, compiled out of production). See its README.

| File | Responsibility | Kind |
|---|---|---|
| `model.ts` | Reference schema (`Expected`), `evaluate` (product matching, checks, silent errors), Batch 1b gate | pure |
| `owner-reference.ts` | Owner reference format: pairing by REG id, contract check, conversion to `Expected` (known fields only) | pure |
| `rework-parser.ts`, `parsers.ts` | The app's parser as a `ParserUnderTest`; `parsers.ts` adds the parser-v2 baseline copy | pure |
| `corrections.ts` | Phase 2c: extra correction actions per receipt, from `evaluate`'s checks | pure |
| `comparison.ts` | Phase 2c: result types, summary lines (IDs and counts only), reading pasted summaries and phone lines, the decision rule (a)–(d) and the 70% stop rule | pure |
| `engine-runner.ts` | Phase 2c: scans each receipt with each engine (scan function injected), first + warm timings, scoring; held-out mode keeps IDs, counts and timings only | workflow |
| `main.ts`, `index.html` | The harness page (DOM glue): sources, held-out mode, pickers with a multi-file fallback, summary and Combine | DOM |
| `phone/EngineTimingPage.tsx` | Phone timing page UI (1 + 3 scans, median warm, optional reference) | React |
| `vite.config.ts` | Dev server on 127.0.0.1:8081: serves the pinned Tesseract and Paddle files only, ORT WASM-only alias, browser console not forwarded to the terminal | config |
| `smoke/*.mjs` | Headless Chrome smoke tests with synthetic receipts (Playwright supplied by the caller) | script |

## Dev-only page: `/dev/engine-timing`

`src/routes/dev.engine-timing.tsx` is a thin route; `src/lib/dev/dev-pages.ts` holds its guard
(`DEV_PAGES_ENABLED`, the same compile-time condition as `ENGINE_SWITCH_ENABLED`, test-checked) and
the only `import()` of `tools/receipt-regression/phone/EngineTimingPage.tsx`. In a production build
the route answers "not found" and no page code is emitted.

## Contracts

```ts
interface OcrEngine {
  readonly name: string;
  readonly loadTimeoutMs?: number; // optional per-engine load limit; default LOAD_TIMEOUT_MS (60 s)
  load(onProgress: (p: EngineProgress) => void): Promise<void>; // may fetch model files only
  recognize(image: Blob, layout: LayoutHint): Promise<OcrPage>; // the image never leaves the device
  terminate(): Promise<void>; // safe to call twice, and while load/recognize is in flight
}
interface OcrPage { text: string; words: OcrWord[] } // words may be empty
interface OcrWord { text: string; confidence: number; bbox: BBox }
type LayoutHint = "column" | "block" | "sparse";

scanReceipt(file, opts: ScanOptions, onProgress, signal, createEngine?, pool = sharedEnginePool()) → ScanReceiptResult
parseReceiptLines(lines: string[]) → { receipt: Receipt; warnings: string[]; currency: string | null }
```

- Errors: `OcrError(stage, message)` with `stage` = `decode | load | orient | recognize | timeout`; the message is user-facing. `OcrCancelled` when the signal aborts.
- The parser never invents prices. Lines it can't place stay visible: flagged items, null prices, or a "Lines not used" warning.

## Dependency direction

```
UI (ScanStep.tsx)
  └─▶ scan/index.ts
        ├─▶ scan.ts ─▶ canvas.ts ─▶ image.ts
        │         ├─▶ layout.ts
        │         └─▶ tesseract-engine.ts ─▶ (lazy) tesseract.js
        │                                └─▶ tesseract-assets.ts (pinned /tesseract/* paths)
        ├─▶ engine-select.ts ─▶ (lazy, dev builds only) paddle-engine.ts ─▶ Worker: paddle.worker.ts
        │                                                                    └─▶ paddle-runtime.ts ─▶ (lazy) @paddleocr/paddleocr-js
        │                   └─▶ paddle-assets.ts (pinned /paddle/* paths, settings)
        └─▶ parse.ts ─▶ items.ts ─▶ lexicon.ts
                    ├─▶ numbers.ts ─▶ ../money.ts
                    ├─▶ lexicon.ts
                    └─▶ reconcile.ts ─▶ ../bill.ts
  everything ─▶ types.ts (contracts; imports nothing)
```

Rules:
- Pure modules import no DOM, React or SDK code.
- `scan.ts` does not import the parser; `index.ts` passes a scorer in, so the workflow stays parser-agnostic.
- The parser does not know which engine produced the text, so swapping engines needs no parser change (D5).
- Nothing imports `paddle-engine.ts` statically; it is reached only through `import()` in
  `engine-select.ts`, inside a branch that is a build-time `false` in production.
- `scan/` may import `bill.ts`, `money.ts`, `types.ts`, `defaults.ts`, `ids.ts`; nothing in those imports `scan/`.
