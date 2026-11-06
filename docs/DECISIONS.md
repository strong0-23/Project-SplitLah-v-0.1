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
