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

- **First scan:** the first scan of an image in a run. The first scan of each engine in a page
  session is the **cold** scan (files downloaded and compiled; a fresh private window for a true
  first download).
- **Warm scan:** a re-scan of the same image in the same page session after the engine has loaded
  once. 3 warm scans; their **median** is used. The app's pipeline starts and ends the engine on
  every scan, so a warm scan includes restarting the engine from files already in the browser:
  what a user waits for on a second scan.
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

Products are matched with the harness's existing matching, unchanged. This simplifies the owner's
earlier proof-bound evaluator (approved-comparison-r1) while keeping all of its thresholds.

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
5. Select **Copy summary**.
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
| `npx vitest run` (app, 15 files) | 300 passed |
| `npm run receipts:test` (harness, 5 files) | 68 passed: corrections, gates (pending and missing-runtime handling, 10-point and 70% edges at n = 12), summary parsing and sanitising, held-out console and summary checks, runner |
| `npx eslint src/lib/scan tools/receipt-regression` | clean |
| `npx vite build` (production) | pass; `/dev/engine-timing` → 404 under `wrangler dev`; no page code and no Paddle files in the output |
| Wrangler dry-run (docs/DEPLOY.md) | pass |
| Harness smoke, headless Chrome 153 (`smoke/engine-smoke.mjs`) | pass: Both mode on 2 computer-rendered synthetic receipts, held-out (3 warm scans) and development runs, plus the Batch 1b parser gate; only the harness origin was reachable; no product name or amount in the summary, held-out page or console |
| Phone page smoke, switch-on build under `wrangler dev` with the deploy CSP, emulated Pixel 7 (`smoke/phone-page-smoke.mjs`) | pass for both engines; no receipt content on the page or console |

Observations on the synthetic receipts (desktop, not evidence for the decision):

- Tesseract's warm median was about 2.4 s.
- Paddle's warm median was about 8.0 s on this desktop; phones are usually slower, so rule (c) is a
  real risk.
- Paddle misread one synthetic product name, giving 1 missing product and 1 extra row (2 actions,
  2 silent errors). This shows the scoring working; it is not a result.

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
- **Warm time** includes restarting the engine (the app's behaviour), not a scan with the engine
  kept loaded.
- The engines' own runtime warnings (ONNX Runtime) still appear in the browser's DevTools console;
  they contain no receipt content.

## 9. For the owner

1. Confirm, or change, how the tool applies rules (c), (d) and the stop rule (section 4): pooled
   warm times per phone, receipts within 2 per phone over the same receipts, and 70% required in
   both Edge and Firefox.
2. Decide which phones and how many receipts per phone (suggestion: at least 4 held-out receipts per
   phone, all 12 if time allows).
3. Authorise the held-out run once the development references are verified (brief gate).
