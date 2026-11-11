# Phase 2c: Tesseract vs PaddleOCR comparison

**Branch:** `engine-comparison` (from `main` at 50f8866). **Date:** 11 Nov 2026.
**Status:** tooling ready; **no real-receipt run yet**. Results tables below are empty until the
owner's run. The held-out run is owner-run and starts only after the owner confirms the
development references are verified and explicitly authorises it (brief, Phase 2c step 1).
Tesseract stays the default engine; this report does not change it.

## 1. Summary

- The local harness (`tools/receipt-regression`) now runs both engines through the app's own scan
  pipeline on the owner's photos, scores each receipt by **extra correction actions** against the
  owner's verified references, times first and warm scans, and applies the decision rule.
- A **held-out mode** keeps everything to receipt IDs, counts and timings.
- A dev-only **phone timing page** (`/dev/engine-timing`) exists only in builds with the engine
  switch on (preview builds), never on `main`.
- Edge and Firefox summaries, and phone result lines, combine into one verdict.
- Sample: about 12 held-out receipts (owner decision, 11 Nov 2026). At n = 12 one receipt is about
  8 percentage points, so every share is shown as a count (x/12) as well as a percentage.

## 2. Method

### Engines and pipeline

| | Tesseract (default) | PaddleOCR (dev-only challenger) |
|---|---|---|
| Package | tesseract.js 5.1.1, `eng` 4.0.0_best_int | @paddleocr/paddleocr-js 0.4.2, onnxruntime-web 1.22.0 (WASM-only) |
| Models | self-hosted, `public/tesseract/` | PP-OCRv5 mobile det/rec, self-hosted, `paddle-models/` |
| Runs in | tesseract.js worker | the app's module worker (`paddle.worker.ts`) |
| Settings | app defaults (unchanged) | fixed "Paddle960" settings (unchanged) |

Both engines run through the same `scanReceipt` path as the app: decode, orientation probes,
crop and flatten, recognise, optional second pass, then the same rework parser (`src/lib/scan`). No
engine settings, parser rules or thresholds were tuned for this comparison.

### Conditions

- **First use (primary):** no saved preferences. The harness and the phone page call `scanReceipt`
  directly, which never reads saved preferences.
- **Desktop:** Edge and Firefox (both required), on the owner's PC, in held-out mode.
- **Phones:** each phone the owner tests, through a Cloudflare preview URL with the switch on.

### Timing

- **Engine lifecycle (fixed 11 Nov 2026, before any comparison run):** the app now keeps a loaded
  engine between scans in a page session, for both engines alike (`src/lib/scan/engine-pool.ts`).
  It is disposed after 3 minutes idle, on page hide/unload, when the engine choice changes, and on
  any error. Cancel still stops a running recognition at once and marks the engine for reload.
  Orientation probes and the 60 s / 120 s load limits are unchanged.
- **First scan:** the first scan of an image in a run. The first scan of each engine in a page
  session is the **cold** scan: it loads the engine (files downloaded and compiled; a fresh private
  window for a true first download). Later first scans run on the loaded engine.
- **Warm scan:** a second scan of the same image with the engine already loaded. 3 warm scans;
  their **median** is used.
- A failed or timed-out warm scan counts as the slowest value in a median.

## 3. Definitions

### Extra correction actions (owner-confirmed, 11 Nov 2026)

For one receipt, against the owner's verified reference, counting only fields whose state is
"known", the number of Review-screen field actions a user must make to reach a correct bill:

| Action | Counts |
|---|---|
| Missing reference product (add) | +1 each |
| Extra product row (delete); only when the reference lists every product row | +1 each |
| Wrong quantity on a matched product | +1 each |
| Wrong line amount on a matched product | +1 each |
| Wrong charge field: discount, service amount, GST amount, GST inclusive/exclusive (if known) | +1 each |
| Wrong printed total field | +1 |
| Calculated total | never: it is derived |

Products are matched one-to-one by **recognisable name** (owner decision, 11 Nov 2026, made before
any held-out run; docs/DECISIONS.md):

- Exact names are paired first (the harness's original rule). Then the remaining products are paired
  greedily by descending similarity, ties broken by printed order, at a similarity of **0.70 or
  more**. One app row never pairs with two reference products.
- Similarity is 1 − Levenshtein distance / the longer length, on normalised names (case-folded,
  NFKC, punctuation stripped except `&`, whitespace collapsed, one leading quantity token such as
  `1 ` or `2x` dropped). A leading item code (`M5`, `A12`) is ignored when only one name has it.
- A misspelled but recognisable name adds **0** corrections; quantity and amount are still checked
  on the paired product. An unrecognisable name is still missing (+1) plus an extra row (+1).
- Summaries show the rule on the run line (`name-match=recognisable-0.70`); summaries using
  different rules are refused when combined. The Batch 1b parser gate keeps the exact rule.

This simplifies the owner's earlier proof-bound evaluator (approved-comparison-r1) while keeping all
of its thresholds.

- **Within 2:** a receipt needing 2 or fewer actions.
- **Silent financial error:** a wrong financial field with no warning or flag shown (the Batch 1b
  definition: an unflagged wrong quantity, amount or extra row; a missing product while the app says
  the total matches; a wrong printed total not marked uncertain; a wrong calculated total while the
  app says it matches; a wrong discount, service or GST not marked uncertain).
- **Denominators:** every receipt in the set. Failed and timed-out scans stay in them and are never
  within 2.

## 4. Decision rule (owner-approved, unchanged)

Paddle replaces Tesseract only if **all** of these hold:

| Rule | Test | Applied as |
|---|---|---|
| (a) | Zero silent financial errors | Paddle, in both the Edge and the Firefox held-out runs |
| (b) | Share within 2 at least 10 points above Tesseract's (held-out) | In both Edge and Firefox; at n = 12, at least 2 more receipts |
| (c) | Median warm phone scan ≤ 8 s | Paddle, on each tested phone (warm times pooled per phone) |
| (d) | Paddle's correctness ≥ Tesseract's on each phone | Per phone, receipts within 2, same receipts for both engines, with references |
| Stop | If neither engine reaches 70% within 2, engine work stops | An engine reaches 70% only if it does in both Edge and Firefox (at n = 12: 9 receipts) |

A missing required runtime (Edge, Firefox, or any tested phone's data) is **pending**, never a pass.

## 5. Owner run

### 5.1 Preflight (development receipts only)

Brief Phase 2c step 2: Edge plus one non-Chromium browser (Firefox), capped at two hours and two
fixes, at most three candidate configurations per engine after the baseline.

1. Run the harness as in 5.2, with the **development** folders and Held-out mode **off**, in Edge
   and in Firefox.
2. Check that both engines finish every receipt. Check the per-field detail on screen; nothing to
   send.

### 5.2 Held-out run: Edge and Firefox (Windows PowerShell)

```powershell
git fetch origin
git switch engine-comparison
git pull
npm.cmd install
npm.cmd run receipts:test
npm.cmd run receipts:dev
```

1. In **Edge**, open http://127.0.0.1:8081/. "Engine comparison" and Held-out mode are already
   selected.
2. Choose the held-out **photos** folder and **references** folder in the pickers. If a folder
   picker doesn't work, use the "select the files themselves" picker under it.
3. Engines **Both**, warm re-scans **3**, revision = `git rev-parse --short HEAD`.
4. Select **Run sequential suite**. Keep the tab in front until it finishes.
5. Select **Copy summary**. Its `run | …` line must show `name-match=recognisable-0.70`; if it
   doesn't, the checkout predates the name rule (section 3): stop and update it.
6. In **Firefox**, open the same address and repeat steps 2–4.
7. In Firefox, paste the Edge summary into "Combine with other browsers and phones" and select
   **Combine**.

### 5.3 Phones

1. Turn on Paddle for preview builds: docs/DEPLOY.md, "Paddle on in Cloudflare preview builds"
   (one build variable). Push or retry the PR's build.
2. Copy the receipt photos you will time (and their references, for rule d) to the phone. Delete
   them from the phone afterwards.
3. On the phone, open `https://<preview-url>/dev/engine-timing` in a **private tab** (a fresh
   session: the first scan is cold).
4. Choose the engine, type the phone's label (the same for every run on that phone), choose the
   photo and its reference, and select **Run 1 + 3 scans**. Keep the screen on.
5. Select **Copy result** and keep the line.
6. For the next photo, the same engine can continue in the same tab. **To switch engine, close the
   private tab and open a new one.**
7. Do this for both engines and the **same receipts** on each phone.
8. Paste all phone lines into the Combine box together with the desktop summaries, select
   **Combine**, and send only the combined block.

## 6. Results (to be filled from the owner's summary)

### 6.1 Desktop, held-out set (n = ___)

| Browser (version) | Engine | Within 2 (x/n, %) | Silent errors | Failed / timed out | Session-cold | Median warm |
|---|---|---|---|---|---|---|
| Edge | Tesseract | | | | | |
| Edge | Paddle | | | | | |
| Firefox | Tesseract | | | | | |
| Firefox | Paddle | | | | | |

### 6.2 Correction actions by field (held-out, totals)

| Browser | Engine | Missing | Extra | Quantity | Amount | Charges | Printed total |
|---|---|---|---|---|---|---|---|
| Edge | Tesseract | | | | | | |
| Edge | Paddle | | | | | | |
| Firefox | Tesseract | | | | | | |
| Firefox | Paddle | | | | | | |

### 6.3 By photo condition (held-out, within 2, x/n)

| Condition tag | Edge Tesseract | Edge Paddle | Firefox Tesseract | Firefox Paddle |
|---|---|---|---|---|
| | | | | |

### 6.4 Phones

| Phone (label, browser) | Engine | Receipts | Cold first scan | Median warm (pooled) | Within 2 (x/n) | Silent errors |
|---|---|---|---|---|---|---|
| | Tesseract | | | | | |
| | Paddle | | | | | |

### 6.5 Decision-rule outcome

| Rule | Outcome | Detail |
|---|---|---|
| (a) zero silent financial errors | pending | |
| (b) +10 points within 2 (held-out) | pending | |
| (c) median warm phone scan ≤ 8 s | pending | |
| (d) Paddle correctness ≥ Tesseract per phone | pending | |
| 70% stop rule | pending | |
| **Decision** | **pending** | |

### 6.6 Recommendation

Pending the owner's results. Per the brief, a device-based fallback (Paddle on capable phones,
Tesseract otherwise) is proposed only if Paddle passes on accuracy but fails on speed on some
phones.

## 7. Tooling verification (synthetic data only, 11 Nov 2026)

| Check | Result |
|---|---|
| `npx tsc --noEmit`, `npm run receipts:check` | pass |
| `npx vitest run` (app, 16 files) | 311 passed, including engine reuse: reuse, idle disposal, cancel-then-rescan, engine change, errors, load limit, page hide, concurrent scans, and Paddle's adapter reused across scans |
| `npm run receipts:test` (harness, 5 files) | 68 passed: corrections, gates (pending and missing-runtime handling, 10-point and 70% edges at n = 12), summary parsing and sanitising, held-out console and summary checks, runner |
| `npx eslint src/lib/scan tools/receipt-regression` | clean |
| `npx vite build` (production) | pass; `/dev/engine-timing` → 404 under `wrangler dev`; no page code and no Paddle files in the output |
| Wrangler dry-run (docs/DEPLOY.md) | pass |
| Harness smoke, headless Chrome 153 (`smoke/engine-smoke.mjs`) | pass: Both mode on 2 computer-rendered synthetic receipts, held-out (3 warm scans) and development runs, plus the Batch 1b parser gate; only the harness origin was reachable; no product name or amount in the summary, held-out page or console |
| Phone page smoke, switch-on build under `wrangler dev` with the deploy CSP, emulated Pixel 7 (`smoke/phone-page-smoke.mjs`) | pass for both engines; no receipt content on the page or console |

Timings on the synthetic receipts (desktop Linux, headless Chrome 153; not evidence for the
decision), before and after the engine-reuse fix:

| Measurement | Tesseract before | Tesseract after | Paddle before | Paddle after |
|---|---:|---:|---:|---:|
| Harness, session-cold first scan | 2.7–2.8 s | 2.7 s | 9.2–9.4 s | 9.4 s |
| Harness, warm median (2 receipts × 3) | 2.4–2.5 s | 2.0 s | 8.0–8.3 s | 6.0 s |
| Phone page (`wrangler dev`, deploy CSP, emulated Pixel 7), cold | 2.8 s | 2.7 s | 9.0 s | 8.7 s |
| Phone page, median of 3 warm | 2.5 s | 2.1 s | 8.2 s | 6.5 s |

- Most of Paddle's remaining warm time is the orientation probes plus recognition (unchanged by
  design). Phones are usually slower than this desktop, so rule (c) is still a real risk.
- Paddle misread one synthetic product name, giving 1 missing product and 1 extra row (2 actions,
  2 silent errors). This shows the scoring working; it is not a result. It was scored with the
  earlier exact name rule. Re-run with the recognisable-name rule (below), the same misread name is
  matched, and the check moves to that product's quantity, which Paddle also misread: 1 action,
  1 silent error.

**Recognisable-name rule (11 Nov 2026, synthetic data only).**

| Check | Result |
|---|---|
| `npm run receipts:test` (harness, 6 files) | 89 passed. New `names.test.ts`: normalisation, typo tolerance with an `M5` item-code prefix, names below 0.70 staying missing + extra, one-to-one pairing and printed-order ties, exact pairs first, and the Batch 1b gate staying exact. `comparison.test.ts`: the `name-match=recognisable-0.70` run-line label, legacy lines read as `exact`, refusal to combine mixed rules (desktop and scored phone lines) |
| `npx tsc --noEmit`, `npm run receipts:check`, `npx vitest run` (311 passed), `npx eslint src/lib/scan tools/receipt-regression`, `npx vite build` | pass |
| Harness smoke, headless Chrome 153 (`smoke/engine-smoke.mjs`) | pass; run line shows `name-match=recognisable-0.70`; the parser gate still gives `OVERALL: PASS` |
| Phone page smoke (`smoke/phone-page-smoke.mjs`) | not re-run for this change (needs a switch-on build under `wrangler dev`) |

## 8. Not verified, and limitations

- **No real receipts** were used; accuracy on real photos is unmeasured until the owner's run.
- **Firefox was not tested here.** It couldn't be installed in this environment (Playwright's
  Firefox download, Mozilla's package host and the Debian mirror are all blocked). The harness uses
  no Chrome-only API and has fallbacks, but the owner's Firefox preflight is the first real check.
- **Edge and Safari** were not tested; no **real phone** was tested (phone emulation in desktop
  Chrome only).
- **No real Cloudflare preview build** was tested; it was checked with `wrangler dev` locally.
- **Sample size:** 12 held-out receipts give low statistical confidence; one receipt is about 8
  points.
- The engines' own runtime warnings (ONNX Runtime) still appear in the browser's DevTools console;
  they contain no receipt content.

## 9. For the owner

1. **Settled (11 Nov 2026):** the rule application in section 4 is accepted; at least 4 receipts
   per phone; engine reuse fixed before any run (section 2).
2. Name the phones to test.
3. Authorise the held-out run once the development references are verified (brief gate).
