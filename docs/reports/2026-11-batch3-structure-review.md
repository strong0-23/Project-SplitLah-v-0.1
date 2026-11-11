# Batch 3: structure + review

**Branch:** `batch3/structure-review`, from `main` at 6dbcd90. **Date:** 11 Nov 2026.
**Stage:** MVP. Tesseract stays the only production engine; no engine settings changed.
**Data:** aggregate counts only. No receipt content, names, amounts or per-receipt results appear in
this report, the tests, the commits or the PR. All committed tests and fixtures are synthetic.

## 1. Summary

- On 7 unseen receipts the owner measured 0/7 within 2 corrections, mostly from extra rows, charges
  on GST-inclusive receipts and a wrong printed total. This batch works on those three in general
  ways, and makes the review screen faster to correct.
- **New pure modules:** `anchor.ts` (total-anchored item selection), `totals.ts` (total evidence:
  payment agreement, per-section totals, tax tables, damaged-label totals), `review.ts` (review
  hints derived from the stored OCR text).
- **Parser:** a header zone guard, card/terminal/reference vocabulary, "Total Inc. GST" and
  "Total N items" totals, tax tables, comma-for-point totals (flagged), quantity × unit rows under a
  name, and per-row review reasons.
- **Review screen:** one-tap delete with Undo; set-aside lines under "N lines hidden — show" with
  "Add back"; a short reason under each highlighted row; a top banner with the difference when the
  bill doesn't match the printed total; no plain "matches" while lines are hidden.
- **Development receipts (12):** within 2 corrections 2 → 4; silent errors 11 → 10; extra rows
  28 → 24; charges 12 → 9; printed total 7 → 5. Small sample: one receipt is about 8 points.
- **Batch 1b parser gate:** still `OVERALL: FAIL`, as it already was on `main` with these readings;
  no receipt got worse (section 5).
- No storage schema, `Receipt` interface or dependency change.

## 2. What changed

| Area | Change | Decision |
|---|---|---|
| `anchor.ts` (new) | Which doubtful rows add up to the printed total; the rest are set aside. Unique best subset only; protected rows never set aside; bounded by size (40 rows, 4 M cells), deterministic | D9 |
| `totals.ts` (new) | Payment agreement, cash minus change, per-section totals, tax-table rows, damaged-label sum row | D10, D11 |
| `review.ts` (new) | `reviewHints(rawOcrText)`: set-aside lines and row reasons for the review screen, nothing stored | D13 |
| `parse.ts` | Header zone; item line/section tracking; reasons; payments; tax tables; total choice with payment evidence and label strength; the anchor before `reconcileCharges`; `ParseResult.setAside`, `itemReasons`, `anchor` | D9–D12 |
| `lexicon.ts` | "Inc." GST totals and notes; "Total N items"; card-terminal / approval / reference / copy / station lines as noise; tax-table heading; change/cash labels; `totalLabelStrength` | D10–D12 |
| `numbers.ts` | "14,60" on a dot-decimal receipt read as 14.60, marked repaired (D8) | D12 |
| `ReviewStep.tsx` | Undo, hidden lines, reasons, mismatch banner; the existing behaviour otherwise | D13 |
| `tools/receipt-regression/smoke/review-smoke.mjs` (new) | Headless scan → review → split journey on a synthetic receipt under `wrangler dev` | — |

The algorithm and its limits are in docs/MODULES.md, "Total-anchored item selection".

### Designed against silent errors

A silent error is a wrong financial field with no review signal. The anchor could create one by
hiding a real item while the bill "matches". Guards:

1. Protected rows (unflagged, priced, inside the item list) are never set aside. Only flagged rows,
   header-zone rows and rows after the total are searched.
2. Only a unique best subset is applied; ties, two possible tax readings, or a payment that
   disagrees with the total mean nothing is hidden.
3. Whenever a line is hidden, the receipt's items are marked for review, the first warning says so,
   and the total notice reads "Matches the receipt total, with N lines hidden…", never a plain
   "matches". The lines stay one tap away.
4. A total found from an unlabelled sum row also marks the items for review (the match then only
   confirms the amounts read).

Tested: `anchor.test.ts` (protected rows, ties, tax readings, bounds), `structure.test.ts` ("a real
item hidden by coincidence is never silent", "never hides a real item when the total doesn't add
up", "hides nothing when a payment disagrees"), `ReviewStep.test.tsx` (no plain success while
lines are hidden).

## 3. Method

- Harness: `tools/receipt-regression` (`npm run receipts:dev`), **development mode** (held-out mode
  off), source "Engine comparison", engine **Tesseract only**, warm re-scans 0, name rule
  `recognisable-0.70` (unchanged). Then source "Parser gate (Batch 1b)" on the same receipts.
- Receipts: the 12 owner development receipts and their references, read locally only.
- Browser: headless Chrome 153 on Linux, driven by a local Playwright script (not committed).
- Before: `main` at 6dbcd90. After: this branch's final code. Same machine, same settings.
- During development, the OCR text was re-parsed offline to diagnose; reported numbers are only
  from the browser runs.

## 4. Results (12 development receipts, Tesseract, aggregate)

| Measure | Before (main 6dbcd90) | After (this branch) |
|---|---|---|
| Receipts within 2 corrections | 2/12 (16.7%) | **4/12 (33.3%)** |
| Silent financial errors | 11 | **10** |
| Missing products | 15 | 15 |
| Extra rows | 28 | **24** |
| Wrong quantity | 4 | 4 |
| Wrong line amount | 5 | **4** |
| Wrong charge fields | 12 | **9** |
| Wrong printed total | 7 | **5** |
| Failed scans | 0 | 0 |
| First-scan median | 5.0 s | 4.9–5.2 s (three runs) |

How the anchor itself behaved on the 12 final readings: matched 3 (lines hidden on 1 receipt,
1 line in all), no exact subset 4, not run 5 (no total read, or every row protected). On most of
these readings a total or an item amount is misread, so there is no exact subset: the anchor then
changes nothing, by design. The gains here came mostly from the total and GST rules and the
vocabulary; the anchor's effect on the owner's unseen receipts, where extra rows were the main
problem, is **not measured**.

### What still costs the most corrections (development set, aggregate)

- A quantity printed after a per-item tax marker on a receipt whose Qty heading OCR damaged: under
  D7 the number stays in the name, so names don't match. 12 of the remaining corrections. See "Decisions needed".
- An upside-down reading (orientation): 15 of the remaining corrections. Engine/orientation work
  is out of scope.
- Item amounts or totals lost or misread by OCR (the rest).

## 5. Batch 1b parser gate (parser-v2 vs rework, exact names)

| | Before (main) | After |
|---|---|---|
| Receipts passing the gate | 2/12 | 3/12 |
| of which REG001–004 (the original gate set) | 1/4 | 1/4 |
| Failures: "extra items" | 5 | 4 |
| Failures: "silent errors" | 6 | 5 |
| Rework silent errors (exact names, all 12) | 14 | 14 |
| parser-v2 silent errors (all 12) | 1 | 1 |
| OVERALL | FAIL | **FAIL** |

**It still does not pass, and it did not pass on `main` either with these OCR readings.** This
batch made no receipt fail that passed before. The owner's earlier PASS on REG001–004 (revision
5f374d8, the owner's PC) was with different readings, or before later parser changes; which of the
two is not established. The remaining failures:

- The gate matches names exactly. Rows whose names OCR misspelled count as missing plus extra, and
  once the app's total matches, a missing row counts as silent. parser-v2 reports a doubtful
  quantity as "unknown", which the gate never counts as silent; the rework shows a quantity and
  flags it. Most rework silent errors in the gate are of these two kinds.
- Does it matter? The gate compared two parsers on the same text to stop the rework regressing
  parser-v2's rules; on that question this batch is neutral or better on every receipt. The
  owner-approved measure for "how much fixing a scan needs" is now the corrections count above
  (recognisable names). Re-running the gate on the owner's PC would show whether the readings differ.

## 6. Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx vitest run` | pass, 361 tests (311 on `main`) |
| `npx eslint src/lib/scan src/components/splitlah tools/receipt-regression` | 0 problems in every file this batch touches; `ReviewStep.tsx` was formatted with Prettier in its own commit (it had 61 Prettier-only problems on `main`). The 139 problems left are Prettier-only, in untouched files |
| `npx vite build` | pass |
| `npm run receipts:test` | pass, 89 tests |
| `npm run receipts:check` | pass |
| `npx wrangler@4.154.0 deploy --dry-run --config cloudflare/wrangler.jsonc` | pass |
| Headless smoke (`review-smoke.mjs`, `wrangler dev`, security headers on, synthetic receipt): scan → review (hidden line, add back, mismatch banner, delete, undo) → split | pass |
| Harness before/after on 12 development receipts (headless Chrome) | run; section 4 |

Not checked: phones, Edge, Firefox, Safari; the held-out receipts; the anchor on the owner's 7
unseen receipts; screen readers (the controls have labels, `aria-expanded` and `role="status"`,
but no assistive-technology run).

## 7. Known limitations

- 12 development receipts, several heavily damaged by OCR; one receipt is about 8 points.
- The anchor needs a correctly read total and exact item amounts; it does nothing otherwise.
- A hidden line or a total from an unlabelled sum row marks the items uncertain, which also makes
  the scan try its second OCR pass (`isConsistent`); the measured first-scan median did not change
  beyond run-to-run noise.
- Hidden lines are derived again from the stored OCR text; if a later parser version reads that
  text differently, the hidden list of an old saved bill can change (it never changes the items).
- The header zone is a heuristic for receipts with no item heading; a row wrongly put in it is
  only flagged, and can be set aside only when the total confirms it.

## 8. What the owner should test by hand

1. Scan 3–4 familiar receipts with header/address or card blocks: are any real items hidden? Open
   "N lines hidden — show" and check each line; "Add back" one and see the banner.
2. A GST-inclusive retail receipt (with "Total Inc. GST" or a net/tax/gross table): GST must not be
   added on top, and "Prices already include GST" should be on.
3. Delete an item, then Undo: it must come back in the same place (and keep its split assignment if
   you went to Split and back).
4. A receipt where items don't add up: the top banner must show the difference.
5. On a phone: the expander and Undo are easy to tap.

## 9. Decisions needed

1. **D7 extension (proposed, not implemented):** accept a bare trailing number as the quantity when
   the receipt's printed item count ("Total Qty N") equals the sum of those numbers. It would
   address the largest remaining cause on the development set (12 corrections), but it
   changes owner decision D7, so it waits for the owner.
2. **Review D9–D13** in docs/DECISIONS.md (rules of this batch).
