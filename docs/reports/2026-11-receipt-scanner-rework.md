# Receipt scanner rework: report (Batch 1)

**Branch:** `rework/receipt-scanner` (from `fix/receipt-ocr-recovery`). **Baseline:** `main` (dabfd34, the original Lovable import). **Date:** 6 Nov 2026. **Stage:** MVP.

## 1. Summary

Receipt scanning has moved from two large files (`ocr.ts`, `parser.ts`) into a feature module, `src/lib/scan/`, with 12 small files. Eight are pure functions tested with synthetic text; the browser canvas and Tesseract.js sit behind adapters. OCR engines now plug in through an `OcrEngine` interface, so PaddleOCR can be tried later without touching the parser (D5). Tesseract is still the only engine, and recognition still happens on the device.

The parser now handles many more receipt layouts. Of the 19 synthetic receipt fixtures, `main` gets the items exactly right on 4 and fails to read any items on 4. The rework gets all 19 right, and every one reconciles to its printed total using the bill's own maths (`computeTotals`).

This batch made no change to bill maths or UI flow. The one schema change on the branch (an optional field) came from `fix/receipt-ocr-recovery`; see §6.

All checks pass: `tsc`, 73/73 tests, ESLint and Prettier on `src/lib/scan`, and `vite build`. A browser smoke test of the real app with real Tesseract on synthetic images passed 8/8. **Accuracy on real receipt photos has not been measured** (§6).

## 2. Before vs after (against `main`)

### File map

| `main` | Now | Notes |
|---|---|---|
| `src/lib/ocr.ts` (image prep + Tesseract + workflow) | `scan/canvas.ts`, `scan/image.ts`, `scan/tesseract-engine.ts`, `scan/layout.ts`, `scan/scan.ts` | Split into a DOM adapter, pure pixel functions, an SDK adapter, word-box layout and the workflow |
| `src/lib/parser.ts` (one parser) | `scan/numbers.ts`, `scan/lexicon.ts`, `scan/items.ts`, `scan/reconcile.ts`, `scan/parse.ts` | Amounts, vocabulary, item rows, cross-checks and the section state machine are now separate |
| — (`preprocess.ts` was added on the fix branch) | `scan/image.ts` | Moved |
| — | `scan/types.ts`, `scan/index.ts` | Contracts; public API (UI imports `@/lib/scan` only) |
| — | `scan/receipt-types.test.ts`, `parse.test.ts`, `modules.test.ts`, `scan.test.ts` | 50 scanner tests, all synthetic |
| `ScanStep.tsx` | `ScanStep.tsx` | Now a thin caller of `scanReceipt` |
| `bill.ts`, `money.ts` | unchanged | |
| `types.ts`, `storage.ts` | +1 optional field, `printedNetSubtotalCents` | From the fix branch (§3, §6) |

### Behaviour per receipt type

Measured by running the same synthetic fixtures (from `receipt-types.test.ts`) through each branch's parser and `computeTotals`. "Items" means the description, quantity and line total all match the expected list; "reconciles" means the calculated total equals the printed total.

| Receipt type | `main` | `fix/receipt-ocr-recovery` | Rework |
|---|---|---|---|
| Restaurant: service charge + GST on top | Reconciles; qty left in the name ("Ribeye Steak 2", qty 1) | ✅ | ✅ |
| Hawker / kopitiam, no charges | ✅ | ✅ | ✅ |
| Supermarket: name row + `2 @ 8.95` row, weighed goods, item discount, rounding | ❌ "NET" read as an item; Milo lost; off by 33.54 | ❌ Milo lost; "EGGS 10S" read as qty 10; off by 17.90 | ✅ |
| Cafe: add-ons and free options | Reconciles; "+ Oat milk" is a separate item | Reconciles; add-on is a separate item | ✅ add-on folded into its item (D3) |
| Columns: description / qty / unit / total | Reconciles; qty left in the name | Reconciles; qty and unit price in the name | ✅ |
| Bill discount; total printed on the next line | Items ✅; total not found | Items ✅; total not found | ✅ |
| Malaysia: RM, SST, Jumlah, rounding adj | ❌ "Jumlah" and "Tunai" read as items; no total | Items keep "RM"; no total | ✅ |
| Europe: decimal comma, VAT included | ❌ only the summary lines read, as items | ❌ same | ✅ |
| Indonesia: zero-decimal rupiah, PB1 | ❌ no items | ❌ no items | ✅ (D1) |
| Japan: yen, tax included | ❌ no items | ❌ no items | ✅ (D1) |
| US: sales tax, suggested tips | ❌ tip suggestions read as items; off by 8.17 | Items ✅; off by 1.91 | ✅ |
| OCR noise: `1O.5O`, `l.80`, dates, phone numbers | ❌ no items | ❌ no items | ✅ |
| Long receipt, 3-line wrapped descriptions *(new)* | Reconciles; first lines of each wrapped name lost | Same | ✅ names joined |
| Two subtotals around a discount *(new)* | Reconciles; "Fries" read as "Frie" | Same | ✅ |
| No item header, address with price-like numbers *(new)* | ✅ | ✅ | ✅ |
| Delivery app: delivery/platform fees, fee discount *(new, D6)* | Reconciles, but fees are items | ❌ fees dropped; off by 4.39 | ✅ fees are service |
| Service charge + delivery fee together *(new, D6)* | Reconciles, but fees are items | ❌ off by 5.60 | ✅ |
| Total in the footer after payment *(new)* | ✅ | ✅ | ✅ |
| `|` column separators *(new)* | ❌ no items | ❌ no items | ✅ |

Totals: items exactly right on `main` 4/19, `fix` 6/19, rework 19/19. Reconciles to the printed total on `main` 10/19, `fix` 8/19, rework 19/19.

## 3. Inherited from `fix/receipt-ocr-recovery` vs new in this rework

**Inherited** (commit da7d832, on the fix branch before the rework):
- Automatic orientation (probing rotations) and manual rotate/crop controls in `ScanStep`.
- Image preprocessing: lighting flattening and paper-bounds detection (`preprocess.ts`, now `scan/image.ts`).
- Tax parsing: inclusive vs exclusive GST.
- `printedNetSubtotalCents`, an optional field in `Receipt` and the storage schema, with a small `ReviewStep` change to show it.

**New in this rework:**
- WIP commit 09cfd61 (at handoff): module split into `src/lib/scan/`; the `OcrEngine` interface and Tesseract adapter; word-box layout; locale-aware numbers and currency detection; multilingual lexicon with the tail-word check; item-row shapes; reconciliation reusing `computeTotals`; the section state machine; D1–D4 in code; the cancellable, time-bounded workflow with an optional second pass.
- This session:
  - Descriptions that wrap over several lines are joined into one item. A line ending on a joining word ("with", "and", ",", "&", …) continues on the next line, whether the price is on the first or the last line.
  - Shop-address lines above the first item ("Unit 3.12", "#02-15", "Singapore 123456") are skipped, not read as items.
  - A `|` with space on both sides is a column separator. A `|` touching a digit is still left for OCR digit repair.
  - D6: delivery, platform, packaging/packing, small-order and booking fees (plus Malay, Indonesian and European terms) count as service charge. A negative fee line ("Delivery Discount -1.00") reduces it.
  - Tests for the six edge cases in the brief, and the docs.
  - The interrupted lint fix (`normaliseLine` `\u0000` placeholder) was already done in the WIP commit; `src/lib/scan` was already Prettier-clean.

## 4. Decisions D1–D6

Full text and reasons are in [`docs/DECISIONS.md`](../DECISIONS.md).

| | Decision | Status |
|---|---|---|
| D1 | SGD-only; non-SGD parsed as printed, with a warning; zero-decimal stored ×100 | Implemented (WIP), tested (MYR, EUR, IDR, JPY) |
| D2 | Discount under an item reduces it; moved back to the bill if the printed subtotal is pre-discount | Implemented (WIP), tested |
| D3 | Priced add-on added to the item above; free add-on becomes a note | Implemented (WIP), tested |
| D4 | Cash rounding ≤ 5 cents recognised; split on the unrounded total, with a warning | Implemented (WIP), tested |
| D5 | Engine interface kept for a later PaddleOCR adapter | Implemented (WIP); workflow tested with a fake engine |
| D6 | Delivery and similar fees count as service charge | **Implemented this session**, tested alone and with a service charge |

## 5. Tests

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | ✅ clean |
| Unit tests | `npx vitest run` | ✅ 73/73 passed in 6 files (36 existing + 28 from the WIP commit + 9 new). Scanner: 26 receipt types, 11 module, 9 parse, 4 workflow. Bill: 22. Routing: 1 |
| Lint (scanner) | `npx eslint src/lib/scan` | ✅ 0 problems |
| Format (scanner) | `npx prettier --check src/lib/scan` | ✅ clean |
| Build | `npx vite build` | ✅ succeeded. Tesseract.js is in a separate 19 KB chunk loaded by dynamic `import()`, not the initial bundle |
| Lint (whole repo) | `npx eslint .` | 324 problems, **none in `src/lib/scan`**. These predate this work: 314 are Prettier formatting in existing files (the brief says to leave them), 9 `react-refresh/only-export-components` and 1 `no-control-regex` in `src/hooks/use-bill.tsx` |
| Before/after comparison | 19 fixtures through `main`, `fix/receipt-ocr-recovery` and rework parsers | See §2 |

**Browser smoke test** (`npm run dev`, Playwright with headless Chromium at a 420 px phone width). Synthetic receipt text was drawn onto a canvas and saved as PNG; no real receipt was used. jsDelivr is blocked in the test sandbox, so Tesseract's worker, core and `eng` language files were served from local copies of the same packages through request interception. The app code was not changed.

| State | Result |
|---|---|
| Loading: progress bar and Cancel shown while reading | ✅ |
| Success: review screen with all 3 items and quantities, service 3.05, GST 3.02, "Matches the receipt total exactly" | ✅ about 4.5 s, warm desktop CPU |
| Cancel during model load: back to "Read receipt", no error, stays on the scan step | ✅ |
| Empty: blank image → "No readable text was found…" | ✅ |
| Empty: text without prices → "Text was read but no priced items were found…" | ✅ |
| Error: engine can't load (CDN unreachable) → "Couldn't start the text recogniser…", can retry | ✅ |
| Error: corrupt PNG → "This image couldn't be opened…" | ✅ |
| Error: wrong file type → "Please choose a JPEG, PNG or WebP image." | ✅ |

## 6. Not verified, and known limitations

- **All tests use synthetic text.** The fixtures are typed OCR-style transcripts, and the smoke test used clean, computer-rendered text. **Accuracy on real receipt photos is unmeasured**: crumpled or faded thermal paper, skew, glare, low light and phone cameras have not been tested. That is the job of the Batch 2 evaluation.
- **No phone or non-Chromium browser was tested.** The smoke test ran headless Chromium on a desktop CPU only, so speed on phones is unknown.
- **Multi-currency:** by D1 the app is SGD-only. Foreign receipts are parsed as printed and labelled SGD, with a warning. There is no conversion.
- **Non-Latin scripts:** only the `eng` Tesseract model is loaded. Chinese, Tamil, Thai, Japanese and other scripts will not be read. Receipts that mix English with these scripts may lose the non-Latin item names.
- **Handwritten receipts** are not supported. Tesseract's printed-text model is not built for handwriting.
- **Model files come from a CDN.** Tesseract downloads its worker, core and language data from jsDelivr on first use. The image never leaves the device, but scanning needs that download to succeed (if it fails, the app shows "Couldn't start the text recogniser"). This is unchanged from `main`.
- **Wrapped descriptions** are joined only when a line ends on a joining word or comma. A wrap that breaks mid-phrase with no such word (for example "Seafood Platter Grilled" / "Prawns") still becomes a note in brackets on the item. The price and total stay correct.
- **D6 and the service rate:** when a service charge with a rate ("10%") and a delivery fee appear together, the service *amount* includes both, but the stored rate is still 10%. The split uses the amount, so it is correct. If the user switches to "Calculate by %", though, the delivery fee would drop out.
- **Address skipping** only applies above the first item and only on clear address patterns (unit/block numbers, `#02-15`, six-digit postcodes, street types). Other header lines with prices still appear under "Lines not used".
- **Needs owner approval (hard rule 5):** this branch includes a storage-schema change inherited from `fix/receipt-ocr-recovery`. `printedNetSubtotalCents` was added as an optional, nullable field to `Receipt` and to the `receiptSchema` in `storage.ts`. It is additive, and old saved sessions still load. No schema, interface or dependency change was made in this session.

## 7. Suggested next steps

1. Owner: review this PR, including the inherited `printedNetSubtotalCents` schema field.
2. Batch 2a: port the parser-v2 behaviours once that branch is on GitHub.
3. Measure on real photos, owner-run, with the held-out rules from the evaluation brief. Measure corrections per receipt and scan time on real phones.
4. Consider serving Tesseract's worker, core and `eng` model from the app's own origin, so scanning works when jsDelivr is unreachable. That is a dependency/hosting change, so it needs owner approval.
5. When a service rate and other fees are combined (D6), think about either clearing the stored rate or showing the parts in the review screen.
6. Batch 2b/2c: PaddleOCR adapter and the engine comparison, as in the brief.

## 8. `git diff --stat main...rework/receipt-scanner`

```
 AGENTS.md                                      |   9 +-
 docs/DECISIONS.md                              |  35 ++
 docs/MODULES.md                                |  76 ++++
 docs/briefs/receipt-scanner-rework.md          | 170 +++++++++
 docs/reports/2026-11-receipt-scanner-rework.md | 168 +++++++++
 src/components/splitlah/ReviewStep.tsx         |   4 +
 src/components/splitlah/ScanStep.tsx           |  57 ++-
 src/lib/bill.test.ts                           |   2 +-
 src/lib/ocr.ts                                 |  62 ----
 src/lib/parser.ts                              | 118 -------
 src/lib/scan/canvas.ts                         | 139 ++++++++
 src/lib/scan/image.ts                          | 142 ++++++++
 src/lib/scan/index.ts                          |  62 ++++
 src/lib/scan/items.ts                          | 121 +++++++
 src/lib/scan/layout.ts                         |  62 ++++
 src/lib/scan/lexicon.ts                        | 150 ++++++++
 src/lib/scan/modules.test.ts                   | 149 ++++++++
 src/lib/scan/numbers.ts                        | 153 ++++++++
 src/lib/scan/parse.test.ts                     | 115 ++++++
 src/lib/scan/parse.ts                          | 431 +++++++++++++++++++++++
 src/lib/scan/receipt-types.test.ts             | 462 +++++++++++++++++++++++++
 src/lib/scan/reconcile.ts                      | 154 +++++++++
 src/lib/scan/scan.test.ts                      | 113 ++++++
 src/lib/scan/scan.ts                           | 256 ++++++++++++++
 src/lib/scan/tesseract-engine.ts               |  69 ++++
 src/lib/scan/types.ts                          |  78 +++++
 src/lib/storage.ts                             |   2 +
 src/lib/types.ts                               |   3 +
 28 files changed, 3170 insertions(+), 192 deletions(-)
```

## Addendum (7 Nov 2026): owner review follow-up 1a

**Owner review of PR #2.** The optional `printedNetSubtotalCents` field (inherited from `fix/receipt-ocr-recovery`) is approved. Task 1a was requested before merge.

**What changed**
- **Fee lines are recorded.** When the parser folds a delivery, platform, packaging, small-order or booking fee into the service amount (D6), it adds a scan warning that lists them. For example: "Delivery/platform fees are included in the service charge: Delivery Fee 3.99, Platform Fee 0.40." The warning goes first in the list, so the 20-warning storage cap keeps it.
- **No schema change.** The record lives in the existing `ocrWarnings`. The review screen checks it with `hasFoldedFees(ocrWarnings)`, a pure helper exported from `@/lib/scan` that looks for the fixed prefix `FOLDED_FEES_NOTE`.
- **Review warning.** While "Calculate by %" is selected on such a receipt, the review screen shows: "Your receipt's delivery/platform fees will drop out if you calculate by %." It disappears when switching back to "Amounts on receipt". Receipts whose service amount is only a service charge never show it.
- **Single source for fee terms.** The fee terms now live once in `lexicon.ts` (`FEE_TERMS`). Both the `service` classifier and the new `FEE` pattern use them, so they cannot drift apart. The list of terms is unchanged.
- **Files:** `lexicon.ts`, `parse.ts`, `index.ts`, `ReviewStep.tsx` (one derived flag and one notice), and the new `ReviewStep.test.tsx`.

**Tests (run 7 Nov 2026)**

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npx vitest run` | ✅ 77/77 passed in 7 files (73 before + 4 new) |
| New parser tests | The fee note lists exactly the folded lines (the fee discount is not listed); both delivery fixtures are detected; a service-charge-only receipt is not |
| New UI test (`ReviewStep.test.tsx`) | Renders the real review screen with a scanned synthetic delivery receipt. The warning is absent in "Amounts on receipt", appears after clicking "Calculate by %", and goes away when switching back. A second case checks it never appears for a receipt without fees. Reverting the `ReviewStep` change makes this test fail, so it does detect a regression. |
| `npx eslint` + `prettier --check` on `src/lib/scan` and the new test | ✅ clean |
| `npx vite build` | ✅ succeeded |

`ReviewStep.tsx` was not Prettier-formatted before this work (60 existing complaints). The new notice line follows the file's existing one-line style (61 now), and the rest of the file was left unformatted, as the brief asks.

**Still open:** the stored service *rate* is unchanged when fees are folded in. The warning tells the user rather than changing the rate. The browser smoke test in §5 was not re-run for this change; the UI test covers the new warning.

The diff stat in §8 is from the original Batch 1 commit and does not include this addendum.
