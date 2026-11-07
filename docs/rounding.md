# Explicit bill rounding

Before Batch 1c, some rounding labels were treated as payment rows. The bill
calculator had no distinct rounding adjustment, so a printed rounding difference
remained a reconciliation discrepancy.

Rounding is now a separate signed-cent field. It never becomes a product,
discount, tax or tender. Detection retains each literal row and source line.
Automatic application requires one finite, explicit rounding label in the final
bill summary after supported product rows, an exactly readable signed amount,
and an absolute amount no greater than five cents. A readable zero needs no sign.
Prefix/trailing signs and negative parentheses are accepted. A nonzero unsigned
amount, unreadable amount, larger adjustment, uncertain placement or any repeated
rounding row remains for review and is not applied. Identical repetitions are
not automatically deduplicated. No amount is inferred from a total difference.

Explicit user entry may apply a larger signed adjustment after checking the
receipt. The original source is retained separately from that user action.

The calculator sums products and signed credits, subtracts established discounts,
adds service, calculates included/added GST, and only then applies bill rounding.
The unrounded calculated payable, applied rounding and rounded calculated payable
are separate values. The independently printed payable is never rounded again;
it is compared with the rounded calculation. Existing tax bases and GST cents
do not change.

Participant rounding uses the absolute magnitude of each participant's payable
before bill rounding as its weight. The existing integer largest-remainder
allocator distributes the absolute adjustment, breaks ties by ascending
participant ID, and then restores its sign. If every pre-rounding payable is
zero, weights are equal. Shares sum exactly to the signed adjustment, and final
participant payables sum exactly to the rounded bill. This also handles signed
credits without negative allocation weights.

The detector is conservative text interpretation, not an OCR engine change.
Parser flags and final reconciliation can nevertheless affect existing OCR
retry/selection inputs; engine settings and scoring weights remain unchanged.
