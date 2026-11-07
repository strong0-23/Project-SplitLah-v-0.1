# Local receipt regression harness (Batch 1b merge gate)

A separate, localhost-only Vite page with no new dependencies. It runs **two parsers on the same
text** for every receipt and scores both against your verified references:

- **parser-v2**: the baseline. A read-only copy of branch `parser-v2`'s parser at commit a80f7e3,
  in `baseline/parser-v2/`. Only this tool imports it; the app never does.
- **rework**: the parser this branch ships (`src/lib/scan`).

Each is scored with its own bill arithmetic. Reference answers are read after parsing and are
never passed to OCR or to a parser.

Ported from branch `parser-v2` (`tools/receipt-regression`). Batch 1b changes: both parsers per
receipt, OCR mode uses the rework's scan path once and gives that one text to both parsers, silent
errors are counted, and a shareable **Summary scores** block applies the merge gate.

## Owner's scored run (Windows PowerShell)

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

1. Open **http://127.0.0.1:8081/**.
2. **Dataset folder**: select your private folder with `dataset.json` for Receipt2–5 (the same
   folder and `dataset.json` format you used with parser-v2, e.g. `receipt-regression.local\`).
3. **Mode**: "Parser only (verified transcript)". Enter a revision label (for example the commit
   SHA shown by `git rev-parse --short HEAD`) and click **Run sequential suite**.
4. Click **Copy summary scores** and keep the text.
5. Switch **Mode** to "Browser OCR + parser", run again, and copy that summary too.
6. Send back only the two **Summary scores** blocks. They contain receipt IDs and counts, no
   receipt content. Keep any downloaded full report private: it holds OCR text and your answers.

Stop the page with Ctrl+C in the terminal.

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

## Private dataset

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

Select `tools/receipt-regression/examples/` as the dataset folder and run both modes. Both receipts
should show `gate: PASS`. They are invented, clean images, so this proves the tool works, not
real-photo accuracy.

## Checks and isolation

```powershell
npm.cmd run receipts:test    # harness unit tests (no browser OCR)
npm.cmd run receipts:check   # type-check the harness and the baseline copy
```

The harness config binds to 127.0.0.1, serves no public assets, denies the private folder and
refuses production builds. The app's normal build never imports the harness.
