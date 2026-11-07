# Claude Code brief: receipt scanner rework (handoff)

This brief has two batches. **Do Batch 1 first.** Start Batch 2 only after the owner has reviewed the Batch 1 PR and says go.

**Owner:** Lahvin (stakeholder; approves decisions)
**Repo:** strong0-23/Project-SplitLah-v-0.1
**Work branch:** `rework/receipt-scanner`, branched from `fix/receipt-ocr-recovery`
**Baseline for the report:** `main` (the original Lovable import, dabfd34)
**Target stage:** MVP

## Batch 1: modular rework

### Goal
Make receipt scanning work for as many receipt types as possible while keeping it lightweight and modular. Make no change to bill maths, storage schema or UI flow beyond what the scanner needs.

### Hard rules (apply to both batches)
1. **Never push to `main` and never merge.** Push only the batch's work branch (`rework/receipt-scanner` for Batch 1, `engine-eval` for Batch 2), and open a PR for owner review. Never rewrite pushed history: no force-push, rebase, amend or squash of pushed commits.
2. **Recognition stays on the device.** Never upload images, and add no cloud OCR or vision API.
3. **Tesseract stays the default engine.** In Batch 1, do no engine tuning and no PaddleOCR work. The engine interface only has to make a swap possible later.
4. **Receipt data rules carry over from the evaluation brief.**
   - Use synthetic text fixtures only.
   - Never read or commit real receipt photos, held-out receipts, their references or their OCR text.
   - Commit nothing containing card numbers or personal names.
5. Ask the owner before any change to an established interface, the storage schema or the dependencies.
6. Never claim a check you didn't run.

### State already in the branch (pushed as a WIP commit at handoff)
New feature module `src/lib/scan/`. The old `ocr.ts`, `parser.ts` and `preprocess.ts` are removed.

| File | Responsibility | Pure? |
|---|---|---|
| `types.ts` | Contracts: `OcrEngine`, `OcrPage`/`OcrWord`, errors, scan options | yes |
| `image.ts` | Lighting flattening, paper bounds (moved from `preprocess.ts`) | yes |
| `canvas.ts` | Decode, rotate, crop, scale (pixel budget, so long receipts stay legible), preview | DOM adapter |
| `tesseract-engine.ts` | Tesseract.js adapter behind `OcrEngine` (lazy import) | SDK adapter |
| `layout.ts` | Word boxes → reading-order rows; wide gaps kept as column marks | yes |
| `numbers.ts` | Locale-aware amounts (1,234.56 / 1.234,56 / zero-decimal), negatives, OCR digit fixes, currency detection | yes |
| `lexicon.ts` | Receipt vocabulary (EN, MS/ID, DE/FR/ES/IT/NL). A tail-word check stops "SERVICE TEA" or "TAX-FREE COLA" being read as charges | yes |
| `items.ts` | Item-row shapes: qty/unit/total columns, `2 @ 3.50`, `x2`, weighed goods | yes |
| `reconcile.ts` | Inclusive vs exclusive tax, consistency score; `isConsistent` reuses `computeTotals` | yes |
| `parse.ts` | Section state machine (header → items → summary → footer); lines → draft `Receipt` | yes |
| `scan.ts` | Workflow: decode → load → orient → recognise → optional 2nd pass; cancellable, time-bounded, engine injected | workflow |
| `index.ts` | Public API (`scanReceipt` and others). UI imports `@/lib/scan` only | — |

The parser also handles:
- name rows followed by a detail row;
- add-ons and modifiers folded into the parent item;
- item discounts;
- a bill-level discount;
- a label on one line with its amount on the next;
- cash rounding;
- savings, tip-suggestion and count lines (ignored);
- multiple tax lines;
- a "last total before payment" rule.

`ScanStep.tsx` is now a thin caller of `scanReceipt`, and `bill.test.ts` imports from `./scan`.

**Last known checks** (before an interrupted command): 64/64 tests passed (36 existing + 28 new), `tsc` was clean and `vite build` succeeded.

**Interrupted step.** The interrupted command may have partly run. Re-check:
- `parse.ts` `normaliseLine`: the `\u0000` placeholder regex should be replaced with a split/join (it fails the lint rule `no-control-regex`);
- `npx prettier --write src/lib/scan`.

### Owner decisions (approved by the owner, 6 Nov 2026)
- D1: The app stays SGD-only. A non-SGD receipt is parsed with amounts as printed, and the user sees a warning. Zero-decimal currencies are stored ×100 so they display as `1,200.00`.
- D2: A discount printed directly under an item (before any subtotal) reduces that item. If the printed subtotal equals items + those discounts, they are moved back to the bill-level discount.
- D3: A priced add-on is added to the item above it. A free add-on becomes a note on that item. Neither becomes an item of its own.
- D4: Cash rounding of up to 5 cents is recognised, and splitting uses the unrounded total (with a warning). Anything larger is treated as a misread.
- D5: The engine interface is kept so PaddleOCR can be plugged in later without parser changes.
- D6: **Delivery fees count as a service charge**, spread in proportion to what each person ordered — not shown as an item. Add delivery fee/charge (and platform/packaging/small-order fee) terms to the `service` entry in `lexicon.ts`, so they add to `serviceAmountCents`. Add a test where a service charge and a delivery fee appear together and reconcile. *Not yet implemented at handoff.*

### Tasks
1. **Verify the starting state.** Run `npx tsc --noEmit`, `npx vitest run`, `npx eslint src/lib/scan` and `npx vite build`.
   - Finish the interrupted lint/format fix.
   - Run Prettier on `src/lib/scan` only. Don't reformat other files: the repo's existing code already fails Prettier, so leave that alone.
2. **Review the edge cases** below and add a synthetic test for each. Fix any that fail, in the responsible module only.
   - A long receipt where a description wraps onto 3 lines.
   - Two subtotals: the second one comes after the discount.
   - A receipt with no item header that has an address line containing a price-like number.
   - A delivery-app printout with a "Delivery fee" line (implement D6).
   - "Total" printed in the footer after the payment lines.
   - OCR text with `|` column separators.
3. **Run a manual smoke test** with `npm run dev` on a synthetic image: render a fixture as text onto a canvas, or use a screenshot of typed text. Never use a real receipt.
   - Check the loading, error, cancel and empty-result states.
4. **Update the docs.**
   - `AGENTS.md` (keep the LOVABLE block untouched) architecture section: paths are now `src/lib/scan/*`, with the engine interface and the pure/adapter split.
   - `docs/MODULES.md`: module table, contracts and dependency direction.
   - `docs/DECISIONS.md`: D1–D6, each with its reason.
5. **Write the report** at `docs/reports/2026-11-receipt-scanner-rework.md`. It is the owner's record of what changed from the original. Sections:
   1. Summary.
   2. Before vs after, against `main`: file map, plus behaviour per receipt type in a table.
   3. Changes inherited from `fix/receipt-ocr-recovery` vs new in this rework.
   4. Decisions D1–D6.
   5. Tests: which ran and their results.
   6. Not verified, and known limitations. This must state that all tests use synthetic text and that accuracy on real photos is unmeasured; it also covers multi-currency, non-Latin scripts (only the `eng` model is loaded) and handwritten receipts.
   7. Suggested next steps.
   8. `git diff --stat main...rework/receipt-scanner`.
6. **Commit and push.** Commit in small logical commits:
   - module restructure;
   - parser generalisation;
   - tests;
   - docs/report.

   Then push `rework/receipt-scanner` and open a PR into `main` titled "Receipt scanner rework: modular pipeline, more receipt layouts". The PR body summarises the report and links to it. **Do not merge.**
7. **Report back** with the PR link, the check results, and any decision that needs the owner.

### Done when
- All checks pass, and new scan files are lint-clean.
- Every receipt type in `receipt-types.test.ts` reconciles to its printed total.
- The report and docs are committed, and the PR is open and unmerged.

### Batch 1 owner review (6 Nov 2026), PR #2
- **Approved:** the optional `printedNetSubtotalCents` field in `Receipt` and `storage.ts`, inherited from `fix/receipt-ocr-recovery`. It is backward-compatible.
- **Follow-up task 1a**, on `rework/receipt-scanner` before merge:
  - When a scanned receipt's service amount includes delivery/platform/packaging/small-order fees, show a one-line warning if the user switches charges to "Calculate by %". Suggested wording: "Your receipt's delivery/platform fees will drop out if you calculate by %."
  - Record which fee lines were folded in. Use a non-persisted flag, or one derived from `ocrWarnings`; **no schema change**.
  - Add a UI test that shows the warning appears.
  - Update the Batch 1 report with a short addendum section.
  - Push to the same PR. Do not merge.
- **Merge gate (owner):** after 1a, the owner runs the branch locally (`npm run dev -- --host`, phone on the same Wi-Fi) and scans 2–3 familiar development receipts. The owner merges PR #2 only if they look right. Claude Code does not merge.

### Owner PC test (7 Nov 2026): **merge blocked**, do Batch 1b
The owner scanned the development receipts Receipt2–5 locally with PR #2. The rework parser drops rules that parser-v2 had already proven on these receipts. Failure patterns (described in general terms; Claude Code must not ask for the receipts):

| # | Pattern seen | Cause (our diagnosis) |
|---|---|---|
| P1 | Summary/footer lines ("Total (SGD) incl. GST …", "Transaction No/Date") appended to an item description as notes; an item whose price OCR lost was appended to the next item and disappeared | The rework's "unpriced line → note on previous item" rule is too greedy |
| P2 | Quantity 4 and 8 instead of 1 on grocery rows, with leftover tokens ("PW", "%") on the name; a cinema ticket row with qty 1 instead of 2 | Trailing tokens/numbers taken as quantity; parser-v2's trailing/implicit-quantity rules missing |
| P3 | Bill discount = 2× the printed discount (an item-level discount also repeated in the summary) | No discount de-duplication (parser-v2 had this) |
| P4 | A total row read as an item (OCR-damaged label, e.g. "T0TAL"/"TOTA1"); a total amount with its decimal point lost ("52455") | Exact-match labels; no OCR-tolerant label matching (parser-v2 had this) |
| P5 | GST read 6.18 where 9% of the base gives 6.16, and not flagged | No charge-vs-rate sanity check |
| P6 | Stylised merchant name garbled | OCR; out of scope here (engine comparison) |

## Batch 1b: real-receipt fixes (same branch, same PR #2; do before merge)
Phase 2a is moved forward into this batch for **parser rules only**.
1. **Port parser-v2's parsing rules** from branch `parser-v2` into the responsible `src/lib/scan/` modules, together with their tests:
   - OCR-tolerant summary labels;
   - trailing and implicit quantity;
   - discount de-duplication;
   - rounding;
   - payment-label handling;
   - column/row recovery.

   Read `docs/parser-v2.md`, `batch1c-layout.md` and `rounding.md` on that branch first. Where a parser-v2 rule conflicts with D1–D6, stop and ask the owner.
2. **Not in this batch:** parser-v2's UI and storage features. That covers the "save as defaults?" prompt, the bulk confirmations, quantity review, receipt status and any changes to `types.ts`, `storage.ts` or `bill.ts`. Their adoption has not been approved. List them in the report as "available, not ported".
3. **Tighten note attachment (P1):**
   - Only attach an unpriced line to the item above it when it is clearly an add-on: a modifier marker or modifier word, as in `MODIFIER`.
   - Never attach a line that contains summary, payment, date, time or transaction vocabulary, or that is mostly digits.
   - An unpriced line that looks like a product becomes its own flagged item with no price, so the user can fill it in.
4. **Discount de-duplication (P3):** a summary discount equal to the item-level discounts already applied must not be counted again.
5. **Damaged amounts (P4):** on a total or subtotal line, a 3–6 digit integer with no decimal point may be accepted only as a flagged candidate. Read it with a decimal point inserted, and only if that value reconciles with the computed total. Otherwise keep it as not found.
6. **Charge sanity (P5):** when a printed GST or service amount differs from rate × base by any amount, mark that charge uncertain. The warning shows the expected value. Never auto-correct.
7. **Tests:** add one synthetic fixture per pattern P1–P5, written from the descriptions above with invented product names. All parser-v2 tests and all existing rework tests must pass. Where a parser-v2 test assumes the old module API, adapt it to `src/lib/scan` and record that in the report.
8. **Scored merge gate (owner-run):**
   - Bring `tools/receipt-regression` from `parser-v2` into this branch, with its `receipts:*` scripts.
   - Make sure it can run both the parser-v2 parser (as the baseline) and the rework parser on the same OCR text.
   - Give the owner exact commands to run it locally against Receipt2–5 and their references.
   - The owner returns only the summary scores.
   - **Merge only if the rework matches or beats parser-v2 on every receipt** for items, quantities, line amounts, printed total, calculated total and silent errors.
9. **Report:** write `docs/reports/2026-11-batch1b-real-receipt-fixes.md`, covering:
   - what was ported;
   - what was not ported, and why;
   - the fixes for P1–P5;
   - test results;
   - the harness instructions;
   - a placeholder table for the owner's scores.

   Update the PR description. **Do not merge.**

## Batch 2: shared parser, then the engine decision

**Purpose:** pick Tesseract or PaddleOCR on evidence. Both run on the device; no VLM or API calls. Both engines run on the same rework parser, so the comparison measures the engine alone.

**Branch:** `engine-eval`, cut from `rework/receipt-scanner` after the owner merges PR #2 (Batch 1 + 1b). Same hard rules as Batch 1. Nothing is merged and the default engine is not changed without owner approval.

### Phase 2a: remaining parser-v2 items (parser rules were done in Batch 1b)
1. **Source:** branch `parser-v2` on GitHub, pushed on 7 Nov 2026 as one snapshot commit of the owner's local parser-v2 working copy.
   - 410/410 tests passed at push. It adds no new dependencies; only `receipts:*` scripts were added to `package.json`.
   - It includes `docs/parser-v2.md`, `batch1c-layout.md`, `review-confirmation.md` and `rounding.md`, plus `tools/receipt-regression` and `tools/ocr-engine-sandbox`. Read those docs first.
   - Private receipt data was deliberately left out. It stays in the git-ignored `receipt-regression.local/` on the owner's PC. Never ask for it.
2. **Inventory:** list every behaviour parser-v2 has that the rework parser lacks, including:
   - the triage of the 35 legacy test failures;
   - the documented implicit-quantity layouts and their negative tests;
   - the one-time "save as defaults?" prompt for currency, GST rate and service rate;
   - the bulk confirm for printed charges and GST;
   - the cash-rounding rule (±5 cents, applied to the final payable total after GST).

   Where a parser-v2 rule conflicts with D1–D6, **stop and ask the owner** which to keep.
3. **Port** each remaining behaviour into the responsible module in `src/lib/scan/`, bringing parser-v2's tests across as synthetic fixtures. All existing tests must still pass. **UI and storage features need owner approval first.**
4. **Report:** write `docs/reports/2026-11-parser-v2-port.md`. It lists what was ported, what was dropped and why, and the test results.

### Phase 2b: Paddle adapter
1. Add `src/lib/scan/paddle-engine.ts`, implementing `OcrEngine`, using the PaddleOCR browser SDK already chosen for the comparison.
   - Load it lazily, so it stays out of the initial bundle.
   - Only model files are downloaded; the image stays in the browser.
   - Use the same orientation, crop and pixel-budget step as Tesseract.
   - Make no parser changes.
2. Add a dev-only engine switch, a query parameter or local setting, so both engines can be run in the same build. **The default stays Tesseract.** The switch is hidden from normal users.
3. **Ask the owner** before adding the Paddle dependency. Report its download size (models and runtime) and its effect on the initial bundle.
4. Add contract tests, using a fake image, that show the Paddle adapter behaves like Tesseract's:
   - cancel and timeout;
   - releasing resources;
   - word boxes coming back in the same format.
5. **Self-host the model files for both engines** (approved by the owner on 6 Nov 2026).
   - Serve Tesseract's worker, core and `eng` traineddata, and Paddle's models, from the app's own static assets instead of jsDelivr or other CDNs, at pinned versions.
   - Cache them so they download once, then work offline.
   - Report the added deploy size.
   - Confirm that scanning still works with jsDelivr blocked.
6. **Report:** write `docs/reports/2026-11-paddle-adapter.md`, covering:
   - the SDK and its version;
   - download sizes;
   - bundle impact;
   - model self-hosting;
   - contract-test results;
   - any browser limits found.

### Phase 2c: comparison run (owner-gated)
1. **Gate:** start only after the owner confirms the four development reference drafts are verified, with currency and complete item lists, and explicitly authorises the held-out run.
2. **Preflight** on synthetic and development receipts only:
   - Edge plus one non-Chromium browser;
   - capped at two hours and two fixes;
   - at most three candidate configurations per engine after the baseline.
3. **The held-out run is owner-run.** The agent never reads held-out receipts, references or OCR text. The agent supplies the runner and the scoring tool; the owner runs them locally and returns sanitised scores only.
4. **Decision rule (unchanged):** Paddle replaces Tesseract only if all of these hold:
   - zero silent financial errors;
   - at least 10 points more receipts needing 2 or fewer corrections;
   - a median warm phone scan of 8s or less;
   - at least Tesseract's correctness on each tested phone.

   If neither engine reaches 70% of receipts with 2 or fewer corrections, stop engine work. A missing required runtime does not count as a pass.
5. **Report:** write `docs/reports/2026-11-engine-comparison.md`, covering:
   - setup;
   - results per engine, broken down by photo condition, browser and phone;
   - the decision-rule outcome;
   - a recommendation.

   **Do not switch the default engine.** The owner decides. A device-based fallback (Paddle on capable phones, Tesseract otherwise) is proposed only if the results show Paddle passes on accuracy but fails on speed on some phones.

### Done when (Batch 2)
- All three Batch 2 reports (parser-v2 port, Paddle adapter, engine comparison) are committed on `engine-eval` and a PR is open, unmerged.
- Tesseract is still the default.
- Nothing from the held-out set appears in the repo, logs or reports beyond aggregate scores.
