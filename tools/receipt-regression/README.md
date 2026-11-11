# Local receipt regression harness

A separate, localhost-only Vite page (`npm run receipts:dev`, http://127.0.0.1:8081/) with no new
dependencies. Files are read into the browser's memory only: nothing is uploaded, stored or logged.
It has three sources:

1. **Engine comparison (Phase 2c, default)**: each photo is scanned by Tesseract and/or PaddleOCR
   through the app's own scan pipeline and scored against your verified references by **extra
   correction actions**. The decision rule (a)–(d) and the 70% stop rule are applied.
2. **Parser gate (Batch 1b)**: one OCR reading per photo, read by both parser-v2 (baseline) and the
   rework parser, with the Batch 1b merge gate.
3. **dataset.json folder (legacy)**: the parser-v2 harness format.

## Engine comparison (Phase 2c)

### What it does

- Every receipt is scanned with **Tesseract, then every receipt with Paddle** (engine "Both"), or
  with one engine. Both engines run through `scanReceipt` in `src/lib/scan`, exactly as in the app,
  with the engine injected through the existing `OcrEngine` contract; Paddle is the app's own
  dev-only engine (`engineFactoryFor("?engine=paddle")`).
- Engine files come from the harness's own address: the dev server serves only the pinned files in
  `src/lib/scan/tesseract-assets.ts` (from `public/tesseract/`) and `paddle-assets.ts` (from
  `paddle-models/`); ONNX Runtime's WASM and the Paddle worker come from `node_modules` and
  `src/lib/scan` like any other module. No CDN.
- Each receipt is scanned once (**first scan**), then re-scanned **3 times** in the same page
  session (**warm**: the engine is already loaded); the warm time is the median of the 3. Like the
  app, `scanReceipt` keeps the loaded engine between scans (`src/lib/scan/engine-pool.ts`), so the
  very first scan of each engine in the page is the session's **cold** scan (it includes loading
  the engine; for a first download, use a fresh private window) and later scans are recognition
  only. Switching engine disposes the other one.
- Scoring uses the receipt the app itself would show, with **no saved preferences** (first use is
  the primary condition; `scanReceipt` never reads saved preferences).
- Per receipt and engine it records matched, missing and extra products, quantity and amount
  correctness, charge fields, the printed total, silent errors, the extra-correction count, and the
  first and warm scan times. It also notes whether the warm scans read the same text as the first.

### Extra correction actions (owner-confirmed, 11 Nov 2026)

For one receipt, against your verified reference, counting **only fields with state "known"**: the
number of Review-screen field actions needed to reach a correct bill.

| Action | Counts |
|---|---|
| A reference product is missing (add it) | +1 each |
| An extra product row (delete it); only when the reference says every product row is listed | +1 each |
| A matched product has the wrong quantity | +1 each |
| A matched product has the wrong line amount | +1 each |
| A wrong charge field: discount, service amount, GST amount, GST inclusive/exclusive (when known) | +1 each |
| The printed total field is wrong | +1 |
| The calculated total | never (it is derived) |

Products are matched one-to-one by **recognisable name** (owner decision, 11 Nov 2026, made before
any held-out run; `names.ts`):

1. Exact names are paired first, with the harness's original rule (case and spaces ignored, or the
   name followed by a bracketed note the app added).
2. The rest are paired greedily by descending similarity, ties broken by printed order (reference,
   then app), and only at a similarity of **0.70 or more**. One app row never pairs with two
   reference products.
   - Both names are normalised: case-folded, NFKC, punctuation stripped except `&`, whitespace
     collapsed, and one leading quantity token (`1 `, `2x `) dropped.
   - Similarity = 1 − Levenshtein distance / the longer name's length.
   - A leading item code (`M5`, `A12`: one or two letters then digits) is ignored when only one of
     the two names has one, and kept when both do.
   - A bracketed note the app added after a name is ignored.
3. A recognisable but misspelled name adds **0** corrections. An unrecognisable name (below 0.70)
   is still a missing product (+1) and an extra row (+1).
4. Quantity, amount, charge and silent-error checks then run on the paired products as before.

A missing product is one action: its quantity and amount are typed in with it. The run line says
which rule was used (`name-match=recognisable-0.70`); see "Summary format". A receipt "within 2" needs 2 or fewer actions; a
failed or timed-out scan is never within 2 and stays in the denominator.

This simplifies the owner's earlier proof-bound evaluator (approved-comparison-r1) while keeping all
of its thresholds. Code: `corrections.ts`; tests: `corrections.test.ts`.

A **silent error** is a wrong financial field the app shows no warning or flag for (unchanged from
Batch 1b; see "What the scores mean" below).

### Decision rule (owner-approved, unchanged)

Paddle replaces Tesseract only if **all** hold:

- **(a)** zero silent financial errors (Paddle);
- **(b)** on the held-out set, Paddle's share of receipts within 2 corrections is at least
  **10 percentage points** higher than Tesseract's;
- **(c)** Paddle's median **warm** scan time on **each tested phone** is **8 s or less**;
- **(d)** Paddle's correctness on each tested phone is at least Tesseract's.

If **neither** engine reaches **70%** of receipts within 2 corrections, engine work stops.

How the tool applies it (`comparison.ts`, tested in `comparison.test.ts`):

- (a), (b) and the stop rule use **complete held-out runs in Both mode**. The desktop verdict needs
  **both Edge and Firefox**; each rule must hold in each. A missing browser is **pending**, never a
  pass. Chrome or other browsers are shown as informational only. Two runs of the same browser, or
  Edge and Firefox runs over different receipts, leave the rules pending.
- An engine "reaches 70%" only if it does so in both Edge and Firefox.
- (b) is computed exactly in whole receipts: at n = 12, one receipt is about 8.3 points, so Paddle
  needs at least **2 more** receipts within 2 corrections than Tesseract.
- (c) and (d) use the phone timing page's result lines (below). (c): Paddle's warm times on that
  phone, pooled, median ≤ 8 s; a failed warm scan counts as the slowest. (d): on that phone, over the
  same receipts scanned with both engines and a verified reference, Paddle's count within 2 is at
  least Tesseract's.
- Anything without data is **pending**. The tool never changes the default engine; you decide.

### Held-out mode

On by default. With it on:

- the page shows and keeps **receipt IDs, counts and timings only**: no photo, OCR text, field
  values, product names or check names, not even in error messages;
- "Download full report" is off, and comparison with an earlier report is hidden;
- nothing is written to disk or browser storage, and the harness writes nothing to the console. The
  dev server does **not** copy the browser console into the terminal (Vite 8 does that by default
  when an AI agent runs it; turned off in `vite.config.ts`). The engines' own runtime warnings
  (ONNX Runtime model-loading notes) can still appear in the browser's DevTools console; they
  contain no receipt content;
- an engine run made with it on is labelled `set=held-out`. With it off, a run is a
  `set=development` preflight and gives **no** verdict.

Choose the held-out folders **in the browser's file picker only**. Never type their paths into a
chat, a terminal Claude can see, or this repository. See `docs/OWNER-DATASET-GUIDE.md` for where to
keep them.

### Owner run: Edge, then Firefox (Windows PowerShell)

From the repository root:

```powershell
git fetch origin
git switch engine-comparison
git pull
npm.cmd install
npm.cmd run receipts:test
npm.cmd run receipts:dev
```

1. **Edge**: open http://127.0.0.1:8081/. Source "Engine comparison" and Held-out mode are already
   selected.
2. **Photos**: choose your held-out photos folder (or select the photo files themselves with the
   second picker). **References**: choose the held-out references folder (or the files).
   The status line lists the paired REG ids.
3. Engines **Both**, warm re-scans **3**. Revision: the output of `git rev-parse --short HEAD`.
4. **Run sequential suite** and leave the tab in front until it finishes (about 1 minute per
   receipt on a typical desktop; Paddle takes most of it).
5. **Copy summary** and keep it. Its `run | …` line must show `name-match=recognisable-0.70`; if
   it doesn't, the checkout predates the owner's name rule: stop and update it.
6. **Firefox**: open the same address in Firefox and repeat steps 2–4.
7. In Firefox, paste the Edge summary into "Combine with other browsers and phones", add any phone
   result lines, and select **Combine**. Copy the combined summary and send only that block.

Preflight first (brief, Phase 2c step 2): the same steps on the **development** receipts with
Held-out mode **off** (details visible), in Edge and Firefox.

### Phone timing page

On a preview build with the engine switch on (docs/DEPLOY.md, "Paddle on in Cloudflare preview
builds"), open `https://<preview-url>/dev/engine-timing` on the phone. The page does not exist on
`main` or any production build. Per engine and receipt photo it runs 1 first scan and 3 warm
re-scans and shows the median warm time, the device's user agent and a result line to copy. With
the receipt's verified reference chosen too, it also counts the extra corrections (rule d). It
shows no receipt content. Steps are in `docs/reports/2026-11-engine-comparison.md`, "Owner run".

### Summary format

Lines like `run | …`, `receipt | …` and `phone | …` are machine-readable and the only lines read
back when pasted; everything else (aggregates, verdict) is recomputed. Run and phone lines carry
`name-match=` (the item-name rule used for scoring). **Summaries that used different rules are not
combined:** Combine refuses them (a run made in this page is kept, the pasted ones are left out),
and a line without the field, written before the rule existed, counts as `exact`. Re-run every
browser and phone with the same harness revision. Timing-only phone lines (no reference) are not
scored, so their rule does not matter. Receipt IDs must look like
`REG001` (letters then digits); a line with anything else in an ID is ignored and reported by line
number. Per-receipt field detail (`detail | …`) appears only in development runs.

### Smoke tests (synthetic receipts only)

```bash
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs CHROME_PATH=/path/to/chrome \
  node tools/receipt-regression/smoke/engine-smoke.mjs
# with a switch-on build served by `wrangler dev` on :8787:
node tools/receipt-regression/smoke/phone-page-smoke.mjs http://127.0.0.1:8787
```

They render two invented receipts as text onto a canvas, build their references from
`reference-format/reference-template.json` (checked with the contract), and run the harness in Both
mode (held-out and development) and the parser gate, or the phone page with each engine. Playwright
is not a project dependency.

### Firefox

The page uses no Chrome-only API: folder pickers (`webkitdirectory`, which Firefox also supports)
have a plain multi-file picker next to them; copying falls back to selecting the text when the
Clipboard API is refused; hashing uses Web Crypto (available on 127.0.0.1). Paddle's worker needs
module workers and `OffscreenCanvas` in workers (Firefox 114+ and 105+).

## Parser gate (Batch 1b): owner's scored run (Windows PowerShell, Browser OCR mode)

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

1. Open **http://127.0.0.1:8081/** and choose **Source** "Parser gate (Batch 1b)". Turn Held-out
   mode off if you want to see per-check detail.
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
  brackets, e.g. "DRY MEE POK (MEMBER DISC -1.00)". This is the `exact` name rule; the parser gate
  always uses it, unchanged (the engine comparison's recognisable-name rule does not apply here).

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

Prefer a folder outside the checkout. Development data may also live in the Git-ignored
`receipt-regression.local/` at the repository root, but **held-out receipts and references never
go inside the project folder at all**: it is connected to Claude (see
`docs/OWNER-DATASET-GUIDE.md`). **Never put private data in `public/`, `src/`, `tools/` or the
committed examples.** Files are read into browser memory only; reports are saved only when you
click Download.

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
