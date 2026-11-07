# Local receipt regression harness

This is a separate localhost-only Vite page, with no new dependencies. It imports the app's `runOcr`, `parseOcrResult`, `parseReceiptText`, `computeTotals`, and the same `scoreOcrText` callback as the scan UI. No reference answer is used to choose OCR output.

## Start and run

From the repository root in PowerShell:

```powershell
npm.cmd run receipts:dev
```

Open **http://127.0.0.1:8081/**. Select the dataset **folder**, choose a mode, enter a code revision/experiment label, and run. Receipts run in manifest order, one at a time. Cancel stops the current receipt and remaining suite; a partial report can be downloaded. Restart Vite after code changes and rerun the whole suite for a clean experiment.

- **Browser OCR + parser** uses real browser canvas, workers and Tesseract. First use downloads recognizer assets. There is no photo upload or cloud OCR.
- **Parser only** reads a manually verified text transcript, bypassing OCR. It does not count as a browser OCR test. Existing `npm.cmd test` OCR tests mock the recognizer and are also not photo tests.

For a smoke test, select `tools/receipt-regression/examples/`: it contains only invented merchant data and known reference answers. Run both modes separately. PNG examples are deliberately simple, so success does not establish real-photo accuracy.

The inclusive example checks that a discount is deducted before reconciling the GST-inclusive payable total.

## Private dataset and adding receipts

Prefer a folder outside the checkout, for example `C:\Users\<you>\Documents\SplitLah-receipts`. Alternatively, the root `receipt-regression.local/` directory is Git-ignored. **Never put private data in `public/`, `src/`, or the committed examples directory.** The picker reads files into browser memory; no dataset is imported into source code, served by Vite, saved to app storage, or copied into production assets. Reports are saved only when Download is clicked. Choose the private folder as their destination. Git ignore cannot protect files manually saved elsewhere or force-added.

Create a `dataset.json` at the folder root (copy the synthetic example), with relative forward-slash paths:

```json
{
  "schemaVersion": 1,
  "receipts": [
    {
      "id": "Receipt5",
      "image": "images/Receipt5.jpg",
      "transcript": "transcripts/Receipt5.txt",
      "notes": "Reference verification pending",
      "expected": {
        "items": null,
        "itemsComplete": false,
        "discountCents": null,
        "serviceChargeCents": null,
        "gstCents": null,
        "gstInclusive": null,
        "payableTotalCents": null
      }
    }
  ]
}
```

Add another object with a unique stable `id` and its image/transcript paths to add another merchant layout. Images obey the app's JPEG/PNG/WebP and 10 MB limits. `transcript` can be omitted when only OCR is being evaluated; parser mode reports a missing-input error for that case. Paths never need to be absolute. Reselect the folder after edits so the browser reads updated files.

### Manually verify references before scoring

For Receipt5 and the second failing receipt, first supply their local paths. We will inspect each photo and transcribe item names, quantities, amounts and summary lines independently of scanner output. Keep uncertain fields null until confirmed. The harness shows the original image alongside a separate OCR text section, parsed JSON/warnings, totals, and the reference. It never generates answers from OCR.

- `items`: known item rows, each with `description`, optional/null `quantity`, `lineTotalCents`, and optional `unitPriceCents`.
- **Line amount is the amount for the full quantity**: two teas at 250 cents each mean `quantity: 2`, `unitPriceCents: 250`, `lineTotalCents: 500`. Do not put 250 in the line amount. The parser has no unit-price field; unit price is human-reference metadata and is always unscored. Do not infer a line amount from a blurry unit price without verification (printed offers/discounts may differ).
- All monetary values are nonnegative integer cents; discounts are positive reductions. `discountCents: 0` explicitly verifies no bill-level discount. Do not double-count discounts already included in printed line amounts.
- `serviceChargeCents`: actual service charge added, `0` for verified none.
- `gstCents`: GST amount whether included or added; `gstInclusive: true` means already included, `false` means added. For verified no GST, use `gstCents: 0` and leave inclusion null if not applicable.
- `payableTotalCents`: printed final payable total. Both parsed printed total and app-computed total are checked against it separately.
- Omitted/null fields are **unverified**, never passes. Zero/false are verified values. A receipt with no verified answers has no accuracy passes, even if OCR completes.
- `itemsComplete: true` asserts the complete item list was checked; only then are extra rows scored. Missing known items are always failures. Descriptions match exactly after case and whitespace normalization; no fuzzy matches hide errors. Duplicate descriptions match in printed order. Misspelled OCR descriptions appear as missing/extra rows; visually inspect the raw text to determine the source.

Check item sums, discount, service, included/added GST and payable total against the photo. Record unresolved arithmetic in `notes`; do not change answers to make the parser pass. Unsupported adjustments such as rounding may deliberately fail computed-total checks.

Optional `scanOptions` has the app's `{ "rotation": null, "crop": null }` defaults. Manual rotation is 0/90/180/270 clockwise; crop fractions apply to the oriented image. Fixed options are included in the comparison fingerprint.

## Reports and baselines

Download a report after a run and save it privately as the baseline. Load it with Baseline report for the next run. Reports include per-receipt field checks, missing/extra items, signed amount/quantity differences, raw text, parsed output/warnings, computed charges/total, duration, errors and all available progress events with elapsed times. Successful OCR also supplies rotation, crop, number of full recognition passes and full-resolution candidate texts. Internal orientation scores are not exposed by the current OCR API.

Baseline comparisons use receipt ID plus a SHA-256 fingerprint of the input bytes, expected answers and scan options. Changed inputs/references are marked not comparable, and parser/OCR modes cannot be compared. Save separate baselines per mode. Pass-to-fail is a regression; fail-to-pass is an improvement. New/removed receipts and new/resolved errors are reported. Unverified fields do not become accuracy passes. Duration is reported, not scored: first-use downloads, browser/CPU and cache state affect timings. Reports include browser user agent, timestamp and your revision label; record browser/cache conditions in the experiment label if needed.

If image OCR fails but the verified-transcript parser run passes, the evidence points toward the OCR path. If parsing the verified transcript fails too, investigate the parser/reference interpretation. A mismatch alone does not prove which component is responsible; compare the raw OCR against the original/verified transcript. The app's normal “no priced items” UI outcome can be diagnosed from empty parsed items even if OCR itself returned text.

## Checks and build isolation

Browser OCR reports retain every full-resolution candidate with its preprocessing variant,
layout mode, score and acceptance status. `selectedAttempt` is a zero-based index into
`ocr.attempts`. A null score means the candidate recovered no items (negative infinity
internally). Orientation probes are not included. The original-colour fallback runs only
when the selected lighting-adjusted reading remains uncertain; equal scores keep the
earlier reading. An original-colour candidate with a higher score can replace recovered
rows only if it passes the scanner's acceptance checks. If both adjusted candidates
recover no items, an uncertain original-colour candidate can rescue them; its review
flags remain. These candidate texts are private and must stay with local reports.
Accuracy checks and review status are separate: a receipt can pass every verified value
while still requiring review. Unknown reference fields never count as passes.

OCR mode uses the same `parseOcrResult` coordinator as the app. It preserves the selected
raw text, merchant and item descriptions. A missing printed total may be recovered from an
alternate attempt from that same scan: literal totals must agree, a single recognised
electronic payment in the source attempt must match, and its body must have the same
item count and a shared confident item. The parsed report's `recoveredTotal` records
the attempt index and supporting labels. Review flags remain, including total review;
Total recovery copies no item fields. Parser-only mode receives
only the verified transcript and does not perform this recovery. A higher reference
pass count does not imply that the receipt can be accepted automatically.

For a selected item with an unknown amount, the app may make two additional readings of
its image region (at most two items per scan). Regions are derived from uniquely matched
descriptor word boxes and observed row slope, using native image detail. The selected
merchant, description and quantity remain unchanged. An amount is filled only when two
different layout modes corroborate an explicit amount and quantity in the same row,
with confident numeric tokens and two unique name anchors; ambiguous/multiple products,
conflicting values and signed rows are rejected. The priced regional descriptor itself
must match the target; a target name elsewhere in the crop is insufficient. Selected-source
discount ambiguity blocks this recovery, even if closer readings lose a minus sign.
Every recovered amount remains flagged.
`ocr.itemReadings` records source attempt, original-photo crop, words/confidences and texts;
`parsed.recoveredItems` records the accepted field and observed quantity for review.
These diagnostics stay local with the report. Existing known amounts are never replaced.

Optional `OcrDiagnostics` arguments support development-only lighting, scale and small-angle
experiments plus prepared-image capture. They do not change normal luminance correction.
Reference answers are evaluated after recognition and are never passed to the recogniser.
The extra row recognitions are separate from `passes`, which counts full-image readings.

```powershell
npm.cmd run receipts:test
npm.cmd run receipts:check
npm.cmd test
npx.cmd tsc --noEmit
npm.cmd run build
```

Harness tests are separate from existing app tests. They validate reference parsing, synthetic parser results, unknown-field scoring, missing/extra/duplicate items, deltas and baseline comparison. These tests do **not** run browser OCR. The normal production entry never imports the harness; its config disables public assets, denies the local private directory, binds loopback and rejects production harness builds. Keep private folders outside the checkout (or only in the ignored root folder) to maintain this separation.
