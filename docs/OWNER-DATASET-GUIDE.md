# Owner guide: collecting receipts for the engine comparison

This is for you (the owner) only. Claude never sees these receipts, their photos, their references
or their OCR text. Claude only ever sees the summary block the harness produces (receipt IDs and
counts).

> **Update, 11 Nov 2026.** The engine comparison is finished and PaddleOCR was removed
> (docs/DECISIONS.md). The 7 receipts used as the held-out set are now **development** receipts
> (12 development receipts in all); you can keep them with your development receipts. A **fresh held-out set**
> will be collected later, following this guide, with **references you write yourself** (not
> drafted by Claude). The harness now scores Tesseract only (source "Engine scoring").

## 1. How many, and which

- About **18 receipts** from at least **8 materially different layouts**. A layout is a merchant's
  printed format: the same chain's printer counts as one layout, even across branches.
- Split them **by layout** into about **6 development** and about **12 held-out** receipts. Every
  receipt of a layout goes into the same set; never put one layout in both.
- Choose the held-out layouts **before** looking at any engine results, and don't change the split
  afterwards.
- Aim for variety. Some good kinds to include:
  - hawker or kopitiam slip; food court;
  - restaurant with service charge and GST added; café with GST included;
  - supermarket receipt that is long, with item discounts and quantities;
  - delivery-app printout with delivery or platform fees;
  - receipt with a bill-level discount, and one with cash rounding;
  - retail or cinema receipt with quantities of 2 or more.
- Vary the photo conditions too, and note them in the reference's `photo_condition_tags` as a list
  of short words, for example `["dim_light", "curled"]` (state `known`, evidence
  `{ "kind": "independent_user_verification", "location": "photo" }`). Use a small fixed set such
  as `flat_good_light`, `curled`, `dim_light`, `long`, `faded`. The summary breaks results down by
  these tags.
- At 12 held-out receipts, one receipt is about 8 percentage points. The report shows counts
  (for example 9/12) next to percentages for this reason.

## 2. Redact before you photograph

The photos stay private, but redact anyway.

- Cover these with a strip of paper **before** taking the photo, so there is nothing to edit later:
  - card numbers, even partial ones;
  - names;
  - membership, loyalty and phone numbers;
  - personal addresses;
  - QR codes and barcodes for e-receipts or loyalty accounts.
- Don't cover product lines, amounts, charges, GST or the total: those are what is being measured.
- Turn off location tagging in the phone's camera before taking the photos. If a photo already has a
  location, remove it in Windows: right-click the file → Properties → Details → "Remove Properties
  and Personal Information".
- Name the photos `REG001.jpg`, `REG002.jpg`, … For example, use `REG001`–`REG006` for development
  and `REG101`–`REG112` for held-out. (IDs are letters then up to 6 digits.)

## 3. Write a verified reference for each receipt

1. Copy `tools/receipt-regression/reference-format/reference-template.json` once per receipt, named
   `REG101.owner-inventory-v1.reference.private.json` (and so on). For a corrected version, save a
   new file as `-v2` (the harness uses the highest version).
2. Fill it in **from the paper receipt**, never from any OCR or app output. Set
   `written_independently_of_ocr` to `true`.
3. Each field has a `state`:
   - **`known`**: you can read it. Give the value and evidence, for example
     `"evidence": { "kind": "printed", "location": "line 4" }`.
   - **`not_printed`**: it isn't on the receipt. This needs `verified_absence` evidence.
   - **`illegible`**: you can't read it.
   - **`not_applicable`**: it doesn't apply to this receipt.
   - **`not_yet_verified`**: you haven't checked it yet.

   **Only `known` fields are scored.** A field that isn't known never earns or loses points.
4. Money is in **integer cents** (`12.50` → `1250`). Quantities are exact fractions
   (`{ "numerator": 2, "denominator": 1 }`).
5. Set `receipt_id` (known: `REG101`), `partition` (`development` or `held_out`) and
   `merchant_layout_group_id` (your own label, for example `L03`). Set the
   `all_…_accounted_for` flags to `true` only when you have listed **every** product row, discount
   and charge. Extra rows are only counted against an engine when the product list is complete.
6. The harness checks every reference with the owner's contract
   (`reference-format/reference-contract.mjs`) when you run it. If one fails, the run is refused and
   the error is shown as a path and code only (for example
   `$.products.2.quantity known_requires_independent_evidence`). Fix it and run again.

## 4. Where to keep the files

**Development set.** Keep it where it is now: the Git-ignored `receipt-regression.local/` in your
project folder, or anywhere outside the repository. Never commit it.

**Held-out set.** It must be **outside every folder Claude, Claude Code or the Claude desktop app
can access**:

- **Not** inside the project folder `%USERPROFILE%\Project-SplitLah-v-0.1` (it is connected to
  Claude), and not in `receipt-regression.local\` inside it.
- Not in a folder that is synced to a cloud drive Claude is connected to, and not in any folder you
  have shared with Claude (check the Claude desktop app's connected folders).
- Suggested: a new folder that you never connect to anything, for example
  `%USERPROFILE%\SplitLah-heldout\` with two subfolders, `photos\` and `references\`.
- Never attach these files to a chat, paste their contents, or type their paths where Claude can
  see them. Open them only through the harness's file pickers.
- To test on a phone, copy only the photos (and references) you need to the phone, and delete them
  from the phone afterwards.
- Optional: keep a backup on an offline USB drive.

## 5. What you send back

Only the summary block from the harness (`SPLITLAH ENGINE COMPARISON v1 …`) and the phone pages'
result lines (`phone | …`). They contain receipt IDs, counts, timings, the browser and the phone's
user agent; no product names, amounts or text. Read the block before sending it.
