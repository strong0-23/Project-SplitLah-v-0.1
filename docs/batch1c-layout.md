# Quantity layout and review — Batch 1c

The parser preserves unsupported numeric prefixes, such as `100 PLUS`, instead
of treating a bare leading number as an observed quantity. A leading quantity
needs an explicit multiplication token or an explicitly leading quantity column.
Identifiers introduced by No/Model/ID/Code/SKU are retained. Currency parsing must
not consume the final S of a product or payment label as a currency prefix.

Automatic **flagged defaults** are deliberately narrower than user entry. They
need an explicit, aligned two-column Description/Amount header; at least two
complete, consistently aligned product rows; no quantity/weight/unit-price
heading; no explicit or mixed quantities; no numeric fragments or ambiguous
financial rows; and no measured/weighted or numeric-name ambiguity. Single-space
OCR text and missing quantity recognition alone are insufficient. Defaults are
defaulted, not observed, do not pass quantity accuracy checks, and need confirmation.
Bulk eligibility revalidates the original raw layout; a stored marker is not proof.

Observed, measured and fractional quantities are never overwritten by the count
default or count-entry bulk action. Users can explicitly select compatible unknown
count rows and apply 1 after checking them. This is user input, with original
sources retained, not a recognition success. One bulk click changing N fields is
N field actions; selection clicks and any value entry are separate interaction costs.

Quantity/amount field uncertainty does not automatically make an otherwise known
product row's **role** uncertain again. Description/layout/role ambiguity still
has separate review state. Unknown fields remain unresolved in accuracy reports,
even if a test verifies that the warning is correctly present.

Preferences are stored separately and require explicit saving of the confirmed
values listed in the optional prompt. They can prefill pending settings but cannot
confirm receipt applicability, charge presence/absence, amounts or GST inclusion.
The optional save/decline prompt is handled once per receipt and never gates review.

Rounding is a final signed bill adjustment after GST. The Review screen exposes
unrounded total, applied adjustment and payable total independently. Manual zero
entry followed by explicit Apply can establish that no bill rounding is needed;
clearing the input leaves it unknown. Printed sources remain inspectable. See
`rounding.md` for evidence, bounds, duplication and allocation rules.
