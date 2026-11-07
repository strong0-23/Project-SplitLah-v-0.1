# Local receipt regression harness (Batch 1b merge gate)

A separate, localhost-only Vite page with no new dependencies. It runs **two parsers on the same
text** for every receipt and scores both against your verified references (the owner reference
format in `reference-format/`, or the legacy `dataset.json`):

- **parser-v2**: the baseline. A read-only copy of branch `parser-v2`'s parser at commit a80f7e3,
  in `baseline/parser-v2/`. Only this tool imports it; the app never does.
- **rework**: the parser this branch ships (`src/lib/scan`).

Each is scored with its own bill arithmetic. Reference answers are read after parsing and are
never passed to OCR or to a parser.

Ported from branch `parser-v2` (`tools/receipt-regression`). Batch 1b changes: both parsers per
receipt, OCR mode uses the rework's scan path once and gives that one text to both parsers, silent
errors are counted, and a shareable **Summary scores** block applies the merge gate.

## Owner's scored run (Windows PowerShell, Browser OCR mode)

From the repository root:

```powershell
git fetch origin
git switch rework/receipt-scanner
git pull
npm.cmd install
npm.cmd run receipts:test
npm.cmd run receipts:dev
```

Then:

1. Open **http://127.0.0.1:8081/**. **Source** is already "Owner references: photos + verified
   references (Browser OCR)".
2. **Photos folder**: select `<folder>\development-working`. Only `REG001.jpg` … `REG004.jpg` are
   read. The older `REG00n.reference.private.json` files in that folder are ignored and never opened.
3. **Verified references folder**: select `<folder>\owner-worksheet\reference-versions`
   (`REG001.owner-inventory-v2.reference.private.json` … `REG004…`).
4. Check the status line: it lists the REG ids paired, and any unpaired id (those are not run).
5. Enter a revision label (for example `git rev-parse --short HEAD`) and click
   **Run sequential suite**. Each photo is read once by OCR, and both parsers read that same text.
   The first run downloads the recogniser files.
6. Click **Copy summary scores** and send back only that block. It contains REG ids and counts, no
   receipt content. Keep any downloaded full report private (it holds OCR text and your answers).

Stop the page with Ctrl+C in the terminal.

**The run is refused** if any paired reference fails the owner's contract
(`reference-format/reference-contract.mjs`, used unchanged), is not valid JSON, or has a known
`receipt_id` that doesn't match its file name. The status lists each problem as
`REG00n: <path> <code>` (no values), and no OCR is run.

### How the verified references are scored

Format and contract: `reference-format/` (blank template, contract, notes).

- Only fields with state **known** are scored. `not_printed`, `illegible`, `not_applicable` and
  `not_yet_verified` are unscored: they never earn or lose points (`unknownReferenceCredit: false`).
- **Items**: purchase rows with a known description; quantity when known and a whole number; full
  line amount when known. Extra items are scored only when `all_product_rows_accounted_for` is known
  true. Known return rows and fractional quantities are not scored (the app has neither); the
  summary says how many were skipped.
- **Discounts**: scored when `all_discounts_accounted_for` is known true and each discount's amount,
  scope and "already reflected" flag is known. An item discount printed separately from its row
  counts the same whether a parser takes it off the item (rework, D2) or puts it on the bill
  (parser-v2), as long as the amounts agree.
- **Service**: non-tax charges (delivery and platform fees count, D6), when
  `all_charges_and_taxes_accounted_for` is known true.
- **GST**: printed amount; inclusion mode `included`/`added` (`mixed` is unscored).
- **Totals**: `printed_payable_total`. If the rounding inventory
  (`preparation_extension.rounding`) is known complete, the rework, which splits on the unrounded
  total (D4), is compared with payable − rounding; parser-v2 with the payable.
- Item names match exactly (case and spaces ignored), or the name followed by a note the app added in
  brackets, e.g. "DRY MEE POK (MEMBER DISC -1.00)".

## What the scores mean

Per receipt and parser:

| Score | Meaning |
|---|---|
| items found/of, extra | Verified items found by exact name (case/whitespace ignored); extra unexpected items when `itemsComplete` is true |
| qty pass/of | Verified quantities that match. parser-v2's "unknown quantity" (`quantityExact: null`) is not a pass. The rework always shows a quantity; a doubtful one is flagged |
| amounts pass/of | Verified line amounts that match (the amount for the full quantity) |
| printed total | The total the parser read from the receipt vs your verified payable total |
| calculated total | The app's own computed total vs your verified payable total |
| silent errors | Failed checks with **no** review signal in the app: a wrong quantity/amount on an unflagged item, an unflagged extra item, a missing item while the app says the total matches, a wrong printed total not marked uncertain, a wrong calculated total while the app says it matches, or a wrong discount/service/GST not marked uncertain |

**Gate (per receipt):** the rework must match or beat parser-v2 on items found, extra items,
quantities, line amounts, printed total, calculated total and silent errors (fewer or equal).
**OVERALL: PASS** needs a complete run where every receipt passes. Null/omitted reference fields
are unverified and never count as passes for either parser.

In OCR mode both parsers read the rework's single OCR reading, so differences come from the
parser only. parser-v2's own OCR coordinator (alternate-attempt total recovery, item-region
re-reads) is not part of this comparison.

## Legacy: dataset.json folder

The parser-v2 `dataset.json` format still works: choose Source "dataset.json folder (legacy)", then
Parser only or Browser OCR mode.

### Private dataset

Prefer a folder outside the checkout, or the Git-ignored `receipt-regression.local/` at the
repository root. **Never put private data in `public/`, `src/`, `tools/` or the committed
examples.** Files are read into browser memory only; reports are saved only when you click
Download.

`dataset.json` (unchanged from parser-v2):

```json
{
  "schemaVersion": 1,
  "receipts": [
    {
      "id": "Receipt5",
      "image": "images/Receipt5.jpg",
      "transcript": "transcripts/Receipt5.txt",
      "notes": "",
      "expected": {
        "items": [{ "description": "EXAMPLE ITEM", "quantity": 2, "lineTotalCents": 500 }],
        "itemsComplete": true,
        "discountCents": 0,
        "serviceChargeCents": 0,
        "gstCents": 0,
        "gstInclusive": null,
        "payableTotalCents": 500
      }
    }
  ]
}
```

- `lineTotalCents` is the amount for the full quantity (two teas at 2.50 → `quantity: 2`,
  `lineTotalCents: 500`). `unitPriceCents` is optional reference metadata and is never scored.
- All money is non-negative integer cents; discounts are positive reductions. `0`/`false` are
  verified values; `null`/omitted means unverified.
- Optional `scanOptions`: `{ "rotation": null, "crop": null }` (rotation 0/90/180/270 clockwise).

## Smoke test with the committed synthetic examples

Choose Source "dataset.json folder (legacy)", select `tools/receipt-regression/examples/` and run
both modes. Both receipts should show `gate: PASS`. The owner reference format is covered by
synthetic references in `owner-reference.test.ts` (built from the blank template and checked with
the contract). These prove the tool works, not real-photo accuracy.

## Checks and isolation

```powershell
npm.cmd run receipts:test    # harness unit tests (no browser OCR)
npm.cmd run receipts:check   # type-check the harness and the baseline copy
```

The harness config binds to 127.0.0.1, serves no public assets, denies the private folder and
refuses production builds. The app's normal build never imports the harness.
