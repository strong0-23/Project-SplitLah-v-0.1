# Decisions

Owner-approved decisions. Each has the rule and the reason for it.

## Receipt scanner (approved by the owner, 6 Nov 2026)

### D1: SGD-only app; foreign receipts parsed as printed, with a warning
**Rule.** The app stays SGD-only. A non-SGD receipt is parsed with amounts as printed, and the user sees a warning naming the detected currency. Zero-decimal currencies (IDR, JPY, …) are stored ×100, so ¥1,200 displays as `1,200.00`.
**Why.** Multi-currency would touch storage, bill maths and the UI, which is out of scope for an MVP. Splitting works the same in any currency as long as amounts stay as printed; the warning stops the user mistaking them for SGD. Storing ×100 keeps every amount in integer cents with no schema change.
**Where.** `numbers.ts` (detection, minor digits), `parse.ts` (warning).

### D2: Discounts under an item reduce that item, unless the subtotal says otherwise
**Rule.** A discount printed directly under an item (before any subtotal) reduces that item. If the printed subtotal equals items + those discounts, they are moved back to the bill-level discount.
**Why.** An item-level discount should only affect whoever had that item. But some receipts print the pre-discount subtotal, which shows the shop applied the discount to the bill; the printed subtotal is the evidence that decides.
**Where.** `parse.ts` (`addDiscount` and the subtotal check after the loop).

### D3: Add-ons belong to the item above
**Rule.** A priced add-on is added to the item above it. A free add-on becomes a note on that item. Neither becomes an item of its own.
**Why.** "+ Oat milk 0.80" is part of one person's drink. As a separate item it could be assigned to someone else, and free options would clutter the item list.
**Where.** `lexicon.ts` (`MODIFIER`), `parse.ts`.

### D4: Cash rounding up to 5 cents; split on the unrounded total
**Rule.** Cash rounding of up to 5 cents is recognised, and splitting uses the unrounded total, with a warning. A larger "rounding" is treated as a misread.
**Why.** Cash rounding (Malaysia, and some Singapore shops) is to the nearest 5 cents, so anything larger is not real rounding. Splitting the unrounded total keeps each share tied to what was ordered; the few cents of rounding don't belong to any one person.
**Where.** `parse.ts` (`MAX_ROUNDING`).

### D5: Keep the engine interface so PaddleOCR can be plugged in later
**Rule.** OCR engines sit behind `OcrEngine` (`types.ts`). Tesseract is the default. Another on-device engine is a new adapter and needs no parser change.
**Why.** The engine choice (Tesseract vs PaddleOCR) is to be made on evidence later (Batch 2). A narrow interface lets both run on the same parser, so a comparison measures the engine alone.
**Where.** `types.ts`, `tesseract-engine.ts`, `scan.ts` (engine injected).

### D6: Delivery and similar fees count as a service charge
**Rule.** Delivery fees count as a service charge, spread in proportion to what each person ordered. They are not shown as an item. Delivery fee/charge, platform fee, packaging/packing fee, small-order fee and booking fee (plus common Malay/Indonesian/European equivalents) add to `serviceAmountCents`. A negative fee line (for example "Delivery Discount -1.00") reduces that amount.
**Why.** A fee for the whole order is shared like a service charge; as an item it would have to be assigned to one person or split evenly, which isn't fair when orders differ in size.
**Where.** `lexicon.ts` (`service` entry), `parse.ts`.

## Receipt scanner, Batch 1b (approved by the owner, 7 Nov 2026)

Decided while porting parser-v2's parsing rules, where they conflicted with D2 or with existing
rework behaviour.

### D2 (amended): offers under an item use parser-v2's match rule
**Rule.** D2 stands: a discount printed directly under an item reduces that item. For a signed
offer row ("2 FOR $8.00 2.00-"), the saving is taken off the item above only when that item's
quantity was printed explicitly as the offer's N and its line amount minus the offer price equals
the saving. Otherwise nothing is deducted, the row is listed under "Lines not used", and the
discount is flagged. A summary discount equal to the item discounts already applied, and any
"Total savings" summary, is never deducted again (P3).
**Why.** Item-level placement keeps a discount with whoever had the item (D2). parser-v2's match
rule stops an offer from being applied to the wrong item or with the wrong amount.
**Where.** `parse.ts` (offer rows, `addDiscount`, savings summaries).

### D7: a bare number next to a name is not a quantity without evidence
**Rule.** A plain leading or trailing number on an item row ("VITAMIN B 12", "100 PLUS",
"SOAP 2") is a quantity only under a Qty column heading, or when the row's own unit price × that
number equals its line total. Otherwise it stays in the description and the row is flagged for the
user. Explicit quantities ("2 x", "x2", "2 @") always count. (parser-v2 rule.)
**Why.** On real receipts the old reading turned trailing numbers and OCR debris into quantities
of 4 and 8 (P2). A flagged row costs the user one check; a wrong quantity silently mis-splits.
Three synthetic rework expectations changed as a result ("2 Pancakes", "Pad Thai 2",
"Nasi Goreng 2" now keep the number in the name, flagged).
**Where.** `items.ts` (`splitItemLabel`, `readItemRow`), `lexicon.ts` (`qtyColumnsOf`).

### D8: OCR digit repair is kept, and always flagged (owner, 7 Nov 2026)
**Rule.** Letters OCR puts inside a number are still repaired ("1O.5O" → 10.50, "l.80" → 1.80).
Whenever an amount needed a repair, whatever uses it is marked: an item row is flagged, a service
or GST amount marks the charges uncertain, a discount marks the discount uncertain, and a total,
subtotal or rounding amount marks the total uncertain. The warning names the printed text
(“1O.5O” was read as 10.50…). Amounts printed cleanly are not affected.
**Why.** The repair recovers many real amounts, but a repaired digit can be wrong; the user should
check every one of them rather than have it pass silently.
**Where.** `numbers.ts` (`Amount.repairedFrom`), `parse.ts` (`noteRepair`).

### D4 confirmed; rounding allocation deferred (owner, 7 Nov 2026)
parser-v2's rounding-as-a-bill-adjustment, shared among participants, is not adopted for now.
D4 stays: splitting uses the unrounded total, and the rounding is shown as a warning.

## Receipt scanner, Batch 2b (approved by the owner, 6 Nov 2026)

### Self-hosted Tesseract files
**Rule.** Tesseract's worker (`worker.min.js`), its two LSTM cores (SIMD and non-SIMD) and the
`eng` model (`4.0.0_best_int`) are served from the app's own static assets under
`public/tesseract/`, at pinned versions (tesseract.js / tesseract.js-core 5.1.1,
@tesseract.js-data/eng 1.0.0). There is no CDN fallback. Versioned paths, and a size + SHA-256
manifest in `tesseract-assets.ts` checked by a test, keep the copies in step with the installed
packages.
**Why.** Scanning then works when jsDelivr is blocked or down, no third party sees when the app
is used, and the CSP can drop jsDelivr. The brief approved self-hosting for both engines (Batch 2b
step 5); Paddle's files wait for the decision on adding Paddle.
**Where.** `tesseract-assets.ts`, `tesseract-engine.ts`, `public/tesseract/`.


## Receipt scanner, Batch 2b: PaddleOCR as a dev-only challenger (owner decisions, 11 Nov 2026)

### PaddleOCR SDK, dev-only, WASM-only runtime
**Rule.** `@paddleocr/paddleocr-js` is added at exactly `0.4.2`, with `onnxruntime-web` pinned at
exactly `1.22.0` (the version the SDK already resolves to; pinned so the self-built runtime files
always match it). Vite aliases `onnxruntime-web` to its WASM-only build (`onnxruntime-web/wasm`),
so no WebGPU/JSEP runtime is shipped. Paddle is reachable only through the dev-only engine switch
below; Tesseract stays the default and normal users never get Paddle.
**Why.** Phase 2c needs both engines in the same build to compare them on evidence. The WASM-only
runtime is 11.2 MB instead of 21.9 MB and works on every browser the app supports.
**Where.** `package.json`, `vite.config.ts`, `paddle-assets.ts` (version constants, checked by a test).

### Paddle models self-hosted from the app's own origin
**Rule.** The PP-OCRv5 mobile det/rec archives committed in `paddle-models/` (moved from
`public/paddle/` on 11 Nov 2026, see below; sizes and SHA-256 in `paddle-models/PROVENANCE.md` and
`paddle-assets.ts`, checked by a test) are the only model source.
They are fetched from the page's own origin; there is no external model host and no CDN fallback.
**Why.** Same reasons as Tesseract self-hosting: works when third-party hosts are blocked, no third
party sees app usage, and the CSP needs no extra origins.
**Where.** `paddle-assets.ts`, `paddle-models/`.

### Paddle runs in a Web Worker
**Rule.** The SDK runs inside the app's own module worker (`paddle.worker.ts`), with the SDK's own
worker mode off. The image is posted to the worker as a Blob; `terminate()` ends the worker.
**Why.** Inference takes seconds; on the main thread it would freeze the UI and could not be
interrupted. Ending the worker is real cancellation and frees all SDK memory at once.
**Where.** `paddle-engine.ts` (main-thread side), `paddle-runtime.ts`, `paddle.worker.ts`.

### Paddle load timeout 120 s (PROVISIONAL); Tesseract keeps 60 s
**Rule.** An engine may set `loadTimeoutMs` on `OcrEngine`; Paddle sets 120 s. The overall scan
limit grows by the same extra time, so recognition keeps its 150 s budget. Tesseract and any engine
that sets nothing keep `LOAD_TIMEOUT_MS` (60 s). 120 s is provisional until the Phase 2c phone timings.
**Why.** Paddle's first download is about 26 MB compressed (models + runtime), versus about 4.4 MB
for Tesseract; 60 s is too short on slow mobile data.
**Where.** `types.ts` (`OcrEngine.loadTimeoutMs`), `scan.ts`, `paddle-assets.ts`.

### Dev-only engine switch `?engine=paddle`
**Rule.** `?engine=paddle` selects PaddleOCR only when the switch is compiled in: in `npm run dev`
(`import.meta.env.DEV`), or in a build made with `VITE_SPLITLAH_ENGINE_SWITCH=on`. Both are build-time
constants; in a normal production build the switch folds to "Tesseract", the URL is never read and
no Paddle code, worker or runtime is emitted. `VITE_SPLITLAH_ENGINE_SWITCH` must never be set for
the production deploy; since 11 Nov 2026 it is also refused on a Workers Builds build of `main`
(see "Paddle files only in builds with the engine switch on").
**Why.** The comparison needs both engines in one build; users must never get the challenger.
**Where.** `engine-select.ts`, `ScanStep.tsx` (passes `engineFactoryFor()` to `scanReceipt`).

### Paddle files only in builds with the engine switch on (owner, 11 Nov 2026)
**Rule.** A normal build (`npm run build`, and every production deploy of `main`) contains no
Paddle model archives and no Paddle/ONNX Runtime code or WASM. The archives live in
`paddle-models/`, outside `public/`. The `splitlah:paddle-models` plugin in `vite.config.ts` serves
them at `/paddle/` in `npm run dev`, and copies them into the client output only when the switch is
compiled in (`import.meta.env.DEV`, or `VITE_SPLITLAH_ENGINE_SWITCH=on`). The Paddle code, worker
and runtime were already left out of builds without the switch. On a Workers Builds build of the
production branch (`WORKERS_CI_BRANCH` = `main`, `PRODUCTION_BRANCH` in `paddle-assets.ts`) the
switch is refused even if the variable is set, and the build is identical to a normal one.
**Why.** Production never loads Paddle, so shipping 21.5 MB of model files with it only adds deploy
size. Cloudflare build variables apply to every branch, so the guard lets the owner turn Paddle on
for preview builds (docs/DEPLOY.md) without any risk of it reaching production.
**Where.** `vite.config.ts`, `paddle-assets.ts` (`engineSwitchForBuild`, tested), `paddle-models/`,
`docs/DEPLOY.md` ("Builds with Paddle on").

### Paddle packages pinned exactly (owner, 11 Nov 2026)
**Rule.** `package.json` pins `@paddleocr/paddleocr-js` at exactly `0.4.2` and `onnxruntime-web` at
exactly `1.22.0`, the version the SDK's own range (`^1.22.0`) resolves to in `bun.lock`. The SDK
must use that single copy: a test fails if the pins and the installed versions differ, or if a
nested `onnxruntime-web` appears under the SDK. Upgrading either is a deliberate change of both
pins, `paddle-assets.ts` and the lockfile together.
**Why.** The adapter builds ONNX Runtime's glue and WASM files from the installed package and the
Vite alias points at it; if the SDK silently picked up another runtime version, the self-built
files and the runtime JS could drift apart.
**Where.** `package.json`, `bun.lock`, `paddle-assets.ts` (`PADDLE_SDK_VERSION`,
`PADDLE_ORT_VERSION`), `paddle-engine.test.ts`.

### parser-v2 UI and storage features: none for the MVP
**Rule.** None of parser-v2's UI/review features (B1–B6) or storage/schema/bill-maths features
(X1–X6), as listed in `docs/reports/2026-11-parser-v2-port.md` §5–6, is adopted for the MVP.
D4 stays as it is.
**Why.** Owner decision, in line with the 2a report's recommendation. These features would change
the `Receipt` interface, the storage schema, the bill maths or the wizard flow, which is beyond the
MVP's scope.
**Where.** No code change; recorded so later work does not port them without a new decision.

## Engine comparison, Phase 2c (owner decisions, 11 Nov 2026)

### Dataset size: about 18 receipts, about 6 development and 12 held-out
**Rule.** The comparison uses about 18 receipts across at least 8 materially distinct layouts,
split by merchant layout into about 6 development and about 12 held-out receipts (a layout is in
one set only). This replaces the earlier plan of about 30 receipts (10 development, 20 held-out).
The decision rule and all its thresholds are unchanged. The report states the smaller sample and its
lower statistical confidence: each engine's share is shown as a count (x/12) next to the
percentage, and at n = 12 one receipt is about 8 percentage points.
**Why.** A smaller set the owner can collect and verify carefully, with every reference written
independently of OCR, is worth more than a larger, less checked one. Showing counts keeps the
uncertainty visible: for example, rule (b)'s 10 points means at least 2 more receipts out of 12.
**Where.** `docs/OWNER-DATASET-GUIDE.md`, `docs/reports/2026-11-engine-comparison.md`,
`tools/receipt-regression/comparison.ts` (shares shown as x/n with the percentage).

### Scoring: extra correction actions
**Rule.** A receipt's score is the number of Review-screen field actions a user must make to reach
a correct bill, against the owner's verified reference, counting only fields whose state is
"known": +1 per missing reference product (add); +1 per extra product row (delete); +1 per wrong
quantity on a matched product; +1 per wrong line amount on a matched product; +1 for each wrong
charge field (discount, service and GST amounts, and GST inclusive/exclusive when known); +1 if the
printed total field is wrong. The calculated total is derived and never an action. Products are
matched with the harness's existing matching, unchanged. A receipt "needs at most 2 extra
corrections" when this count is 2 or less; a failed or timed-out scan never does, and stays in the
denominator.
**Why.** It measures what the owner cares about (how much fixing a scan needs) in a way that is
simple to check. It simplifies the owner's earlier proof-bound evaluator (approved-comparison-r1)
while keeping all of its thresholds: ≤ 2 corrections, +10 points, 8 s median warm phone scan,
correctness on each phone, and the 70% stop rule.
**Where.** `tools/receipt-regression/corrections.ts` (tested in `corrections.test.ts`),
`tools/receipt-regression/README.md`, `docs/reports/2026-11-engine-comparison.md`.

### How the decision rule is applied (accepted 11 Nov 2026)
**Rule.** Rule (c): each phone's Paddle warm times are pooled and their median must be ≤ 8 s.
Rule (d): per phone, Paddle's number of receipts within 2 corrections must be at least
Tesseract's, over the same receipts scanned with both engines and a verified reference. Stop rule:
an engine reaches 70% only if it does so in both Edge and Firefox. Each phone is tested on at least
4 receipts; the owner names the phones.
**Why.** These make the rules checkable from IDs-and-counts data without any receipt content, and
never let missing data count as a pass.
**Where.** `tools/receipt-regression/comparison.ts` (`verdict`, tested in `comparison.test.ts`).

### Keep a loaded OCR engine between scans (11 Nov 2026)
**Rule.** In a page session, a loaded engine (worker and models) is kept for the next scan, for
both engines alike. It is disposed after 3 minutes idle (`ENGINE_IDLE_MS`), on page hide/unload
(`pagehide`), when another engine is chosen, and on any scan error, cancel or timeout. Cancel still
stops a running recognition at once (the engine is terminated and the next scan loads a new one).
A concurrent second scan gets its own single-use engine. Orientation probes and the 60 s / 120 s
load limits are unchanged. `runOcr` without a pool keeps the old one-shot behaviour; `scanReceipt`
uses the page's shared pool.
**Why.** Restarting the engine on every scan was an app inefficiency, not a measurement choice:
a user's second scan waited for the engine to start again. Fixing it before the comparison means
"warm" measures what users get, and it applies equally to both engines, so it is not tuning against
data.
**Where.** `src/lib/scan/engine-pool.ts`, `scan.ts` (`ScanDeps.pool`), `index.ts` (`scanReceipt`),
`engine-reuse.test.ts`, `paddle-engine.test.ts`.
