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
