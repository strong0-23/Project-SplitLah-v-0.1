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
| `canvas.ts` | Decode, rotate, crop, scale to a pixel budget (so long receipts stay legible), preview, file validation | DOM adapter |
| `tesseract-engine.ts` | Tesseract.js behind `OcrEngine`; SDK is lazy-imported in `load` | SDK adapter |
| `layout.ts` | Word boxes → reading-order rows; wide gaps kept as a two-space column mark | pure |
| `numbers.ts` | Locale-aware amounts (1,234.56 / 1.234,56 / zero-decimal), negatives, OCR digit fixes, currency detection | pure |
| `lexicon.ts` | Receipt vocabulary (EN, MS/ID, DE/FR/ES/IT/NL), label classifier with a tail-word check, item header, address, modifier and tax-marker patterns | pure |
| `items.ts` | Item-row shapes: qty/unit/total columns, `2 @ 3.50`, `x2`, weighed goods | pure |
| `reconcile.ts` | Tax inclusive vs exclusive from printed numbers; parse consistency score; `isConsistent` reuses `computeTotals` | pure |
| `parse.ts` | Section state machine (header → items → summary → footer): lines → draft `Receipt` + warnings | pure |
| `scan.ts` | Workflow: decode → load engine → orient → crop/flatten → recognise → optional 2nd pass. Cancellable (`AbortSignal`), time-bounded, engine injected | workflow |
| `index.ts` | Public API: `scanReceipt`, `parseReceiptText`, `parseReceiptLines`, `validateImageFile`, `preparePreview`, error types | — |

Tests (synthetic text only): `receipt-types.test.ts` (one fixture per receipt style; each must reconcile with `computeTotals`), `parse.test.ts`, `modules.test.ts`, `scan.test.ts` (workflow with a fake engine).

## Contracts

```ts
interface OcrEngine {
  readonly name: string;
  load(onProgress: (p: EngineProgress) => void): Promise<void>; // may fetch model files only
  recognize(image: Blob, layout: LayoutHint): Promise<OcrPage>; // the image never leaves the device
  terminate(): Promise<void>; // safe to call twice, and while load/recognize is in flight
}
interface OcrPage { text: string; words: OcrWord[] } // words may be empty
interface OcrWord { text: string; confidence: number; bbox: BBox }
type LayoutHint = "column" | "block" | "sparse";

scanReceipt(file, opts: ScanOptions, onProgress, signal, createEngine?) → ScanReceiptResult
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
- `scan/` may import `bill.ts`, `money.ts`, `types.ts`, `defaults.ts`, `ids.ts`; nothing in those imports `scan/`.
