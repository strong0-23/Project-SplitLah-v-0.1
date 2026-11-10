# Batch 2a: parser-v2 inventory and port (report)

**Branch:** `engine-eval`, cut from `main` at a53bd58 (PR #2 merged). **Date:** 10–11 Nov 2026.
**Source:** branch `parser-v2`, commit a80f7e3 (owner's snapshot, 410/410 tests; re-run here: 410/410).
**Status:** category (a) ported and tested on synthetic text. Categories (b) and (c) are listed for
your approval; none of them was ported.

## 1. Summary

- Batch 1b had already ported parser-v2's main parsing rules. To find what was still missing, I ran
  every parser-v2 parser-test input (plus extra synthetic cases) through **both** parsers side by
  side and read parser-v2's `parser.ts`, `receipt-rounding.ts` and its four docs.
- **8 parsing rules were still missing and are now ported** (§3). Two of them fixed silent errors on
  the rework: a lone unit price after `@` was stored as the line total, and a total printed with a
  minus sign was accepted.
- **6 parser-v2 rules were not ported** because they conflict with D2, D8, an owner-approved Batch 1b
  rule, or an established rework rule (§4).
- **UI/review (b): 6 features; storage/bill maths (c): 6 features** wait for your approval (§5–6).
  OCR-side code (d) belongs to Phase 2b/2c (§7).
- No change to `types.ts`, `storage.ts`, `bill.ts`, the UI or the dependencies.

## 2. Inventory

| # | parser-v2 behaviour | Cat. | Status |
|---|---|---|---|
| — | OCR-tolerant labels, trailing/implicit quantity (D7), discount de-duplication, rounding detection (D4), payment labels, column/row recovery | a | Ported in Batch 1b |
| A1 | An amount right after `@` is a unit price; without a second amount the line total is unknown | a | **Ported** |
| A2 | A decimal or fractional number next to a name (`VERSION 2.5`, `LOOSE TEA 1/2`, `0.5 x TEA`) is not a known quantity | a | **Ported** (kept in name, flagged; D7 extended) |
| A3 | A total printed with a minus sign is not used | a | **Ported** |
| A4 | A rounding row with no readable amount, or with no total, is retained for review and never applied | a | **Ported** |
| A5 | An unlabelled minus amount (`-1.00`) is not a discount | a | **Ported in part** (D2 case kept, see C1) |
| A6 | Discount grammar: `Member Discount`, `Discount: CODE` | a | **Ported** (codes need a digit) |
| A7 | Unit price and line amount on different tax bases: no quantity worked out from them | a | **Ported** |
| A8 | `scoreParse`: a reading with no items never beats one with items | a | **Ported** |
| C1 | Unlabelled minus under a priced item is never deducted | a | Conflict with **D2** |
| C2 | No OCR digit repair inside amounts | a | Conflict with **D8** |
| C3 | First printed total wins when totals conflict | a | Conflict with the rework's last-total-before-payment rule (Batch 1; already ADAPTED in 1b) |
| C4 | An unpriced product-like line under a table header is an "ambiguous row", not an item | a | Conflict with the owner's **P1** rule (Batch 1b brief item 3) |
| C5 | No quantity auto-fill while a discount's scope is unresolved | a | Conflict with **D2** (D2 resolves the scope; the row stays flagged) |
| C6 | Flag every item whose quantity was not printed (`Coffee 4.00` under "Description Amount") | a/b | Part of the evidence model and quantity review, see B3/X1 |
| B1 | "Save as defaults?" prompt for currency, GST rate, service rate | b | Needs approval |
| B2 | Bulk confirm of printed charges and GST (incl. flagging arithmetic-inferred GST mode) | b | Needs approval |
| B3 | Quantity review: flagged implicit-quantity defaults on aligned two-column layouts, "apply 1" bulk action | b | Needs approval |
| B4 | Receipt status: Ready / Needs check / Failed, gating Review → Split → Summary | b | Needs approval (needs X1) |
| B5 | Review-screen rounding panel (unrounded total, adjustment, payable) | b | Needs approval (needs X2) |
| B6 | Signed-amount and row-role review cards ("Lines not used" with roles) | b | Needs approval (needs X1) |
| X1 | Field evidence/provenance, `quantityExact`, row roles, unit price/price basis, schema v2 + migration | c | Needs approval |
| X2 | Rounding as a signed bill adjustment shared among participants | c | Needs approval **and a change to D4** |
| X3 | Signed credits and returns (`Return SOAP -4.00` as a negative item) | c | Needs approval |
| X4 | Fractional/measured quantities with a price basis (`250 g @ 1.00/kg`) | c | Needs approval |
| X5 | Suggested total from a single card payment | c | Needs approval |
| X6 | Implicit-quantity default markers stored per receipt and preferences store | c | Needs approval (with B1/B3) |
| D1 | OCR coordinator: alternate-attempt total recovery, item-region re-reads (`receipt-reading.ts`, `ocr-regions.ts`) | d | Phase 2b/2c (engine work) |
| D2x | Engine-neutral recognition document (`recognition-document.ts`, `documentFromPaddle`) | d | Used as input to the Paddle adapter design (2b report) |
| — | Triage of the 35 legacy test failures | — | **Not found**, see §8 |

## 3. What was ported (category a)

All in the responsible modules; tests in `src/lib/scan/parser-v2-port-2a.test.ts` (38 tests,
synthetic text, invented names).

| # | Rule | Before (rework) | After | Where |
|---|---|---|---|---|
| A1 | `COFFEE 2 @ 3.50`, `COFFEE @ $3.50`, a detail row `2 @ 8.95`, `BANANA 0.512kg @ 3.98/kg` with nothing after | Line total = 3.50 (unit price), not flagged: **silent error** | Line total empty, row flagged, warning names the unit price ("enter its line total"). `2 @ 8.95  17.90` still reads 17.90. A lone amount after `N x` is kept but flagged | `items.ts` (`readItemRow`, `AT_UNIT`), `parse.ts` |
| A2 | `VERSION 2.5`, `LOOSE TEA 1/2`, `SPARKLING WATER 1.5`, `0.5 x LOOSE TEA`, `1/2 ROAST DUCK`, also under a Qty heading | Not flagged | Number stays in the name, row flagged (fractional quantities can't be stored; X4). `1.5L` and `No 8` unaffected | `items.ts` (`FRACTIONAL_EDGE`) |
| A3 | `Total 4.00-F`, `Total -4.00` | Accepted as 4.00: **silent error** | Not used; total uncertain; listed in "Lines not used" | `parse.ts` |
| A4 | `Rounding` / `Cash rounding unreadable` with no amount; a rounding row with no total | Ignored without a word | Warning, total uncertain, nothing applied. "Rounding" with its amount on the next line still works (D4 unchanged) | `parse.ts` |
| A5 | Unlabelled `-1.00` after a subtotal, or under an unpriced item | Deducted as a bill discount, not flagged | Not deducted; discount uncertain; in "Lines not used". Under a priced item D2 still takes it off that item, now flagged with a warning | `parse.ts` |
| A6 | `Member Discount 1.00-`, `Discount: ABC-1`, `Voucher #A12`, `Coupon - X2` | Became a flagged item with a minus sign | A discount. Only codes containing a digit, so `PROMO: SET A 5.00` stays a product | `lexicon.ts` |
| A7 | `Unit (incl GST) … Amount (excl GST)`, or "Unit prices exclude GST" + "Line amount includes GST" | Quantity auto-filled from unit and amount (flagged) | No quantity worked out; row flagged; one warning. A printed Qty column is still read | `lexicon.ts` (`mixedTaxBasis`), `parse.ts` |
| A8 | Second OCR pass with no items vs a first pass with damaged items | Could replace it | Footer-only reading scores −∞ | `reconcile.ts` |

## 4. Not ported: conflicts (your decision, if you want any of them)

| # | parser-v2 rule | Conflicts with | Effect today | Suggestion |
|---|---|---|---|---|
| C1 | Unlabelled `-1.00` under a priced item is never deducted | D2 | Taken off the item, now **flagged** (A5) | Keep D2 + flag |
| C2 | Never repair letters inside amounts | D8 | Repaired and flagged | Keep D8 |
| C3 | First printed total wins | Rework "last total before payment" | Both flag a disagreement | Keep rework |
| C4 | Unpriced product-like line = ambiguous row, not an item | P1 rule (your 7 Nov brief) | Own flagged item with no price | Keep P1 |
| C5 | No quantity auto-fill while discount scope is open | D2 | Auto-filled and flagged | Keep D2 |
| C6 | Every unprinted quantity flagged | Needs X1/B3 | Only D7/A2 cases flagged | Decide with X1/B3 |

## 5. Category (b): UI and review features, for approval

| # | Feature | User benefit | Files / schema touched | Risk |
|---|---|---|---|---|
| B1 | "Save as defaults?" prompt | Set your usual GST/service rates once instead of every bill | `preferences.ts` (new localStorage key, versioned), `ReviewStep.tsx`; per-receipt "prompt shown" marker needs X6 | Low. A new storage key; must never fill receipt values silently (parser-v2 keeps them marked "saved preference") |
| B2 | Bulk confirm printed charges and GST | One tap confirms service, GST and their rates when they were clearly printed | `review-confirmation.ts`, `ReviewConfirmations.tsx`, `ReviewStep.tsx`; needs X1 evidence | Medium. Depends on X1; easy to over-confirm if eligibility rules are loosened |
| B3 | Quantity review + "apply 1" | Fewer taps on receipts that print no quantities | `quantity-defaults.ts`, `QuantityReview.tsx`; needs X1 (`quantityExact`) and X6 | Medium. More flags at first (C6); the narrow layout rules must be kept to avoid wrong defaults |
| B4 | Receipt status Ready / Needs check / Failed | Clear "is this safe to split?" signal; blocks splitting a broken scan | `receipt-quality.ts`, `receipt-status.ts`, `ReceiptStatus.tsx`, `ReviewStep/SplitStep/SummaryStep.tsx` | Medium-high. Gating changes the wizard flow; needs X1 |
| B5 | Rounding panel on Review | See unrounded total, rounding and payable separately | `ReviewStep.tsx`, `summary.ts`; needs X2 | Tied to X2 and D4 |
| B6 | Row-role review (signed rows, returns, ambiguous rows) | Lines the parser couldn't place can be assigned a role instead of retyped | `ReviewStep.tsx`, row review; needs X1 (+X3 for returns) | Medium. Larger Review screen |

## 6. Category (c): storage, schema and bill maths, for approval

| # | Feature | User benefit | Files / schema touched | Risk |
|---|---|---|---|---|
| X1 | Evidence/provenance model, `quantityExact`, row roles, unit price / price basis, schema v2 + migration | Every value knows whether it was printed, inferred or typed; foundation for B2–B4, B6 | `types.ts` (+~50 lines), `storage.ts` (v1→v2 migration), `defaults.ts`, parser output | **High.** Breaks the `Receipt` interface and storage schema; migration of saved bills; large diff |
| X2 | Rounding as a signed bill adjustment, shared by participants | Each person's share adds up to the cash amount actually paid | `bill.ts`, `types.ts` (rounding fields), `receipt-rounding.ts`, `summary.ts` | Medium. **Reverses D4** (split on unrounded total); changes the bill maths |
| X3 | Signed credits and returns | A returned item reduces the bill instead of being retyped | `bill.ts`, `money.ts`, `types.ts` (`rowKind`) | Medium. Negative line totals through all split modes |
| X4 | Fractional/measured quantities and price basis | Weighed goods and "1/2" portions split by exact quantity | `quantity.ts`, `types.ts`, `bill.ts` (rational maths) | Medium-high. Touches quantity split mode |
| X5 | Suggested total from a single card payment | Receipts whose total line is lost still get a checkable total | `types.ts` (`suggestedTotalCents`), parser, Review | Low-medium. Must never be treated as a printed total |
| X6 | Per-receipt review markers (defaults applied, prompt shown) | Prompts aren't repeated; bulk actions are re-validated | `types.ts`, `storage.ts` | Low, but only useful with B1/B3 |

Recommendation: approve none of X1–X4 for the MVP unless real-receipt scores show a need; X5
(low risk) and B1 are the cheapest wins if you want one. X2 needs a D4 decision first.

## 7. Category (d): OCR-side code

parser-v2's OCR coordinator (`receipt-reading.ts`: alternate attempts, total recovery;
`ocr-regions.ts`: item-region re-reads; `ocr.ts`/`preprocess.ts`) is engine-side and belongs to the
engine comparison (2b/2c). Its `recognition-document.ts` (`documentFromPaddle`: Paddle boxes with
native 0–1 confidence) informed the Paddle adapter design in `2026-11-paddle-adapter.md`.

## 8. The "35 legacy test failures"

The brief asks for their triage, but no record of them exists in the parser-v2 snapshot: I searched
its docs, tests and both tool READMEs. Its own suite passes 410/410 here. Running the pre-parser-v2
parser tests (`da7d832` `parser.test.ts` + `ocr.test.ts`, 13 tests) against parser-v2 gives 2
failures (inclusive-tax arithmetic, OCR "I" in the qty column), not 35. **The triage can't be
reconstructed from the repository**; if it matters, it is on your PC's local history.

## 9. Tests

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **251/251** in 10 files (205 before + 38 Batch 2a + 8 Tesseract self-hosting) |
| `npx eslint src/lib/scan` | 0 problems (Prettier applied to `src/lib/scan` only) |
| `npx vite build` | succeeded |
| `npm run receipts:test` | 29/29 |

No existing test expectation changed. All tests use synthetic text; accuracy on real photos is
measured only by your harness runs.

## 10. Limitations noticed (not parser-v2 rules; not changed)

- An unpriced product line containing a summary word (e.g. "ROUNDING BISCUITS" with its price lost)
  is dropped by the P1 vocabulary rule without a warning.
- A currency symbol inside a damaged, unused line (e.g. "£") can raise the D1 foreign-currency
  warning.
