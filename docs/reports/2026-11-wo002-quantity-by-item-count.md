# WO-002: Quantity confirmed by the receipt's printed item count

Branch `wo/002-quantity-by-item-count`, from `main` at 7b42ee0. Rule: **D15** (docs/DECISIONS.md).

## 1. Summary

When a receipt prints how many items were sold ("Total Qty 7", "Total 5 items", "Items: 3",
"No. of items 4"), the bare numbers that D7 leaves in item names are tried as quantities, all of
them at once. Only when every quantity then adds up to the printed count exactly are they taken;
otherwise nothing changes. Line totals never change.

On the 12 development receipts (stored readings, parser only, see §3): D15 fired on **1 receipt**,
which went from 13 corrections to 0 and from 6 silent errors to 0. No other receipt changed in any
way. Receipts within 2 corrections: 4/12 → **5/12**. No wrong quantity was introduced.

## 2. What changed

| File | Change |
|---|---|
| `src/lib/scan/lexicon.ts` | `itemCountOf`: the item-count wording, matched on the whole label with its delimiters, in the languages the lexicon covers (EN, MS/ID, DE, FR, ES, IT, NL). A bare "Items: N" needs the plural; "Qty 2" (per row) and "Pax" (people) are not counts. |
| `src/lib/scan/items.ts` | `splitItemLabel` / `readItemRow` now report the unresolved bare number (`BareNumber`: value, name without it, start or end, a tax marker in front of it, numbers at both ends) and whether the row is doubtful for another reason (`otherDoubt`). New pure function `quantitiesByItemCount` (the all-or-nothing rule). |
| `src/lib/scan/parse.ts` | Reads item counts while scanning lines; records candidate rows; after the total anchor, applies D15 to the rows the anchor kept: quantities set, numbers (and a tax marker in front of a trailing number) taken out of the names, D7 flag cleared unless the row is doubtful for another reason (then "Check this line"), and a warning on the review screen saying where the quantities came from. |
| `src/lib/scan/item-count.test.ts` | New synthetic tests (43). |
| `docs/DECISIONS.md`, `docs/MODULES.md`, `AGENTS.md` | D15 recorded; module table and test list updated. |

`review.ts` is unchanged: no new row reason; a confirmed row simply has no reason.

**Designed against silent errors.**
- All or nothing: a count that matches only if some of the numbers are taken changes nothing (tested).
- Any item row without a line total, a row with numbers at both ends, a candidate row that already
  has another quantity, a number not at an end of the whole name (wrapped description), a name cut
  at 80 characters, counts that disagree or are not whole: nothing changes.
- Explicit quantities and D7's own tests are applied first and are never overridden.
- Runs after the anchor, so the anchor behaves exactly as before (D15 changes no amounts, and the
  anchor never sees a cleared flag). Rows the anchor set aside are not counted.
- Every application leaves a warning on the review screen (standing rule 8).

**Side effect on D7.** When D7's unit × number test takes a number that follows a per-item tax
marker ("SOUP(GST*) 2  3.90  7.80"), the marker now leaves the name too, as it already did when
it ended the name. Tested; it did not change any development receipt.

## 3. Method (what was measured)

- **Parser only, on stored readings.** The 12 development receipts' Tesseract readings stored from
  the Batch 3 final browser run were parsed by `origin/main` (7b42ee0) and by this branch: the same
  text in, so the difference is the rule alone. Scoring: the harness's own `evaluate` and
  `countCorrections` / `countSilent`, `name-match=recognisable-0.70`, against the owner references.
  A local script did this; nothing private is in the repo.
- The `main` numbers reproduce the Batch 3 report's browser results exactly (4/12, 10 silent,
  15 missing, 24 extra, 4 wrong quantities), so the stored readings stand for the browser run.
- **Not measured: a browser run of this branch.** WO-002 changes no image or OCR code, but the
  scan workflow's pass choice uses a parse score that counts flagged rows (`scoreParse`). D15
  clears flags only where the count confirms the quantities, so it can only raise the score of a
  reading where it fires; a different first/second-pass choice on that one receipt is possible but
  was not checked. No timing change is expected (the rule is a single pass over the rows).

## 4. Results (12 development receipts, aggregate)

| Measure | Before (main 7b42ee0) | After (this branch) |
|---|---|---|
| Receipts within 2 corrections | 4/12 (33.3%) | **5/12 (41.7%)** |
| Silent financial errors | 10 | **4** |
| Missing products | 15 | **9** |
| Extra rows | 24 | **18** |
| Wrong quantity | 4 | **3** |
| Wrong line amount | 4 | 4 |
| Wrong charge fields | 9 | 9 |
| Wrong printed total | 5 | 5 |
| Receipts where D15 fired | – | 1 |
| Receipts worse on corrections or silent errors | – | **0** |
| Wrong quantities introduced | – | **0** |

Name corrections: with exact name matching (stricter than the scoring rule), item names wrong
on the receipt where D15 fired went from 8 to 0 (missing + extra 16 → 0); across all 12, missing
24 → 16 and extra 33 → 25. Under the scoring rule the 6 missing + 6 extra rows on that receipt were
names that still carried "(GST) 1" or "(GST) 2" and were too far from the reference name.

On the other 11 receipts, the parse output (items, quantities, flags, charges, totals) is
identical before and after. None of them had an item count in its reading.

## 5. Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npm run receipts:check` | pass |
| `npm run test` | pass, 17 files, 376 tests (43 new) |
| `npm run receipts:test` | pass, 6 files, 77 tests |
| `npm run build` | pass |
| `npx wrangler@4.154.0 deploy --dry-run --config cloudflare/wrangler.jsonc` | pass |
| `review-smoke.mjs` (headless Chrome, synthetic receipt) | SMOKE PASS |
| `npx eslint` on the touched source and test files | 0 errors, 0 warnings |
| Private-data scan of the diff | done before push: no shop, item, card or address text from real receipts |
| Browser before/after run on the development receipts | **not run** (see §3) |
| Full `npm run lint` | not run (crashes on `main`; WO-003) |

## 6. Known limitations

- Only one development receipt prints an item count in its reading, so the evidence on real
  receipts is n = 1. The negatives are covered by synthetic tests only.
- A count printed in front of "TOTAL" ("2 TOTAL 13.80") is not read as an item count: it is not
  one of the agreed wordings and could be something else.
- Found, not changed (outside this work order): a name ending in "x" followed by a number
  ("Gift Box 40") is read by `splitItemLabel` as an explicit "x40" quantity. That is an existing
  rule ("COFFEE x2"); it deserves a separate look.

## 7. Decisions needed

None.
