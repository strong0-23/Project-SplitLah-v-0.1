# WO-001: Stop losing printed text before the parser sees it

Branch `wo/001-reading-coverage`, 13 Nov 2026. Rule D14 (docs/DECISIONS.md). Receipt IDs and counts
only; no receipt content.

## Summary

- Reading coverage, median over the 12 development receipts: **79.2% → 91.7%**. No receipt's
  coverage went down; two went up (REG106 0% → 67%, REG108 0% → 100%).
- Receipts within 2 corrections: **5/12 → 5/12** (target 6/12: missed).
- Silent errors: **4 → 7** (REG106 0 → 1, REG108 0 → 2). Corrections in all: 48 → 39.
- First-scan median: 6.18 s → 6.63 s (+0.45 s; limit +1.0 s).
- The review screen now says "The photo was only partly read" (3 of 12 development receipts).

The acceptance line is **not met**: two receipts get worse on silent errors (one also on
corrections), and within-2 stays at 5/12. See "Decision needed" in the PR.

## 1. Measurement

`tools/receipt-regression/coverage.ts` adds **reading coverage** to the harness's engine scoring:
the share of the reference's printed amounts (each known line amount, each charge, the GST amount
when no charge row holds it, the printed payable total) that appear anywhere in the OCR text the
parser read, counted as a multiset and only with the same digits (a misread digit does not count).
Summary lines carry it as a count (`coverage=5/6`), plus `coverage-median` per run and
`incomplete=yes|no` (whether the D14 review warning shows).

`tools/receipt-regression/dev-run.mjs` is the headless development runner: it runs the engine
scoring on the private development folder in headless Chrome (development mode, first scans only)
and prints the summary block, IDs and counts only. It writes nothing to disk, refuses
`NODE_ENV=production` and uses the harness dev server, whose config refuses production builds.
`--repeat N` scans the set N times in fresh browsers and adds median first-scan times. It was built
from the private Batch 3 runner.

**How the numbers below were taken.** Headless Chrome 153 on Linux, the same 12 development
receipts, `name-match=recognisable-0.70`, first use (each run in a fresh browser, so its first
receipt pays the engine load). `origin/main` at `8e38672` (with WO-002/D15 merged) was measured
with this branch's harness files copied in (unchanged app code), then this branch, back to back,
twice each with `--repeat 2` (4 runs each). Correctness was identical in every run of the same
code. The machine's CPU is shared, so timings are medians of the 4 runs' first-scan medians.

## 2. Where the text was lost

Every development receipt under 90% coverage on `origin/main`, with the stage found by writing each
stage's image (orientation probes, crop, flattened image) and both recognition passes to a private
folder outside the repository and comparing them.

| Receipt | Coverage on main | Stage that loses the text | Fixed here? |
|---|---|---|---|
| REG002 | 5/6 | Recognition pass: the engine's page layout drops one printed row (in both layouts) | No (engine, out of scope) |
| REG101 | 2/3 | Recognition pass: the column layout treats the rows around a double rule as non-text; the block pass reads them but scores lower, so it is not chosen | No; now gets the partly-read warning |
| REG106 | 0/3 | Orientation choice: an upside-down probe scored 15 confident words, passed the early-stop line (12) and ended the search; the upright rotation scores 123 | Yes → 2/3 (the rest: digit misreads in recognition) |
| REG107 | 2/3 | Second-pass choice: the block reading, which lost one amount, replaced a column reading that had all of them | No (see 3.3) |
| REG108 | 0/5 | `autoCrop` / `detectPaperBounds`: a shadow band across the lower part of the photo fell below the global threshold, so the crop ended after the first item row | Yes → 5/5 |
| REG110 | 2/3 | Recognition pass: one amount read without its decimal point | No (flattening variants did not help) |
| REG112 | 3/4 | Second-pass choice, as REG107 | No (see 3.3) |

Flattening (`flattenIllumination`) lost no text on the development set: with the crop fixed, the
shadowed part of REG108 is read in full.

## 3. Fixes (D14)

### 3.1 A crop never cuts the paper (`image.ts`)

`detectPaperBounds` keeps its global-threshold search, then widens the row run while the strip
beyond each end is still paper: its middle part at least 1.5× as bright as the background beside
the crop in the same rows, and 24 grey levels brighter. A shadow darkens paper and background
alike, so the comparison holds across a shadow edge. Short gaps are tolerated. Where there is no
background beside the paper to compare with, the crop is dropped on that side. Effect on the 12
development photos (both candidate rotations each): REG108 (both rotations) and REG002 (both
rotations; the bottom of the paper) are widened; every other crop is unchanged.

Tests (`image.test.ts`): an even-lit photo's crop is unchanged; a shadow band no longer cuts the
paper; a row run that would cut the paper is widened to the paper's end and not into background;
no measurable background → the crop is dropped on that side; a crop covering almost the whole
photo is dropped; an even-lit page stays even after flattening; shadowed paper is levelled with
ink kept dark.

### 3.2 An upside-down probe does not end the orientation search (`scan.ts`)

A probe ends the search early only when it has at least 12 confident wide words **and** they are at
least 35% of the longer words it read. Measured on all 12 photos: upright probes have 59–95%;
upside-down probes 7–13%. Upright photos still stop after one probe; REG106 now probes the second
landscape rotation and picks it. Tests: upright, upside-down and too-few probes, and a workflow
test that keeps probing past an upside-down first probe.

### 3.3 Second-pass choice: measured, not changed

Keeping the first reading when the second read fewer amounts restored the lost amount on REG107
and REG112 (coverage 3/3 and 4/4), but each then needed one more correction (the fuller reading
carried an extra row), so REG107 left the within-2 group. It was removed. Merging the lines the two
passes disagree on was not tried: placing borrowed lines correctly for the parser is not simple.

### 3.4 Review warning: "The photo was only partly read" (`image.ts`, `canvas.ts`, `scan.ts`, `index.ts`, `review.ts`, `ReviewStep.tsx`)

After recognition, the rows that hold print on the prepared image (ink-dark pixels in the middle
80% of a row) are compared with the rows covered by the chosen reading's words. When 35% or more of
the printed rows have no word, `scanReceipt` puts a note first in the receipt's existing
`ocrWarnings`. The review screen shows the warning for that note, or when no total was read from
the stored `rawOcrText` and none has been typed in. Nothing new is stored (D13).

On the development set the unread share of the chosen readings was 0–20%, except REG101 (41%, the
rows around the double rule, plus a QR code); logos, QR codes and barcodes print without words, so
the line is set well above them. The warning shows on REG003 and REG108 (no total read) and REG101
(partly read). Tests: the unread share, `readingLooksPartial`, `scanReceipt` adding the note, and
the review banner (shown for the note and for no total; gone once a total is typed; not shown on a
complete reading; the note is not repeated in the scanned-details list).

## 4. Before / after (development set, 12 receipts)

| Measure | origin/main `8e38672` | This branch |
|---|---|---|
| Reading coverage, median | 79.2% | 91.7% |
| Coverage change per receipt, smallest | n/a | 0 points (none went down) |
| Receipts within 2 corrections | 5/12 | 5/12 |
| Silent errors | 4 | 7 |
| Corrections, all receipts | 48 | 39 |
| Missing rows / extra rows | 9 / 18 | 5 / 11 |
| Wrong quantity / amount / charges / printed total | 3 / 4 / 9 / 5 | 4 / 7 / 7 / 5 |
| First-scan median (median of 4 runs) | 6.18 s (runs 5.70–6.96) | 6.63 s (runs 6.40–6.84) |
| "Partly read" warning shown | n/a | 3/12 |

Per receipt (corrections / silent errors / coverage), main → branch. Only REG106 and REG108 change:

| Receipt | Corrections | Silent | Coverage |
|---|---|---|---|
| REG106 | 15 → 5 | 0 → 1 | 0/3 → 2/3 |
| REG108 | 7 → 8 | 0 → 2 | 0/5 → 5/5 |
| The other 10 | unchanged | unchanged | unchanged |

**Why REG106 and REG108 get worse on silent errors.** Both were read almost not at all on main, so
they had nothing to be silently wrong about. Now their text reaches the parser, and misreads in it
become unflagged values: on REG108 a damaged total label means no total is read and the payment
rows below it become unflagged items; on REG106 the printed total is read with misread digits and
is not marked uncertain. Both are parser-side (label repair, rows after an item-count or payment
line, marking a misread total), which this work order excludes. REG108 now shows the
"partly read" warning, but the harness counts only row flags and field marks as review signals.

First-scan time rises mostly on the two receipts that are now read: REG106 probes one more rotation
and REG108 reads the whole paper instead of a third of it.

## 5. Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npm run receipts:check` | pass |
| `npm run test` | pass, 19 files, 400 tests |
| `npm run receipts:test` | pass, 7 files, 83 tests |
| `npm run build` | pass |
| `npx wrangler@4.154.0 deploy --dry-run --config cloudflare/wrangler.jsonc` | pass |
| `tools/receipt-regression/smoke/review-smoke.mjs` (headless Chrome, `SMOKE_PORT=8897`) | SMOKE PASS |
| `tools/receipt-regression/smoke/engine-smoke.mjs` (extra; harness changed) | SMOKE PASS |
| `npm run lint` | 0 errors, 9 warnings (all in files this branch does not touch, as on main) |
| Private-data search of the diff | done before every push |

Not run: Firefox or any phone (only headless Chrome on Linux); no held-out receipts exist on this
machine and none were read.

## 6. Limits

- Development set only (12 receipts, all seen before). At n = 12 one receipt is about 8 points.
- Rows the engine's page layout drops (REG002, REG101) and digit misreads (REG106, REG110) are
  recognition problems this work order does not touch (no engine or Tesseract parameter changes).
- The crop check needs some background beside the paper; when there is none, it drops the crop on
  that side rather than guess.
- The partly-read threshold (35%) was set from 12 receipts; a receipt that is mostly logo, QR code
  or barcode could trigger it.
