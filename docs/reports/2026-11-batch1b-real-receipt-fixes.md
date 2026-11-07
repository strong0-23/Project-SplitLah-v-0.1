# Batch 1b: real-receipt fixes (report)

**Branch:** `rework/receipt-scanner` (PR #2). **Date:** 7 Nov 2026. **Source of ported rules:** branch `parser-v2`, commit a80f7e3.
**Status:** done on synthetic data; **merge waits for the owner's scored run** (§6).

## 1. Summary

Your PC test of PR #2 found five parser failure patterns (P1–P5) on development receipts. This batch:

- ports parser-v2's parsing rules into `src/lib/scan`;
- fixes P1–P5;
- brings parser-v2's regression harness across, so you can score parser-v2 and the rework on the same receipts.

Two parser-v2 rules conflicted with D2 or with existing rework tests. You decided both on 7 Nov 2026; they are recorded as D2 (amended) and D7 in `docs/DECISIONS.md`.

All checks pass: `tsc`; 202/202 app tests, including 113 ported parser-v2 tests and one fixture per pattern P1–P5; 19/19 harness tests; ESLint and Prettier on the scanner and the harness; `vite build`.

No change to `types.ts`, `storage.ts`, `bill.ts` or the dependencies. `package.json` gains only the three `receipts:*` scripts, identical to parser-v2's.

## 2. What was ported

Each parser-v2 rule went into the responsible module:

| Rule family (brief) | parser-v2 behaviour ported | Where |
|---|---|---|
| OCR-tolerant summary labels | Finite word repair (I/l/1/\|/! ↔ l, O ↔ 0, S ↔ 5) on summary vocabulary only ("T0TAL", "TOTA1", "D1SC0UNT", "G5T"). Product names and amounts are never changed. Total labels with qualifiers ("Total (SGD) INCL.GST", "Grand Total ( INCL GST) ©", "2 TOTAL", "Total S $"). One stray margin character before a summary label ("E GST AMT", "4 Total saving"). Separators ("GST AMT;0.90", "Total:11.90", "Service Charge="). | `lexicon.ts` `normaliseLabelWords`, `classifyLabel`; `numbers.ts` (colon) |
| Trailing and implicit quantity | A bare leading/trailing number is a quantity only under a Qty heading (including "qiy"/"qly" in a full heading), or when unit × number = line total. Explicit "x"/"@" always count. A leading Qty column ("Qty Description Amount") wins over a trailing number. No/Model/ID/Code/SKU numbers are identifiers. Package sizes ("500ml", "1KG") are not weighings. | `items.ts`, `lexicon.ts` `qtyColumnsOf` |
| Discount de-duplication | A "Total savings/discount" summary is compared with the discount lines and never deducted again. On its own it is informational and flagged. Disagreeing summaries are flagged. | `parse.ts` |
| Rounding | One signed rounding row (+/−, trailing minus or parentheses; zero needs no sign) of at most 5 cents, after the items, is applied. An unsigned non-zero row, a row over 5 cents, a row before the items, or more than one row is not applied and flags the total. "Bill/Final rounding" labels. Applied per **D4** (split on the unrounded total). | `parse.ts`, `lexicon.ts` |
| Payment-label handling | Card lines with masked numbers ("MASTER:XXXX0000[123456]", "VISA ****1234"); "Master" alone; "Paid By"/"Credit"; payment amounts never become the total. | `lexicon.ts` |
| Column/row recovery | Description + "qty amount" row joins (e.g. "VITAMIN B 12" / "2 16.00"). Description + lone amount ("[ 4.20 V", "\| 3.10") keeps the amount, flagged. Description + damaged numeric columns ("\| 4.20 2", ": 4.20 V 2", "[ 4.20 8.40") gives an unpriced flagged item; digits are never mined. In unit-price layouts a lone amount is not taken as the line total, and a damaged final amount ("12.00 \| 2 XOO -") leaves the line total unknown. Orphan amount rows are never borrowed by a header or summary. Damaged tax notes are kept out of items. | `parse.ts`, `lexicon.ts` `isFinancialNote` |
| Also ported | Signed service/GST amounts are kept for review, never made positive. A minus sign on a product row is never a discount (flagged, price unknown). Two different totals with nothing between them are flagged. A row with an explicit quantity after a total is still an item. Non-SGD currency adds an uncertain "currency" field (D1 warning unchanged). | `parse.ts` |

### Owner decisions (7 Nov 2026)

- **D2 (amended):** item-level placement stays, and parser-v2's offer-match rule is added. A signed "N FOR $X" saving reduces the item above only if that item's explicit quantity is N and the amounts agree. Otherwise it is not deducted, and it is flagged.
- **D7:** parser-v2's bare-number rule was adopted. Three synthetic rework expectations changed and are listed in §5.

## 3. Not ported, and why

Item 2 of the brief excludes parser-v2's UI and storage features; their adoption is not approved. Rules that need fields the approved `Receipt` type doesn't have were not ported either.

**Available, not ported:**

| parser-v2 feature | Why not | parser-v2 tests not ported |
|---|---|---|
| "Save as defaults?" prompt for currency, GST rate, service rate (`preferences.ts`) | UI + storage; not approved | `preferences.test.ts` (9) |
| Bulk confirmation of printed charges and GST (`review-confirmation.ts`, `ReviewConfirmations.tsx`), including flagging every arithmetic-inferred GST mode | UI; not approved. The rework does not flag an inferred inclusive/exclusive mode when the arithmetic agrees (existing rework test). | `review-confirmation.test.ts` (9), `ReviewConfirmations.test.tsx` (7) |
| Quantity review: flagged implicit defaults, "apply 1" bulk action (`quantity-defaults.ts`, `QuantityReview.tsx`) | UI; not approved | `batch1c-parser.test.ts` defaults part (10), `QuantityReview.test.tsx` (5) |
| Receipt status: Ready / Needs check / Failed gating (`receipt-quality.ts`, `receipt-status.ts`, `ReceiptStatus.tsx`, row review) | UI + evidence model; not approved | `receipt-quality.test.ts` (24), `receipt-status.test.ts` (7), `row-review.batch1d.test.ts` (7), `review-safety.test.tsx` (4) |
| Field evidence/provenance, `quantityExact`, row roles, unit price and price basis, schema v2 + migration (`types.ts`, `storage.ts`) | Changes to `types.ts`/`storage.ts`; not approved. Ported tests assert the rework equivalents instead (flags, `uncertainFields`, warnings). | `storage.test.ts` (5), `batch1c-storage.test.ts` (3); evidence-only assertions in the parser suites |
| Rounding as a signed bill adjustment, shared among participants (`bill.ts`, rounding fields) | Changes to `bill.ts`/`types.ts`, and it **differs from D4**: parser-v2 splits the rounded payable, D4 splits the unrounded total. Needs an owner decision before any port. | `rounding-integration.test.ts` (10), `ReviewRounding.batch1d.test.tsx` (12), allocation part of `receipt-rounding.test.ts` (18) |
| Signed credits and returns ("Return SOAP -4.00" as a negative item) (`bill.ts`, `money.ts`, `quantity.ts`) | Needs signed line totals in `bill.ts`. The rework keeps such a row as a flagged, unpriced item. | `bill-signed.test.ts` (8), `money.test.ts` (3), return cases in `parser-interpretation.test.ts` |
| Fractional/measured quantities with a price basis ("LOOSE TEA 1/2", "250 g at $1.00/kg") | Rational quantities need `types.ts`/`bill.ts` changes | `quantity.test.ts` (10), fractional cases in the parser suites |
| Suggested total from a single card payment (`suggestedTotalCents`) | New `Receipt` field | 1 case in `parser-interpretation.test.ts` |
| OCR-side coordinator: alternate-attempt total recovery, item-region re-reads, recognition-document contract (`receipt-reading.ts`, `ocr-regions.ts`, `recognition-*`, parser-v2's `ocr.ts`/`preprocess.ts`) | OCR/engine scope (Batch 2), not parser rules | `receipt-reading.test.ts` (49), `ocr.test.ts` (13), `ocr-regions.test.ts` (4), `recognition-document.test.ts` (7), `recognition-parser.test.ts` (3), `preprocess.test.ts` (5) |

parser-v2's `bill.test.ts` (22) and `app-routing.test.tsx` (1) already exist in the rework as the same app tests.

## 4. Fixes for P1–P5

| # | Pattern | Fix | Fixture (synthetic, in `receipt-types.test.ts`) |
|---|---|---|---|
| P1 | Footer/summary lines appended to an item as notes; a price-lost item appended to the next item and lost | Only clear add-ons (`MODIFIER`: "+ Oat milk", "Add egg", "Warm up") attach to the item above. A line with summary, payment, date/time or transaction vocabulary, or mostly digits, never attaches. A product-like unpriced line becomes its **own flagged item with no price**. "Transaction No/Date/ID", "Approval code", "RRN" and similar are noise. | A grocer receipt with a price-lost loaf, "Total (SGD) incl. GST" on its own line, and two "Transaction" lines. It reconciles once the missing price is entered. |
| P2 | Quantity 4/8 from trailing tokens; a ticket row read as qty 1 | D7 quantity rule. Ticket descriptions followed by a "qty amount" row join with that quantity. | Grocery rows "BABY SPINACH PW 4", "GREEK YOGHURT % 8" (qty 1, flagged). A cinema ticket split over two lines (qty 2). |
| P3 | Bill discount = 2× the printed discount | A summary discount equal to the item discounts already applied is not counted again (with a warning). Savings summaries are compared, never deducted. | A pharmacy receipt: item-level "MEMBER DISC -2.00", then "DISCOUNT -2.00" and "TOTAL SAVINGS 2.00" in the summary. Discount counted once. |
| P4 | A total row read as an item ("T0TAL", "TOTA1"); "52455" without its decimal point | OCR-tolerant total labels. A 3–6 digit total/subtotal with no decimal point is a candidate only. It is read as cents and used, flagged, **only if it equals the computed total** (or the item sum, for a subtotal); otherwise the total stays not found. | "T0TAL 2453" (accepted as 24.53, flagged); the same with 2455 (not found); "TOTA1 4.00". |
| P5 | GST 6.18 where 9% of the base is 6.16, not flagged | `checkChargeRates`: if a printed GST or service amount differs from rate × base by any amount, the charges are marked uncertain and the warning shows the expected value. Never auto-corrected. It uses the app's own `applyRate`/`includedTax`. The rate is the printed one, or 9% for a "GST" line on an SGD/unmarked receipt. Several tax lines aren't checked against one rate. | GST 6.18 on 68.40 (flagged, "is 6.16"); 6.16 (not flagged); service 6.85 on 10% of 68.40 (flagged, "is 6.84"). |

P6 (garbled stylised merchant name) is OCR and out of scope, as the brief says.

## 5. Tests

| Check | Command | Result |
|---|---|---|
| Types (app) | `npx tsc --noEmit` | ✅ clean |
| App tests | `npx vitest run` | ✅ **202/202** in 8 files: 113 ported parser-v2 tests, 40 receipt types (12 of them for P1–P5), 9 parse, 11 module, 4 workflow, 2 review UI, 22 bill, 1 routing |
| Harness tests | `npm run receipts:test` | ✅ 19/19: both parsers on the committed synthetic examples, evaluator, silent errors, gate, summary content |
| Harness types | `npm run receipts:check` | ✅ clean (includes the baseline copy) |
| Lint / format | `npx eslint src/lib/scan tools` + `prettier --check` | ✅ 0 problems / clean |
| Build | `npx vite build` | ✅ succeeded. No harness code in the output. The Tesseract chunk is unchanged (19 KB, lazy); the routes chunk grew from 96.9 KB to 108.8 KB with the larger parser |
| Whole-repo lint | `npx eslint .` | 325 problems, all predating this batch and none in `src/lib/scan` or `tools/` (315 Prettier formatting, 9 `react-refresh`, 1 `no-control-regex` in `use-bill.tsx`) |
| Harness in a browser | `npm run receipts:dev` driven by Playwright, synthetic examples | ✅ Parser mode and OCR mode (real Tesseract; model files served locally because jsDelivr is blocked in the test sandbox): both receipts `gate: PASS`, OVERALL PASS |

**How parser-v2's tests were adapted** (all in `src/lib/scan/parser-v2-port.test.ts`, names kept):

- They now import from `src/lib/scan`.
- Assertions on parser-v2-only fields are translated: `quantityExact: null` becomes flagged with qty 1 and the number kept in the name; `evidence.*` becomes `uncertainFields`/warnings; row roles become "not an item and not deducted"; `scoreOcrText().good` becomes `isConsistent()`.
- 12 tests are marked **ADAPTED** with the reason:
  - D2 (offers and discounts under an item reduce the item; same total);
  - D4 (split on the unrounded total);
  - the rework's last-total-before-payment rule (parser-v2 kept the first total; both flag a conflict);
  - the rework's O→0 repair inside amounts (see §7).
- Ported per suite:
  - `parser.test.ts`: 43 tests, plus 8 already in the rework's `parse.test.ts`;
  - `parser-interpretation`: 24 of 30;
  - `parser-safety`: 10 of 15;
  - `batch1c-parser`: 6 of 16;
  - `trailing-quantity`: 19 of 42 (the other cases repeat through parser-v2's OCR coordinator, or use fractions or unit-price fields);
  - `receipt-rounding`: 11 of 29.

  The rest are in §3.

**Existing rework expectations changed by D7** (approved): "2 Pancakes 18.00" (US fixture), "Nasi Goreng 2"/"Es Teh Manis 2" (Indonesia fixture), "Pad Thai 2"/"Green Curry 1" (delivery fixture and the 1a review-screen test) now keep the number in the name and are flagged. Their totals still reconcile. One test call (`splitItemLabel(…, Qty column)`) gained the column argument.

## 6. Scored merge gate: harness instructions

The harness is at `tools/receipt-regression/`; its README has full details. On your PC (PowerShell, repository root):

```powershell
git fetch origin
git switch rework/receipt-scanner
git pull
npm.cmd install
npm.cmd run receipts:test
npm.cmd run receipts:dev
```

1. Open http://127.0.0.1:8081/ and select your private dataset folder (Receipt2–5 with `dataset.json`; the same format as parser-v2's harness).
2. Mode **Parser only (verified transcript)**. Enter a revision label (`git rev-parse --short HEAD`), run, and click **Copy summary scores**.
3. Mode **Browser OCR + parser**. Run and copy again.
4. Send back the two summary blocks only. They contain receipt IDs and counts. Keep full reports private.

**Gate:** merge only if, on **every** receipt, the rework matches or beats parser-v2 on items found, extra items, quantities, line amounts, printed total, calculated total and silent errors (fewer or equal). The summary ends with `OVERALL: PASS` only then. Each scoring term is defined in the harness README.

Scoring notes:

- In OCR mode both parsers read the same single OCR reading (the rework's scan path), so the comparison is parser-only. parser-v2's own OCR coordinator (alternate-attempt total recovery, item-region re-reads) is not part of it.
- parser-v2's "unknown quantity" is never a pass, following its own scoring.
- The rework always shows a quantity. A doubtful one is flagged, and flags count as review signals, not as passes.

### Owner's scores (placeholder: to be filled from your summary blocks)

| Receipt | Mode | Parser | Items (found/of, extra) | Qty | Line amounts | Printed total | Calculated total | Silent errors | Gate |
|---|---|---|---|---|---|---|---|---|---|
| Receipt2 | parser | parser-v2 | | | | | | | |
| Receipt2 | parser | rework | | | | | | | |
| Receipt3 | parser | parser-v2 | | | | | | | |
| Receipt3 | parser | rework | | | | | | | |
| Receipt4 | parser | parser-v2 | | | | | | | |
| Receipt4 | parser | rework | | | | | | | |
| Receipt5 | parser | parser-v2 | | | | | | | |
| Receipt5 | parser | rework | | | | | | | |
| Receipt2–5 | ocr | both | (same rows for OCR mode) | | | | | | |
| **Overall** | | | | | | | | | |

## 7. Not verified, limitations, and points for the owner

- **All tests use synthetic text.** Accuracy on your development receipts is measured only by your scored run. It has not been measured by me, and I have not seen those receipts.
- **Raised for your decision: O→0 inside amounts.** parser-v2 never repairs digits in amounts; the rework has always repaired O→0 and l/I→1 inside numbers ("1O.5O" → 10.50, an existing rework test). I kept the rework behaviour. A repaired GST that doesn't fit its rate is now flagged by the P5 check. Say if you want parser-v2's stricter rule instead.
- **Raised for later: rounding allocation.** parser-v2 applies rounding to the payable total and shares it among participants. D4 splits the unrounded total. Porting parser-v2's version needs `bill.ts` changes and a decision on D4.
- **Wrapped descriptions vs P1.** A wrapped description continues on the next line only when the first line ends on a joining word or comma ("… with", "… and"). Otherwise the next unpriced line now becomes its own flagged item rather than a note (P1 rule).
- **P5 base rate.** With no rate printed, only a "GST" line on an SGD or unmarked receipt is checked, at 9%. Non-SGD taxes are checked only against a printed rate. Japan-style per-item tax rounding can be flagged by 1 unit; it is flagged, never changed.
- **Config changes in this batch:**
  - `.gitignore`: `receipt-regression.local/`;
  - `eslint.config.js`: the verbatim baseline copy is excluded;
  - `package.json`: only the `receipts:*` scripts.
- **Sandbox only:** Tesseract's packages were installed from the public npm registry with lockfile-verified hashes because the lockfile's mirror is blocked here. The lockfile is unchanged.

## 8. Commits in this batch

- `02eaa5a` Scanner 1b: port parser-v2 parsing rules; fix real-receipt patterns P1–P5
- `80dbed4` Scanner 1b tests: parser-v2 parser tests ported; P1–P5 fixtures
- `b7c4800` Receipt regression harness: parser-v2 baseline vs rework on the same text
- this report, `DECISIONS.md` (D2 amended, D7) and `MODULES.md`

## Addendum (7 Nov 2026): owner decisions on §7

- **O→0 repair (D8):** kept. Every amount whose digits were repaired now marks what uses it:
  - an item row is flagged;
  - service/GST marks the charges uncertain;
  - a discount marks the discount uncertain;
  - a total, subtotal or rounding marks the total uncertain.

  The warning names the printed text, e.g. “1O.5O” was read as 10.50. Implemented with `Amount.repairedFrom` (`numbers.ts`) and `noteRepair` (`parse.ts`). Tests:
  - a synthetic receipt with repaired item, service, discount and total amounts: each is flagged and named, and it still reconciles;
  - the same receipt printed cleanly: no repair warning or flag;
  - a `findAmounts` unit test.

  `npx vitest run`: 205/205.
- **Rounding allocation:** deferred; D4 stays (split on the unrounded total).

## Addendum (8 Nov 2026): owner reference format in the harness

**Supersedes the §6 run instructions.** The harness now reads the owner's verified reference format (`tools/receipt-regression/reference-format/`: blank template + contract).

- **Default source:** "Owner references (Browser OCR)". You pick the photos folder (`development-working`) and the references folder (`owner-worksheet/reference-versions`) separately.
- **Pairing:** files pair by REG id. Only `REGnnn.jpg/png/webp` is read from the photos folder; the older `*.reference.private.json` there are ignored and never opened. If an id has several reference versions, the highest `owner-inventory-vN` is used and named in the summary. Unpaired ids are listed and not run.
- **Refusal:** every paired reference is validated with the unchanged contract (`validateReference`). If any reference fails, isn't valid JSON, or has a known `receipt_id` that doesn't match its file name, the run is refused before any OCR. The status lists `REG00n: <path> <code>`, with no values.
- **Scoring:** only fields with state `known` count; every other state is unscored (`unknownReferenceCredit: false`). README "How the verified references are scored" gives the full mapping.
- **Two fairness rules:**
  - an item discount scores the same whether a parser takes it off the item (D2) or puts it on the bill;
  - if the rounding inventory is known complete, the rework (D4) is compared with the unrounded total.
- **Tests:** `owner-reference.test.ts` (10 tests) uses synthetic references built from the committed template and checked with the contract. It covers:
  - the blank template and the contract policy;
  - refusal on missing evidence and on a receipt-id mismatch;
  - mapping of known fields;
  - discount placement either way;
  - unknown states never scored;
  - D4 rounding;
  - pairing.

  `npm run receipts:test`: 29/29.
- **Browser check:** Playwright on a synthetic copy of the owner layout.
  - Good run: REG901 paired and scored, gate PASS. REG902 (photo only) and REG903 (reference only) were unpaired and not run. The older reference in the photos folder, deliberately invalid JSON, was never read.
  - Bad run: a reference with a known value but no evidence was refused (`$.printed_payable_total known_requires_independent_evidence`), with no OCR started.
- **Config:** the contract `.mjs` is excluded from ESLint so it can stay unchanged. A type declaration (`reference-contract.d.mts`) was added beside it.

### Owner's scored run (replaces §6 steps)

```powershell
git fetch origin
git switch rework/receipt-scanner
git pull
npm.cmd install
npm.cmd run receipts:test
npm.cmd run receipts:dev
```

1. Open http://127.0.0.1:8081/ (Source: Owner references, Browser OCR).
2. Photos folder: `<folder>\development-working`.
3. Verified references folder: `<folder>\owner-worksheet\reference-versions`.
4. Enter a revision label and click **Run sequential suite**.
5. Click **Copy summary scores** and send back that block only.
