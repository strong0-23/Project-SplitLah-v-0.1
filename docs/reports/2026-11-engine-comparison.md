# Phase 2c: Tesseract vs PaddleOCR comparison

**Branch:** `engine-comparison` (from `main` at 50f8866), merged; results filled in on
`cleanup/remove-paddle`. **Dates:** 11 Nov 2026.
**Status:** **finished.** The held-out run was done by the owner on revision `6dbcd90`. Result:
**Paddle does not replace Tesseract**, and the 70% stop rule triggered, so engine work stops.
The owner decided to remove Paddle from the app (done on `cleanup/remove-paddle`). Results are in
section 6; sections 2–5 describe the method as it was run. The Paddle-specific tooling described
there (engine "Both" mode, the phone timing page, the preview-build engine switch) no longer
exists.

## 1. Summary

- The local harness (`tools/receipt-regression`) ran both engines through the app's own scan
  pipeline on the owner's photos, scores each receipt by **extra correction actions** against the
  owner's verified references, timed first and warm scans, and applied the decision rule. Since
  Paddle's removal it scores Tesseract only, with no decision rule.
- A **held-out mode** keeps everything to receipt IDs, counts and timings.
- A dev-only **phone timing page** (`/dev/engine-timing`) existed in builds with the engine switch
  on (preview builds); it was never used (6.4) and was removed with Paddle.
- Edge and Firefox summaries, and phone result lines, combined into one verdict.
- Sample: planned at about 12 held-out receipts (owner decision, 11 Nov 2026); the run used **7**.
  At n = 7 one receipt is about 14.3 percentage points, so every share is shown as a count (x/7)
  as well as a percentage.
- **Result (section 6):** both engines 0/7 within 2 corrections in Edge and Firefox; Paddle 7
  silent errors per browser (Tesseract 3). Paddle does not replace Tesseract; engine work stops;
  Paddle was removed.

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
git switch main
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

## 6. Results (owner's held-out run, 11 Nov 2026)

**Setup of the run.** Revision `6dbcd90` (`main`). Edge 157 and Firefox 152 on the owner's PC.
**7 held-out receipts** (fewer than the planned ~12), first use (no saved preferences), item-name
rule `name-match=recognisable-0.70`, 3 warm re-scans. The owner returned aggregate scores only.

**Sample size.** At n = 7, **one receipt is about 14.3 percentage points**, so every share below is
shown as a count first. A 70% share needs 5 of 7 receipts (71.4%); rule (b)'s +10 points needs at
least 1 more receipt than Tesseract.

### 6.1 Desktop, held-out set (n = 7)

| Browser | Engine | Within 2 (x/n, %) | Silent errors | Median warm |
|---|---|---|---|---|
| Edge 157 | Tesseract | 0/7 (0.0%) | 3 | 5.8 s |
| Edge 157 | Paddle | 0/7 (0.0%) | 7 | 12.5 s |
| Firefox 152 | Tesseract | 0/7 (0.0%) | 3 | 5.8 s |
| Firefox 152 | Paddle | 0/7 (0.0%) | 7 | 13.2 s |

Failed/timed-out scans, session-cold times and unstable re-reads were not part of the figures the
owner reported, so they are not shown here.

### 6.2 Correction actions by field (held-out, totals over the 7 receipts)

As reported by the owner, Edge / Firefox:

| Field | Tesseract (Edge / Firefox) | Paddle (Edge / Firefox) |
|---|---|---|
| Extra product rows | 15 / 28 | 24 / 23 |
| Charge fields | 11 / 11 | 10 / 8 |
| Printed total | 5 / 5 | 5 / 5 |
| Missing products | 6 / 8 | 5 / 4 |
| Quantity, line amount | not reported | not reported |

Extra rows are the largest source for both engines, then charges. The printed total was wrong on
5 of 7 receipts for both engines in both browsers. That both engines miss in the same places
suggests much of the error comes from how the shared parser reads unfamiliar receipt layouts
rather than from character recognition alone; the per-receipt data that would confirm this was not
returned (held-out mode).

### 6.3 By photo condition

Not reported (aggregates only); at n = 7 a per-tag breakdown would have 1–3 receipts per tag.

### 6.4 Phones

**Not run.** Rules (c) and (d) were not tested because Paddle had already failed rules (a) and (b)
on desktop; a phone result could not change the decision.

### 6.5 Decision-rule outcome

| Rule | Outcome | Detail |
|---|---|---|
| (a) zero silent financial errors (Paddle) | **FAIL** | Paddle 7 silent errors in Edge and 7 in Firefox (Tesseract: 3 and 3) |
| (b) +10 points within 2 (held-out) | **FAIL** | Edge: Paddle 0/7 vs Tesseract 0/7, +0.0 points; Firefox: 0/7 vs 0/7, +0.0 points |
| (c) median warm phone scan ≤ 8 s | **not run** | Paddle had already failed (a) and (b). For reference, Paddle's desktop warm medians were 12.5 s and 13.2 s |
| (d) Paddle correctness ≥ Tesseract per phone | **not run** | Same reason |
| 70% stop rule | **STOP ENGINE WORK** | Neither engine reaches 70% (5/7) in either browser: both are 0/7 |
| **Decision** | **FAIL: Paddle does not replace Tesseract** | |

### 6.6 Development vs held-out

The development receipts scored **40–60% within 2 corrections**; the held-out receipts scored
**0%** with both engines. A drop that large points to **overfitting to the familiar receipts**:
the parser rules ported and fixed in Batches 1b and 2a were checked against the development set,
and they do not carry over to unfamiliar layouts. This affects both engines equally, because both
feed the same parser.

### 6.7 Caveats

- **Small sample.** n = 7 (one receipt ≈ 14.3 points). The decision does not hinge on it: Paddle
  failed rule (a) by 7 silent errors per browser, and both engines were 0/7 within 2.
- **The held-out set was seen by the coordinator.** Claude drafted the held-out references from
  the owner's photos, and the owner checked them. So the held-out receipts were not unseen by the
  project's coordinator. Nothing from them went into any code brief before this run, and no code
  was changed using them, so the run still measured code that had not been tuned on them. The next
  held-out set will have references written by the owner (6.8).

### 6.8 Decision and follow-up (owner, 11 Nov 2026)

1. **Paddle does not replace Tesseract.** Tesseract stays the only engine.
2. **Paddle is removed from the app** (`cleanup/remove-paddle`): adapter, worker, models, packages,
   the dev engine switch and the phone timing page. The `OcrEngine` interface, engine pool and
   engine injection stay, so an engine could be added later.
3. **Engine work stops** (70% stop rule).
4. **The 7 held-out receipts become development receipts**, giving 12 development receipts. They
   may now be used for development like the others.
5. **A fresh held-out set** will be collected later, with references written by the owner.

The device-based fallback in the brief (Paddle on capable phones) does not apply: Paddle failed on
accuracy, not only on speed.

## 7. Tooling verification before the run (synthetic data only, 11 Nov 2026)

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

- **Phones** were not tested (rules (c) and (d) not run; see 6.4).
- **Safari** was not tested.
- Only aggregate figures were returned; per-receipt and per-condition results are not available
  (by design for a held-out run).
- **Sample size:** 7 held-out receipts; one receipt is about 14.3 points.
- The tooling checks in section 7 used synthetic receipts only; the agent never saw the held-out
  results beyond the aggregates in section 6.

## 9. For the owner

1. **Done (11 Nov 2026):** verdict recorded, Paddle removed, held-out receipts reclassified as
   development, engine work stopped (docs/DECISIONS.md).
2. The Cloudflare build variable `VITE_SPLITLAH_ENGINE_SWITCH`, if you added it, can be deleted
   (docs/DEPLOY.md).
3. Next: collect a fresh held-out set and write its references yourself before any new run. The
   harness (`npm run receipts:dev`, source "Engine scoring") still scores Tesseract on it.

## 10. Paddle removal: what it saves (measured 11 Nov 2026)

Before: `main` at `6dbcd90`. After: `cleanup/remove-paddle`. Each measured in a fresh clone with
`bun install --frozen-lockfile` (Bun 1.4.4, Linux x64) from an empty cache, then `npm run build`
and `npx wrangler@4.154.0 deploy --dry-run --config cloudflare/wrangler.jsonc`.

| | Before | After | Saved |
|---|---:|---:|---:|
| Packages in `bun.lock` | 636 | 617 | 19 (2 direct + 17 transitive) |
| Packages installed | 553 | 534 | 19 |
| Direct dependencies (`dependencies`) | 55 | 53 | 2 |
| `node_modules` (apparent size) | 495,463,771 B | 361,489,655 B | 133,974,116 B (27%) |
| `node_modules` (on disk, `du -h`) | 582 MiB | 451 MiB | 131 MiB |
| Checkout without `node_modules`, `.git`, `.output` | 33,866,289 B | 12,236,499 B | 21,629,790 B (model archives 21,546,025 B) |
| Production static assets (`.output/public`) | 11,613,801 B, 19 files | 11,612,303 B, 15 files | 1,498 B |
| Worker (`.output/server`) | 1,780,679 B | 1,776,682 B | 3,997 B |
| Wrangler upload (Worker) | 1,738.60 KiB, gzip 388.54 KiB | 1,734.69 KiB, gzip 387.69 KiB | 3.91 KiB, gzip 0.85 KiB |
| Preview build with `VITE_SPLITLAH_ENGINE_SWITCH=on` | 66,283,118 B static | 11,612,303 B (the variable is ignored) | 54,670,815 B |

- Production builds already contained no Paddle files, so the deployed app is essentially
  unchanged: the small saving is the dev-page guard and route, and the client JS is now split into
  4 chunks instead of 8 (538,355 B of JS instead of 539,853 B).
- The large savings are in installs (about 134 MB less in `node_modules`, mostly
  `onnxruntime-web` 94.0 MB, `@paddleocr/paddleocr-js` 23.8 MB and `@techstark/opencv-js` 11.8 MB),
  in the checkout (21.5 MB of model archives), and in preview builds with the switch on.
- Git history still holds the model archives (removing them from history would rewrite pushed
  history, which is not allowed), so a fresh `git clone` downloads the same pack as before.
