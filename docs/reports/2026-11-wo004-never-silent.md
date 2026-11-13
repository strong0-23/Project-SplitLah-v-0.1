# WO-004: Never silent on a newly readable receipt

Branch `wo/004-never-silent`, cut from `wo/001-reading-coverage` (`e981fc7`), 13 Nov 2026. Rules
D16 and D17 (docs/DECISIONS.md). Receipt IDs and counts only; no receipt content.

## Summary

- Silent errors: **main 4 → WO-001 7 → this branch 2**. No receipt has more silent errors than on
  `main` (REG101 2 → 0; REG106 and REG108 back to 0; REG109 and REG112 unchanged at 1).
- Corrections: unchanged from WO-001 on every receipt (this branch changes no value). Against
  `main`, REG108 still has **one more correction (7 → 8)**, which came with WO-001's fuller reading.
  The acceptance line "no receipt has more corrections than on main" is therefore **not met**; see
  "Decision needed" in the PR.
- Receipts within 2 corrections: 5/12 (main 5/12, WO-001 5/12). Reading coverage: 91.7% median,
  every receipt identical to WO-001.
- Review burden: flagged rows 24/37 (main), 19/34 (WO-001), **23/34** (this branch); uncertain money
  fields 27, 26, **29**.

## 1. Diagnosis of the new silent errors (WO-001 branch)

Measured with `dev-run.mjs` on the WO-001 branch, then each reading's stored OCR text re-parsed
locally to see which checks fail and why. `isSilent` (`tools/receipt-regression/model.ts`) counts
per field.

| Receipt | Field kind | Silent | Why it was silent | General pattern |
|---|---|---|---|---|
| REG106 | printed total | 1 | The total was read with a misread digit. One item price was read, two rows had no price, and the price read was already above the total. Neither tax reading fitted, so the charges were marked uncertain, but the total was not. The mismatch banner needs every price, so it could not show | A total that disagrees with what was read is not marked (fixed by D17) |
| REG108 | extra item rows | 2 | The total, item-count and card-payment labels were damaged by OCR, so no total was read. The payment line and a total line became item rows with no flag. "No total read" showed only as a receipt-level banner, which is not a per-field signal | With no total, nothing checks the item list, yet rows passed unflagged (fixed by D16) |

The coordinator's note expected REG108's silent errors on amounts, quantity or total. Diagnosis
shows they are the two extra rows; the quantity, amounts and total that are wrong on REG108 were
already flagged or marked.

The same diagnosis on the silent errors that `main` already had: REG101's two (a quantity and the
discount, on a partly read photo with no total) are the D16 pattern and are fixed by it. REG109's
(an item split into an extra row, total matches) and REG112's (a total misread far below the
items, but the only item row has no price, so nothing read exceeds it) are not touched.

## 2. Rules

### D16: nothing checks the money fields

When no total was read, or the scan says the photo was only partly read (D14), every item row is
flagged and items, total, charges and discount are marked uncertain. A row already flagged keeps
its reason; the others say "No total was read to check this line" or "Part of the photo was not
read". No value changes.

- No total: at the end of `parseReceiptLines` (`markForReview` → `markUnchecked`), so the review
  screen derives the same reasons again from the stored text (D13).
- Partly read: in `scanReceipt`, next to the existing note (`markUnchecked`); the review screen
  gives the reason from the stored note.
- Pass choice unchanged by construction: the scorer `scanReceipt` gives `runOcr` is now
  `scoreReading`, which scores the reading before the marks (`readReceiptLines`), so the D14
  second-pass choice is exactly as before. Coverage and every reading are identical to WO-001.

### D17: a total that disagrees is marked

When a total was read and items + service − discount (+ tax) differ from it by more than 5 cents
(D4) under both tax readings, the total and the charges are marked uncertain. With prices missing,
only when the prices that were read already exceed the total (a missing price is never guessed);
then a warning says so. No value changes. `totalDisagreement` in `reconcile.ts`; `MAX_ROUNDING`
moved there from `parse.ts` (same value).

### Candidates not adopted

- **Rows below the payment block flagged.** After a read total, rows are already skipped or flagged
  ("Printed after the total", D9/D12). On REG108 the parser recognised none of the total, payment
  or item-count lines, so such a rule could not fire; D16 covers it.
- **A repaired total label marks the total uncertain.** No new silent error came from one.

D17 changes the outcome on one development receipt only (REG106). It is kept because the work
order lists it, it rests on arithmetic rather than wording, and it only adds a review mark. Flagged
for the coordinator under standing rule 9.

## 3. Before / after (development set, 12 receipts)

**How measured.** Headless Chrome 153 on Linux, `dev-run.mjs --repeat 2`, `name-match=recognisable-0.70`,
first use. `origin/main` at `0437d2f` with this branch's harness files copied in (unchanged app
code; its D14 `incomplete` field left unmeasured because `main` has no D14), then this branch, back
to back, twice each (4 runs each). WO-001 (`e981fc7`, same harness files) measured once with
`--repeat 2` for reference. Correctness was identical in every run of the same code.

| Measure | main `0437d2f` | WO-001 `e981fc7` | This branch |
|---|---|---|---|
| Silent errors | 4 | 7 | **2** |
| Within 2 corrections | 5/12 | 5/12 | 5/12 |
| Corrections, all receipts | 48 | 39 | 39 |
| Missing / extra rows | 9 / 18 | 5 / 11 | 5 / 11 |
| Wrong quantity / amount / charges / printed total | 3 / 4 / 9 / 5 | 4 / 7 / 7 / 5 | 4 / 7 / 7 / 5 |
| Reading coverage, median | 79.2% | 91.7% | 91.7% |
| Flagged rows / item rows | 24/37 | 19/34 | 23/34 |
| Uncertain money fields | 27 | 26 | 29 |
| First-scan median (median of runs) | 6.49 s (4 runs, 6.23–6.59) | 6.89 s (2 runs, 6.67–7.11) | 6.97 s (4 runs, 6.62–7.68) |

Per receipt, main / WO-001 / this branch. Receipts not listed are identical in all three on every
column (REG001, REG003, REG004, REG107, REG109, REG110, REG111, REG112).

| Receipt | Corrections | Silent | Coverage | Flagged rows | Uncertain fields |
|---|---|---|---|---|---|
| REG002 | 2 / 2 / 2 | 0 / 0 / 0 | 5/6 / 5/6 / 5/6 | 3/4 / 4/4 / 4/4 | 3 / 3 / 3 |
| REG101 | 3 / 3 / 3 | 2 / 2 / **0** | 2/3 / 2/3 / 2/3 | 0/1 / 0/1 / **1/1** | 3 / 3 / **4** |
| REG106 | 15 / 5 / 5 | 0 / 1 / **0** | 0/3 / 2/3 / 2/3 | 11/11 / 3/3 / 3/3 | 3 / 2 / **3** |
| REG108 | 7 / 8 / 8 | 0 / 2 / **0** | 0/5 / 5/5 / 5/5 | 1/1 / 3/6 / **6/6** | 3 / 3 / **4** |

For completeness, the unchanged receipts (all three versions): REG001 0 corrections, 0 silent,
0/8 flagged, 0 uncertain; REG003 4, 0, 2/2, 4; REG004 0, 0, 1/2, 0; REG107 2, 0, 1/1, 2; REG109 2,
1, 0/2, 2; REG110 5, 0, 3/3, 2; REG111 3, 0, 1/1, 2; REG112 5, 1, 1/1, 3.

First-scan time: this branch changes nothing in the scan path (the scorer computes the same score
as before), so the difference from WO-001 is the shared machine's noise; the work order sets no
time limit.

### Acceptance

| Line | Result |
|---|---|
| Silent errors at most 4, none above `main` per receipt | **Met**: 2; per receipt ≤ main |
| No receipt has more corrections than on `main` | **Not met**: REG108 8 vs 7 (from WO-001; unchanged here) |
| Within 2 corrections at least 5/12 | Met: 5/12 |
| Reading coverage unchanged from WO-001 | Met: identical per receipt |
| Review burden reported | Above |

## 4. Harness change

`receipt |` summary lines carry the review burden of the first scan: `flagged=rows/of` and
`uncertain=N` (items, total, charges, discount; merchant and currency marks not counted).
Read back from pasted summaries; older lines without the fields read as "not measured". Tests in
`comparison.test.ts`, `engine-runner.test.ts`, `coverage.test.ts`.

## 5. Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npm run receipts:check` | pass |
| `npm run test` | pass, 20 files, 417 tests |
| `npm run receipts:test` | pass, 7 files, 84 tests |
| `npm run build` | pass |
| `npx wrangler@4.154.0 deploy --dry-run --config cloudflare/wrangler.jsonc` | pass |
| `tools/receipt-regression/smoke/review-smoke.mjs` (headless Chrome, `SMOKE_PORT=8899`) | SMOKE PASS |
| `tools/receipt-regression/smoke/engine-smoke.mjs` (extra; harness changed) | SMOKE PASS |
| `npm run lint` | 0 errors, 9 warnings (none in files this branch touches) |
| Private-data search of the diff | done before every push |

Changed test expectations: three parser-v2 port fixtures and one Batch 3 structure fixture had no
printed total, so D16 now flags every row; each gets a total line so they still test what they were
written for (marked "ADAPTED (WO-004, D16)" or commented).

Not run: Firefox or any phone (headless Chrome on Linux only). No held-out receipts exist on this
machine and none were read.

## 6. Limits

- Development set only (12 receipts, all seen before); the set is known to overstate real-world
  accuracy. At n = 12 one receipt is about 8 points.
- D16 highlights every row whenever no total is read, so on such receipts the highlight no longer
  points at the doubtful rows in particular; the row reasons still say which rows have a reason of
  their own.
- D17 with missing prices is one-sided: a total misread far below the items is caught only when the
  prices that were read already exceed it (REG112 stays silent: its only row has no price).
- REG108's extra correction against `main` is a parsing gap that WO-001 exposed: the item lines
  print a barcode, quantity, unit price and amount on the line below the name, and the parser does
  not read those columns. Out of scope here (no value changes in this work order).
