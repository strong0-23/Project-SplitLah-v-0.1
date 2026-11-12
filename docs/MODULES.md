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

UI code imports `@/lib/scan` (`index.ts`) only. `ReviewStep.tsx` uses `reviewHints`/`rowKey` from it.

| File | Responsibility | Kind |
|---|---|---|
| `types.ts` | Contracts: `OcrEngine`, `OcrPage`/`OcrWord`/`BBox`, `LayoutHint`, `ScanOptions`, `OcrError`, `OcrCancelled` | pure |
| `image.ts` | Lighting flattening, paper-bounds detection on raw pixel arrays | pure |
| `canvas.ts` | Decode, rotate, crop, scale to a pixel budget (so long receipts stay legible), preview, file validation. Canvas read-back probe (`assertCanvasReadable`): a tiny known pattern is drawn and read back; if a privacy/anti-fingerprinting setting blanks or randomises it, preview and scan stop with `CANVAS_BLOCKED_MESSAGE` (stage `decode`) instead of showing a black image. A pass is remembered for the page session; a failure is re-checked next time | DOM adapter |
| `tesseract-engine.ts` | Tesseract.js behind `OcrEngine`; SDK is lazy-imported in `load`; worker, core and `eng` model come from the app's own static assets | SDK adapter |
| `tesseract-assets.ts` | Pinned self-hosted Tesseract files (`public/tesseract/`): versions, paths, size + SHA-256 manifest, same-origin URLs | pure |
| `layout.ts` | Word boxes → reading-order rows; wide gaps kept as a two-space column mark | pure |
| `numbers.ts` | Locale-aware amounts (1,234.56 / 1.234,56 / zero-decimal), negatives, OCR digit fixes, currency detection | pure |
| `lexicon.ts` | Receipt vocabulary (EN, MS/ID, DE/FR/ES/IT/NL), label classifier with a tail-word check and finite OCR label repair (`normaliseLabelWords`: T0TAL, TOTA1, G5T), item header and Qty-column detection (`qtyColumnsOf`), address, modifier, note-vocabulary (`NOT_A_NOTE`) and tax-marker patterns | pure |
| `items.ts` | Item-row shapes: qty/unit/total columns, `2 @ 3.50 7.00`, `x2`, weighed goods. A bare number is a quantity only under a Qty heading or when unit × number = total (D7); a decimal/fractional number stays in the name, flagged. An amount after `@` is a unit price: alone, the line total is unknown (Batch 2a) | pure |
| `reconcile.ts` | Tax inclusive vs exclusive from printed numbers; charge-vs-rate check (`checkChargeRates`, P5); parse consistency score; `isConsistent` reuses `computeTotals` | pure |
| `totals.ts` | Total evidence: payment agreement (`findPaymentTotal`, `paidAmounts`: a payment, or cash minus change, equal to a total candidate), totals per section that add up to the payment, tax-table rows (net + tax = gross), and a damaged-label total row equal to the items above it (`findSumRow`). Never takes a payment, change, savings or points value as the total | pure |
| `anchor.ts` | Total-anchored item selection (`anchorItems`): which doubtful rows add up to the printed total; the rest are set aside. Algorithm and limits below | pure |
| `parse.ts` | Section state machine (header → items → summary → footer): lines → draft `Receipt` + warnings. Also returns `setAside` (rows the anchor set aside, never deleted), `itemReasons` (short reason per flagged row) and `anchor` (what the anchor did) | pure |
| `review.ts` | Review hints (`reviewHints`, `rowKey`): parses the stored `rawOcrText` again to give the review screen the set-aside lines and row reasons, so nothing new is stored | pure |
| `scan.ts` | Workflow: decode → load engine → orient → crop/flatten → recognise → optional 2nd pass. Cancellable (`AbortSignal`), time-bounded, engine injected. With `deps.pool` the engine is leased from the pool (load skipped when already loaded; released on success, discarded on any failure); without one it is single-use | workflow |
| `engine-pool.ts` | Keeps one loaded engine between scans in a page session: reuse for the same factory, dispose after 3 min idle, on `pagehide`, on engine change and on error/cancel/timeout; forwards engine progress to the scan using it; single-use engine for a concurrent scan. `sharedEnginePool()` is the page's pool | workflow |
| `index.ts` | Public API: `scanReceipt`, `parseReceiptText`, `parseReceiptLines`, `validateImageFile`, `preparePreview`, error types | — |

Tests (synthetic text only): `anchor.test.ts` (anchor ranking, uniqueness, protected rows, tax readings, bounds; totals evidence), `structure.test.ts` (Batch 3: one synthetic receipt per structure pattern: header rows, card blocks, "Total Inc. GST", payment agreement, section totals, tax tables, comma-for-point totals, quantity × unit rows, damaged-label totals, and the never-silent design), `ReviewStep.test.tsx` (hidden-lines expander and add back, remove with undo, row reasons, the mismatch banner), `receipt-types.test.ts` (one fixture per receipt style and per real-receipt pattern P1–P5; each must reconcile with `computeTotals`), `parser-v2-port.test.ts` (parser-v2's parser tests, adapted), `parser-v2-port-2a.test.ts` (the remaining parser-v2 parsing rules, Batch 2a), `tesseract-assets.test.ts` (self-hosted files match their manifest and the installed packages; the adapter uses same-origin paths only), `parse.test.ts`, `modules.test.ts`, `scan.test.ts` (workflow with a fake engine, including a per-engine load limit), `engine-reuse.test.ts` (engine pool), `canvas.test.ts` (read-back probe with mocked canvases returning zeros, white, noise or throwing; preview and scan both stop), `ScanStep.test.tsx` (the message is shown and no preview). `src/test/setup.ts` marks the probe as passed before each test, because other tests mock canvases with fixed pixels; probe tests turn that off.

## Total-anchored item selection (`anchor.ts`, Batch 3)

**Why.** OCR turns header, address, card-terminal and footer lines into extra "items". The printed
total says which lines are real: the item lines must add up to it.

**When it runs** (in `parse.ts`, after totals, charges and discounts are read, before
`reconcileCharges`): a payable total was read, at least one item row is doubtful, and no payment
line disagrees with the total (a payment that is neither the total nor the total after change means
the total may be incomplete, so nothing is hidden).

**Rows.** Each item row is *inside* the item section (read in the items section, below the header
zone) or not, and *protected* or not. Protected = inside, priced and not flagged. Only unprotected
rows are searched ("doubtful"): flagged rows, rows in the header zone (a receipt with no item
heading: up to the last address/phone/date/noise line before the summary, unless two priced rows
came after an earlier header line) and rows after the total. Unpriced rows are never in a subset.

**Target.** `total − service/fees + bill discount`, minus the printed tax when GST is added. When
the tax mode is unknown both readings are tried; if both have a subset the result is ambiguous.

**Search.** 0/1 knapsack over cents for the doubtful rows, for `need = target − protected rows`.
Rank: more rows inside the item section, then more rows (weight 64 per inside row + 1 per row, so
"inside" always wins with ≤ 40 rows). The number of subsets with the best rank is counted (capped
at 2) and choice bits rebuild the subset when it is unique.

**Outcomes.**
- `matched`: one best subset. Rows not in it, and unpriced rows, move to `setAside` (description,
  quantity, amount, reason). The receipt gets `uncertainFields: items` and a first warning saying
  lines were hidden, so the review screen never shows a plain "matches" while lines are hidden.
- `ambiguous`: several equally ranked subsets, or both tax readings fit: nothing hidden, items
  marked uncertain with a warning.
- `no-match` / `too-large`: nothing changes (the existing mismatch warnings apply).

**Limits.**
- At most 40 doubtful rows (`MAX_CANDIDATES`) and 4,000,000 DP cells (`MAX_CELLS`, rows × need in
  cents); beyond that the result is `too-large`. Bounded by size, not time, so the same text always
  gives the same answer (the review screen relies on that).
- Exact cents only: a misread amount on a real item means no subset, so nothing is hidden.
- A real but doubtful row (flagged, or in the header zone) can be hidden by coincidence when the
  total itself is misread and another doubtful row fits (tested in `structure.test.ts`). That is
  why a hidden line always marks the items for review and is shown under "N lines hidden — show".
- Item discounts must already be in the rows (D2); a discount repeated in two lines is not detected
  by the anchor.

**Review screen.** `ReviewStep.tsx` calls `reviewHints(receipt.rawOcrText)` (memoised): the hidden
lines appear collapsed under the item list ("3 lines hidden — show") with their amount and reason,
each with "Add back" (adds it as a flagged item). A line added back and later deleted is offered
again. Nothing about hidden lines is stored: they are derived from the stored OCR text.

## Dev-only tool: `tools/receipt-regression/`

Local harness for the owner's scored runs (`npm run receipts:dev`, `receipts:test`, `receipts:check`). It refuses production builds, and the app never imports it. See its README.

| File | Responsibility | Kind |
|---|---|---|
| `model.ts` | Reference schema (`Expected`), `evaluate` (product matching, checks, silent errors), Batch 1b gate | pure |
| `owner-reference.ts` | Owner reference format: pairing by REG id, contract check, conversion to `Expected` (known fields only) | pure |
| `rework-parser.ts`, `parsers.ts` | The app's parser as a `ParserUnderTest`; `parsers.ts` adds the parser-v2 baseline copy | pure |
| `corrections.ts` | Extra correction actions per receipt, from `evaluate`'s checks | pure |
| `comparison.ts` | Engine scoring (Tesseract only since 11 Nov 2026): result types, summary lines (IDs and counts only), per-run aggregates (within-2 share, silent errors, failures, timings), reading pasted summaries. The Phase 2c decision rule and phone lines were removed with Paddle | pure |
| `engine-runner.ts` | Scans each receipt with each engine in `ENGINES` (scan function injected), first + warm timings, scoring; held-out mode keeps IDs, counts and timings only | workflow |
| `main.ts`, `index.html` | The harness page (DOM glue): sources, held-out mode, pickers with a multi-file fallback, summary and Combine | DOM |
| `vite.config.ts` | Dev server on 127.0.0.1:8081: serves the pinned Tesseract files only, browser console not forwarded to the terminal | config |
| `smoke/*.mjs` | Headless Chrome smoke tests with synthetic receipts (Playwright supplied by the caller). `review-smoke.mjs`: the app's scan → review (hidden line, add back, delete, undo) → split journey under `wrangler dev` | script |

## Contracts

```ts
interface OcrEngine {
  readonly name: string;
  readonly loadTimeoutMs?: number; // optional per-engine load limit; default LOAD_TIMEOUT_MS (60 s); Tesseract sets none
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
        ├─▶ engine-pool.ts (keeps the loaded engine between scans)
        ├─▶ review.ts ─▶ parse.ts
        └─▶ parse.ts ─▶ items.ts ─▶ lexicon.ts
                    ├─▶ numbers.ts ─▶ ../money.ts
                    ├─▶ lexicon.ts
                    ├─▶ totals.ts (no imports)
                    ├─▶ anchor.ts (no imports)
                    └─▶ reconcile.ts ─▶ ../bill.ts
  everything ─▶ types.ts (contracts; imports nothing)
```

Rules:
- Pure modules import no DOM, React or SDK code.
- `scan.ts` does not import the parser; `index.ts` passes a scorer in, so the workflow stays parser-agnostic.
- The parser does not know which engine produced the text, so swapping engines needs no parser change (D5).
- Tesseract is the only engine (PaddleOCR was removed on 11 Nov 2026). Another engine would be a
  new adapter passed to `scanReceipt` as `createEngine` (a stable factory), with no parser change.
- `scan/` may import `bill.ts`, `money.ts`, `types.ts`, `defaults.ts`, `ids.ts`; nothing in those imports `scan/`.
